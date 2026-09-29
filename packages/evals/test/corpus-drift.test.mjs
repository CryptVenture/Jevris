import test from 'node:test';
import assert from 'node:assert/strict';

const e = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');

const SLICES = ['bounded-edit', 'test-repair', 'docs', 'refactor'];
const START = '2026-01-01T00:00:00Z';
// Repository i starts i weeks after START; repositories 14..19 start on or after the cutoff.
const CUTOFF = new Date(Date.parse(START) + 14 * 7 * 86_400_000).toISOString();

test('EVL-02: rows validate; outcome names are refused as features and never reach the router input', () => {
  const [row] = e.syntheticCorpus({ tasks: 1, slices: SLICES });
  assert.equal(e.validateCorpusRow(row).ok, true);
  const leak = { ...row, features: { ...row.features, verified: true } };
  assert.deepEqual(e.validateCorpusRow(leak), { ok: false, reason: 'OUTCOME_AS_FEATURE:verified' });
  assert.deepEqual(e.validateCorpusRow({ ...row, features: { costMicroUsd: 5 } }), { ok: false, reason: 'OUTCOME_AS_FEATURE:costMicroUsd' });
  assert.deepEqual(e.validateCorpusRow({ ...row, secret: 'x' }), { ok: false, reason: 'UNKNOWN_FIELD:secret' });
  assert.deepEqual(e.validateCorpusRow({ ...row, createdAt: 'yesterday' }), { ok: false, reason: 'INVALID:createdAt' });
  const features = e.featuresOf(row);
  for (const name of [...e.OUTCOME_FIELDS, 'outcome', 'labelSource']) assert.equal(name in features, false, name);
  assert.equal(features.sliceId, row.sliceId);
  // A row that slipped an outcome name into features past validation still does not leak it.
  assert.equal('verified' in e.featuresOf(leak), false);
});

test('EVL-02: the split is by repository and time, with no leakage across splits', () => {
  const rows = e.syntheticCorpus({ tasks: 400, slices: SLICES, start: START, repositories: 20 });
  const split = e.splitCorpus(rows, { holdoutFrom: CUTOFF });
  assert.equal(split.excluded.length, 0);
  assert.equal(split.holdout.length, 120, 'six repositories of twenty rows');
  assert.equal(split.development.length + split.calibration.length, 280);
  assert.ok(split.calibration.length > 0 && split.development.length > 0);
  const report = e.checkLeakage(split);
  assert.deepEqual(report, { ok: true, repositoryOverlap: [], timeOverlap: false, crossSplitDuplicates: [] });
  for (const row of split.holdout) assert.ok(Date.parse(row.createdAt) >= Date.parse(CUTOFF));
});

test('EVL-02: a straddling repository keeps only its early rows; overlaps and near-duplicates block the split', () => {
  const rows = e.syntheticCorpus({ tasks: 400, slices: SLICES, start: START, repositories: 20 });
  const early = rows.find((row) => row.repository === 'synthetic/repo-000');
  const late = { ...early, taskId: 'late-row', createdAt: '2026-12-01T00:00:00Z' };
  const split = e.splitCorpus([...rows, late], { holdoutFrom: CUTOFF });
  assert.deepEqual(split.excluded, [{ taskId: 'late-row', reason: 'REPOSITORY_STRADDLES_CUTOFF' }]);
  // Hand-built splits that break the rules are caught.
  const holdoutRow = split.holdout[0];
  const moved = { ...split, holdout: [...split.holdout, { ...split.development[0], taskId: 'moved' }] };
  const overlap = e.checkLeakage(moved);
  assert.equal(overlap.ok, false);
  assert.deepEqual(overlap.repositoryOverlap, [split.development[0].repository]);
  assert.equal(overlap.timeOverlap, true);
  const copy = { ...holdoutRow, taskId: 'dup', summary: `${split.development[1].summary}` };
  const dup = e.checkLeakage({ ...split, holdout: [...split.holdout, copy] });
  assert.equal(dup.ok, false);
  assert.deepEqual(dup.crossSplitDuplicates, [[split.development[1].taskId, 'dup']]);
  assert.ok(e.jaccard(new Set(['a b c']), new Set(['a b c'])) === 1);
});

test('EVL-02/EVL-13: size floors and the hash-committed holdout manifest', () => {
  const rows = e.syntheticCorpus({ tasks: 400, slices: SLICES, start: START });
  assert.deepEqual(e.corpusSizeReasons(e.summarizeCorpus(rows)), []);
  const small = e.summarizeCorpus(rows.slice(0, 100));
  assert.deepEqual(e.corpusSizeReasons(small), ['CORPUS_TOO_SMALL', ...SLICES.map((s) => `SLICE_TOO_SMALL:${s}`)]);
  assert.equal(e.summarizeCorpus(rows).consented, true);
  const holdout = e.splitCorpus(rows, { holdoutFrom: CUTOFF }).holdout;
  const manifest = e.holdoutManifest(holdout, { holdoutId: 'synthetic-holdout-1', releasedAt: '2026-09-25T00:00:00Z' });
  assert.equal(contracts.HoldoutManifestContract.validate(manifest).ok, true, JSON.stringify(contracts.HoldoutManifestContract.validate(manifest)));
  assert.equal(manifest.size, holdout.length);
  assert.deepEqual(manifest.goldLabelSources, ['adjudicated-review', 'test']);
  // The commitment is order-independent and changes when any row changes.
  assert.equal(e.holdoutManifest([...holdout].reverse(), { holdoutId: 'synthetic-holdout-1', releasedAt: '2026-09-25T00:00:00Z' }).contentHash, manifest.contentHash);
  const changed = [{ ...holdout[0], outcome: { ...holdout[0].outcome, verified: !holdout[0].outcome.verified } }, ...holdout.slice(1)];
  assert.notEqual(e.holdoutManifest(changed, { holdoutId: 'x', releasedAt: '2026-09-25T00:00:00Z' }).contentHash, manifest.contentHash);
  const empty = e.holdoutManifest([], { holdoutId: 'none', releasedAt: '2026-09-25T00:00:00Z' });
  assert.deepEqual([empty.state, empty.releasedAt], ['empty', null]);
  // Deterministic for a seed.
  assert.deepEqual(e.syntheticCorpus({ tasks: 5, slices: SLICES, seed: 3 }), e.syntheticCorpus({ tasks: 5, slices: SLICES, seed: 3 }));
});

const H = (c) => `sha256:${c.repeat(64)}`;
const BASELINE = {
  decisionSpecId: 'worker-readiness', calibrationId: 'cal-1', modelId: 'jev-1.13.0', questionHash: H('a'), encoderHash: H('b'), policyHash: H('c'),
  sliceMix: { 'bounded-edit': 0.5, docs: 0.5 }, threshold: 0.8,
};
const OBS = { modelId: 'jev-1.13.0', questionHash: H('a'), encoderHash: H('b'), policyHash: H('c'), sliceCounts: { 'bounded-edit': 25, docs: 25 }, observedAt: '2026-09-25T00:00:00Z' };

test('EVL-04: drift disables automation and records a hypothesis; it never changes the threshold', () => {
  const steady = e.detectDrift(BASELINE, OBS);
  assert.deepEqual([steady.drifted, steady.automationDisabled, steady.hypothesis], [false, false, null]);
  const cases = [
    [{ modelId: 'jev-1.14.0' }, 'model-drift'],
    [{ questionHash: H('d') }, 'question-hash-drift'],
    [{ encoderHash: H('d') }, 'encoder-hash-drift'],
    [{ policyHash: H('d') }, 'policy-hash-drift'],
    [{ sliceCounts: { 'bounded-edit': 45, docs: 5 } }, 'task-mix-drift'],
  ];
  for (const [change, kind] of cases) {
    const result = e.detectDrift(BASELINE, { ...OBS, ...change });
    assert.deepEqual(result.kinds, [kind]);
    assert.equal(result.automationDisabled, true);
    assert.equal(result.threshold, 0.8, 'threshold unchanged');
    assert.equal(result.hypothesis.thresholdChanged, false);
    assert.equal(result.hypothesis.action, 'disable-automation');
    assert.equal(result.hypothesis.proposal, 'recalibrate-through-release-pipeline');
    assert.deepEqual(result.hypothesis.kinds, [kind]);
  }
  // A shifted mix in a window below the minimum is not yet evidence of drift.
  assert.equal(e.detectDrift(BASELINE, { ...OBS, sliceCounts: { 'bounded-edit': 9, docs: 1 } }).drifted, false);
  assert.equal(e.totalVariation({ a: 1 }, { b: 1 }), 1);
  assert.equal(e.totalVariation({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 }), 0);
});
