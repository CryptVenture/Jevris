// The bundled snapshot multi-2026-09-28 (owner decision DOMAINS 7be3c43, SPEC §8.1 amended): the
// admitted providers' entries, the harness map with each harness's own spelling, the consent and
// preview gates, and the per-harness baselines (OD-3). Deterministic: data only, a fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, BUNDLED_REGISTRY_SOURCES, filterCandidates, generationCostMicroUsd, harnessEffortToken, harnessModelId, harnessModelRef, registryModel, registryModelOf, tariffAt, validateModelRegistry } = core;

// pinned-clock: the routing time the gates and scheduled prices are read at.
const NOW = Date.parse('2026-09-28T00:00:00Z');

test('7be3c43: the snapshot holds the admitted providers, each entry sourced, unevaluated and priced in both forms', () => {
  assert.equal(validateModelRegistry(R).ok, true);
  assert.equal(R.snapshotId, 'multi-2026-09-28');
  const byProvider = {};
  for (const e of R.entries) (byProvider[e.provider] ??= []).push(e.modelId);
  assert.deepEqual(byProvider, {
    anthropic: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    openai: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    google: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'],
    xai: ['grok-4.7', 'grok-4.6'],
    zai: ['glm-5.3'],
    moonshot: ['kimi-k3'],
    deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  });
  for (const e of R.entries) {
    assert.equal(e.evaluationVersion, 'unevaluated', e.modelId);
    assert.deepEqual(e.evaluationSliceIds, [], e.modelId);
    assert.deepEqual(e.accountEligibility, [], e.modelId);
    const ids = [...e.sourceIds, e.tariff.sourceId, e.lifecycle?.sourceId, e.dataGovernance?.sourceId, ...(e.dataGovernance?.bySignIn ?? []).map((row) => row.sourceId)].filter(Boolean);
    for (const id of ids) assert.ok(BUNDLED_REGISTRY_SOURCES[id] !== undefined, `${e.modelId}: ${id}`);
    assert.equal(e.tariff.inputMicroUsdPerMillion, Math.round(e.tariff.inputPerMillion * 1_000_000), e.modelId);
    assert.equal(e.tariff.outputMicroUsdPerMillion, Math.round(e.tariff.outputPerMillion * 1_000_000), e.modelId);
  }
  // Kimi and DeepSeek train on content by default: consent first. Gemini 3.1 Pro is a preview.
  assert.deepEqual(R.entries.filter((e) => e.requiresProviderConsent === true).map((e) => e.modelId), ['kimi-k3', 'deepseek-v4-pro', 'deepseek-flash']);
  assert.deepEqual(R.entries.filter((e) => e.lifecycle?.status === 'preview').map((e) => e.modelId), ['gemini-3.1-pro-preview']);
  assert.deepEqual(R.harnessDefaults, [
    { harness: 'claude', baselineModelId: 'claude-opus-5-5' },
    { harness: 'codex', baselineModelId: 'gpt-6-sol' },
    { harness: 'antigravity', baselineModelId: 'gemini-3.8-flash' },
  ]);
});

test('R7: long-context tiers, an inclusive xAI threshold, the scheduled Gemini price and a promotion end', () => {
  const cost = (id, inputTokens) => generationCostMicroUsd(registryModel(R, id).tariff, { inputTokens, outputTokens: 0 });
  // OpenAI above 272K: 2x input for the whole request.
  assert.equal(cost('gpt-6-sol', 272_000), 544_000);
  assert.equal(cost('gpt-6-sol', 272_001), Math.round(272_001 * 4));
  // xAI from 200K ("reaches"): 2x at exactly the threshold.
  assert.equal(cost('grok-4.7', 199_999), 399_998);
  assert.equal(cost('grok-4.7', 200_000), 800_000);
  // Gemini Flash doubles on 2027-01-01.
  const flash = registryModel(R, 'gemini-3.8-flash').tariff;
  assert.equal(tariffAt(flash, Date.parse('2026-12-31T23:59:59Z')).inputPerMillion, 0.75);
  assert.equal(tariffAt(flash, Date.parse('2027-01-01T00:00:00Z')).inputPerMillion, 1.5);
  assert.equal(registryModel(R, 'gpt-5.6-sol').tariff.validUntil, '2026-11-22T00:00:00Z');
});

test('OD-4 and §8.1: a consent-gated model passes only with consent; a preview model never in an automated route', () => {
  const policy = (extra = {}) => ({
    managedAllowlist: null, allowedRegions: ['global', 'cn', 'sg', 'us', 'unspecified', 'eu'], requiredContextTokens: 1, requiredCapabilities: [], pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null, accountId: null, locallyEligible: R.entries.map((e) => e.modelId), nowMs: NOW, ...extra,
  });
  const gateOf = (extra, id) => filterCandidates(R, policy(extra)).eliminated.find((e) => e.modelId === id)?.gate ?? 'eligible';
  assert.equal(gateOf({}, 'kimi-k3'), 'provider-consent');
  assert.equal(gateOf({ consentedProviders: ['deepseek'] }, 'kimi-k3'), 'provider-consent');
  assert.equal(gateOf({ consentedProviders: ['moonshot'] }, 'kimi-k3'), 'eligible');
  assert.equal(gateOf({}, 'gpt-6-sol'), 'eligible', 'a provider without the mark needs no consent here');
  assert.equal(gateOf({}, 'gemini-3.1-pro-preview'), 'eligible', 'advice may name a preview model');
  assert.equal(gateOf({ automated: true }, 'gemini-3.1-pro-preview'), 'preview');
  assert.equal(gateOf({ automated: true }, 'gemini-3.8-flash'), 'eligible');
});

test('R2, R6, R13: each harness spells a model its own way, and the spelling maps back', () => {
  const id = (h, m) => harnessModelId(R, h, m);
  const back = (h, raw) => registryModelOf(R, h, raw);
  assert.deepEqual([id('claude', 'claude-opus-5-5'), id('opencode', 'claude-opus-5-5'), id('kilocode', 'claude-opus-5-5'), id('codex', 'claude-opus-5-5')], ['claude-opus-5-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5', null]);
  assert.deepEqual([id('codex', 'gpt-6-sol'), id('opencode', 'gpt-6-sol'), id('antigravity', 'gpt-6-sol')], ['gpt-6-sol', 'openai/gpt-6-sol', null]);
  // Kilo resolves ids against the models.dev catalog it ships, so its provider ids are OpenCode's.
  assert.deepEqual([id('opencode', 'kimi-k3'), id('kilocode', 'kimi-k3')], ['moonshotai/kimi-k3', 'moonshotai/kimi-k3']);
  assert.deepEqual([id('antigravity', 'gemini-3.8-flash'), id('kilocode', 'glm-5.3'), id('kilocode', 'gemini-3.8-flash'), id('kilocode', 'deepseek-flash')], ['gemini-3.8-flash-medium', 'zai/glm-5.3', 'google/gemini-3.8-flash', 'deepseek/deepseek-flash']);
  assert.deepEqual(back('kilocode', 'zai-coding-plan/glm-5.3'), { provider: 'zai', modelId: 'glm-5.3' });
  assert.equal(back('kilocode', 'kilo/z-ai/glm-5.3'), null, 'a Kilo Gateway id is not a direct provider run and is not mapped yet');
  assert.deepEqual(back('opencode', 'moonshotai-cn/kimi-k3'), { provider: 'moonshot', modelId: 'kimi-k3' });
  assert.deepEqual(back('opencode', 'google-vertex/gemini-3.8-flash'), { provider: 'google', modelId: 'gemini-3.8-flash' });
  assert.deepEqual(back('antigravity', 'gemini-3.8-flash-high'), { provider: 'google', modelId: 'gemini-3.8-flash' });
  assert.deepEqual(back('claude', 'claude-opus-5-5[1m]'), { provider: 'anthropic', modelId: 'claude-opus-5-5' });
  assert.equal(back('codex', 'openai/gpt-6-sol'), null, 'Codex spells the bare id');
  assert.equal(back('opencode', 'gpt-6-sol'), null, 'OpenCode spells provider/model');
  assert.equal(back('opencode', 'openrouter/gpt-6-sol'), null, 'a gateway segment is not a provider of the row');
  // G20's parser maps a harness provider segment to the registry provider.
  assert.deepEqual([harnessModelRef(R, 'moonshotai/kimi-k3').modelId, harnessModelRef(R, 'moonshotai/kimi-k3').registered], ['kimi-k3', true]);
  // Effort tokens: Antigravity names it in the slug; a level the model lacks is never sent.
  assert.equal(harnessEffortToken(R, 'antigravity', 'gemini-3.8-flash', 'low'), 'gemini-3.8-flash-low');
  assert.equal(harnessEffortToken(R, 'antigravity', 'gemini-3.8-flash', 'max'), null);
  assert.equal(harnessEffortToken(R, 'codex', 'gpt-6-sol', 'xhigh'), 'xhigh');
  assert.equal(harnessEffortToken(R, 'claude', 'claude-haiku-4-5-20251001', 'low'), null, 'Haiku 4.5 takes no effort');
  assert.equal(harnessEffortToken(R, 'antigravity', 'gpt-6-sol', 'low'), null);
});
