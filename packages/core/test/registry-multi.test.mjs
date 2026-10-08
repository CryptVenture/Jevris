// The bundled snapshot multi-2026-10-08 (owner decision DOMAINS 7be3c43, SPEC §8.1 amended): the
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
  assert.equal(R.snapshotId, 'multi-2026-10-08');
  const byProvider = {};
  for (const e of R.entries) (byProvider[e.provider] ??= []).push(e.modelId);
  assert.deepEqual(byProvider, {
    anthropic: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    openai: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
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
    { harness: 'codex', baselineModelId: 'gpt-6.1-sol' },
    { harness: 'antigravity', baselineModelId: 'gemini-3.8-flash' },
  ]);
});

test('Claude Sonnet 5.5 (released 2026-09-28): the vendor pages\' price, limits, effort and lifecycle; Sonnet 5 becomes legacy', () => {
  const sonnet55 = registryModel(R, 'claude-sonnet-5-5', 'anthropic');
  assert.ok(sonnet55 !== null, 'Sonnet 5.5 is registered');
  assert.deepEqual([sonnet55.family, sonnet55.displayName], ['sonnet', 'Sonnet 5.5']);
  // Pricing page, fetched 2026-10-08: $2 input, $10 output, $0.10 cache read (0.05x the input price), $2.50 5-minute and $4 1-hour writes.
  const t = sonnet55.tariff;
  assert.deepEqual([t.inputPerMillion, t.outputPerMillion, t.cacheReadPerMillion, t.cacheWritePerMillion, t.cacheWrite1hPerMillion], [2, 10, 0.1, 2.5, 4]);
  assert.deepEqual([t.inputMicroUsdPerMillion, t.outputMicroUsdPerMillion, t.cacheReadMicroUsdPerMillion, t.cacheWriteMicroUsdPerMillion, t.cacheWrite1hMicroUsdPerMillion], [2_000_000, 10_000_000, 100_000, 2_500_000, 4_000_000]);
  assert.deepEqual([t.version, t.effectiveAt, t.sourceId, t.tiers], ['anthropic-2026-10-08', '2026-09-28T00:00:00Z', 'S28', undefined]);
  assert.equal(generationCostMicroUsd(t, { inputTokens: 1_000_000, outputTokens: 100_000 }), 3_000_000);
  // Models overview: 1M context, 128K output; effort low to max, default high on the Claude API.
  assert.deepEqual([sonnet55.contextTokens, sonnet55.maxOutputTokens], [1_000_000, 128_000]);
  assert.deepEqual([sonnet55.effortLevels, sonnet55.defaultEffort], [['low', 'medium', 'high', 'xhigh', 'max'], 'high']);
  // Per-message effort keeps the cache on the Anthropic-operated platforms (effort page).
  assert.deepEqual([core.effortSwitchKeepsCache(sonnet55, 'claude-api'), core.effortSwitchKeepsCache(sonnet55, 'bedrock')], [true, false]);
  assert.ok(sonnet55.capabilities.includes('adaptive-thinking') && sonnet55.capabilities.includes('per-message-effort'));
  assert.equal(sonnet55.capabilities.includes('thinking-always-on'), false, 'between_tools turns up-front thinking off');
  // Deprecations page: active, retirement not sooner than 2027-09-28. Not a Covered Model: ZDR eligible.
  assert.deepEqual(sonnet55.lifecycle, { status: 'active', releasedOn: '2026-09-28T00:00:00Z', retirementNotBefore: '2027-09-28T00:00:00Z', retiresOn: null, replacementModelId: null, sourceId: 'ANT-DEPREC' });
  assert.deepEqual([sonnet55.dataGovernance.zdrEligible, sonnet55.dataGovernance.requiredRetentionDays], [true, null]);
  assert.deepEqual(core.lifecycleCheck(sonnet55, NOW), { usable: true });
  // Claude Code runs it by its API id; OpenCode and Kilo through the Anthropic provider config.
  assert.deepEqual([harnessModelId(R, 'claude', 'claude-sonnet-5-5'), harnessModelId(R, 'opencode', 'claude-sonnet-5-5'), harnessModelId(R, 'codex', 'claude-sonnet-5-5')], ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5', null]);
  // Sonnet 5 stays at the same price, a legacy model that is not deprecated.
  const sonnet5 = registryModel(R, 'claude-sonnet-5', 'anthropic');
  assert.deepEqual([sonnet5.lifecycle.status, sonnet5.lifecycle.retirementNotBefore, sonnet5.tariff.inputPerMillion, sonnet5.tariff.outputPerMillion], ['legacy', '2027-06-30T00:00:00Z', 2, 10]);
  assert.deepEqual(core.lifecycleCheck(sonnet5, NOW), { usable: true });
  // The baseline and the Claude Code default stay Opus 5.5.
  assert.equal(R.baselineModelId, 'claude-opus-5-5');
});

test('Claude Haiku 5.5 (released 2026-10-07): the vendor pages\' price and its 100,000-token tier, limits, effort and lifecycle; Haiku 4.5 becomes legacy', () => {
  const haiku55 = registryModel(R, 'claude-haiku-5-5', 'anthropic');
  assert.ok(haiku55 !== null, 'Haiku 5.5 is registered');
  assert.deepEqual([haiku55.family, haiku55.displayName], ['haiku', 'Haiku 5.5']);
  // Pricing page: up to a 100,000-token prompt $0.10 / $0.50, cache read $0.01, 5-minute write $0.125, 1-hour write $0.20.
  const t = haiku55.tariff;
  assert.deepEqual([t.inputPerMillion, t.outputPerMillion, t.cacheReadPerMillion, t.cacheWritePerMillion, t.cacheWrite1hPerMillion], [0.1, 0.5, 0.01, 0.125, 0.2]);
  assert.deepEqual([t.inputMicroUsdPerMillion, t.outputMicroUsdPerMillion, t.cacheReadMicroUsdPerMillion, t.cacheWriteMicroUsdPerMillion, t.cacheWrite1hMicroUsdPerMillion], [100_000, 500_000, 10_000, 125_000, 200_000]);
  // Over 100,000 tokens every price is five times: $0.50 / $2.50, cache read $0.05, writes $0.625 and $1.
  assert.deepEqual(t.tiers, [{ aboveInputTokens: 100_000, inputMultiplier: 5, outputMultiplier: 5, cacheMultiplier: 5 }]);
  const priced = (inputTokens, outputTokens) => generationCostMicroUsd(t, { inputTokens, outputTokens });
  assert.equal(priced(100_000, 0), 10_000, 'exactly 100,000 input tokens is the base price (the tier is for a prompt over it)');
  assert.equal(priced(100_001, 0), 50_001, 'over 100,000 the whole request is five times: $0.50 per million input');
  assert.equal(priced(1_000, 1_000_000), 500_100, 'a short prompt pays $0.50 per million output');
  assert.equal(priced(100_001, 1_000_000), 50_001 + 2_500_000, 'over 100,000 output is $2.50 per million');
  assert.deepEqual([haiku55.contextTokens, haiku55.maxOutputTokens], [1_000_000, 128_000]);
  assert.deepEqual([...haiku55.effortLevels], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(haiku55.defaultEffort, 'medium');
  assert.deepEqual([core.effortSwitchKeepsCache(haiku55, 'claude-api'), core.effortSwitchKeepsCache(haiku55, 'bedrock')], [true, false]);
  assert.ok(haiku55.capabilities.includes('adaptive-thinking') && haiku55.capabilities.includes('per-message-effort'));
  // Deprecations page: active, retirement not sooner than 2027-10-07. Not a Covered Model: ZDR eligible.
  assert.deepEqual(haiku55.lifecycle, { status: 'active', releasedOn: '2026-10-07T00:00:00Z', retirementNotBefore: '2027-10-07T00:00:00Z', retiresOn: null, replacementModelId: null, sourceId: 'ANT-DEPREC' });
  assert.deepEqual([haiku55.dataGovernance.zdrEligible, haiku55.dataGovernance.requiredRetentionDays], [true, null]);
  assert.deepEqual(core.lifecycleCheck(haiku55, NOW), { usable: true });
  // Claude Code runs it by its API id and takes effort for it; OpenCode and Kilo through the Anthropic provider config.
  assert.deepEqual([harnessModelId(R, 'claude', 'claude-haiku-5-5'), harnessModelId(R, 'opencode', 'claude-haiku-5-5'), harnessModelId(R, 'codex', 'claude-haiku-5-5')], ['claude-haiku-5-5', 'anthropic/claude-haiku-5-5', null]);
  assert.notEqual(harnessEffortToken(R, 'claude', 'claude-haiku-5-5', 'low'), null, 'Haiku 5.5 takes effort');
  // Haiku 4.5 stays at its price, a legacy model that is not deprecated; no tier, no effort.
  const haiku45 = registryModel(R, 'claude-haiku-4-5-20251001', 'anthropic');
  assert.deepEqual([haiku45.lifecycle.status, haiku45.lifecycle.retirementNotBefore, haiku45.tariff.inputPerMillion, haiku45.tariff.outputPerMillion, haiku45.tariff.tiers ?? null], ['legacy', '2026-10-15T00:00:00Z', 1, 5, null]);
  // No other Anthropic model has a long-context tier.
  assert.deepEqual(R.entries.filter((e) => e.provider === 'anthropic' && (e.tariff.tiers ?? []).length > 0).map((e) => e.modelId), ['claude-haiku-5-5']);
  // The baseline and the Claude Code default stay Opus 5.5.
  assert.equal(R.baselineModelId, 'claude-opus-5-5');
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

test('GPT-6.1 Sol (OpenAI pages, 2026-09-30): priced as GPT-6 Sol with half its cached rate, and it is the Codex baseline with everything a baseline needs from the registry', () => {
  const sol = registryModel(R, 'gpt-6.1-sol');
  assert.equal(sol.lifecycle.releasedOn, '2026-09-29T00:00:00Z');
  assert.deepEqual([sol.tariff.inputPerMillion, sol.tariff.outputPerMillion, sol.tariff.cacheReadPerMillion, sol.tariff.cacheWritePerMillion], [2, 10, 0.1, 2.5]);
  assert.deepEqual(sol.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(sol.maxInputTokens, 922000);
  assert.equal(harnessModelId(R, 'codex', 'gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(R.harnessDefaults.find((row) => row.harness === 'codex').baselineModelId, 'gpt-6.1-sol');
  // As a baseline it needs a price, a context window, an effort default and a Codex id; its quality is not claimed.
  assert.deepEqual([sol.contextTokens, sol.maxOutputTokens, sol.defaultEffort, sol.lifecycle.status], [1050000, 128000, 'medium', 'active']);
  assert.deepEqual(sol.harnessModels, [{ harness: 'codex', id: 'gpt-6.1-sol', effortVia: 'config', defaultEffort: 'medium' }]);
  assert.deepEqual([sol.evaluationVersion, sol.evaluationSliceIds, sol.health], ['unevaluated', [], 'unknown'], 'no evidence of quality is invented for the new baseline');
  assert.equal(registryModel(R, 'gpt-6-sol').lifecycle.status, 'active', 'GPT-6 Sol stays a current model; only the baseline moved');
  // The GPT-5.6 family carries the same long-context tier as the pricing page lists for it.
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) assert.equal(registryModel(R, id).tariff.tiers[0].aboveInputTokens, 272000, id);
  assert.equal(registryModel(R, 'gpt-6-luna').lifecycle.releasedOn, '2026-09-22T00:00:00Z');
});
