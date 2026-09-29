import test from 'node:test';
import assert from 'node:assert/strict';


const US08_TEXT = [
  'Next step: request environment evidence.',
  'Do not escalate the coding model.',
  'Diagnostic: missing-service.',
  'Source evidence: absent.',
  'Rejected approaches: patch-a, patch-b.',
  'Proposed cause is not a passing test.',
].join('\n');

function us08Fixture() {
  return {
    diagnostic: 'missing-service',
    sourceEvidence: 'absent',
    fingerprint: 'sameFingerprint',
    sameFingerprintCount: 3,
    commandHashRepeated: true,
    relevantDiff: 'none',
    rejectedApproaches: ['patch-a', 'patch-b'],
    proposedCause: 'service-down',
    maxRepairAttempts: 2,
    repairAttemptsUsed: 1,
  };
}

test('US08 missing-service asks for environment evidence and does not escalate', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  let calls = 0;
  const input = {
    ...us08Fixture(),
    evaluate() {
      calls += 1;
      throw new Error('CANARY_PORT');
    },
    port: {
      evaluate() {
        calls += 1;
        throw new Error('CANARY_PORT');
      },
    },
  };

  const result = adviseFailureLoop(input);
  assert.equal(calls, 0);
  assert.equal(input.repairAttemptsUsed, 1);
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_ADVICE');
  assert.equal(result.nextStep, 'request-environment-evidence');
  assert.equal(result.escalated, false);
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.consentFabricated, false);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.hypothesis, 'service-down');
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  assert.equal(result.text, US08_TEXT);
  assert.equal(result.text.endsWith('\n'), false);
  assert.equal(result.text.includes('\u001b'), false);
  assert.equal(result.text.includes('service-down'), false);
  assert.equal(result.text.includes('sameFingerprint'), false);
  assert.equal(result.text.includes('stronger worker'), false);
  assert.equal(result.text.includes('stronger-worker'), false);
  assert.equal(JSON.stringify(result).includes('CANARY_PORT'), false);

  const again = adviseFailureLoop(input);
  assert.equal(again.nextStep, 'request-environment-evidence');
  assert.equal(input.repairAttemptsUsed, 1);
  assert.equal(calls, 0);
});

const REFUSED_TEXT = 'Recovery advice refused. No action was applied.';

const ABSTAIN_TEXT = [
  'Next step: abstain.',
  'Do not escalate the coding model.',
  'Rejected approaches: patch-a, patch-b.',
  'Proposed cause is not a passing test.',
].join('\n');

const NONE_ABSTAIN_TEXT = [
  'Next step: abstain.',
  'Do not escalate the coding model.',
  'Rejected approaches: none.',
  'Proposed cause is not a passing test.',
].join('\n');

function assertRefused(result, echoed) {
  assert.equal(result.disposition, 'refused');
  assert.equal(result.reasonCode, 'INVALID_REQUEST');
  assert.equal(result.nextStep, 'abstain');
  assert.deepEqual(result.rejectedApproaches, []);
  assert.equal(result.hypothesis, null);
  assert.equal(result.escalated, false);
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.consentFabricated, false);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.text, REFUSED_TEXT);
  assert.equal(result.text.endsWith('\n'), false);
  if (echoed !== undefined) {
    assert.equal(result.text.includes(echoed), false);
    assert.equal(JSON.stringify(result).includes(echoed), false);
  }
}

test('invalid input is refused without echoing the bad value', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const missing = {
    ...us08Fixture(),
    fingerprint: 'leakFingerprint',
  };
  delete missing.sameFingerprintCount;

  const dangerousKey = us08Fixture();
  Object.defineProperty(dangerousKey, 'constructor', {
    value: 'CANARY_DANGEROUS_KEY',
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const cases = [
    ['CANARY_NOT_OBJECT', 'CANARY_NOT_OBJECT'],
    [['CANARY_ARRAY'], 'CANARY_ARRAY'],
    [missing, 'leakFingerprint'],
    [{ ...us08Fixture(), sameFingerprintCount: '3', fingerprint: 'leakCount' }, 'leakCount'],
    [{ ...us08Fixture(), sameFingerprintCount: 11, fingerprint: 'leakBound' }, 'leakBound'],
    [{ ...us08Fixture(), diagnostic: 'environment', fingerprint: 'leakFamily' }, 'leakFamily'],
    [dangerousKey, 'CANARY_DANGEROUS_KEY'],
    [null, undefined],
    [Object.create(null), undefined],
  ];

  for (const [input, echoed] of cases) {
    const result = adviseFailureLoop(input);
    assertRefused(result, echoed);
    if (input !== null && typeof input === 'object' && !Array.isArray(input) && input.diagnostic === 'environment') {
      assert.equal(result.text.includes('environment'), false);
      assert.notEqual(result.nextStep, 'request-environment-evidence');
    }
  }
});

test('an invalid approach list is refused and not truncated', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const input = {
    ...us08Fixture(),
    rejectedApproaches: ['patch-a', '../secret', 'patch-b'],
  };
  const result = adviseFailureLoop(input);
  assertRefused(result, '../secret');
  assert.equal(result.text.includes('patch-a'), false);
  assert.equal(JSON.stringify(result).includes('patch-a'), false);
  assert.equal(JSON.stringify(result).includes('patch-b'), false);
});

test('a fingerprint outside the id pattern is refused and not printed', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const leak = '../leak-fingerprint';
  const result = adviseFailureLoop({
    ...us08Fixture(),
    fingerprint: leak,
  });
  assertRefused(result, leak);
  assertRefused(
    adviseFailureLoop({
      ...us08Fixture(),
      fingerprint: 'constructor',
    }),
    'constructor',
  );
});

test('extra credential fields are not echoed and caller flags stay false', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  let calls = 0;
  const input = {
    ...us08Fixture(),
    sourceText: 'CANARY_SOURCE_EGRESS',
    credential: 'CANARY_SECRET',
    testsPassed: true,
    verified: true,
    escalated: true,
    port: {
      evaluate() {
        calls += 1;
        throw new Error('CANARY_PORT');
      },
    },
  };
  const result = adviseFailureLoop(input);
  assert.equal(calls, 0);
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_ADVICE');
  assert.equal(result.nextStep, 'request-environment-evidence');
  assert.equal(result.text, US08_TEXT);
  assert.equal(result.testsPassed, false);
  assert.equal(result.verified, false);
  assert.equal(result.escalated, false);
  assert.equal(result.hypothesis, 'service-down');
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('CANARY_SOURCE_EGRESS'), false);
  assert.equal(encoded.includes('CANARY_SECRET'), false);
  assert.equal(encoded.includes('CANARY_PORT'), false);
});

test('count 2 is not a loop and does not request environment evidence', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const result = adviseFailureLoop({
    ...us08Fixture(),
    sameFingerprintCount: 2,
  });
  assert.equal(result.disposition, 'abstained');
  assert.equal(result.reasonCode, 'NOT_A_LOOP');
  assert.equal(result.nextStep, 'abstain');
  assert.equal(result.text, ABSTAIN_TEXT);
  assert.equal(result.escalated, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.verified, false);
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  assert.equal(result.hypothesis, 'service-down');
  assert.equal(result.text.includes('request environment evidence'), false);
});

test('a source defect is not rewritten as a missing-service request', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const result = adviseFailureLoop({
    ...us08Fixture(),
    diagnostic: 'source-defect',
  });
  assert.notEqual(result.nextStep, 'request-environment-evidence');
  assert.equal(result.disposition, 'abstained');
  assert.equal(result.reasonCode, 'NOT_A_LOOP');
  assert.equal(result.nextStep, 'abstain');
  assert.equal(result.escalated, false);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  assert.equal(result.hypothesis, 'service-down');
  assert.equal(result.text, ABSTAIN_TEXT);
  assert.equal(result.text.includes('missing-service'), false);
  assert.equal(result.text.includes('request environment evidence'), false);
});

test('empty rejected approaches render none on a valid abstain', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const result = adviseFailureLoop({
    ...us08Fixture(),
    sameFingerprintCount: 2,
    rejectedApproaches: [],
    proposedCause: null,
  });
  assert.equal(result.disposition, 'abstained');
  assert.equal(result.reasonCode, 'NOT_A_LOOP');
  assert.equal(result.nextStep, 'abstain');
  assert.equal(result.text, NONE_ABSTAIN_TEXT);
  assert.deepEqual(result.rejectedApproaches, []);
  assert.equal(result.hypothesis, null);
  assert.equal(result.escalated, false);
  assert.equal(result.testsPassed, false);
});

const CAPPED_TEXT = [
  'Next step: stop with a clear report.',
  'Environment evidence is still missing.',
  'Do not escalate the coding model.',
  'Recovery advice is capped.',
  'Rejected approaches: patch-a, patch-b.',
  'Proposed cause is not a passing test.',
].join('\n');

const CAPPED_SOURCE_TEXT = [
  'Next step: stop with a clear report.',
  'Do not escalate the coding model.',
  'Recovery advice is capped.',
  'Rejected approaches: patch-a, patch-b.',
  'Proposed cause is not a passing test.',
].join('\n');

function assertClosedFlags(result) {
  assert.equal(result.escalated, false);
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.consentFabricated, false);
  assert.equal(result.providerCalls, 0);
}

function assertNoForbiddenOutcome(text) {
  assert.equal(text.includes('worker-route'), false);
  assert.equal(text.includes('worker route'), false);
  assert.equal(text.includes('checkpoint-restore'), false);
  assert.equal(text.includes('checkpoint restore'), false);
  assert.equal(text.includes('rerun'), false);
  assert.equal(text.toLowerCase().includes('flake'), false);
}

test('a capped missing-service loop stops with a report and keeps rejected approaches', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  let calls = 0;
  const input = {
    ...us08Fixture(),
    repairAttemptsUsed: 2,
    evaluate() {
      calls += 1;
      throw new Error('CANARY_PORT');
    },
  };

  const result = adviseFailureLoop(input);
  assert.equal(calls, 0);
  assert.equal(input.repairAttemptsUsed, 2);
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_CAPPED');
  assert.equal(result.nextStep, 'stop-with-report');
  assertClosedFlags(result);
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  assert.equal(result.hypothesis, 'service-down');
  assert.equal(result.text, CAPPED_TEXT);
  assert.equal(result.text.endsWith('\n'), false);
  assert.equal(result.text.includes('\u001b'), false);
  assert.equal(result.text.includes('Environment evidence is still missing.'), true);
  assert.equal(result.text.includes('Recovery advice is capped.'), true);
  assert.equal(result.text.includes('service-down'), false);
  assertNoForbiddenOutcome(result.text);
  assert.equal(JSON.stringify(result).includes('CANARY_PORT'), false);

  const again = adviseFailureLoop(input);
  assert.equal(again.nextStep, 'stop-with-report');
  assert.equal(again.reasonCode, 'LOOP_CAPPED');
  assert.equal(input.repairAttemptsUsed, 2);
  assert.equal(calls, 0);
});

test('max 0 and used 0 is capped immediately and does not escalate', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const input = {
    ...us08Fixture(),
    maxRepairAttempts: 0,
    repairAttemptsUsed: 0,
  };
  const result = adviseFailureLoop(input);
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_CAPPED');
  assert.equal(result.nextStep, 'stop-with-report');
  assert.equal(result.escalated, false);
  assert.equal(result.text, CAPPED_TEXT);
  assert.equal(input.repairAttemptsUsed, 0);
  assert.equal(input.maxRepairAttempts, 0);
  assertNoForbiddenOutcome(result.text);
});

test('a capped source-defect stops without the environment-still-missing line', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const result = adviseFailureLoop({
    ...us08Fixture(),
    diagnostic: 'source-defect',
    repairAttemptsUsed: 2,
  });
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_CAPPED');
  assert.equal(result.nextStep, 'stop-with-report');
  assert.notEqual(result.nextStep, 'request-environment-evidence');
  assert.equal(result.text.includes('Environment evidence is still missing.'), false);
  assert.equal(result.text.includes('request environment evidence'), false);
  assert.equal(result.text, CAPPED_SOURCE_TEXT);
  assertClosedFlags(result);
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  assert.equal(result.hypothesis, 'service-down');
  assertNoForbiddenOutcome(result.text);
});

test('the ten-row failure-loop state table matches nextStep and does not escalate', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const rows = [
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'missing-service',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'request-environment-evidence',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'missing-service',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 2,
      maxRepairAttempts: 2,
      nextStep: 'stop-with-report',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'missing-service',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 0,
      maxRepairAttempts: 0,
      nextStep: 'stop-with-report',
    },
    {
      sameFingerprintCount: 2,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'missing-service',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'abstain',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: false,
      relevantDiff: 'none',
      diagnostic: 'missing-service',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'abstain',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'present',
      diagnostic: 'missing-service',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'abstain',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'missing-service',
      sourceEvidence: 'present',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'abstain',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'source-defect',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'abstain',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'source-defect',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 2,
      maxRepairAttempts: 2,
      nextStep: 'stop-with-report',
    },
    {
      sameFingerprintCount: 3,
      commandHashRepeated: true,
      relevantDiff: 'none',
      diagnostic: 'unknown',
      sourceEvidence: 'absent',
      repairAttemptsUsed: 1,
      maxRepairAttempts: 2,
      nextStep: 'abstain',
    },
  ];

  for (const [index, row] of rows.entries()) {
    const input = {
      ...us08Fixture(),
      sameFingerprintCount: row.sameFingerprintCount,
      commandHashRepeated: row.commandHashRepeated,
      relevantDiff: row.relevantDiff,
      diagnostic: row.diagnostic,
      sourceEvidence: row.sourceEvidence,
      repairAttemptsUsed: row.repairAttemptsUsed,
      maxRepairAttempts: row.maxRepairAttempts,
    };
    const result = adviseFailureLoop(input);
    assert.equal(result.nextStep, row.nextStep, `row ${index}`);
    assertClosedFlags(result);
    assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
    assert.equal(result.hypothesis, 'service-down');
    assert.equal(input.repairAttemptsUsed, row.repairAttemptsUsed);
    if (row.diagnostic === 'source-defect') {
      assert.notEqual(result.nextStep, 'request-environment-evidence');
    }
    assertNoForbiddenOutcome(result.text);
  }
});

test('eleven approach ids are refused and ten ids are copied in order', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const eleven = Array.from({ length: 11 }, (_, index) => `id${index}`);
  const refused = adviseFailureLoop({
    ...us08Fixture(),
    repairAttemptsUsed: 2,
    rejectedApproaches: eleven,
  });
  assertRefused(refused, 'id10');
  assert.equal(JSON.stringify(refused).includes('id0'), false);
  assert.equal(refused.rejectedApproaches.length, 0);

  const ten = Array.from({ length: 10 }, (_, index) => `id${index}`);
  const kept = adviseFailureLoop({
    ...us08Fixture(),
    repairAttemptsUsed: 2,
    rejectedApproaches: ten,
  });
  assert.equal(kept.disposition, 'advice');
  assert.equal(kept.reasonCode, 'LOOP_CAPPED');
  assert.equal(kept.nextStep, 'stop-with-report');
  assert.deepEqual(kept.rejectedApproaches, ten);
  assert.equal(kept.text.includes(ten.join(', ')), true);
  assert.equal(kept.text.includes('id9'), true);
  assert.equal(kept.escalated, false);
  assertNoForbiddenOutcome(kept.text);
});

test('caller testsPassed true does not stick and a proposed cause stays a hypothesis', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const input = {
    ...us08Fixture(),
    proposedCause: 'disk-full',
    testsPassed: true,
    verified: true,
    escalated: true,
  };
  const result = adviseFailureLoop(input);
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_ADVICE');
  assert.equal(result.nextStep, 'request-environment-evidence');
  assert.equal(result.hypothesis, 'disk-full');
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.escalated, false);
  assert.equal('receipt' in result, false);
  assert.equal('exitCode' in result, false);
  assert.equal(result.text.includes('Proposed cause is not a passing test.'), true);
  assert.equal(result.text.includes('disk-full'), false);
  assert.equal(JSON.stringify(result).includes('disk-full'), true);

  const capped = adviseFailureLoop({
    ...input,
    repairAttemptsUsed: 2,
  });
  assert.equal(capped.reasonCode, 'LOOP_CAPPED');
  assert.equal(capped.nextStep, 'stop-with-report');
  assert.equal(capped.hypothesis, 'disk-full');
  assert.equal(capped.verified, false);
  assert.equal(capped.testsPassed, false);
  assert.equal(capped.escalated, false);
  assert.equal('receipt' in capped, false);
  assert.equal('exitCode' in capped, false);
  assert.equal(capped.text.includes('Proposed cause is not a passing test.'), true);
  assert.equal(capped.text.includes('disk-full'), false);
});

test('a null proposed cause stays null on a valid US08 object', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const result = adviseFailureLoop({
    ...us08Fixture(),
    proposedCause: null,
    testsPassed: true,
    verified: true,
  });
  assert.equal(result.disposition, 'advice');
  assert.equal(result.reasonCode, 'LOOP_ADVICE');
  assert.equal(result.nextStep, 'request-environment-evidence');
  assert.equal(result.hypothesis, null);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.escalated, false);
  assert.equal(result.applied, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.consentFabricated, false);
  assert.equal(result.providerCalls, 0);
  assert.equal('receipt' in result, false);
  assert.equal('exitCode' in result, false);
  assert.equal(result.text.includes('Proposed cause is not a passing test.'), true);
});

test('a proposed cause outside the id pattern is refused and not echoed', async () => {
  const { adviseFailureLoop } = await import('../dist/index.js');
  const leak = '../cause-leak';
  const result = adviseFailureLoop({
    ...us08Fixture(),
    proposedCause: leak,
    testsPassed: true,
    verified: true,
  });
  assertRefused(result, leak);
  assert.equal(result.hypothesis, null);
  assert.equal(result.text.includes('Proposed cause is not a passing test.'), false);
});
