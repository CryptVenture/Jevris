// C66 learned router and C71 policy lab (RSH-05, RSH-10): offline training, holdout evaluation,
// the signed-review deployment gate, and the mandatory contamination checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signRecord } from '@jevris/contracts';
import { contaminationChecks, learnedRouteAdvice, learnedRouterDeployable, runPolicyExperiment, syntheticRoutingExamples, trainLearnedRouter } from '../dist/index.js';

const MODELS = [
  { modelId: 'opus', skill: 2.5, costMicroUsd: 2_650_000 },
  { modelId: 'sonnet', skill: 1.5, costMicroUsd: 1_060_000 },
  { modelId: 'haiku', skill: 0.3, costMicroUsd: 530_000 },
];
const OPTIONS = (qualityFloor) => ({ qualityFloor, baselineModelId: 'opus', trainedAt: '2026-09-26T00:00:00Z' });

test('C66: the estimator trains offline, is deterministic, and reports holdout regret, calibration and the router comparison', () => {
  const train = syntheticRoutingExamples(7, 600, MODELS);
  const holdout = syntheticRoutingExamples(8, 300, MODELS);
  const a = trainLearnedRouter(train, holdout, OPTIONS(0.7));
  const b = trainLearnedRouter(train, holdout, OPTIONS(0.7));
  assert.equal(a.ok, true);
  assert.equal(a.artifact.id, b.artifact.id, 'same data, same artifact');
  assert.equal(a.artifact.state, 'candidate');
  assert.equal(a.artifact.holdout.tasks, 300);
  assert.equal(a.artifact.holdout.improvesOnRouter, true);
  assert.ok(a.artifact.holdout.learned.regret < a.artifact.holdout.existingRouter.regret);
  for (const c of a.artifact.holdout.calibration) assert.ok(c.brier >= 0 && c.brier < 0.25 && c.ece >= 0 && c.ece < 0.2, JSON.stringify(c));
  const strict = trainLearnedRouter(train, holdout, OPTIONS(0.9));
  assert.equal(strict.artifact.holdout.improvesOnRouter, false, 'a floor the estimator cannot beat the router at is reported as no gain');
});

test('C66: consent, outcome leakage, identity features and holdout overlap are refused before training', () => {
  const rows = syntheticRoutingExamples(1, 60, MODELS);
  const train = rows.slice(0, 40);
  const holdout = rows.slice(40);
  assert.equal(trainLearnedRouter(train.map((e, i) => (i === 3 ? { ...e, consentId: '' } : e)), holdout, OPTIONS(0.7)).reasonCode, 'CONSENT_MISSING');
  for (const leak of ['verifiedBefore', 'costMicroUsd', 'authorId', 'teamSize']) {
    const leaky = (list) => list.map((e) => ({ ...e, features: { ...e.features, [leak]: 1 } }));
    assert.equal(trainLearnedRouter(leaky(train), leaky(holdout), OPTIONS(0.7)).reasonCode, 'FORBIDDEN_FEATURE', leak);
  }
  assert.equal(trainLearnedRouter(train, [train[0]], OPTIONS(0.7)).detail, 'holdout-overlaps-training');
  assert.equal(trainLearnedRouter(train, holdout, { ...OPTIONS(0.7), baselineModelId: 'gpt' }).reasonCode, 'BASELINE_UNKNOWN');
  assert.equal(trainLearnedRouter([], holdout, OPTIONS(0.7)).reasonCode, 'NO_EXAMPLES');
});

test('C66: only a trusted signed approval of this artifact, with a held-out gain, makes it deployable; even then it is advice', () => {
  const { artifact } = trainLearnedRouter(syntheticRoutingExamples(7, 600, MODELS), syntheticRoutingExamples(8, 300, MODELS), OPTIONS(0.7));
  const keys = generateKeyPairSync('ed25519');
  const trusted = new Map([['cal-1', keys.publicKey.export({ type: 'spki', format: 'pem' })]]);
  const sign = (extra = {}) => signRecord({ schemaVersion: 'jevris-learned-router-review-1', artifactId: artifact.id, decision: 'approve', reviewer: 'owner', reviewedAt: '2026-09-26T00:00:00Z', ...extra }, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'cal-1');
  const features = { contextK: 20, filesTouched: 1, failingTests: 0, python: 1 };
  assert.deepEqual(learnedRouteAdvice(artifact, null, trusted, features), { outcome: 'abstain', reasonCode: 'NOT_REVIEWED', applied: false });
  assert.equal(learnedRouterDeployable(artifact, sign(), new Map()).reasonCode, 'REVIEW_SIGNATURE');
  assert.equal(learnedRouterDeployable(artifact, { ...sign(), reviewer: 'someone else' }, trusted).reasonCode, 'REVIEW_SIGNATURE', 'an edited review fails its signature');
  assert.equal(learnedRouterDeployable(artifact, sign({ decision: 'reject' }), trusted).reasonCode, 'REVIEW_REJECTED');
  assert.equal(learnedRouterDeployable(artifact, sign({ artifactId: 'lr-x' }), trusted).reasonCode, 'REVIEW_FOR_OTHER_ARTIFACT');
  assert.deepEqual(learnedRouterDeployable(artifact, sign(), trusted), { deployable: true, keyId: 'cal-1' });
  const advice = learnedRouteAdvice(artifact, sign(), trusted, features);
  assert.deepEqual([advice.outcome, advice.applied], ['recommend', false]);
  assert.notEqual(advice.modelId, 'opus', 'an easy task routes below the strongest model when the floor allows');
  assert.equal(learnedRouteAdvice(artifact, sign(), trusted, { contextK: 20 }).reasonCode, 'FEATURES_MISSING');
});

test('C71: contamination checks are mandatory; a clean experiment scores each variant and changes nothing', () => {
  const lab = (seed, n, repository, year) => syntheticRoutingExamples(seed, n, MODELS).map((e, i) => ({ ...e, repository, createdAt: `${String(year)}-02-01T00:00:${String(i % 60).padStart(2, '0')}Z`, summary: `${repository} change ${String(seed)} ${String(i)}` }));
  const train = lab(1, 120, 'org/a', 2025);
  const testRows = lab(2, 60, 'org/b', 2026);
  const variants = [{ id: 'floor-70', qualityFloor: 0.7 }, { id: 'sonnet-only', qualityFloor: 0.7, allowedModels: ['sonnet'] }];
  const run = (overrides = {}) => runPolicyExperiment({ train, test: testRows, variants, baselineModelId: 'opus', frozenHoldoutIds: [], evaluationBudget: 1000, ...overrides });
  const clean = run();
  assert.equal(clean.ok, true);
  assert.deepEqual([clean.report.applied, clean.report.reviewRequired, clean.report.evaluations], [false, true, 120]);
  assert.ok(Object.values(clean.report.variants[1].table).every((m) => m === 'sonnet' || m === 'opus'));
  assert.equal(run().report.experimentId, clean.report.experimentId, 'reproducible');
  const dup = { ...testRows[0], taskId: 'dup-1', summary: train[5].summary };
  const checks = contaminationChecks(train, [dup, { ...train[0] }], [train[1].taskId]);
  assert.deepEqual(checks.checks.map((c) => [c.id, c.passed]), [['task-overlap', false], ['repository-overlap', false], ['time-order', false], ['near-duplicate', false], ['frozen-holdout', false]]);
  assert.equal(run({ test: [...testRows, dup] }).reasonCode, 'CONTAMINATED');
  assert.equal(run({ evaluationBudget: 119 }).reasonCode, 'OVER_BUDGET');
  assert.equal(run({ variants: [{ id: 'bad', qualityFloor: 2 }] }).reasonCode, 'INVALID_VARIANT');
});
