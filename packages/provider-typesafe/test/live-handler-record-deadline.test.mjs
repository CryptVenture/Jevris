// Review of the live advisers (item 1, second part): when the rules settle a repeated failure, the
// handler answers the hook with the line at once. Recording the advisory decision is inline on that
// path, so a slow disk could hold the line until the hook's own time was gone. The record is now
// waited for only briefly (at most 250 ms, and never past the time the hook has left less a margin):
// past that the line is returned without a decision id (the trace says REPEATED_FAILURE_RECORD_LATE)
// and the record finishes or fails on its own. The disk is a gate the test opens, never a real
// sleep. Stub engine, no files, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const SAFETY_MS = 6000;

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function holdingEngine(gate) {
  const entered = [];
  const finished = [];
  return {
    entered,
    finished,
    providerConfigured: true,
    sourceEgress: () => 'denied',
    decide: () => new Promise(() => {}),
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice(input) {
      entered.push(input);
      await gate.promise;
      finished.push(input);
      return { ok: true, decisionId: `d-held-${finished.length}` };
    },
  };
}

const FEATURES = { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: true, elapsed: 'lt10s', present: [] };
const OBSERVATION = { attempts: 2, sameSignature: true, sameCommand: true, editsSince: 0, gapMs: 1000, unsure: false, previous: null };

/** The input the subscriber gives a trigger handler, with `remainingMs` left of the hook's time. */
function handlerInput(engine, { remainingMs, traces, session = 'sess-record' } = {}) {
  const envelope = { schemaVersion: '1.0', eventId: `ev-${sha(session).slice(0, 12)}`, workspaceId: 'w-record', sessionId: session, sequence: 1, occurredAt: '2026-10-03T10:00:00.000Z', kind: 'tool.failed', expectedRevision: 'rev-1', deadlineAt: '2026-10-03T10:00:01.000Z', payload: {}, evidence: [] };
  return {
    ctx: { op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-record', root: '/nowhere' }, body: { failure: FEATURES, repair: { maxAttempts: 2 } }, home: '/nonexistent-home', signal: new AbortController().signal, deadline: { remainingMs: () => remainingMs, expired: () => false }, store: null, killSwitchStopped: false, engine, mode: 'bounded-auto', jevAssist: 'off', trace: (entry) => traces.push(entry) },
    envelope,
    event: {},
    trigger: 'repeated-failure',
    engine,
    queues: new core.DecisionQueues(),
    revision: 'rev-1',
    failure: OBSERVATION,
  };
}

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

test('a recording held past the hook\'s own time does not hold the line: it comes back without a decision id, and the record finishes on its own', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const traces = [];
  const store = new provider.PendingAdviceStore();
  const handler = provider.createRepeatedFailureHandler({ store, background: () => undefined });
  let forced = false;
  const safety = setTimeout(() => {
    forced = true;
    gate.resolve();
  }, SAFETY_MS);
  let proposal;
  try {
    // 400 ms left of the hook: the handler keeps its margin and waits for the record only briefly, at most what remains.
    proposal = await handler(handlerInput(engine, { remainingMs: 400, traces }));
  } finally {
    clearTimeout(safety);
  }
  assert.equal(forced, false, 'the handler answered while the recording was still held: it did not wait for the disk');
  assert.ok(proposal !== null, 'the line is returned');
  assert.equal(proposal.hookOutcome.kind, 'explain');
  assert.match(proposal.hookOutcome.text, /looks environmental/);
  assert.equal(proposal.decisionId, undefined, 'no decision id: the record had not finished');
  assert.equal(traces.filter((t) => t.event === 'repeated-failure-advice' && t.reasonCode === 'REPEATED_FAILURE_RECORD_LATE').length, 1, 'the trace says the record was late, once');
  assert.equal(store.count('w-record', 'sess-record'), 1, 'the line is also waiting for the session, as before');
  assert.equal(engine.entered.length, 1, 'the one record had started');
  gate.resolve();
  await until(() => engine.finished.length === 1);
});

/** A handler whose record is held at a closed gate; the hook has `remainingMs` left. Returns what the hook was given and whether the safety had to open the gate. */
async function answerWhileHeld({ remainingMs, handlerOptions = {} }) {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const traces = [];
  const store = new provider.PendingAdviceStore();
  const handler = provider.createRepeatedFailureHandler({ store, background: () => undefined, ...handlerOptions });
  let forced = false;
  const safety = setTimeout(() => {
    forced = true;
    gate.resolve();
  }, SAFETY_MS);
  let proposal;
  try {
    proposal = await handler(handlerInput(engine, { remainingMs, traces }));
  } finally {
    clearTimeout(safety);
  }
  return { proposal, forced: () => forced, traces, engine, gate };
}

test('the 250 ms bound is the handler\'s own: with plenty of hook time left, a record that never arrives still does not hold the line', async () => {
  // 60 s left of the hook, so the time the hook has left is not what cuts the wait: only the default bound can.
  const held = await answerWhileHeld({ remainingMs: 60_000 });
  assert.equal(held.forced(), false, 'the handler answered while the record was still held, long before the safety');
  assert.ok(held.proposal !== null);
  assert.equal(held.proposal.hookOutcome.kind, 'explain');
  assert.equal(held.proposal.decisionId, undefined, 'no decision id: the record had not arrived inside the bound');
  assert.equal(held.traces.filter((t) => t.event === 'repeated-failure-advice' && t.reasonCode === 'REPEATED_FAILURE_RECORD_LATE').length, 1);
  held.gate.resolve();
  await until(() => held.engine.finished.length === 1);
});

test('the test seam lengthens the wait and nothing else: the record is waited for past 250 ms, and the hook\'s remaining time still cuts it', async () => {
  // A long bound and a hook with time: the handler is still waiting well past 250 ms and takes the record when it arrives.
  const gate = deferred();
  const engine = holdingEngine(gate);
  const traces = [];
  const handler = provider.createRepeatedFailureHandler({ store: new provider.PendingAdviceStore(), background: () => undefined, recordWaitMaxMs: 120_000 });
  let answered = false;
  const run = handler(handlerInput(engine, { remainingMs: 300_000, traces })).then((proposal) => {
    answered = true;
    return proposal;
  });
  await until(() => engine.entered.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(answered, false, 'past the default 250 ms the handler is still waiting for the record');
  gate.resolve();
  const proposal = await run;
  assert.equal(proposal.decisionId, 'd-held-1', 'the record arrived and rides on the proposal');
  assert.deepEqual(traces.map((t) => t.reasonCode).filter((code) => code === 'REPEATED_FAILURE_RECORD_LATE'), []);
  // The same long bound with only 400 ms left of the hook: the hook's time less the margin (250 ms) cuts the wait.
  const held = await answerWhileHeld({ remainingMs: 400, handlerOptions: { recordWaitMaxMs: 120_000 } });
  assert.equal(held.forced(), false, 'the handler answered at what the hook had left, not at the long bound');
  assert.equal(held.proposal.decisionId, undefined);
  assert.equal(held.traces.filter((t) => t.reasonCode === 'REPEATED_FAILURE_RECORD_LATE').length, 1);
  held.gate.resolve();
  await until(() => held.engine.finished.length === 1);
});

test('a recording that finishes in time is as before: the decision id rides on the proposal and nothing is called late', async () => {
  const gate = deferred();
  gate.resolve();
  const engine = holdingEngine(gate);
  const traces = [];
  const handler = provider.createRepeatedFailureHandler({ store: new provider.PendingAdviceStore(), background: () => undefined });
  const proposal = await handler(handlerInput(engine, { remainingMs: 60_000, traces }));
  assert.equal(proposal.decisionId, 'd-held-1');
  assert.deepEqual(traces.map((t) => t.reasonCode).filter((code) => code === 'REPEATED_FAILURE_RECORD_LATE'), []);
});

test('adviseRepeatedFailure called without a wait bound still waits for the record, as it always did', async () => {
  const gate = deferred();
  const engine = holdingEngine(gate);
  const context = provider.failureContextOf(provider.parseFailureFeatures(FEATURES), OBSERVATION, 2);
  const run = provider.adviseRepeatedFailure(engine, context, { mode: 'bounded-auto', assist: 'off', deadlineMs: 1000, ids: { workspaceId: 'w-record', sessionId: 'sess-record' } });
  let settled = false;
  void run.then(() => {
    settled = true;
  });
  await until(() => engine.entered.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'with no bound it is still waiting for the held record');
  gate.resolve();
  const advice = await run;
  assert.equal(advice.decisionId, 'd-held-1');
});
