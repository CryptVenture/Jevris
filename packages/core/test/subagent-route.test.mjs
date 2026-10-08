// Claude Code subagent routing, the decision side (owner decision 2026-09-27, DOMAINS 9ce2ba5):
// propose only with evidence for the subagent type, abstain with a reason otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { adviseSubagentRoute, subagentSliceId, SUBAGENT_ROUTE_ABSTAIN_REASONS, CLAUDE_CODE_SUBAGENT_ALIASES, BUNDLED_MODEL_REGISTRY, emptyLearningState } = core;

// pinned-clock: before any bundled retirement date, so the propose path does not age.
const NOW = Date.parse('2026-09-27T12:00:00Z');
const SLICE = 'subagent:Explore';
// Claude Code's baseline is Sonnet 5.5 (2026-10-08), so its subagent slices learn under the qualified key; the bare key still means an Opus 5.5 baseline.
const KEY = `${SLICE}::claude-sonnet-5-5`;

/** A learning state whose active version routes `slices` (hand-built: the policy is what the route reads). */
function learning(slices) {
  const base = emptyLearningState({ workspaceId: 'ws-sub', now: '2026-09-27T00:00:00Z' });
  return { ...base, versions: [...base.versions, { version: 1, parentVersion: 0, createdAt: '2026-09-27T01:00:00Z', reason: 'promotion', reasonCode: 'PROMOTED', sliceId: SLICE, slices, evidence: null }] };
}
const active = (modelId, extra = {}) => learning({ [KEY]: { mode: 'auto', modelId, baselineModelId: 'claude-sonnet-5-5', baselineRate: 0.9, ...extra } });

function input(extra = {}) {
  return {
    harness: 'claude',
    // Claude Code 2.1.294: its haiku and sonnet aliases mean Haiku 5.5 and Sonnet 5.5 (from 2.1.293 and 2.1.284).
    harnessVersion: '2.1.294',
    subagentType: 'Explore',
    explicitModel: false,
    sessionModel: 'claude-opus-5-5',
    pins: { modelPin: null, effortPin: null },
    registry: BUNDLED_MODEL_REGISTRY,
    nowMs: NOW,
    unavailableModels: {},
    learning: active('claude-haiku-5-5'),
    signedPrior: null,
    ...extra,
  };
}

const reason = (extra) => adviseSubagentRoute(input(extra)).reasonCode;

/** The bundled registry plus a model of a family Claude Code has no alias for. */
function withFamily(family) {
  const sonnet = BUNDLED_MODEL_REGISTRY.entries.find((e) => e.modelId === 'claude-sonnet-5');
  return { ...BUNDLED_MODEL_REGISTRY, entries: [...BUNDLED_MODEL_REGISTRY.entries, { ...sonnet, modelId: `claude-${family}-1`, family }] };
}

test('subagent route R25: Fable routes through the fable alias', () => {
  const advice = adviseSubagentRoute(input({ learning: active('claude-fable-5-1') }));
  assert.deepEqual([advice.outcome, advice.modelId, advice.alias], ['propose', 'claude-fable-5-1', 'fable']);
});

test('subagent route: an active learned route for the subagent type proposes its model with the Claude Code alias', () => {
  assert.equal(subagentSliceId('Explore'), SLICE);
  assert.deepEqual([...CLAUDE_CODE_SUBAGENT_ALIASES], ['haiku', 'sonnet', 'opus', 'fable']);
  const advice = adviseSubagentRoute(input());
  assert.deepEqual(
    { outcome: advice.outcome, modelId: advice.modelId, alias: advice.alias, sliceId: advice.sliceId, basis: advice.basis, reasonCode: advice.reasonCode },
    { outcome: 'propose', modelId: 'claude-haiku-5-5', alias: 'haiku', sliceId: SLICE, basis: 'learning', reasonCode: 'SUBAGENT_ROUTE_LEARNED' },
  );
  assert.match(advice.text, /Explore subagent/);
  // A signed prior is the other evidence, when learning has nothing active.
  const prior = adviseSubagentRoute(input({ learning: null, signedPrior: { modelId: 'claude-sonnet-5-5', releaseId: 'rel-1' } }));
  assert.deepEqual([prior.outcome, prior.modelId, prior.alias, prior.basis, prior.reasonCode], ['propose', 'claude-sonnet-5-5', 'sonnet', 'signed-prior', 'SUBAGENT_ROUTE_PRIOR']);
  // Since Sonnet 5.5 the `sonnet` alias no longer means Sonnet 5: a route to it abstains.
  assert.equal(adviseSubagentRoute(input({ learning: null, signedPrior: { modelId: 'claude-sonnet-5', releaseId: 'rel-1' } })).reasonCode, 'ALIAS_NOT_NEWEST');
  // Since Claude Code 2.1.293 the haiku alias means Haiku 5.5, so a route to Haiku 4.5 abstains.
  assert.equal(adviseSubagentRoute(input({ learning: null, signedPrior: { modelId: 'claude-haiku-4-5-20251001', releaseId: 'rel-1' } })).reasonCode, 'ALIAS_NOT_NEWEST');
});

test('subagent route, owner decision 2026-10-08: with no learned or signed evidence a low-risk launch goes to haiku and a medium one to sonnet, for that call only', () => {
  const risk = (level, source = 'rules', subagentClass = 'read-only') => ({ level, source, subagentClass });
  const none = { learning: null, signedPrior: null };
  const low = adviseSubagentRoute(input({ ...none, risk: risk('low') }));
  assert.deepEqual(
    { outcome: low.outcome, modelId: low.modelId, alias: low.alias, basis: low.basis, reasonCode: low.reasonCode, blockedReason: low.blockedReason },
    { outcome: 'propose', modelId: 'claude-haiku-5-5', alias: 'haiku', basis: 'risk-rule', reasonCode: 'SUBAGENT_ROUTE_RISK_RULE', blockedReason: null },
  );
  assert.equal(low.appliedContext, 'Jevris set model haiku on this one Agent call (read-only type, low risk by rules). The session model is unchanged.');
  assert.equal(low.adviceContext, 'Jevris advises model: haiku for this Explore subagent (read-only type, low risk by rules). This call already started; set model on the next Agent call to apply it. The session model is unchanged.');
  const medium = adviseSubagentRoute(input({ ...none, subagentType: 'general-purpose', risk: risk('medium', 'rules', 'general-purpose') }));
  assert.deepEqual([medium.outcome, medium.modelId, medium.alias, medium.basis], ['propose', 'claude-sonnet-5-5', 'sonnet', 'risk-rule']);
  assert.match(medium.text, /general-purpose subagent, from general-purpose type, medium risk by rules/);
  // A Jev-raised judgement that stays low or medium is labelled as Jev's; a high one changes nothing.
  assert.deepEqual([adviseSubagentRoute(input({ ...none, risk: risk('low', 'jev') })).basis, adviseSubagentRoute(input({ ...none, risk: risk('low', 'jev') })).reasonCode], ['risk-jev', 'SUBAGENT_ROUTE_RISK_JEV']);
  assert.equal(adviseSubagentRoute(input({ ...none, risk: risk('high', 'jev', 'custom') })).reasonCode, 'RISK_HIGH');
  // Learned evidence and a signed prior win over the default.
  assert.deepEqual([adviseSubagentRoute(input({ risk: risk('low') })).basis, adviseSubagentRoute(input({ learning: null, signedPrior: { modelId: 'claude-sonnet-5-5', releaseId: 'rel-1' }, risk: risk('low') })).modelId], ['learning', 'claude-sonnet-5-5']);
  // The gates still apply to the default: eligibility, an explicit model, a pin, the session's own model, the lifecycle.
  assert.equal(reason({ ...none, risk: risk('low'), locallyEligible: ['claude-opus-5-5'] }), 'NOT_ELIGIBLE_HERE');
  assert.equal(adviseSubagentRoute(input({ ...none, risk: risk('low'), locallyEligible: ['claude-haiku-5-5'] })).outcome, 'propose');
  assert.equal(reason({ ...none, risk: risk('low'), explicitModel: true }), 'EXPLICIT_MODEL');
  assert.equal(reason({ ...none, risk: risk('low'), pins: { modelPin: 'claude-opus-5', effortPin: null } }), 'PINNED');
  assert.equal(reason({ ...none, risk: risk('low'), sessionModel: 'haiku' }), 'SAME_AS_SESSION');
  assert.equal(reason({ ...none, risk: risk('medium'), sessionModel: 'claude-haiku-5-5' }), 'NOT_CHEAPER', 'never to a model that costs more than the session');
  assert.equal(reason({ ...none, risk: risk('medium'), sessionModel: 'sonnet' }), 'SAME_AS_SESSION');
  // The session id is resolved as Claude Code reports it: a `[1m]` variant is its base model, and no id reads as the baseline (Sonnet 5.5), never as "cheaper" by default.
  assert.equal(reason({ ...none, risk: risk('medium'), sessionModel: null }), 'NOT_CHEAPER', 'an unknown session is the baseline, so Sonnet 5.5 is no cheaper');
  assert.equal(adviseSubagentRoute(input({ ...none, risk: risk('low'), sessionModel: null })).modelId, 'claude-haiku-5-5');
  assert.equal(reason({ ...none, risk: risk('medium'), sessionModel: 'claude-sonnet-5-5[1m]' }), 'NOT_CHEAPER');
  assert.equal(reason({ ...none, risk: risk('low'), sessionModel: 'claude-haiku-5-5[1m]' }), 'NOT_CHEAPER');
  assert.equal(adviseSubagentRoute(input({ ...none, risk: risk('low'), sessionModel: 'claude-sonnet-5-5[1m]' })).modelId, 'claude-haiku-5-5');
  assert.equal(adviseSubagentRoute(input({ ...none, risk: risk('medium'), sessionModel: 'claude-opus-5-5[1m]' })).modelId, 'claude-sonnet-5-5');
  assert.equal(reason({ ...none, risk: risk('low'), unavailableModels: { 'claude-haiku-5-5': 'MODEL_GONE' } }), 'MODEL_UNAVAILABLE');
  assert.equal(reason({ ...none, risk: risk('low'), consentedProviders: [] }), 'PROVIDER_NOT_CONSENTED');
  // The default follows the registry: when Haiku 5.5 is retired the next usable haiku is what the alias means.
  const retired = { ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => (e.modelId === 'claude-haiku-5-5' ? { ...e, lifecycle: { ...e.lifecycle, status: 'retired' } } : e)) };
  assert.equal(adviseSubagentRoute(input({ ...none, registry: retired, risk: risk('low') })).modelId, 'claude-haiku-4-5-20251001');
  // Claude Code only: no other harness takes the default, and without a risk there is nothing.
  assert.equal(reason({ ...none, harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', risk: risk('low') }), 'NO_EVIDENCE');
  assert.equal(reason({ ...none, harness: 'codex', sessionModel: 'gpt-6-sol', risk: risk('low') }), 'NO_EVIDENCE');
  assert.equal(reason({ ...none }), 'NO_EVIDENCE');
});

test('subagent route: every abstain reason, each paired with the one change that makes it propose', () => {
  const seen = new Set();
  const expect = (code, extra) => {
    assert.equal(reason(extra), code, JSON.stringify(extra));
    seen.add(code);
  };
  expect('HARNESS_NOT_SUPPORTED', { harness: 'jules' });
  // R20: Codex does not name an Anthropic model, so a signed prior for one abstains there.
  expect('NOT_ON_HARNESS', { harness: 'codex', learning: null, signedPrior: { modelId: 'claude-sonnet-5', releaseId: 'rel-1' } });
  // Codex takes only its offline presets (a model's own Codex row): GPT-5.6 Sol is spelled by the template but is not one.
  expect('NOT_ON_HARNESS', { harness: 'codex', sessionModel: 'gpt-6-sol', learning: null, signedPrior: { modelId: 'gpt-5.6-sol', releaseId: 'rel-1' } });
  assert.equal(adviseSubagentRoute(input({ harness: 'codex', sessionModel: 'gpt-6-sol', learning: null, signedPrior: { modelId: 'gpt-6-luna', releaseId: 'rel-1' } })).outcome, 'propose');
  // Owner 3f090fa: where the route names the harness's own id, the model must be eligible here from local evidence.
  expect('NOT_ELIGIBLE_HERE', { harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', locallyEligible: ['claude-opus-5-5'] });
  assert.equal(adviseSubagentRoute(input({ harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', locallyEligible: ['claude-haiku-5-5'] })).outcome, 'propose');
  // 8c1f85d: a route keeps the session's host; a gateway session has none Jevris can keep.
  expect('HOST_UNKNOWN', { harness: 'opencode', sessionModel: 'openrouter/anthropic/claude-opus-5-5', locallyEligible: ['claude-haiku-5-5'] });
  // R44: the session's host is known, but the model has not been seen through any host here.
  expect('NOT_ON_SESSION_HOST', { harness: 'opencode', sessionModel: 'openai/gpt-6-sol', locallyEligible: null, consentedProviders: ['anthropic', 'openai'] });
  expect('NO_SUBAGENT_TYPE', { subagentType: undefined });
  expect('NO_SUBAGENT_TYPE', { subagentType: '' });
  expect('INVALID_SUBAGENT_TYPE', { subagentType: 'bad type/../x' });
  expect('INVALID_SUBAGENT_TYPE', { subagentType: 'x'.repeat(65) });
  expect('EXPLICIT_MODEL', { explicitModel: true });
  expect('PINNED', { pins: { modelPin: 'claude-opus-5', effortPin: null } });
  // No evidence: no learning state, an advise slice, another slice active, a slice pinned to advice.
  expect('NO_EVIDENCE', { learning: null });
  expect('NO_EVIDENCE', { learning: learning({}) });
  expect('NO_EVIDENCE', { learning: learning({ 'subagent:Plan': { mode: 'auto', modelId: 'claude-haiku-5-5', baselineModelId: null, baselineRate: null } }) });
  expect('NO_EVIDENCE', { learning: learning({ [KEY]: { mode: 'advise', modelId: null, baselineModelId: null, baselineRate: null } }) });
  expect('NOT_IN_REGISTRY', { learning: active('claude-mystery-9') });
  const retired = { ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => (e.modelId === 'claude-haiku-5-5' ? { ...e, lifecycle: { ...e.lifecycle, retiresOn: '2026-09-01T00:00:00Z' } } : e)) };
  expect('MODEL_RETIRED', { registry: retired });
  expect('MODEL_UNAVAILABLE', { unavailableModels: { 'claude-haiku-5-5': 'MODEL_GONE' } });
  expect('MODEL_UNAVAILABLE', { unavailableModels: { 'claude-haiku-5-5': 'MODEL_NOT_ACCESSIBLE' } });
  // OD-4 (MEDIUM 4, 9): the session's consent gate; absent, the pinned default (Kimi always needs a grant).
  expect('PROVIDER_NOT_CONSENTED', { consentedProviders: [] });
  expect('PROVIDER_NOT_CONSENTED', { harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', learning: active('kimi-k3') });
  assert.equal(adviseSubagentRoute(input({ consentedProviders: ['anthropic'] })).outcome, 'propose');
  // Owner decision 2026-10-08 (amends 3f090fa for Claude Code): the alias branch checks eligibility too.
  expect('NOT_ELIGIBLE_HERE', { locallyEligible: ['claude-opus-5-5'] });
  assert.equal(adviseSubagentRoute(input({ locallyEligible: ['claude-haiku-5-5'] })).outcome, 'propose');
  // The risk default: a high-risk launch changes nothing, and a medium one never goes to a model that costs more than the session's.
  expect('RISK_HIGH', { learning: null, risk: { level: 'high', source: 'rules', subagentClass: 'custom' } });
  expect('NOT_CHEAPER', { learning: null, risk: { level: 'medium', source: 'rules', subagentClass: 'general-purpose' }, sessionModel: 'claude-haiku-5-5' });
  expect('NO_ALIAS', { registry: withFamily('mythos'), learning: active('claude-mythos-1') });
  // R25, K1: `opus` resolves to the family's current model, Opus 5.5, so a route to Opus 5 abstains.
  expect('ALIAS_NOT_NEWEST', { learning: active('claude-opus-5'), sessionModel: 'claude-sonnet-5' });
  // Amended 2026-10-08: on a Claude Code older than the version from which `haiku` means Haiku 5.5 (2.1.293), or of unknown version, the alias still means an older model.
  expect('ALIAS_VERSION_OLD', { harnessVersion: '2.1.292' });
  expect('ALIAS_VERSION_OLD', { harnessVersion: null });
  expect('ALIAS_VERSION_OLD', { harnessVersion: undefined });
  expect('EFFORT_NOT_ROUTABLE', { learning: active('claude-opus-5-5', { effort: 'low' }), sessionModel: 'claude-sonnet-5' });
  expect('SAME_AS_SESSION', { sessionModel: 'claude-haiku-5-5' });
  expect('SAME_AS_SESSION', { sessionModel: 'haiku' });
  // Access limits R73 (design E5): the subagent's scope on this harness and sign-in is paused.
  const window = { key: '0123456789abcdef', scope: { harness: 'claude', authMode: 'subscription', servingHost: 'anthropic', modelId: null, family: null }, class: 'usage-window', signal: 'claude.stream.rate-limit-event.five-hour', source: 'session', firstSeenMs: NOW - 60_000, lastSeenMs: NOW - 60_000, untilMs: NOW + 3_600_000, step: 0, weekly: false, resetBasis: 'reported', count: 1, fingerprint: null };
  expect('ACCESS_LIMITED', { accessLimits: [window], authMode: 'subscription' });
  assert.equal(adviseSubagentRoute(input({ accessLimits: [window], authMode: 'api-key' })).outcome, 'propose', 'a subscription window leaves the API key');
  assert.equal(adviseSubagentRoute(input({ accessLimits: [{ ...window, untilMs: NOW }], authMode: 'subscription' })).outcome, 'propose', 'an expired window pauses nothing');
  // Learned against Opus 5.5 (the bare key, before the 2026-10-08 move) is not Claude Code's evidence now: it starts afresh.
  expect('NO_EVIDENCE', { learning: learning({ [SLICE]: { mode: 'auto', modelId: 'claude-haiku-5-5', baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }) });
  assert.deepEqual([...seen].sort(), [...SUBAGENT_ROUTE_ABSTAIN_REASONS].sort(), 'every declared abstain reason is exercised');
  // Pairs: the default input proposes; a learned arm at the model's default effort is routable.
  assert.equal(adviseSubagentRoute(input()).outcome, 'propose');
  assert.equal(adviseSubagentRoute(input({ learning: active('claude-opus-5-5', { effort: core.defaultEffortOf('claude-opus-5-5') }), sessionModel: 'claude-sonnet-5' })).outcome, 'propose');
  // Opus 5 is routable once no newer usable Opus is in the registry (Opus 5.5 retired here).
  const opus55Retired = { ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => (e.modelId === 'claude-opus-5-5' ? { ...e, lifecycle: { ...e.lifecycle, status: 'retired' } } : e)) };
  assert.equal(adviseSubagentRoute(input({ registry: opus55Retired, learning: active('claude-opus-5'), sessionModel: 'claude-sonnet-5' })).outcome, 'propose');
  // A family entry with no release date cannot be ordered, so the alias is not trusted.
  const undated = { ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => (e.modelId === 'claude-opus-5' ? { ...e, lifecycle: { ...e.lifecycle, releasedOn: null } } : e)) };
  assert.equal(reason({ registry: undated, learning: active('claude-opus-5-5'), sessionModel: 'claude-sonnet-5' }), 'ALIAS_NOT_NEWEST');
  assert.equal(adviseSubagentRoute(input({ sessionModel: null })).outcome, 'propose', 'an unknown session model does not block');
  // Learning beats a signed prior; a gone learned model is never replaced by the prior silently.
  assert.equal(reason({ unavailableModels: { 'claude-haiku-5-5': 'MODEL_GONE' }, signedPrior: { modelId: 'claude-sonnet-5', releaseId: 'rel-1' } }), 'MODEL_UNAVAILABLE');
});

test('subagent route: no prompt text is ever read; only the declared fields decide', () => {
  // A Proxy input throws on any field the function is not declared to read (prompt, description, toolInput...).
  const allowed = new Set(['harness', 'subagentType', 'explicitModel', 'sessionModel', 'pins', 'registry', 'nowMs', 'unavailableModels', 'learning', 'signedPrior', 'consentedProviders', 'locallyEligible', 'accessLimits', 'authMode', 'harnessVersion', 'risk', 'tier']);
  const guarded = new Proxy({ ...input(), prompt: 'SECRET PROMPT', description: 'SECRET', toolInput: { prompt: 'SECRET' } }, {
    get(target, key) {
      if (typeof key === 'string' && !allowed.has(key)) throw new Error(`read ${key}`);
      return Reflect.get(target, key);
    },
  });
  const advice = adviseSubagentRoute(guarded);
  assert.equal(advice.outcome, 'propose');
  assert.doesNotMatch(JSON.stringify(advice), /SECRET/);
});

test('R20: each harness applies a subagent route its own way; Antigravity explains only', () => {
  const { SUBAGENT_ROUTE_ACTUATORS, learningSliceKey } = core;
  assert.deepEqual(Object.keys(SUBAGENT_ROUTE_ACTUATORS).sort(), ['antigravity', 'claude', 'codex', 'kilocode', 'opencode']);
  assert.equal(SUBAGENT_ROUTE_ACTUATORS.antigravity, null);
  assert.deepEqual([SUBAGENT_ROUTE_ACTUATORS.claude.carries, SUBAGENT_ROUTE_ACTUATORS.codex.carries, SUBAGENT_ROUTE_ACTUATORS.codex.authority], ['alias', 'harness-model-id', 'updated-input-with-allow']);
  // Codex: the slice learns under Codex's baseline (R17), and the route names Codex's own id.
  const codexKey = learningSliceKey(SLICE, 'gpt-6.1-sol', BUNDLED_MODEL_REGISTRY);
  assert.notEqual(codexKey, SLICE);
  const codex = adviseSubagentRoute(input({ harness: 'codex', sessionModel: 'gpt-6.1-sol', learning: learning({ [codexKey]: { mode: 'auto', modelId: 'gpt-6-luna', baselineModelId: 'gpt-6.1-sol', baselineRate: 0.9 } }) }));
  assert.deepEqual([codex.outcome, codex.harness, codex.modelId, codex.harnessModel, codex.alias, codex.actuator.tool], ['propose', 'codex', 'gpt-6-luna', 'gpt-6-luna', null, 'spawn_agent']);
  // A route learned on Claude Code's subagents is never proposed on Codex.
  assert.equal(reason({ harness: 'codex', sessionModel: 'gpt-6.1-sol' }), 'NO_EVIDENCE');
  // OpenCode and Kilo: the same learned route, spelled provider/model; the session spelling counts as the same model.
  for (const harness of ['opencode', 'kilocode']) {
    const advice = adviseSubagentRoute(input({ harness, sessionModel: 'anthropic/claude-opus-5-5' }));
    assert.deepEqual([advice.outcome, advice.harnessModel, advice.actuator.tool], ['propose', 'anthropic/claude-haiku-5-5', 'task']);
    assert.match(advice.text, /anthropic\/claude-haiku-5-5/);
    assert.equal(reason({ harness, sessionModel: 'anthropic/claude-haiku-5-5' }), 'SAME_AS_SESSION');
  }
  // A learned effort rides as the route's variant where the actuator carries one (E b250627): Kilo's
  // variant. Codex states it only (43cb54c); OpenCode's child-session route and Claude Code's alias carry none.
  const codexHigh = adviseSubagentRoute(input({ harness: 'codex', sessionModel: 'gpt-6.1-sol', learning: learning({ [codexKey]: { mode: 'auto', modelId: 'gpt-6-luna', effort: 'xhigh', baselineModelId: 'gpt-6.1-sol', baselineRate: 0.9 } }) }));
  assert.deepEqual([codexHigh.outcome, codexHigh.harnessModel, codexHigh.variant], ['propose', 'gpt-6-luna', null]);
  assert.equal(codex.variant, null);
  const sonnetLow = active('claude-sonnet-5', { effort: 'low' });
  const kiloLow = adviseSubagentRoute(input({ harness: 'kilocode', sessionModel: 'anthropic/claude-opus-5-5', learning: sonnetLow }));
  assert.deepEqual([kiloLow.outcome, kiloLow.harnessModel, kiloLow.variant], ['propose', 'anthropic/claude-sonnet-5', 'low']);
  assert.equal(reason({ harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', learning: sonnetLow }), 'EFFORT_NOT_ROUTABLE');
  assert.equal(reason({ learning: active('claude-sonnet-5-5', { effort: 'low' }) }), 'EFFORT_NOT_ROUTABLE');
  // Owner decision 43cb54c: on Codex the route sets the model only; the learned effort is stated, never carried.
  assert.equal(codexHigh.effortNotApplied, 'xhigh');
  assert.match(codexHigh.text, /learned effort is xhigh; the route sets the model only/);
  assert.equal(kiloLow.effortNotApplied, null);
  // One learning key per harness baseline, the one the advice reads (D records under it).
  assert.deepEqual(['claude', 'codex', 'kilocode', 'opencode', 'antigravity'].map((h) => core.subagentLearningKey('Explore', h, BUNDLED_MODEL_REGISTRY)), [KEY, codexKey, KEY, KEY, learningSliceKey(SLICE, 'gemini-3.8-flash', BUNDLED_MODEL_REGISTRY)]);
  assert.equal(learningSliceKey(SLICE, 'claude-opus-5-5', BUNDLED_MODEL_REGISTRY), SLICE, 'the bare key is pinned to Opus 5.5: what was learned against it stays where it is');
  assert.equal(core.subagentLearningKey('bad type/..', 'codex', BUNDLED_MODEL_REGISTRY), null);
  assert.deepEqual([...core.SUBAGENT_ROUTE_HARNESSES], ['claude', 'codex', 'kilocode', 'opencode']);
  // Antigravity: a proposal with no actuator, spelled as Antigravity names it.
  const agyKey = learningSliceKey(SLICE, 'gemini-3.8-flash', BUNDLED_MODEL_REGISTRY);
  const agy = adviseSubagentRoute(input({ harness: 'antigravity', sessionModel: null, learning: learning({ [agyKey]: { mode: 'auto', modelId: 'gemini-3.7-flash', baselineModelId: 'gemini-3.8-flash', baselineRate: 0.9 } }) }));
  assert.deepEqual([agy.outcome, agy.actuator], ['propose', null]);
});

test('subagent route, amended 2026-10-08: a family alias means a newer model only from the Claude Code version that maps it (haiku 2.1.293, sonnet 2.1.284)', () => {
  const { CLAUDE_CODE_ALIAS_SINCE, aliasMeansModel, aliasNeedsClaudeCode, claudeCodeVersionOf, aliasVersionOldText, claudeAliasGaps } = core;
  assert.deepEqual({ ...CLAUDE_CODE_ALIAS_SINCE }, { 'claude-sonnet-5-5': '2.1.284', 'claude-haiku-5-5': '2.1.293' });
  const model = (id) => BUNDLED_MODEL_REGISTRY.entries.find((e) => e.modelId === id);
  const means = (id, version) => aliasMeansModel(BUNDLED_MODEL_REGISTRY, model(id), NOW, version);
  // Haiku: below, at and above 2.1.293, and a version that is not known.
  assert.deepEqual(['2.1.292', '2.1.293', '2.1.294', '2.2.0', '3.0.0', '2.0.999'].map((v) => means('claude-haiku-5-5', v)), [false, true, true, true, true, false]);
  assert.deepEqual([null, undefined, '', 'unknown', 'v2'].map((v) => means('claude-haiku-5-5', v)), [false, false, false, false, false]);
  // Sonnet: from 2.1.284.
  assert.deepEqual(['2.1.283', '2.1.284', '2.1.285', '2.1.292'].map((v) => means('claude-sonnet-5-5', v)), [false, true, true, true]);
  // A model with no table entry keeps today's rule, whatever the version (Opus 5.5 is the newest Opus).
  assert.deepEqual([null, '2.1.0', '2.1.294'].map((v) => means('claude-opus-5-5', v)), [true, true, true]);
  // The newest-of-family rule still applies on a recent version: Opus 5 is not the newest Opus.
  assert.equal(means('claude-opus-5', '2.1.294'), false);
  // The installed version may carry a suffix; the x.y.z is what counts.
  assert.equal(claudeCodeVersionOf('2.1.293 (Claude Code)'), '2.1.293');
  assert.equal(claudeCodeVersionOf('claude 2.1.292'), '2.1.292');
  assert.equal(claudeCodeVersionOf('nonsense'), null);
  assert.equal(means('claude-haiku-5-5', '2.1.293 (Claude Code)'), true);
  assert.equal(aliasNeedsClaudeCode(model('claude-haiku-5-5'), '2.1.292'), '2.1.293');
  assert.equal(aliasNeedsClaudeCode(model('claude-haiku-5-5'), '2.1.293'), null);
  assert.equal(aliasNeedsClaudeCode(model('claude-opus-5-5'), null), null);
  // The route: haiku abstains on 2.1.292 with the plain sentence, and routes on 2.1.293 and 2.1.294; the alias is never set below.
  const old = adviseSubagentRoute(input({ harnessVersion: '2.1.292' }));
  assert.deepEqual([old.outcome, old.reasonCode, old.sliceId], ['abstain', 'ALIAS_VERSION_OLD', SLICE]);
  assert.equal(old.text, 'Claude Code 2.1.292 may map the haiku alias to an older model; update to 2.1.293 or later (or name the model by its id) so the alias means the current one.');
  assert.equal(old.text, aliasVersionOldText('haiku', '2.1.292', '2.1.293'));
  for (const harnessVersion of ['2.1.293', '2.1.294']) {
    const advice = adviseSubagentRoute(input({ harnessVersion }));
    assert.deepEqual([advice.outcome, advice.alias, advice.harnessModel], ['propose', 'haiku', 'haiku'], harnessVersion);
  }
  // An unknown version is conservative for a gated model, and the sentence says so.
  assert.match(adviseSubagentRoute(input({ harnessVersion: null })).text, /^This Claude Code \(its version is not known\) may map the haiku alias/);
  // Sonnet routes on 2.1.292 (since 2.1.284) and abstains before it; opus and fable are not gated.
  const sonnet = (harnessVersion) => adviseSubagentRoute(input({ learning: active('claude-sonnet-5-5'), sessionModel: 'claude-opus-5-5', harnessVersion }));
  assert.deepEqual([sonnet('2.1.292').outcome, sonnet('2.1.283').reasonCode, sonnet(null).reasonCode], ['propose', 'ALIAS_VERSION_OLD', 'ALIAS_VERSION_OLD']);
  assert.equal(adviseSubagentRoute(input({ learning: active('claude-opus-5-5'), sessionModel: 'claude-sonnet-5', harnessVersion: null })).outcome, 'propose', 'opus has no table entry');
  assert.equal(adviseSubagentRoute(input({ learning: active('claude-fable-5-1'), harnessVersion: null })).outcome, 'propose', 'fable has no table entry');
  // The version is not read on other harnesses: Kilo spells the model id, no alias.
  assert.equal(adviseSubagentRoute(input({ harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', locallyEligible: ['claude-haiku-5-5'], harnessVersion: null })).outcome, 'propose');
  // Doctor's gaps: which newest models the installed Claude Code does not yet map its alias to.
  assert.deepEqual(claudeAliasGaps(BUNDLED_MODEL_REGISTRY, NOW, '2.1.292').map((g) => [g.alias, g.modelId, g.since]), [['haiku', 'claude-haiku-5-5', '2.1.293']]);
  assert.deepEqual(claudeAliasGaps(BUNDLED_MODEL_REGISTRY, NOW, '2.1.294'), []);
  assert.deepEqual(claudeAliasGaps(BUNDLED_MODEL_REGISTRY, NOW, null).map((g) => g.alias).sort(), ['haiku', 'sonnet']);
});
