// Serving hosts R48 (design 6.3; OQ-4), advice side: main-session advice priced by estimate says
// so. The cost basis `maker-price-estimate` names the maker's list price and the unknown host
// tariff; the contract accepts it.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const { AdviceOnce, BUNDLED_MODEL_REGISTRY: R, renderRouteAdvice, routeTask } = core;

const kimi = R.entries.find((e) => e.modelId === 'kimi-k3');
// OpenRouter serves Kimi K3 at a lower tariff here; nothing else, so Opus through it is an estimate.
const hostTariff = { ...kimi.tariff, version: 'openrouter-2026-09-28', inputPerMillion: 2, inputMicroUsdPerMillion: 2_000_000, sourceId: 'MODELSDEV-TEST' };
const REG = { ...R, servings: [{ host: 'openrouter', provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff: hostTariff, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'] }] };

const POLICY = {
  managedAllowlist: null,
  allowedRegions: ['global', 'unspecified', 'cn', 'sg'],
  requiredContextTokens: 50_000,
  requiredCapabilities: [],
  pins: { modelPin: null, effortPin: null },
  riskFloorFamilies: null,
  accountId: null,
  locallyEligible: ['kimi-k3', 'claude-opus-5-5'],
  consentedProviders: ['moonshot', 'anthropic'],
  // pinned-clock: inside the bundled snapshot's lifecycle windows.
  nowMs: Date.parse('2026-09-28T00:00:00Z'),
};
const q = (modelId) => ({ modelId, sliceId: 'bounded-edit', lower: 0.9, point: 0.95, upper: 0.99, sourceId: 'holdout-synthetic-1' });

test('R48: advice whose route prices a side by estimate labels the cost basis maker-price-estimate, and the contract accepts it', () => {
  const selection = routeTask({
    registry: REG,
    policy: { ...POLICY, servingHost: 'openrouter' },
    sliceId: 'bounded-edit',
    volume: { inputTokens: 2_000_000, outputTokens: 200_000 },
    assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
    qualityFloor: 0.8,
    qualities: [q('kimi-k3'), q('claude-opus-5-5')],
    baselineModelId: 'claude-opus-5-5',
  });
  assert.deepEqual(selection.costEstimates, ['claude-opus-5-5']);
  assert.ok(contracts.COST_BASES.includes('maker-price-estimate'));
  const shown = renderRouteAdvice({
    registry: REG,
    scopeId: 'session-hosts',
    requestedModelId: 'claude-opus-5-5',
    observedModelId: 'claude-opus-5-5',
    selection,
    switchDecision: null,
    costBasis: 'maker-price-estimate',
    once: new AdviceOnce(),
    pins: { modelPin: null, effortPin: null },
  });
  assert.equal(shown.shown, true);
  assert.equal(contracts.RouteAdviceContract.validate(shown.advice).ok, true);
  assert.equal(shown.advice.costBasis, 'maker-price-estimate');
  assert.match(shown.advice.text, /Cost basis: the maker's list price as an estimate; the serving host's tariff is not known\./);
  assert.doesNotMatch(shown.advice.text, /unknown billing/);
});
