// C22 (the spans of a long check output) and C24 (project-memory entries) ask for all their items in one request of up to twelve
// questions, not one request per item (decision of 4 October 2026; the plan's slice labels do the same). Each item keeps its own
// answer, its own confidence floor, its own rules fallback and the 700 ms / deadline behaviour. Measured live on 2026-10-04
// (jev-1.13.0, 2 runs each): C22 with 8 spans took 8 requests, 474 to 556 ms and 273 micro-USD one by one, and 1 request, 244 to 284 ms
// and 165 micro-USD together; C24 with 10 entries took 10 requests, 637 to 673 ms and 230 micro-USD, and 1 request, 238 to 263 ms
// and 78 micro-USD. Here: a scripted engine for the contract, and the real answers of that run (numbers only) through the real
// engine and validators. No live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSidecarEngine } from '@jevris/provider-typesafe';
import { SCORE_BATCH_BYTES, SCORE_BATCH_ITEMS, admitProjectMemory, consultScore, consultScoreBatch, distillOutput, openWorkspace, retrieveProjectMemory } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const REAL = JSON.parse(readFileSync(new URL('./fixtures/score-batch-real.json', import.meta.url), 'utf8'));
const ANCHORS = ['Noise.', 'Background.', 'Useful.', 'Essential.'];
// C22's own anchors and instructions, which the question lint accepts (the real engine refuses anchors this short).
const C22_ANCHORS = ['Noise: nothing in this span helps with the task.', 'Background: context that rarely matters.', 'Useful: it helps with part of the task.', 'Essential: the task cannot be done without it.'];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** A scripted engine: `answerOf(id, question, index)` gives a Score answer (or null for none) to each question of a request; every request is kept. */
function scripted(answerOf, { egress = 'approved', delay = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  return {
    calls,
    peak: () => peak,
    sourceEgress: () => egress,
    async decide(request) {
      calls.push(request);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      inFlight -= 1;
      const answers = {};
      Object.entries(request.questions).forEach(([id, q], i) => {
        const a = answerOf(id, q, i, request);
        if (a !== null && a !== undefined) answers[id] = { type: 'score', ...a };
      });
      return { abstained: false, decisionId: `dec-${String(calls.length)}`, automation: 'advice', rulesOnly: false, result: { answers } };
    },
  };
}

const item = (i, text = `text of item ${String(i)}`) => ({ evidence: { id: `item-${String(i)}`, text, sourceKind: 'tool', priority: 'optional' }, rules: () => ({ score: 0.5, reasonCode: `RULES_${String(i)}` }) });
const consult = (over = {}) => ({ capabilityId: 'C22', specVersion: '1', sendsWorkspaceText: true, objective: 'Keep the output spans that help.', instructions: 'How useful is this span?', anchors: ANCHORS, noun: 'span', workspaceId: 'w-batch', evidenceRevision: 'rev', ...over });
/** A confident Score answer of `score` (its distribution sits on that level). */
const sure = (score, confidence = 0.9) => ({ score, confidence, probabilities: Object.fromEntries(ANCHORS.map((_, i) => [String(i), i === score ? confidence : Math.round(((1 - confidence) / 3) * 100) / 100])) });

test('items are asked together: one request of one Score question per item, each item led by its number, each answer on its own item', async () => {
  const engine = scripted((id, _q, i) => sure(i % 4));
  const items = [0, 1, 2, 3, 4].map((i) => item(i));
  const got = await consultScoreBatch(engine, consult({ items, shared: [{ id: 'question', text: 'the question', sourceKind: 'user', priority: 'mandatory' }] }));
  assert.equal(engine.calls.length, 1, 'one request for five items');
  const [request] = engine.calls;
  assert.deepEqual(Object.keys(request.questions), ['s0', 's1', 's2', 's3', 's4']);
  Object.entries(request.questions).forEach(([id, q], i) => {
    assert.deepEqual([q.type, q.criteria], ['score', ANCHORS], id);
    assert.equal(q.instructions, `How useful is this span? This question is about span ${String(i)}: the evidence item that begins "Span ${String(i)}:".`, 'a fixed template with only the number in it');
  });
  assert.deepEqual(request.packet.evidence.map((e) => e.id), ['question', 'item-0', 'item-1', 'item-2', 'item-3', 'item-4'], 'the shared evidence once, ahead of the items');
  assert.deepEqual(request.packet.evidence.map((e) => e.text), ['the question', ...[0, 1, 2, 3, 4].map((i) => `Span ${String(i)}: text of item ${String(i)}`)]);
  assert.equal(request.spec.id, 'd-c22');
  assert.deepEqual(got.map((r) => [r.source, r.value, r.reasonCode, r.decisionId]), [0, 1, 2, 3, 0].map((v) => ['jev', v, 'JEV_SCORE', 'dec-1']), 'each answer lands on its own item, and each names the request\'s decision');
  assert.deepEqual(got.map((r) => r.confidence), [0.9, 0.9, 0.9, 0.9, 0.9]);
});

test('each item has its own floor and its own fallback: an answer below 0.6, no answer and an out-of-range score are that item\'s rules, and the rest keep Jev', async () => {
  const engine = scripted((id, _q, i) => (i === 1 ? sure(2, 0.5) : i === 2 ? null : i === 3 ? { ...sure(1), score: 9 } : sure(3)));
  const got = await consultScoreBatch(engine, consult({ items: [0, 1, 2, 3, 4].map((i) => item(i)) }));
  assert.equal(engine.calls.length, 1);
  assert.deepEqual(got.map((r) => [r.source, r.value, r.reasonCode]), [['jev', 3, 'JEV_SCORE'], ['rules', 0.5, 'RULES_1'], ['rules', 0.5, 'RULES_2'], ['rules', 0.5, 'RULES_3'], ['jev', 3, 'JEV_SCORE']]);
  assert.equal(got[1].confidence, 0.5, 'what Jev reported is kept beside the rules answer');
  assert.equal(got[2].confidence, null);
});

test('twelve to a request: thirty items are three requests (12, 12 and 6), asked at once, answered in order', async () => {
  assert.equal(SCORE_BATCH_ITEMS, 12);
  const engine = scripted((id, _q, i, request) => sure(request.packet.evidence[i].text.endsWith('item 29') ? 3 : 1), { delay: 40 });
  const got = await consultScoreBatch(engine, consult({ items: Array.from({ length: 30 }, (_, i) => item(i)) }));
  assert.deepEqual(engine.calls.map((c) => Object.keys(c.questions).length), [12, 12, 6]);
  assert.equal(engine.peak(), 3, 'the three requests were in flight together');
  assert.equal(got.length, 30);
  assert.deepEqual(got.map((r) => r.value), got.map((_, i) => (i === 29 ? 3 : 1)), 'results are in the order of the items, whichever request answered');
  engine.calls.forEach((c) => assert.deepEqual(Object.keys(c.questions)[0], 's0', 'each request numbers its own items from 0'));
});

test('a request carries at most the byte budget of evidence: twelve items of 3-byte characters are cut into requests of ten and two', async () => {
  const engine = scripted(() => sure(1));
  const wide = '漢'.repeat(3000);
  const got = await consultScoreBatch(engine, consult({ items: Array.from({ length: 12 }, (_, i) => item(i, wide)) }));
  assert.deepEqual(engine.calls.map((c) => Object.keys(c.questions).length), [10, 2]);
  for (const c of engine.calls) assert.ok(Buffer.byteLength(JSON.stringify(c.packet)) < 131_072, 'under the request byte cap');
  assert.ok(SCORE_BATCH_BYTES < 131_072);
  assert.equal(got.every((r) => r.source === 'jev'), true);
});

test('one item is asked the single way (its own question, no number), so it shares the single-item decision cache', async () => {
  const engine = scripted(() => sure(2));
  const [only] = await consultScoreBatch(engine, consult({ items: [item(0)] }));
  assert.deepEqual(Object.keys(engine.calls[0].questions), ['q']);
  assert.equal(engine.calls[0].packet.evidence[0].text, 'text of item 0');
  const single = scripted(() => sure(2));
  const direct = await consultScore(single, { ...consult(), evidence: [item(0).evidence], rules: item(0).rules });
  assert.deepEqual([only.source, only.value, only.reasonCode], [direct.source, direct.value, direct.reasonCode]);
  assert.deepEqual((await consultScoreBatch(scripted(() => sure(1)), consult({ items: [] }))), [], 'no items, no request');
});

test('a request that is refused, abstains, fails or has no time gives every item its own rules answer; with egress denied a question that quotes text sends nothing', async () => {
  const items = [0, 1, 2].map((i) => item(i));
  const rules = (got) => got.map((r) => [r.source, r.value, r.reasonCode]);
  const expected = [['rules', 0.5, 'RULES_0'], ['rules', 0.5, 'RULES_1'], ['rules', 0.5, 'RULES_2']];
  const abstaining = { calls: 0, sourceEgress: () => 'approved', async decide() { this.calls += 1; return { abstained: true, reasonCode: 'BUDGET', decisionId: 'dec-x' }; } };
  const refused = await consultScoreBatch(abstaining, consult({ items }));
  assert.deepEqual(rules(refused), expected);
  assert.deepEqual(refused.map((r) => r.decisionId), ['dec-x', 'dec-x', 'dec-x'], 'the engine\'s record of the refusal is named');
  const throwing = { sourceEgress: () => 'approved', async decide() { throw new Error('boom'); } };
  assert.deepEqual(rules(await consultScoreBatch(throwing, consult({ items }))), expected);
  assert.deepEqual(rules(await consultScoreBatch(undefined, consult({ items }))), expected, 'no engine');
  const denied = scripted(() => sure(3), { egress: 'denied' });
  assert.deepEqual(rules(await consultScoreBatch(denied, consult({ items }))), expected);
  assert.equal(denied.calls.length, 0, 'egress denied: nothing quoted is sent, and nothing is asked');
  const short = scripted(() => sure(3));
  assert.deepEqual(rules(await consultScoreBatch(short, consult({ items, remainingMs: 200 }))), expected);
  assert.equal(short.calls.length, 0, 'too little time left for a call to finish: the rules answer');
  const late = scripted(() => sure(3));
  await consultScoreBatch(late, consult({ items, remainingMs: 1_000 }));
  assert.ok(late.calls[0].spec.deadlineMs <= 1_000 - 150, 'the request settles inside the time left');
});

// ------------------------------------------------------------------------------ C22 and C24 through their own functions

async function workspace(t) {
  const dir = tempDir('jv-sbatch-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  t.after(() => {
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  });
  return openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
}

test('C22: the spans of a long output are scored in one request, and each span\'s own score decides whether it is kept', async (t) => {
  const ws = await workspace(t);
  // Every span is a block of 20 lines; only some fit the budget, so the scores decide which.
  const lines = Array.from({ length: 1500 }, (_, i) => `noisy line number ${String(i)} of the check output`);
  const run = (engine) => distillOutput(ws, { command: 'make check', exitCode: 2, stdout: lines.join('\n'), budgetTokens: 1500, engine, egressApproved: true });
  const favouring = (block) => (id, _q, i, request) => (request.packet.evidence[i].id === `span-${String(block * 20)}` ? sure(3) : sure(0));
  const first = scripted(favouring(3));
  const a = await run(first);
  assert.equal(first.calls.length, 1, 'one request for the spans (was one per span)');
  const asked = Object.keys(first.calls[0].questions).length;
  assert.ok(asked >= 2 && asked <= 8, `${String(asked)} spans, at most 8`);
  assert.deepEqual(first.calls[0].packet.evidence.map((e) => e.id), Array.from({ length: asked }, (_, i) => `span-${String(i * 20)}`));
  assert.equal(a.source, 'jev');
  assert.ok(a.text.includes('noisy line number 60 of'), 'the span Jev scored highest is kept');
  const second = scripted(favouring(5));
  const b = await run(second);
  assert.ok(b.text.includes('noisy line number 100 of'), 'and another span when that one is the one Jev scored highest');
  assert.equal(b.text.includes('noisy line number 60 of'), false, 'each span\'s answer decided its own place');
  // A span whose answer is below the floor is the rules\' (score 0): the others still count.
  const lowOne = scripted((id, _q, i, request) => (request.packet.evidence[i].id === 'span-60' ? sure(3, 0.5) : sure(0)));
  const c = await run(lowOne);
  assert.equal(c.text.includes('noisy line number 60 of'), false, 'span 3 at confidence 0.5 is not trusted');
});

function entry(i) {
  return { scope: 'workspace:w1', kind: 'convention', text: `Project rule ${String(i)}: exports are kept thirty days.`, approvedBy: 'owner', revision: `r${String(i)}`, nowMs: 1_000_000 + i };
}

async function memory(t, count) {
  const ws = await workspace(t);
  for (let i = 0; i < count; i += 1) assert.equal((await admitProjectMemory(ws, { ...entry(i), scope: `workspace:${ws.workspaceId}` })).ok, true);
  return ws;
}

test('C24: entries are rescored in requests of twelve, each entry on its own answer, and the decision of each request is told once', async (t) => {
  const ws = await memory(t, 30);
  const query = 'Which project rules keep exports for thirty days?';
  const engine = scripted((id, _q, i, request) => sure(Number(/Project rule (\d+)/.exec(request.packet.evidence[i + 1].text)?.[1] ?? 0) === 17 ? 3 : 0));
  const told = [];
  const found = await retrieveProjectMemory(ws, { scopes: [`workspace:${ws.workspaceId}`], query, limit: 20, engine, egressApproved: true, onDecision: (id) => told.push(id) });
  assert.deepEqual(engine.calls.map((c) => Object.keys(c.questions).length), [12, 12, 6], 'thirty entries: three requests (was thirty)');
  engine.calls.forEach((c) => assert.deepEqual([c.packet.evidence[0].id, c.packet.evidence[0].text], ['question', query], 'the question once per request'));
  assert.deepEqual(told, ['dec-1', 'dec-2', 'dec-3'], 'one decision record per request, told once each');
  assert.equal(found.length, 20);
  assert.match(found[0].text, /Project rule 17:/, 'the entry Jev scored 3 comes first');
  assert.equal(found[0].score, 3);
  // Without the administrator\'s and the person\'s approval the lexical order stands and nothing is sent.
  const denied = scripted(() => sure(3), { egress: 'denied' });
  await retrieveProjectMemory(ws, { scopes: [`workspace:${ws.workspaceId}`], query, limit: 20, engine: denied, egressApproved: true });
  assert.equal(denied.calls.length, 0);
  const noPreference = scripted(() => sure(3));
  await retrieveProjectMemory(ws, { scopes: [`workspace:${ws.workspaceId}`], query, limit: 20, engine: noPreference });
  assert.equal(noPreference.calls.length, 0);
});

// ------------------------------------------------------------------------------ the real answers

/** Replays the real answers by question id (s0, s1, ...), through the real engine, validators and floors. */
async function realEngine(t, answers) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-sbatch-engine-'));
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const out = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const real = answers[id];
      out[id] = { type: 'score', score: real.score, probabilities: real.probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: real.confidence };
    }
    return new Response(JSON.stringify({ model: body.model, answers: out, usage: { input_tokens: 700, output_tokens: 100 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const engine = await createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' }) });
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return { engine, requests };
}

test('REAL answers, C22: eight spans in one request come back valid, five clear the floor of 0.6 and three are the rules\'', async (t) => {
  const { engine, requests } = await realEngine(t, REAL.c22.answers);
  const items = Array.from({ length: 8 }, (_, i) => item(i, `a span of the check output, number ${String(i)}`));
  const got = await consultScoreBatch(engine, consult({ items, instructions: 'How useful is this span of tool output for diagnosing the command result?', anchors: C22_ANCHORS }));
  assert.equal(requests.length, 1);
  assert.equal(Object.keys(requests[0].questions).length, 8);
  assert.deepEqual(got.map((r) => r.source), ['jev', 'jev', 'rules', 'jev', 'rules', 'jev', 'rules', 'jev'], 'real confidences 0.69 0.73 0.41 0.68 0.54 0.79 0.41 0.67');
  assert.deepEqual(got.map((r) => r.value), [0.87, 1.08, 0.5, 1.15, 0.5, 1.84, 0.5, 0.95]);
  assert.ok(got.every((r) => typeof r.decisionId === 'string'));
});

test('REAL answers, C24: ten entries in one request come back valid; the two below the floor keep their lexical score', async (t) => {
  const ws = await memory(t, 10);
  const { engine, requests } = await realEngine(t, REAL.c24.answers);
  const found = await retrieveProjectMemory(ws, { scopes: [`workspace:${ws.workspaceId}`], query: 'Which project rules keep exports for thirty days?', limit: 5, engine, egressApproved: true });
  assert.equal(requests.length, 1, 'ten entries, one request (was ten)');
  assert.equal(Object.keys(requests[0].questions).length, 10);
  assert.equal(found.length, 5);
  // The entries at questions s4 (2.17 at confidence 0.51) and s7 (1 at 0.42) are below the floor, so their lexical score (2, the same for all ten
  // here) stands; the next are Jev's own scores. Jev's 2.17 was not trusted, and the others are what it said.
  assert.deepEqual(found.map((e) => e.score), [2, 2, 0.25, 0.25, 0.17]);
});
