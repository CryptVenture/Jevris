import test from 'node:test';
import assert from 'node:assert/strict';


const { completionFromReceipts, stopContinuation, storeReadInput } = await import('../dist/index.js');

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';

function currentReceipt(checkId, revision) {
  return {
    checkId,
    sourceRevision: revision,
    validity: 'current',
    failed: false,
  };
}

test('the second stop after one reminder is unverified', () => {
  const first = stopContinuation({
    remindersAlreadyFired: 0,
    requiredCheckUnavailable: true,
  });
  assert.equal(first.outcome, 'remind');
  assert.equal(first.continuationScheduled, true);
  assert.equal(first.verified, false);
  assert.equal(first.humanStopAvailable, true);
  assert.equal(first.cap, 1);
  const second = stopContinuation({
    remindersAlreadyFired: 1,
    requiredCheckUnavailable: true,
    modelSentence: 'all checks passed',
    source: SOURCE_CANARY,
  });
  assert.equal(second.outcome, 'unverified');
  assert.equal(second.continuationScheduled, false);
  assert.equal(second.verified, false);
  assert.equal(second.humanStopAvailable, true);
  assert.equal(second.cap, 1);
  assert.equal(JSON.stringify(second).includes(SOURCE_CANARY), false);
  assert.equal(JSON.stringify(second).includes('\u001b'), false);
  const again = stopContinuation({
    remindersAlreadyFired: 2,
    requiredCheckUnavailable: true,
  });
  assert.equal(again.continuationScheduled, false);
  assert.equal(again.outcome, 'unverified');
});

test('revision B waits and a model sentence cannot verify', () => {
  const waiting = completionFromReceipts({
    currentRevision: 'rev-b',
    mandatoryChecks: ['check-build'],
    receipts: [
      {
        checkId: 'check-build',
        sourceRevision: 'rev-a',
        validity: 'invalidated',
        failed: false,
      },
    ],
    modelSentence: 'all checks passed',
    jevConfidence: 0.99,
  });
  assert.equal(waiting.verified, false);
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.applied, false);
  assert.equal(waiting.authorityGranted, false);
  assert.equal(waiting.providerCalls, 0);
  assert.deepEqual(waiting.mandatoryChecks, ['check-build']);
  const scored = completionFromReceipts({
    currentRevision: 'rev-b',
    mandatoryChecks: ['check-build'],
    receipts: [],
    score: 0.99,
    modelSentence: 'all checks passed',
  });
  assert.equal(scored.verified, false);
  assert.equal(scored.handoff, false);
  const failed = completionFromReceipts({
    currentRevision: 'rev-b',
    mandatoryChecks: ['check-build'],
    receipts: [
      {
        checkId: 'check-build',
        sourceRevision: 'rev-b',
        validity: 'current',
        failed: true,
      },
    ],
    score: 1,
  });
  assert.equal(failed.verified, false);
  // A frame-shaped object never verifies, even with a current passing receipt row (VER-04).
  const frame = completionFromReceipts({
    currentRevision: 'rev-b',
    mandatoryChecks: ['check-build'],
    receipts: [currentReceipt('check-build', 'rev-b')],
  });
  assert.equal(frame.verified, false);
  assert.equal(frame.waiting, true);
  const opFrame = completionFromReceipts({
    op: 'complete',
    currentRevision: 'rev-b',
    mandatoryChecks: ['check-build'],
    receipts: [currentReceipt('check-build', 'rev-b')],
  });
  assert.equal(opFrame.verified, false);
  const ready = completionFromReceipts(
    storeReadInput({
      currentRevision: 'rev-b',
      mandatoryChecks: ['check-build'],
      receipts: [currentReceipt('check-build', 'rev-b')],
    }),
  );
  assert.equal(ready.verified, true);
  assert.equal(ready.waiting, false);
  assert.equal(ready.applied, false);
  assert.equal(ready.authorityGranted, false);
  assert.equal(ready.providerCalls, 0);
  assert.equal(ready.handoff, false);
});

test('a flaky label and a score do not drop mandatory checks or hand off', () => {
  const result = completionFromReceipts({
    currentRevision: 'rev-b',
    mandatoryChecks: [
      { id: 'check-sec', label: 'flaky' },
      { id: 'check-integ' },
    ],
    receipts: [],
    impact: 'unknown',
    score: 0.99,
    modelSentence: 'all checks passed',
    jevConfidence: 1,
    requiredContextIds: ['ctx-diff'],
    presentContextIds: [],
    source: SOURCE_CANARY,
  });
  assert.equal(result.verified, false);
  assert.equal(result.applied, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.providerCalls, 0);
  assert.deepEqual(result.mandatoryChecks, ['check-sec', 'check-integ']);
  assert.equal(result.suite, 'broader');
  assert.equal(result.handoff, false);
  assert.equal(result.outcome, 'ask');
  assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);
  assert.equal(JSON.stringify(result).includes('\u001b'), false);
  const blocked = completionFromReceipts(
    storeReadInput({
      currentRevision: 'rev-b',
      mandatoryChecks: ['check-build'],
      receipts: [currentReceipt('check-build', 'rev-b')],
      requiredContextIds: ['ctx-diff'],
      presentContextIds: [],
    }),
  );
  assert.equal(blocked.verified, false);
  assert.equal(blocked.handoff, false);
  assert.equal(blocked.outcome, 'ask');
  assert.deepEqual(blocked.mandatoryChecks, ['check-build']);
});

test('branded store input: a per-check current revision and a stale or failed row', () => {
  const stale = completionFromReceipts(
    storeReadInput({
      currentRevision: 'rev-b',
      mandatoryChecks: ['a', 'b'],
      receipts: [
        { checkId: 'a', sourceRevision: 's-1', currentRevision: 's-1', validity: 'current', failed: false },
        { checkId: 'b', sourceRevision: 's-2', currentRevision: 's-3', validity: 'current', failed: false },
      ],
    }),
  );
  assert.equal(stale.verified, false);
  const ok = completionFromReceipts(
    storeReadInput({
      currentRevision: 'rev-b',
      mandatoryChecks: ['a', 'b'],
      receipts: [
        { checkId: 'a', sourceRevision: 's-1', currentRevision: 's-1', validity: 'current', failed: false },
        { checkId: 'b', sourceRevision: 's-3', currentRevision: 's-3', validity: 'current', failed: false },
      ],
    }),
  );
  assert.equal(ok.verified, true);
  const passedClaim = completionFromReceipts({ ...storeReadInput({ currentRevision: 'r', mandatoryChecks: ['a'], receipts: [] }), passed: true });
  assert.equal(passedClaim.verified, false);
  // JSON round-trip drops the brand.
  const copied = JSON.parse(JSON.stringify(storeReadInput({ currentRevision: 'r', mandatoryChecks: ['a'], receipts: [{ checkId: 'a', sourceRevision: 'r', validity: 'current', failed: false }] })));
  assert.equal(completionFromReceipts(copied).verified, false);
});
