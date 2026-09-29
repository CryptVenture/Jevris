import test from 'node:test';
import assert from 'node:assert/strict';

const e = await import('../dist/index.js');

let serial = 0;
const R = (decisionSpecId, accepted, reason) => ({ recommendationId: `r-${(serial += 1)}`, decisionSpecId, accepted, ...(reason === undefined ? {} : { reason }) });

test('EVL-11: feedback separates preference, missing context and error; only errors count as errors', () => {
  const records = [
    ...Array.from({ length: 16 }, () => R('model-route', true)),
    R('model-route', false, 'preference'), R('model-route', false, 'preference'),
    R('model-route', false, 'missing-context'),
    R('model-route', false, 'error'),
    R('ambiguity', true), R('ambiguity', false, 'preference'), R('ambiguity', false),
  ];
  const [ambiguity, route] = e.analyzeFeedback(records);
  assert.equal(route.decisionSpecId, 'model-route');
  assert.deepEqual(route.rejectedBy, { preference: 2, 'missing-context': 1, error: 1, unspecified: 0 });
  assert.equal(route.total, 20);
  assert.equal(route.errorRate.point, 1 / 20, 'preferences are not errors');
  assert.ok(route.errorRate.lower < 0.05 && route.errorRate.upper > 0.05);
  assert.deepEqual(route.hypotheses.map((h) => h.kind), ['possible-error', 'missing-context']);
  assert.ok(route.hypotheses.every((h) => h.action === 'review-through-release-pipeline'));
  assert.equal(route.policyChanged, false);
  assert.equal(ambiguity.unlabelledShare, 0.5);
  assert.deepEqual(ambiguity.hypotheses.map((h) => h.kind), ['preference-only']);
});

test('EVL-11: sandboxed replay measures alternatives in the sandbox only and claims no saving', async () => {
  const cases = [
    { caseId: 'c1', input: { size: 1 }, loggedPolicy: 'sonnet', loggedSucceeded: true },
    { caseId: 'c2', input: { size: 9 }, loggedPolicy: 'sonnet', loggedSucceeded: true },
    { caseId: 'c3', input: { size: 3 }, loggedPolicy: 'sonnet', loggedSucceeded: true },
  ];
  const runner = { async run(input) { return { succeeded: input.size < 5, sandboxed: input.size !== 3 }; } };
  const replay = await e.sandboxedReplay(cases, 'haiku', runner);
  assert.deepEqual(replay.results, [
    { caseId: 'c1', policy: 'haiku', succeeded: true, measuredIn: 'sandbox' },
    { caseId: 'c2', policy: 'haiku', succeeded: false, measuredIn: 'sandbox' },
  ]);
  assert.deepEqual(replay.refused, ['c3'], 'a run outside a sandbox is not counted');
  assert.equal(replay.savingClaim, null);
});

test('EVL-11: exploration is narrow, logged with propensities, and never touches risky actions', () => {
  const random = e.seededRandom(5);
  const choices = Array.from({ length: 2000 }, () => e.exploreSafely({ defaultAction: 'sonnet', alternatives: ['sonnet', 'haiku', 'opus'], risk: 'low', epsilon: 0.1, random }));
  const explored = choices.filter((c) => c.explored);
  assert.ok(explored.length > 120 && explored.length < 280, `${explored.length} explored`);
  for (const c of explored) assert.equal(c.propensity, 0.05);
  for (const c of choices.filter((c) => !c.explored)) assert.equal(c.propensity, 0.9);
  assert.deepEqual(e.exploreSafely({ defaultAction: 'sonnet', alternatives: ['haiku'], risk: 'high', epsilon: 0.2, random }), { action: 'sonnet', propensity: 1, explored: false, reasonCode: 'RISK_NOT_LOW' });
  assert.equal(e.exploreSafely({ defaultAction: 'sonnet', alternatives: ['haiku'], risk: 'medium', epsilon: 0.2, random }).explored, false);
  assert.equal(e.exploreSafely({ defaultAction: 'a', alternatives: ['b'], risk: 'low', epsilon: 0, random }).reasonCode, 'EXPLORATION_DISABLED');
  // Epsilon is capped: exploration stays narrow even if configured wide.
  const wide = Array.from({ length: 1000 }, () => e.exploreSafely({ defaultAction: 'a', alternatives: ['b'], risk: 'low', epsilon: 0.9, random }));
  assert.ok(wide.filter((c) => c.explored).length < 260);
});

test('EVL-11: the off-policy estimate recovers a known mean and is labelled an estimate, not a saving', () => {
  const random = e.seededRandom(8);
  const logs = [];
  for (let i = 0; i < 4000; i += 1) {
    const c = e.exploreSafely({ defaultAction: 'sonnet', alternatives: ['haiku'], risk: 'low', epsilon: 0.2, random });
    // True success: sonnet 0.9, haiku 0.6.
    const reward = random() < (c.action === 'sonnet' ? 0.9 : 0.6) ? 1 : 0;
    logs.push({ action: c.action, propensity: c.propensity, reward });
  }
  const haiku = e.inversePropensityEstimate(logs, (a) => (a === 'haiku' ? 1 : 0));
  assert.ok(Math.abs(haiku.estimate - 0.6) < 0.05, String(haiku.estimate));
  assert.ok(haiku.lower < 0.6 && haiku.upper > 0.6);
  assert.equal(haiku.label, 'off-policy-estimate');
  assert.equal(haiku.savingClaim, null);
  assert.ok(haiku.effectiveSamples > 600 && haiku.effectiveSamples < 1000);
  assert.deepEqual(e.inversePropensityEstimate([], () => 1).estimate, null);
});
