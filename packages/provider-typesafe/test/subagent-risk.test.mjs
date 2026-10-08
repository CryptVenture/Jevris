// Owner decision 2026-10-08 (reverses 9ce2ba5's abstain-only line for Claude Code): one subagent launch is judged
// low, medium or high risk from content-free features (the type class and the tool-input size). A read-only built-in is
// settled by the rules; a write-capable type (general-purpose or custom) is HIGH by the rules, and only one bounded Jev
// answer at the floors may lower it (owner review: the one question where Jev lowers). A low-risk launch goes to the
// haiku family and a medium one to the sonnet family for that one Agent call, advised or applied by mode and certification. Scripted fetch, temporary
// homes, stub certifications, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { HookOutcomeContract } = await import('@jevris/contracts');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const PROMPT = 'PROMPT-TEXT-REWRITE-THE-BILLING-MODULE-5d1c';
const DESCRIPTION = 'DESCRIPTION-TEXT-9e2a';
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A scripted Jev: `answer(id, question)` gives `{ choice, probabilities }`; every request body is recorded. */
function scriptedFetch(answer, { status = 200 } = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status, headers: { 'content-type': 'application/json' } });
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const want = answer(id, q, body) ?? {};
      const keys = Object.keys(q.criteria);
      const given = want.probabilities ?? { [want.choice ?? keys[0]]: 0.9 };
      const rest = keys.filter((k) => !(k in given));
      const left = 1 - Object.values(given).reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / rest.length) * 10000) / 10000]));
      const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
      answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, answer, options) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-risk-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const script = scriptedFetch(answer, options);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests };
}

const CTX = { workspaceId: 'w-risk', evidenceRevision: 'rev-1', deadlineMs: 30_000 };
const JEV_HIGH = () => ({ choice: 'high', probabilities: { high: 0.85 } });
const JEV_LOW = () => ({ choice: 'low', probabilities: { low: 0.9 } });
const JEV_MEDIUM = () => ({ choice: 'medium', probabilities: { medium: 0.9 } });
const features = (subagentType, toolInputBytes, toolInputKeys = 3) => core.subagentRiskFeatures({ subagentType, toolInputBytes, toolInputKeys });

test('the rules: a read-only built-in is low risk (medium when large); a write-capable type is high whatever its size', () => {
  const level = (type, bytes) => core.rulesSubagentRisk(features(type, bytes));
  for (const type of ['Explore', 'Plan', 'explore', 'PLAN']) assert.equal(level(type, 600), 'low', type);
  assert.equal(level('Explore', 3000), 'low');
  assert.equal(level('Explore', 5000), 'medium', 'a long brief for a read-only type is real work');
  assert.equal(level('Explore', null), 'medium', 'an unknown size reads as large');
  // Never routed on size alone: a general-purpose or custom type may edit.
  for (const type of ['general-purpose', 'code-reviewer', 'my-agent', undefined, '']) for (const bytes of [0, 500, 1500, 9000, null]) assert.equal(level(type, bytes), 'high', `${String(type)} ${String(bytes)}`);
  // Only the write-capable classes ask Jev, at any size; a read-only type is never asked.
  assert.deepEqual(core.SUBAGENT_CLASSES, ['read-only', 'general-purpose', 'custom']);
  for (const bytes of [600, 5000, null]) assert.equal(core.subagentRiskNeedsJev(features('Explore', bytes)), false, 'a read-only type is never asked, even at medium');
  for (const type of ['general-purpose', 'code-reviewer']) for (const bytes of [500, 9000]) assert.equal(core.subagentRiskNeedsJev(features(type, bytes)), true);
});

test('the features are content-free: a class, a size bucket and a key count, whatever else the event carried', () => {
  const f = core.subagentRiskFeatures({ subagentType: 'Explore', toolInputBytes: 600, toolInputKeys: 3, prompt: PROMPT, description: DESCRIPTION });
  assert.deepEqual(f, { subagentClass: 'read-only', size: 'small', keys: 3 });
  assert.deepEqual(Object.keys(f).sort(), ['keys', 'size', 'subagentClass']);
  assert.equal(JSON.stringify(f).includes('PROMPT-TEXT'), false);
  // An unlisted type name reduces to the class `custom`: its text goes nowhere.
  assert.equal(JSON.stringify(core.subagentRiskFeatures({ subagentType: 'secret-internal-agent-name', toolInputBytes: 10 })).includes('secret'), false);
});

test('Jev is asked one Choice from features only; at the floors it may lower the rules\' high, and the decision is recorded', async (t) => {
  const { engine, requests } = await setup(t, JEV_LOW);
  const j = await core.judgeSubagentRisk(engine, features('general-purpose', 500), CTX, { assist: 'classify' });
  assert.deepEqual([j.level, j.source, j.rulesLevel, j.jevLevel, j.asked, j.reasonCode], ['low', 'jev', 'high', 'low', true, 'SUBAGENT_RISK_JEV_LOWERED']);
  assert.equal(requests.length, 1);
  const body = requests[0];
  assert.deepEqual(Object.keys(body.questions), ['risk']);
  assert.deepEqual(Object.keys(body.questions.risk.criteria), ['low', 'medium', 'high', 'unknown']);
  const text = JSON.stringify(body);
  assert.match(text, /general-purpose/);
  assert.equal(text.includes('PROMPT-TEXT'), false);
  const record = await engine.lookup(j.decisionId);
  assert.equal(record.specId, 'subagent-risk');
  for (const code of ['SUBAGENT_RISK_SOURCE_JEV', 'SUBAGENT_RISK_CLASS_GENERAL_PURPOSE', 'SUBAGENT_RISK_SIZE_SMALL', 'SUBAGENT_RISK_LEVEL_LOW', 'SUBAGENT_RISK_RULES_HIGH', 'SUBAGENT_RISK_JEV_LOW', 'JEV_CACHE_MISS']) assert.ok(record.reasonCodes.includes(code), code);
  const explained = core.explainDecision(record);
  assert.match(explained, /Subagent launch risk: low \(lowered by Jev from the rules' level, advice only\)/);
  assert.match(explained, /only a Jev answer at the confidence floors lowers it, and any miss leaves high standing/);
  assert.doesNotMatch(explained, /Provider: no model answered/, 'the summary does not contradict the question it asked');
  const again = await core.judgeSubagentRisk(engine, features('general-purpose', 500), CTX, { assist: 'classify' });
  assert.equal(again.cacheHit, true, 'the same features are answered from the decision cache');
  assert.equal(requests.length, 1);
  // Medium works the same way; a custom type is judged like general-purpose.
  const medium = await setup(t, JEV_MEDIUM);
  const m = await core.judgeSubagentRisk(medium.engine, features('code-reviewer', 9000), CTX, { assist: 'classify' });
  assert.deepEqual([m.level, m.source, m.subagentClass], ['medium', 'jev', 'custom']);
});

test('a weak, unknown or high answer leaves the rules\' high standing', async (t) => {
  const run = async (answer) => {
    const f = await setup(t, answer);
    return core.judgeSubagentRisk(f.engine, features('general-purpose', 500), CTX, { assist: 'classify' });
  };
  // Under the confidence floor (0.6): a low answer at 0.5 changes nothing.
  const weak = await run(() => ({ choice: 'low', probabilities: { low: 0.5, medium: 0.3, high: 0.1, unknown: 0.1 } }));
  assert.deepEqual([weak.level, weak.source, weak.reasonCode], ['high', 'rules', 'SUBAGENT_RISK_JEV_LOW_CONFIDENCE']);
  // Over the confidence floor but under the margin (0.15): 0.62 against 0.5 cannot happen on a distribution, so use the engine's own check on two close options.
  const close = await run(() => ({ choice: 'low', probabilities: { low: 0.46, medium: 0.44, high: 0.05, unknown: 0.05 } }));
  assert.deepEqual([close.level, close.source], ['high', 'rules']);
  const unknown = await run(() => ({ choice: 'unknown', probabilities: { unknown: 0.9 } }));
  assert.deepEqual([unknown.level, unknown.source, unknown.reasonCode, unknown.jevLevel], ['high', 'rules', 'SUBAGENT_RISK_JEV_UNKNOWN', null]);
  const high = await run(JEV_HIGH);
  assert.deepEqual([high.level, high.source, high.jevLevel, high.reasonCode], ['high', 'rules', 'high', 'SUBAGENT_RISK_JEV_HIGH']);
});

test('every failure leaves the rules\' answer: assist off, no engine, a gate, a provider error; a read-only launch is never asked', async (t) => {
  const off = await setup(t, JEV_LOW);
  const assistOff = await core.judgeSubagentRisk(off.engine, features('general-purpose', 500), CTX, { assist: 'off' });
  assert.deepEqual([assistOff.level, assistOff.asked, assistOff.reasonCode], ['high', false, 'SUBAGENT_RISK_ASSIST_OFF']);
  const none = await core.judgeSubagentRisk(null, features('general-purpose', 500), CTX, { assist: 'classify' });
  assert.deepEqual([none.level, none.asked, none.reasonCode], ['high', false, 'PROVIDER_NOT_CONFIGURED']);
  const gated = await core.judgeSubagentRisk(off.engine, features('general-purpose', 500), CTX, { assist: 'classify', skipAsk: 'SUBAGENT_RISK_NO_TIME' });
  assert.deepEqual([gated.level, gated.asked, gated.reasonCode], ['high', false, 'SUBAGENT_RISK_NO_TIME']);
  const sure = await core.judgeSubagentRisk(off.engine, features('Explore', 600), CTX, { assist: 'classify' });
  assert.deepEqual([sure.level, sure.source, sure.asked, sure.reasonCode], ['low', 'rules', false, 'SUBAGENT_RISK_RULES_SURE']);
  // Jev cannot lower a read-only launch below the rules' medium: it is not asked, whatever it would say.
  const large = await core.judgeSubagentRisk(off.engine, features('Explore', 9000), CTX, { assist: 'classify' });
  assert.deepEqual([large.level, large.source, large.asked, large.reasonCode], ['medium', 'rules', false, 'SUBAGENT_RISK_RULES_SURE']);
  assert.equal(off.requests.length, 0, 'none of those sent a request');
  const broken = await setup(t, JEV_LOW, { status: 500 });
  const failed = await core.judgeSubagentRisk(broken.engine, features('general-purpose', 500), CTX, { assist: 'classify' });
  assert.deepEqual([failed.level, failed.source, failed.asked], ['high', 'rules', true]);
  assert.match(failed.reasonCode, /^SUBAGENT_RISK_JEV_/);
});

// ------------------------------------------------------------------------------------------ the handler, by mode

let n = 0;
function agentEvent(payload, { model = 'claude-opus-5-5' } = {}) {
  n += 1;
  return {
    schemaVersion: '1.0', harness: 'claude', nativeEventName: 'PreToolUse', kind: 'tool.proposed', sessionId: 'sess-risk', turnId: null, toolUseId: `tu-${n}`, toolName: 'Agent',
    agentId: null, model, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: true, payload: { toolName: 'Agent', toolInputKeys: ['description', 'prompt', 'subagent_type'], ...payload }, dedupKey: sha(`risk-${n}`),
  };
}

function ctx(home, envelope, { engine, mode, jevAssist, pins, traces = [], remainingMs = 2000 } = {}) {
  const body = { envelope, deliveryKey: `k-${envelope.dedupKey.slice(0, 8)}`, revision: 'rev-1', harnessVersion: '2.1.0', ...(pins === undefined ? {} : { pins }) };
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-risk', root: home }, body, home, signal: new AbortController().signal,
    deadline: { budgetMs: 900, remainingMs: () => remainingMs, expired: () => false }, store: null, killSwitchStopped: false, engine, trace: (e) => traces.push(e),
    ...(mode === undefined ? {} : { mode }), ...(jevAssist === undefined ? {} : { jevAssist }),
  };
}

function record(features) {
  return {
    id: 'cert-claude-1', schemaVersion: '1.0', harness: 'claude', actuatorId: 'claude-hooks', harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: 'FIXTURES_PASSED' })),
    certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', signature: 'sig',
  };
}
const both = provider.recordsCertificationSource(async () => [record(['hooks.route', 'hooks.context'])]);
const routeOnly = provider.recordsCertificationSource(async () => [record(['hooks.route'])]);
const contextOnly = provider.recordsCertificationSource(async () => [record(['hooks.context'])]);
const neither = provider.recordsCertificationSource(async () => []);
const subscriber = (certifications) => provider.createDecisionSubscriber({ handlers: { 'worker-creation': [provider.subagentRouteAdvice] }, certifications, now: () => NOW, operatingSystem: 'linux' });

const EXPLORE = { subagentType: 'Explore', toolInputBytes: 600 };
const GENERAL = { subagentType: 'general-purpose', toolInputBytes: 500 };

test('a read-only launch is low risk by rules: applied as a route to haiku for that call, with a note for the model, no Jev question', async (t) => {
  const { home, engine, requests } = await setup(t, JEV_HIGH);
  const traces = [];
  const result = await subscriber(both).handle(ctx(home, agentEvent({ ...EXPLORE, prompt: PROMPT, description: DESCRIPTION }), { engine, mode: 'bounded-auto', traces }));
  assert.equal(result.hookOutcome.kind, 'route');
  assert.equal(result.hookOutcome.model, HAIKU);
  assert.equal(result.hookOutcome.context, 'Jevris set model haiku on this one Agent call (read-only type, low risk by rules). The session model is unchanged.');
  assert.equal(HookOutcomeContract.validate(result.hookOutcome).ok, true);
  assert.equal(result.reasonCode, 'SUBAGENT_ROUTE_RISK_RULE');
  assert.equal(result.certified, true);
  assert.equal(requests.length, 0, 'the rules were sure');
  const decision = await engine.lookup(result.decisionIds[0]);
  assert.equal(decision.specId, 'subagent-risk', 'the judgement is recorded as advice');
  assert.doesNotMatch(JSON.stringify([result, traces, decision]), /PROMPT-TEXT|DESCRIPTION-TEXT/);
});

test('a write-capable launch is never routed on size alone: with no engine, or Jev at 0.5 or high, the subagent keeps the session model; Jev low at 0.9 sends it to haiku, medium to sonnet', async (t) => {
  const kept = async (label, setupResult, payload, extra = {}) => {
    const traces = [];
    const result = await subscriber(both).handle(ctx(setupResult.home, agentEvent(payload), { engine: setupResult.engine, mode: 'bounded-auto', traces, ...extra }));
    assert.equal(result.hookOutcome.kind, 'observe', label);
    assert.deepEqual(traces.filter((e) => e.event === 'subagent-route').map((e) => e.reasonCode), ['RISK_HIGH'], label);
  };
  const quiet = await setup(t, JEV_LOW);
  await kept('no engine', quiet, GENERAL, { engine: undefined });
  await kept('custom type, no engine', quiet, { subagentType: 'code-reviewer', toolInputBytes: 300 }, { engine: undefined });
  assert.equal(quiet.requests.length, 0, 'nothing was asked');
  await kept('jev.assist off', quiet, GENERAL, { jevAssist: 'off' });
  await kept('too little time', quiet, GENERAL, { remainingMs: 200 });
  assert.equal(quiet.requests.length, 0);
  const weak = await setup(t, () => ({ choice: 'low', probabilities: { low: 0.5, medium: 0.3, high: 0.1, unknown: 0.1 } }));
  await kept('Jev low at confidence 0.5', weak, GENERAL);
  await kept('custom type, Jev low at confidence 0.5', weak, { subagentType: 'code-reviewer', toolInputBytes: 800 });
  assert.equal(weak.requests.length, 2, 'asked, and the weak answer left high standing');
  const high = await setup(t, JEV_HIGH);
  await kept('Jev high', high, GENERAL);
  const unknown = await setup(t, () => ({ choice: 'unknown', probabilities: { unknown: 0.9 } }));
  await kept('Jev unknown', unknown, GENERAL);
  const broken = await setup(t, JEV_LOW, { status: 500 });
  await kept('a provider error', broken, GENERAL);
  // Jev low at 0.9 unlocks haiku, for general-purpose and for a custom type alike.
  const low = await setup(t, JEV_LOW);
  for (const payload of [GENERAL, { subagentType: 'code-reviewer', toolInputBytes: 800 }, { subagentType: 'general-purpose', toolInputBytes: 9000 }]) {
    const routed = await subscriber(both).handle(ctx(low.home, agentEvent({ ...payload, prompt: PROMPT }), { engine: low.engine, mode: 'bounded-auto' }));
    assert.deepEqual([routed.hookOutcome.kind, routed.hookOutcome.model, routed.reasonCode], ['route', HAIKU, 'SUBAGENT_ROUTE_RISK_JEV'], JSON.stringify(payload));
    assert.match(routed.hookOutcome.context, /^Jevris set model haiku on this one Agent call \((?:general-purpose type|custom type code-reviewer), low risk by Jev\)\. The session model is unchanged\.$/);
  }
  assert.equal(JSON.stringify(low.requests).includes('PROMPT-TEXT'), false, 'the brief never reached Jev');
  const medium = await setup(t, JEV_MEDIUM);
  const sonnet = await subscriber(both).handle(ctx(medium.home, agentEvent(GENERAL), { engine: medium.engine, mode: 'bounded-auto' }));
  assert.deepEqual([sonnet.hookOutcome.kind, sonnet.hookOutcome.model], ['route', SONNET]);
  assert.equal(medium.requests.length, 1, 'one bounded question');
  // A Jev answer unlocks nothing the gates refuse: an explicit model or a pin is asked about nothing at all.
  const gated = await setup(t, JEV_LOW);
  assert.equal((await subscriber(both).handle(ctx(gated.home, agentEvent({ ...GENERAL, requestedModel: 'opus' }), { engine: gated.engine, mode: 'bounded-auto' }))).hookOutcome.kind, 'observe');
  assert.equal((await subscriber(both).handle(ctx(gated.home, agentEvent(GENERAL), { engine: gated.engine, mode: 'bounded-auto', pins: { modelPin: 'claude-opus-5', effortPin: null } }))).hookOutcome.kind, 'observe');
  assert.equal(gated.requests.length, 0, 'a refusal never spends a question');
});

test('jev.assist off, no engine, too little time and a provider error leave a read-only launch routed by the rules alone', async (t) => {
  const a = await setup(t, JEV_HIGH);
  for (const extra of [{ jevAssist: 'off' }, { remainingMs: 200 }, { engine: undefined }]) {
    const result = await subscriber(both).handle(ctx(a.home, agentEvent(EXPLORE), { engine: a.engine, mode: 'bounded-auto', ...extra }));
    assert.deepEqual([result.hookOutcome.kind, result.hookOutcome.model], ['route', HAIKU], JSON.stringify(extra));
  }
  assert.equal(a.requests.length, 0, 'a read-only launch is never asked');
});

test('route, advise and observe: applied at bounded-auto with hooks.route; advice for the model in advise or when the route is uncertified; nothing in observe', async (t) => {
  const { home, engine } = await setup(t, JEV_HIGH);
  const at = (certifications, mode) => subscriber(certifications).handle(ctx(home, agentEvent(EXPLORE), { engine, mode }));
  const applied = await at(both, 'bounded-auto');
  assert.deepEqual([applied.hookOutcome.kind, applied.certified], ['route', true]);
  // advise: a route is an actuation, so the same advice is addressed to the model as a PreToolUse context.
  const advised = await at(both, 'advise');
  assert.deepEqual([advised.hookOutcome.kind, advised.certified], ['context', true]);
  assert.equal(advised.hookOutcome.text, 'Jevris advises model: haiku for this Explore subagent (read-only type, low risk by rules). This call already started; set model on the next Agent call to apply it. The session model is unchanged.');
  // Context certified, route not: the alias proof is off, so haiku needs a run on this harness before it is advised at all.
  assert.equal((await at(contextOnly, 'bounded-auto')).hookOutcome.kind, 'observe', 'no evidence that haiku is usable here');
  assert.equal(await core.recordModelRun(home, { harness: 'claude', authMode: 'unknown', modelId: HAIKU, nowMs: NOW, raw: null, servingHost: null, source: 'reported' }), true);
  const uncertified = await at(contextOnly, 'bounded-auto');
  assert.deepEqual([uncertified.hookOutcome.kind, uncertified.certified], ['context', true]);
  assert.match(uncertified.hookOutcome.text, /^Jevris advises model: haiku/);
  // Neither feature: the user-only explain, as before.
  const explained = await at(neither, 'bounded-auto');
  assert.equal(explained.hookOutcome.kind, 'explain');
  assert.match(explained.hookOutcome.text, /Explore subagent/);
  // Route certified but hooks.context not: advise mode keeps the explain.
  assert.equal((await at(routeOnly, 'advise')).hookOutcome.kind, 'explain');
  // observe records and shows nothing.
  assert.equal((await at(both, 'observe')).hookOutcome.kind, 'observe');
});

test('the gates still hold: an explicit model, a pin, a model found gone, the session already on it, and no alias proof without hooks.route', async (t) => {
  const { home, engine } = await setup(t, JEV_MEDIUM);
  const run = (payload, extra = {}, certs = both) => subscriber(certs).handle(ctx(home, agentEvent(payload, extra.event), { engine, mode: 'bounded-auto', ...extra.ctx }));
  assert.equal((await run({ ...EXPLORE, requestedModel: 'opus' })).hookOutcome.kind, 'observe', 'an explicit model stands');
  assert.equal((await run(EXPLORE, { ctx: { pins: { modelPin: 'claude-opus-5', effortPin: null } } })).hookOutcome.kind, 'observe', 'a pin stands');
  assert.equal((await run(EXPLORE, { event: { model: 'haiku' } })).hookOutcome.kind, 'observe', 'the session already runs it');
  assert.equal((await run(GENERAL, { event: { model: 'claude-sonnet-5-5' } })).hookOutcome.kind, 'observe', 'sonnet on sonnet is no change');
  assert.equal((await run(GENERAL, { event: { model: 'claude-haiku-5-5' } })).hookOutcome.kind, 'observe', 'a default route never goes to a model that costs more than the session');
  await core.recordModelUnavailable({ home, modelId: HAIKU, reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'provider-call', nowMs: NOW, registry: core.BUNDLED_MODEL_REGISTRY });
  assert.equal((await run(EXPLORE)).hookOutcome.kind, 'observe', 'a model found gone is never routed, whatever else is true');
  // Kimi-style: another harness is out of scope here (Claude Code only).
  const other = agentEvent(EXPLORE);
  const codex = await subscriber(both).handle(ctx(home, { ...other, harness: 'codex', dedupKey: sha('codex-risk') }, { engine, mode: 'bounded-auto' }));
  assert.equal(codex.hookOutcome.kind, 'observe', 'the risk default is Claude Code only');
});

test('the Claude Code alias proof is its own eligibility reason, only for harness claude, anthropic, an alias family and a certified hooks.route', () => {
  const registry = core.BUNDLED_MODEL_REGISTRY;
  const eligible = (harness, certified, extra = {}) =>
    core.modelEligibility({ registry, accountId: null, offer: null, scope: { harness, authMode: null }, harnessAlias: { certified, nowMs: NOW }, ...extra }).filter((e) => e.eligible);
  const claude = eligible('claude', true);
  assert.deepEqual(claude.map((e) => e.reasonCode), claude.map(() => 'HARNESS_ALIAS'));
  // Only the model each family alias means now: Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1, not Sonnet 5 or Haiku 4.5.
  const ids = claude.map((e) => e.modelId);
  for (const id of [HAIKU, SONNET, 'claude-opus-5-5', 'claude-fable-5-1']) assert.ok(ids.includes(id), id);
  for (const id of ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5']) assert.equal(ids.includes(id), false, id);
  assert.ok(claude.every((e) => e.basis === 'harness-alias'));
  assert.deepEqual(eligible('claude', false), [], 'hooks.route not certified: no proof');
  for (const harness of ['codex', 'kilocode', 'opencode', 'antigravity', null]) assert.deepEqual(eligible(harness, true), [], `${String(harness)} gets no alias proof`);
  assert.deepEqual(core.locallyEligibleModels(claude), ids);
  // The refusals win: found gone, and an administrator's account check.
  const gone = eligible('claude', true, { unavailable: { [HAIKU]: 'MODEL_GONE' } }).map((e) => e.modelId);
  assert.equal(gone.includes(HAIKU), false);
  const admin = core.modelEligibility({ registry, accountId: 'acct', offer: null, scope: { harness: 'claude', authMode: null }, harnessAlias: { certified: true, nowMs: NOW } });
  assert.ok(admin.every((e) => e.basis === 'account-check'), 'an administrator account check decides alone');
  // A retired model is no alias target.
  const retired = { ...registry, entries: registry.entries.map((e) => (e.modelId === HAIKU ? { ...e, lifecycle: { ...e.lifecycle, retiresOn: '2026-09-01T00:00:00Z' } } : e)) };
  assert.equal(core.modelEligibility({ registry: retired, accountId: null, offer: null, scope: { harness: 'claude', authMode: null }, harnessAlias: { certified: true, nowMs: NOW } }).find((e) => e.modelId === HAIKU).eligible, false);
  const lines = core.modelEligibilityLines(core.modelEligibility({ registry, accountId: null, offer: null, scope: { harness: 'claude', authMode: null }, harnessAlias: { certified: true, nowMs: NOW } }), { harness: 'claude', authMode: null });
  assert.ok(lines.some((l) => /claude-haiku-5-5 is eligible for a subagent route: Claude Code's own family alias resolves to it.*\(HARNESS_ALIAS\)/.test(l)));
});
