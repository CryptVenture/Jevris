import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvaluationCorpus } from '../dist/index.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const frontierPath = join(root, 'fixtures', 'evaluation', 'frontier-corpus.json');
const costPath = join(root, 'fixtures', 'evaluation', 'cost-registry.json');
const protocol = JSON.parse(await readFile(join(root, 'fixtures', 'evaluation', 'protocol.json'), 'utf8'));
const HASH = `sha256:${'ef'.repeat(32)}`;

async function corpusRoot(t, frontier, costs) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-corpus-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets', 'evaluation'), { recursive: true });
  await writeFile(join(dir, 'assets', 'evaluation', 'frontier-corpus.json'), JSON.stringify(frontier));
  await writeFile(join(dir, 'assets', 'evaluation', 'cost-registry.json'), JSON.stringify(costs));
  return dir;
}

/** A synthetic consented, labelled corpus: 10 slices of 30 tasks. */
function labelledCorpus({ perSlice = 30, slices = 10, labelEvery = true } = {}) {
  const taskClasses = [];
  for (let s = 0; s < slices; s += 1) {
    for (let i = 0; i < perSlice; i += 1) {
      taskClasses.push({ id: `t-${s}-${i}`, slice: `slice-${s}`, consentId: `consent-${s}`, label: labelEvery || i > 0 ? 'verified-success' : null, outcome: 'verified' });
    }
  }
  return { labelled: true, consented: true, outcomes: taskClasses.map((row) => row.outcome), models: [{ id: 'm1' }], taskClasses };
}

function gateInputs() {
  const holdoutId = 'holdout-synthetic-2026-09-25';
  return {
    protocol: { ...protocol, holdoutId, labelledCorpus: true, nonInferiorityMargin: 0.02, preRegistrationHash: HASH },
    holdout: {
      schemaVersion: '1.0', kind: 'holdout-manifest', holdoutId, state: 'released', size: 100, contentHash: HASH,
      goldLabelSources: ['test', 'spec-check'], sliceCounts: {}, releasedAt: '2026-09-25T00:00:00Z',
    },
    measurement: { metric: 'verified-success-ratio', arm: 'jev-routed', baseline: 'rules-only', point: 1.02, lower: 0.99, upper: 1.05, interval: 'bootstrap', confidence: 0.95, n: 100, holdoutId },
  };
}

const COSTS = { measuredSpeedRatio: null, measuredCostRatio: null, prices: [{ modelId: 'p1' }] };

test('the shipped inventory loads unlabelled, and the computed gate names why it is not a pass', async () => {
  const frontier = JSON.parse(await readFile(frontierPath, 'utf8'));
  const costs = JSON.parse(await readFile(costPath, 'utf8'));
  const loaded = await loadEvaluationCorpus(root, { protocol });
  const fromModule = await loadEvaluationCorpus();
  assert.equal(loaded.modelCount, fromModule.modelCount);
  assert.deepEqual(loaded.modelIds, frontier.models.map((row) => row.id));
  assert.deepEqual(loaded.costIds, costs.prices.map((row) => row.modelId));
  assert.equal(loaded.labels.length, frontier.taskClasses.length);
  assert.equal(loaded.labelled, false, 'rows carry no gold labels');
  assert.equal(loaded.corpus.tasks, frontier.taskClasses.length);
  assert.equal(loaded.qualityGate, 'not-passed');
  for (const reason of ['CORPUS_UNLABELLED', 'CORPUS_TOO_SMALL', 'HOLDOUT_MISSING', 'MEASUREMENT_MISSING']) assert.ok(loaded.gateReasons.includes(reason), reason);
  assert.equal(loaded.measuredSpeedRatio, null, 'no measured ratio is invented');
  assert.equal(loaded.measuredCostRatio, null);
});

test('a synthetic consented labelled corpus that meets the margin passes the computed gate', async (t) => {
  const dir = await corpusRoot(t, labelledCorpus(), COSTS);
  const loaded = await loadEvaluationCorpus(dir, gateInputs());
  assert.equal(loaded.labelled, true);
  assert.equal(loaded.corpus.consented, true);
  assert.equal(loaded.corpus.tasks, 300);
  assert.deepEqual(loaded.gateReasons, []);
  assert.equal(loaded.qualityGate, 'passed');
  assert.equal(loaded.outcomes.length, 300);
});

test('the same corpus is not a pass when any piece is missing or short', async (t) => {
  const cases = [
    [labelledCorpus({ labelEvery: false }), gateInputs(), 'CORPUS_UNLABELLED'],
    [{ ...labelledCorpus(), consented: false }, gateInputs(), 'CORPUS_NOT_CONSENTED'],
    [labelledCorpus({ perSlice: 29, slices: 11 }), gateInputs(), 'SLICE_TOO_SMALL'],
    [labelledCorpus({ slices: 9 }), gateInputs(), 'CORPUS_TOO_SMALL'],
    [labelledCorpus(), { ...gateInputs(), measurement: undefined }, 'MEASUREMENT_MISSING'],
    [labelledCorpus(), { ...gateInputs(), measurement: { ...gateInputs().measurement, lower: 0.9, point: 0.95 } }, 'NON_INFERIORITY_NOT_SHOWN'],
    [labelledCorpus(), { ...gateInputs(), holdout: { ...gateInputs().holdout, state: 'empty', size: 0, releasedAt: null } }, 'HOLDOUT_NOT_RELEASED'],
  ];
  for (const [frontier, gate, reason] of cases) {
    const dir = await corpusRoot(t, frontier, COSTS);
    if (gate.measurement === undefined) delete gate.measurement;
    const loaded = await loadEvaluationCorpus(dir, gate);
    assert.equal(loaded.qualityGate, 'not-passed', reason);
    assert.ok(loaded.gateReasons.includes(reason), `${reason}: ${loaded.gateReasons}`);
  }
});

test('measured ratios are read as numbers, never implied', async (t) => {
  const dir = await corpusRoot(t, labelledCorpus(), { measuredSpeedRatio: 1.4, measuredCostRatio: 'fast', prices: [{ modelId: 'p1' }] });
  const loaded = await loadEvaluationCorpus(dir);
  assert.equal(loaded.measuredSpeedRatio, 1.4);
  assert.equal(loaded.measuredCostRatio, null);
  assert.equal(loaded.qualityGate, 'not-passed', 'no protocol, holdout or measurement');
});

test('a malformed inventory is refused', async (t) => {
  for (const [frontier, costs] of [
    [{ models: [{ id: 'm1' }] }, COSTS],
    [{ models: [{ id: '' }], taskClasses: [] }, COSTS],
    [{ models: [], taskClasses: ['row'] }, COSTS],
    [labelledCorpus(), { prices: 'none' }],
  ]) {
    const dir = await corpusRoot(t, frontier, costs);
    await assert.rejects(loadEvaluationCorpus(dir), /refused/);
  }
});
