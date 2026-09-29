// Registry servings and harness hosts (serving-hosts design 3.3, R36; owner decisions 8c1f85d and
// c8e933d): both are optional, so every snapshot without them stays valid at schemaVersion 1.0. A
// serving names only a pinned gateway or inference host, never a maker or an unpinned host; its
// tariff is the host's own, with integer micro-USD forms; a harness host row uses only the segment
// pinned for that harness. C's registry checks add the cross-entry rules (R37).
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');

const clone = (value) => JSON.parse(JSON.stringify(value));
const codes = (registry) => {
  const result = c.ModelRegistryContract.validate(registry);
  return result.ok ? [] : result.issues.map((issue) => issue.code ?? issue.message);
};

const tariff = {
  version: 'openrouter-2026-09-28',
  currency: 'USD',
  effectiveAt: '2026-09-27T00:00:00Z',
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: null,
  sourceId: 'MODELSDEV-64c46645',
  inputMicroUsdPerMillion: 3_000_000,
  outputMicroUsdPerMillion: 15_000_000,
  cacheReadMicroUsdPerMillion: 300_000,
  cacheWriteMicroUsdPerMillion: null,
};
const serving = (patch = {}) => ({ host: 'openrouter', provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff, tariffBasis: 'host', sourceIds: ['MODELSDEV-64c46645'], ...patch });
const hostRow = (patch = {}) => ({ harness: 'opencode', host: 'openrouter', segment: 'openrouter', signIns: ['api-key'], sourceIds: ['OC-PROVIDERS'], ...patch });
const withHosts = (servings, harnessHosts = []) => ({ ...clone(BUNDLED_MODEL_REGISTRY), servings, harnessHosts });

test('a snapshot without servings stays valid, and valid servings and host rows pass', () => {
  assert.deepEqual(codes(clone(BUNDLED_MODEL_REGISTRY)), []);
  const registry = withHosts(
    [
      serving(),
      serving({ host: 'kilo', hostModelId: 'moonshotai/Kimi-K3', harnesses: ['kilocode'] }),
      serving({ host: 'nvidia', tariff: null, tariffBasis: 'free-tier' }),
      serving({ host: 'openrouter', hostModelId: 'z-ai/glm-5.3', provider: 'zai', modelId: 'glm-5.3', tariff: null, tariffBasis: 'unknown' }),
    ],
    [hostRow(), hostRow({ harness: 'kilocode' }), hostRow({ harness: 'kilocode', host: 'kilo', segment: 'kilo', signIns: ['api-key', 'subscription'] }), hostRow({ host: 'nvidia', segment: 'nvidia' })],
  );
  assert.deepEqual(codes(registry), []);
  assert.equal(registry.schemaVersion, '1.0');
  assert.deepEqual([...c.SERVING_TARIFF_BASES], ['host', 'free-tier', 'unknown']);
});

test('a serving never names a maker, an unpinned host, or a moving, free or suffixed id', () => {
  for (const host of ['moonshot', 'anthropic', 'vercel', 'opencode', 'OpenRouter']) assert.notDeepEqual(codes(withHosts([serving({ host })])), [], host);
  for (const hostModelId of ['moonshotai/kimi-k3:free', 'moonshotai/kimi-k3:nitro', '~deepseek/deepseek-v4-flash-latest', 'openrouter/moonshotai/kimi-k3', 'moonshotai/kimi-k3[1m]', '', 'moonshotai/', '/kimi-k3', 'moonshotai/kimi k3']) {
    assert.notDeepEqual(codes(withHosts([serving({ hostModelId })])), [], hostModelId);
  }
  assert.notDeepEqual(codes(withHosts([serving({ tariffBasis: 'maker' })])), []);
  assert.notDeepEqual(codes(withHosts([serving({ sourceIds: [] })])), []);
  assert.notDeepEqual(codes(withHosts([serving({ harnesses: [] })])), []);
  assert.notDeepEqual(codes(withHosts([serving({ extra: true })])), []);
});

test('only a host basis carries a tariff, and it carries the integer forms', () => {
  assert.deepEqual(codes(withHosts([serving({ tariff: null })])), ['SERVING_TARIFF_MISSING']);
  assert.deepEqual(codes(withHosts([serving({ tariffBasis: 'free-tier' })])), ['SERVING_TARIFF_NOT_HOST']);
  assert.deepEqual(codes(withHosts([serving({ tariffBasis: 'unknown' })])), ['SERVING_TARIFF_NOT_HOST']);
  const floatOnly = { ...tariff };
  delete floatOnly.inputMicroUsdPerMillion;
  delete floatOnly.outputMicroUsdPerMillion;
  delete floatOnly.cacheReadMicroUsdPerMillion;
  delete floatOnly.cacheWriteMicroUsdPerMillion;
  assert.deepEqual(codes(withHosts([serving({ tariff: floatOnly })])), ['INTEGER_PRICES_REQUIRED']);
  assert.deepEqual(codes(withHosts([serving({ tariff: { ...tariff, outputMicroUsdPerMillion: 15_000_001 } })])), ['PRICE_FORMS_DISAGREE']);
  assert.deepEqual(codes(withHosts([serving({ tariff: { ...tariff, effectiveAt: '2026-10-01T00:00:00Z' } })])), ['TARIFF_AFTER_SNAPSHOT']);
  // B's LOW 18 (T-R4 as amended): a zero price is never a known tariff.
  const free = { ...tariff, inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: null, inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0, cacheReadMicroUsdPerMillion: null };
  assert.deepEqual(codes(withHosts([serving({ tariff: free })])), ['SERVING_FREE_PRICED']);
  assert.deepEqual(codes(withHosts([serving({ tariff: { ...free, outputPerMillion: 1, outputMicroUsdPerMillion: 1_000_000 } })])), [], 'only both zero is a free price');
});

test('a harness host row uses only the segment pinned for that harness, once', () => {
  assert.deepEqual(codes(withHosts([], [hostRow({ segment: 'moonshotai' })])), ['HOST_SEGMENT_NOT_PINNED']);
  assert.deepEqual(codes(withHosts([], [hostRow({ host: 'kilo', segment: 'kilo' })])), ['HOST_SEGMENT_NOT_PINNED'], 'the Kilo Gateway has no OpenCode segment');
  assert.deepEqual(codes(withHosts([], [hostRow({ harness: 'claude' })])), ['HOST_SEGMENT_NOT_PINNED']);
  assert.deepEqual(codes(withHosts([], [hostRow(), hostRow({ signIns: [] })])), ['DUPLICATE_HARNESS_HOST']);
  assert.notDeepEqual(codes(withHosts([], [hostRow({ host: 'moonshot', segment: 'moonshotai' })])), []);
  assert.notDeepEqual(codes(withHosts([], [hostRow({ signIns: ['oauth'] })])), []);
});
