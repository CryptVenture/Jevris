// Tiered routing in `jevris route` (owner decision 2026-10-08): a request that describes its task gets a `tier` part: how hard
// the work looks and which of the models available to this session it points at, from the session's own model (any provider),
// labelled as advice from a rules-based default or Jev's suggestion; never a learned route, never a signed prior, never applied.
// A harness with no default of its own (Kilo, OpenCode) and an unknown session model has no baseline and no route advice.
// Scripted fetch, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));
const NOW = Date.parse('2026-10-08T12:00:00Z');
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });
const HARD = { title: 'rework the zebra login flow', paths: ['src/auth/login.ts'], checkIds: ['test'] };
const PLAIN = { title: 'adjust the zebra pagination', paths: ['src/page.ts', 'src/list.ts'], checkIds: ['test'] };

function scriptedFetch(label) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const keys = Object.keys(q.criteria);
      if (q.type === 'score') answers[id] = { type: 'score', score: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])), legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      else {
        const choice = id === 'model' ? label : id === 'slice' ? 'issue-fix' : keys[0];
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0.1 / (keys.length - 1)]));
        answers[id] = { type: 'choice', choice, probabilities, confidence: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, { label = 'B', listings = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-tier-op-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  for (const [harness, models] of listings) assert.equal(await core.recordModelListing(home, { harness, authMode: 'api-key', result: { ok: true, version: null, models }, nowMs: NOW }), true);
  const script = scriptedFetch(label);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: DENIED });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests };
}

const fixedDeadline = (budgetMs) => ({ budgetMs, remainingMs: () => budgetMs, expired: () => false });
function opCtx(home, body, engine, extra = {}) {
  return { op: 'route', client: 'cli', scopes: ['status', 'advice'], workspace: { id: 'w-tier-op', root: null }, body, home, signal: new AbortController().signal, deadline: fixedDeadline(60_200), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise', ...extra };
}
async function route(home, body, engine, extra) {
  const out = await ops.route.handle(opCtx(home, body, engine, extra));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('route').validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

const SESSIONS = [
  // [harness, session model, listed models, task, expected tier, expected target, provider prefix]
  ['claude', 'claude-sonnet-5-5', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], HARD, 'step-up', 'claude-opus-5-5', 'claude-'],
  ['codex', 'gpt-6.1-sol', ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-astra', 'claude-opus-5-5'], HARD, 'step-up', 'gpt-5.6-sol', 'gpt-'],
  ['antigravity', 'gemini-3.8-flash', ['gemini-3.8-flash', 'gemini-3.7-flash', 'claude-opus-5-5'], HARD, 'baseline', 'gemini-3.8-flash', 'gemini-'],
  ['kilocode', 'gpt-6-sol', ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'claude-sonnet-5-5', 'claude-opus-5-5'], HARD, 'step-up', 'gpt-5.6-sol', 'gpt-'],
  ['opencode', 'claude-opus-5-5', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6-astra'], HARD, 'baseline', 'claude-opus-5-5', 'claude-'],
];
for (const [harness, model, listed, task, tier, target, prefix] of SESSIONS) {
  test(`route op on ${harness} (${model}): the tier is over this provider's own models, advice only, labelled as a rules-based default`, async (t) => {
    const { home, engine } = await setup(t, { listings: [[harness, listed]] });
    const out = await route(home, { currentModel: model, harness, authMode: 'api-key', task }, engine, { jevAssist: 'off' });
    assert.ok(out.tier !== undefined, JSON.stringify(out));
    assert.deepEqual([out.tier.tier, out.tier.targetModel, out.tier.baselineModel, out.tier.basis], [tier, target, model, 'tier-rule']);
    assert.equal(out.tier.label, 'Rules-based default - not a learned route, not a signed prior');
    assert.ok(out.tier.candidates.every((id) => id.startsWith(prefix)), `${harness}: ${JSON.stringify(out.tier.candidates)}`);
    assert.ok(!out.tier.candidates.includes('claude-fable-5-1'));
    assert.equal(out.applied, false, 'advice only: nothing is switched');
    assert.match(out.tier.text, /Advice only: nothing here switches the session's model/);
  });
}

test('route op: Jev may choose among the candidates; the answer is labelled as Jev\'s suggestion and the title never leaves with egress denied', async (t) => {
  const { home, engine, requests } = await setup(t, { label: 'C', listings: [['claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']]] });
  const out = await route(home, { currentModel: 'claude-sonnet-5-5', harness: 'claude', authMode: 'api-key', task: PLAIN }, engine);
  assert.deepEqual([out.tier.tier, out.tier.targetModel, out.tier.basis, out.tier.asked], ['step-up', 'claude-opus-5-5', 'tier-jev', true]);
  assert.equal(out.tier.label, "Jev's suggestion from structured features; not a learned route, not a signed prior");
  assert.ok(out.tier.decisionId !== null, 'explain names the decision');
  const asked = requests.filter((r) => 'model' in r.questions);
  assert.equal(asked.length, 1);
  assert.equal(JSON.stringify(asked).includes('zebra'), false, 'no title with source egress denied');
  assert.deepEqual([asked[0].state.untrustedEvidence, asked[0].state.withheldEvidence], [[], []]);
  const text = core.explainDecision(await engine.lookup(out.tier.decisionId));
  assert.match(text, /Model tier: step up/);
});

test('route op: no task, a pinned model or an unregistered session model gives no tier; Claude Code with no reported model uses its own default', async (t) => {
  const { home, engine } = await setup(t, { listings: [['claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']]] });
  assert.equal((await route(home, { currentModel: 'claude-sonnet-5-5', harness: 'claude', authMode: 'api-key' }, engine, { jevAssist: 'off' })).tier, undefined, 'no task');
  assert.equal((await route(home, { currentModel: 'claude-sonnet-5-5', modelPin: 'claude-sonnet-5-5', harness: 'claude', authMode: 'api-key', task: HARD }, engine, { jevAssist: 'off' })).tier, undefined, 'a pin is kept');
  assert.equal((await route(home, { currentModel: 'gpt-0-unknown', harness: 'claude', authMode: 'api-key', task: HARD }, engine, { jevAssist: 'off' })).tier, undefined, 'an unregistered session model');
  const none = await route(home, { harness: 'claude', authMode: 'api-key', task: HARD }, engine, { jevAssist: 'off' });
  assert.deepEqual([none.tier.baselineModel, none.tier.targetModel], ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('route op: Kilo and OpenCode with no reported session model have no baseline: no tier and no route advice, never the Claude fallback', async (t) => {
  const { home, engine } = await setup(t, { listings: [['kilocode', ['claude-sonnet-5-5', 'claude-opus-5-5']], ['opencode', ['gpt-6.1-sol']]] });
  for (const harness of ['kilocode', 'opencode']) {
    const out = await route(home, { sliceId: 'bounded-edit', harness, authMode: 'api-key', task: HARD }, engine, { jevAssist: 'off' });
    assert.equal(out.tier, undefined, harness);
    assert.equal(out.main.reasonCode, 'CURRENT_MODEL_UNKNOWN', harness);
    assert.equal(out.main.outcome, 'abstain', harness);
    assert.equal(out.main.recommendedModel, null, harness);
  }
  // A harness with its own default keeps using it for an unknown model.
  const codex = await route(home, { sliceId: 'bounded-edit', harness: 'codex', authMode: 'api-key', task: HARD }, engine, { jevAssist: 'off' });
  assert.notEqual(codex.main.reasonCode, 'CURRENT_MODEL_UNKNOWN');
});
