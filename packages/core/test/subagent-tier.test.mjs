// Tiered routing, step 2b (owner decisions 2026-10-08): a subagent launch no learned route or signed prior covers is decided by
// the shared tier, on every harness, provider-neutral. Low risk goes to the session model's provider's cheapest rung, medium
// to its step-down rung, and a write-capable launch goes UP to the step-up rung only when the session's own work was judged
// step-up. Pure: the real bundled registry, no file, no clock, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_MODEL_REGISTRY as REGISTRY,
  DEFAULT_TASK_VOLUME,
  SESSION_TIER_MEMO_TTL_MS,
  adviseSubagentRoute,
  buildTierLadder,
  clearSessionTierMemos,
  harnessTierSlot,
  noteSessionTier,
  readSessionTier,
  subagentTierOf,
} from '../dist/index.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ALL = REGISTRY.entries.map((e) => e.modelId);

const ladderFor = (baselineModelId, models = REGISTRY.entries) => buildTierLadder({ eligible: models, baselineModelId, volume: DEFAULT_TASK_VOLUME });
const memo = (over = {}) => ({ tier: 'step-up', targetModelId: 'claude-opus-5-5', baselineModelId: 'claude-sonnet-5-5', basis: 'tier-rule', reasonCodes: ['TIER_PROTECTED_PATH'], atMs: NOW, ...over });
const risk = (level, subagentClass = 'read-only', source = 'rules') => ({ level, source, subagentClass });

function input(over = {}) {
  return {
    harness: 'claude',
    subagentType: 'Explore',
    explicitModel: false,
    sessionModel: 'claude-sonnet-5-5',
    pins: { modelPin: null, effortPin: null },
    registry: REGISTRY,
    nowMs: NOW,
    unavailableModels: {},
    learning: null,
    signedPrior: null,
    consentedProviders: ['anthropic', 'openai', 'google'],
    locallyEligible: ALL,
    ...over,
  };
}

test('memo: ten minutes, newest wins, the harness slot stands in for a route that named no session, nothing but ids and codes', () => {
  clearSessionTierMemos();
  assert.equal(SESSION_TIER_MEMO_TTL_MS, 600_000);
  assert.equal(noteSessionTier('w1', 's1', memo()), true);
  assert.equal(readSessionTier('w1', 's1', NOW + 599_000).tier, 'step-up');
  assert.equal(readSessionTier('w1', 's1', NOW + 601_000), null, 'expired');
  assert.equal(readSessionTier('w1', 's1', NOW + 1_000), null, 'an expired memo is dropped, not revived');
  assert.equal(readSessionTier('w2', 's1', NOW), null, 'another workspace');
  // The slot: read by the harness, the newer of the two.
  assert.equal(noteSessionTier('w1', harnessTierSlot('claude'), memo({ tier: 'baseline', targetModelId: 'claude-sonnet-5-5', atMs: NOW })), true);
  assert.equal(readSessionTier('w1', 'other-session', NOW, 'claude').tier, 'baseline');
  assert.equal(readSessionTier('w1', 'other-session', NOW), null, 'no harness named: the slot is not read');
  assert.equal(noteSessionTier('w1', 's9', memo({ atMs: NOW + 1000 })), true);
  assert.equal(readSessionTier('w1', 's9', NOW + 1000, 'claude').tier, 'step-up', 'the newer memo wins');
  // Refused: a bad id, a bad code is dropped, a bad time.
  assert.equal(noteSessionTier('w1', 'bad id', memo()), false);
  assert.equal(noteSessionTier('w1', 's2', memo({ targetModelId: 'a b' })), false);
  assert.equal(noteSessionTier('w1', 's3', memo({ atMs: Number.NaN })), false);
  noteSessionTier('w1', 's4', memo({ reasonCodes: ['TIER_OK', 'not a code', 'SECRET text here'] }));
  assert.deepEqual(readSessionTier('w1', 's4', NOW).reasonCodes, ['TIER_OK']);
  clearSessionTierMemos();
});

test('the tier input: low is the cheapest rung, medium the step-down rung only when it is another rung, up only from a fresh step-up memo on the same baseline', () => {
  const sonnet = subagentTierOf(ladderFor('claude-sonnet-5-5'), memo());
  assert.deepEqual([sonnet.lowModelId, sonnet.midModelId, sonnet.upModelId, sonnet.sessionTier], ['claude-haiku-5-5', null, 'claude-opus-5-5', 'step-up']);
  const opus = subagentTierOf(ladderFor('claude-opus-5-5'), null);
  assert.deepEqual([opus.lowModelId, opus.midModelId, opus.upModelId, opus.sessionTier], ['claude-haiku-5-5', 'claude-sonnet-5-5', null, null], 'an Opus session: Haiku below, Sonnet as the step-down rung; Fable is never a rung');
  // A memo judged against another baseline is not used.
  assert.equal(subagentTierOf(ladderFor('claude-sonnet-5-5'), memo({ baselineModelId: 'claude-opus-5-5' })).upModelId, null);
  // A baseline tier memo goes nowhere.
  assert.equal(subagentTierOf(ladderFor('claude-sonnet-5-5'), memo({ tier: 'baseline', targetModelId: 'claude-sonnet-5-5' })).upModelId, null);
  // No ladder, no input.
  assert.equal(subagentTierOf({ none: true, reasonCode: 'TIER_BASELINE_NOT_ELIGIBLE' }, memo()), null);
  // The memo's own target is used when it is a rung above the baseline, else the nearest.
  const gpt = subagentTierOf(ladderFor('gpt-6.1-sol', REGISTRY.entries.filter((e) => e.provider === 'openai')), memo({ baselineModelId: 'gpt-6.1-sol', targetModelId: 'gpt-6-astra' }));
  assert.equal(gpt.upModelId, 'gpt-6-astra');
  const near = subagentTierOf(ladderFor('gpt-6.1-sol', REGISTRY.entries.filter((e) => e.provider === 'openai')), memo({ baselineModelId: 'gpt-6.1-sol', targetModelId: 'not-a-rung' }));
  assert.equal(near.upModelId, 'gpt-5.6-sol');
});

test('Claude Code: a Sonnet session sends Explore to haiku, a very hard session sends a write-capable launch up to opus, and a read-only launch never goes up', () => {
  const tier = subagentTierOf(ladderFor('claude-sonnet-5-5'), memo());
  const down = adviseSubagentRoute(input({ tier, risk: risk('low') }));
  assert.deepEqual([down.outcome, down.modelId, down.alias, down.basis, down.reasonCode], ['propose', 'claude-haiku-5-5', 'haiku', 'risk-rule', 'SUBAGENT_ROUTE_RISK_RULE']);
  // The same read-only launch under a step-up session still goes down.
  const explore = adviseSubagentRoute(input({ tier, risk: risk('low') }));
  assert.equal(explore.modelId, 'claude-haiku-5-5');
  // A write-capable launch (general-purpose, custom) goes up whatever the risk level says.
  for (const [subagentType, subagentClass, level] of [['general-purpose', 'general-purpose', 'high'], ['my-agent', 'custom', 'high'], ['general-purpose', 'general-purpose', 'low']]) {
    const up = adviseSubagentRoute(input({ subagentType, tier, risk: risk(level, subagentClass, level === 'low' ? 'jev' : 'rules') }));
    assert.deepEqual([up.outcome, up.modelId, up.alias, up.basis, up.reasonCode, up.blockedReason], ['propose', 'claude-opus-5-5', 'opus', 'tier-rule-up', 'SUBAGENT_ROUTE_TIER_UP', null], `${subagentType} ${level}`);
    assert.equal(up.appliedContext, "Jevris set model opus on this one Agent call (the session's work was judged very hard by the tier rules (TIER_PROTECTED_PATH); a rules-based default, not a learned route and not a signed prior). The session model is unchanged.");
    assert.match(up.adviceContext, /^Jevris advises model: opus for this .+ subagent/);
    assert.match(up.text, /rules-based default, not a learned route and not a signed prior/);
  }
  // Without the step-up memo a write-capable launch changes nothing.
  const quiet = subagentTierOf(ladderFor('claude-sonnet-5-5'), null);
  assert.equal(adviseSubagentRoute(input({ subagentType: 'general-purpose', tier: quiet, risk: risk('high', 'general-purpose') })).reasonCode, 'RISK_HIGH');
  // A Sonnet session has nothing below Haiku to send a medium launch to.
  assert.equal(adviseSubagentRoute(input({ tier: quiet, risk: risk('medium') })).reasonCode, 'NOT_CHEAPER');
});

test('learned and signed evidence win over the tier, and every gate still applies to a route up', () => {
  const tier = subagentTierOf(ladderFor('claude-sonnet-5-5'), memo());
  const signed = adviseSubagentRoute(input({ subagentType: 'general-purpose', tier, risk: risk('high', 'general-purpose'), signedPrior: { modelId: 'claude-haiku-5-5', releaseId: 'rel-1' } }));
  assert.deepEqual([signed.basis, signed.modelId], ['signed-prior', 'claude-haiku-5-5']);
  const up = (over) => adviseSubagentRoute(input({ subagentType: 'general-purpose', tier, risk: risk('high', 'general-purpose'), ...over }));
  assert.equal(up({ explicitModel: true }).reasonCode, 'EXPLICIT_MODEL');
  assert.equal(up({ pins: { modelPin: 'claude-sonnet-5-5', effortPin: null } }).reasonCode, 'PINNED');
  assert.equal(up({ unavailableModels: { 'claude-opus-5-5': 'MODEL_GONE' } }).reasonCode, 'MODEL_UNAVAILABLE');
  assert.equal(up({ consentedProviders: [] }).reasonCode, 'PROVIDER_NOT_CONSENTED');
  assert.equal(up({ locallyEligible: ALL.filter((id) => id !== 'claude-opus-5-5') }).reasonCode, 'NOT_ELIGIBLE_HERE');
  assert.equal(up({ sessionModel: 'opus' }).reasonCode, 'SAME_AS_SESSION', 'a session already on the up model changes nothing');
  assert.equal(up({ accessLimits: [] }).outcome, 'propose');
  // The alias must mean the model: an older Opus is never the up rung through the alias.
  const oldTier = { ...tier, upModelId: 'claude-opus-5' };
  assert.equal(up({ tier: oldTier }).reasonCode, 'ALIAS_NOT_NEWEST', 'the opus alias means Opus 5.5, so an older Opus is never set through it');
});

test('an Opus session keeps its old behaviour: Explore to haiku, a large Explore to sonnet', () => {
  const tier = subagentTierOf(ladderFor('claude-opus-5-5'), null);
  assert.equal(adviseSubagentRoute(input({ sessionModel: 'claude-opus-5-5', tier, risk: risk('low') })).alias, 'haiku');
  assert.equal(adviseSubagentRoute(input({ sessionModel: 'claude-opus-5-5', tier, risk: risk('medium') })).alias, 'sonnet');
  assert.equal(adviseSubagentRoute(input({ sessionModel: 'claude-opus-5-5', tier, risk: risk('high', 'general-purpose'), subagentType: 'general-purpose' })).reasonCode, 'RISK_HIGH');
});

test('Codex: an OpenAI session steps down to that provider cheapest rung and up to its dearer rung, as Codex model ids, never Anthropic', () => {
  const openai = REGISTRY.entries.filter((e) => e.provider === 'openai' && (e.harnessModels ?? []).some((r) => r.harness === 'codex'));
  const tier = subagentTierOf(ladderFor('gpt-6.1-sol', openai), memo({ baselineModelId: 'gpt-6.1-sol', targetModelId: 'gpt-6-astra' }));
  assert.deepEqual([tier.lowModelId, tier.midModelId, tier.upModelId], ['gpt-6-luna', null, 'gpt-6-astra']);
  const base = { harness: 'codex', sessionModel: 'gpt-6.1-sol', consentedProviders: ['openai'], locallyEligible: openai.map((e) => e.modelId), subagentType: 'Explore' };
  const down = adviseSubagentRoute(input({ ...base, tier, risk: risk('low') }));
  assert.deepEqual([down.outcome, down.harness, down.modelId, down.harnessModel, down.alias, down.actuator.tool, down.basis], ['propose', 'codex', 'gpt-6-luna', 'gpt-6-luna', null, 'spawn_agent', 'risk-rule']);
  assert.equal(down.appliedContext, null, 'only Claude Code has the note for the model');
  const up = adviseSubagentRoute(input({ ...base, subagentType: 'general-purpose', tier, risk: risk('high', 'general-purpose') }));
  assert.deepEqual([up.outcome, up.modelId, up.harnessModel, up.basis, up.reasonCode], ['propose', 'gpt-6-astra', 'gpt-6-astra', 'tier-rule-up', 'SUBAGENT_ROUTE_TIER_UP']);
  // No local evidence of the rung on this harness: dormant.
  assert.equal(adviseSubagentRoute(input({ ...base, locallyEligible: ['gpt-6.1-sol'], tier, risk: risk('low') })).reasonCode, 'NOT_ELIGIBLE_HERE');
  // A tier-less Codex launch stays as before: no evidence, no route.
  assert.equal(adviseSubagentRoute(input({ ...base, risk: risk('low') })).reasonCode, 'NO_EVIDENCE');
});

test('Kilo and OpenCode: a non-Anthropic session routes within its own provider, spelled provider/model, host kept', () => {
  const openai = REGISTRY.entries.filter((e) => e.provider === 'openai');
  const tier = subagentTierOf(ladderFor('gpt-6.1-sol', openai), memo({ baselineModelId: 'gpt-6.1-sol', targetModelId: 'gpt-6-astra' }));
  for (const harness of ['kilocode', 'opencode']) {
    const base = { harness, sessionModel: 'openai/gpt-6.1-sol', consentedProviders: ['openai'], locallyEligible: openai.map((e) => e.modelId), hostRouteCertified: true };
    const down = adviseSubagentRoute(input({ ...base, tier, risk: risk('low') }));
    assert.deepEqual([down.outcome, down.modelId, down.harnessModel, down.actuator.tool, down.blockedReason], ['propose', 'gpt-6-luna', 'openai/gpt-6-luna', 'task', null], harness);
    const up = adviseSubagentRoute(input({ ...base, subagentType: 'general-purpose', tier, risk: risk('high', 'general-purpose') }));
    assert.deepEqual([up.outcome, up.modelId, up.harnessModel, up.basis], ['propose', 'gpt-6-astra', 'openai/gpt-6-astra', 'tier-rule-up'], harness);
    // The child keeps the parent's host: nothing without a readable parent model.
    assert.equal(adviseSubagentRoute(input({ ...base, sessionModel: null, tier, risk: risk('low') })).reasonCode, 'HOST_UNKNOWN');
  }
});

test('Antigravity: the route is advice text only (no actuator), on the provider-neutral rung', () => {
  // The bundled Google models are 1.0 times each other, so there is no rung a tier away: dormant. A cheaper Google model makes it text.
  const flash = REGISTRY.entries.find((e) => e.modelId === 'gemini-3.8-flash');
  const row = flash.harnessModels[0];
  const lite = { ...flash, modelId: 'gemini-3.8-flash-lite', displayName: 'Gemini 3.8 Flash-Lite', tariff: { ...flash.tariff, inputPerMillion: 0.1, outputPerMillion: 0.4 }, harnessModels: [{ ...row, id: 'gemini-3.8-flash-lite-medium', efforts: { low: 'gemini-3.8-flash-lite-low', medium: 'gemini-3.8-flash-lite-medium', high: 'gemini-3.8-flash-lite-high' } }] };
  const registry = { ...REGISTRY, entries: [...REGISTRY.entries, lite] };
  const none = subagentTierOf(ladderFor('gemini-3.8-flash'), null);
  assert.equal(none.lowModelId, null);
  assert.equal(adviseSubagentRoute(input({ harness: 'antigravity', sessionModel: 'gemini-3.8-flash', consentedProviders: ['google'], tier: none, risk: risk('low') })).reasonCode, 'NOT_CHEAPER');
  const tier = subagentTierOf(buildTierLadder({ eligible: registry.entries, baselineModelId: 'gemini-3.8-flash', volume: DEFAULT_TASK_VOLUME }), null);
  assert.equal(tier.lowModelId, 'gemini-3.8-flash-lite');
  const advice = adviseSubagentRoute(input({ registry, harness: 'antigravity', sessionModel: 'gemini-3.8-flash', consentedProviders: ['google'], locallyEligible: registry.entries.map((e) => e.modelId), tier, risk: risk('low') }));
  // Antigravity starts no subagent a hook can re-model: a proposal with no actuator is shown as text, never applied.
  assert.deepEqual([advice.outcome, advice.modelId, advice.actuator, advice.alias, advice.appliedContext], ['propose', 'gemini-3.8-flash-lite', null, null, null]);
  assert.match(advice.text, /Jevris suggests Gemini 3\.8 Flash-Lite .* for this Explore subagent/);
});

test('prompt and description text never reach the tier route: only the declared fields are read', () => {
  const tier = subagentTierOf(ladderFor('claude-sonnet-5-5'), memo());
  const allowed = new Set(['harness', 'subagentType', 'explicitModel', 'sessionModel', 'pins', 'registry', 'nowMs', 'unavailableModels', 'learning', 'signedPrior', 'consentedProviders', 'locallyEligible', 'accessLimits', 'authMode', 'risk', 'tier']);
  const guarded = new Proxy({ ...input({ subagentType: 'general-purpose', tier, risk: risk('high', 'general-purpose') }), prompt: 'SECRET PROMPT', description: 'SECRET', toolInput: { prompt: 'SECRET' } }, {
    get(target, key) {
      if (typeof key === 'string' && !allowed.has(key)) throw new Error(`read ${key}`);
      return Reflect.get(target, key);
    },
  });
  const advice = adviseSubagentRoute(guarded);
  assert.equal(advice.modelId, 'claude-opus-5-5');
  assert.doesNotMatch(JSON.stringify(advice), /SECRET/);
  // The tier input itself is ids and codes.
  assert.doesNotMatch(JSON.stringify(tier), /SECRET|prompt|description/);
});
