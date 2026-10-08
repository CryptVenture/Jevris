// The worker-creation handler for Claude Code subagent routing (owner decision 9ce2ba5): a route
// `{ model }` only with evidence for the subagent type; otherwise the hook stays silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createDecisionSubscriber, recordsCertificationSource, subagentRouteAdvice, DEFAULT_TRIGGER_HANDLERS } = await import('../dist/index.js');
const core = await import('@jevris/core');
const { HookOutcomeContract } = await import('@jevris/contracts');

// pinned-clock: every event and record here uses this fixed time.
const NOW = Date.parse('2026-09-27T12:00:00Z');
const HAIKU = 'claude-haiku-5-5';
const SECRET = 'SECRET-PROMPT-TEXT-7f3a';
const sha = (text) => createHash('sha256').update(text).digest('hex');
let n = 0;

function agentEvent(payload, { harness = 'claude', model = 'claude-opus-5-5' } = {}) {
  n += 1;
  return {
    schemaVersion: '1.0', harness, nativeEventName: 'PreToolUse', kind: 'tool.proposed', sessionId: 'sess-1', turnId: null, toolUseId: `tu-${n}`, toolName: 'Agent',
    agentId: null, model, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: true, payload: { toolName: 'Agent', ...payload }, dedupKey: sha(`agent-${n}`),
  };
}

function ctx(home, envelope, { signal = new AbortController().signal, pins, traces = [] } = {}) {
  const body = { envelope, deliveryKey: `k-${envelope.dedupKey.slice(0, 8)}`, revision: 'rev-1', harnessVersion: '2.1.0', ...(pins === undefined ? {} : { pins }) };
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-sub', root: home }, body, home, signal,
    deadline: { remainingMs: () => 2000, expired: () => false }, store: null, killSwitchStopped: false, engine: { now: () => NOW }, trace: (t) => traces.push(t),
  };
}

function record(features, harness = 'claude') {
  return {
    id: `cert-${harness}-1`, schemaVersion: '1.0', harness, actuatorId: `${harness}-hooks`, harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: 'FIXTURES_PASSED' })),
    certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', signature: 'sig',
  };
}
const certified = recordsCertificationSource(async () => [record(['hooks.route'])]);
const none = recordsCertificationSource(async () => []);
const subscriber = (certifications) => createDecisionSubscriber({ handlers: { 'worker-creation': [subagentRouteAdvice] }, certifications, now: () => NOW, operatingSystem: 'linux' });

/** Local evidence that Haiku 5.5 ran under Claude Code here (RAN_HERE), the other way a model becomes eligible. */
async function ran(dir) {
  assert.equal(await core.recordModelRun(dir, { harness: 'claude', authMode: 'unknown', modelId: HAIKU, nowMs: NOW, raw: null, servingHost: null, source: 'reported' }), true);
}

async function home(t, { active = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-subagent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (active) {
    const base = core.emptyLearningState({ workspaceId: 'w-sub', now: '2026-09-27T00:00:00Z' });
    const slice = core.subagentSliceId('Explore');
    const state = { ...base, versions: [...base.versions, { version: 1, parentVersion: 0, createdAt: '2026-09-27T01:00:00Z', reason: 'promotion', reasonCode: 'PROMOTED', sliceId: slice, slices: { [slice]: { mode: 'auto', modelId: HAIKU, baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }, evidence: null }] };
    assert.equal((await core.saveLearningState(dir, state)).ok, true);
    assert.equal(core.slicePolicy(await core.loadLearningState({ home: dir, workspaceId: 'w-sub' }), slice).mode, 'auto', 'the fixture state loads as active');
  }
  return dir;
}

test('subagent route: registered for worker-creation; an active learned route for the subagent type is a route { model }, and uncertified it is explain', async (t) => {
  assert.ok(DEFAULT_TRIGGER_HANDLERS['worker-creation'].includes(subagentRouteAdvice));
  const dir = await home(t);
  const traces = [];
  const routed = await subscriber(certified).handle(ctx(dir, agentEvent({ subagentType: 'Explore' }), { traces }));
  assert.equal(routed.trigger, 'worker-creation');
  // Rewrite plus instruct (owner decision 2026-10-08): the route carries the short note for the model.
  assert.deepEqual(routed.hookOutcome, { kind: 'route', model: HAIKU, context: "Jevris set model haiku on this one Agent call (this workspace's route learning for Explore subagents). The session model is unchanged." });
  assert.equal(HookOutcomeContract.validate(routed.hookOutcome).ok, true, 'the proposal meets E\'s wire contract');
  assert.equal(routed.reasonCode, 'SUBAGENT_ROUTE_LEARNED');
  assert.deepEqual(traces.filter((e) => e.event === 'subagent-route').map((e) => e.reasonCode), ['SUBAGENT_ROUTE_LEARNED']);
  // 3f090fa applies to this path too: with hooks.route uncertified the alias proof is off, so the model needs a run on this harness.
  await ran(dir);
  const explained = await subscriber(none).handle(ctx(dir, agentEvent({ subagentType: 'Explore' })));
  assert.equal(explained.hookOutcome.kind, 'explain');
  assert.match(explained.hookOutcome.text, /Explore subagent/);
});

test('subagent route: abstains (the hook stays silent) without evidence, with an explicit model or a pin, on another harness, or when the answer is no longer wanted', async (t) => {
  const dir = await home(t);
  const silent = async (label, context, expectedTrace) => {
    const traces = [];
    const result = await subscriber(certified).handle({ ...context, trace: (e) => traces.push(e) });
    assert.deepEqual(result.hookOutcome, { kind: 'observe' }, label);
    if (expectedTrace !== undefined) assert.deepEqual(traces.filter((e) => e.event === 'subagent-route').map((e) => e.reasonCode), [expectedTrace], label);
    return result;
  };
  await silent('explicit model', ctx(dir, agentEvent({ subagentType: 'Explore', requestedModel: 'opus' })));
  await silent('pinned', ctx(dir, agentEvent({ subagentType: 'Explore' }), { pins: { modelPin: 'claude-opus-5', effortPin: null } }));
  await silent('no subagent type', ctx(dir, agentEvent({})));
  // Owner decision 2026-10-08: no learned evidence for the type, so a high-risk launch (a custom type with a large input) changes nothing.
  await silent('a launch judged high risk', ctx(dir, agentEvent({ subagentType: 'code-reviewer', toolInputBytes: 9000, toolInputKeys: ['description', 'prompt', 'subagent_type'] })), 'RISK_HIGH');
  await silent('the session already runs it', ctx(dir, agentEvent({ subagentType: 'Explore' }, { model: 'haiku' })), 'SAME_AS_SESSION');
  // R20: Antigravity's slice learns under its own baseline, so Claude Code's route is no evidence there.
  await silent('a route learned on another harness', ctx(dir, agentEvent({ subagentType: 'Explore' }, { harness: 'antigravity', model: null })), 'NO_EVIDENCE');
  const ended = new AbortController();
  ended.abort();
  const missed = await silent('slice ended', ctx(dir, agentEvent({ subagentType: 'Explore' }), { signal: ended.signal }));
  assert.equal(missed.reasonCode, 'NO_PROPOSAL');
  // Found gone on this machine: never proposed.
  await core.recordModelUnavailable({ home: dir, modelId: HAIKU, reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'provider-call', nowMs: NOW, registry: core.BUNDLED_MODEL_REGISTRY });
  await silent('found gone', ctx(dir, agentEvent({ subagentType: 'Explore' })), 'MODEL_UNAVAILABLE');
  // A fresh home with no learning state and no signed release for the slice: no evidence.
  const bare = await home(t, { active: false });
  await silent('no evidence and a high-risk launch', ctx(bare, agentEvent({ subagentType: 'code-reviewer', toolInputBytes: 9000, toolInputKeys: ['prompt'] })), 'RISK_HIGH');
});

test('subagent route: prompt text never reaches the answer or the trace, and no learning outcome is recorded', async (t) => {
  const dir = await home(t);
  const traces = [];
  const event = agentEvent({ subagentType: 'Explore', prompt: SECRET, description: SECRET });
  const result = await subscriber(certified).handle(ctx(dir, event, { traces }));
  assert.equal(result.hookOutcome.kind, 'route');
  assert.equal(result.hookOutcome.model, HAIKU);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(traces), new RegExp(SECRET));
  const state = await core.loadLearningState({ home: dir, workspaceId: 'w-sub' });
  assert.deepEqual(state.arms, {}, 'a subagent route feeds no learning outcome');
});

test('P13: each handled launch leaves one text-free note for D\'s SubagentStart record: rendered, explained or abstained with its code', async (t) => {
  core.clearSubagentRouteNotes();
  const dir = await home(t);
  const take = () => core.takeSubagentRoute('w-sub', 'sess-1', 'Explore', NOW + 1000);
  await subscriber(certified).handle(ctx(dir, agentEvent({ subagentType: 'Explore', prompt: SECRET })));
  // R20: the note names the registry model the route set, for D's attribution.
  assert.deepEqual(take(), { reasonCode: 'SUBAGENT_ROUTE_LEARNED', outcome: 'rendered', atMs: NOW, modelId: HAIKU });
  assert.equal(take(), null, 'taken once');
  await ran(dir);
  await subscriber(none).handle(ctx(dir, agentEvent({ subagentType: 'Explore' })));
  assert.equal(take().outcome, 'explained');
  await subscriber(certified).handle(ctx(dir, agentEvent({ subagentType: 'Explore', requestedModel: 'sonnet' })));
  assert.deepEqual(take(), { reasonCode: 'EXPLICIT_MODEL', outcome: 'abstained', atMs: NOW, modelId: null });
  const bare = await home(t, { active: false });
  await subscriber(certified).handle(ctx(bare, agentEvent({ subagentType: 'code-reviewer', toolInputBytes: 9000, toolInputKeys: ['prompt'] })));
  assert.equal(core.takeSubagentRoute('w-sub', 'sess-1', 'code-reviewer', NOW + 1000).outcome, 'abstained');
  // Past the 120 s window a note is gone; another session or type never takes it.
  await subscriber(certified).handle(ctx(dir, agentEvent({ subagentType: 'Explore' })));
  assert.equal(core.takeSubagentRoute('w-sub', 'sess-2', 'Explore', NOW + 1000), null);
  assert.equal(core.takeSubagentRoute('w-sub', 'sess-1', 'Plan', NOW + 1000), null);
  assert.equal(core.takeSubagentRoute('w-sub', 'sess-1', 'Explore', NOW + 121_000), null);
});

test('P13: the note store is bounded and refuses anything that is not an id, a code or an outcome', () => {
  core.clearSubagentRouteNotes();
  const base = { workspaceId: 'w1', sessionId: 's1', subagentType: 'Explore', reasonCode: 'NO_EVIDENCE', outcome: 'abstained', atMs: NOW };
  assert.equal(core.noteSubagentRoute({ ...base, reasonCode: 'free text' }), false);
  assert.equal(core.noteSubagentRoute({ ...base, subagentType: 'has space' }), false);
  assert.equal(core.noteSubagentRoute({ ...base, outcome: 'maybe' }), false);
  // A model id only with a proposal, and only a registry-shaped id.
  assert.equal(core.noteSubagentRoute({ ...base, outcome: 'abstained', modelId: HAIKU }), false);
  assert.equal(core.noteSubagentRoute({ ...base, outcome: 'proposed', modelId: 'not an id' }), false);
  for (let i = 0; i < core.SUBAGENT_NOTE_CAP + 10; i += 1) assert.equal(core.noteSubagentRoute({ ...base, atMs: NOW + i }), true);
  // The oldest ten were dropped: the first one taken is the eleventh.
  assert.equal(core.takeSubagentRoute('w1', 's1', 'Explore', NOW + 300).atMs, NOW + 10);
  core.clearSubagentRouteNotes();
});

test('R20: Codex gets a route in its own id, and OpenCode its provider/model, once that harness\'s hooks.route passes; otherwise explain text', async (t) => {
  const dir = await home(t);
  // A Codex-baseline promotion for the slice (R17 key), next to the Claude Code one.
  const slice = core.subagentSliceId('Explore');
  const key = core.learningSliceKey(slice, 'gpt-6.1-sol', core.BUNDLED_MODEL_REGISTRY);
  const state = await core.loadLearningState({ home: dir, workspaceId: 'w-sub' });
  const last = state.versions[state.versions.length - 1];
  const next = { ...last, version: last.version + 1, parentVersion: last.version, sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId: 'gpt-6-luna', baselineModelId: 'gpt-6.1-sol', baselineRate: 0.9 } } };
  assert.equal((await core.saveLearningState(dir, { ...state, versions: [...state.versions, next] })).ok, true);
  // Owner 3f090fa: the routed models have run on these harnesses (local evidence).
  assert.equal(await core.recordModelRun(dir, { harness: 'codex', authMode: 'unknown', modelId: 'gpt-6-luna', nowMs: NOW }), true);
  assert.equal(await core.recordModelRun(dir, { harness: 'opencode', authMode: 'unknown', modelId: HAIKU, nowMs: NOW }), true);
  const codexEvent = () => ({ ...agentEvent({ subagentType: 'Explore', toolName: 'spawn_agent' }, { harness: 'codex', model: 'gpt-6.1-sol' }), toolName: 'spawn_agent' });
  const codexCertified = recordsCertificationSource(async () => [record(['hooks.route'], 'codex')]);
  const routed = await subscriber(codexCertified).handle(ctx(dir, codexEvent()));
  assert.deepEqual(routed.hookOutcome, { kind: 'route', model: 'gpt-6-luna' });
  assert.equal(HookOutcomeContract.validate(routed.hookOutcome).ok, true);
  // Owner decision 43cb54c: a learned Codex effort is stated, never carried: the route sets the model only.
  const withEffort = await core.loadLearningState({ home: dir, workspaceId: 'w-sub' });
  const top = withEffort.versions[withEffort.versions.length - 1];
  const high = { ...top, version: top.version + 1, parentVersion: top.version, slices: { ...top.slices, [key]: { ...top.slices[key], effort: 'xhigh' } } };
  assert.equal((await core.saveLearningState(dir, { ...withEffort, versions: [...withEffort.versions, high] })).ok, true);
  const traced = [];
  const varied = await subscriber(codexCertified).handle(ctx(dir, codexEvent(), { traces: traced }));
  assert.deepEqual(varied.hookOutcome, { kind: 'route', model: 'gpt-6-luna' });
  assert.deepEqual(traced.filter((e) => e.event === 'subagent-route').map((e) => e.effortNotApplied), ['xhigh']);
  const told = await subscriber(none).handle(ctx(dir, codexEvent()));
  assert.match(told.hookOutcome.text, /learned effort is xhigh; the route sets the model only/);
  assert.equal(HookOutcomeContract.validate(varied.hookOutcome).ok, true);
  // Claude Code's certification does not certify Codex: explain.
  assert.equal((await subscriber(certified).handle(ctx(dir, codexEvent()))).hookOutcome.kind, 'explain');
  // OpenCode names the Claude Code route as provider/model (E b250627 widened the wire for it).
  const opencodeCertified = recordsCertificationSource(async () => [record(['hooks.route'], 'opencode')]);
  const ocEvent = () => ({ ...agentEvent({ subagentType: 'Explore', toolName: 'task' }, { harness: 'opencode', model: 'anthropic/claude-opus-5-5' }), toolName: 'task' });
  const oc = await subscriber(opencodeCertified).handle(ctx(dir, ocEvent()));
  assert.deepEqual(oc.hookOutcome, { kind: 'route', model: 'anthropic/claude-haiku-5-5' });
  assert.equal(HookOutcomeContract.validate(oc.hookOutcome).ok, true);
  const unc = await subscriber(none).handle(ctx(dir, ocEvent()));
  assert.equal(unc.hookOutcome.kind, 'explain');
  assert.match(unc.hookOutcome.text, /anthropic\/claude-haiku-5-5/);
});

test('R51: an OpenCode subagent keeps the parent\'s gateway; applied only with route.host from the sidecar, otherwise explain', async (t) => {
  const dir = await home(t, { active: false });
  // A Plan-subagent promotion to GLM-5.3 under OpenCode's baseline key.
  const slice = core.subagentSliceId('Plan');
  const key = core.subagentLearningKey('Plan', 'opencode', core.BUNDLED_MODEL_REGISTRY);
  const base = core.emptyLearningState({ workspaceId: 'w-sub', now: '2026-09-27T00:00:00Z' });
  const state = { ...base, versions: [...base.versions, { version: 1, parentVersion: 0, createdAt: '2026-09-27T01:00:00Z', reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { [key]: { mode: 'auto', modelId: 'glm-5.3', baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }, evidence: null }] };
  assert.equal((await core.saveLearningState(dir, state)).ok, true);
  assert.ok(slice !== null);
  // OpenCode lists GLM-5.3 through OpenRouter (the offer keeps the spelling and its host).
  assert.equal(await core.recordModelListing(dir, { harness: 'opencode', authMode: 'api-key', result: { ok: true, version: null, models: ['glm-5.3'], spellings: [{ raw: 'openrouter/z-ai/glm-5.3', modelId: 'glm-5.3', servingHost: 'openrouter' }] }, nowMs: NOW }), true);
  const ocEvent = () => ({ ...agentEvent({ subagentType: 'Plan', toolName: 'task' }, { harness: 'opencode', model: 'openrouter/moonshotai/kimi-k3' }), toolName: 'task' });
  // Makers granted; OpenRouter is the parent's own host, so it is signed in (OQ-3).
  const providerConsent = (party) => (party === 'openrouter' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true });
  const withHost = (envelope, hostRouteCertified) => {
    const c = ctx(dir, envelope);
    return { ...c, engine: { ...c.engine, providerConsent }, body: { ...c.body, ...(hostRouteCertified === undefined ? {} : { hostRouteCertified }) } };
  };
  const opencodeCertified = recordsCertificationSource(async () => [record(['hooks.route'], 'opencode')]);
  const routed = await subscriber(opencodeCertified).handle(withHost(ocEvent(), true));
  assert.deepEqual(routed.hookOutcome, { kind: 'route', model: 'openrouter/z-ai/glm-5.3' }, JSON.stringify(routed));
  assert.equal(HookOutcomeContract.validate(routed.hookOutcome).ok, true);
  // Without the sidecar's route.host answer (or with it false), the proposal is explained only.
  for (const flag of [undefined, false]) {
    const explained = await subscriber(opencodeCertified).handle(withHost(ocEvent(), flag));
    assert.equal(explained.hookOutcome.kind, 'explain', String(flag));
    assert.match(explained.hookOutcome.text, /Not applied \(ROUTE_HOST_NOT_CERTIFIED\)/);
  }
  // A revoked gateway is never used for the child.
  const revoked = (party) => (party === 'openrouter' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_REVOKED' } : { granted: true });
  const c = withHost(ocEvent(), true);
  const blocked = await subscriber(opencodeCertified).handle({ ...c, engine: { ...c.engine, providerConsent: revoked } });
  assert.deepEqual(blocked.hookOutcome, { kind: 'observe' }, JSON.stringify(blocked));
});

test('F\'s 057e8553: a task tool model the adapter kept as bedrock-arn or unreadable-model is the user\'s explicit choice: never routed', async (t) => {
  const dir = await home(t);
  for (const requestedModel of ['bedrock-arn', 'unreadable-model']) {
    const traces = [];
    const answer = await subscriber(certified).handle(ctx(dir, agentEvent({ subagentType: 'Explore', requestedModel }), { traces }));
    assert.deepEqual(answer.hookOutcome, { kind: 'observe' }, requestedModel);
    assert.deepEqual(traces.filter((e) => e.event === 'subagent-route'), [], 'abstained before any route was worked out');
  }
  // A Bedrock ARN session model: its host is unknown, so the subagent is not routed either.
  const traces = [];
  const arn = await subscriber(certified).handle(ctx(dir, agentEvent({ subagentType: 'Explore' }, { model: 'bedrock-arn' }), { traces }));
  assert.deepEqual(arn.hookOutcome, { kind: 'observe' });
  assert.deepEqual(traces.filter((e) => e.event === 'subagent-route').map((e) => e.reasonCode), ['HOST_UNKNOWN']);
});
