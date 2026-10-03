// Live repeated-failure advice: what the trigger filter knows about a failure when it triggers.
// With the adapter's content-free hints (a signature digest, a call digest, the failure's shape) the
// filter counts how many times THIS failure came back in the session, tells it from a different
// failure of the same family, and says how it compares with the previous one. Counts and flags only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const core = await import('../dist/index.js');
const { TriggerFilter, toEventEnvelope } = core;

const sha = (text) => createHash('sha256').update(text).digest('hex');
let n = 0;
let clock = Date.parse('2026-10-03T10:00:00Z');

function envelope(kind, { tool = 'Bash', exitCode, session = 's1', at = null } = {}) {
  n += 1;
  clock += 1000;
  const result = toEventEnvelope({
    event: {
      schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: session, turnId: null, toolUseId: `tu${n}`, toolName: tool,
      agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: false, responseRequired: false, payload: exitCode === undefined ? {} : { exitCode }, dedupKey: sha(`f${n}`),
    },
    workspaceId: 'w1', sequence: n, occurredAt: new Date(at ?? clock).toISOString(), expectedRevision: 'rev-1', deadlineAt: new Date((at ?? clock) + 1000).toISOString(), taskId: `task-${session}`,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.envelope;
}

const SHAPE = { exitClass: 'nonzero', environmental: false, elapsed: 'lt10s', present: [] };
const hint = (signature, commandDigest = 'cccccccccccccccc') => ({ signature, commandDigest, shape: SHAPE });
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const failed = (filter, hints, options) => filter.classify(envelope('tool.failed', options), hints);
const edited = (filter, options) => filter.classify(envelope('tool.finished', { tool: 'Edit', ...options }));

test('the first failure of a family is attempt 1; the same failure returning is attempt 2, then 4 (every second one triggers)', () => {
  const filter = new TriggerFilter();
  const first = failed(filter, hint(A));
  assert.equal(first.trigger, 'new-failure-family');
  assert.deepEqual([first.failure.attempts, first.failure.unsure, first.failure.previous], [1, false, null]);
  const second = failed(filter, hint(A));
  assert.equal(second.trigger, 'repeated-failure');
  assert.deepEqual([second.failure.attempts, second.failure.sameSignature, second.failure.sameCommand, second.failure.editsSince, second.failure.unsure], [2, true, true, 0, false]);
  assert.deepEqual(second.failure.previous, SHAPE, 'the previous failure of the family is kept as its shape, without text');
  assert.equal(second.failure.gapMs, 1000, 'the time since the previous failure');
  assert.equal(failed(filter, hint(A)).reasonCode, 'BELOW_THRESHOLD', 'attempt 3 is counted and does not trigger');
  const fourth = failed(filter, hint(A));
  assert.equal(fourth.trigger, 'repeated-failure', 'the escalation: the same failure again triggers again, not coalesced');
  assert.equal(fourth.failure.attempts, 4);
});

test('two different failures of the same family are not merged: a different signature resets the count', () => {
  const filter = new TriggerFilter();
  failed(filter, hint(A, 'c1c1c1c1c1c1c1c1'));
  assert.equal(failed(filter, hint(A, 'c1c1c1c1c1c1c1c1')).failure.attempts, 2);
  // A different failure by a different call: progress, not a repeat.
  const other = failed(filter, hint(B, 'c2c2c2c2c2c2c2c2'));
  assert.deepEqual([other.trigger, other.reasonCode], [null, 'BELOW_THRESHOLD']);
  const again = failed(filter, hint(B, 'c2c2c2c2c2c2c2c2'));
  assert.deepEqual([again.trigger, again.failure.attempts], ['repeated-failure', 2], 'B has come back twice; A\'s attempts are not added to it');
  // Alternating failures never add up to a repeat.
  const alternating = new TriggerFilter();
  const outcomes = ['aa', 'bb', 'aa', 'bb', 'aa', 'bb'].map((s) => failed(alternating, hint(s.repeat(8), `${s}${s}${s}${s}${s}${s}${s}${s}`)).trigger);
  assert.deepEqual(outcomes, ['new-failure-family', null, null, null, null, null]);
});

test('the same failure returning after a different one in between is advised again, not coalesced with its first run', () => {
  const filter = new TriggerFilter();
  // Different calls, so the second error is progress and not "the same call with new text".
  const a = (call = 'c1c1c1c1c1c1c1c1') => hint(A, call);
  const b = hint(B, 'c2c2c2c2c2c2c2c2');
  failed(filter, a());
  const firstRun = failed(filter, a());
  assert.deepEqual([firstRun.trigger, firstRun.failure.attempts], ['repeated-failure', 2]);
  assert.equal(failed(filter, b).reasonCode, 'BELOW_THRESHOLD', 'a different failure in between ends the run');
  failed(filter, a());
  const secondRun = failed(filter, a());
  assert.deepEqual([secondRun.trigger, secondRun.reasonCode, secondRun.failure.attempts], ['repeated-failure', 'TRIGGERED', 2], 'A, A, B, A, A advises on both pairs of A');
  assert.notEqual(secondRun.coalesceKey, firstRun.coalesceKey, 'each run has its own key');
  assert.equal(failed(filter, a()).reasonCode, 'BELOW_THRESHOLD', 'the third A of the run is counted and does not trigger');
});

test('the same call run again with nothing edited and a different error text is possibly the same failure: counted, flagged unsure', () => {
  const filter = new TriggerFilter();
  failed(filter, hint(A));
  const second = failed(filter, hint(B));
  assert.equal(second.trigger, 'repeated-failure');
  assert.deepEqual([second.failure.attempts, second.failure.sameSignature, second.failure.sameCommand, second.failure.unsure], [2, false, true, true]);
});

test('an edit between two attempts makes a different signature progress, not a repeat; the edits are counted', () => {
  const filter = new TriggerFilter();
  failed(filter, hint(A));
  edited(filter);
  edited(filter);
  const changed = failed(filter, hint(B));
  assert.deepEqual([changed.trigger, changed.reasonCode], [null, 'BELOW_THRESHOLD'], 'the failure changed after edits');
  edited(filter);
  const same = failed(filter, hint(B));
  assert.equal(same.trigger, 'repeated-failure');
  assert.deepEqual([same.failure.attempts, same.failure.editsSince, same.failure.sameCommand], [2, 1, true], 'the same failure came back after one more edit');
});

test('without hints a failure is told apart by its family alone, as before, and carries a plain observation', () => {
  const filter = new TriggerFilter();
  const first = filter.classify(envelope('tool.failed', { exitCode: 1 }));
  assert.equal(first.trigger, 'new-failure-family');
  const second = filter.classify(envelope('tool.failed', { exitCode: 1 }));
  assert.equal(second.trigger, 'repeated-failure');
  assert.deepEqual([second.failure.attempts, second.failure.sameSignature, second.failure.sameCommand, second.failure.unsure], [2, true, null, false]);
  assert.equal(filter.classify(envelope('tool.finished', { tool: 'Grep' })).failure, undefined, 'only a failure result carries an observation');
});

test('failures are counted per session and per family', () => {
  const filter = new TriggerFilter();
  failed(filter, hint(A), { session: 's1' });
  assert.equal(failed(filter, hint(A), { session: 's2' }).trigger, 'new-failure-family', 'another session has its own count');
  assert.equal(failed(filter, hint(A), { session: 's1', tool: 'Bash' }).failure.attempts, 2);
  assert.equal(failed(filter, hint(A), { session: 's1', tool: 'WebFetch' }).trigger, 'new-failure-family', 'another tool is another family');
});

test('an unreadable time is a null gap, never a guess', () => {
  const filter = new TriggerFilter();
  failed(filter, hint(A));
  const second = failed(filter, hint(A));
  assert.equal(typeof second.failure.gapMs, 'number');
  // An envelope whose time cannot be read still counts; the gap is unknown.
  const third = filter.classify({ ...envelope('tool.failed'), occurredAt: 'not a time' }, hint(A));
  assert.equal(third.reasonCode, 'BELOW_THRESHOLD');
  const fourth = filter.classify({ ...envelope('tool.failed'), occurredAt: 'not a time' }, hint(A));
  assert.deepEqual([fourth.trigger, fourth.failure.gapMs], ['repeated-failure', null]);
});
