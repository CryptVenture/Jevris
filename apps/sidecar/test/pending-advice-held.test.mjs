// A waiting advice line is taken only when an event shows it (JEV-0062). The sidecar's `event` op runs
// every subscriber, then the hook launcher renders the strongest outcome among their answers. The
// decision subscriber hands its take of the waiting line to the sidecar (`holdCommit`), which runs it
// after every subscriber has answered and only for an answer the launcher will render (`renderedSubscribers`):
// - a certified context or route from another subscriber beats the explain, so the line is not taken
//   and stays held, with its ten-minute expiry and its session, for the next event that shows it;
// - an explain beside it (the orchestrator's own loop advice), or an uncertified context, does not,
//   and both lines are shown, in subscriber-name order, with the line taken once;
// - a take that finds the line already taken withdraws the answer (ALREADY_SHOWN), so a line is never shown
//   twice, and a redelivery of the event that showed it replays the first answer and takes nothing again;
// - a subscriber the sidecar defers as slow (its handler ran 100 ms or more before its first await) is not
//   waited for on its next event, and a deferred answer takes nothing, so the line stays held for the one after.
// A real daemon with the real decision subscriber and a stand-in for the orchestrator's certified context,
// and the launcher's own `chooseOutcome` to say what is rendered. Also: the sidecar's reading of an answer is
// the launcher's reading.
//
// The deferral is the product's own rule and a host decides when it applies: the first event a process answers
// pays a cold cost that passed 100 ms under coverage and on windows-latest, which deferred the NEXT event and failed
// the first version of this file. So each test warms the subscribers first, takes an event only when both
// subscribers answered it in time (`answeredEvent`, which waits on the sidecar's own account of what it deferred, never
// on time), puts a line back if a deferral of the other subscriber let it be shown early, and one test makes the
// deferral happen on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { renderedSubscribers } = await import('../dist/outcome-rank.js');
const { chooseOutcome } = await import('../../hook/dist/launcher.js');
const provider = await import('@jevris/provider-typesafe');
const kilo = await import('@jevris/adapter-kilocode');

const LINE = 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.';
const ORIENTATION = 'Jevris is on here (mode: bounded-auto). A stand-in for the orientation line.';
const MIN = 60_000;
/** More than the sidecar's 100 ms rule for a slow subscriber, spent in the part of the handler that runs before its first await. */
const STALL_MS = 150;

let sequence = 0;
/** A Kilo chat message as the adapter normalizes it: a `task.requested` event, which can show a waiting line. */
function chat(session) {
  sequence += 1;
  const normalized = kilo.normalize({ hookKey: 'chat.message', input: { sessionID: session, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, messageID: `msg_${sequence}_${process.pid}` }, output: { message: {}, parts: [{ type: 'text', text: `message ${sequence}` }] } });
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  return normalized.event;
}

const advice = (atMs) => ({ kind: 'repeated-failure', text: LINE, decisionId: null, reasonCode: 'REPEATED_FAILURE_NEXT_RULES', ...(atMs === undefined ? {} : { atMs }) });
const certifiedContext = { hookOutcome: { kind: 'context', text: ORIENTATION }, certified: true, reasonCode: 'ORIENTATION' };
const rendered = (result) => chooseOutcome(result).outcome;

/** Busy for `ms` of real time: the synchronous part of a handler that is slow to start (a cold cost). */
function busy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

class RacedStore extends provider.PendingAdviceStore {
  /** A store whose lines have always just been shown by an event that raced this one. */
  consume() {
    return false;
  }
}

async function withDaemon(t, run, { storeClass = provider.PendingAdviceStore } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-held-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  let clock = Date.parse('2026-10-05T10:00:00Z');
  const store = new storeClass({ now: () => clock });
  const stall = { ms: 0 };
  // The stand-in for the orchestrator: whatever answer the test sets is what it answers.
  const other = { name: 'orchestrator', answer: null };
  // What each subscriber is doing, from the subscribers' own side: a call that has not returned, and the background runs
  // the sidecar owes for the answers it deferred (a deferred run is the one whose answer signal is already aborted).
  const work = { active: 0, started: 0, owed: 0 };
  const idleWaiters = [];
  const settled = () => work.active === 0 && work.started >= work.owed;
  const track = (subscriber) => ({
    name: subscriber.name,
    handle: async (ctx) => {
      work.active += 1;
      if (ctx.signal.aborted) work.started += 1;
      try {
        return await subscriber.handle(ctx);
      } finally {
        work.active -= 1;
        if (settled()) for (const wake of idleWaiters.splice(0)) wake();
      }
    },
  });
  /** Resolves when no subscriber is running and every background run the sidecar owes has run. */
  const idle = () => (settled() ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve)));
  const decision = provider.createDecisionSubscriber({
    handlers: {},
    certifications: provider.recordsCertificationSource(async () => []),
    // The clock is read at the start of the handler: a stall here is a handler that is slow before its first await.
    now: () => {
      if (stall.ms > 0) busy(stall.ms);
      return clock;
    },
    pending: store,
  });
  const orchestrator = { name: other.name, handle: async () => other.answer };
  // The hot budget and the slice are wide: this test is about what an answer takes, not a deadline.
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, engine: null, subscribers: [track(decision), track(orchestrator)], subscriberSliceMs: 60_000, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const workspaceId = registered.result.id;
    const send = async (event, deliveryKey = event.dedupKey) => {
      const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { envelope: event, deliveryKey, showsExplain: true }, timeoutMs: 60_000 });
      assert.equal(res.ok, true, JSON.stringify(res));
      // Each name the sidecar says it deferred is one background run it now owes (a replay deferred nothing new).
      if (res.result.replayed !== true) work.owed += (res.result.queued ?? []).length;
      return res.result;
    };
    const seeded = new Map();
    const env = {
      send,
      store,
      workspaceId,
      other,
      idle,
      now: () => clock,
      advance: (ms) => {
        clock += ms;
      },
      /** Every run of the decision subscriber from now on is slow before its first await, until `stall(0)`. */
      stall: (ms) => {
        stall.ms = ms;
      },
      /** Holds the line for a session, from now (or from `atMs`). */
      seed(session, atMs = clock) {
        seeded.set(session, atMs);
        assert.equal(store.put(workspaceId, session, advice(atMs)), true);
      },
      /**
       * One event for `session` that both subscribers answered in time, and the answer. A deferred subscriber's answer is never
       * used and takes nothing, so an event with one is tried again; if the OTHER subscriber was the deferred one the line
       * may have been shown and taken meanwhile, so a line the test means to hold is put back, with the time it had.
       */
      async answeredEvent(session, { answer, holding = true, make = chat } = {}) {
        const tried = [];
        for (let attempt = 1; attempt <= 20; attempt += 1) {
          other.answer = answer ?? null;
          if (holding && store.count(workspaceId, session) === 0) assert.equal(store.put(workspaceId, session, advice(seeded.get(session))), true);
          const event = make(session);
          const result = await send(event);
          await idle();
          if (result.queued === undefined) return { event, result };
          tried.push(JSON.stringify(result.queued));
        }
        return assert.fail(`every event had a subscriber deferred (${tried.join(' ')}): the host is too slow for this test`);
      },
    };
    // Warm the subscribers on a session of their own, so the cold cost of a process's first event is not what a test reads.
    await env.answeredEvent('s-warm', { holding: false });
    await env.answeredEvent('s-warm', { holding: false });
    await run(env);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
}

test('a certified context beats the waiting line: the line is not taken, and the next event shows it, once', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ store, workspaceId, seed, answeredEvent }) => {
    const session = 's-outranked';
    seed(session);

    const first = (await answeredEvent(session, { answer: certifiedContext })).result;
    assert.deepEqual(rendered(first), { kind: 'context', text: ORIENTATION }, `the context is what the message shows: ${JSON.stringify(first)}`);
    assert.equal(first.results['decision-engine'].hookOutcome.kind, 'observe', 'the outranked answer shows nothing');
    assert.equal(first.results['decision-engine'].reasonCode, 'OUTRANKED');
    assert.equal(store.count(workspaceId, session), 1, 'the line is still held');

    const second = (await answeredEvent(session)).result;
    assert.deepEqual(rendered(second), { kind: 'explain', text: LINE }, `the next message shows the line: ${JSON.stringify(second)}`);
    assert.equal(store.count(workspaceId, session), 0, 'and takes it');
    const third = (await answeredEvent(session, { holding: false })).result;
    assert.equal(third.results['decision-engine'].hookOutcome.kind, 'observe', 'a line shown once is not shown again');
  });
});

test('a redelivery of the event that showed the line replays the answer and takes nothing; a redelivery of the one that did not show it replays that', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ send, store, workspaceId, seed, answeredEvent }) => {
    const session = 's-replay';
    seed(session);
    const outranked = await answeredEvent(session, { answer: certifiedContext });
    const replayOutranked = await send(outranked.event);
    assert.equal(replayOutranked.replayed, true, JSON.stringify(replayOutranked));
    assert.deepEqual(replayOutranked.results, outranked.result.results, 'the same answer, from the first delivery');
    assert.equal(store.count(workspaceId, session), 1, 'the replay took nothing');

    const showing = await answeredEvent(session);
    assert.deepEqual(rendered(showing.result), { kind: 'explain', text: LINE }, JSON.stringify(showing.result));
    const replayShown = await send(showing.event);
    assert.equal(replayShown.replayed, true, JSON.stringify(replayShown));
    assert.deepEqual(rendered(replayShown), { kind: 'explain', text: LINE }, 'the replay answers as the first delivery did');
    assert.equal(chooseOutcome(replayShown).reason, 'DUPLICATE_REPLAYED');
    assert.equal(store.count(workspaceId, session), 0);
    assert.equal(rendered((await answeredEvent(session, { holding: false })).result).kind, 'observe', 'and nothing is shown twice');
  });
});

test('the held line keeps its ten-minute expiry and its session', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ store, workspaceId, advance, seed, answeredEvent }) => {
    seed('s-young');
    seed('s-old');
    advance(MIN);
    // Outranked at one minute: both lines stay, and another session's message gets neither.
    assert.equal(rendered((await answeredEvent('s-young', { answer: certifiedContext })).result).kind, 'context');
    assert.equal(rendered((await answeredEvent('s-old', { answer: certifiedContext })).result).kind, 'context');
    assert.equal(rendered((await answeredEvent('s-elsewhere', { holding: false })).result).kind, 'observe', 'a line is for its own session');
    assert.deepEqual([store.count(workspaceId, 's-young'), store.count(workspaceId, 's-old')], [1, 1]);
    // Held, not renewed: at nine minutes the line is shown; at eleven it is gone.
    advance(8 * MIN);
    assert.deepEqual(rendered((await answeredEvent('s-young')).result), { kind: 'explain', text: LINE }, 'after nine minutes the line is still held and shown');
    advance(2 * MIN);
    assert.equal(rendered((await answeredEvent('s-old', { holding: false })).result).kind, 'observe', 'after eleven minutes it is dropped: being outranked did not extend it');
    assert.equal(store.count(workspaceId, 's-old'), 0);
  });
});

test('only a certified context or route outranks the line: another explain, an uncertified context and nothing do not', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ store, workspaceId, seed, answeredEvent }) => {
    const take = async (label, answer) => {
      const session = `s-${label}`;
      seed(session);
      const { result } = await answeredEvent(session, { answer });
      return { result, held: store.count(workspaceId, session) === 1 };
    };
    const explain = await take('explain', { hookOutcome: { kind: 'explain', text: 'Jevris: the orchestrator has a line of its own.' }, certified: false, reasonCode: 'LOOP_REPEATED_FAILURE' });
    assert.equal(explain.held, false, 'an explain beside it does not outrank it');
    assert.equal(rendered(explain.result).text, `${LINE}\nJevris: the orchestrator has a line of its own.`, 'both lines, in subscriber-name order, one per line');

    const uncertified = await take('uncertified', { hookOutcome: { kind: 'context', text: ORIENTATION }, certified: false, reasonCode: 'ORIENTATION' });
    assert.equal(uncertified.held, false, 'a context that is not certified is not rendered, so it does not outrank');
    assert.deepEqual(rendered(uncertified.result), { kind: 'explain', text: LINE });

    const route = await take('route', { hookOutcome: { kind: 'route', model: 'claude-sonnet-4-5' }, certified: true, reasonCode: 'ROUTE' });
    assert.equal(route.held, true, 'a certified route outranks it');
    assert.equal(rendered(route.result).kind, 'route');

    const invalidRoute = await take('invalid-route', { hookOutcome: { kind: 'route', model: 'not a model id!' }, certified: true, reasonCode: 'ROUTE' });
    assert.equal(invalidRoute.held, false, 'a route the launcher cannot read is not rendered, so it does not outrank');

    const empty = await take('empty', { hookOutcome: { kind: 'context', text: '   ' }, certified: true, reasonCode: 'ORIENTATION' });
    assert.equal(empty.held, false, 'a context with no text is not rendered');

    const nothing = await take('nothing', null);
    assert.equal(nothing.held, false);
    assert.deepEqual(rendered(nothing.result), { kind: 'explain', text: LINE });
  });
});

test('a subscriber the sidecar defers as slow takes nothing: the line stays held, and the event after it shows the line', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ send, idle, store, workspaceId, other, seed, stall, answeredEvent }) => {
    const session = 's-deferred';
    other.answer = null;
    // The decision subscriber is slow before its first await on every run (a cold cost, as the first event of a process pays),
    // so the sidecar knows it as slow whichever of its runs it measured last: the event after any event is deferred.
    stall(STALL_MS);
    const slow = await send(chat(session));
    assert.deepEqual(rendered(slow), { kind: 'observe' }, 'nothing to show yet');

    // The line is due, and the next event finds the subscriber deferred: it answers without it, and the background run takes
    // nothing (its answer signal is aborted), so the line is still held.
    seed(session);
    const deferred = await send(chat(session));
    assert.ok(deferred.queued?.includes('decision-engine'), `the slow subscriber is not waited for: ${JSON.stringify(deferred)}`);
    assert.deepEqual(deferred.results['decision-engine'], { queued: true });
    assert.deepEqual(rendered(deferred), { kind: 'observe' }, 'the deferred event shows nothing');
    stall(0);
    await idle();
    assert.equal(store.count(workspaceId, session), 1, 'its background run took nothing');

    // The subscriber is fast again, and the next event that both subscribers answer shows the line.
    const next = await answeredEvent(session);
    assert.deepEqual(rendered(next.result), { kind: 'explain', text: LINE }, JSON.stringify(next.result));
    assert.equal(store.count(workspaceId, session), 0);
  });
});

test('a take that finds the line already taken withdraws the answer, so a line is never shown twice', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(
    t,
    async ({ seed, answeredEvent }) => {
      seed('s-raced');
      const { result } = await answeredEvent('s-raced');
      assert.equal(result.results['decision-engine'].reasonCode, 'ALREADY_SHOWN', JSON.stringify(result));
      assert.deepEqual(rendered(result), { kind: 'observe' }, 'the event that did not take the line does not show it');
    },
    { storeClass: RacedStore },
  );
});

test('the sidecar reads an answer as the launcher does: the subscribers it names are the ones whose text the launcher renders', () => {
  const kinds = [
    null,
    { hookOutcome: { kind: 'observe' }, certified: false },
    { hookOutcome: { kind: 'explain', text: 'A' }, certified: false },
    { hookOutcome: { kind: 'explain', text: 'B' }, certified: true },
    { hookOutcome: { kind: 'explain', text: '  ' }, certified: false },
    { hookOutcome: { kind: 'context', text: 'C' }, certified: true },
    { hookOutcome: { kind: 'context', text: 'D' }, certified: false },
    { hookOutcome: { kind: 'context', text: '' }, certified: true },
    { hookOutcome: { kind: 'route', model: 'claude-sonnet-4-5' }, certified: true },
    { hookOutcome: { kind: 'route', model: 'claude-sonnet-4-5' }, certified: false },
    { hookOutcome: { kind: 'route', model: 'bad id' }, certified: true },
    { hookOutcome: { kind: 'bogus', text: 'E' }, certified: true },
    { hookOutcome: 'explain', certified: true },
    { queued: true },
    { error: 'SUBSCRIBER_FAILED' },
  ];
  const names = ['a-first', 'b-second', 'c-third'];
  let checked = 0;
  // Every combination of three subscribers' answers (15 x 15 x 15).
  for (const x of kinds) {
    for (const y of kinds) {
      for (const z of kinds) {
        const results = { [names[0]]: x, [names[1]]: y, [names[2]]: z };
        const chosen = chooseOutcome({ recorded: true, duplicate: false, results }).outcome;
        const set = renderedSubscribers(results);
        const text = (name) => results[name]?.hookOutcome?.text ?? null;
        if (chosen.kind === 'observe') assert.equal(set.size, 0, JSON.stringify(results));
        else if (chosen.kind === 'explain') assert.equal([...set].map(text).filter((v, i, all) => all.indexOf(v) === i).join('\n'), chosen.text, JSON.stringify(results));
        else if (chosen.kind === 'context') assert.deepEqual([...set].map(text), [chosen.text], JSON.stringify(results));
        else assert.deepEqual([...set].map((name) => results[name].hookOutcome.model), [chosen.model], JSON.stringify(results));
        checked += 1;
      }
    }
  }
  assert.equal(checked, 15 ** 3);
});
