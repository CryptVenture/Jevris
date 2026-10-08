// Tiered routing on owned workers (owner decision 2026-10-08): a step-up tier runs the step-up rung as its own non-randomized
// route (not a learned arm; the generation budget is reserved as for any launch); a step-down stays the existing randomized
// first try; learned and pinned evidence for the slice still wins; any rung that cannot launch leaves the approved baseline.
// Checked on every harness's own models: Claude Code (Anthropic), Codex (OpenAI), Antigravity (Google), Kilo and OpenCode
// (whatever provider the session runs). Deterministic: scripted random, stub launch port, temporary homes, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLED_MODEL_REGISTRY,
  DEFAULT_TASK_VOLUME,
  DecisionBudget,
  EMPTY_FIRST_TRY_HISTORY,
  emptyLearningState,
  filterCandidates,
  judgeModelTier,
  pinSlice,
  recordModelListing,
  routeManagedWorker,
  runManagedWorker,
  tierSignalsOf,
} from '../dist/index.js';

const NOW = '2026-10-08T12:00:00Z';
const NOW_MS = Date.parse(NOW);
const SLICE = 'issue-fix';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const ACCOUNT = 'acct-1';
const REGISTRY = {
  ...BUNDLED_MODEL_REGISTRY,
  entries: BUNDLED_MODEL_REGISTRY.entries.map((m) => ({ ...m, health: 'healthy', accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })),
};
const PROVIDERS = [...new Set(REGISTRY.entries.map((e) => e.provider))];
const NO_RELEASE = async () => ({ eligible: false, stage: 'read', reasonCode: 'NO_RELEASE' });
const HARD = { hints: { paths: ['src/auth/login.ts'], checkIds: ['test'] } };

const POLICY = { managedAllowlist: null, allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: ['tools'], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: ACCOUNT, nowMs: NOW_MS, automated: true, consentedProviders: PROVIDERS };

/** The rules' tier for a baseline over the policy's own eligible set, as the route builds it. */
async function tierFor(baselineModelId, input) {
  const eligible = filterCandidates(REGISTRY, POLICY).eligible;
  return judgeModelTier(null, { signals: tierSignalsOf(input), eligible, baselineModelId, volume: DEFAULT_TASK_VOLUME }, { workspaceId: 'ws-1', evidenceRevision: 'rev-1' }, { assist: 'off', record: false });
}

async function worker(t, { tier, baselineModelId = SONNET, state = emptyLearningState({ workspaceId: 'ws-1', now: NOW }), risk = 'medium', mode = 'bounded-auto', limitMicroUsd = 50_000_000, paused = undefined, withLearning = true, firstTry = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-tier-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const launches = [];
  const result = await runManagedWorker({
    taskId: 'task-1',
    workspaceId: 'ws-1',
    killSwitchStopped: () => false,
    loadCalibration: NO_RELEASE,
    ...(tier === undefined ? {} : { tier }),
    route: {
      registry: REGISTRY,
      policy: { ...POLICY, ...(paused === undefined ? {} : { pausedModels: paused }) },
      baselineModelId,
      volume: DEFAULT_TASK_VOLUME,
      assumptions: { verificationMicroUsd: 0, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
      qualities: [],
    },
    budget: DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd }),
    launch: async ({ model, effort, maxBudgetUsd }) => {
      launches.push({ model, effort: effort ?? null, maxBudgetUsd });
      return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
    },
    mode,
    ...(withLearning ? { learning: { state, sliceId: SLICE, risk, random: () => 0.99, ...(firstTry ? { firstTry: { setting: 'auto', history: () => EMPTY_FIRST_TRY_HISTORY } } : {}) } } : {}),
  });
  return { result, launches };
}

test('a step-up tier runs Opus 5.5 as its own route: unrandomized, labelled TIER_STEP_UP, with the generation reserved', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  assert.deepEqual([tier.tier, tier.targetModelId], ['step-up', OPUS]);
  const { result, launches } = await worker(t, { tier });
  assert.equal(result.launched, true, JSON.stringify(result));
  assert.deepEqual(launches.map((l) => [l.model, l.effort]), [[OPUS, null]]);
  assert.deepEqual([result.selection.modelId, result.selection.reasonCode, result.selection.baselineModelId], [OPUS, 'TIER_STEP_UP', SONNET]);
  // Not a learned arm: no exploration, no propensity, no first-try assignment; the note carries the baseline it was weighed against.
  assert.equal(result.learning.exploration, null);
  assert.equal(result.learning.firstTry, undefined);
  assert.equal(result.learning.baselineModelId, SONNET);
  // The reservation is the generation of the step-up model with a retry, and it was settled from the reported usage.
  assert.ok(launches[0].maxBudgetUsd >= 4.8 - 1e-9, `reserved ${String(launches[0].maxBudgetUsd)} USD`);
  assert.ok(result.reservedMicroUsd >= 4_800_000);
  assert.equal(result.settledMicroUsd !== null, true);
});

test('the budget still applies: a step up that does not fit the generation envelope launches nothing', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  const tight = await worker(t, { tier, limitMicroUsd: 1_000_000 });
  assert.equal(tight.result.launched, false);
  assert.deepEqual(tight.launches, []);
  const roomy = await worker(t, { tier, limitMicroUsd: 6_000_000 });
  assert.equal(roomy.result.launched, true, JSON.stringify(roomy.result));
});

test('a step-up that cannot run (an access limit pauses its scope) launches nothing, so the approved baseline runs', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  const { result, launches } = await worker(t, { tier, paused: { [OPUS]: { class: 'rate-limit', untilMs: NOW_MS + 3_600_000, source: 'test' } } });
  // The paused scope is not an eligible rung, so nothing launches here and the caller runs the approved baseline.
  assert.deepEqual(launches, []);
  assert.equal(result.launched, false);
});

test('learned, pinned and signed evidence for the slice wins over the tier; a step-down, a baseline and a no-op tier change nothing', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  // A person pinned the slice to Haiku 5.5: it runs, the tier does not override a pin.
  const base = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  const pinned = await worker(t, { tier, state: pinSlice(base, SLICE, HAIKU, NOW) });
  assert.deepEqual(pinned.launches.map((l) => l.model), [HAIKU]);
  // A pin to advice only launches nothing.
  const down = await worker(t, { tier: await tierFor(SONNET, { hints: { paths: ['docs/guide.md'], checkIds: [] } }), risk: 'low' });
  assert.deepEqual(down.launches, [], 'a step-down tier is only ever the randomized first try, never a launch of its own');
  const baseline = await worker(t, { tier: await tierFor(SONNET, { hints: { title: 'adjust the pagination', paths: ['src/a.ts', 'src/b.ts'], checkIds: ['test'] }, risk: 'medium' }) });
  assert.deepEqual(baseline.launches, []);
  // A tier that names the baseline itself has nothing to launch.
  const same = await worker(t, { tier: { ...tier, targetModelId: SONNET } });
  assert.deepEqual(same.launches, []);
});

test('observe and advise record the counterfactual and never launch a step-up', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  for (const mode of ['observe', 'advise']) {
    const { result, launches } = await worker(t, { tier, mode });
    assert.equal(result.launched, false, mode);
    assert.deepEqual(launches, [], mode);
  }
});

test('with a first-try wiring, a step-up skips the randomized first try and exploration: very hard work is not a sample of a cheaper model', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  const { result, launches } = await worker(t, { tier, risk: 'low', firstTry: true });
  assert.deepEqual(launches.map((l) => l.model), [OPUS]);
  assert.equal(result.learning.firstTry, undefined);
});

test('with no learning state and no release the step-up is still the rules\' default for very hard work', async (t) => {
  const tier = await tierFor(SONNET, HARD);
  const { result, launches } = await worker(t, { tier, withLearning: false });
  assert.deepEqual(launches.map((l) => l.model), [OPUS], JSON.stringify(result));
});

// ------------------------------------------------------------------------------------ per harness, through the route

/**
 * Each harness on its own models, through `routeManagedWorker` with a real (temporary) home: local evidence (the harness lists
 * its models) decides eligibility, the baseline is the task's approved model, and the tier is judged over what the route accepts.
 */
const HARNESSES = [
  // [harness, approved model, listed models, expected step-up target (null: none), provider]
  ['claude', SONNET, [HAIKU, SONNET, OPUS, 'claude-fable-5-1'], OPUS, 'anthropic'],
  ['codex', 'gpt-6.1-sol', ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-astra'], 'gpt-5.6-sol', 'openai'],
  ['antigravity', 'gemini-3.8-flash', ['gemini-3.8-flash', 'gemini-3.7-flash'], null, 'google'],
  ['kilocode', 'gpt-6-sol', ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-astra', SONNET, OPUS], 'gpt-5.6-sol', 'openai'],
  ['opencode', 'gpt-6.1-sol', ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-sol', SONNET, 'gemini-3.8-flash'], 'gpt-5.6-sol', 'openai'],
  ['opencode', OPUS, [HAIKU, SONNET, OPUS, 'gpt-6-astra'], null, 'anthropic'],
];

for (const [harness, approved, listed, up, provider] of HARNESSES) {
  test(`the route on ${harness} (${approved}): tier over this provider's models only${up === null ? ', with no rung to step to' : ''}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'jevris-tier-route-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    assert.equal(await recordModelListing(home, { harness, authMode: 'api-key', result: { ok: true, version: null, models: listed }, nowMs: NOW_MS }), true);
    const launches = [];
    const result = await routeManagedWorker(
      {
        taskId: 'task-1',
        workspaceId: 'ws-tier',
        sliceId: SLICE,
        mode: 'bounded-auto',
        risk: 'medium',
        harness,
        authMode: 'api-key',
        approvedModelId: approved,
        killSwitchStopped: () => false,
        tier: { signals: tierSignalsOf(HARD), jevAssist: 'classify' },
        launch: async ({ model }) => {
          launches.push(model);
          return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
        },
      },
      { home, trustedKeys: new Map(), bundledCalibration: null, nowMs: () => NOW_MS, random: () => 0.99 },
    );
    const note = result.tier;
    assert.ok(note !== undefined, JSON.stringify(result));
    assert.equal(note.baselineModelId, approved);
    assert.ok(note.candidates.every((id) => REGISTRY.entries.find((e) => e.modelId === id).provider === provider), `${harness}: ${JSON.stringify(note.candidates)}`);
    assert.ok(!note.candidates.includes('claude-fable-5-1'), 'never Fable');
    assert.equal(note.label, 'Rules-based default - not a learned route, not a signed prior');
    assert.equal(note.basis, 'tier-rule');
    if (up === null) {
      assert.deepEqual([note.tier, note.targetModelId], ['baseline', approved]);
      assert.ok(note.reasonCodes.includes('TIER_NO_STEP_UP_RUNG'), JSON.stringify(note.reasonCodes));
      assert.deepEqual(launches, [], 'nothing to step to: the approved baseline runs');
    } else {
      assert.deepEqual([note.tier, note.targetModelId], ['step-up', up]);
      assert.deepEqual(launches, [up], `${harness}: the step-up rung runs, as its own route`);
      assert.equal(result.launched, true, JSON.stringify(result));
      assert.deepEqual([result.selection.reasonCode, result.selection.baselineModelId], ['TIER_STEP_UP', approved]);
      assert.equal(result.learning.exploration, null);
    }
  });
}

test('a task that approves one model only is never widened: no rung above it, so the approved model runs', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-tier-one-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await recordModelListing(home, { harness: 'claude', authMode: 'api-key', result: { ok: true, version: null, models: [HAIKU, SONNET, OPUS] }, nowMs: NOW_MS });
  const launches = [];
  const result = await routeManagedWorker(
    {
      taskId: 'task-1', workspaceId: 'ws-tier', sliceId: SLICE, mode: 'bounded-auto', risk: 'medium', harness: 'claude', authMode: 'api-key', approvedModelId: SONNET, eligibleModels: [SONNET],
      killSwitchStopped: () => false, tier: { signals: tierSignalsOf(HARD) },
      launch: async ({ model }) => (launches.push(model), { status: 'completed', requestedModel: model, actualModel: model, usage: null, costUsd: null }),
    },
    { home, trustedKeys: new Map(), bundledCalibration: null, nowMs: () => NOW_MS, random: () => 0.99 },
  );
  assert.deepEqual(launches, []);
  assert.deepEqual([result.tier.tier, result.tier.candidates], ['baseline', [SONNET]]);
});

test('a note with no task signals asks nothing and keeps the baseline, and an observe route carries the tier without spending Jev', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-tier-observe-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await recordModelListing(home, { harness: 'claude', authMode: 'api-key', result: { ok: true, version: null, models: [HAIKU, SONNET, OPUS] }, nowMs: NOW_MS });
  const result = await routeManagedWorker(
    { taskId: 'task-1', workspaceId: 'ws-tier', sliceId: SLICE, mode: 'observe', risk: 'medium', harness: 'claude', authMode: 'api-key', approvedModelId: SONNET, killSwitchStopped: () => false, tier: { signals: tierSignalsOf({ hints: {} }) }, launch: async () => { throw new Error('never launched'); } },
    { home, trustedKeys: new Map(), bundledCalibration: null, nowMs: () => NOW_MS, random: () => 0.99 },
  );
  assert.deepEqual([result.launched, result.tier.tier, result.tier.targetModelId], [false, 'baseline', SONNET]);
  assert.ok(result.tier.reasonCodes.includes('TIER_NO_SIGNALS'));
});
