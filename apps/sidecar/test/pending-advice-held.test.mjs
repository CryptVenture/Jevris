// A waiting advice line is taken only when an event shows it (JEV-0062). The sidecar's `event` op runs
// every subscriber, then the hook launcher renders the strongest outcome among their answers. The
// decision subscriber hands its take of the waiting line to the sidecar (`holdCommit`), which runs it
// after every subscriber has answered and only for an answer the launcher will render (`renderedSubscribers`):
// - a certified context or route from another subscriber beats the explain, so the line is not taken
//   and stays held, with its ten-minute expiry and its session, for the next event that shows it;
// - an explain beside it (the orchestrator's own loop advice), or an uncertified context, does not,
//   and both lines are shown, in subscriber-name order, with the line taken once;
// - a take that finds the line already taken withdraws the answer (ALREADY_SHOWN), so a line is never shown
//   twice, and a redelivery of the event that showed it replays the first answer and takes nothing again.
// A real daemon with the real decision subscriber and a stand-in for the orchestrator's certified context,
// and the launcher's own `chooseOutcome` to say what is rendered. Also: the sidecar's reading of an answer is
// the launcher's reading.
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

let sequence = 0;
/** A Kilo chat message as the adapter normalizes it: a `task.requested` event, which can show a waiting line. */
function chat(session) {
  sequence += 1;
  const normalized = kilo.normalize({ hookKey: 'chat.message', input: { sessionID: session, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, messageID: `msg_${sequence}_${process.pid}` }, output: { message: {}, parts: [{ type: 'text', text: `message ${sequence}` }] } });
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  return normalized.event;
}

async function withDaemon(t, run) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-held-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  let clock = Date.parse('2026-10-05T10:00:00Z');
  const store = new provider.PendingAdviceStore({ now: () => clock });
  // The stand-in for the orchestrator: whatever answer the test sets is what it answers.
  const other = { name: 'orchestrator', answer: null, runs: 0 };
  const orchestrator = { name: other.name, handle: async () => { other.runs += 1; return other.answer; } };
  const decision = provider.createDecisionSubscriber({ handlers: {}, certifications: provider.recordsCertificationSource(async () => []), now: () => clock, pending: store });
  // The hot budget and the slice are wide: this test is about what an answer takes, not a deadline.
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, engine: null, subscribers: [decision, orchestrator], subscriberSliceMs: 60_000, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const workspaceId = registered.result.id;
    const send = async (event, deliveryKey = event.dedupKey) => {
      const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { envelope: event, deliveryKey, showsExplain: true }, timeoutMs: 60_000 });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.result;
    };
    await run({ send, store, workspaceId, other, advance: (ms) => { clock += ms; }, now: () => clock });
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
}

const advice = (text = LINE) => ({ kind: 'repeated-failure', text, decisionId: null, reasonCode: 'REPEATED_FAILURE_NEXT_RULES' });
const certifiedContext = { hookOutcome: { kind: 'context', text: ORIENTATION }, certified: true, reasonCode: 'ORIENTATION' };
const rendered = (result) => chooseOutcome(result).outcome;

test('a certified context beats the waiting line: the line is not taken, and the next event shows it, once', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ send, store, workspaceId, other }) => {
    const session = 's-outranked';
    assert.equal(store.put(workspaceId, session, advice()), true);

    other.answer = certifiedContext;
    const first = await send(chat(session));
    assert.deepEqual(rendered(first), { kind: 'context', text: ORIENTATION }, 'the context is what the message shows');
    assert.equal(first.results['decision-engine'].hookOutcome.kind, 'observe', 'the outranked answer shows nothing');
    assert.equal(first.results['decision-engine'].reasonCode, 'OUTRANKED');
    assert.equal(store.count(workspaceId, session), 1, 'the line is still held');

    other.answer = null;
    const second = await send(chat(session));
    assert.deepEqual(rendered(second), { kind: 'explain', text: LINE }, 'the next message shows the line');
    assert.equal(store.count(workspaceId, session), 0, 'and takes it');
    assert.equal((await send(chat(session))).results['decision-engine'].hookOutcome.kind, 'observe', 'a line shown once is not shown again');
  });
});

test('a redelivery of the event that showed the line replays the answer and takes nothing; a redelivery of the one that did not show it replays that', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ send, store, workspaceId, other }) => {
    const session = 's-replay';
    store.put(workspaceId, session, advice());
    other.answer = certifiedContext;
    const outranked = chat(session);
    const first = await send(outranked);
    other.answer = null;
    const replayOutranked = await send(outranked);
    assert.equal(replayOutranked.replayed, true);
    assert.deepEqual(replayOutranked.results, first.results, 'the same answer, from the first delivery');
    assert.equal(store.count(workspaceId, session), 1, 'the replay took nothing');

    const showing = chat(session);
    const shown = await send(showing);
    assert.deepEqual(rendered(shown), { kind: 'explain', text: LINE });
    const replayShown = await send(showing);
    assert.equal(replayShown.replayed, true);
    assert.deepEqual(rendered(replayShown), { kind: 'explain', text: LINE }, 'the replay answers as the first delivery did');
    assert.equal(chooseOutcome(replayShown).reason, 'DUPLICATE_REPLAYED');
    assert.equal(store.count(workspaceId, session), 0);
    assert.equal(rendered(await send(chat(session))).kind, 'observe', 'and nothing is shown twice');
  });
});

test('the held line keeps its ten-minute expiry and its session', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ send, store, workspaceId, other, advance }) => {
    other.answer = certifiedContext;
    store.put(workspaceId, 's-young', advice());
    store.put(workspaceId, 's-old', advice());
    advance(MIN);
    // Outranked at one minute: both lines stay, and another session's message gets neither.
    assert.equal(rendered(await send(chat('s-young'))).kind, 'context');
    assert.equal(rendered(await send(chat('s-old'))).kind, 'context');
    other.answer = null;
    assert.equal(rendered(await send(chat('s-elsewhere'))).kind, 'observe', 'a line is for its own session');
    assert.deepEqual([store.count(workspaceId, 's-young'), store.count(workspaceId, 's-old')], [1, 1]);
    // Held, not renewed: at nine minutes the line is shown; at eleven it is gone.
    advance(8 * MIN);
    assert.deepEqual(rendered(await send(chat('s-young'))), { kind: 'explain', text: LINE }, 'after nine minutes the line is still held and shown');
    advance(2 * MIN);
    assert.equal(rendered(await send(chat('s-old'))).kind, 'observe', 'after eleven minutes it is dropped: being outranked did not extend it');
    assert.equal(store.count(workspaceId, 's-old'), 0);
  });
});

test('only a certified context or route outranks the line: another explain, an uncertified context and nothing do not', { skip: managedHostSkip() }, async (t) => {
  await withDaemon(t, async ({ send, store, workspaceId, other }) => {
    const take = async (label, answer) => {
      const session = `s-${label}`;
      store.put(workspaceId, session, advice());
      other.answer = answer;
      const result = await send(chat(session));
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

test('a take that finds the line already taken withdraws the answer, so a line is never shown twice', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-held-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  // A store whose lines have always just been shown by an event that raced this one.
  class RacedStore extends provider.PendingAdviceStore {
    consume() {
      return false;
    }
  }
  const store = new RacedStore();
  const decision = provider.createDecisionSubscriber({ handlers: {}, certifications: provider.recordsCertificationSource(async () => []), pending: store });
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, engine: null, subscribers: [decision], subscriberSliceMs: 60_000, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    store.put(registered.result.id, 's-raced', advice());
    const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { envelope: chat('s-raced'), deliveryKey: `raced-${process.pid}`, showsExplain: true }, timeoutMs: 60_000 });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.results['decision-engine'].reasonCode, 'ALREADY_SHOWN');
    assert.deepEqual(rendered(res.result), { kind: 'observe' }, 'the event that did not take the line does not show it');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
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
