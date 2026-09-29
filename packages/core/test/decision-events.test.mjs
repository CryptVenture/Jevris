import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { toEventEnvelope, EventDeduper, AggregateOrderer } = await import('../dist/index.js');

const sha = (text) => createHash('sha256').update(text).digest('hex');

function harnessEvent(overrides = {}) {
  return {
    schemaVersion: '1.0',
    harness: 'claude',
    nativeEventName: 'PreToolUse',
    kind: 'tool.proposed',
    sessionId: 'sess-1',
    turnId: null,
    toolUseId: 'toolu_01',
    toolName: 'Bash',
    agentId: null,
    model: 'claude-sonnet-5',
    permissionMode: 'default',
    cwd: null,
    trigger: null,
    blocking: true,
    responseRequired: false,
    payload: { commandClass: 'test' },
    dedupKey: sha('sess-1|toolu_01|PreToolUse'),
    ...overrides,
  };
}

const base = {
  workspaceId: 'w-1',
  sequence: 7,
  occurredAt: '2026-09-25T10:00:00.000Z',
  expectedRevision: 'rev-3',
  deadlineAt: '2026-09-25T10:00:00.900Z',
};

test('DEC-01: a harness event becomes a valid EventEnvelope with distinct transport, operation and tool-use ids', () => {
  const result = toEventEnvelope({ ...base, event: harnessEvent(), taskId: 'task-9', transportEventId: 'delivery-42', operationId: 'op-5' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const envelope = result.envelope;
  assert.equal(envelope.kind, 'tool.proposed');
  assert.equal(envelope.provenance.nativeEventName, 'PreToolUse', 'native name kept as provenance only');
  assert.equal(envelope.provenance.transportEventId, 'delivery-42');
  assert.equal(envelope.provenance.toolUseId, 'toolu_01');
  assert.equal(envelope.causationId, 'op-5', 'the logical operation id');
  assert.match(envelope.provenance.dedupKey, /^sha256:[0-9a-f]{64}$/);
  const ids = new Set([envelope.provenance.transportEventId, envelope.provenance.toolUseId, envelope.causationId, envelope.eventId]);
  assert.equal(ids.size, 4, 'no identifier is reused for another purpose');
  assert.equal(envelope.taskId, 'task-9');
  assert.equal(JSON.stringify(envelope).includes('PreToolUse') && envelope.kind !== 'PreToolUse', true);
});

test('DEC-01: a missing or malformed dedup key, or a foreign event, is refused', () => {
  assert.equal(toEventEnvelope({ ...base, event: harnessEvent({ dedupKey: '' }) }).reasonCode, 'INVALID_DEDUP_KEY');
  assert.equal(toEventEnvelope({ ...base, event: harnessEvent({ dedupKey: 'x'.repeat(64) }) }).reasonCode, 'INVALID_DEDUP_KEY');
  assert.equal(toEventEnvelope({ ...base, event: { ...harnessEvent(), schemaVersion: '2.0' } }).reasonCode, 'INVALID_EVENT');
  assert.equal(toEventEnvelope({ ...base, event: harnessEvent({ kind: 'NotDotted' }) }).reasonCode, 'INVALID_ENVELOPE');
  const late = toEventEnvelope({ ...base, deadlineAt: '2026-09-25T09:00:00.000Z', event: harnessEvent() });
  assert.equal(late.ok, false, 'a deadline before the event is refused');
});

test('DEC-01: redelivery of the same event deduplicates, even with a new sequence number', () => {
  const deduper = new EventDeduper();
  const first = toEventEnvelope({ ...base, event: harnessEvent() }).envelope;
  const again = toEventEnvelope({ ...base, sequence: 99, event: harnessEvent() }).envelope;
  const other = toEventEnvelope({ ...base, event: harnessEvent({ toolUseId: 'toolu_02', dedupKey: sha('sess-1|toolu_02|PreToolUse') }) }).envelope;
  assert.equal(first.eventId, again.eventId, 'the event id comes from the dedup key, not the sequence');
  assert.equal(deduper.accept(first), true);
  assert.equal(deduper.accept(again), false);
  assert.equal(deduper.accept(other), true);
  const otherWorkspace = toEventEnvelope({ ...base, workspaceId: 'w-2', event: harnessEvent() }).envelope;
  assert.equal(deduper.accept(otherWorkspace), true, 'dedup is per workspace');
});

test('DEC-01: compare-and-swap on the task revision; a late result is kept but never overwrites', () => {
  const orderer = new AggregateOrderer();
  assert.equal(orderer.apply('t1', 0, 'e1').ok, true);
  assert.equal(orderer.apply('t1', 1, 'e2').ok, true);
  const late = orderer.apply('t1', 1, 'e-late');
  assert.equal(late.ok, false);
  assert.equal(late.reasonCode, 'STALE_REVISION');
  assert.equal(late.late, true);
  assert.equal(orderer.get('t1').lastEventId, 'e2');
  assert.equal(orderer.lateResults().length, 1, 'kept for inspection');
  assert.equal(orderer.apply('t1', 2, 'cancel', 'cancelled').ok, true);
  const completeAfterCancel = orderer.apply('t1', 3, 'done', 'completed');
  assert.equal(completeAfterCancel.ok, false);
  assert.equal(completeAfterCancel.reasonCode, 'TASK_CANCELLED', 'a cancelled task is never marked complete');
});

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each task has a chain of transitions; each event names the revision it expects. */
function workload(tasks, steps) {
  const events = [];
  for (let t = 0; t < tasks; t += 1) {
    for (let r = 0; r < steps; r += 1) events.push({ task: `t${t}`, expected: r, id: `t${t}-e${r}`, to: r === steps - 1 ? 'completed' : 'open' });
  }
  return events;
}

function replay(events, orderer = new AggregateOrderer(), deduper = new EventDeduper()) {
  for (const event of events) {
    if (!deduper.accept({ workspaceId: 'w', eventId: event.id })) continue;
    orderer.apply(event.task, event.expected, event.id, event.to);
  }
  return orderer;
}

test('DEC-01 property: replaying the same log twice gives the same state (idempotent delivery)', () => {
  const events = workload(6, 5);
  const once = replay(events).digest();
  const deduper = new EventDeduper();
  const orderer = new AggregateOrderer();
  replay(events, orderer, deduper);
  replay(events, orderer, deduper);
  assert.equal(orderer.digest(), once);
});

test('DEC-01 property: any interleaving across tasks that keeps per-task order reaches the same state', () => {
  const events = workload(5, 6);
  const expected = replay(events).digest();
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = mulberry(seed);
    const queues = new Map();
    for (const event of events) {
      if (!queues.has(event.task)) queues.set(event.task, []);
      queues.get(event.task).push(event);
    }
    const shuffled = [];
    while ([...queues.values()].some((q) => q.length > 0)) {
      const live = [...queues.values()].filter((q) => q.length > 0);
      shuffled.push(live[Math.floor(random() * live.length)].shift());
    }
    assert.equal(replay(shuffled).digest(), expected, `seed ${seed}`);
  }
});

test('DEC-01 property: under arbitrary permutation, CAS admits at most one transition per revision and never regresses', () => {
  const events = workload(4, 5);
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = mulberry(seed * 7919);
    const shuffled = [...events];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const orderer = new AggregateOrderer();
    const accepted = new Map();
    for (const event of shuffled) {
      const before = orderer.get(event.task).revision;
      const result = orderer.apply(event.task, event.expected, event.id, event.to);
      const after = orderer.get(event.task).revision;
      assert.ok(after >= before, 'revision never goes back');
      if (result.ok) {
        const key = `${event.task}:${event.expected}`;
        assert.equal(accepted.has(key), false, 'one winner per revision');
        accepted.set(key, event.id);
      }
    }
    for (const [task, state] of ['t0', 't1', 't2', 't3'].map((t) => [t, orderer.get(t)])) {
      assert.ok(state.revision <= 5, `${task} bounded`);
    }
  }
});
