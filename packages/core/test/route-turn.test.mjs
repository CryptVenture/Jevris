// OD-8 (owner decisions DOMAINS f294e43): the per-turn main-session route for Kilo and OpenCode.
// It abstains by default, names a model only from a promoted slice under the session's own
// baseline key, and actuates only under plugin-bounded-auto with D's gate open on a low-risk task.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const { BUNDLED_MODEL_REGISTRY: R, routeTurn, emptyLearningState, learningSliceKey } = core;

// pinned-clock: every turn here is routed at this time.
const NOW = Date.parse('2026-09-28T00:00:00Z');
const SLICE = 'bounded-edit';
const OPEN = { taskId: 'task-1', risk: 'low', turnActuation: 'bounded-auto', turnReasonCode: null };

/** A learning state whose slice (under the given baseline) is promoted to `modelId`. */
function promoted(modelId, baseline = 'claude-opus-5-5', extra = {}) {
  const state = emptyLearningState({ workspaceId: 'w-turn', now: new Date(NOW).toISOString() });
  const key = learningSliceKey(SLICE, baseline, R);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: new Date(NOW).toISOString(), reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId, baselineModelId: baseline, baselineRate: 0.9, ...extra } }, evidence: null };
  return { ...state, versions: [...state.versions, version] };
}

const turn = (extra = {}) => {
  const answer = routeTurn({
    harness: 'opencode', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' }, registry: R, learning: promoted('claude-sonnet-5'), sliceId: SLICE, scope: OPEN,
    mainSession: 'plugin-bounded-auto', killSwitchStopped: false, modelPin: null, nowMs: NOW, ...extra,
  });
  assert.equal(contracts.RouteTurnPayloadContract.validate(answer).ok, true, JSON.stringify(answer));
  return answer;
};

test('OD-8: a promoted slice on a low-risk task with the gate open switches the turn, spelled for the harness', () => {
  const a = turn();
  assert.deepEqual([a.outcome, a.actuate, a.mainSession, a.model, a.variant, a.reasonCode], ['switch', true, { mode: 'plugin-bounded-auto', switched: true }, { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, null, 'PROMOTED_SAVING']);
  const kilo = turn({ harness: 'kilocode' });
  assert.equal(kilo.actuate, true);
  // An effort arm becomes the harness's variant.
  const high = turn({ learning: promoted('claude-sonnet-5', 'claude-opus-5-5', { effort: 'high' }) });
  assert.deepEqual([high.actuate, high.variant], [true, 'high']);
});

test('OD-8: it abstains by default: no learning, no slice, no promotion, an unregistered or gateway current model, a pin, the kill switch', () => {
  assert.deepEqual([turn({ learning: null }).outcome, turn({ learning: null }).reasonCode], ['abstain', 'NO_PROMOTED_SLICE']);
  assert.equal(turn({ learning: emptyLearningState({ workspaceId: 'w', now: new Date(NOW).toISOString() }) }).reasonCode, 'NO_PROMOTED_SLICE');
  assert.equal(turn({ sliceId: null }).reasonCode, 'UNKNOWN_SLICE');
  assert.equal(turn({ current: { providerID: 'openrouter', modelID: 'anthropic/claude-opus-5-5' } }).reasonCode, 'CURRENT_MODEL_UNREGISTERED');
  assert.equal(turn({ modelPin: 'anthropic/claude-opus-5-5' }).reasonCode, 'PIN_RESPECTED');
  assert.equal(turn({ killSwitchStopped: true }).reasonCode, 'KILL_SWITCH');
  assert.equal(turn({ current: { providerID: 'anthropic', modelID: 'claude-sonnet-5' } }).reasonCode, 'NO_PROMOTED_SLICE', "another baseline's key has no promotion");
});

test('OD-8: a promoted model is advice, never actuated, when the mode, the gate, the scope or the risk says so', () => {
  const advice = (extra, code) => {
    const a = turn(extra);
    assert.deepEqual([a.outcome, a.actuate, a.mainSession.switched, a.reasonCode], ['switch', false, false, code], JSON.stringify(a));
    assert.deepEqual(a.model, { providerID: 'anthropic', modelID: 'claude-sonnet-5' });
  };
  advice({ mainSession: 'advice-only' }, 'MAIN_SESSION_ADVICE_ONLY');
  advice({ mainSession: null }, 'MAIN_SESSION_ADVICE_ONLY');
  advice({ scope: null }, 'NO_APPROVED_SCOPE');
  advice({ scope: { ...OPEN, turnActuation: 'advise', turnReasonCode: 'TURN_ROUTE_UNCERTIFIED' } }, 'TURN_ROUTE_UNCERTIFIED');
  advice({ scope: { ...OPEN, turnActuation: 'advise', turnReasonCode: null } }, 'TURN_GATE_ADVISE');
  advice({ scope: { ...OPEN, risk: 'medium' } }, 'RISK_NOT_LOW');
  advice({ scope: { taskId: 'task-1', turnActuation: 'bounded-auto', turnReasonCode: null } }, 'RISK_NOT_LOW');
});

test('OD-4 and R17: another provider needs its consent; the session baseline picks the learning key', () => {
  // Kimi from an Anthropic session: Kimi always needs a grant.
  const kimi = turn({ learning: promoted('kimi-k3') });
  assert.deepEqual([kimi.outcome, kimi.reasonCode], ['abstain', 'PROVIDER_CONSENT_REQUIRED']);
  // Granted, it still does not move the session to a host Jevris has not seen for it: Kimi has two
  // hosts on OpenCode (moonshotai, moonshotai-cn), so none is chosen (8c1f85d; R44 NOT_ON_SESSION_HOST).
  const granted = turn({ learning: promoted('kimi-k3'), locallyEligible: ['kimi-k3'], providerConsent: (p) => (p === 'moonshot' ? { granted: true } : { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }) });
  assert.deepEqual([granted.outcome, granted.actuate, granted.reasonCode], ['abstain', false, 'NOT_ON_SESSION_HOST']);
  // A session on Moonshot's China host is registered (it reaches the slice lookup, not CURRENT_MODEL_UNREGISTERED).
  assert.equal(turn({ current: { providerID: 'moonshotai-cn', modelID: 'kimi-k3' }, learning: promoted('kimi-k3') }).reasonCode, 'NO_PROMOTED_SLICE');
  // A GPT session on OpenCode learns under its own key.
  const gpt = turn({ current: { providerID: 'openai', modelID: 'gpt-6-sol' }, learning: promoted('gpt-6-luna', 'gpt-6-sol') });
  assert.deepEqual([gpt.actuate, gpt.model], [true, { providerID: 'openai', modelID: 'gpt-6-luna' }]);
  // Already on the promoted model: nothing to switch.
  assert.equal(turn({ learning: promoted('claude-opus-5-5') }).reasonCode, 'ALREADY_ON_MODEL');
  // A pinned slice is never switched by a turn.
  const pinned = core.pinSlice(emptyLearningState({ workspaceId: 'w', now: new Date(NOW).toISOString() }), SLICE, 'claude-sonnet-5', new Date(NOW).toISOString(), null, R);
  assert.equal(turn({ learning: pinned }).reasonCode, 'SLICE_PINNED');
});
