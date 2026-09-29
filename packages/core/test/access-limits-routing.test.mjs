// Access limits in routing (design access-limits.md R61 and R72): the legacy model-only reader for
// one release, the router's access-limit gate, the managed worker's launch check, and exploration
// by scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../dist/index.js');
const {
  BUNDLED_MODEL_REGISTRY: R, DecisionBudget, emptyLearningState, recordRouteOutcome, usageLimitStatus, explorationChoice, filterCandidates, routeTask, runManagedWorker,
  recordAccessLimit, classifyAccessSignal, routeAccessPauses, accessQueryFor, FILTER_GATES,
} = core;

// pinned-clock: every route and record here runs at this fixed time.
const NOW = '2026-09-28T12:00:00Z';
const T = Date.parse(NOW);
const H = 3_600_000;
const BASE = 'claude-opus-5-5';
const CAND = 'claude-sonnet-5';
const SLICE = 'bounded-edit';
const ACCOUNT = 'acct-1';

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-access-route-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

let seq = 0;
function hit(overrides = {}) {
  seq += 1;
  return {
    eventId: `ev-${seq}`, routeId: `route-${seq}`, sliceId: SLICE, modelId: CAND, rulesModelId: BASE, policyVersion: 0, kind: 'usage-limited', labelSource: 'harness-limit',
    receiptId: null, explored: false, propensity: null, risk: 'low', costMicroUsd: null, latencyMs: null, at: new Date(T - H).toISOString(), ...overrides,
  };
}
const record = (state, event) => {
  const r = recordRouteOutcome(state, event);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
};

test('R61: the legacy reader still honours an old unexpired hit, per sign-in, and skips a hit the access-limits record holds', () => {
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  s = record(s, hit({ authMode: 'subscription', limitResetAt: new Date(T + 2 * H).toISOString() }));
  assert.equal(usageLimitStatus(s, CAND, T).limited, true, 'an old hit still blocks its model');
  assert.equal(usageLimitStatus(s, CAND, T, 'subscription').limited, true);
  assert.equal(usageLimitStatus(s, CAND, T, 'api-key').limited, false, 'a subscription hit leaves the API key');
  assert.equal(usageLimitStatus(s, CAND, T + 3 * H).limited, false, 'after expiry nothing');
  // A hit the caller also recorded in access-limits.json is the neutral outcome only.
  let n = emptyLearningState({ workspaceId: 'ws-2', now: NOW });
  n = record(n, hit({ authMode: 'subscription', accessLimited: true }));
  assert.equal(n.events.at(-1).accessLimited, true);
  const status = usageLimitStatus(n, CAND, T);
  assert.deepEqual([status.limited, status.near], [false, false]);
  assert.equal(n.arms[SLICE][CAND].usageLimited, 1, 'still counted as a usage-limited outcome, never a failure');
  assert.equal(recordRouteOutcome(n, hit({ kind: 'verified-pass', labelSource: 'verification-receipt', receiptId: 'rc-1', accessLimited: true })).reasonCode, 'INVALID_EVENT');
  assert.equal(recordRouteOutcome(n, hit({ accessLimited: 'yes' })).reasonCode, 'INVALID_EVENT');
});

test('R72: the router\'s last gate leaves out a paused model (ACCESS_LIMITED) and replaces a paused baseline', () => {
  assert.equal(FILTER_GATES.at(-1), 'access-limit');
  const paused = { [CAND]: { class: 'usage-window', untilMs: T + 5 * H, scope: { harness: 'claude', authMode: 'subscription', servingHost: 'anthropic', modelId: null, family: null } } };
  const policy = {
    managedAllowlist: [BASE, CAND], allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: [], pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null, accountId: null, locallyEligible: [BASE, CAND], nowMs: T, consentedProviders: ['anthropic'], pausedModels: paused,
  };
  const f = filterCandidates(R, policy);
  assert.deepEqual(f.eliminated.find((e) => e.modelId === CAND), { modelId: CAND, gate: 'access-limit', reasonCode: 'ACCESS_LIMITED' });
  assert.ok(f.eligible.some((m) => m.modelId === BASE));
  assert.equal(filterCandidates(R, { ...policy, pausedModels: {} }).eliminated.some((e) => e.gate === 'access-limit'), false);
  // A prototype key never reads as a pause.
  assert.equal(filterCandidates(R, { ...policy, pausedModels: Object.create({ [BASE]: paused[CAND] }) }).eliminated.some((e) => e.gate === 'access-limit'), false);
  const qualities = [
    { modelId: BASE, sliceId: SLICE, lower: 0.9, point: 0.94, upper: 0.97, sourceId: 'holdout-synthetic-1' },
    { modelId: CAND, sliceId: SLICE, lower: 0.86, point: 0.9, upper: 0.94, sourceId: 'holdout-synthetic-1' },
  ];
  const route = (pausedModels, extra = {}) => routeTask({ registry: R, policy: { ...policy, pausedModels, ...extra }, sliceId: SLICE, volume: { inputTokens: 400_000, outputTokens: 40_000 }, assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 }, qualities, qualityFloor: 0.8, baselineModelId: BASE });
  const open = route({});
  assert.equal(open.accessLimited, undefined);
  const candPaused = route(paused);
  assert.notEqual(candPaused.modelId, CAND);
  assert.deepEqual(candPaused.accessLimited, [{ modelId: CAND, class: 'usage-window', untilMs: T + 5 * H }]);
  const basePaused = route({ [BASE]: paused[CAND] });
  assert.deepEqual([basePaused.outcome, basePaused.modelId, basePaused.reasonCode], ['select', CAND, 'BASELINE_ACCESS_LIMITED']);
  // A pin is kept, never overridden: a paused pinned model is a pin conflict, never a launch.
  const pinned = route(paused, { pins: { modelPin: CAND, effortPin: null } });
  assert.deepEqual([pinned.outcome, pinned.reasonCode], ['pinned', 'PIN_CONFLICT']);
});

function workerRegistry() {
  return { ...R, entries: R.entries.map((m) => ({ ...m, health: 'healthy', accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })) };
}

async function worker(t, { pausedModels = {}, learning, loadCalibration, qualities = [] }) {
  const home = await tempHome(t);
  const launches = [];
  const result = await runManagedWorker({
    taskId: 'task-1', workspaceId: 'ws-1', killSwitchStopped: () => false,
    loadCalibration: loadCalibration ?? (async () => ({ eligible: false, stage: 'read', reasonCode: 'NO_RELEASE' })),
    route: {
      registry: workerRegistry(),
      policy: { managedAllowlist: [BASE, CAND], allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: ['tools'], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: ACCOUNT, nowMs: T, pausedModels },
      volume: { inputTokens: 400_000, outputTokens: 40_000 },
      assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
      qualities,
      baselineModelId: BASE,
    },
    budget: DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 }),
    launch: async ({ model }) => {
      launches.push(model);
      return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
    },
    mode: 'bounded-auto',
    ...(learning === undefined ? {} : { learning }),
  });
  return { result, launches };
}

test('R72: a paused model is never launched: a kept baseline carries the pause for the caller, and a paused candidate leaves the baseline', async (t) => {
  const released = async () => ({ eligible: true, artifact: {}, keyId: 'k-test', qualityFloor: 0.8, sliceId: SLICE });
  const qualities = [
    { modelId: BASE, sliceId: SLICE, lower: 0.9, point: 0.94, upper: 0.97, sourceId: 'h' },
    { modelId: CAND, sliceId: SLICE, lower: 0.86, point: 0.9, upper: 0.94, sourceId: 'h' },
  ];
  const scope = { harness: 'claude', authMode: 'api-key', servingHost: 'anthropic', modelId: null, family: null };
  const pauseBase = { [BASE]: { class: 'credit-exhausted', untilMs: null, scope }, [CAND]: { class: 'credit-exhausted', untilMs: null, scope } };
  const plain = await worker(t, { pausedModels: pauseBase, loadCalibration: released, qualities });
  assert.deepEqual([plain.result.launched, plain.launches], [false, []]);
  assert.deepEqual(plain.result.selection.accessLimited.map((p) => p.modelId).sort(), [BASE, CAND].sort(), 'the caller sees why');
  const state = emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } });
  const learned = await worker(t, { pausedModels: pauseBase, loadCalibration: released, qualities, learning: { state, sliceId: SLICE, risk: 'high', random: () => 0.99, authMode: 'api-key' } });
  assert.deepEqual([learned.result.launched, learned.launches], [false, []]);
  assert.deepEqual(learned.result.learning.usageLimit, { modelId: BASE, resetAt: null, class: 'credit-exhausted' });
  // Only the candidate paused: the router never selects it.
  const cand = await worker(t, { pausedModels: { [CAND]: pauseBase[CAND] }, loadCalibration: released, qualities });
  assert.notEqual(cand.result.selection.modelId, CAND);
  assert.ok(!cand.launches.includes(CAND));
});

test('R72: exploration never picks a paused model or one whose scope was hit within nearLimitHours', () => {
  const state = { ...emptyLearningState({ workspaceId: 'ws-1', now: NOW }), settings: { ...emptyLearningState({ workspaceId: 'ws-1', now: NOW }).settings, effortArms: [] } };
  const base = { state, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: [BASE, CAND], random: () => 0, mode: 'bounded-auto', risk: 'low', nowMs: T };
  assert.equal(explorationChoice(base).modelId, CAND);
  assert.equal(explorationChoice({ ...base, pausedModelIds: [CAND] }).reasonCode, 'NO_ELIGIBLE_ALTERNATIVE');
  assert.equal(explorationChoice({ ...base, nearLimitModelIds: [CAND] }).reasonCode, 'NO_ELIGIBLE_ALTERNATIVE');
});

test('R72: routeAccessPauses reads the record once and scopes each candidate by the harness that would run it', async (t) => {
  const home = await tempHome(t);
  const window = classifyAccessSignal({ port: 'claude', channel: 'structured', certified: false, errorType: 'rate_limit_event', rateLimitType: 'seven_day_opus' }, 'subscription', T);
  assert.equal((await recordAccessLimit({ home, scope: accessQueryFor(R, 'claude', BASE, 'subscription'), classification: window, source: 'owned-run', nowMs: T })).ok, true);
  const credit = classifyAccessSignal({ port: 'opencode', channel: 'structured', certified: false, errorType: 'APIError', status: 402 }, 'api-key', T);
  assert.equal((await recordAccessLimit({ home, scope: accessQueryFor(R, 'opencode', 'kimi-k3', 'api-key'), classification: credit, source: 'session', nowMs: T - 30 * H })).ok, true);
  const scopes = { [BASE]: { harness: 'claude', authMode: 'subscription' }, 'claude-opus-5': { harness: 'claude', authMode: 'api-key' }, [CAND]: { harness: 'claude', authMode: 'subscription' }, 'kimi-k3': { harness: 'opencode', authMode: 'api-key' }, 'gpt-6-sol': null };
  const out = await routeAccessPauses({ home, registry: R, nowMs: T + H, scopeOf: (m) => (Object.hasOwn(scopes, m) ? scopes[m] : { harness: 'claude', authMode: 'subscription' }) });
  assert.deepEqual(Object.keys(out.paused).sort(), [BASE, 'kimi-k3'], 'the Opus weekly limit pauses Opus on the subscription, not the API key or Sonnet');
  assert.equal(out.paused['kimi-k3'].class, 'credit-exhausted');
  assert.deepEqual(out.nearLimitModelIds, [BASE], 'near only within 24 h, on the same scope');
  // Advice that names no harness: any harness's pause on the maker counts.
  const advice = await routeAccessPauses({ home, registry: R, nowMs: T + H, scopeOf: () => ({ harness: null, authMode: null }) });
  assert.ok(Object.hasOwn(advice.paused, BASE) && Object.hasOwn(advice.paused, 'claude-opus-5') && Object.hasOwn(advice.paused, 'kimi-k3'));
  // No record: nothing.
  const empty = await routeAccessPauses({ home: await tempHome(t), registry: R, nowMs: T, scopeOf: () => ({ harness: 'claude', authMode: 'api-key' }) });
  assert.deepEqual(empty, { paused: {}, nearLimitModelIds: [] });
});
