// Serving hosts R48 (design 6.3; OQ-4): the tariff through a serving host, and how well it is known.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, servingTariff, servingTariffKnown, HOST_TARIFF_UNKNOWN } = core;

const kimi = R.entries.find((e) => e.modelId === 'kimi-k3');
const hostTariff = { ...kimi.tariff, version: 'openrouter-2026-09-28', inputPerMillion: 2, inputMicroUsdPerMillion: 2_000_000, sourceId: 'MODELSDEV-TEST' };
const serving = (host, extra = {}) => ({ host, provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff: hostTariff, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'], ...extra });
const REG = { ...R, servings: [serving('openrouter'), serving('kilo', { tariff: null, tariffBasis: 'unknown' }), serving('nvidia', { tariff: null, tariffBasis: 'free-tier' })] };

test('R48: the maker host and a host tariff are known; an unknown, free-tier or missing serving is the maker price as an estimate', () => {
  assert.deepEqual(servingTariff(REG, 'moonshot', 'moonshot', 'kimi-k3'), { tariff: kimi.tariff, basis: 'host' });
  assert.deepEqual(servingTariff(REG, 'openrouter', 'moonshot', 'kimi-k3'), { tariff: hostTariff, basis: 'host' });
  for (const host of ['kilo', 'nvidia', 'togetherai']) assert.deepEqual(servingTariff(REG, host, 'moonshot', 'kimi-k3'), { tariff: kimi.tariff, basis: 'maker-price-estimate' }, host);
  assert.equal(servingTariff(REG, 'openrouter', 'moonshot', 'kimi-k9'), null);
  assert.equal(servingTariff(REG, 'openrouter', 'zai', 'kimi-k3'), null, 'the maker must match the entry');
  assert.deepEqual(['moonshot', 'openrouter', 'kilo', 'nvidia'].map((h) => servingTariffKnown(REG, h, 'moonshot', 'kimi-k3')), [true, true, false, false]);
  assert.equal(HOST_TARIFF_UNKNOWN, 'HOST_TARIFF_UNKNOWN');
});

test('R48: two host tariffs for one model on one host are not one known price', () => {
  const two = { ...REG, servings: [serving('openrouter'), serving('openrouter', { hostModelId: 'moonshotai/kimi-k3-alt' })] };
  assert.equal(servingTariff(two, 'openrouter', 'moonshot', 'kimi-k3').basis, 'maker-price-estimate');
});

// The router (design 6.3): candidates are priced through the route's serving host.
const POLICY = {
  managedAllowlist: null,
  allowedRegions: ['global', 'unspecified', 'cn', 'sg'],
  requiredContextTokens: 50_000,
  requiredCapabilities: [],
  pins: { modelPin: null, effortPin: null },
  riskFloorFamilies: null,
  accountId: null,
  locallyEligible: ['kimi-k3', 'glm-5.3', 'claude-opus-5-5'],
  consentedProviders: ['moonshot', 'zai', 'anthropic'],
  // pinned-clock: inside the bundled snapshot's lifecycle windows.
  nowMs: Date.parse('2026-09-28T00:00:00Z'),
};

test('R48: the router prices each candidate through the route host: a host tariff, else the maker price as a named estimate', () => {
  const at = (servingHost) => core.filterCandidates(REG, { ...POLICY, servingHost });
  const price = (result, id) => result.eligible.find((m) => m.modelId === id)?.tariff.inputMicroUsdPerMillion;
  // Direct (no host, or a maker id): every candidate at its maker's price, no estimate.
  for (const host of [undefined, null, 'moonshot', 'anthropic']) {
    const direct = at(host);
    assert.equal(price(direct, 'kimi-k3'), kimi.tariff.inputMicroUsdPerMillion, String(host));
    assert.equal(direct.costEstimates, undefined, String(host));
  }
  // Through OpenRouter: Kimi K3 at OpenRouter's tariff; GLM-5.3 and Opus (no serving here) are estimates.
  const gw = at('openrouter');
  assert.equal(price(gw, 'kimi-k3'), 2_000_000);
  assert.ok(gw.costEstimates.includes('glm-5.3') && gw.costEstimates.includes('claude-opus-5-5') && !gw.costEstimates.includes('kimi-k3'), JSON.stringify(gw.costEstimates));
  // An unknown tariff (Kilo here) is an estimate at the maker's price, never a guess.
  const kilo = at('kilo');
  assert.equal(price(kilo, 'kimi-k3'), kimi.tariff.inputMicroUsdPerMillion);
  assert.ok(kilo.costEstimates.includes('kimi-k3'));
});

test('R48: a route selection names the selected model or baseline priced by estimate', () => {
  const q = (modelId, lower, point, upper) => ({ modelId, sliceId: 'bounded-edit', lower, point, upper, sourceId: 'holdout-synthetic-1' });
  const input = (servingHost) => ({
    registry: REG,
    policy: { ...POLICY, servingHost },
    sliceId: 'bounded-edit',
    volume: { inputTokens: 2_000_000, outputTokens: 200_000 },
    assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
    qualityFloor: 0.8,
    qualities: [q('kimi-k3', 0.9, 0.95, 0.99), q('claude-opus-5-5', 0.9, 0.95, 0.99)],
    baselineModelId: 'claude-opus-5-5',
  });
  const direct = core.routeTask(input(null));
  assert.equal(direct.costEstimates, undefined, JSON.stringify(direct.costEstimates));
  const gw = core.routeTask(input('openrouter'));
  // Opus has no OpenRouter serving in this registry: the baseline's price is an estimate.
  assert.deepEqual([gw.outcome, gw.modelId, gw.costEstimates], ['select', 'kimi-k3', ['claude-opus-5-5']]);
  // Kimi K3 is priced at OpenRouter's tariff, so it is not an estimate; the direct route names none.
  assert.deepEqual([direct.outcome, direct.modelId], ['select', 'kimi-k3']);
});
