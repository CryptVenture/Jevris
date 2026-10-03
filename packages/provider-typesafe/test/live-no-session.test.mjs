// Review of the live advisers (item 3): an event with a missing or unsafe session id (an Antigravity
// `conversationId` can be null) was given the one shared id `unknown-session`, so every such event of
// a workspace shared one bucket: advice waiting for one session could show in another, and the
// repeat counts of unrelated failures merged. An event with no usable session id now neither queues
// nor receives waiting advice, and the two live advisers (repeated failure, new task) do nothing for
// it and say why (`REPEATED_FAILURE_NO_SESSION`, `NEW_TASK_NO_SESSION`). The envelope still carries
// the shared placeholder, and the older handlers and the trigger filter are as they were. Stub
// engines, no files, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const sha = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- the placeholder

test('the placeholder session id is one exported constant, and an event without a usable session id still gets it', () => {
  assert.equal(core.UNKNOWN_SESSION_ID, 'unknown-session');
  const event = (sessionId) => ({ schemaVersion: '1.0', harness: 'antigravity', nativeEventName: 'Hook', kind: 'tool.failed', sessionId, turnId: null, toolUseId: null, toolName: 'Bash', agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: false, responseRequired: false, payload: {}, dedupKey: sha(`placeholder-${String(sessionId)}`) });
  const envelopeOf = (sessionId) => core.toEventEnvelope({ event: event(sessionId), workspaceId: 'w-nosession', sequence: 1, occurredAt: '2026-10-03T10:00:00.000Z', expectedRevision: 'r1', deadlineAt: '2026-10-03T10:00:01.000Z' });
  for (const missing of [null, '', 'has a space', 'a'.repeat(200)]) {
    const built = envelopeOf(missing);
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.equal(built.envelope.sessionId, core.UNKNOWN_SESSION_ID, String(missing));
  }
  assert.equal(envelopeOf('conversation-1').envelope.sessionId, 'conversation-1');
});

// ---------------------------------------------------------------- the pending store

test('the pending store neither takes advice for, nor gives advice to, a session with no usable id', () => {
  const store = new provider.PendingAdviceStore();
  const advice = { kind: 'new-task', text: 'Jevris: a line.', decisionId: null, reasonCode: 'NEW_TASK_JEV' };
  assert.equal(store.put('w-nosession', core.UNKNOWN_SESSION_ID, advice), false, 'not queued');
  assert.equal(store.count('w-nosession', core.UNKNOWN_SESSION_ID), 0);
  assert.equal(store.peek('w-nosession', core.UNKNOWN_SESSION_ID), null);
  assert.equal(store.find('w-nosession', core.UNKNOWN_SESSION_ID, 'new-task'), null);
  // A real session still works.
  assert.equal(store.put('w-nosession', 'sess-real', advice), true);
  assert.equal(store.peek('w-nosession', core.UNKNOWN_SESSION_ID), null, 'and it never shows in the placeholder session');
  const waiting = store.peek('w-nosession', 'sess-real');
  assert.equal(store.consume('w-nosession', core.UNKNOWN_SESSION_ID, waiting), false);
  assert.equal(store.consume('w-nosession', 'sess-real', waiting), true);
});

// ---------------------------------------------------------------- the subscriber

let n = 0;
function harnessEvent(kind, { session, toolName = null } = {}) {
  n += 1;
  return { schemaVersion: '1.0', harness: 'antigravity', nativeEventName: 'Hook', kind, sessionId: session, turnId: null, toolUseId: `tu-${n}`, toolName, agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload: {}, dedupKey: sha(`no-session-event-${n}`) };
}

const FAILURE = { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [] };

function ctxFor(kind, { session, engine, body = {}, toolName = kind === 'tool.finished' ? 'Edit' : 'Bash', traces }) {
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-nosession', root: '/nowhere' },
    body: { envelope: harnessEvent(kind, { session, toolName }), deliveryKey: `k-${n}`, revision: 'rev-1', repair: { maxAttempts: 2 }, ...body },
    home: '/nonexistent-home', signal: new AbortController().signal, deadline: { remainingMs: () => 5_000, expired: () => false }, store: null,
    killSwitchStopped: false, engine, mode: 'bounded-auto', jevAssist: 'classify', trace: (entry) => traces.push(entry),
  };
}

/** An engine that would answer any question and records every question and every recording: nothing here may reach it for a session-less event. */
function countingEngine() {
  const decides = [];
  const recorded = [];
  return {
    decides,
    recorded,
    providerConfigured: true,
    sourceEgress: () => 'approved',
    async decide(request) {
      decides.push(request);
      return { abstained: true, decisionId: `d-${decides.length}`, reasonCode: 'TEST_ENGINE' };
    },
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice(input) {
      recorded.push(input);
      return { ok: true, decisionId: `d-advice-${recorded.length}` };
    },
  };
}

function liveSubscriber(engineForHandlers) {
  const store = new provider.PendingAdviceStore();
  const background = [];
  const traces = [];
  const failure = provider.createRepeatedFailureHandler({ store, background: (work) => background.push(work), deadlineMs: 30_000 });
  const newTask = provider.createNewTaskHandler({ store, background: (work) => background.push(work), deadlineMs: 30_000 });
  const subscriber = provider.createDecisionSubscriber({ handlers: { 'repeated-failure': [failure], 'new-task': [newTask] }, certifications: provider.recordsCertificationSource(async () => []), now: () => Date.parse('2026-10-03T10:00:00Z'), operatingSystem: 'linux', pending: store });
  const send = (kind, options) => subscriber.handle(ctxFor(kind, { engine: engineForHandlers, traces, ...options }));
  return { send, store, background, traces };
}

test('two unrelated failures of session-less events are not one repeated failure: the live adviser says nothing, asks nothing and records nothing', async () => {
  const engine = countingEngine();
  const live = liveSubscriber(engine);
  // Two different conversations, both without a usable id, fail the same way once each: no real repeat.
  const first = await live.send('tool.failed', { session: null, body: { failure: FAILURE } });
  assert.equal(first.hookOutcome.kind, 'observe');
  const second = await live.send('tool.failed', { session: null, body: { failure: FAILURE } });
  assert.equal(second.hookOutcome.kind, 'observe', 'no advice line for a "repeat" that is two sessions');
  await Promise.all(live.background);
  assert.equal(live.background.length, 0, 'nothing was detached');
  assert.equal(engine.decides.length, 0, 'Jev was not asked');
  assert.equal(engine.recorded.length, 0, 'nothing was recorded under the shared placeholder');
  assert.equal(live.store.count('w-nosession', core.UNKNOWN_SESSION_ID), 0);
  assert.ok(live.traces.some((t) => t.event === 'repeated-failure-advice' && t.reasonCode === 'REPEATED_FAILURE_NO_SESSION'), JSON.stringify(live.traces));
  // And the next session-less event, of yet another conversation, is shown nothing.
  const later = await live.send('tool.finished', { session: null });
  assert.equal(later.hookOutcome.kind, 'observe', 'nothing waits in the shared placeholder session');
});

test('the same failure twice in a real session is advised as before (the control)', async () => {
  const engine = countingEngine();
  const live = liveSubscriber(engine);
  await live.send('tool.failed', { session: 'sess-real', body: { failure: { ...FAILURE, environmental: true } } });
  const second = await live.send('tool.failed', { session: 'sess-real', body: { failure: { ...FAILURE, environmental: true } } });
  assert.equal(second.hookOutcome.kind, 'explain');
  assert.match(second.hookOutcome.text, /^Jevris: this failure has come back 2 times/);
  assert.equal(engine.recorded.length, 1, 'recorded under the real session');
  assert.equal(engine.recorded[0].sessionId, 'sess-real');
});

test('a new task with no usable session id is not read: nothing is asked, queued or recorded, and the trace says why', async () => {
  const engine = countingEngine();
  const live = liveSubscriber(engine);
  const task = { objective: 'Add a retry with backoff to the upload client and cover it with a test' };
  // Different revisions: the trigger filter coalesces repeats of one trigger at one revision, which is not under test here.
  for (const [session, revision] of [[null, 'rev-1'], ['', 'rev-2']]) {
    const result = await live.send('task.requested', { session, body: { task, revision } });
    assert.equal(result.hookOutcome.kind, 'observe');
  }
  await Promise.all(live.background);
  assert.equal(live.background.length, 0, 'nothing was detached');
  assert.equal(engine.decides.length, 0, 'the request text never went to Jev');
  assert.equal(engine.recorded.length, 0);
  assert.equal(live.store.count('w-nosession', core.UNKNOWN_SESSION_ID), 0);
  assert.equal(live.traces.filter((t) => t.event === 'new-task-advice' && t.reasonCode === 'NEW_TASK_NO_SESSION').length, 2);
});

test('waiting advice of a real session is never shown to a session-less event, and still reaches its own session', async () => {
  const engine = countingEngine();
  const live = liveSubscriber(engine);
  assert.equal(live.store.put('w-nosession', 'sess-real', { kind: 'repeated-failure', text: 'Jevris: for the real session only.', decisionId: null, reasonCode: 'REPEATED_FAILURE_RULES_SURE' }), true);
  // A tool event with no session id: it must not receive the other session's line.
  const lost = await live.send('tool.finished', { session: null });
  assert.equal(lost.hookOutcome.kind, 'observe');
  assert.equal(live.store.count('w-nosession', 'sess-real'), 1, 'still waiting');
  // The real session's next event gets it.
  const got = await live.send('tool.finished', { session: 'sess-real' });
  assert.deepEqual([got.hookOutcome.kind, got.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED']);
  assert.equal(got.hookOutcome.text, 'Jevris: for the real session only.');
  assert.equal(live.store.count('w-nosession', 'sess-real'), 0);
});
