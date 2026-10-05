// JEV-0063. Jev's Score is an expectation over the rubric, so it is fractional (the API reports hundredths: 2.98 and
// 1.07 are real answers, see fixtures/jev-real-answers.json; specification section 2.2 and S07). The plan op's review
// (C03 coverage, C07 ranking) carried the raw Score into a result contract that asked for a whole number from 0 to 4, so
// every approved-egress plan with requirements or candidates ended in PAYLOAD_INVALID and a reduced local plan. The
// product's own tests used whole-number scripts, so none saw it. These drive the real plan op with fractional scores and
// check the result against the same contract the sidecar and the CLI check it with. A stub engine: no live call.
import test from 'node:test';
import assert from 'node:assert/strict';

const provider = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');

/**
 * An engine whose Score answers are the numbers `script(id)` names, each a distribution over the rubric's levels that has exactly
 * that expectation (the shape of a real answer, see fixtures/jev-real-answers.json). It answers at once, with no
 * disk and no clock: this is about what the plan op does with a fractional answer, not about how long one takes.
 */
function fractionalEngine(script) {
  return {
    providerConfigured: true,
    sourceEgress: () => 'approved',
    async decide(request) {
      const answers = {};
      for (const [id, q] of Object.entries(request.questions)) {
        const score = script(id);
        const low = Math.floor(score);
        const up = Math.round((score - low) * 100) / 100;
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === low ? Math.round((1 - up) * 100) / 100 : i === low + 1 ? up : 0]));
        answers[id] = { type: 'score', score, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: Math.max(...Object.values(probabilities)) };
      }
      return { abstained: false, decisionId: `d-stub-${Object.keys(answers).join('-')}`, automation: true, rulesOnly: false, result: { answers } };
    },
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice() {
      return { ok: true, decisionId: 'd-stub-advice' };
    },
  };
}

const node = (id, requirementIds, deps = []) => ({
  id, schemaVersion: '1.0', workspaceId: 'w-frac', revision: 'r1', state: 'proposed', requirementIds, dependencyIds: deps, writeScopes: [`src/${id}`], acceptanceCheckIds: ['unit'], rootBudgetId: 'budget-1',
});

function planOp(script) {
  const engine = fractionalEngine(script);
  const op = provider.sidecarOps.find((def) => def.op === 'plan');
  return (body) => op.handle({
    op: 'plan', client: 'cli', scopes: ['advice'], workspace: { id: 'w-frac', root: '/work/repo' }, body, home: '/nonexistent', signal: new AbortController().signal,
    deadline: { remainingMs: () => 30_000, expired: () => false }, store: null, killSwitchStopped: false, engine, trace() {}, jevAssist: 'off',
  });
}

const REQUIREMENTS = [{ id: 'R1', text: 'Show labels in the cart' }, { id: 'R2', text: 'Store labels per account' }, { id: 'R3', text: 'Export labels to CSV' }];
const CANDIDATES = [{ id: 'p-a', summary: 'Ship labels first' }, { id: 'p-b', summary: 'Ship labels and export' }, { id: 'p-c', summary: 'Rewrite the module' }, { id: 'p-d', summary: 'Do nothing yet' }];

test('the plan op delivers fractional Scores in the review, in the plan result contract (JEV-0063)', async () => {
  const scores = { coverage0: 2.88, coverage1: 1.07, plan0: 2.98, plan1: 0, plan2: 4, plan3: 1.07 };
  const call = planOp((id) => scores[id]);
  const out = await call({ tasks: [node('a', ['R1']), node('b', ['R2'], ['a'])], requirements: REQUIREMENTS, candidates: CANDIDATES });
  assert.equal(out.ok, true, `the plan result was refused: ${JSON.stringify(out)}`);
  assert.equal(contracts.surfacePayloadContract('plan').validate(out.body).ok, true);
  const { decomposition, plans } = out.body.review;
  assert.equal(decomposition.reasonCode, 'SCORED');
  assert.deepEqual(decomposition.coverage, [{ requirementId: 'R1', score: 2.88 }, { requirementId: 'R2', score: 1.07 }]);
  assert.equal(plans.reasonCode, 'SCORED');
  // The fraction is kept: 2.98 outranks 1.07 and 4 outranks both; a rounded score would have tied the first with a 3.
  assert.deepEqual(plans.ranking.map((r) => [r.planId, r.rank, r.score]), [['p-c', 1, 4], ['p-a', 2, 2.98], ['p-d', 3, 1.07], ['p-b', 4, 0]]);
});

test('the plan result contract accepts a Score from 0 to 4 in hundredths and refuses one outside it (JEV-0063)', () => {
  const contract = contracts.surfacePayloadContract('plan');
  const base = { valid: true, taskCount: 1, order: ['T1'], waves: [['T1']], criticalPath: ['T1'], ready: ['T1'], issues: [], advice: [] };
  const review = (coverageScore, rankScore) => ({
    decomposition: { label: 'decomposition-review-score', isFeasibility: false, issues: [], coverage: [{ requirementId: 'R1', score: coverageScore }], reasonCode: 'SCORED', decisionId: null },
    plans: { label: 'plan-review-score', isFeasibility: false, reviewRequired: true, ranking: [{ planId: 'p1', rank: 1, score: rankScore }], note: 'A review aid.', reasonCode: 'SCORED', decisionId: null },
  });
  for (const score of [0, 1.07, 2.88, 2.98, 3, 4]) assert.equal(contract.validate({ ...base, review: review(score, score) }).ok, true, `score ${score}`);
  assert.equal(contract.validate({ ...base, review: review(2.5, null) }).ok, true, 'a plan that was not scored still has a null score');
  for (const score of [-0.01, 4.01, 5, Number.NaN, Infinity]) {
    assert.equal(contract.validate({ ...base, review: review(score, 1) }).ok, false, `coverage ${score}`);
    assert.equal(contract.validate({ ...base, review: review(1, score) }).ok, false, `ranking ${score}`);
  }
});
