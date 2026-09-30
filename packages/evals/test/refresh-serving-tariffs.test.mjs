// Serving-host tariff snapshot (serving-hosts design 6.1 and 6.2, R38): local inputs only, integer
// micro-USD by string arithmetic, exact tiers, the Kilo Gateway cross-check, and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'refresh-serving-tariffs.mjs');
const lib = await import(pathToFileURL(scriptPath).href);
const { scaledDecimal, microUsd, exactMultiplier, tariffFromCost, kiloGatewayAgrees, baseModelOf, linkBaseModel, sameModel, buildServings, servingsModule } = lib;
const contracts = await import('@jevris/contracts');
const core = await import('@jevris/core');
const R = core.BUNDLED_MODEL_REGISTRY;

const META = { version: 'openrouter-2026-09-28', effectiveAt: '2026-09-28T00:00:00Z', sourceId: 'MODELSDEV-64c46645' };

test('R38: decimals become integer micro-USD by string arithmetic; more than 6 decimals is refused', () => {
  assert.equal(microUsd(3), 3_000_000);
  assert.equal(microUsd(0.3), 300_000);
  assert.equal(microUsd(0.003625), 3625);
  assert.equal(microUsd(1.1), 1_100_000, 'no float drift');
  assert.equal(microUsd(0.0000001), null, 'exponent form and 7 decimals are refused');
  assert.equal(microUsd(0.1234567), null);
  assert.equal(microUsd(-1), null);
  assert.equal(microUsd(Number.NaN), null);
  assert.equal(microUsd('1.5'), 1_500_000);
  assert.equal(scaledDecimal('0.000003', 12), 3_000_000n, 'a per-token string at 10^12 is micro-USD per 1M');
  assert.equal(scaledDecimal('1.2.3', 6), null);
  assert.equal(scaledDecimal('01', 6), null);
});

test('R38: a tier maps to multipliers only when exact to 4 decimals', () => {
  assert.equal(exactMultiplier(6_000_000, 3_000_000), 2);
  assert.equal(exactMultiplier(4_500_000, 3_000_000), 1.5);
  assert.equal(exactMultiplier(1_000_000, 3_000_000), null, '1/3 is not exact');
  assert.equal(exactMultiplier(1, 0), null);
});

test('R38: a models.dev cost becomes a host tariff, free-tier or unknown', () => {
  const host = tariffFromCost({ input: 3, output: 15, cache_read: 0.3 }, META);
  assert.equal(host.tariffBasis, 'host');
  assert.deepEqual(
    [host.tariff.inputMicroUsdPerMillion, host.tariff.outputMicroUsdPerMillion, host.tariff.cacheReadMicroUsdPerMillion, host.tariff.cacheWriteMicroUsdPerMillion, host.tariff.inputPerMillion],
    [3_000_000, 15_000_000, 300_000, null, 3],
  );
  const tiered = tariffFromCost({ input: 2, output: 12, cache_read: 0.2, tiers: [{ input: 4, output: 18, cache_read: 0.4, tier: { type: 'context', size: 200000 } }] }, META);
  assert.deepEqual(tiered.tariff.tiers, [{ aboveInputTokens: 200000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: 2 }]);
  const cases = [
    [{ input: 0, output: 0 }, 'free-tier', null],
    [{ input: 0, output: 1 }, 'unknown', 'PARTLY_FREE'],
    [{ input: 1 }, 'unknown', 'COST_MISSING'],
    [null, 'unknown', 'COST_MISSING'],
    [{ input: 1, output: 2, reasoning: 3 }, 'unknown', 'REASONING_PRICED'],
    [{ input: 0.1234567, output: 2 }, 'unknown', 'PRICE_PRECISION'],
    [{ input: 3, output: 15, tiers: [{ input: 1, output: 15, tier: { type: 'context', size: 1000 } }] }, 'unknown', 'TIER_INEXACT'],
    [{ input: 3, output: 15, tiers: [{ input: 6, output: 30, tier: { type: 'time', size: 1000 } }] }, 'unknown', 'TIER_NOT_CONTEXT'],
  ];
  for (const [cost, basis, reason] of cases) {
    const got = tariffFromCost(cost, META);
    assert.deepEqual([got.tariffBasis, got.tariff, got.reason], [basis, null, reason], JSON.stringify(cost));
  }
  // Every host tariff passes the contract's integer and float agreement.
  const registry = { ...R, fetchedOn: '2026-09-30T00:00:00Z', servings: [{ host: 'openrouter', provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff: host.tariff, tariffBasis: 'host', sourceIds: ['MODELSDEV-64c46645'] }] };
  assert.equal(core.validateModelRegistry(registry).ok, true, JSON.stringify(core.validateModelRegistry(registry).issues));
});

test('R38: the Kilo Gateway cross-check compares per-token strings exactly', () => {
  const tariff = tariffFromCost({ input: 3, output: 15, cache_read: 0.3 }, META).tariff;
  const list = (pricing) => ({ data: [{ id: 'moonshotai/kimi-k3', pricing }] });
  assert.deepEqual(kiloGatewayAgrees(list({ prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }), 'moonshotai/kimi-k3', tariff), { agrees: true, reason: null });
  assert.deepEqual(kiloGatewayAgrees(list({ prompt: '0.000003', completion: '0.000016' }), 'moonshotai/kimi-k3', tariff), { agrees: false, reason: 'KGW_DISAGREES' });
  assert.deepEqual(kiloGatewayAgrees(list({ prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000004' }), 'moonshotai/kimi-k3', tariff), { agrees: false, reason: 'KGW_DISAGREES' });
  assert.deepEqual(kiloGatewayAgrees(list({ prompt: '3e-6', completion: '0.000015' }), 'moonshotai/kimi-k3', tariff), { agrees: false, reason: 'KGW_DISAGREES' });
  assert.deepEqual(kiloGatewayAgrees({ data: [] }, 'moonshotai/kimi-k3', tariff), { agrees: false, reason: 'KGW_MISSING' });
});

test('R38: base_model is the only maker link, and it must name exactly one registry entry', () => {
  assert.equal(baseModelOf('name = "Kimi K3"\nbase_model = "moonshotai/kimi-k3"\n[cost]\ninput = 3\n'), 'moonshotai/kimi-k3');
  assert.equal(baseModelOf('name = "x"\n[cost]\nbase_model = "moonshotai/kimi-k3"\n'), null, 'only at the top level');
  assert.equal(baseModelOf('name = "x"\n'), null);
  const link = (base) => linkBaseModel(R, base, contracts.hostMakerOf);
  assert.deepEqual(link('moonshotai/kimi-k3'), { provider: 'moonshot', modelId: 'kimi-k3' });
  assert.deepEqual(link('zai/glm-5.3'), { provider: 'zai', modelId: 'glm-5.3' });
  assert.deepEqual(link('z-ai/glm-5.3'), { provider: 'zai', modelId: 'glm-5.3' });
  assert.deepEqual(link('zhipuai/glm-5.3'), { provider: 'zai', modelId: 'glm-5.3' }, "models.dev's own id for Z.ai");
  assert.equal(link('moonshotai/kimi-k9'), null);
  assert.equal(link('openai/kimi-k3'), null, 'another maker never links');
  assert.equal(link('kimi-k3'), null);
  // base_model is inheritance: the host id must also name the model itself.
  assert.equal(sameModel('anthropic/claude-opus-5.5', 'claude-opus-5-5'), true);
  assert.equal(sameModel('moonshotai/Kimi-K3', 'kimi-k3'), true);
  assert.equal(sameModel('openai/gpt-5.6-luna-pro', 'gpt-5.6-luna'), false);
  assert.equal(sameModel('z-ai/glm-5.3-flash', 'glm-5.3'), false);
});

test('R38: servings are built from local files; unlinked files are skipped and kilo needs the gateway list', () => {
  const tomls = {
    openrouter: [
      { hostModelId: 'moonshotai/kimi-k3', text: 'base_model = "moonshotai/kimi-k3"\n' },
      { hostModelId: 'z-ai/glm-5.3', text: 'base_model = "zai/glm-5.3"\n' },
      { hostModelId: 'moonshotai/kimi-k3:free', text: 'base_model = "moonshotai/kimi-k3"\n' },
      { hostModelId: 'openai/glm-5.3', text: 'base_model = "zai/glm-5.3"\n' },
      { hostModelId: 'mistralai/some-model', text: 'name = "no link"\n' },
      { hostModelId: 'moonshotai/kimi-k3-pro', text: 'base_model = "moonshotai/kimi-k3"\n' },
    ],
    kilo: [
      { hostModelId: 'moonshotai/kimi-k3', text: 'base_model = "moonshotai/kimi-k3"\n' },
      { hostModelId: 'z-ai/glm-5.3', text: 'base_model = "zai/glm-5.3"\n' },
    ],
    nvidia: [{ hostModelId: 'moonshotai/kimi-k3', text: 'base_model = "moonshotai/kimi-k3"\n' }],
  };
  const api = {
    openrouter: { models: { 'moonshotai/kimi-k3': { cost: { input: 3, output: 15, cache_read: 0.3 } }, 'z-ai/glm-5.3': { cost: { input: 1, output: 3.2 } } } },
    kilo: { models: { 'moonshotai/kimi-k3': { cost: { input: 3, output: 15, cache_read: 0.3 } }, 'z-ai/glm-5.3': { cost: { input: 1, output: 3.2 } } } },
    nvidia: { models: { 'moonshotai/kimi-k3': { cost: { input: 0, output: 0 } } } },
  };
  const kgw = { data: [{ id: 'moonshotai/kimi-k3', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' } }, { id: 'z-ai/glm-5.3', pricing: { prompt: '0.000001', completion: '0.0000033' } }] };
  const build = (kgwList) =>
    buildServings({ registry: R, api, readToml: (h) => tomls[h] ?? [], kgw: kgwList, date: '2026-09-28', etag: '"64c46645616953a380a1b26671dc82bb"', hostMakerOf: contracts.hostMakerOf, hostModelIdPattern: contracts.HOST_MODEL_ID_PATTERN });
  const built = build(kgw);
  const rows = built.servings.map((s) => [s.host, s.hostModelId, s.provider, s.modelId, s.tariffBasis, s.sourceIds.join(',')]);
  assert.deepEqual(rows, [
    ['kilo', 'moonshotai/kimi-k3', 'moonshot', 'kimi-k3', 'host', 'MODELSDEV-64c46645,KGW-2026-09-28'],
    ['kilo', 'z-ai/glm-5.3', 'zai', 'glm-5.3', 'unknown', 'MODELSDEV-64c46645,KGW-2026-09-28'],
    ['nvidia', 'moonshotai/kimi-k3', 'moonshot', 'kimi-k3', 'free-tier', 'MODELSDEV-64c46645'],
    ['openrouter', 'moonshotai/kimi-k3', 'moonshot', 'kimi-k3', 'host', 'MODELSDEV-64c46645'],
    ['openrouter', 'z-ai/glm-5.3', 'zai', 'glm-5.3', 'host', 'MODELSDEV-64c46645'],
  ]);
  assert.ok(built.notes.some((n) => n.includes('kimi-k3:free') && n.includes('pattern')), built.notes.join('\n'));
  assert.ok(built.notes.some((n) => n.includes('openai/glm-5.3') && n.includes('maker slug')), built.notes.join('\n'));
  assert.ok(built.notes.some((n) => n.includes('kimi-k3-pro') && n.includes('not that model')), built.notes.join('\n'));
  assert.ok(built.notes.some((n) => n.includes('kilo z-ai/glm-5.3') && n.includes('KGW_DISAGREES')));
  assert.deepEqual(Object.keys(built.sources).sort(), ['KGW-2026-09-28', 'MODELSDEV-64c46645']);
  // Without the gateway list, no kilo price is taken.
  assert.deepEqual(build(null).servings.filter((s) => s.host === 'kilo').map((s) => [s.tariffBasis, s.tariff]), [['unknown', null], ['unknown', null]]);
  // The registry with these servings is valid (the contract and the R37 checks).
  const registry = { ...R, fetchedOn: '2026-09-30T00:00:00Z', servings: built.servings, harnessHosts: [] };
  const checked = core.validateModelRegistry(registry);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  // The generated module names its inputs and carries the rows as data.
  const text = servingsModule({ ...built, date: '2026-09-28', commit: 'abc1234', etag: '"64c46645"' });
  assert.match(text, /models\.dev commit abc1234/);
  assert.match(text, /export const BUNDLED_SERVINGS/);
  assert.match(text, /"hostModelId": "moonshotai\/kimi-k3"/);
});

test('R38: the script never fetches the network', () => {
  const text = readFileSync(scriptPath, 'utf8');
  for (const pattern of [/\bfetch\s*\(/, /node:https?\b/, /node:net\b/, /node:dns\b/, /\bXMLHttpRequest\b/, /child_process/, /\bWebSocket\b/]) {
    assert.doesNotMatch(text, pattern, String(pattern));
  }
});
