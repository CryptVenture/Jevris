// SPEC §8.3 (amended 2026-09-27) and owner decision OD-14 (DOMAINS 38be7b5): a model with no
// calibration may take a provisional quality prior from an independent coding-agent board. It
// lets the model be explored under bounded-auto on a low-risk task; it never promotes a route.
// Deterministic: synthetic board rows, a fixed clock, no network, no billing.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const {
  BUNDLED_MODEL_REGISTRY,
  BUNDLED_PUBLIC_PRIORS,
  PUBLIC_PRIOR_WEIGHT,
  PUBLIC_PRIOR_MAX_AGE_DAYS,
  boardVersion,
  emptyLearningState,
  explorationChoice,
  nativeHarnessOf,
  publicPriorRefusal,
  publicPriorVerdict,
  qualifiedPublicPriors,
  weighPublicPrior,
} = core;

// pinned-clock: the board rows below are dated against this route time.
const NOW = Date.parse('2026-09-27T12:00:00Z');
const SLICE = 'terminal';
const BASE = 'claude-opus-5-5';
const GPT = 'gpt-test-1';

function row(extra = {}) {
  return {
    priorSliceId: SLICE, modelId: BASE, effort: 'medium', successRate: 0.6, trials: 300, benchmark: 'terminal-bench@4.0', harness: 'claude-code',
    sourceId: 'TB4-LB', url: 'https://www.tbench.ai/leaderboard', publishedOn: '2026-09-01', fetchedOn: '2026-09-26', independent: true, ...extra,
  };
}

/** The bundled registry plus one model of another vendor, reached natively by Codex. */
function registryWithGpt() {
  const sonnet = BUNDLED_MODEL_REGISTRY.entries.find((e) => e.modelId === 'claude-sonnet-5');
  return {
    ...BUNDLED_MODEL_REGISTRY,
    entries: [...BUNDLED_MODEL_REGISTRY.entries, { ...sonnet, provider: 'openai', modelId: GPT, family: 'gpt', displayName: 'GPT Test 1', defaultEffort: 'medium' }],
    harnessAccess: [...BUNDLED_MODEL_REGISTRY.harnessAccess, { harness: 'codex', provider: 'openai', access: 'native', sourceIds: ['S26'] }],
  };
}

const state = (extra = {}) => ({ ...emptyLearningState({ workspaceId: 'ws-public', now: '2026-09-27T00:00:00Z' }), ...extra });

test('§8.3: only an independent board row with trials, recent and on the latest board version, counts', () => {
  const table = [row()];
  assert.equal(publicPriorRefusal(row(), table, NOW), null);
  assert.equal(publicPriorRefusal(row({ sourceId: 'VENDOR-BLOG' }), table, NOW), 'NOT_INDEPENDENT', 'a vendor-reported result never counts');
  assert.equal(publicPriorRefusal(row({ independent: undefined }), table, NOW), 'NOT_INDEPENDENT');
  assert.equal(publicPriorRefusal(row({ trials: 0 }), table, NOW), 'NO_TRIALS');
  const old = new Date(NOW - (PUBLIC_PRIOR_MAX_AGE_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
  assert.equal(publicPriorRefusal(row({ publishedOn: old }), table, NOW), 'TOO_OLD');
  assert.equal(publicPriorRefusal(row(), [...table, row({ benchmark: 'terminal-bench@4.1', modelId: 'claude-sonnet-5' })], NOW), 'BOARD_SUPERSEDED');
  assert.deepEqual(boardVersion('deep-swe@1.1 (AA index component)'), { board: 'deep-swe', version: '1.1' });
  // The bundled rows are all independent board results with their trial counts.
  for (const p of BUNDLED_PUBLIC_PRIORS) assert.equal(publicPriorRefusal(p, BUNDLED_PUBLIC_PRIORS, NOW), null, `${p.modelId} ${p.benchmark}`);
});

test('§8.3: the weight is at most 12, halved per harness or effort mismatch, and local outcomes replace it one for one', () => {
  const w = (extra, harness = 'claude', effort = null, localOutcomes = 0) => weighPublicPrior({ prior: row(extra), effort, harness, localOutcomes, registry: BUNDLED_MODEL_REGISTRY });
  assert.equal(PUBLIC_PRIOR_WEIGHT, 12);
  assert.equal(w().weight, 12, 'Opus 5.5 at its default effort (medium) on Claude Code');
  assert.equal(w({}, 'codex').weight, 6);
  assert.equal(w({}, null).weight, 6, 'an unknown harness is a mismatch');
  assert.equal(w({}, 'claude', 'high').weight, 6);
  assert.equal(w({}, 'codex', 'high').weight, 3);
  assert.equal(w({ trials: 5 }).weight, 5);
  assert.equal(w({}, 'claude', null, 5).weight, 7);
  assert.equal(w({}, 'claude', null, 20).weight, 0);
  // The bound is the board's evidence: over its trials times the same factors, not the capped weight.
  const full = w();
  assert.equal(full.boundTrials, 300);
  assert.ok(full.lower > 0.54 && full.lower < 0.6, String(full.lower));
  assert.equal(w({}, 'codex', 'high').boundTrials, 75);
  assert.equal(w({}, 'claude', null, 20).lower, full.lower, 'local outcomes do not move the bound');
});

test('§8.3: a candidate qualifies when its lower bound reaches the baseline point less the margin; a release overrides', () => {
  const registry = registryWithGpt();
  const table = [row(), row({ modelId: GPT, successRate: 0.62, harness: 'codex' })];
  const verdict = (extra = {}) => publicPriorVerdict({ state: state(), sliceId: SLICE, modelId: GPT, effort: null, harness: 'codex', baselineModelId: BASE, baselineHarness: 'claude', nowMs: NOW, registry, table, ...extra });
  const ok = verdict();
  assert.equal(ok.qualified, true, JSON.stringify(ok));
  assert.equal(ok.floor, 0.6 - 0.075);
  assert.equal(ok.baselineSourceId, 'TB4-LB');
  assert.equal(verdict({ table: [row(), row({ modelId: GPT, successRate: 0.45, harness: 'codex' })] }).reasonCode, 'BELOW_FLOOR');
  // The same board rate on another harness and effort is weaker evidence and falls short.
  assert.equal(verdict({ table: [row(), row({ modelId: GPT, successRate: 0.56, harness: 'terminus-2', effort: 'xhigh' })] }).reasonCode, 'BELOW_FLOOR');
  assert.equal(verdict({ table: [row({ modelId: GPT, harness: 'codex' })] }).reasonCode, 'NO_BASELINE_PRIOR');
  assert.equal(verdict({ table: [row()] }).reasonCode, 'NO_PUBLIC_PRIOR');
  assert.equal(verdict({ table: [row(), row({ modelId: GPT, sourceId: 'VENDOR-BLOG', harness: 'codex' })] }).reasonCode, 'NOT_INDEPENDENT');
  const release = [{ sliceId: SLICE, modelId: GPT, rate: 0.5, pseudoCount: 30, sampleSize: 40, sourceId: 'cal-1' }];
  assert.equal(verdict({ releasePriors: release }).reasonCode, 'RELEASE_OVERRIDES');
  // A release prior for the baseline sets the floor instead of its board row.
  const floorFromRelease = verdict({ releasePriors: [{ sliceId: SLICE, modelId: BASE, rate: 0.7, pseudoCount: 30, sampleSize: 40, sourceId: 'cal-1' }] });
  assert.deepEqual([floorFromRelease.qualified, floorFromRelease.reasonCode], [false, 'BELOW_FLOOR']);
});

test('§8.3 with the bundled rows: no Claude model qualifies against Opus 5.5 on the terminal or issue-fix slice today', () => {
  for (const sliceId of ['terminal', 'issue-fix']) {
    const priors = qualifiedPublicPriors({ state: state(), sliceId, modelIds: BUNDLED_MODEL_REGISTRY.entries.map((e) => e.modelId), baselineModelId: BASE, harnessOf: (m) => nativeHarnessOf(BUNDLED_MODEL_REGISTRY, m), nowMs: NOW, registry: BUNDLED_MODEL_REGISTRY });
    assert.deepEqual(priors.map((p) => p.modelId), [BASE], `${sliceId}: only the baseline's own board prior`);
    assert.ok(priors[0].pseudoCount <= PUBLIC_PRIOR_WEIGHT && priors[0].sourceId.startsWith('public:'));
  }
});

test('OD-14: a model of another vendor is explored only with evidence; a qualified board prior is that evidence', () => {
  const registry = registryWithGpt();
  assert.equal(nativeHarnessOf(registry, GPT), 'codex');
  const s = state();
  // random: explore (0 < rate), then take the last arm in sorted order (the GPT model when present).
  const seq = () => {
    const values = [0, 0.999999];
    return () => values.shift() ?? 0;
  };
  const choose = (priors) =>
    explorationChoice({ state: s, sliceId: SLICE, mode: 'bounded-auto', risk: 'low', defaultModelId: BASE, baselineModelId: BASE, eligibleModelIds: [BASE, 'claude-sonnet-5', GPT], random: seq(), registry, nowMs: NOW, ...(priors === undefined ? {} : { priors }) });
  const without = choose();
  assert.equal(without.explored, true);
  assert.notEqual(without.modelId, GPT, 'no evidence: the other vendor is not an arm');
  const table = [row(), row({ modelId: GPT, successRate: 0.62, harness: 'codex' })];
  const priors = qualifiedPublicPriors({ state: s, sliceId: SLICE, modelIds: [BASE, 'claude-sonnet-5', GPT], baselineModelId: BASE, harnessOf: (m) => nativeHarnessOf(registry, m), nowMs: NOW, registry, table });
  assert.deepEqual(priors.map((p) => [p.modelId, p.pseudoCount, p.sourceId]), [[BASE, 12, 'public:TB4-LB'], [GPT, 12, 'public:TB4-LB']]);
  const withPrior = choose(priors);
  assert.deepEqual([withPrior.explored, withPrior.modelId, withPrior.reasonCode], [true, GPT, 'EXPLORED']);
  // Not on a task that is not low risk, and never outside bounded-auto.
  assert.equal(explorationChoice({ state: s, sliceId: SLICE, mode: 'bounded-auto', risk: 'medium', defaultModelId: BASE, eligibleModelIds: [BASE, GPT], random: seq(), registry, nowMs: NOW, priors }).reasonCode, 'RISK_NOT_LOW');
  assert.equal(explorationChoice({ state: s, sliceId: SLICE, mode: 'advise', risk: 'low', defaultModelId: BASE, eligibleModelIds: [BASE, GPT], random: seq(), registry, nowMs: NOW, priors }).reasonCode, 'NOT_AUTOMATED');
  // Local outcomes on the arm are evidence of their own, and they use up the board prior's weight.
  const local = state({ arms: { [SLICE]: { [GPT]: { successes: 8, failures: 4, staleOrCancelled: 0, usageLimited: 0, routes: 12, costSumMicroUsd: 0, costCount: 0, tokensSum: 0, tokensCount: 0, latencySumMs: 0, latencyCount: 0, updatedAt: '2026-09-27T00:00:00Z' } } } });
  assert.equal(explorationChoice({ state: local, sliceId: SLICE, mode: 'bounded-auto', risk: 'low', defaultModelId: BASE, baselineModelId: BASE, eligibleModelIds: [BASE, 'claude-sonnet-5', GPT], random: seq(), registry, nowMs: NOW }).modelId, GPT);
  const spent = qualifiedPublicPriors({ state: local, sliceId: SLICE, modelIds: [GPT], baselineModelId: BASE, harnessOf: (m) => nativeHarnessOf(registry, m), nowMs: NOW, registry, table });
  assert.deepEqual(spent.map((p) => p.modelId), [BASE], 'twelve local outcomes leave the board prior no weight');
});
