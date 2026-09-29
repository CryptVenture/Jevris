// OD-8: the route.turn op. The approved scope and the main-session mode come only from the
// sidecar's turnContext, never from the request; the answer matches E's contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');

function ctx(home, body, extra = {}) {
  return {
    op: 'route.turn', client: 'hook', scopes: ['status', 'advice', 'checkpoint'], workspace: { id: 'w-turn-op', root: null }, body, home,
    signal: new AbortController().signal, deadline: createDeadline(900), store: undefined, killSwitchStopped: false, engine: undefined, trace() {}, ...extra,
  };
}

test('route.turn: a malformed request, or one that claims a scope or a mode, is refused', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-turn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const op = provider.createRouteTurnOp(() => ({ scope: null, mainSession: 'plugin-bounded-auto' }));
  assert.deepEqual([op.op, op.scope, op.budget], ['route.turn', 'advice', 'hot']);
  const base = { harness: 'opencode', sessionId: 'ses_1', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' } };
  for (const body of [null, { ...base, harness: 'claude' }, { ...base, sessionId: 'bad id' }, { ...base, current: { providerID: 'Anthropic!', modelID: 'x' } }, { ...base, scope: { approvedScope: { turnActuation: 'bounded-auto' } } }, { ...base, mainSession: 'plugin-bounded-auto' }]) {
    assert.equal((await op.handle(ctx(home, body))).reasonCode, 'INVALID_REQUEST', JSON.stringify(body));
  }
});

test('route.turn: with no learning it abstains, under the mode the sidecar names; a throwing context is advice only', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-turn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const seen = [];
  const op = provider.createRouteTurnOp((c, sessionId, harness) => (seen.push([sessionId, harness]), { scope: { taskId: 't', risk: 'low', sliceId: 'bounded-edit', turnActuation: 'bounded-auto', turnReasonCode: null }, mainSession: 'plugin-bounded-auto' }));
  const answer = await op.handle(ctx(home, { harness: 'kilocode', sessionId: 'ses_2', messageId: 'msg_1', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' }, sliceId: 'other-slice' }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(contracts.RouteTurnPayloadContract.validate(answer.body).ok, true);
  assert.deepEqual([answer.body.outcome, answer.body.actuate, answer.body.reasonCode, answer.body.mainSession.mode], ['abstain', false, 'NO_PROMOTED_SLICE', 'plugin-bounded-auto']);
  assert.deepEqual(seen, [['ses_2', 'kilocode']]);
  // LOW 11: the slice is the approved scope's; the request's sliceId is ignored.
  const noSlice = provider.createRouteTurnOp(() => ({ scope: { taskId: 't', risk: 'low', turnActuation: 'bounded-auto', turnReasonCode: null }, mainSession: 'plugin-bounded-auto' }));
  const ignored = await noSlice.handle(ctx(home, { harness: 'opencode', sessionId: 'ses_4', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' }, sliceId: 'bounded-edit' }));
  assert.deepEqual([ignored.body.outcome, ignored.body.reasonCode], ['abstain', 'UNKNOWN_SLICE']);
  const broken = provider.createRouteTurnOp(() => { throw new Error('no store'); });
  const advice = await broken.handle(ctx(home, { harness: 'opencode', sessionId: 'ses_3', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' } }));
  assert.deepEqual([advice.body.outcome, advice.body.mainSession.mode], ['abstain', 'advice-only']);
});

test('8c1f85d: route.turn writes another provider\'s model only through a host seen on this harness (the model listing)', async (t) => {
  const core = await import('@jevris/core');
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-turn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const state = core.emptyLearningState({ workspaceId: 'w-turn-op', now: at });
  const key = core.learningSliceKey('bounded-edit', 'claude-opus-5-5', core.BUNDLED_MODEL_REGISTRY);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: at, reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId: 'gpt-6-luna', baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }, evidence: null };
  assert.deepEqual(await core.saveLearningState(home, { ...state, versions: [...state.versions, version] }), { ok: true });
  // R50: another maker's endpoint changes the session's host, which acts only with route.host
  // certified; the sidecar's turn context says so (the plugin cannot).
  let certified = true;
  const op = provider.createRouteTurnOp(() => ({ scope: { taskId: 't', risk: 'low', sliceId: 'bounded-edit', turnActuation: 'bounded-auto', turnReasonCode: null }, mainSession: 'plugin-bounded-auto', hostRouteCertified: certified }));
  const consenting = { providerConsent: () => ({ granted: true }) };
  const body = { harness: 'opencode', sessionId: 'ses_host', current: { providerID: 'anthropic', modelID: 'claude-opus-5-5' } };
  const unseen = await op.handle(ctx(home, body, { engine: consenting }));
  assert.deepEqual([unseen.body.outcome, unseen.body.reasonCode, unseen.body.actuate], ['abstain', 'NOT_ON_SESSION_HOST', false], JSON.stringify(unseen.body));
  // OpenCode lists GPT-6 Luna (under its one spelling, openai): now the host is known here.
  assert.equal(await core.recordModelListing(home, { harness: 'opencode', authMode: 'api-key', result: { ok: true, version: null, models: ['gpt-6-luna'] }, nowMs: Date.now() }), true);
  const seen = await op.handle(ctx(home, body, { engine: consenting }));
  assert.deepEqual([seen.body.outcome, seen.body.actuate, seen.body.model], ['switch', true, { providerID: 'openai', modelID: 'gpt-6-luna' }], JSON.stringify(seen.body));
  certified = false;
  const advice = await op.handle(ctx(home, body, { engine: consenting }));
  assert.deepEqual([advice.body.outcome, advice.body.actuate, advice.body.reasonCode], ['switch', false, 'ROUTE_HOST_NOT_CERTIFIED'], JSON.stringify(advice.body));
});

test('R50: route.turn routes a gateway session through its gateway from the spellings the model offer saw, with route.host from the turn context', async (t) => {
  const core = await import('@jevris/core');
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-turn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const state = core.emptyLearningState({ workspaceId: 'w-turn-op', now: at });
  const key = core.learningSliceKey('bounded-edit', 'kimi-k3', core.BUNDLED_MODEL_REGISTRY);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: at, reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId: 'glm-5.3', baselineModelId: 'kimi-k3', baselineRate: 0.9 } }, evidence: null };
  assert.deepEqual(await core.saveLearningState(home, { ...state, versions: [...state.versions, version] }), { ok: true });
  let certified = true;
  const op = provider.createRouteTurnOp(() => ({ scope: { taskId: 't', risk: 'low', sliceId: 'bounded-edit', turnActuation: 'bounded-auto', turnReasonCode: null }, mainSession: 'plugin-bounded-auto', hostRouteCertified: certified }));
  // Makers granted; the gateway is the session's own host, so it is signed in (OQ-3).
  const consenting = { providerConsent: (party) => (party === 'openrouter' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true }) };
  const body = { harness: 'opencode', sessionId: 'ses_gateway', current: { providerID: 'openrouter', modelID: 'moonshotai/kimi-k3' } };
  const unseen = await op.handle(ctx(home, body, { engine: consenting }));
  assert.deepEqual([unseen.body.outcome, unseen.body.reasonCode], ['abstain', 'NOT_ON_SESSION_HOST'], JSON.stringify(unseen.body));
  // OpenCode lists GLM-5.3 through OpenRouter: the offer keeps that spelling and its host.
  assert.equal(await core.recordModelListing(home, { harness: 'opencode', authMode: 'api-key', result: { ok: true, version: null, models: ['glm-5.3'], spellings: [{ raw: 'openrouter/z-ai/glm-5.3', modelId: 'glm-5.3', servingHost: 'openrouter' }] }, nowMs: Date.now() }), true);
  const seen = await op.handle(ctx(home, body, { engine: consenting }));
  assert.deepEqual([seen.body.outcome, seen.body.actuate, seen.body.model], ['switch', true, { providerID: 'openrouter', modelID: 'z-ai/glm-5.3' }], JSON.stringify(seen.body));
  certified = false;
  const advice = await op.handle(ctx(home, body, { engine: consenting }));
  assert.deepEqual([advice.body.actuate, advice.body.reasonCode], [false, 'ROUTE_HOST_NOT_CERTIFIED']);
});
