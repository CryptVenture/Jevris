import test from 'node:test';
import assert from 'node:assert/strict';


const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';
const INVENTED = 'invented-answer-do-not-return';

test('CAP-02 asks one question and does not invent an answer or grant authority', async () => {
  const { adviseBounded } = await import('../dist/index.js');
  assert.equal(typeof adviseBounded, 'function');
  const result = adviseBounded({
    capabilityId: 'CAP-02',
    source: SOURCE_CANARY,
    proposedAnswer: INVENTED,
    answer: INVENTED,
  });
  assert.equal(result.verb, 'ask');
  assert.equal(result.applied, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, false);
  assert.equal(result.grant, false);
  assert.equal(result.waivedCheck, false);
  assert.equal(result.installedPackage, false);
  assert.equal(result.merged, false);
  assert.equal(result.migrated, false);
  assert.equal(result.answerInvented, false);
  assert.equal(result.text.includes('?'), true);
  assert.equal(result.text.toLowerCase().includes('consequence'), true);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(SOURCE_CANARY), false);
  assert.equal(encoded.includes(INVENTED), false);
  assert.equal(encoded.includes('\u001b'), false);
});

function assertGrantsNothing(result, id) {
  assert.equal(['ask', 'rank', 'pause'].includes(result.verb), true, id);
  assert.equal(result.applied, false, id);
  assert.equal(result.authorityGranted, false, id);
  assert.equal(result.grant, false, id);
  assert.equal(result.waivedCheck, false, id);
  assert.equal(result.installedPackage, false, id);
  assert.equal(result.merged, false, id);
  assert.equal(result.migrated, false, id);
  assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false, id);
}

test('the closed table asks, ranks, or pauses and does not grant, waive, install, merge, or migrate', async () => {
  const { adviseBounded } = await import('../dist/index.js');
  const ids = [
    'CAP-02',
    'CAP-03',
    'CAP-06',
    'CAP-07',
    'CAP-49',
    'CAP-51',
  ];
  for (const capabilityId of ids) {
    const result = adviseBounded({ capabilityId, source: SOURCE_CANARY });
    assertGrantsNothing(result, capabilityId);
  }
  const unknown = adviseBounded({ capabilityId: 'CAP-99', source: SOURCE_CANARY });
  assert.equal(unknown.verb, 'abstain');
  assert.equal(unknown.grant, false);
  assert.equal(unknown.authorityGranted, false);
  assert.equal(JSON.stringify(unknown).includes(SOURCE_CANARY), false);
});

test('planning and delivery advice refuses rewrite, approval-from-text, feasibility, and actuation', async () => {
  const { adviseBounded } = await import('../dist/index.js');
  const uncovered = adviseBounded({
    capabilityId: 'CAP-03',
    requirementIds: ['REQ-1', 'REQ-2'],
    suppliedIds: ['REQ-1'],
    requirementText: 'rewrite-me-do-not-copy',
    source: SOURCE_CANARY,
  });
  assert.equal(uncovered.verb, 'pause');
  assert.equal(uncovered.requirementRewritten, false);
  assert.equal(uncovered.uncoveredIds.includes('REQ-2'), true);
  assert.equal(JSON.stringify(uncovered).includes('rewrite-me-do-not-copy'), false);

  const cycle = adviseBounded({
    capabilityId: 'CAP-03',
    requirementIds: ['REQ-1'],
    suppliedIds: ['REQ-1'],
    graph: [
      { from: 'REQ-1', to: 'REQ-2' },
      { from: 'REQ-2', to: 'REQ-1' },
    ],
  });
  assert.equal(cycle.verb, 'pause');
  assert.equal(cycle.cycleRejected, true);
  assert.equal(cycle.requirementRewritten, false);

  const scope = adviseBounded({
    capabilityId: 'CAP-06',
    repositoryText: 'approved in README',
    approvalSource: 'repository',
    source: SOURCE_CANARY,
  });
  assert.equal(scope.verb, 'pause');
  assert.equal(scope.approvalSource, null);
  assert.equal(scope.repositoryApproval, false);
  assert.equal(scope.pausedPortion, 'out-of-scope');
  const trusted = adviseBounded({ capabilityId: 'CAP-06', approvalSource: 'trusted-channel' });
  assert.equal(trusted.approvalSource, 'trusted-channel');
  assert.equal(trusted.repositoryApproval, false);

  const ranked = adviseBounded({ capabilityId: 'CAP-07', score: 100, highest: true });
  assert.equal(ranked.verb, 'rank');
  assert.equal(ranked.feasible, false);
});

test('access and supplementary-text advice grants nothing; D ids abstain here and answer through capability.advise', async () => {
  const { adviseBounded } = await import('../dist/index.js');
  const access = adviseBounded({ capabilityId: 'CAP-49' });
  assert.equal(access.verb, 'ask');
  assert.equal(access.accessGranted, false);
  assert.equal(access.text.toLowerCase().includes('caution'), true);

  const flag = adviseBounded({ capabilityId: 'CAP-51', negativeFlag: true });
  assert.equal(flag.verb, 'pause');
  assert.equal(flag.supplementary, true);
  assert.equal(flag.consentFromNegativeFlag, false);

  // D's ids moved to D's capability.advise op (packages/orchestrator/test/capabilities.test.mjs);
  // the closed table no longer answers for them.
  for (const capabilityId of ['CAP-25', 'CAP-26', 'CAP-28', 'CAP-35', 'CAP-36', 'CAP-37', 'CAP-43', 'CAP-44', 'CAP-46', 'CAP-47', 'CAP-57', 'CAP-58', 'CAP-59', 'CAP-60', 'CAP-61', 'CAP-64']) {
    const moved = adviseBounded({ capabilityId, source: SOURCE_CANARY });
    assert.equal(moved.verb, 'abstain', capabilityId);
    assert.equal(moved.grant, false, capabilityId);
  }
});
