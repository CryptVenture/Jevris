// Tiered routing, step 2b (owner decisions 2026-10-08): the subagent hook on every harness. With no learned or signed evidence,
// the launch goes to the session model's own provider's rung: down by the launch's risk, and (a write-capable launch only) UP
// when the session's own work was judged step-up. The hook makes no Jev call for the tier: it reads the per-session memo.
// Temporary homes, stub certifications, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { HookOutcomeContract } = await import('@jevris/contracts');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const PROMPT = 'PROMPT-TEXT-REWRITE-THE-BILLING-MODULE-5d1c';
const DESCRIPTION = 'DESCRIPTION-TEXT-9e2a';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const WS = 'w-tier';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-subtier-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  core.clearSessionTierMemos();
  t.after(() => core.clearSessionTierMemos());
  return dir;
}

let n = 0;
function agentEvent(payload, { harness = 'claude', model = 'claude-sonnet-5-5', toolName = harness === 'claude' ? 'Agent' : harness === 'codex' ? 'spawn_agent' : 'task', sessionId = 'sess-tier' } = {}) {
  n += 1;
  return {
    schemaVersion: '1.0', harness, nativeEventName: 'PreToolUse', kind: 'tool.proposed', sessionId, turnId: null, toolUseId: `tu-${n}`, toolName,
    agentId: null, model, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: true, payload: { toolName, toolInputKeys: ['description', 'prompt', 'subagent_type'], ...payload }, dedupKey: sha(`tier-${n}`),
  };
}

function ctx(dir, envelope, { mode = 'bounded-auto', traces = [], engine } = {}) {
  const body = { envelope, deliveryKey: `k-${envelope.dedupKey.slice(0, 8)}`, revision: 'rev-1', harnessVersion: '2.1.0' };
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: WS, root: dir }, body, home: dir, signal: new AbortController().signal,
    deadline: { budgetMs: 900, remainingMs: () => 2000, expired: () => false }, store: null, killSwitchStopped: false, engine, trace: (e) => traces.push(e), mode,
  };
}

function record(features, harness) {
  return {
    id: `cert-${harness}-1`, schemaVersion: '1.0', harness, actuatorId: `${harness}-hooks`, harnessVersionRange: { minimum: '0.0.1', maximumExclusive: '99.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: 'FIXTURES_PASSED' })),
    certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', signature: 'sig',
  };
}
const certifiedFor = (...harnesses) => provider.recordsCertificationSource(async () => harnesses.map((h) => record(['hooks.route', 'hooks.context'], h)));
const subscriber = (certifications) => provider.createDecisionSubscriber({ handlers: { 'worker-creation': [provider.subagentRouteAdvice] }, certifications, now: () => NOW, operatingSystem: 'linux' });

const EXPLORE = { subagentType: 'Explore', toolInputBytes: 600 };
const GENERAL = { subagentType: 'general-purpose', toolInputBytes: 500 };
const memo = (over = {}) => ({ tier: 'step-up', targetModelId: 'claude-opus-5-5', baselineModelId: 'claude-sonnet-5-5', basis: 'tier-rule', reasonCodes: ['TIER_PROTECTED_PATH', 'TIER_MIGRATION'], atMs: NOW, ...over });

/** An engine stand-in with no provider: any request to Jev (decide, an ask) is counted; the local advisory record is not a request. The subagent hook must make none for the tier. */
function countingEngine() {
  const calls = [];
  const count = (name) => () => (calls.push(name), Promise.reject(new Error('no call expected')));
  const engine = { providerConfigured: false, now: () => NOW, decide: count('decide'), askBounded: count('askBounded'), recordAdvice: async () => ({ ok: false }), lookup: count('lookup') };
  return { engine, calls };
}

test('Claude Code, a Sonnet session: Explore goes to haiku; with a step-up memo a write-capable launch goes up to opus (exact route outcome); no Jev call, no text', async (t) => {
  const dir = home(t);
  const { engine, calls } = countingEngine();
  const traces = [];
  const down = await subscriber(certifiedFor('claude')).handle(ctx(dir, agentEvent({ ...EXPLORE, prompt: PROMPT, description: DESCRIPTION }), { engine, traces }));
  assert.deepEqual(down.hookOutcome, { kind: 'route', model: 'claude-haiku-5-5', context: 'Jevris set model haiku on this one Agent call (read-only type, low risk by rules). The session model is unchanged.' });
  // No memo: a write-capable launch changes nothing.
  const kept = await subscriber(certifiedFor('claude')).handle(ctx(dir, agentEvent({ ...GENERAL, prompt: PROMPT }), { engine }));
  assert.equal(kept.hookOutcome.kind, 'observe');
  // The session's work was judged step-up (memo written by the main-session tier): up, for write-capable launches only.
  assert.equal(core.noteSessionTier(WS, 'sess-tier', memo()), true);
  const up = await subscriber(certifiedFor('claude')).handle(ctx(dir, agentEvent({ ...GENERAL, prompt: PROMPT, description: DESCRIPTION }), { engine, traces }));
  assert.deepEqual(up.hookOutcome, {
    kind: 'route',
    model: 'claude-opus-5-5',
    context: "Jevris set model opus on this one Agent call (the session's work was judged very hard by the tier rules (TIER_PROTECTED_PATH, TIER_MIGRATION); a rules-based default, not a learned route and not a signed prior). The session model is unchanged.",
  });
  assert.equal(HookOutcomeContract.validate(up.hookOutcome).ok, true);
  assert.equal(up.reasonCode, 'SUBAGENT_ROUTE_TIER_UP');
  assert.equal(up.certified, true);
  const custom = await subscriber(certifiedFor('claude')).handle(ctx(dir, agentEvent({ subagentType: 'code-reviewer', toolInputBytes: 300 }), { engine }));
  assert.deepEqual([custom.hookOutcome.kind, custom.hookOutcome.model], ['route', 'claude-opus-5-5']);
  // A read-only launch still goes down under a step-up session, never up.
  const explore = await subscriber(certifiedFor('claude')).handle(ctx(dir, agentEvent(EXPLORE), { engine }));
  assert.deepEqual([explore.hookOutcome.kind, explore.hookOutcome.model], ['route', 'claude-haiku-5-5']);
  assert.deepEqual(calls, [], 'the hook asked the engine for nothing');
  assert.doesNotMatch(JSON.stringify([up, traces]), /PROMPT-TEXT|DESCRIPTION-TEXT/, 'no prompt or description text anywhere');
});

test('Claude Code gates for a route up: advise gives context, observe nothing, uncertified explains, a pin or explicit model or an expired or other-baseline memo changes nothing', async (t) => {
  const dir = home(t);
  const { engine } = countingEngine();
  core.noteSessionTier(WS, 'sess-tier', memo());
  const run = (certs, mode, payload = GENERAL, extra = {}) => subscriber(certs).handle(ctx(dir, agentEvent(payload, extra.event), { engine, mode }));
  const advised = await run(certifiedFor('claude'), 'advise');
  assert.equal(advised.hookOutcome.kind, 'context');
  assert.match(advised.hookOutcome.text, /^Jevris advises model: opus for this general-purpose subagent/);
  assert.equal((await run(certifiedFor('claude'), 'observe')).hookOutcome.kind, 'observe');
  // hooks.route not certified: the alias proof is off, so Opus is not eligible out of the box.
  const none = provider.recordsCertificationSource(async () => []);
  assert.equal((await run(none, 'bounded-auto')).hookOutcome.kind, 'observe');
  assert.equal((await run(certifiedFor('claude'), 'bounded-auto', { ...GENERAL, requestedModel: 'sonnet' })).hookOutcome.kind, 'observe', 'an explicit model stands');
  // A session already on Opus has no step up from its tier.
  assert.equal((await run(certifiedFor('claude'), 'bounded-auto', GENERAL, { event: { model: 'claude-opus-5-5' } })).hookOutcome.kind, 'observe');
  // A memo judged against another baseline is not used: the session now runs a model the memo never saw.
  core.noteSessionTier(WS, 'sess-tier', memo({ baselineModelId: 'claude-haiku-5-5' }));
  assert.equal((await run(certifiedFor('claude'), 'bounded-auto')).hookOutcome.kind, 'observe');
  // An expired memo is not read.
  core.noteSessionTier(WS, 'sess-tier', memo({ atMs: NOW - core.SESSION_TIER_MEMO_TTL_MS - 1000 }));
  assert.equal((await run(certifiedFor('claude'), 'bounded-auto')).hookOutcome.kind, 'observe');
});

test('Codex: an OpenAI session goes to that provider\'s cheaper rung as a Codex model id with local evidence, and is dormant without it', async (t) => {
  const dir = home(t);
  const { engine, calls } = countingEngine();
  const event = (payload) => agentEvent(payload, { harness: 'codex', model: 'gpt-6.1-sol' });
  const run = (payload) => subscriber(certifiedFor('codex')).handle(ctx(dir, event(payload), { engine }));
  // No local evidence on this harness: dormant (the Codex route needs a run or a listing first).
  assert.equal((await run(EXPLORE)).hookOutcome.kind, 'observe', 'dormant without evidence');
  for (const modelId of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']) assert.equal(await core.recordModelRun(dir, { harness: 'codex', authMode: 'unknown', modelId, nowMs: NOW }), true);
  const down = await run(EXPLORE);
  assert.deepEqual(down.hookOutcome, { kind: 'route', model: 'gpt-6-luna' });
  assert.equal(HookOutcomeContract.validate(down.hookOutcome).ok, true);
  assert.equal(down.reasonCode, 'SUBAGENT_ROUTE_RISK_RULE');
  // Codex rungs are the models with their own Codex preset row; the session's tier memo raises a write-capable launch.
  assert.equal((await run(GENERAL)).hookOutcome.kind, 'observe');
  core.noteSessionTier(WS, 'sess-tier', memo({ baselineModelId: 'gpt-6.1-sol', targetModelId: 'gpt-6-astra' }));
  const up = await run({ ...GENERAL, prompt: PROMPT });
  assert.deepEqual(up.hookOutcome, { kind: 'route', model: 'gpt-6-astra' });
  assert.equal(up.reasonCode, 'SUBAGENT_ROUTE_TIER_UP');
  // Never Anthropic: the OpenAI session's rungs are OpenAI's.
  assert.doesNotMatch(JSON.stringify([down, up]), /claude/);
  // Codex's own certification decides whether it is applied: another harness's does not count.
  const told = await subscriber(certifiedFor('claude')).handle(ctx(dir, event(GENERAL), { engine }));
  assert.equal(told.hookOutcome.kind, 'explain');
  assert.match(told.hookOutcome.text, /gpt-6-astra/);
  assert.deepEqual(calls, []);
});

test('Kilo and OpenCode: an OpenAI session keeps its provider (and an Anthropic one its own), dormant without local evidence, never a session model Jevris does not know', async (t) => {
  for (const harness of ['kilocode', 'opencode']) {
    const dir = home(t);
    const { engine, calls } = countingEngine();
    const run = (payload, model) => subscriber(certifiedFor(harness)).handle(ctx(dir, agentEvent(payload, { harness, model }), { engine }));
    // OpenAI session: dormant without local evidence, then Luna below and (memo) Astra above, as openai/<id>.
    assert.equal((await run(EXPLORE, 'openai/gpt-6.1-sol')).hookOutcome.kind, 'observe', `${harness} dormant without evidence`);
    for (const modelId of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']) assert.equal(await core.recordModelRun(dir, { harness, authMode: 'unknown', modelId, nowMs: NOW }), true);
    const down = await run(EXPLORE, 'openai/gpt-6.1-sol');
    assert.deepEqual(down.hookOutcome, { kind: 'route', model: 'openai/gpt-6-luna' }, harness);
    core.noteSessionTier(WS, 'sess-tier', memo({ baselineModelId: 'gpt-6.1-sol', targetModelId: 'gpt-6-astra' }));
    const up = await run(GENERAL, 'openai/gpt-6.1-sol');
    assert.deepEqual(up.hookOutcome, { kind: 'route', model: 'openai/gpt-6-astra' }, harness);
    assert.equal(HookOutcomeContract.validate(up.hookOutcome).ok, true);
    // An Anthropic session on the same harness goes to Anthropic rungs only.
    assert.equal(await core.recordModelRun(dir, { harness, authMode: 'unknown', modelId: 'claude-sonnet-5-5', nowMs: NOW }), true);
    assert.equal(await core.recordModelRun(dir, { harness, authMode: 'unknown', modelId: 'claude-haiku-5-5', nowMs: NOW }), true);
    core.clearSessionTierMemos();
    const anthropic = await run(EXPLORE, 'anthropic/claude-sonnet-5-5');
    assert.deepEqual(anthropic.hookOutcome, { kind: 'route', model: 'anthropic/claude-haiku-5-5' }, harness);
    // A session model Jevris does not know has no baseline, so no route (never Claude's).
    assert.equal((await run(EXPLORE, 'openai/some-future-model')).hookOutcome.kind, 'observe');
    assert.deepEqual(calls, []);
  }
});

test('Antigravity: the Google ladder has no rung a tier away, so the hook stays silent; there is no actuator to apply a route anyway', async (t) => {
  const dir = home(t);
  const { engine } = countingEngine();
  for (const modelId of ['gemini-3.8-flash', 'gemini-3.7-flash']) assert.equal(await core.recordModelRun(dir, { harness: 'antigravity', authMode: 'unknown', modelId, nowMs: NOW }), true);
  core.noteSessionTier(WS, 'sess-tier', memo({ baselineModelId: 'gemini-3.8-flash', targetModelId: 'gemini-3.8-flash' }));
  const result = await subscriber(certifiedFor('antigravity')).handle(ctx(dir, agentEvent(EXPLORE, { harness: 'antigravity', model: 'gemini-3.8-flash', toolName: 'subagent' }), { engine }));
  assert.equal(result.hookOutcome.kind, 'observe');
  assert.equal(core.SUBAGENT_ROUTE_ACTUATORS.antigravity, null, 'advice text only, by the actuator table');
});

test('the Jev-lowering rule for write-capable types works on the Sonnet baseline (low goes to haiku, medium has no rung), and a step-up session never spends the question', async (t) => {
  const { trackEngine } = await import('./engine-settle.mjs');
  const dir = home(t);
  const requests = [];
  let answer = 'low';
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const keys = Object.keys(q.criteria);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === answer ? 0.9 : 0.1 / (keys.length - 1)]));
      answers[id] = { type: 'choice', choice: answer, probabilities, confidence: 0.9 };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const engine = await provider.createSidecarEngine({ home: dir, credential: 'test-key-not-a-secret', fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  const tracker = trackEngine(engine);
  t.after(() => tracker.settled());
  const run = (payload) => subscriber(certifiedFor('claude')).handle(ctx(dir, agentEvent({ ...payload, prompt: PROMPT }), { engine }));
  const low = await run(GENERAL);
  assert.deepEqual([low.hookOutcome.kind, low.hookOutcome.model, low.reasonCode], ['route', 'claude-haiku-5-5', 'SUBAGENT_ROUTE_RISK_JEV']);
  assert.equal(requests.length, 1);
  answer = 'medium';
  core.clearSessionTierMemos();
  const medium = await run({ subagentType: 'code-reviewer', toolInputBytes: 700 });
  assert.equal(medium.hookOutcome.kind, 'observe', 'a Sonnet session has no mid rung to send a medium launch to');
  // A step-up session: write-capable goes up with no question asked, whatever Jev would have said.
  const before = requests.length;
  core.noteSessionTier(WS, 'sess-tier', memo({ atMs: Date.now() })); // the real engine's own clock
  const up = await run({ subagentType: 'general-purpose', toolInputBytes: 650 });
  assert.deepEqual([up.hookOutcome.kind, up.hookOutcome.model], ['route', 'claude-opus-5-5']);
  assert.equal(requests.length, before, 'no question for a launch the tier sends up');
  assert.equal(JSON.stringify(requests).includes('PROMPT-TEXT'), false, 'the brief never reached Jev');
});
