// Tiered routing, step 2b (owner decision 2026-10-08, a new decision against OD-8): on Kilo and OpenCode, after no promoted slice,
// the shared tier of the linked task's work may name the main-session turn's model, within the session's own provider, and
// actuate it under every existing gate; below bounded-auto it is advice. A learned, promoted slice still takes precedence.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const { BUNDLED_MODEL_REGISTRY: R, routeTurn, emptyLearningState, learningSliceKey } = core;

const NOW = Date.parse('2026-10-08T12:00:00Z');
const SLICE = 'bounded-edit';
const OPEN = { taskId: 'task-1', risk: 'low', sliceId: SLICE, turnActuation: 'bounded-auto', turnReasonCode: null };
const RULES = 'Rules-based default - not a learned route, not a signed prior';
const down = (targetModelId, over = {}) => ({ tier: 'step-down', targetModelId, basis: 'tier-rule', label: RULES, reasonCodes: ['TIER_LOW_RISK_BOUNDED'], ...over });
const up = (targetModelId, over = {}) => ({ tier: 'step-up', targetModelId, basis: 'tier-rule', label: RULES, reasonCodes: ['TIER_PROTECTED_PATH'], stepUpGate: null, ...over });

function promoted(modelId, baseline) {
  const state = emptyLearningState({ workspaceId: 'w-turn', now: new Date(NOW).toISOString() });
  const key = learningSliceKey(SLICE, baseline, R);
  const last = state.versions[state.versions.length - 1];
  return { ...state, versions: [...state.versions, { version: last.version + 1, parentVersion: last.version, createdAt: new Date(NOW).toISOString(), reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId, baselineModelId: baseline, baselineRate: 0.9 } }, evidence: null }] };
}

const turn = (extra = {}) => {
  const answer = routeTurn({
    harness: 'opencode', current: { providerID: 'anthropic', modelID: 'claude-sonnet-5-5' }, registry: R, learning: null, sliceId: SLICE, scope: OPEN,
    mainSession: 'plugin-bounded-auto', killSwitchStopped: false, modelPin: null, nowMs: NOW, locallyEligible: R.entries.map((e) => e.modelId), providerConsent: () => ({ granted: true }), ...extra,
  });
  assert.equal(contracts.RouteTurnPayloadContract.validate(answer).ok, true, JSON.stringify(answer));
  return answer;
};

test('a step down on a linked low-risk task actuates the turn under bounded-auto, spelled for the harness, reason TIER_RULE', () => {
  for (const harness of ['kilocode', 'opencode']) {
    const a = turn({ harness, tier: down('claude-haiku-5-5') });
    assert.deepEqual([a.outcome, a.actuate, a.mainSession, a.model, a.variant, a.reasonCode], ['switch', true, { mode: 'plugin-bounded-auto', switched: true }, { providerID: 'anthropic', modelID: 'claude-haiku-5-5' }, null, 'TIER_RULE'], harness);
    assert.match(a.text, /^Switched this turn to anthropic\/claude-haiku-5-5 \(a step down\): Rules-based default - not a learned route, not a signed prior \(TIER_LOW_RISK_BOUNDED\); no learned slice applies\./);
  }
  // No slice at all: the tier still names a model.
  assert.equal(turn({ sliceId: null, tier: down('claude-haiku-5-5') }).actuate, true);
});

test('every existing gate still holds for a tier turn: advice (TIER_RULE_ADVICE) with the reason, never an actuation', () => {
  const advice = (extra, code) => {
    const a = turn({ tier: down('claude-haiku-5-5'), ...extra });
    assert.deepEqual([a.outcome, a.actuate, a.mainSession.switched, a.reasonCode], ['switch', false, false, 'TIER_RULE_ADVICE'], JSON.stringify(a));
    assert.match(a.text, new RegExp(`Not switched \\(${code}\\)`), a.text);
    assert.deepEqual(a.model, { providerID: 'anthropic', modelID: 'claude-haiku-5-5' });
  };
  advice({ mainSession: 'advice-only' }, 'MAIN_SESSION_ADVICE_ONLY');
  advice({ scope: null }, 'NO_APPROVED_SCOPE');
  advice({ scope: { ...OPEN, turnActuation: 'advise', turnReasonCode: 'TURN_ROUTE_UNCERTIFIED' } }, 'TURN_ROUTE_UNCERTIFIED');
  advice({ scope: { ...OPEN, turnActuation: 'advise', turnReasonCode: 'SESSION_NOT_LINKED' } }, 'SESSION_NOT_LINKED');
  advice({ scope: { ...OPEN, risk: 'medium' } }, 'RISK_NOT_LOW');
  // Abstentions of the main path are unchanged: a pin, the kill switch, an unregistered session model.
  assert.equal(turn({ tier: down('claude-haiku-5-5'), modelPin: 'anthropic/claude-sonnet-5-5' }).reasonCode, 'PIN_RESPECTED');
  assert.equal(turn({ tier: down('claude-haiku-5-5'), killSwitchStopped: true }).reasonCode, 'KILL_SWITCH');
  assert.equal(turn({ tier: down('claude-haiku-5-5'), current: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-5-5' } }).reasonCode, 'CURRENT_MODEL_UNREGISTERED');
  // The baseline tier, or a target that is the session's own model, changes nothing.
  assert.equal(turn({ tier: { ...down('claude-sonnet-5-5'), tier: 'baseline' } }).reasonCode, 'NO_PROMOTED_SLICE');
  assert.equal(turn({ tier: down('claude-sonnet-5-5') }).reasonCode, 'ALREADY_ON_MODEL');
  // Consent and eligibility of the target apply as for a promoted model (an access-limit pause is the same shared tail: access-limits-turn.test.mjs).
  assert.equal(turn({ tier: down('kimi-k3'), providerConsent: (p) => (p === 'anthropic' ? { granted: true } : { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }) }).actuate, false);
});

test('a step up needs the linked-task gate without the low-risk condition: a high-risk linked task actuates, an unlinked one is advice', () => {
  const highRisk = { ...OPEN, risk: 'high', turnActuation: 'advise', turnReasonCode: 'RISK_NOT_LOW' };
  // The step-down gate would refuse this task (RISK_NOT_LOW); the step-up gate (D's gate without that condition) is open.
  const a = turn({ scope: highRisk, tier: up('claude-opus-5-5') });
  assert.deepEqual([a.outcome, a.actuate, a.reasonCode, a.model], ['switch', true, 'TIER_RULE', { providerID: 'anthropic', modelID: 'claude-opus-5-5' }]);
  assert.match(a.text, /\(a step up\)/);
  // The link is still required, and so are the mode, certification and budget (D's gate decided them into stepUpGate).
  for (const gate of ['SESSION_NOT_LINKED', 'TURN_ROUTE_UNCERTIFIED', 'BUDGET_EXHAUSTED', 'KILL_SWITCH']) {
    const b = turn({ scope: highRisk, tier: up('claude-opus-5-5', { stepUpGate: gate }) });
    assert.deepEqual([b.actuate, b.reasonCode], [false, 'TIER_RULE_ADVICE'], gate);
    assert.match(b.text, new RegExp(`Not switched \\(${gate}\\)`));
  }
  assert.equal(turn({ scope: highRisk, tier: { ...up('claude-opus-5-5'), stepUpGate: undefined } }).actuate, false, 'a gate that was not read is advice');
  assert.equal(turn({ scope: highRisk, mainSession: 'advice-only', tier: up('claude-opus-5-5') }).actuate, false);
  assert.equal(turn({ scope: null, tier: up('claude-opus-5-5') }).reasonCode, 'TIER_RULE_ADVICE');
  // A step down never uses the step-up gate: a high-risk task is still refused for it.
  assert.equal(turn({ scope: highRisk, tier: down('claude-haiku-5-5', { stepUpGate: null }) }).actuate, false);
});

test('Jev\'s pick (from the session memo) carries its own label and codes; advice below bounded-auto', () => {
  const jev = up('claude-opus-5-5', { basis: 'tier-jev', label: "Jev's suggestion from structured features; not a learned route, not a signed prior" });
  const a = turn({ tier: jev });
  assert.deepEqual([a.actuate, a.reasonCode], [true, 'TIER_JEV']);
  assert.match(a.text, /Jev's suggestion from structured features/);
  const b = turn({ tier: jev, mainSession: 'advice-only' });
  assert.deepEqual([b.actuate, b.reasonCode], [false, 'TIER_JEV_ADVICE']);
});

test('a learned, promoted slice takes precedence over the tier; a pinned slice abstains; the tier fills in only where nothing is promoted', () => {
  const learned = turn({ learning: promoted('claude-haiku-5-5', 'claude-sonnet-5-5'), tier: up('claude-opus-5-5') });
  assert.deepEqual([learned.reasonCode, learned.model.modelID], ['PROMOTED_SAVING', 'claude-haiku-5-5']);
  const pinned = core.pinSlice(emptyLearningState({ workspaceId: 'w', now: new Date(NOW).toISOString() }), SLICE, 'claude-haiku-5-5', new Date(NOW).toISOString(), null, R);
  assert.equal(turn({ learning: pinned, tier: down('claude-haiku-5-5') }).reasonCode, 'SLICE_PINNED');
  const none = turn({ learning: emptyLearningState({ workspaceId: 'w', now: new Date(NOW).toISOString() }), tier: down('claude-haiku-5-5') });
  assert.deepEqual([none.reasonCode, none.actuate], ['TIER_RULE', true]);
});

test('provider-neutral: a GPT session moves within OpenAI, a Gemini or GLM session within its own provider, spelled as the harness spells it', () => {
  const gpt = turn({ harness: 'kilocode', current: { providerID: 'openai', modelID: 'gpt-6.1-sol' }, tier: down('gpt-6-luna') });
  assert.deepEqual([gpt.actuate, gpt.model], [true, { providerID: 'openai', modelID: 'gpt-6-luna' }]);
  const gptUp = turn({ harness: 'opencode', current: { providerID: 'openai', modelID: 'gpt-6.1-sol' }, scope: { ...OPEN, risk: 'high' }, tier: up('gpt-6-astra') });
  assert.deepEqual([gptUp.actuate, gptUp.model], [true, { providerID: 'openai', modelID: 'gpt-6-astra' }]);
  // A target of another provider needs that provider's consent and a host seen here: with neither it is not written.
  const cross = turn({ current: { providerID: 'openai', modelID: 'gpt-6.1-sol' }, tier: down('claude-haiku-5-5'), providerConsent: (p) => (p === 'openai' ? { granted: true } : { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }), locallyEligible: [] });
  assert.equal(cross.actuate, false);
});
