// The helpers a test uses to read a real hook answer on a host of any speed (test/acceptance/hook-settled.mjs): the
// sidecar defers a subscriber that was slow on the event before, and a deferred answer shows and takes nothing. Scripted
// answers stand in for the hook process, so each case is exact and nothing here waits on a clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFERRED, untilShown, warmHooks } from './acceptance/hook-settled.mjs';

/** A box whose hook answers are scripted: `reasons` in order, each with the stdout given beside it. */
function scripted(answers) {
  const sent = [];
  return {
    sent,
    hook(harness, native, options) {
      sent.push({ harness, native, options });
      const next = answers[Math.min(sent.length - 1, answers.length - 1)];
      return { code: 0, stdout: next.stdout ?? '', stderr: '', reason: next.reason };
    },
  };
}

test('warming sends throwaway events until two in a row are answered with nothing deferred', () => {
  const box = scripted([{ reason: DEFERRED }, { reason: DEFERRED }, { reason: 'NO_PROPOSAL' }, { reason: DEFERRED }, { reason: 'NO_PROPOSAL' }, { reason: 'NO_PROPOSAL' }, { reason: 'NO_PROPOSAL' }]);
  warmHooks(box, 'kilo', (i) => ({ n: i }), { tag: 'x' });
  assert.equal(box.sent.length, 6, 'a clean answer after a deferred one does not end it; two clean ones in a row do');
  assert.deepEqual(box.sent.map((s) => s.native.n), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(box.sent[0].options, { tag: 'x' });
});

test('warming names itself when the sidecar keeps deferring, and when a hook fails', () => {
  assert.throws(() => warmHooks(scripted([{ reason: DEFERRED }]), 'kilo', () => ({})), /kept deferring its subscribers while warming up \(last answer SUBSCRIBER_QUEUED\)/);
  const failing = { hook: () => ({ code: 1, stdout: '', stderr: 'boom', reason: null }) };
  assert.throws(() => warmHooks(failing, 'kilo', () => ({})), /warm-up hook exited 1: boom/);
});

test('an event that showed nothing because it was deferred is followed by the next one, and the one that showed the line is returned', () => {
  const box = scripted([{ reason: DEFERRED }, { reason: DEFERRED }, { reason: 'PROPOSED_BY_DECISION_ENGINE', stdout: '{"system":["the line"]}' }]);
  const shown = untilShown(box, 'kilo', (n) => ({ try: n }), (hook) => hook.stdout.includes('the line'));
  assert.equal(shown.tries, 3);
  assert.deepEqual(shown.native, { try: 3 }, 'the event that showed it, so a test can deliver it again');
  assert.equal(shown.hook.reason, 'PROPOSED_BY_DECISION_ENGINE');
});

test('an event that showed nothing and was not deferred fails with what the hook said, and so does a line that never comes', () => {
  const quiet = scripted([{ reason: DEFERRED }, { reason: 'NO_PROPOSAL', stdout: '' }]);
  assert.throws(() => untilShown(quiet, 'kilo', () => ({}), () => false), /was not shown, and the event was not deferred either: SUBSCRIBER_QUEUED: \(empty\) \| NO_PROPOSAL: \(empty\)/);
  const always = scripted([{ reason: DEFERRED }]);
  assert.throws(() => untilShown(always, 'kilo', () => ({}), () => false, {}, 3), /not shown in 3 events, every one deferred/);
  assert.equal(always.sent.length, 3);
});
