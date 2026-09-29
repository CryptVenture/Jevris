import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const e = await import('../dist/index.js');
const core = await import('@jevris/core');

const H = (c) => `sha256:${c.repeat(64)}`;
const KEYS = generateKeyPairSync('ed25519');
const RELEASE_KEY = { privateKeyPem: KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'calibration-test-key' };
const TRUSTED = new Map([['calibration-test-key', KEYS.publicKey.export({ type: 'spki', format: 'pem' })]]);
const CONTEXT = {
  nowMs: Date.parse('2026-09-25T12:00:00Z'), decisionSpecId: 'worker-readiness', decisionSpecVersion: 'v1', questionHash: H('a'), modelId: 'jev-1.13.0', modelRevisionHash: H('b'), encoderHash: H('c'), sliceId: 'bounded-edit',
};

const C = (sliceId, probability, outcome) => ({ sliceId, probability, outcome });
function cases(slice, high, low, lowFailures) {
  return [
    ...Array.from({ length: high }, () => C(slice, 0.9, true)),
    ...Array.from({ length: low }, (_, i) => C(slice, 0.3, i >= lowFailures)),
  ];
}

function input(overrides = {}) {
  return {
    id: 'cal-worker-readiness-synthetic-2', decisionSpecId: 'worker-readiness', decisionSpecVersion: 'v1',
    dataset: { id: 'synthetic-routing-corpus', version: 'v2', contentHash: H('d') }, questionHash: H('a'), model: { modelId: 'jev-1.13.0', revisionHash: H('b') }, encoderHash: H('c'),
    errorBudget: 0.05,
    calibration: [...cases('bounded-edit', 100, 20, 10), ...cases('tiny-slice', 8, 4, 2)],
    holdout: [...cases('bounded-edit', 50, 10, 5), ...cases('tiny-slice', 4, 2, 1)],
    minimumSliceSamples: 30, issuedAt: '2026-09-21T00:00:00Z', expiresAt: '2026-12-21T00:00:00Z',
    ...overrides,
  };
}

test('RTE-13: the threshold is the lowest whose false-accept upper bound fits the error budget', () => {
  const pick = e.selectThreshold(cases('s', 100, 20, 10), 0.05);
  // At 0.3 the upper bound on 10 false accepts of 120 is far above 5 %; at 0.9 zero of 100 fits.
  assert.equal(pick.threshold, 0.9);
  assert.deepEqual([pick.accepted, pick.falseAccepts], [100, 0]);
  assert.ok(pick.falseAcceptUpper <= 0.05 && pick.falseAcceptUpper > 0.02);
  // Zero failures in too few accepted cases cannot prove a 5 % bound: the upper bound decides.
  assert.equal(e.selectThreshold(cases('s', 40, 0, 0), 0.05), null);
  assert.equal(e.selectThreshold(cases('s', 5, 0, 0), 0.5), null, 'below the minimum accepted count');
});

test('RTE-13: proposals are drafts; small slices stay advisory; the holdout is reported, never tuned on', () => {
  const result = e.proposeCalibration(input());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.proposal.releaseState, 'draft');
  assert.equal('signature' in result.proposal, false);
  assert.equal('reviewer' in result.proposal, false);
  assert.deepEqual(result.advisorySlices, ['tiny-slice']);
  assert.deepEqual(result.proposal.permittedSlices, [{ sliceId: 'bounded-edit', calibrationSampleSize: 120, holdoutSampleSize: 60 }]);
  assert.equal(result.proposal.threshold.value, 0.9);
  assert.equal(result.holdout[0].accepted, 50);
  // Flipping every holdout outcome changes the report, not the threshold.
  const flipped = e.proposeCalibration(input({ holdout: input().holdout.map((c) => ({ ...c, outcome: !c.outcome })) }));
  assert.equal(flipped.proposal.threshold.value, 0.9);
  assert.notDeepEqual(flipped.proposal.uncertaintyInterval, result.proposal.uncertaintyInterval);
  assert.deepEqual(e.proposeCalibration(input({ minimumSliceSamples: 500 })), { ok: false, reasonCode: 'NO_SLICE_LARGE_ENOUGH' });
  assert.deepEqual(e.proposeCalibration(input({ errorBudget: 0.001 })), { ok: false, reasonCode: 'NO_THRESHOLD_WITHIN_BUDGET' });
});

test('RTE-13: only a reviewed, signed release is accepted by the RTE-04 loader; drafts never load', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-calrel-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = e.proposeCalibration(input());
  // The pipeline never writes a release file: proposing is pure.
  assert.deepEqual(readdirSync(home), []);
  const draft = core.checkCalibration(result.proposal, { trustedKeys: TRUSTED, context: CONTEXT });
  assert.equal(draft.eligible, false);
  assert.equal(draft.stage, 'validate');
  assert.deepEqual(e.releaseProposal(result.proposal, { reviewerId: 'reviewer-1', reviewedAt: '2026-09-22T00:00:00Z', approved: false }, RELEASE_KEY), { ok: false, reasonCode: 'NOT_APPROVED' });
  const released = e.releaseProposal(result.proposal, { reviewerId: 'reviewer-1', reviewedAt: '2026-09-22T00:00:00Z', approved: true }, RELEASE_KEY);
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(released.artifact.releaseState, 'released');
  assert.equal(released.artifact.reviewer.id, 'reviewer-1');
  const accepted = core.checkCalibration(released.artifact, { trustedKeys: TRUSTED, context: CONTEXT });
  assert.equal(accepted.eligible, true, JSON.stringify(accepted));
  assert.equal(accepted.qualityFloor, 0.9);
  // The advisory slice is not permitted by the release.
  assert.equal(core.checkCalibration(released.artifact, { trustedKeys: TRUSTED, context: { ...CONTEXT, sliceId: 'tiny-slice' } }).reasonCode, 'SLICE_NOT_PERMITTED');
  // A key outside the trusted release set is refused.
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rogue = e.releaseProposal(result.proposal, { reviewerId: 'reviewer-1', reviewedAt: '2026-09-22T00:00:00Z', approved: true }, { privateKeyPem: other, keyId: 'rogue' });
  assert.equal(core.checkCalibration(rogue.artifact, { trustedKeys: TRUSTED, context: CONTEXT }).reasonCode, 'UNKNOWN_KEY');
});

test('RTE-03, C09: holdout cases that name their worker model give signed per-model qualities on permitted slices only', (t) => {
  const withModel = (list, modelId, successes) => list.map((c, i) => ({ ...c, modelId, outcome: i < successes }));
  const holdout = [
    ...withModel(cases('bounded-edit', 50, 10, 5), 'claude-opus-5', 57),
    ...withModel(cases('bounded-edit', 40, 0, 0), 'claude-sonnet-5', 36),
    ...withModel(cases('bounded-edit', 10, 0, 0), 'claude-haiku-4-5-20251001', 9),
    ...withModel(cases('tiny-slice', 4, 2, 1), 'claude-opus-5', 5),
  ];
  const result = e.proposeCalibration(input({ holdout }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const qualities = result.proposal.modelQualities;
  assert.deepEqual(qualities.map((q) => [q.modelId, q.sliceId, q.point, q.sampleSize]), [
    ['claude-opus-5', 'bounded-edit', 0.95, 60],
    ['claude-sonnet-5', 'bounded-edit', 0.9, 40],
  ], 'haiku (10 cases) is below the minimum and tiny-slice is not permitted');
  for (const q of qualities) assert.ok(q.lower <= q.point && q.point <= q.upper);
  const released = e.releaseProposal(result.proposal, { reviewerId: 'reviewer-1', reviewedAt: '2026-09-22T00:00:00Z', approved: true }, RELEASE_KEY);
  assert.equal(released.ok, true, JSON.stringify(released));
  const loaded = core.checkCalibration(released.artifact, { trustedKeys: TRUSTED, context: CONTEXT });
  assert.equal(loaded.eligible, true);
  assert.deepEqual(core.releasedQualities(loaded.artifact, 'bounded-edit').map((q) => [q.modelId, q.sourceId]), [['claude-opus-5', 'cal-worker-readiness-synthetic-2'], ['claude-sonnet-5', 'cal-worker-readiness-synthetic-2']]);
  // The qualities are signed: changing one breaks the signature.
  const tampered = { ...released.artifact, modelQualities: released.artifact.modelQualities.map((q) => ({ ...q, lower: 0.99, point: 0.995, upper: 0.999 })) };
  assert.equal(core.checkCalibration(tampered, { trustedKeys: TRUSTED, context: CONTEXT }).reasonCode, 'BAD_SIGNATURE');
  void t;
});
