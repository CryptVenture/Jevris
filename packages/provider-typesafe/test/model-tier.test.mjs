// Tiered routing, the Jev choice (owner decision 2026-10-08): when the rules do not settle a task's tier and there is a real
// choice, Jev is asked ONE bounded Choice over the actual candidate set (generic labels A to H, mapped back locally), from
// content-free features and, only with source egress approved, one screened task-text span. Its pick is used only at the 0.6
// confidence and 0.15 margin floors and only inside the rules' floor and ceiling; any miss is the rules' tier. Scripted fetch,
// temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const REGISTRY = core.BUNDLED_MODEL_REGISTRY;
const PROVIDERS = [...new Set(REGISTRY.entries.map((e) => e.provider))];
const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });
const TITLE = 'adjust the zebra pagination offsets';
const CTX = { workspaceId: 'w-tier', evidenceRevision: 'rev-1', deadlineMs: 30_000 };

/** A scripted Jev: `answer()` gives `{ choice, probabilities }`; every request body is recorded. */
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
      const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / Math.max(1, rest.length)) * 10000) / 10000]));
      const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
      answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 400, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, answer, { sourceEgress = DENIED, status } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-tier-jev-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const script = scriptedFetch(answer, { status });
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests };
}

const pick = (label, p = 0.9) => () => ({ choice: label, probabilities: { [label]: p } });

function eligible(extra = {}) {
  return core.filterCandidates(REGISTRY, {
    managedAllowlist: null,
    allowedRegions: ['global'],
    requiredContextTokens: 0,
    requiredCapabilities: [],
    pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null,
    accountId: null,
    locallyEligible: REGISTRY.entries.map((e) => e.modelId),
    automated: true,
    consentedProviders: PROVIDERS,
    nowMs: NOW,
    ...extra,
  }).eligible;
}

const PLAIN = { hints: { title: TITLE, paths: ['src/page.ts', 'src/list.ts'], checkIds: ['test'] }, risk: 'medium' };
const HARD = { hints: { title: TITLE, paths: ['src/auth/login.ts'], checkIds: ['test'] } };
const SMALL = { hints: { title: TITLE, paths: ['src/label.ts'], checkIds: ['test'] } };
const LOCKFILE = { hints: { title: TITLE, paths: ['package-lock.json'], checkIds: ['test'] } };

function judge(engine, baselineModelId, input, { text = TITLE, models = eligible(), options = {} } = {}) {
  return core.judgeModelTier(engine, { signals: core.tierSignalsOf(input), eligible: models, baselineModelId, volume: core.DEFAULT_TASK_VOLUME, ...(text === null ? {} : { text }) }, CTX, { assist: 'classify', ...options });
}

test('Jev is asked one Choice over generic labels in price order, with the candidates described by registry facts; an accepted pick is the tier, labelled as Jev\'s suggestion', async (t) => {
  const { engine, requests } = await setup(t, pick('C'));
  const d = await judge(engine, SONNET, PLAIN);
  assert.deepEqual([d.tier, d.targetModelId, d.basis, d.rulesTier, d.asked, d.jevModelId], ['step-up', OPUS, 'tier-jev', 'baseline', true, OPUS]);
  assert.equal(d.label, "Jev's suggestion from structured features; not a learned route, not a signed prior");
  assert.ok(d.reasonCodes.includes('TIER_JEV_ACCEPTED'));
  assert.equal(requests.length, 1);
  const body = requests[0];
  assert.deepEqual(Object.keys(body.questions), ['model']);
  assert.deepEqual(Object.keys(body.questions.model.criteria), ['A', 'B', 'C', 'unknown']);
  assert.deepEqual(body.questions.model, core.modelTierQuestions(3).model, 'the question text depends on the candidate count only');
  const wire = JSON.stringify(body);
  for (const id of [HAIKU, SONNET, OPUS]) assert.ok(wire.includes(id), `${id} is described to Jev`);
  assert.equal(wire.includes('claude-fable-5-1'), false, 'never Fable');
  assert.equal(JSON.stringify(body.questions).includes(OPUS), false, 'no model id in the question text');
  assert.match(wire, /the baseline/);
  assert.match(wire, /provider anthropic; family haiku/);
});

test('the question text does not change with the provider: three OpenAI candidates ask the same question as three Anthropic ones', async (t) => {
  const claude = await setup(t, pick('B'));
  await judge(claude.engine, SONNET, PLAIN);
  const openai = eligible().filter((m) => ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-sol'].includes(m.modelId));
  const codex = await setup(t, pick('B'));
  await judge(codex.engine, 'gpt-6.1-sol', PLAIN, { models: openai });
  assert.deepEqual(codex.requests[0].questions, claude.requests[0].questions);
  assert.equal(JSON.stringify(codex.requests[0]).includes('claude'), false, 'an OpenAI session never sees an Anthropic model');
});

test('egress denied: no task text and not even a withheld span go out; approved: the title goes as one screened span; a secret in it refuses the packet', async (t) => {
  const denied = await setup(t, pick('B'), { sourceEgress: DENIED });
  const a = await judge(denied.engine, SONNET, PLAIN);
  assert.equal(a.textSent, false);
  assert.equal(denied.requests.length, 1);
  assert.deepEqual([denied.requests[0].state.untrustedEvidence, denied.requests[0].state.withheldEvidence], [[], []], 'no evidence at all');
  const wire = JSON.stringify(denied.requests);
  for (const leak of ['zebra', 'pagination', 'page.ts', 'list.ts']) assert.equal(wire.includes(leak), false, `${leak} must not leave while egress is denied`);
  assert.match(wire, /"files"/, 'the features are sent');

  const approved = await setup(t, pick('B'), { sourceEgress: APPROVED });
  const b = await judge(approved.engine, SONNET, PLAIN);
  assert.equal(b.textSent, true);
  const spans = approved.requests[0].state.untrustedEvidence;
  assert.equal(spans.length, 1);
  assert.ok(JSON.stringify(spans).includes('zebra pagination'), 'one screened span of the title');
  assert.equal(JSON.stringify(approved.requests).includes('page.ts'), false, 'a path name is never sent, even with egress approved');

  // A secret in the text refuses the packet before anything is sent: the rules' tier, with the reason.
  const secret = await setup(t, pick('C'), { sourceEgress: APPROVED });
  const refused = await judge(secret.engine, SONNET, PLAIN, { text: `adjust the pagination, token ${provider.FAKE_SECRET}` });
  assert.equal(secret.requests.length, 0, 'nothing was sent');
  assert.deepEqual([refused.tier, refused.basis, refused.asked, refused.textSent], ['baseline', 'tier-rule', true, false]);
  assert.ok(refused.reasonCodes.some((c) => /^TIER_JEV_/.test(c)), JSON.stringify(refused.reasonCodes));
  assert.equal(JSON.stringify(refused).includes(provider.FAKE_SECRET), false);
});

test('the floors: below 0.6 confidence or a 0.15 margin the rules\' tier stands; unknown, a label outside the set and a provider error too', async (t) => {
  const weak = await setup(t, () => ({ choice: 'C', probabilities: { A: 0.2, B: 0.2, C: 0.5, unknown: 0.1 } }));
  const low = await judge(weak.engine, SONNET, PLAIN);
  assert.deepEqual([low.tier, low.basis, low.reasonCodes.includes('TIER_JEV_LOW_CONFIDENCE'), low.jevModelId], ['baseline', 'tier-rule', true, OPUS]);
  const thin = await setup(t, () => ({ choice: 'C', probabilities: { A: 0.05, B: 0.3, C: 0.62, unknown: 0.03 } }));
  assert.equal((await judge(thin.engine, SONNET, PLAIN)).tier, 'step-up', '0.62 against 0.30 clears both floors');
  const close = await setup(t, () => ({ choice: 'C', probabilities: { A: 0.01, B: 0.4, C: 0.55, unknown: 0.04 } }));
  assert.equal((await judge(close.engine, SONNET, PLAIN)).tier, 'baseline', 'a 0.15 margin is needed');
  const unknown = await setup(t, pick('unknown'));
  const u = await judge(unknown.engine, SONNET, PLAIN);
  assert.deepEqual([u.tier, u.basis, u.reasonCodes.includes('TIER_JEV_UNKNOWN'), u.jevModelId], ['baseline', 'tier-rule', true, null]);
  // A label the set does not have (the answer is validated against what was passed): the rules answer.
  const off = await setup(t, pick('H'));
  const o = await judge(off.engine, SONNET, PLAIN);
  assert.deepEqual([o.tier, o.basis, o.jevModelId], ['baseline', 'tier-rule', null]);
  const broken = await setup(t, pick('C'), { status: 500 });
  const e = await judge(broken.engine, SONNET, PLAIN);
  assert.deepEqual([e.tier, e.basis, e.asked], ['baseline', 'tier-rule', true]);
  assert.ok(e.reasonCodes.some((c) => /^TIER_JEV_/.test(c)));
});

test('the rules\' floor: a step-up the rules say is never lowered, and the baseline is the floor when risk is high or no text is attached', async (t) => {
  // Rules say step up (an auth path): Jev answering the baseline or Haiku is below the floor.
  for (const label of ['A', 'B']) {
    const { engine } = await setup(t, pick(label));
    const d = await judge(engine, SONNET, HARD);
    // With one rung above the baseline the range holds one candidate: Jev is not even asked.
    assert.deepEqual([d.tier, d.targetModelId, d.asked], ['step-up', OPUS, false], label);
    assert.ok(d.reasonCodes.includes('TIER_NO_CHOICE'));
  }
  // Codex has two rungs above its baseline, so the rules' step-up has a real choice; the baseline and the lower rungs are below the floor.
  for (const label of ['A', 'B', 'C']) {
    const { engine, requests } = await setup(t, pick(label));
    const d = await judge(engine, 'gpt-6.1-sol', HARD);
    assert.equal(requests.length, 1, label);
    assert.deepEqual([d.tier, d.targetModelId, d.basis], ['step-up', 'gpt-5.6-sol', 'tier-rule'], `${label}: ${JSON.stringify(d.reasonCodes)}`);
    assert.ok(d.reasonCodes.includes('TIER_JEV_BELOW_FLOOR'), label);
  }
  // Jev agreeing with the rules is the rules' answer, said so; Jev choosing the dearer rung is the step-up to it (rules say step up).
  const agree = await setup(t, pick('D'));
  const same = await judge(agree.engine, 'gpt-6.1-sol', HARD);
  assert.deepEqual([same.tier, same.targetModelId, same.basis, same.reasonCodes.includes('TIER_JEV_AGREES')], ['step-up', 'gpt-5.6-sol', 'tier-rule', true]);
  const dearer = await setup(t, pick('E'));
  const up = await judge(dearer.engine, 'gpt-6.1-sol', HARD);
  assert.deepEqual([up.tier, up.targetModelId, up.basis], ['step-up', 'gpt-6-astra', 'tier-jev']);
  // The ceiling: with the rules at the baseline, Jev may raise to the nearest dearer rung only, never to the dearest.
  const ceiling = await setup(t, pick('E'));
  const capped = await judge(ceiling.engine, 'gpt-6.1-sol', PLAIN);
  assert.deepEqual([capped.tier, capped.basis, capped.reasonCodes.includes('TIER_JEV_ABOVE_CEILING')], ['baseline', 'tier-rule', true]);
  const nearest = await setup(t, pick('D'));
  assert.deepEqual([(await judge(nearest.engine, 'gpt-6.1-sol', PLAIN)).targetModelId], ['gpt-5.6-sol']);
  // Rules at the baseline with egress denied: Jev may not go below the baseline, whatever it answers.
  const cheaper = await setup(t, pick('A'));
  const noText = await judge(cheaper.engine, SONNET, PLAIN);
  assert.deepEqual([noText.tier, noText.basis, noText.reasonCodes.includes('TIER_JEV_BELOW_FLOOR')], ['baseline', 'tier-rule', true]);
});

test('Jev may judge a task easy and go below the baseline only with the egress-approved text attached, risk under high and no open failure', async (t) => {
  const withText = await setup(t, pick('A'), { sourceEgress: APPROVED });
  const easy = await judge(withText.engine, SONNET, PLAIN);
  assert.deepEqual([easy.tier, easy.targetModelId, easy.basis, easy.textSent], ['step-down', HAIKU, 'tier-jev', true]);
  assert.equal(easy.label, "Jev's suggestion from structured features and a screened task-text span; not a learned route, not a signed prior");
  // Risk high (a lockfile-only change is high risk with the rules at the baseline): no lowering even with the text.
  const high = await setup(t, pick('A'), { sourceEgress: APPROVED });
  const lock = await judge(high.engine, SONNET, LOCKFILE);
  assert.deepEqual([lock.rulesTier, lock.tier, lock.reasonCodes.includes('TIER_JEV_BELOW_FLOOR')], ['baseline', 'baseline', true]);
  // An open failure: no lowering either.
  const failing = await setup(t, pick('A'), { sourceEgress: APPROVED });
  const f = await judge(failing.engine, SONNET, { ...PLAIN, failedAttempts: 1, maxRepairAttempts: 3 });
  assert.deepEqual([f.tier, f.reasonCodes.includes('TIER_JEV_BELOW_FLOOR')], ['baseline', true]);
  // No text sent (egress denied): no lowering.
  const denied = await setup(t, pick('A'), { sourceEgress: DENIED });
  assert.equal((await judge(denied.engine, SONNET, PLAIN)).tier, 'baseline');
  // A step-down the rules reached: Jev may raise it, and goes lower only with the text.
  const raised = await setup(t, pick('B'));
  const r = await judge(raised.engine, SONNET, SMALL);
  assert.deepEqual([r.rulesTier, r.tier, r.targetModelId, r.basis], ['step-down', 'baseline', SONNET, 'tier-jev']);
});

test('a task the rules settle, a ladder with nothing to choose between, assist off and no engine ask nothing', async (t) => {
  const { engine, requests } = await setup(t, pick('C'));
  const docs = await judge(engine, SONNET, { hints: { paths: ['docs/guide.md'], checkIds: [] } });
  assert.deepEqual([docs.tier, docs.targetModelId, docs.asked, docs.reasonCodes.includes('TIER_RULES_SURE')], ['step-down', HAIKU, false, true]);
  const none = await judge(engine, SONNET, { hints: {} });
  assert.deepEqual([none.tier, none.asked, none.reasonCodes.includes('TIER_NO_SIGNALS')], ['baseline', false, true]);
  // Antigravity's Google ladder is one model: nothing to choose.
  const agy = await judge(engine, 'gemini-3.8-flash', PLAIN);
  assert.deepEqual([agy.tier, agy.targetModelId, agy.asked, agy.reasonCodes.includes('TIER_NO_CHOICE')], ['baseline', 'gemini-3.8-flash', false, true]);
  const off = await judge(engine, SONNET, PLAIN, { options: { assist: 'off' } });
  assert.deepEqual([off.tier, off.asked, off.reasonCodes.includes('TIER_ASSIST_OFF')], ['baseline', false, true]);
  const bare = await judge(null, SONNET, PLAIN);
  assert.deepEqual([bare.tier, bare.asked, bare.reasonCodes.includes('PROVIDER_NOT_CONFIGURED')], ['baseline', false, true]);
  const gated = await judge(engine, SONNET, PLAIN, { options: { skipAsk: 'TIER_NO_TIME' } });
  assert.deepEqual([gated.asked, gated.reasonCodes.includes('TIER_NO_TIME')], [false, true]);
  assert.equal(requests.length, 0, 'none of those sent a request');
});

test('the decision is recorded, explained with its label and candidates, and read back as an adviser summary; a repeat is a cache hit', async (t) => {
  const { engine, requests } = await setup(t, pick('C'));
  const d = await judge(engine, SONNET, PLAIN);
  const record = await engine.lookup(d.decisionId);
  assert.equal(record.specId, 'model-tier');
  for (const code of ['TIER_SOURCE_JEV', 'TIER_LEVEL_STEP_UP', 'TIER_RULES_BASELINE', 'TIER_FEATURE_RISK_MEDIUM', 'TIER_CANDIDATES_3', 'TIER_TEXT_NOT_SENT', 'TIER_JEV_PICK_C', 'JEV_CACHE_MISS', 'TIER_JEV_ACCEPTED']) assert.ok(record.reasonCodes.includes(code), `${code}: ${JSON.stringify(record.reasonCodes)}`);
  const text = core.explainDecision(record);
  assert.match(text, /Model tier: step up, claude-opus-5-5 against the baseline claude-sonnet-5-5\./);
  assert.match(text, /Jev's suggestion from structured features; not a learned route, not a signed prior/);
  assert.match(text, /Candidates offered .*claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5/);
  assert.match(text, /chose candidate c/);
  assert.doesNotMatch(text, /Provider: no model answered/, 'the summary does not contradict the question it asked');
  assert.match(text, /\(asked Jev, \d+ ms\)/);
  assert.equal(JSON.stringify(record).includes('zebra'), false, 'no task text in the record');
  const again = await judge(engine, SONNET, PLAIN);
  assert.equal(again.cacheHit, true);
  assert.equal(requests.length, 1, 'the same task is answered from the decision cache');
  assert.match(core.explainDecision(await engine.lookup(again.decisionId)), /\(cache hit, \d+ ms\)/);
  // A rules-only decision says so, with the rules label.
  const rules = await judge(engine, SONNET, { hints: { paths: ['docs/guide.md'], checkIds: [] } });
  const ruleText = core.explainDecision(await engine.lookup(rules.decisionId));
  assert.match(ruleText, /Rules-based default - not a learned route, not a signed prior/);
  assert.match(ruleText, /\(Jev not asked, \d+ ms\)/);
});
