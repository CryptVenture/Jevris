// Sonnet-first routing in the managed-worker route (owner decision 2026-09-30): a low-risk route
// with no learned or pinned model starts on the baseline vendor's cheaper model, reserves the first
// attempt AND the hand-off, and logs a randomized first-try or control assignment. Deterministic:
// scripted random, a stub launch port, a temporary home, no network and no billing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_MODEL_REGISTRY, DecisionBudget, EMPTY_FIRST_TRY_HISTORY, emptyLearningState, pinSlice, runManagedWorker } from '../dist/index.js';

const NOW = '2026-09-30T00:00:00Z';
const SLICE = 'bounded-edit';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const ACCOUNT = 'acct-1';
const REGISTRY = {
  ...BUNDLED_MODEL_REGISTRY,
  entries: BUNDLED_MODEL_REGISTRY.entries.map((m) => ({ ...m, health: 'healthy', accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })),
};
const NO_RELEASE = async () => ({ eligible: false, stage: 'read', reasonCode: 'NO_RELEASE' });
const seq = (...values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

async function route(t, { state = emptyLearningState({ workspaceId: 'ws-1', now: NOW }), risk = 'low', random = seq(0.99, 0.99), setting = 'auto', history = EMPTY_FIRST_TRY_HISTORY, limitMicroUsd = 50_000_000, mode = 'bounded-auto', withFirstTry = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-first-try-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const launches = [];
  const queries = [];
  const result = await runManagedWorker({
    taskId: 'task-1',
    workspaceId: 'ws-1',
    killSwitchStopped: () => false,
    loadCalibration: NO_RELEASE,
    route: {
      registry: REGISTRY,
      policy: { managedAllowlist: null, allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: ['tools'], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: ACCOUNT, nowMs: Date.parse(NOW), automated: true },
      volume: { inputTokens: 400_000, outputTokens: 40_000 },
      assumptions: { verificationMicroUsd: 0, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
      qualities: [],
    },
    budget: DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd }),
    launch: async ({ model, effort, maxBudgetUsd }) => {
      launches.push({ model, effort: effort ?? null, maxBudgetUsd });
      return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
    },
    mode,
    learning: {
      state,
      sliceId: SLICE,
      risk,
      random,
      ...(withFirstTry ? { firstTry: { setting, history: (q) => (queries.push(q), history) } } : {}),
    },
  });
  return { result, launches, queries };
}

test('a low-risk route with nothing learned starts on Sonnet 5.5, names the hand-off, and reserves both attempts', async (t) => {
  const { result, launches, queries } = await route(t);
  assert.equal(result.launched, true, JSON.stringify(result));
  assert.equal(result.selection.modelId, SONNET);
  assert.equal(result.selection.reasonCode, 'FIRST_TRY');
  assert.deepEqual(launches.map((l) => [l.model, l.effort]), [[SONNET, null]]);
  assert.deepEqual(queries, [{ baselineModelId: OPUS, firstTryModelId: SONNET }]);
  const ft = result.learning.firstTry;
  assert.deepEqual([ft.arm, ft.reasonCode, ft.firstTryModelId, ft.baselineModelId, ft.stepUpModelIds[0], ft.verdictReason], ['first-try', 'FIRST_TRY', SONNET, OPUS, OPUS, 'DAY_1_PRIOR']);
  assert.ok(Math.abs(ft.propensity - 0.9) < 1e-9);
  assert.ok(Math.abs(ft.breakEven - 0.5) < 1e-9);
  // Sonnet 1.2 USD + Opus 2.4 USD at this volume: the reservation is never less than both attempts.
  assert.ok(launches[0].maxBudgetUsd >= 3.6 - 1e-9, `reserved ${String(launches[0].maxBudgetUsd)} USD`);
});

test('the reservation must cover the hand-off: a budget that fits the first try alone refuses the launch', async (t) => {
  const tight = await route(t, { limitMicroUsd: 3_000_000 });
  assert.equal(tight.result.launched, false);
  assert.deepEqual(tight.launches, []);
  const roomy = await route(t, { limitMicroUsd: 4_000_000 });
  assert.equal(roomy.result.launched, true, JSON.stringify(roomy.result));
});

test('the control share runs the baseline first (the caller launches it) and is logged with its propensity', async (t) => {
  const { result, launches } = await route(t, { random: seq(0.99, 0.05) });
  assert.equal(result.launched, false);
  assert.deepEqual(launches, []);
  assert.equal(result.reasonCode, 'CALIBRATION_NO_RELEASE', 'the route itself launches nothing; the approved baseline runs');
  assert.deepEqual([result.learning.firstTry.arm, result.learning.firstTry.reasonCode, result.learning.baselineModelId], ['control', 'FIRST_TRY_CONTROL', OPUS]);
  assert.ok(Math.abs(result.learning.firstTry.propensity - 0.1) < 1e-9);
});

test('nothing changes when the setting is baseline, the risk is not low, the slice is pinned, or there is no first-try wiring', async (t) => {
  for (const [label, opts] of [['setting', { setting: 'baseline' }], ['medium', { risk: 'medium' }], ['high', { risk: 'high' }], ['unknown', { risk: 'unknown' }], ['no wiring', { withFirstTry: false }]]) {
    const { result, launches } = await route(t, opts);
    assert.equal(launches.length, 0, label);
    assert.equal(result.launched, false, label);
    assert.equal(result.learning.firstTry, undefined, label);
  }
  // A person's pin of the slice to advice only launches nothing; a pin to a model runs that model.
  const base = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  const pinned = await route(t, { state: pinSlice(base, SLICE, OPUS, NOW) });
  assert.deepEqual(pinned.launches.map((l) => l.model), [OPUS]);
  assert.equal(pinned.result.learning.firstTry, undefined);
});

test('observe and advise never launch a first try', async (t) => {
  for (const mode of ['observe', 'advise']) {
    const { result, launches } = await route(t, { mode });
    assert.equal(launches.length, 0, mode);
    assert.equal(result.launched, false, mode);
  }
});

test('after a demotion the baseline runs first and the first try is only explored at the 10% cap', async (t) => {
  const demoted = { ...EMPTY_FIRST_TRY_HISTORY, state: { mode: 'baseline', changedAtFinished: 5 }, firstTry: { ...EMPTY_FIRST_TRY_HISTORY.firstTry, tasks: 6, firstAttemptFail: 6 } };
  const held = await route(t, { history: demoted, random: seq(0.99, 0.5) });
  assert.equal(held.launches.length, 0);
  assert.equal(held.result.learning.firstTry.arm, 'control');
  const explored = await route(t, { history: demoted, random: seq(0.99, 0.05) });
  assert.deepEqual(explored.launches.map((l) => l.model), [SONNET]);
  assert.equal(explored.result.selection.reasonCode, 'FIRST_TRY_EXPLORED');
});
