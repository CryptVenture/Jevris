// Owner decision 2026-10-01 (Jev as an active decision aid): Jev helps pick which approved checks
// matter first for the change in front of the agent. Rules order first and are sure when the change
// is all one role; Jev is asked from content-free features only when they are not, and every miss
// falls back to the rules order. Order only: every check is still in the answer. Scripted fetch and
// stub engines, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });

/**
 * A scripted Jev. `answer(id, kind, state, body)` gives `{ score, confidence? }`, or null for no
 * answer to that question. A `gate` promise holds every answer until it is opened.
 */
function scriptedFetch(answer, { gate = null } = {}) {
  const requests = [];
  let finished = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (gate !== null) await gate;
    const facts = body.state.facts;
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const [kind, state] = String(facts[id] ?? '|').split('|');
      const want = answer(id, kind, state, body);
      if (want === null) continue;
      // As the real model reports it: the score is the expected value of the distribution, the confidence its top probability.
      const level = want.score;
      const sure = want.confidence ?? 1;
      const rest = Math.round(((1 - sure) / (q.criteria.length - 1)) * 10000) / 10000;
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? sure : rest]));
      const expected = Math.round(Object.entries(probabilities).reduce((sum, [i, p]) => sum + Number(i) * p, 0) * 100) / 100;
      answers[id] = { type: 'score', score: expected, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: Math.max(...Object.values(probabilities)) };
    }
    finished += 1;
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests, finishedCount: () => finished };
}

async function setup(t, answer, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-relevance-'));
  let tracker = null;
  // A call the test abandoned (the deadline passed) still writes its budget, breaker and journal entries in this home: wait for that work, then remove the home.
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const script = scriptedFetch(answer, options);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: options.sourceEgress ?? APPROVED });
  tracker = trackEngine(engine);
  return { home, engine, script, requests: script.requests };
}

/** Waits for a state, with a generous bound; the wait ends as soon as it holds. */
async function until(condition, what) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, `${what} held before the generous bound`);
}

const CTX = { workspaceId: 'w-relevance' };
const ASK = { assist: 'classify', deadlineMs: 30_000 };
/** The kinds in the order the rules give them for a source change: test, typecheck (4), lint (3), docs (2). */
const CHECKS = [
  { id: 'docs-check', state: 'missing' },
  { id: 'lint', state: 'stale' },
  { id: 'typecheck', state: 'missing' },
  { id: 'unit-test', state: 'missing' },
];
// A source file and a doc: the change is not all one role, so the rules are not sure and Jev is asked.
const MIXED = ['src/billing/invoice.ts', 'docs/guide.md'];
const ids = (ranking) => [...ranking.order];

// ------------------------------------------------------------------ rules first

test('the rules order by the shape of the change; a failing check is first, a passing one last, no change keeps the usual order', () => {
  const checks = [
    { id: 'docs-check', state: 'missing' },
    { id: 'lint', state: 'missing' },
    { id: 'typecheck', state: 'missing' },
    { id: 'unit-test', state: 'missing' },
    { id: 'build', state: 'missing' },
  ];
  const order = (paths, list = checks) => ids(core.rulesOrderOf({ checks: list, paths }, 'CHECK_RELEVANCE_RULES_SURE'));
  assert.equal(order(['docs/guide.md', 'README.md'])[0], 'docs-check', 'a docs-only change needs the docs check first');
  assert.deepEqual(order(['docs/guide.md']).slice(0, 2), ['docs-check', 'lint'], 'and lint next');
  assert.deepEqual(order(['docs/guide.md']).slice(-3).sort(), ['build', 'typecheck', 'unit-test'], 'and the tests, the type check and the build least');
  assert.deepEqual(order(['.github/workflows/ci.yml', 'tsconfig.json']).slice(0, 2).sort(), ['build', 'lint'], 'a config change puts lint and build first');
  assert.deepEqual(order(['src/a.ts', 'src/b.ts']).slice(0, 2).sort(), ['typecheck', 'unit-test'], 'a source change puts the tests and the type check first');
  assert.deepEqual(order([]), checks.map((c) => c.id), 'with no change known the usual order stands');
  assert.deepEqual(order(null), checks.map((c) => c.id), 'and so does an unreadable one');
  const withStates = [{ ...checks[0], state: 'passing' }, { ...checks[1], state: 'failing' }, ...checks.slice(2)];
  const sourceOrder = order(['src/a.ts'], withStates);
  assert.equal(sourceOrder[0], 'lint', 'a failing last receipt is always first, whatever the change');
  assert.equal(sourceOrder.at(-1), 'docs-check', 'a check that already passes is last');
  const ranking = core.rulesOrderOf({ checks: withStates, paths: ['src/a.ts'] }, 'CHECK_RELEVANCE_RULES_SURE');
  assert.equal(ranking.firstWhy, 'failed');
  assert.match(ranking.text, /^Order is advice \(rules\): lint first, its last run failed\. No check is skipped or waived\.$/);
});

test('a change that is all one role is sure by the rules: Jev is not asked', async (t) => {
  const { engine, requests } = await setup(t, () => ({ score: 4 }));
  for (const paths of [['docs/a.md', 'README.md'], ['test/a.test.mjs', 'src/__tests__/b.ts'], ['tsconfig.json', '.github/workflows/ci.yml'], ['src/a.ts', 'src/b.ts']]) {
    const ranking = await core.rankChecks(engine, { checks: CHECKS, paths }, CTX, ASK);
    assert.deepEqual([ranking.source, ranking.reasonCode, ranking.asked], ['rules', 'CHECK_RELEVANCE_RULES_SURE', false], paths.join(' '));
  }
  assert.equal(requests.length, 0, 'a deterministic fact needs no model');
});

test('one check, no change known, no engine, jev.assist off, mode off and a stopped kill switch are the rules order with a reason, and no call', async (t) => {
  const { engine, requests } = await setup(t, () => ({ score: 4 }));
  const rank = (e, input, options) => core.rankChecks(e, input, CTX, { ...ASK, ...options });
  const one = await rank(engine, { checks: [CHECKS[0]], paths: MIXED });
  assert.equal(one.reasonCode, 'CHECK_RELEVANCE_TOO_FEW');
  assert.equal(one.decisionId, null, 'one check has no order to record');
  assert.equal((await rank(engine, { checks: CHECKS, paths: [] })).reasonCode, 'CHECK_RELEVANCE_NO_CHANGE');
  assert.equal((await rank(null, { checks: CHECKS, paths: MIXED })).reasonCode, 'CHECK_RELEVANCE_NO_PROVIDER');
  assert.equal((await rank(engine, { checks: CHECKS, paths: MIXED }, { assist: 'off' })).reasonCode, 'CHECK_RELEVANCE_ASSIST_OFF');
  assert.equal((await rank(engine, { checks: CHECKS, paths: MIXED }, { mode: 'off' })).reasonCode, 'CHECK_RELEVANCE_MODE_OFF');
  const killed = await rank(engine, { checks: CHECKS, paths: MIXED }, { killSwitchStopped: true });
  assert.deepEqual([killed.reasonCode, killed.decisionId], ['CHECK_RELEVANCE_KILL_SWITCH', null], 'a stopped kill switch records nothing');
  assert.equal((await rank(engine, { checks: CHECKS, paths: MIXED }, { deadlineMs: 100 })).reasonCode, 'CHECK_RELEVANCE_NO_TIME', 'too little time for a call to finish');
  assert.equal(requests.length, 0);
});

// ------------------------------------------------------------------ Jev

test('Jev ranks from features: one request of Score questions, an advisory record, then a cache hit with no second call', async (t) => {
  // Jev thinks the docs check matters most for this change, against the rules.
  const byKind = { docs: 4, lint: 3, test: 1, typecheck: 0 };
  const { engine, requests } = await setup(t, (_id, kind) => ({ score: byKind[kind] ?? 2 }));
  const first = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  assert.deepEqual(ids(first), ['docs-check', 'lint', 'unit-test', 'typecheck']);
  assert.deepEqual([first.source, first.reasonCode, first.asked, first.askedCount, first.usedCount, first.cacheHit], ['jev', 'CHECK_RELEVANCE_JEV', true, 4, 4, false]);
  assert.equal(first.firstWhy, 'jev');
  assert.match(first.text, /^Order is advice \(Jev\): docs-check first, Jev rated it most relevant to this change/);
  assert.equal(requests.length, 1, 'one request, however many checks');
  const questions = requests[0].questions;
  assert.deepEqual(Object.keys(questions), ['c1', 'c2', 'c3', 'c4'], 'one Score per open check, by position');
  assert.ok(Object.values(questions).every((q) => q.type === 'score' && q.criteria.length === 5), 'a 0 to 4 Score each');
  const record = await engine.lookup(first.decisionId);
  assert.equal(record.specId, 'check-relevance');
  assert.equal(record.outcome, 'advisory');
  assert.ok(record.reasonCodes.includes('RANK_SOURCE_JEV') && record.reasonCodes.includes('RANK_CHECKS_4') && record.reasonCodes.includes('CHECK_RELEVANCE_JEV'));
  assert.ok(record.proposedAction.evidenceIds.includes('feature-roles'), 'the evidence ids are feature names');
  assert.equal(typeof record.durationMs, 'number', 'the latency is recorded');
  const again = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  assert.deepEqual(ids(again), ids(first));
  assert.equal(again.cacheHit, true, 'the same features are answered from the decision cache');
  assert.equal(requests.length, 1, 'a cache hit makes no second call');
  assert.notEqual(again.decisionId, first.decisionId, 'each ranking is its own record');
});

test('a failing check stays first and a passing one last whatever Jev says; Jev is asked about the open checks only', async (t) => {
  const { engine, requests } = await setup(t, (_id, kind) => ({ score: kind === 'typecheck' ? 4 : 0 }));
  const checks = [
    { id: 'docs-check', state: 'passing' },
    { id: 'lint', state: 'failing' },
    { id: 'typecheck', state: 'missing' },
    { id: 'unit-test', state: 'stale' },
  ];
  const ranking = await core.rankChecks(engine, { checks, paths: MIXED }, CTX, ASK);
  assert.deepEqual(ids(ranking), ['lint', 'typecheck', 'unit-test', 'docs-check']);
  assert.equal(ranking.firstWhy, 'failed');
  assert.match(ranking.text, /lint first, its last run failed/);
  assert.deepEqual(Object.keys(requests[0].questions), ['c1', 'c2'], 'the failing and the passing check are not asked about');
  assert.equal(ranking.askedCount, 2);
});

test('a score below 0.6 confidence, no usable answer and a partly confident answer keep the rules where Jev was not sure', async (t) => {
  let script = () => ({ score: 4, confidence: 0.4 });
  const { engine } = await setup(t, (id, kind, state, body) => script(id, kind, state, body));
  const rules = ids(core.rulesOrderOf({ checks: CHECKS, paths: MIXED }, 'X'));
  // Each case has its own change features, so the decision cache of an earlier one never answers it.
  const ask = (paths) => core.rankChecks(engine, { checks: CHECKS, paths }, CTX, ASK);
  const low = await ask(['src/a.ts', 'docs/a.md']);
  assert.deepEqual([low.source, low.reasonCode, ids(low)], ['rules', 'CHECK_RELEVANCE_JEV_LOW_CONFIDENCE', rules]);
  assert.equal(low.asked, true, 'Jev was asked and its answer not used');
  assert.equal(low.usedCount, 0);
  // Two sure answers and two unsure ones: the sure ones are used, the rest keep their rules score.
  script = (_id, kind) => (kind === 'docs' ? { score: 4 } : kind === 'lint' ? { score: 0 } : { score: 4, confidence: 0.3 });
  const partial = await ask(['src/c.ts', 'src/c2.ts', 'docs/c.md']);
  assert.deepEqual([partial.source, partial.reasonCode, partial.usedCount], ['jev', 'CHECK_RELEVANCE_JEV_PARTIAL', 2]);
  assert.equal(ids(partial)[0], 'docs-check', 'the confident score is used');
  assert.equal(ids(partial).at(-1), 'lint', 'and the confident low one');
  // An answer with no usable score (the engine passes it through): the rules order.
  const empty = { decide: async () => ({ abstained: false, decisionId: 'd-00000000-0000-4000-8000-000000000002', result: { answers: {} }, automation: true, rulesOnly: false }), lookup: async () => null };
  const none = await core.rankChecks(empty, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  assert.deepEqual([none.source, none.reasonCode, ids(none)], ['rules', 'CHECK_RELEVANCE_JEV_NO_ANSWER', rules]);
  assert.equal(none.decisionId, null, 'an engine that cannot record still ranks; the ranking is then not recorded');
});

test('a Jev error, an open circuit and an exhausted budget keep the rules order with the reason in the code', async () => {
  const stub = (reasonCode) => ({
    decide: async () => ({ abstained: true, reasonCode, decisionId: 'd-00000000-0000-4000-8000-000000000001', fallback: 'rules-only' }),
    lookup: async () => null,
  });
  const rules = ids(core.rulesOrderOf({ checks: CHECKS, paths: MIXED }, 'X'));
  for (const [reason, expected] of [['CIRCUIT_OPEN', 'CHECK_RELEVANCE_JEV_CIRCUIT_OPEN'], ['BUDGET', 'CHECK_RELEVANCE_JEV_BUDGET'], ['DEADLINE', 'CHECK_RELEVANCE_JEV_DEADLINE']]) {
    const ranking = await core.rankChecks(stub(reason), { checks: CHECKS, paths: MIXED }, CTX, ASK);
    assert.deepEqual([ranking.source, ranking.reasonCode, ids(ranking)], ['rules', expected, rules], reason);
  }
  const throwing = { decide: async () => { throw new Error('boom'); }, lookup: async () => null };
  const failed = await core.rankChecks(throwing, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  assert.deepEqual([failed.source, failed.reasonCode, ids(failed)], ['rules', 'CHECK_RELEVANCE_ERROR', rules]);
});

test('a slow Jev is abandoned at the deadline and the rules order answers; the late answer only warms the cache', async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  // Opened first on the way out (hooks run in the order they were registered), so a test that failed with the gate shut does not wait for the call's own deadline.
  t.after(() => open());
  const byKind = { docs: 4, lint: 3, test: 1, typecheck: 0 };
  const { engine, requests, script } = await setup(t, (_id, kind) => ({ score: byKind[kind] ?? 2 }), { gate });
  const rules = ids(core.rulesOrderOf({ checks: CHECKS, paths: MIXED }, 'X'));
  // The caller's wait is the 150 ms under test; the late call itself gets a generous grace, so a loaded host cannot cut it off before it reaches the endpoint or finishes.
  const late = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, { assist: 'classify', deadlineMs: 150, lateGraceMs: 60_000 });
  assert.deepEqual([late.source, late.reasonCode, ids(late)], ['rules', 'CHECK_RELEVANCE_DEADLINE', rules], 'the caller did not wait for Jev');
  // On a loaded host the engine reaches the endpoint after the 150 ms: wait for the request, not for a fixed time.
  await until(() => requests.length === 1, 'the abandoned call reached the endpoint');
  assert.equal(script.finishedCount(), 0, 'Jev has not answered yet');
  open();
  await until(() => script.finishedCount() === 1, 'the late answer was sent');
  // The engine puts the late answer in the decision cache just after the response: wait for the entry, not for a fixed time.
  await until(() => engine.cache.stats().entries === 1, 'the late answer was cached');
  const warm = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  assert.deepEqual([warm.source, warm.cacheHit, ids(warm)], ['jev', true, ['docs-check', 'lint', 'unit-test', 'typecheck']], 'the late answer is in the cache for the next ranking');
  assert.equal(requests.length, 1, 'and cost no second call');
});

test('only features leave: no path name, no check name, no description and no objective text', async (t) => {
  const { engine, requests } = await setup(t, () => ({ score: 2 }), { sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  const checks = [
    { id: 'zebra-secret-suite', state: 'missing', description: 'runs the quagga billing tests against the staging vault' },
    { id: 'zebra-lint', state: 'stale', description: 'lint the whole zebra tree' },
  ];
  const paths = ['src/zebra/lexer.ts', 'src/zebra/tokens.ts', 'docs/quagga-notes.md', '.github/workflows/release.yml'];
  const ranking = await core.rankChecks(engine, { checks, paths }, { ...CTX, taskId: 'task-1' }, ASK);
  assert.equal(requests.length, 1);
  const wire = JSON.stringify(requests);
  for (const leak of ['zebra', 'lexer', 'tokens', 'quagga', 'vault', 'secret-suite', 'staging', 'release.yml', 'task-1']) assert.equal(wire.includes(leak), false, `${leak} must not leave`);
  const facts = requests[0].state.facts;
  assert.equal(facts.c1, 'test|missing', 'a check is its kind and its last result');
  assert.equal(facts.c2, 'lint|stale');
  assert.equal(facts.files, 4);
  assert.match(facts.extensions, /ts:2/);
  assert.equal(facts.protectedClasses.startsWith('PROTECTED_'), true, 'a protected class is a code, not a path');
  assert.equal(ranking.source, 'jev');
});

test('more than twelve open checks: twelve are asked, the rest keep their rules order, and nothing is dropped', async (t) => {
  const { engine, requests } = await setup(t, (id) => ({ score: Number(id.slice(1)) % 5 }));
  const checks = Array.from({ length: 15 }, (_, i) => ({ id: `test-${String(i + 1).padStart(2, '0')}`, state: 'missing' }));
  const ranking = await core.rankChecks(engine, { checks, paths: MIXED }, CTX, ASK);
  assert.equal(Object.keys(requests[0].questions).length, 12, 'the question cap');
  assert.deepEqual([ranking.capped, ranking.askedCount], [true, 12]);
  assert.deepEqual([...ids(ranking)].sort(), checks.map((c) => c.id).sort(), 'every check is in the order');
  assert.deepEqual(ids(ranking).slice(-3), ['test-13', 'test-14', 'test-15'], 'the checks past the cap come after, in their rules order');
  const record = await engine.lookup(ranking.decisionId);
  assert.ok(record.reasonCodes.includes('RANK_CAPPED'));
  assert.match(core.explainDecision(record), /More than 12 checks were open/);
});

test('observe mode asks and records the counterfactual; the record carries the task and session for the outcome join', async (t) => {
  const { engine } = await setup(t, () => ({ score: 2 }));
  const ranking = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, { ...CTX, taskId: 'task-9', sessionId: 'session-9' }, { ...ASK, mode: 'observe' });
  const record = await engine.lookup(ranking.decisionId);
  assert.deepEqual([record.taskId, record.sessionId, record.mode], ['task-9', 'session-9', 'observe']);
  const none = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, { ...ASK, record: false });
  assert.equal(none.decisionId, null, 'record: false records nothing');
});

// ------------------------------------------------------------------ properties

test('property: the order is a permutation of the checks, failing first and passing last, for any change and any Jev', async (t) => {
  let seed = 20261001;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const kinds = ['test', 'lint', 'typecheck', 'build', 'coverage', 'docs', 'generated', 'pack', 'misc'];
  const states = ['passing', 'failing', 'missing', 'stale'];
  const pathPool = ['src/a.ts', 'src/b.py', 'docs/a.md', 'README.md', 'test/a.test.mjs', 'package.json', '.github/workflows/ci.yml', 'assets/logo.png', 'package-lock.json'];
  const { engine } = await setup(t, (_id, _kind, _state) => (rand() < 0.2 ? null : { score: Math.floor(rand() * 5), confidence: rand() < 0.3 ? 0.3 : 0.9 }));
  for (let i = 0; i < 60; i += 1) {
    const count = Math.floor(rand() * 18);
    const checks = Array.from({ length: count }, (_, n) => ({ id: `${pick(kinds)}-${String(n)}`, state: pick(states) }));
    const paths = Array.from({ length: Math.floor(rand() * 6) }, () => pick(pathPool));
    const ranking = rand() < 0.5 ? await core.rankChecks(engine, { checks, paths }, CTX, { ...ASK, record: false }) : core.rulesOrderOf({ checks, paths }, 'X');
    const order = ids(ranking);
    assert.deepEqual([...order].sort(), checks.map((c) => c.id).sort(), `a permutation (${String(i)})`);
    const state = new Map(checks.map((c) => [c.id, c.state]));
    const tier = order.map((id) => (state.get(id) === 'failing' ? 0 : state.get(id) === 'passing' ? 2 : 1));
    assert.deepEqual(tier, [...tier].sort((a, b) => a - b), `failing first and passing last (${String(i)})`);
    const items = checks.map((c) => ({ name: c.id }));
    assert.deepEqual(core.applyCheckOrder(items, (x) => x.name, order).map((x) => x.name), order, 'applying the order gives the order');
  }
});

test('applyCheckOrder keeps every item: ids not named run after the named ones in their usual order', () => {
  const items = ['a', 'b', 'c', 'd'];
  assert.deepEqual(core.applyCheckOrder(items, (x) => x, ['c', 'a']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(core.applyCheckOrder(items, (x) => x, ['zzz', 'd']), ['d', 'a', 'b', 'c'], 'an unknown id is ignored');
  assert.deepEqual(core.applyCheckOrder(items, (x) => x, []), items);
  assert.deepEqual(core.applyCheckOrder(items, (x) => x, undefined), items);
});

// ------------------------------------------------------------------ explain

test('explain renders the ranking: the source, the shape, what was asked, the evidence, and that no check is dropped', async (t) => {
  const byKind = { docs: 4, lint: 3, test: 1, typecheck: 0 };
  const { engine } = await setup(t, (_id, kind) => ({ score: byKind[kind] ?? 2 }));
  const ranking = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  const text = core.explainDecision(await engine.lookup(ranking.decisionId));
  assert.match(text, /Check ranking: 4 approved checks ordered by how much this change needs them; the order is advice from Jev and decides nothing\./);
  assert.match(text, /Change shape: source edits\. First check: a docs check \(Jev rated it most relevant\)\./);
  assert.match(text, /Jev was asked about 4 checks and 4 scores were used \(asked Jev, \d+ ms\)\./);
  assert.match(text, /structured features only; no path names, diffs, check output or check names/);
  assert.match(text, /Every approved check still runs: the order never skips, waives or passes a check, and only receipts decide done\./);
  const rulesRanking = await core.rankChecks(engine, { checks: CHECKS, paths: ['docs/a.md'] }, CTX, ASK);
  const rulesText = core.explainDecision(await engine.lookup(rulesRanking.decisionId));
  assert.match(rulesText, /the order is advice from rules and decides nothing/);
  assert.match(rulesText, /Jev was not asked/);
  assert.match(rulesText, /Reason: CHECK_RELEVANCE_RULES_SURE\./);
});

test('jevris explain renders a recorded ranking through the explain op', async (t) => {
  const { home, engine } = await setup(t, () => ({ score: 2 }));
  const ranking = await core.rankChecks(engine, { checks: CHECKS, paths: MIXED }, CTX, ASK);
  const ctx = {
    op: 'explain', client: 'cli', scopes: ['status', 'advice'], workspace: { id: CTX.workspaceId, root: null }, body: { decisionId: ranking.decisionId }, home,
    signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise',
  };
  const out = await ops.explain.handle(ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('explain').validate(out.body).ok, true, JSON.stringify(out.body));
  const text = JSON.stringify(out.body);
  assert.match(text, /Check ranking: 4 approved checks ordered by how much this change needs them/);
  assert.match(text, /the order is advice from (Jev|rules) and decides nothing/);
  assert.match(text, /Every approved check still runs/);
});

test('check kinds come from the id, then the description, and an unknown id is other', () => {
  assert.equal(core.relevanceKindOf('unit-test'), 'test');
  assert.equal(core.relevanceKindOf('tsc'), 'typecheck');
  assert.equal(core.relevanceKindOf('eslint'), 'lint');
  assert.equal(core.relevanceKindOf('check-links'), 'docs');
  assert.equal(core.relevanceKindOf('release-pack'), 'pack');
  assert.equal(core.relevanceKindOf('zzz', 'runs the integration suite'), 'test');
  assert.equal(core.relevanceKindOf('zzz'), 'other');
});
