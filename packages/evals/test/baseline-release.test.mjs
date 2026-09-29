// C16 signed baseline release (SSOT §18.3 and §18.5 as amended at 6d7222a): built from the bundled
// published rows and the owner's seed, listed as its holdout report, signed only by a reviewer, and
// accepted by the routing loader with the priors route learning reads. No harness, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

const KEYS = generateKeyPairSync('ed25519');
const RELEASE_KEY = { privateKeyPem: KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'calibration-test-key' };
const TRUSTED = new Map([['calibration-test-key', KEYS.publicKey.export({ type: 'spki', format: 'pem' })]]);
const SEL = `sha256:${'a'.repeat(64)}`;
const RUNS = `sha256:${'b'.repeat(64)}`;
const NOW = Date.parse('2026-10-01T00:00:00Z');

function seedRow(modelId, effort, successes, trials, extra = {}) {
  return {
    priorSliceId: 'issue-fix', modelId, effort, successRate: Math.round((successes / trials) * 10_000) / 10_000, successes, trials,
    benchmark: 'swe-bench-live@b51a8642 (full, after 2026-02-01)', harness: 'claude-code', sourceId: 'seed:swe-bench-live@2026-09',
    url: 'https://huggingface.co/datasets/SWE-bench-Live/SWE-bench-Live', publishedOn: '2026-09-30', fetchedOn: '2026-09-30',
    meanTokens: 9_000_000, meanApiEquivalentUsd: 7.85, selectionHash: SEL, runsHash: RUNS, ...extra,
  };
}

function input(overrides = {}) {
  const context = core.workerCalibrationContext({ sliceId: '-', nowMs: NOW });
  return {
    id: 'baseline-2026-10',
    issuedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    context: {
      decisionSpecId: context.decisionSpecId,
      decisionSpecVersion: context.decisionSpecVersion,
      questionHash: context.questionHash,
      model: { modelId: context.modelId, revisionHash: context.modelRevisionHash },
      encoderHash: context.encoderHash,
    },
    published: core.BUNDLED_PUBLIC_PRIORS,
    seed: [seedRow('claude-opus-5-5', 'medium', 7, 12), seedRow('claude-sonnet-5', 'high', 8, 12, { meanTokens: 6_000_000, meanApiEquivalentUsd: 4.1 })],
    defaultEffort: (modelId) => core.registryModel(core.BUNDLED_MODEL_REGISTRY, modelId)?.defaultEffort ?? null,
    ...overrides,
  };
}

test('C16 baseline: the Jeffreys interval is the Beta(1/2 + s, 1/2 + f) central 95%, 0 or 1 at the edges, rounded outward', () => {
  const i = e.jeffreysInterval(7, 12);
  assert.ok(Math.abs(e.betaCdf(i.lower, 7.5, 5.5) - 0.025) < 5e-4, JSON.stringify(i));
  assert.ok(Math.abs(e.betaCdf(i.upper, 7.5, 5.5) - 0.975) < 5e-4, JSON.stringify(i));
  assert.equal(e.jeffreysInterval(0, 10).lower, 0);
  assert.equal(e.jeffreysInterval(10, 10).upper, 1);
  const a = e.jeffreysInterval(3, 10);
  const b = e.jeffreysInterval(7, 10);
  assert.ok(Math.abs(a.lower - (1 - b.upper)) <= 1e-4 && Math.abs(a.upper - (1 - b.lower)) <= 1e-4, 'symmetric');
});

test('C16 baseline: published rows enter only at the model default effort, the seed at its own; the sources are the holdout report', () => {
  const r = e.proposeBaselineRelease(input());
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = r.proposal;
  assert.equal(p.releaseState, 'draft');
  assert.equal(p.uncertaintyInterval.method, 'beta-posterior');
  // Outside the §18.5 gate the baseline never routes: the router's quality floor is 1.
  assert.deepEqual(p.threshold, { metric: 'noul-probability', value: 1, errorBudget: 0.1 });
  // Every bundled row today is at an effort other than its model's default (checked 2026-09-26).
  assert.equal(r.report.excluded.length, core.BUNDLED_PUBLIC_PRIORS.length);
  assert.ok(r.report.excluded.every((x) => x.reasonCode === 'EFFORT_NOT_DEFAULT'));
  assert.deepEqual(p.baselineSources.map((s) => [s.kind, s.modelId, s.effort, s.successes, s.trials, s.selectionHash, s.runsHash]), [
    ['seed', 'claude-opus-5-5', 'medium', 7, 12, SEL, RUNS],
    ['seed', 'claude-sonnet-5', 'high', 8, 12, SEL, RUNS],
  ]);
  assert.deepEqual(p.permittedSlices, [{ sliceId: 'issue-fix', calibrationSampleSize: 24, holdoutSampleSize: 24 }]);
  assert.deepEqual(p.modelQualities.map((q) => [q.modelId, q.effort, q.point, q.sampleSize, q.meanCostMicroUsd, q.meanTokens]), [
    ['claude-opus-5-5', 'medium', 0.5833, 12, 7_850_000, 9_000_000],
    ['claude-sonnet-5', 'high', 0.6667, 12, 4_100_000, 6_000_000],
  ]);
  assert.equal(p.dataset.contentHash, contracts.contentHash(p.baselineSources));
  // A published row at the default effort is pooled with the seed for the same arm, and listed.
  const withRow = e.proposeBaselineRelease(input({ published: [{ ...core.BUNDLED_PUBLIC_PRIORS[1], effort: 'medium', successRate: 0.5, trials: 20 }] }));
  const opus = withRow.proposal.modelQualities.find((q) => q.modelId === 'claude-opus-5-5');
  assert.deepEqual([opus.sampleSize, opus.point], [32, Math.round((17 / 32) * 10_000) / 10_000]);
  assert.deepEqual(withRow.proposal.baselineSources.map((s) => s.kind), ['published', 'seed', 'seed']);
  // A local slice can take the benchmark slice's evidence.
  const mapped = e.proposeBaselineRelease(input({ sliceMap: { 'issue-fix': 'py-bugfix' } }));
  assert.deepEqual(mapped.proposal.permittedSlices.map((s) => s.sliceId), ['py-bugfix']);
  assert.ok(mapped.proposal.baselineSources.every((s) => s.priorSliceId === 'issue-fix' && s.sliceId === 'py-bugfix'));
});

test('C16 baseline: no seed, seed rows without their hashes or from different runs, and malformed rows are refused', () => {
  assert.deepEqual(e.proposeBaselineRelease(input({ seed: [] })), { ok: false, reasonCode: 'NO_SEED' });
  assert.deepEqual(e.proposeBaselineRelease(input({ seed: [seedRow('claude-opus-5-5', 'medium', 7, 12, { runsHash: null })] })), { ok: false, reasonCode: 'SEED_HASHES_MISSING' });
  assert.deepEqual(e.proposeBaselineRelease(input({ seed: [seedRow('claude-opus-5-5', 'medium', 7, 12), seedRow('claude-sonnet-5', 'high', 8, 12, { runsHash: `sha256:${'c'.repeat(64)}` })] })), { ok: false, reasonCode: 'SEED_HASH_MISMATCH' });
  assert.deepEqual(e.proposeBaselineRelease(input({ seed: [seedRow('claude-opus-5-5', 'turbo', 7, 12)] })), { ok: false, reasonCode: 'INVALID_ROW' });
});

test('C16 baseline: only a reviewer with the calibration key releases it; the loader accepts a 24-run slice and route learning reads its priors', () => {
  const r = e.proposeBaselineRelease(input());
  assert.deepEqual(e.releaseProposal(r.proposal, { reviewerId: 'owner', reviewedAt: '2026-10-01T00:00:00Z', approved: false }, RELEASE_KEY), { ok: false, reasonCode: 'NOT_APPROVED' });
  const released = e.releaseProposal(r.proposal, { reviewerId: 'owner', reviewedAt: '2026-10-01T00:00:00Z', approved: true }, RELEASE_KEY);
  assert.equal(released.ok, true, JSON.stringify(released));
  const context = core.workerCalibrationContext({ sliceId: 'issue-fix', nowMs: NOW });
  // 24 real outcomes is under the 30-sample threshold-release minimum; a prior is weighed, not refused.
  const decision = core.checkCalibration(released.artifact, { trustedKeys: TRUSTED, context });
  assert.equal(decision.eligible, true, JSON.stringify(decision));
  assert.equal(decision.qualityFloor, 1);
  assert.equal(core.checkCalibration(released.artifact, { trustedKeys: new Map(), context }).eligible, false);
  const priors = core.baselinePriorsFromRelease(released.artifact, 'issue-fix');
  assert.deepEqual(priors.map((p) => [p.modelId, p.effort ?? null, p.rate, p.pseudoCount, p.meanCostMicroUsd]), [
    ['claude-opus-5-5', null, 0.5833, 12, 7_850_000],
    ['claude-sonnet-5', null, 0.6667, 12, 4_100_000],
  ]);
  // Outside the gate the router eliminates every candidate under the floor of 1.
  assert.ok(core.releasedQualities(released.artifact, 'issue-fix').every((q) => q.lower < decision.qualityFloor));
});

test('C16 baseline contract: a beta-posterior release names its sources, each quality is backed by them, and seed sources carry their hashes', () => {
  const r = e.proposeBaselineRelease(input());
  const artifact = e.releaseProposal(r.proposal, { reviewerId: 'owner', reviewedAt: '2026-10-01T00:00:00Z', approved: true }, RELEASE_KEY).artifact;
  const code = (value) => {
    const checked = contracts.CalibrationArtifactContract.validate(value);
    return checked.ok ? 'ok' : checked.issues.map((i) => i.code).join(',');
  };
  assert.equal(code(artifact), 'ok');
  const { baselineSources, ...bare } = artifact;
  assert.equal(code(bare), 'BASELINE_SOURCES_REQUIRED');
  assert.equal(code({ ...artifact, uncertaintyInterval: { ...artifact.uncertaintyInterval, method: 'wilson' } }), 'BASELINE_SOURCES_METHOD');
  assert.equal(code({ ...artifact, modelQualities: artifact.modelQualities.map((q, i) => (i === 0 ? { ...q, sampleSize: 30 } : q)) }), 'QUALITY_NOT_BACKED');
  const { effort, ...noEffort } = artifact.modelQualities[0];
  assert.equal(code({ ...artifact, modelQualities: [noEffort, artifact.modelQualities[1]] }), 'QUALITY_EFFORT_REQUIRED');
  const { runsHash, ...noHash } = baselineSources[0];
  assert.equal(code({ ...artifact, baselineSources: [noHash, baselineSources[1]] }), 'SEED_HASHES_REQUIRED');
  assert.equal(code({ ...artifact, baselineSources: [{ ...baselineSources[0], successes: 13 }, baselineSources[1]] }), 'SUCCESSES_ABOVE_TRIALS');
  assert.equal(code({ ...artifact, baselineSources: [{ ...baselineSources[0], sliceId: 'elsewhere' }, baselineSources[1]] }), 'SLICE_NOT_PERMITTED,QUALITY_NOT_BACKED');
  // A threshold release keeps the §18.3 minimum slice size.
  const threshold = { ...bare, uncertaintyInterval: { ...artifact.uncertaintyInterval, method: 'wilson' } };
  const context = { ...core.workerCalibrationContext({ sliceId: 'issue-fix', nowMs: NOW }), minimumSliceSamples: 30 };
  assert.deepEqual(contracts.calibrationApplies(threshold, context), { ok: false, reasonCode: 'SLICE_TOO_SMALL' });
  assert.deepEqual(contracts.calibrationApplies(artifact, context), { ok: true });
});

test('C16 baseline end to end: seed records to priors and economics, then build and sign; a tampered run record is refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-baseline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
  const node = (script, argv) => spawnSync(process.execPath, [join(scripts, script), ...argv], { env: { ...process.env, JEVRIS_TEST: '1' }, encoding: 'utf8' });
  const ids = Array.from({ length: 12 }, (_, i) => `org__repo${i}-${i}`);
  const body = { planId: e.SEED_PLAN.id, dataset: e.SEED_PLAN.dataset, revision: e.SEED_PLAN.revision, instanceIds: ids };
  writeFileSync(join(dir, 'selection.json'), JSON.stringify({ ...body, selectionHash: contracts.contentHash(body) }));
  const runs = ids.flatMap((id, i) => e.SEED_PLAN.arms.map((arm) => ({
    runId: `${id}__${arm.modelId}`, instanceId: id, modelId: arm.modelId, effort: arm.effort, status: 'completed', reason: 'success', actualModel: arm.modelId,
    apiEquivalentUsd: arm.modelId === 'claude-sonnet-5' ? 4 + (i % 3) : 7 + (i % 2), costUsd: null, costBasis: 'list-price-estimate',
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 8000, cacheCreationInputTokens: 900 }, tokens: 10_000, durationMs: 600_000 + i,
    authMode: 'subscription', patchBytes: 1, patch: 'p', at: '2026-09-30T00:00:00.000Z',
  })));
  writeFileSync(join(dir, 'runs.jsonl'), `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(join(dir, 'opus.json'), JSON.stringify({ resolved_ids: ids.slice(0, 7) }));
  writeFileSync(join(dir, 'sonnet.json'), JSON.stringify({ resolved_ids: ids.slice(0, 8) }));
  const reports = ['--report', `claude-opus-5-5=${join(dir, 'opus.json')}`, '--report', `claude-sonnet-5=${join(dir, 'sonnet.json')}`];
  assert.equal(node('seed-run.mjs', ['priors', '--out', dir, ...reports]).status, 0);
  const econ = node('seed-run.mjs', ['economics', '--out', dir, ...reports]);
  assert.equal(econ.status, 0, econ.stderr);
  const economics = JSON.parse(readFileSync(join(dir, 'seed-economics.json'), 'utf8'));
  assert.deepEqual([economics.runs, economics.pairs.length, economics.baseline.verified, economics.candidate.verified], [24, 12, 7, 8]);
  const built = node('baseline-release.mjs', ['build', '--seed-dir', dir, '--out', dir, '--id', 'baseline-test', '--expires', '2099-01-01']);
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /EFFORT_NOT_DEFAULT/);
  const proposal = JSON.parse(readFileSync(join(dir, 'baseline-proposal.json'), 'utf8'));
  const seedSources = proposal.baselineSources.filter((s) => s.kind === 'seed');
  assert.equal(seedSources.reduce((n, s) => n + s.trials, 0), 24);
  assert.ok(seedSources.every((s) => s.selectionHash === economics.selectionHash && s.runsHash === economics.runsHash), 'the economics and the baseline name the same seed');
  writeFileSync(join(dir, 'key.pem'), RELEASE_KEY.privateKeyPem, { mode: 0o600 });
  const signed = node('baseline-release.mjs', ['sign', '--proposal', join(dir, 'baseline-proposal.json'), '--key', join(dir, 'key.pem'), '--key-id', RELEASE_KEY.keyId, '--reviewer', 'owner', '--out', dir]);
  assert.equal(signed.status, 0, signed.stderr);
  const artifact = JSON.parse(readFileSync(join(dir, 'calibration-release.json'), 'utf8'));
  const decision = core.checkCalibration(artifact, { trustedKeys: TRUSTED, context: core.workerCalibrationContext({ sliceId: 'issue-fix', nowMs: Date.now() }) });
  assert.equal(decision.eligible, true, JSON.stringify(decision));
  assert.equal(artifact.signature.value.length, 88);
  // A run record changed after the priors were computed no longer matches their hash.
  writeFileSync(join(dir, 'runs.jsonl'), `${runs.slice(1).map((r) => JSON.stringify(r)).join('\n')}\n`);
  const tampered = node('baseline-release.mjs', ['build', '--seed-dir', dir, '--out', dir, '--id', 'baseline-test', '--expires', '2099-01-01']);
  assert.equal(tampered.status, 3);
  assert.match(tampered.stderr, /runsHash/);
});
