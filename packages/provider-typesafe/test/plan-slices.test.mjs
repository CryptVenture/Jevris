// Owner decision 2026-10-01 (Jev as an active decision aid): every task of a plan that does not name
// its own slice gets a slice suggestion and a risk hint from the route classifier, shown beside the
// task. A label for a person: never part of the plan, never a learned arm, never an actuation.
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
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

/**
 * A scripted Jev: `answer(id, question)` gives `{ choice, probabilities }` or `{ score }`; every
 * request body is recorded. `hang` makes a request that never answers (it ends only when aborted).
 */
function scriptedFetch(answer, { hang = false } = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (hang) {
      await new Promise((_resolve, reject) => {
        const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) stop();
        else init.signal?.addEventListener('abort', stop, { once: true });
      });
    }
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
// The tasks that need Jev go together, six to a request, so the questions are `slice0`, `risk0`, `slice1`, ... (a request of one task keeps `slice` and `risk`).
const isSlice = (id) => /^slice\d*$/.test(id);
const isRisk = (id) => /^risk\d*$/.test(id);
const JEV_FIX = (id) => (isSlice(id) ? { choice: 'issue-fix', probabilities: { 'issue-fix': 0.85 } } : { score: 1 });

async function setup(t, answer = JEV_FIX, { sourceEgress = DENIED, hang = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-plan-slices-'));
  let tracker = null;
  // A question the plan abandoned at its shared deadline still settles the budget and the breaker and ends its journal entry in this home: wait for that work, then remove the home.
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const script = scriptedFetch(answer, { hang });
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests };
}

let workspaceCounter = 0;
function opCtx(home, body, engine, extra = {}) {
  workspaceCounter += 1;
  return {
    op: 'plan', client: 'cli', scopes: ['status', 'advice'], workspace: { id: `w-plan-slices-${workspaceCounter}`, root: null }, body, home,
    signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise', ...extra,
  };
}

function node(id, extra = {}) {
  return {
    id, schemaVersion: '1.0', workspaceId: 'ws1', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [],
    writeScopes: [], acceptanceCheckIds: [], rootBudgetId: 'b1', ...extra,
  };
}

/** Two ordinary source files and a test check: the rules call it a weak bounded-edit, so Jev is asked. */
const SOURCE = (id, extra = {}) => node(id, { writeScopes: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], acceptanceCheckIds: ['unit-test'], ...extra });

async function plan(home, body, engine, extra) {
  const out = await ops.plan.handle(opCtx(home, body, engine, extra));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('plan').validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

/** The per-task label records in the engine's journal (not the Jev calls, which are slice-classify records too). */
async function advisoryCount(engine) {
  let n = 0;
  for (const id of await engine.journal.list()) {
    const record = (await engine.entry(id))?.record;
    if (record?.specId === 'slice-classify' && record.reasonCodes.includes('SLICE_PLAN_TASK')) n += 1;
  }
  return n;
}

const byTask = (body) => Object.fromEntries((body.sliceSuggestions ?? []).map((s) => [s.taskId, s]));
const byList = (list) => Object.fromEntries(list.map((x) => [x.taskId, x]));

/**
 * The suggestion step itself, with a wait long enough that a loaded runner cannot cut a question
 * short (the op caps the wait at 700 ms, which is the product's choice and is tested through the op
 * below, where the answer may be Jev's or the rules'). Used where a test needs Jev's answer.
 */
async function labels(engine, tasks, { workspaceId = 'w-plan-slices-direct', options = {} } = {}) {
  const order = core.planTaskGraph(tasks).order;
  return core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId, evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 30_000, totalMs: 60_000, ...options });
}

/** An engine that answers every slice question `choice` at once, with no disk and no clock: what the op does with an answer, not how long one takes. */
function stubEngine(choice = 'issue-fix', { together = 0 } = {}) {
  const decides = [];
  const recorded = [];
  let arrived;
  const allArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  return {
    decides,
    recorded,
    providerConfigured: true,
    sourceEgress: () => 'denied',
    async decide(request) {
      decides.push(request);
      // `together: n` holds every answer until n questions have been asked, so a test can show they are asked at the same time without timing anything.
      if (together > 0) {
        if (decides.length >= together) arrived();
        await allArrived;
      }
      // One answer per question the request carries: a request of several tasks has `slice0`, `risk0`, `slice1`, ...
      const answers = {};
      for (const id of Object.keys(request.questions)) {
        answers[id] = isSlice(id) ? { type: 'choice', choice, probabilities: { [choice]: 0.9, unknown: 0.1 }, confidence: 0.9 } : { type: 'score', score: 1, probabilities: { 1: 1 }, confidence: 1 };
      }
      return { abstained: false, decisionId: `d-stub-call-${decides.length}`, automation: true, rulesOnly: false, result: { answers } };
    },
    async lookup() {
      return { reasonCodes: [] };
    },
    async recordAdvice(input) {
      recorded.push(input);
      return { ok: true, decisionId: `d-stub-advice-${recorded.length}` };
    },
  };
}

test('a mixed plan: each task is labelled, rules answer where sure, Jev for the rest, a protected path gets no slice and high risk', async (t) => {
  const { engine, requests } = await setup(t);
  const tasks = [
    node('DOC', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] }),
    node('TST', { writeScopes: ['test/a.test.mjs', 'src/__tests__/b.ts'], acceptanceCheckIds: ['unit-test'] }),
    SOURCE('SRC'),
    node('CI', { writeScopes: ['.github/workflows/ci.yml', 'src/a.ts'], acceptanceCheckIds: ['unit-test'] }),
    node('NONE'),
  ];
  const list = await labels(engine, tasks);
  const s = byList(list);
  assert.deepEqual(list.map((x) => x.taskId).sort(), ['CI', 'DOC', 'NONE', 'SRC', 'TST']);
  assert.deepEqual([s.DOC.slice, s.DOC.source, s.DOC.reasonCode], ['docs', 'rules', 'SLICE_RULES_SURE']);
  assert.deepEqual([s.TST.slice, s.TST.source], ['test-fix', 'rules']);
  assert.deepEqual([s.SRC.slice, s.SRC.source, s.SRC.risk, s.SRC.reasonCode, s.SRC.confidencePercent], ['issue-fix', 'jev', 'low', 'SLICE_JEV_OVER_RULES', 85]);
  assert.deepEqual([s.CI.slice, s.CI.risk, s.CI.source, s.CI.reasonCode], [null, 'high', 'none', 'SLICE_HIGH_RISK'], 'a protected path never gets a slice, whatever Jev says');
  assert.deepEqual([s.NONE.slice, s.NONE.source, s.NONE.reasonCode], [null, 'none', 'SLICE_NO_FEATURES']);
  // Jev was asked for SRC only. The rules were sure for the docs and test tasks, had nothing for NONE, and a
  // protected path (CI) is a high risk by the locked rules whatever Jev says, so its answer could not change
  // anything: it is not asked (live, every protected shape spent a call and about 280 ms to end the same way).
  assert.equal(requests.length, 1);
  // Each classified task has its own recorded advisory decision, with the task's id.
  for (const id of ['DOC', 'TST', 'SRC', 'CI', 'NONE']) assert.ok(s[id].decisionId !== null, `${id} is recorded`);
  const record = await engine.lookup(s.SRC.decisionId);
  assert.equal(record.specId, 'slice-classify');
  assert.equal(record.taskId, undefined, 'a plan check records no task id: its tasks do not exist');
  assert.ok(record.reasonCodes.includes('SLICE_PLAN_TASK') && record.reasonCodes.includes('SLICE_SOURCE_JEV') && record.reasonCodes.includes('SLICE_ID_ISSUE_FIX'));
  assert.equal(record.outcome, 'advisory');
});

test('a slice the plan declared is kept as given; the classifier is recorded beside it (agree and differ), so Jev can be scored later', async (t) => {
  const { home, engine } = await setup(t);
  const here = { workspace: { id: 'w-plan-slices-declared', root: null } };
  const s = byList(await labels(engine, [SOURCE('SAME', { sliceId: 'issue-fix' }), SOURCE('DIFF', { sliceId: 'refactor', writeScopes: ['src/other/a.ts', 'src/other/b.ts', 'src/other/c.ts'] })], { workspaceId: 'w-plan-slices-declared' }));
  assert.deepEqual([s.SAME.slice, s.SAME.source, s.SAME.suggestedSlice, s.SAME.suggestedBy, s.SAME.agrees], ['issue-fix', 'given', 'issue-fix', 'jev', true]);
  assert.deepEqual([s.DIFF.slice, s.DIFF.source, s.DIFF.suggestedSlice, s.DIFF.suggestedBy, s.DIFF.agrees], ['refactor', 'given', 'issue-fix', 'jev', false]);
  const same = await engine.lookup(s.SAME.decisionId);
  assert.ok(['SLICE_PLAN_TASK', 'SLICE_GIVEN_ISSUE_FIX', 'SLICE_AGREE'].every((c) => same.reasonCodes.includes(c)), same.reasonCodes.join(','));
  const diff = await engine.lookup(s.DIFF.decisionId);
  assert.ok(['SLICE_PLAN_TASK', 'SLICE_GIVEN_REFACTOR', 'SLICE_DIFFER'].every((c) => diff.reasonCodes.includes(c)), diff.reasonCodes.join(','));
  assert.equal(same.taskId, undefined, 'a plan check records no task id: its tasks do not exist');
  // explain says so in words.
  const text = core.explainDecision(diff);
  assert.match(text, /Plan task: the plan declared slice refactor, which stands; the classifier differs/);
  const explained = await ops.explain.handle(opCtx(home, { decisionId: s.SAME.decisionId }, engine, { ...here, op: 'explain' }));
  assert.match(JSON.stringify(explained.body), /the plan declared slice issue-fix, which stands; the classifier agrees/);
});

function capTasks() {
  const tasks = [];
  for (let files = 1; files <= 5; files += 1) {
    for (const check of ['unit-test', 'lint']) {
      const paths = Array.from({ length: files }, (_, i) => `src/m${files}/f${i}.ts`);
      tasks.push(node(`T${files}${check === 'lint' ? 'L' : 'U'}`, { writeScopes: paths, acceptanceCheckIds: [check] }));
    }
  }
  // An eleventh, distinct task that declares its slice: it goes last, so the cap spares the readers' suggestions.
  tasks.push(node('DECL', { writeScopes: ['src/z/a.ts', 'src/z/b.ts', 'src/z/c.ts', 'src/z/d.ts', 'src/z/e.ts'], acceptanceCheckIds: ['unit-test', 'lint'], sliceId: 'feature' }));
  return tasks;
}

test('the cap: at most 8 distinct tasks asked per plan (in two requests), the rest get the rules answer with PLAN_JEV_CAP; tasks without a declared slice are served first', async () => {
  // The step itself, with a wait long enough that a slow runner cannot cut a question short: the
  // number of questions asked is then the cap and nothing else. The engine is the stub (no disk): with
  // eight real calls at once on a loaded host, one was seen not to reach the provider (7 requests of 8).
  // The real engine can fall back to the rules before it sends, for example when its wait for the budget
  // file's lock passes 2 s, which is its behaviour and not the cap's.
  const engine = stubEngine();
  const tasks = capTasks();
  const order = core.planTaskGraph(tasks).order;
  const list = await core.suggestPlanSlices(engine, core.planSliceTasksOf(tasks, order), { workspaceId: 'w-plan-slices-cap', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 30_000, totalMs: 60_000 });
  // Eight tasks, two questions each, at most twelve questions to a request: six tasks in one request and two in another.
  assert.deepEqual(engine.decides.map((d) => Object.keys(d.questions).length).sort((a, b) => a - b), [4, 12], 'eight tasks asked in two requests, no more');
  assert.equal(engine.decides.reduce((n, d) => n + Object.keys(d.questions).filter(isSlice).length, 0), 8, 'eight tasks asked, no more');
  const capped = list.filter((x) => x.reasonCode === 'PLAN_JEV_CAP');
  assert.equal(capped.length, 3);
  assert.ok(capped.some((x) => x.taskId === 'DECL'), 'the declared task is among the capped');
  assert.ok(capped.filter((x) => x.taskId !== 'DECL').every((x) => x.slice === 'bounded-edit' && x.source === 'rules'), 'a capped task keeps the rules answer');
  assert.equal(list.filter((x) => x.source === 'jev').length, 8);
  assert.equal(list.length, 11);
});

test('the cap through the op: the same plan is capped the same way, whatever time the runner gives the questions', async (t) => {
  const { home, engine, requests } = await setup(t);
  const body = await plan(home, { tasks: capTasks() }, engine);
  const list = body.sliceSuggestions;
  assert.equal(list.length, 11);
  // Which tasks are capped is decided before anything is asked, so it never depends on the clock.
  const capped = list.filter((x) => x.reasonCode === 'PLAN_JEV_CAP');
  assert.equal(capped.length, 3);
  assert.ok(capped.some((x) => x.taskId === 'DECL'));
  // A request the shared wait cuts short is the rules answer: at most two went out (eight tasks, six to a request), and every label that is not Jev's is the rules'.
  assert.ok(requests.length <= 2, `${requests.length} requests`);
  assert.ok(list.every((x) => x.source === 'jev' || x.source === 'rules' || x.source === 'given'));
  assert.ok(list.filter((x) => x.source === 'jev').length <= 8);
});

test('one shared deadline: a provider that never answers does not hold the plan; every label is the rules answer', async (t) => {
  const { home, engine, requests } = await setup(t, JEV_FIX, { hang: true });
  const tasks = [SOURCE('A'), SOURCE('B', { writeScopes: ['src/x/a.ts'] }), SOURCE('C', { writeScopes: ['src/y/a.ts', 'src/y/b.ts', 'src/y/c.ts'] })];
  const started = Date.now();
  const body = await plan(home, { tasks }, engine);
  const took = Date.now() - started;
  // The questions share one wait (700 ms at most), not one wait each. A generous bound for slow runners.
  assert.ok(took < 6000, `the plan did not wait for the hung provider (${took} ms)`);
  // Whether the request had reached the provider when the wait ended depends on how fast the host does the engine's journal writes, so the count is bounded here; that the tasks go out together is the next test, with no clock.
  assert.ok(requests.length <= 1, `${requests.length} requests for three tasks (one request)`);
  for (const x of body.sliceSuggestions) {
    assert.deepEqual([x.slice, x.source], ['bounded-edit', 'rules'], x.taskId);
    // The plan's wait or the engine's own deadline (the same wait), whichever came first: the plan says PLAN_JEV_DEADLINE either way (JEV-0059).
    assert.equal(x.reasonCode, 'PLAN_JEV_DEADLINE');
  }
  assert.equal(body.valid, true);
});

test('the requests of a plan are asked together, not one after another: both are out before either is answered', async () => {
  // Eight tasks make two requests (six and two). The engine holds every answer until the second request has been asked. A plan that asked one request at a time would never get there and every label would be the rules' at the deadline. Nothing here is timed: the bound is the generous 30 s wait of `labels`, and no disk is involved.
  const engine = stubEngine('issue-fix', { together: 2 });
  const tasks = Array.from({ length: 8 }, (_, i) => SOURCE(`T${i}`, { writeScopes: Array.from({ length: i + 1 }, (_, k) => `src/m${i}/f${k}.ts`) }));
  const list = await labels(engine, tasks);
  assert.equal(engine.decides.length, 2, 'the two requests were asked together');
  assert.deepEqual(list.map((x) => x.source), tasks.map(() => 'jev'), 'and every task was answered by Jev, none cut short');
});

test('three tasks that need Jev are one request of six questions, and each task keeps its own answer', async () => {
  const engine = stubEngine('issue-fix');
  const tasks = [SOURCE('A'), SOURCE('B', { writeScopes: ['src/x/a.ts'] }), SOURCE('C', { writeScopes: ['src/y/a.ts', 'src/y/b.ts', 'src/y/c.ts'] })];
  const list = await labels(engine, tasks);
  assert.equal(engine.decides.length, 1, 'one request for three tasks');
  assert.deepEqual(Object.keys(engine.decides[0].questions), ['slice0', 'risk0', 'slice1', 'risk1', 'slice2', 'risk2']);
  assert.deepEqual(list.map((x) => [x.taskId, x.source, x.slice]), [['A', 'jev', 'issue-fix'], ['B', 'jev', 'issue-fix'], ['C', 'jev', 'issue-fix']]);
});

test('identical tasks share one question and the decision cache; a repeated plan makes no new call and records no label twice', async (t) => {
  const { engine, requests } = await setup(t);
  const same = { workspaceId: 'w-plan-slices-same' };
  // Different names, same features: they are one question.
  const tasks = [SOURCE('A'), SOURCE('B', { writeScopes: ['lib/one.ts', 'lib/two.ts'] }), SOURCE('C', { writeScopes: ['app/p.ts', 'app/q.ts'] })];
  const first = await labels(engine, tasks, same);
  assert.equal(requests.length, 1);
  assert.deepEqual(first.map((x) => [x.slice, x.source]), [['issue-fix', 'jev'], ['issue-fix', 'jev'], ['issue-fix', 'jev']]);
  const ids = first.map((x) => x.decisionId);
  assert.equal(new Set(ids).size, 3, 'one decision per task');
  assert.equal(await advisoryCount(engine), 3);
  const second = await labels(engine, tasks, same);
  assert.equal(requests.length, 1, 'the repeated plan made no provider call');
  assert.deepEqual(second.map((x) => x.decisionId), ids, 'the same decisions, not new ones');
  assert.equal(await advisoryCount(engine), 3, 'no label was recorded again');
  // A plan of different tasks with the same shape is answered from the decision cache too.
  const other = await labels(engine, [SOURCE('Z', { writeScopes: ['x/y.ts', 'x/z.ts'] })], same);
  assert.equal(requests.length, 1, 'the same features are a cache hit');
  assert.equal(other[0].source, 'jev');
});

test('jev.assist off, mode off and a stopped kill switch ask no model; below observe and with the kill switch nothing is recorded; the labels say rules', async (t) => {
  const { home, engine, requests } = await setup(t);
  const tasks = [SOURCE('A'), node('D', { writeScopes: ['README.md'], acceptanceCheckIds: ['unit-test'] })];
  const before = await advisoryCount(engine);
  const off = byList(await labels(engine, tasks, { options: { assist: 'off' } }));
  assert.deepEqual([off.A.slice, off.A.source, off.A.reasonCode, off.D.slice], ['bounded-edit', 'rules', 'SLICE_ASSIST_OFF', 'docs']);
  assert.notEqual(off.A.decisionId, null, 'assist off still records the rules label (a record, not a call)');
  const modeOff = byList(await labels(engine, tasks, { options: { mode: 'off' } }));
  assert.deepEqual([modeOff.A.source, modeOff.A.reasonCode], ['rules', 'PLAN_JEV_MODE_OFF']);
  assert.equal(modeOff.A.decisionId, null, 'below observe nothing is recorded');
  const stopped = byList(await labels(engine, tasks, { options: { killSwitchStopped: true } }));
  assert.deepEqual([stopped.A.source, stopped.A.reasonCode, stopped.A.decisionId], ['rules', 'PLAN_JEV_KILL_SWITCH', null]);
  assert.equal(requests.length, 0);
  assert.equal(await advisoryCount(engine), before + 2, 'only the assist-off run recorded (two tasks)');
  assert.equal((await engine.journal.list()).length, before + 2, 'and no Jev call was made');
  // No engine at all: the rules answer, no record.
  const bare = byTask(await plan(home, { tasks }, undefined));
  assert.deepEqual([bare.A.slice, bare.A.source, bare.A.reasonCode, bare.A.decisionId], ['bounded-edit', 'rules', 'PROVIDER_NOT_CONFIGURED', null]);
});

test('gates come before the clock: with no time at all, assist off, mode off and a stopped kill switch keep their own reason, and only a request with no gate says PLAN_JEV_NO_TIME', async (t) => {
  // The route op had this order wrong (CI run 37169809446: assist off answered SLICE_DEADLINE on a slow machine); the plan
  // already had it right, and this keeps it: a gate is the reason whatever the clock says.
  const { engine, requests } = await setup(t);
  const tasks = [SOURCE('A')];
  const spent = { deadlineMs: 0, totalMs: 0 };
  const off = byList(await labels(engine, tasks, { options: { assist: 'off', record: false, ...spent } }));
  assert.deepEqual([off.A.source, off.A.reasonCode], ['rules', 'SLICE_ASSIST_OFF']);
  const modeOff = byList(await labels(engine, tasks, { options: { mode: 'off', ...spent } }));
  assert.deepEqual([modeOff.A.source, modeOff.A.reasonCode], ['rules', 'PLAN_JEV_MODE_OFF']);
  const stopped = byList(await labels(engine, tasks, { options: { killSwitchStopped: true, mode: 'off', ...spent } }));
  assert.deepEqual([stopped.A.source, stopped.A.reasonCode], ['rules', 'PLAN_JEV_KILL_SWITCH'], 'the kill switch before the mode');
  const noTime = byList(await labels(engine, tasks, { options: { record: false, ...spent } }));
  assert.deepEqual([noTime.A.source, noTime.A.reasonCode], ['rules', 'PLAN_JEV_NO_TIME']);
  assert.equal(requests.length, 0, 'no gate and no lack of time asks a model');
});

test('through the op, with an engine that answers at once: the answer reaches the plan result, the gates the op reads (jev.assist, mode, kill switch) hold, and the graph is the same', async (t) => {
  const { home } = await setup(t);
  const engine = stubEngine('refactor');
  const tasks = [SOURCE('A'), node('D', { writeScopes: ['docs/guide.md'], acceptanceCheckIds: ['unit-test'] }), SOURCE('P', { sliceId: 'bounded-edit' })];
  const body = await plan(home, { tasks }, engine);
  const { sliceSuggestions, ...rest } = body;
  assert.deepEqual(rest, core.planTaskGraph(tasks), 'the plan answer is the graph, with or without labels');
  const s = byTask(body);
  assert.deepEqual([s.A.slice, s.A.source, s.A.decisionId !== null], ['refactor', 'jev', true]);
  assert.deepEqual([s.D.slice, s.D.source], ['docs', 'rules']);
  assert.deepEqual([s.P.slice, s.P.source, s.P.suggestedSlice, s.P.suggestedBy, s.P.agrees], ['bounded-edit', 'given', 'refactor', 'jev', false]);
  assert.equal(engine.decides.length, 1, 'tasks with the same features share one question');
  assert.ok(engine.recorded.every((r) => !Object.hasOwn(r, 'taskId')), 'a plan check records no task id: its tasks do not exist');
  assert.ok(engine.recorded.every((r) => r.specId === 'slice-classify' && r.reasonCodes.includes('SLICE_PLAN_TASK')));
  // The gates the op reads: none of them asks again.
  const off = byTask(await plan(home, { tasks }, engine, { jevAssist: 'off' }));
  assert.deepEqual([off.A.slice, off.A.source, off.A.reasonCode], ['bounded-edit', 'rules', 'SLICE_ASSIST_OFF']);
  const modeOff = byTask(await plan(home, { tasks }, engine, { mode: 'off' }));
  assert.deepEqual([modeOff.A.source, modeOff.A.reasonCode, modeOff.A.decisionId], ['rules', 'PLAN_JEV_MODE_OFF', null]);
  const stopped = byTask(await plan(home, { tasks }, engine, { killSwitchStopped: true }));
  assert.deepEqual([stopped.A.source, stopped.A.reasonCode, stopped.A.decisionId], ['rules', 'PLAN_JEV_KILL_SWITCH', null]);
  assert.equal(engine.decides.length, 1, 'no gate asked a model');
});

test('a plan with too little time does not ask Jev (PLAN_JEV_NO_TIME) and still answers', async (t) => {
  const { home, engine, requests } = await setup(t);
  const tight = byTask(await plan(home, { tasks: [SOURCE('A')] }, engine, { deadline: createDeadline(250) }));
  assert.deepEqual([tight.A.source, tight.A.reasonCode], ['rules', 'PLAN_JEV_NO_TIME']);
  assert.equal(requests.length, 0);
});

test('egress denied: no path name, title or check name leaves; approved adds only the title, one span per distinct task, and still no path', async (t) => {
  const tasks = [
    node('A', { writeScopes: ['src/zebra/lexer.ts', 'src/zebra/tokens.ts'], acceptanceCheckIds: ['zebra-unit-test'], title: 'fix the zebra crash' }),
    node('B', { writeScopes: ['src/giraffe/neck.ts'], acceptanceCheckIds: ['giraffe-lint'], title: 'add giraffe support' }),
  ];
  const denied = await setup(t, JEV_FIX, { sourceEgress: DENIED });
  await labels(denied.engine, tasks);
  const wire = JSON.stringify(denied.requests);
  assert.equal(denied.requests.length, 1, 'two tasks, one request');
  for (const leak of ['zebra', 'lexer', 'tokens', 'crash', 'giraffe', 'neck', 'support']) assert.equal(wire.includes(leak), false, `${leak} must not leave while egress is denied`);
  assert.ok(wire.includes('verb'), 'the verb class is a feature');
  // Not even a withheld title: the question is built without the span, so the engine has nothing to hold back.
  for (const body of denied.requests) assert.deepEqual([body.state.untrustedEvidence, body.state.withheldEvidence], [[], []], 'no title span, and none withheld either');
  const approved = await setup(t, JEV_FIX, { sourceEgress: APPROVED });
  await labels(approved.engine, tasks);
  const wire2 = JSON.stringify(approved.requests);
  assert.ok(wire2.includes('fix the zebra crash') && wire2.includes('add giraffe support'), 'with egress approved the title goes as one screened span');
  assert.equal(approved.requests[0].state.untrustedEvidence.length, 2, 'one span per task, each led by its task');
  assert.ok(approved.requests[0].state.untrustedEvidence.every((span, i) => span.text.startsWith(`Task ${i} title: `)));
  for (const leak of ['lexer', 'tokens', 'neck', 'zebra-unit', 'giraffe-lint']) assert.equal(wire2.includes(leak), false, `${leak} never leaves, even with egress approved`);
  // The recorded decisions carry reason codes and feature names only.
  const ids = await denied.engine.journal.list();
  for (const id of ids) assert.equal(JSON.stringify(await denied.engine.entry(id)).includes('zebra'), false);
});

test('tasks that differ only in their title are one question while egress is denied, because the title is not sent; approved, each title is its own task in one request', async (t) => {
  const same = { writeScopes: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], acceptanceCheckIds: ['unit-test'] };
  const tasks = [node('A', { ...same, title: 'fix the zebra crash' }), node('B', { ...same, title: 'fix the walrus crash' })];
  const denied = await setup(t, JEV_FIX, { sourceEgress: DENIED });
  await labels(denied.engine, tasks);
  assert.equal(denied.requests.length, 1, 'the title is not sent, so the two tasks are one question');
  const approved = await setup(t, JEV_FIX, { sourceEgress: APPROVED });
  await labels(approved.engine, tasks);
  assert.equal(approved.requests.length, 1, 'the title is sent, so each task is its own question, and the two go in one request');
  assert.deepEqual(Object.keys(approved.requests[0].questions), ['slice0', 'risk0', 'slice1', 'risk1']);
  assert.equal(approved.requests[0].state.untrustedEvidence.length, 2);
});

test('an invalid graph gets no suggestions; a sound graph with issues (a missing check) still does', async (t) => {
  const { home, engine, requests } = await setup(t);
  const cyclic = await plan(home, { tasks: [node('A', { dependencyIds: ['B'] }), node('B', { dependencyIds: ['A'] })] }, engine);
  assert.equal(cyclic.sliceSuggestions, undefined);
  const malformed = await plan(home, { tasks: [{ id: 'X' }] }, engine);
  assert.equal(malformed.sliceSuggestions, undefined);
  assert.equal(requests.length, 0);
  const nocheck = await plan(home, { tasks: [node('A', { writeScopes: ['docs/a.md'] })] }, engine);
  assert.equal(nocheck.valid, false);
  assert.equal(nocheck.sliceSuggestions[0].slice, 'docs');
});

test('with reviews asked too (requirements), the labels ride along and the review is unchanged', async (t) => {
  const { home, engine } = await setup(t, (id, q) => (q.type === 'score' && !isRisk(id) ? { score: 3 } : JEV_FIX(id)));
  const body = await plan(home, { tasks: [SOURCE('A')], requirements: [{ id: 'R1', text: 'The parser accepts a trailing comma.' }] }, engine, { deadline: createDeadline(5000) });
  // Jev's answer or, on a runner too loaded for it inside the op's wait, the rules': either way one label rides along.
  assert.equal(body.sliceSuggestions.length, 1);
  assert.ok(['issue-fix', 'bounded-edit'].includes(body.sliceSuggestions[0].slice));
  assert.notEqual(body.review.decomposition, null);
});

/** A small seeded generator, so a failure names its seed. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

test('property: the suggestion step never changes the graph, the plan answer or its input (seeded graphs, valid and broken)', async (t) => {
  const { home, engine } = await setup(t, (id) => (isSlice(id) ? { choice: 'feature', probabilities: { feature: 0.8 } } : { score: 1 }));
  const verbs = ['fix the bug', 'add support', 'refactor module', 'update docs', 'run the script', 'review the change', ''];
  const roots = ['src', 'lib', 'docs', 'test', '.github/workflows', 'package-lock.json', 'app', 'src/auth']; // test-hygiene: not product source
  for (let seed = 1; seed <= 30; seed += 1) {
    const rand = rng(seed * 7919);
    const count = 1 + Math.floor(rand() * 9);
    const tasks = [];
    for (let i = 0; i < count; i += 1) {
      const deps = [];
      for (let j = 0; j < i; j += 1) if (rand() < 0.3) deps.push(`T${j}`);
      const files = Math.floor(rand() * 4);
      const scopes = Array.from({ length: files }, (_, k) => `${roots[Math.floor(rand() * roots.length)]}/f${i}${k}.ts`);
      const checks = rand() < 0.7 ? [rand() < 0.5 ? 'unit-test' : 'lint'] : [];
      const raw = node(`T${i}`, { dependencyIds: deps, writeScopes: scopes, acceptanceCheckIds: checks, title: verbs[Math.floor(rand() * verbs.length)] });
      if (rand() < 0.2) raw.sliceId = rand() < 0.5 ? 'bounded-edit' : 'feature';
      tasks.push(raw);
    }
    // Break some graphs: an unknown dependency, a duplicate id, a cycle.
    if (seed % 5 === 0) tasks[0].dependencyIds = ['NOPE'];
    if (seed % 7 === 0 && tasks.length > 1) tasks[1].id = tasks[0].id;
    if (seed % 11 === 0 && tasks.length > 1) {
      tasks[0].dependencyIds = [tasks[1].id];
      tasks[1].dependencyIds = [tasks[0].id];
    }
    const input = JSON.stringify(tasks);
    const body = await plan(home, JSON.parse(`{"tasks":${input}}`), engine);
    assert.equal(JSON.stringify(tasks), input, `seed ${seed}: the input is untouched`);
    const { sliceSuggestions, ...rest } = body;
    assert.deepEqual(rest, core.planTaskGraph(JSON.parse(input)), `seed ${seed}: the plan answer is the graph's, with or without labels`);
    const sound = rest.order.length === rest.taskCount && rest.taskCount > 0;
    if (!sound) {
      assert.equal(sliceSuggestions, undefined, `seed ${seed}: a broken graph gets no labels`);
      continue;
    }
    assert.deepEqual(sliceSuggestions.map((x) => x.taskId), rest.order, `seed ${seed}: one label per task, in the plan's order`);
    for (const x of sliceSuggestions) {
      const raw = tasks.find((task) => task.id === x.taskId);
      if (raw.sliceId !== undefined) assert.deepEqual([x.slice, x.source], [raw.sliceId, 'given'], `seed ${seed}: ${x.taskId} keeps its declared slice`);
      if (raw.writeScopes.some((p) => p.startsWith('.github') || p.includes('package-lock') || p.includes('auth'))) assert.ok(x.risk === 'high' && (x.slice === null || x.source === 'given'), `seed ${seed}: ${x.taskId} protected`);
    }
  }
});
