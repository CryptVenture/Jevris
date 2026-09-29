// Serving hosts R39 (design 3.4; owner decisions 8c1f85d and c8e933d): one resolver from a harness
// spelling to (model, serving host) and back. A maker endpoint resolves to the maker; a pinned host's
// segment resolves only through an exact serving; everything else stays unregistered.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, harnessModelRef, registryModel, registryModelOf, resolveSpelling, spellOnHost, spellingsOnHost, validateModelRegistry } = core;

const TARIFF = { ...R.entries.find((e) => e.modelId === 'kimi-k3').tariff, version: 'openrouter-2026-09-27', sourceId: 'MODELSDEV-TEST' };
const row = (harness, host) => ({ harness, host, segment: host, signIns: ['api-key'], sourceIds: ['MODELSDEV-TEST'] });
const serving = (host, provider, modelId, hostModelId, extra = {}) => ({ host, provider, modelId, hostModelId, tariff: TARIFF, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'], ...extra });

/** The bundled registry plus OpenRouter on both harnesses, the Kilo Gateway on Kilo and NVIDIA. */
const REG = {
  ...R,
  harnessHosts: [row('opencode', 'openrouter'), row('kilocode', 'openrouter'), row('kilocode', 'kilo'), row('opencode', 'nvidia')],
  servings: [
    serving('openrouter', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
    serving('kilo', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
    serving('kilo', 'zai', 'glm-5.3', 'z-ai/glm-5.3'),
    serving('nvidia', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3', { tariff: null, tariffBasis: 'free-tier' }),
    // Only on OpenCode: a serving can name where its spelling applies.
    serving('openrouter', 'zai', 'glm-5.3', 'z-ai/glm-5.3', { harnesses: ['opencode'] }),
  ],
};

test('R39: the test registry is valid', () => {
  const checked = validateModelRegistry(REG);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
});

test('R39: the spelling table: maker endpoints, pinned hosts, case, [1m], suffixes, aliases and extra segments', () => {
  const at = (harness, raw) => {
    const r = resolveSpelling(REG, harness, raw);
    return r === null ? null : [r.provider, r.modelId, r.servingHost, r.via];
  };
  // Direct, through each of the maker's endpoints: the host is the maker.
  assert.deepEqual(at('opencode', 'moonshotai/kimi-k3'), ['moonshot', 'kimi-k3', 'moonshot', 'maker']);
  assert.deepEqual(at('opencode', 'moonshotai-cn/kimi-k3'), ['moonshot', 'kimi-k3', 'moonshot', 'maker']);
  assert.deepEqual(at('claude', 'claude-opus-5-5[1m]'), ['anthropic', 'claude-opus-5-5', 'anthropic', 'maker']);
  assert.deepEqual(at('codex', 'gpt-6-sol'), ['openai', 'gpt-6-sol', 'openai', 'maker']);
  // The three gateway or host forms.
  assert.deepEqual(at('opencode', 'openrouter/moonshotai/kimi-k3'), ['moonshot', 'kimi-k3', 'openrouter', 'host']);
  assert.deepEqual(at('kilocode', 'kilo/moonshotai/kimi-k3'), ['moonshot', 'kimi-k3', 'kilo', 'host']);
  assert.deepEqual(at('kilocode', 'kilo/z-ai/glm-5.3'), ['zai', 'glm-5.3', 'kilo', 'host']);
  assert.deepEqual(at('opencode', 'nvidia/moonshotai/kimi-k3'), ['moonshot', 'kimi-k3', 'nvidia', 'host'], 'resolved as evidence; consent decides it is never routed');
  // A host segment needs this harness's harnessHosts row, and the serving must apply here.
  assert.equal(at('opencode', 'kilo/moonshotai/kimi-k3'), null, 'the Kilo Gateway is not an OpenCode host');
  assert.equal(at('kilocode', 'nvidia/moonshotai/kimi-k3'), null, 'no NVIDIA row on Kilo here');
  assert.equal(at('claude', 'openrouter/moonshotai/kimi-k3'), null);
  assert.equal(at('kilocode', 'openrouter/z-ai/glm-5.3'), null, 'that serving applies on OpenCode only');
  assert.deepEqual(at('opencode', 'openrouter/z-ai/glm-5.3'), ['zai', 'glm-5.3', 'openrouter', 'host']);
  // Exact case, no suffixes, no moving aliases, no third segment, no unpinned host.
  assert.equal(at('opencode', 'openrouter/moonshotai/Kimi-K3'), null);
  assert.equal(at('opencode', 'openrouter/moonshotai/kimi-k3:free'), null);
  assert.equal(at('opencode', 'openrouter/moonshotai/kimi-k3[1m]'), null, 'a host never spells [1m] (B)');
  assert.equal(at('kilocode', 'kilo/~moonshotai/kimi-k3'), null);
  assert.equal(at('opencode', 'openrouter/a/moonshotai/kimi-k3'), null);
  assert.equal(at('opencode', 'togetherai/moonshotai/kimi-k3'), null);
  assert.equal(at('opencode', 'openrouter/kimi-k3'), null, 'a serving names the host model id exactly');
  // The maker slug of a host id is never read as a maker endpoint.
  assert.equal(at('opencode', 'moonshotai/moonshotai/kimi-k3'), null);
  // Entries stay unique: the registry model lookup is unchanged by servings.
  assert.equal(registryModel(REG, 'kimi-k3').provider, 'moonshot');
});

test('R39: the existing resolvers are maker-only wrappers, so every current caller keeps its meaning', () => {
  for (const [harness, raw] of [['opencode', 'openrouter/moonshotai/kimi-k3'], ['kilocode', 'kilo/moonshotai/kimi-k3'], ['opencode', 'nvidia/moonshotai/kimi-k3']]) {
    assert.equal(registryModelOf(REG, harness, raw), null, raw);
    assert.equal(harnessModelRef(REG, raw, harness).registered, false, raw);
    assert.equal(harnessModelRef(REG, raw).registered, false, raw);
  }
  // A maker spelling resolves the same through both.
  assert.deepEqual(registryModelOf(REG, 'opencode', 'moonshotai-cn/kimi-k3'), { provider: 'moonshot', modelId: 'kimi-k3' });
});

test('R39: spellingsOnHost and spellOnHost are the reverse: every spelling resolves back to the same model and host', () => {
  assert.deepEqual(spellingsOnHost(REG, 'opencode', 'moonshot', 'moonshot', 'kimi-k3'), ['moonshotai-cn/kimi-k3', 'moonshotai/kimi-k3']);
  assert.equal(spellOnHost(REG, 'opencode', 'moonshot', 'moonshot', 'kimi-k3'), null, 'two maker endpoints: no single spelling');
  assert.equal(spellOnHost(REG, 'opencode', 'anthropic', 'anthropic', 'claude-sonnet-5'), 'anthropic/claude-sonnet-5');
  assert.equal(spellOnHost(REG, 'opencode', 'openrouter', 'moonshot', 'kimi-k3'), 'openrouter/moonshotai/kimi-k3');
  assert.equal(spellOnHost(REG, 'kilocode', 'kilo', 'zai', 'glm-5.3'), 'kilo/z-ai/glm-5.3');
  assert.equal(spellOnHost(REG, 'kilocode', 'openrouter', 'zai', 'glm-5.3'), null, 'not served there on Kilo');
  assert.equal(spellOnHost(REG, 'claude', 'anthropic', 'anthropic', 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(spellOnHost(REG, 'codex', 'openai', 'openai', 'gpt-6-sol'), 'gpt-6-sol');
  assert.equal(spellOnHost(REG, 'codex', 'anthropic', 'anthropic', 'claude-opus-5-5'), null);
  for (const harness of ['opencode', 'kilocode']) {
    for (const host of ['moonshot', 'openrouter', 'kilo', 'nvidia']) {
      for (const spelling of spellingsOnHost(REG, harness, host, 'moonshot', 'kimi-k3')) {
        const back = resolveSpelling(REG, harness, spelling);
        assert.deepEqual([back.provider, back.modelId, back.servingHost], ['moonshot', 'kimi-k3', host], `${harness} ${spelling}`);
      }
    }
  }
});
