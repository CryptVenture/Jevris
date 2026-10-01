// Owner decision 2026-10-01 (Jev as an active decision aid): a route request that names no slice
// but describes its task has the slice classified, Jev from structured features with the rules as
// the fallback. Scripted fetch, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

/** A scripted Jev: `answer(id, question)` gives `{ choice, probabilities }` or `{ score }`; every request body is recorded. */
function scriptedFetch(answer, { delayMs = 0 } = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const want = answer(id, q, body) ?? {};
      if (q.type === 'score') {
        const level = want.score ?? 0;
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? 1 : 0]));
        answers[id] = { type: 'score', score: level, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      } else {
        const keys = Object.keys(q.criteria);
        const given = want.probabilities ?? { [want.choice ?? keys[0]]: 0.9 };
        const rest = keys.filter((k) => !(k in given));
        const left = 1 - Object.values(given).reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / rest.length) * 10000) / 10000]));
        const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
        answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

async function setup(t, answer, { sourceEgress = DENIED, delayMs = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-slice-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = scriptedFetch(answer, { delayMs });
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress });
  return { home, engine, requests: script.requests };
}

const CTX = { workspaceId: 'w-slice', evidenceRevision: 'rev-1', deadlineMs: 30_000 };
const JEV_FIX = (id) => (id === 'slice' ? { choice: 'issue-fix', probabilities: { 'issue-fix': 0.85 } } : { score: 1 });
// Two ordinary source files and a check: the rules call it a weak bounded-edit, so Jev is asked.
const SOURCE_TASK = { paths: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], checkIds: ['test'] };

test('rules answer first and a sure answer asks no model: all-docs, all-tests, a command with no files', async (t) => {
  const { engine, requests } = await setup(t, JEV_FIX);
  const docs = await core.classifyTaskSlice(engine, { paths: ['docs/guide.md', 'README.md'] }, CTX, { assist: 'classify' });
  assert.deepEqual([docs.sliceId, docs.source, docs.asked, docs.reasonCode], ['docs', 'rules', false, 'SLICE_RULES_SURE']);
  const tests = await core.classifyTaskSlice(engine, { paths: ['test/a.test.mjs', 'src/__tests__/b.ts'] }, CTX, { assist: 'classify' });
  assert.deepEqual([tests.sliceId, tests.source], ['test-fix', 'rules']);
  const run = await core.classifyTaskSlice(engine, { title: 'run the release script and install' }, CTX, { assist: 'classify' });
  assert.deepEqual([run.sliceId, run.source], ['terminal', 'rules']);
  assert.equal(requests.length, 0, 'a deterministic fact needs no model');
  const none = await core.classifyTaskSlice(engine, {}, CTX, { assist: 'classify' });
  assert.deepEqual([none.sliceId, none.source, none.reasonCode], [null, 'none', 'SLICE_NO_FEATURES']);
});

test('Jev classifies from features: one request with a slice Choice and a risk Score, a record, then a cache hit', async (t) => {
  const { engine, requests } = await setup(t, JEV_FIX);
  const first = await core.classifyTaskSlice(engine, SOURCE_TASK, CTX, { assist: 'classify' });
  assert.deepEqual([first.sliceId, first.source, first.asked, first.reasonCode, first.risk], ['issue-fix', 'jev', true, 'SLICE_JEV_OVER_RULES', 'low']);
  assert.equal(first.rulesAlternative, 'bounded-edit', 'the rules slice is kept as the alternative');
  assert.equal(first.cacheHit, false);
  assert.equal(requests.length, 1);
  const q = requests[0].questions;
  assert.deepEqual(Object.keys(q).sort(), ['risk', 'slice']);
  assert.deepEqual(Object.keys(q.slice.criteria).sort(), [...core.SHARED_SLICE_IDS, 'unknown'].sort());
  assert.equal(q.risk.criteria.length, 5);
  const record = await engine.lookup(first.decisionId);
  assert.equal(record.specId, 'slice-classify');
  assert.ok(record.reasonCodes.includes('SLICE_SOURCE_JEV') && record.reasonCodes.includes('SLICE_ID_ISSUE_FIX'));
  const again = await core.classifyTaskSlice(engine, SOURCE_TASK, CTX, { assist: 'classify' });
  assert.equal(again.sliceId, 'issue-fix');
  assert.equal(again.cacheHit, true, 'the same features are answered from the decision cache');
  assert.equal(requests.length, 1, 'a cache hit makes no second call');
});

test('Jev agreeing with the rules is SLICE_JEV; low confidence, unknown and high risk keep the baseline or the rules slice', async (t) => {
  let script = { slice: { choice: 'bounded-edit', probabilities: { 'bounded-edit': 0.9 } }, risk: 0 };
  const { engine } = await setup(t, (id) => (id === 'slice' ? script.slice : { score: script.risk }));
  const ask = (hints) => core.classifyTaskSlice(engine, hints, CTX, { assist: 'classify' });
  const agree = await ask({ paths: ['src/a.ts'], checkIds: ['lint'] });
  assert.deepEqual([agree.sliceId, agree.reasonCode], ['bounded-edit', 'SLICE_JEV']);
  script = { slice: { choice: 'feature', probabilities: { feature: 0.45, refactor: 0.4 } }, risk: 0 };
  const low = await ask({ paths: ['src/b.ts', 'src/b2.ts'], checkIds: ['lint'] });
  assert.deepEqual([low.sliceId, low.source, low.reasonCode], ['bounded-edit', 'rules', 'SLICE_JEV_LOW_CONFIDENCE'], 'the rules slice is the fallback');
  script = { slice: { choice: 'unknown', probabilities: { unknown: 0.9 } }, risk: 0 };
  const unknown = await ask({ paths: ['src/c.ts', 'src/c2.ts', 'src/c3.ts'], checkIds: ['lint'] });
  assert.deepEqual([unknown.sliceId, unknown.reasonCode], ['bounded-edit', 'SLICE_JEV_UNKNOWN']);
  const noRules = await ask({ paths: ['assets/logo.png'] });
  assert.deepEqual([noRules.sliceId, noRules.source], [null, 'none'], 'no rules slice and no usable Jev answer: no slice');
  script = { slice: { choice: 'issue-fix', probabilities: { 'issue-fix': 0.9 } }, risk: 3 };
  const risky = await ask({ paths: ['src/d.ts', 'src/d2.ts', 'src/d3.ts', 'src/d4.ts'], checkIds: ['lint'] });
  assert.deepEqual([risky.sliceId, risky.source, risky.risk, risky.reasonCode], [null, 'none', 'high', 'SLICE_HIGH_RISK'], 'a high risk score keeps the baseline');
});

test('protected paths are high risk by the locked rules and never get a slice, whatever Jev says', async (t) => {
  const { engine } = await setup(t, JEV_FIX);
  const out = await core.classifyTaskSlice(engine, { paths: ['.github/workflows/ci.yml', 'src/a.ts'], checkIds: ['test'] }, CTX, { assist: 'classify' });
  assert.deepEqual([out.sliceId, out.risk, out.reasonCode], [null, 'high', 'SLICE_HIGH_RISK']);
  const lock = await core.classifyTaskSlice(engine, { paths: ['package-lock.json'] }, CTX, { assist: 'classify' });
  assert.equal(lock.sliceId, null);
});

test('egress denied: only structured features leave, never a path name or the title; approved adds the title as one span', async (t) => {
  const task = { title: 'fix the crash in the zebra parser', paths: ['src/zebra/lexer.ts', 'src/zebra/tokens.ts'], checkIds: ['test'] };
  const denied = await setup(t, JEV_FIX, { sourceEgress: DENIED });
  await core.classifyTaskSlice(denied.engine, task, CTX, { assist: 'classify' });
  const wire = JSON.stringify(denied.requests);
  assert.equal(denied.requests.length, 1);
  for (const leak of ['zebra', 'lexer', 'tokens.ts', 'crash']) assert.equal(wire.includes(leak), false, `${leak} must not leave while egress is denied`);
  assert.ok(wire.includes('"verb"') || wire.includes('verb'), 'the verb class is a feature');
  const approved = await setup(t, JEV_FIX, { sourceEgress: APPROVED });
  await core.classifyTaskSlice(approved.engine, task, CTX, { assist: 'classify' });
  const wire2 = JSON.stringify(approved.requests);
  assert.ok(wire2.includes('zebra parser'), 'with egress approved the title goes as one screened evidence span');
  assert.equal(wire2.includes('lexer.ts'), false, 'a path name is never sent, even when egress is approved');
});

test('jev.assist off asks no model and uses the rules; no engine is the rules answer too', async (t) => {
  const { engine, requests } = await setup(t, JEV_FIX);
  const off = await core.classifyTaskSlice(engine, SOURCE_TASK, CTX, { assist: 'off' });
  assert.deepEqual([off.sliceId, off.source, off.asked, off.reasonCode], ['bounded-edit', 'rules', false, 'SLICE_ASSIST_OFF']);
  const bare = await core.classifyTaskSlice(null, SOURCE_TASK, CTX, { assist: 'classify' });
  assert.deepEqual([bare.sliceId, bare.source, bare.reasonCode], ['bounded-edit', 'rules', 'PROVIDER_NOT_CONFIGURED']);
  assert.equal(requests.length, 0);
});

function opCtx(home, body, engine, extra = {}) {
  return {
    op: 'route', client: 'cli', scopes: ['status', 'advice'], workspace: { id: 'w-slice-op', root: null }, body, home,
    signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise', ...extra,
  };
}

async function route(home, body, engine, extra) {
  const out = await ops.route.handle(opCtx(home, body, engine, extra));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('route').validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

test('route op: a task with no sliceId is classified and routed under that slice; without a task nothing changes', async (t) => {
  const { home, engine, requests } = await setup(t, JEV_FIX);
  const bare = await route(home, { currentModel: 'claude-opus-5' }, engine);
  assert.equal(bare.main.reasonCode, 'UNKNOWN_SLICE');
  assert.equal(bare.slice, undefined, 'no task, no slice part');
  assert.equal(requests.length, 0);
  const out = await route(home, { currentModel: 'claude-opus-5', task: SOURCE_TASK }, engine);
  assert.notEqual(out.main.reasonCode, 'UNKNOWN_SLICE', 'the classified slice reached the router');
  assert.deepEqual([out.slice.sliceId, out.slice.source, out.slice.asked, out.slice.risk], ['issue-fix', 'jev', true, 'low']);
  assert.match(out.slice.text, /classified by Jev; advice only/);
  assert.equal(out.applied, false);
  const given = await route(home, { currentModel: 'claude-opus-5', sliceId: 'bounded-edit', task: SOURCE_TASK }, engine);
  assert.equal(given.slice, undefined, 'a given sliceId is used as is and nothing is classified');
});

test('route op: assist off or mode off classify by rules with no call; a malformed task is refused', async (t) => {
  const { home, engine, requests } = await setup(t, JEV_FIX);
  const off = await route(home, { currentModel: 'claude-opus-5', task: SOURCE_TASK }, engine, { jevAssist: 'off' });
  assert.deepEqual([off.slice.sliceId, off.slice.source, off.slice.asked, off.slice.reasonCode], ['bounded-edit', 'rules', false, 'SLICE_ASSIST_OFF']);
  const modeOff = await route(home, { currentModel: 'claude-opus-5', task: SOURCE_TASK }, engine, { mode: 'off' });
  assert.deepEqual([modeOff.slice.source, modeOff.slice.asked], ['rules', false]);
  assert.equal(requests.length, 0);
  for (const bad of [{ task: 'x' }, { task: { paths: 'a.ts' } }, { task: { extra: 1 } }, { task: { paths: [1] } }, { task: { checkIds: ['has space'] } }]) {
    const refused = await ops.route.handle(opCtx(home, { currentModel: 'claude-opus-5', ...bad }, engine));
    assert.equal(refused.reasonCode, 'INVALID_REQUEST', JSON.stringify(bad));
  }
});

test('route op: a slow Jev is abandoned at the deadline and the route answers with the rules slice', async (t) => {
  const { home, engine } = await setup(t, JEV_FIX, { delayMs: 3000 });
  const started = Date.now();
  const out = await route(home, { currentModel: 'claude-opus-5', task: SOURCE_TASK }, engine);
  const took = Date.now() - started;
  assert.ok(took < 2500, `the route did not wait for the slow call (${took} ms)`);
  assert.equal(out.slice.source, 'rules');
  assert.equal(out.slice.sliceId, 'bounded-edit');
  assert.match(out.slice.reasonCode, /DEADLINE|SLICE_JEV_/);
});

test('explain shows the classification: what was asked, what answered, the rules alternative and the evidence', async (t) => {
  const { home, engine } = await setup(t, JEV_FIX);
  const out = await route(home, { currentModel: 'claude-opus-5', task: SOURCE_TASK }, engine);
  assert.ok(out.slice.decisionId !== null, 'the classification is recorded');
  const explained = await ops.explain.handle(opCtx(home, { decisionId: out.slice.decisionId }, engine, { op: 'explain' }));
  assert.equal(explained.ok, true, JSON.stringify(explained));
  const text = JSON.stringify(explained.body);
  assert.match(text, /Slice classification: slice issue-fix \(classified by Jev, advice only\)/);
  assert.match(text, /Rules alternative: bounded-edit/);
  assert.match(text, /structured features only/);
  assert.match(text, /never a learned arm/);
  const plain = core.explainDecision(await engine.lookup(out.slice.decisionId));
  assert.match(plain, /Jev answered issue-fix with confidence 85 percent/);
});

test('a route with too little says what to supply: sliceId or task, and the warm prefix; a pin or a reasoned answer says nothing', async (t) => {
  const { home, engine } = await setup(t, JEV_FIX);
  const bare = await route(home, { currentModel: 'claude-opus-5' }, engine);
  assert.equal(bare.main.reasonCode, 'UNKNOWN_SLICE');
  assert.equal(bare.needs.length, 2);
  assert.match(bare.needs[0], /sliceId .*task \{ paths, checkIds, title \}/);
  assert.match(bare.needs[1], /session\.warmPrefixTokens/);
  assert.match(bare.main.text, /\(UNKNOWN_SLICE\)\..*To get a reasoned answer, pass: sliceId/);
  const withSession = await route(home, { currentModel: 'claude-opus-5', session: { warmPrefixTokens: 1000 } }, engine);
  assert.equal(withSession.needs.length, 1, 'the warm prefix was given, so only the slice is missing');
  const pinned = await route(home, { currentModel: 'claude-opus-5', modelPin: 'claude-opus-5' }, engine);
  assert.equal(pinned.needs, undefined);
  const classified = await route(home, { currentModel: 'claude-opus-5', task: SOURCE_TASK, session: { warmPrefixTokens: 1000 } }, engine);
  assert.equal(classified.needs, undefined, 'a classified task with a priced session needs nothing more');
});
