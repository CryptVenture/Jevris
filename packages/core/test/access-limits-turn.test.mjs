// Access limits R73 (design access-limits.md E4 and E5, OP-10): route.turn and the subagent route
// check the access-limit record. A paused current scope gets advice only, naming the reset and a
// model that is not paused; a paused target or subagent model is never routed to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const { BUNDLED_MODEL_REGISTRY: R, routeTurn, adviseSubagentRoute, emptyLearningState, learningSliceKey, classifyAccessSignal, recordAccessLimit, readAccessLimits, accessScopeOf, accessQueryFor } = core;

// pinned-clock: every turn and record here runs at this fixed time.
const NOW = Date.parse('2026-09-28T12:00:00Z');
const H = 3_600_000;
const SLICE = 'bounded-edit';
const OPEN = { taskId: 'task-1', risk: 'low', turnActuation: 'bounded-auto', turnReasonCode: null };

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-access-turn-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function promoted(modelId, baseline = 'claude-opus-5-5') {
  const state = emptyLearningState({ workspaceId: 'w-turn', now: new Date(NOW).toISOString() });
  const key = learningSliceKey(SLICE, baseline, R);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: new Date(NOW).toISOString(), reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId, baselineModelId: baseline, baselineRate: 0.9 } }, evidence: null };
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

async function recorded(home, harness, spelling, authMode, signal) {
  const classification = classifyAccessSignal(signal, authMode, NOW);
  const r = await recordAccessLimit({ home, scope: accessScopeOf(R, harness, spelling, authMode), classification, source: 'session', nowMs: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (await readAccessLimits(home)).entries;
}

test('R73 OP-10: a turn whose own scope is paused is advice only, naming the reset and a model that is not paused', async (t) => {
  const home = await tempHome(t);
  // A 402 on the session's Anthropic key through OpenCode: credit exhausted, untimed, the whole host.
  const entries = await recorded(home, 'opencode', 'anthropic/claude-opus-5-5', 'api-key', { port: 'opencode', channel: 'structured', certified: false, errorType: 'APIError', status: 402 });
  const a = turn({ accessLimits: entries, authMode: 'api-key', locallyEligible: ['claude-sonnet-5', 'kimi-k3'] });
  assert.deepEqual([a.outcome, a.actuate, a.mainSession.switched, a.reasonCode], ['abstain', false, false, 'ACCESS_LIMITED']);
  assert.match(a.text, /opencode api-key anthropic is paused: credit-exhausted with no expiry/);
  assert.match(a.text, /kimi-k3 runs here and is not paused/, 'Sonnet shares the paused host, so Kimi is named');
  assert.match(a.text, /Switching is yours/);
  // With nothing else known to run here, it says so.
  assert.match(turn({ accessLimits: entries, authMode: 'api-key' }).text, /no other model is known to be usable here/);
  // An unknown sign-in matches a limit under either; a subscription session is not paused by the key's limit.
  assert.equal(turn({ accessLimits: entries, authMode: null }).reasonCode, 'ACCESS_LIMITED');
  assert.equal(turn({ accessLimits: entries }).reasonCode, 'ACCESS_LIMITED');
  const sub = turn({ accessLimits: entries, authMode: 'subscription' });
  assert.deepEqual([sub.outcome, sub.actuate, sub.reasonCode], ['switch', true, 'PROMOTED_SAVING']);
  // No record: the turn routes as before.
  assert.equal(turn({ accessLimits: [], authMode: 'api-key' }).reasonCode, 'PROMOTED_SAVING');
  // A pin and the kill switch still come first.
  assert.equal(turn({ accessLimits: entries, authMode: 'api-key', modelPin: 'anthropic/claude-opus-5-5' }).reasonCode, 'PIN_RESPECTED');
});

test('R73 E4: a paused target is not switched to; its reset passing lifts it', async (t) => {
  const home = await tempHome(t);
  // A rate limit on Sonnet's model through OpenCode's Anthropic host, reported to reset in 2 minutes.
  const entries = await recorded(home, 'opencode', 'anthropic/claude-sonnet-5', 'api-key', { port: 'opencode', channel: 'structured', certified: false, errorType: 'APIError', status: 429, headers: { 'retry-after': '120' } });
  assert.deepEqual([entries.length, entries[0].scope.modelId], [1, 'claude-sonnet-5'], 'a rate limit is scoped to its model');
  const a = turn({ accessLimits: entries, authMode: 'api-key' });
  assert.deepEqual([a.outcome, a.actuate, a.reasonCode], ['abstain', false, 'ACCESS_LIMITED']);
  assert.match(a.text, /^Not switched: claude-sonnet-5: ACCESS_LIMITED \(opencode api-key anthropic \(claude-sonnet-5\), rate-limit until 2026-09-28T12:02Z\)\. The model stays as it is\.$/);
  // The session's own model (Opus) is not paused by Sonnet's rate limit, so this is not OP-10 advice.
  assert.doesNotMatch(a.text, /Switching is yours/);
  const later = routeTurn({
    harness: 'opencode', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' }, registry: R, learning: promoted('claude-sonnet-5'), sliceId: SLICE, scope: OPEN,
    mainSession: 'plugin-bounded-auto', killSwitchStopped: false, modelPin: null, nowMs: NOW + 3 * 60_000, accessLimits: entries, authMode: 'api-key',
  });
  assert.equal(later.reasonCode, 'PROMOTED_SAVING');
});

test('R73 E5: a subagent route abstains ACCESS_LIMITED when its model is paused on the harness, sign-in and host', () => {
  const learning = (() => {
    const base = emptyLearningState({ workspaceId: 'ws-sub', now: '2026-09-28T00:00:00Z' });
    return { ...base, versions: [...base.versions, { version: 1, parentVersion: 0, createdAt: '2026-09-28T01:00:00Z', reason: 'promotion', reasonCode: 'PROMOTED', sliceId: 'subagent:Explore', slices: { 'subagent:Explore': { mode: 'auto', modelId: 'claude-haiku-5-5', baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }, evidence: null }] };
  })();
  const advise = (extra) => adviseSubagentRoute({ harness: 'claude', subagentType: 'Explore', explicitModel: false, sessionModel: 'claude-opus-5-5', pins: { modelPin: null, effortPin: null }, registry: R, nowMs: NOW, unavailableModels: {}, learning, signedPrior: null, ...extra });
  const entry = (scope, extra = {}) => ({ key: '0123456789abcdef', scope: { harness: 'claude', authMode: 'subscription', servingHost: 'anthropic', modelId: null, family: null, ...scope }, class: 'usage-window', signal: 'claude.stream.rate-limit-event.five-hour', source: 'session', firstSeenMs: NOW - H, lastSeenMs: NOW - H, untilMs: NOW + H, step: 0, weekly: false, resetBasis: 'reported', count: 1, fingerprint: null, ...extra });
  assert.equal(advise({ accessLimits: [entry({})], authMode: 'subscription' }).reasonCode, 'ACCESS_LIMITED');
  // Claude Code's alias is checked as its maker's model: an Opus weekly window leaves Haiku.
  assert.equal(advise({ accessLimits: [entry({ family: 'opus' }, { weekly: true })], authMode: 'subscription' }).outcome, 'propose');
  // Another harness's limit does not pause this one.
  assert.equal(advise({ accessLimits: [entry({ harness: 'codex', servingHost: 'openai' })], authMode: 'subscription' }).outcome, 'propose');
  // On OpenCode the scope is the host the route keeps.
  const oc = { harness: 'opencode', sessionModel: 'anthropic/claude-opus-5-5', locallyEligible: ['claude-haiku-5-5'] };
  assert.equal(advise({ ...oc }).outcome, 'propose');
  assert.equal(advise({ ...oc, accessLimits: [entry({ harness: 'opencode', authMode: 'api-key' })], authMode: 'api-key' }).reasonCode, 'ACCESS_LIMITED');
  assert.equal(advise({ ...oc, accessLimits: [entry({ harness: 'opencode', authMode: 'api-key', servingHost: 'openrouter' })], authMode: 'api-key' }).outcome, 'propose', 'a pause on another host leaves the kept one');
  assert.equal(accessQueryFor(R, 'claude', 'claude-haiku-5-5', 'subscription').servingHost, 'anthropic');
});
