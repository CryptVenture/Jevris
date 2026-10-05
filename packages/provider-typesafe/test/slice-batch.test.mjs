// A plan's tasks that need Jev are asked together, six to a request (two questions a task, at most 12 to a request),
// not one request per task. Measured live (jev-1.13.0, 2026-10-04, six tasks that all need Jev, four plans): six
// requests at once took 429 ms (median; the slowest of six, each about 330 ms) and 282 micro-USD; one request of the 12
// questions took 227 ms and 198 micro-USD, and both labelled all 24 tasks as expected, every one above the confidence
// floor. Each task keeps its own answer, floors and decision. Scripted fetch and a real engine, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

/**
 * A scripted Jev. `answer(taskIndex, kind, request)` gives `{ choice, p }` for a slice question (the winner and its
 * probability) or `{ score }` for a risk question, or null for no answer; the task index is the one in the question id
 * (`slice3` is task 3, `slice` is task 0). `fail(request)` may return an HTTP status to fail that request with;
 * `hold` returns a promise a request waits for before it answers (and aborts on its signal).
 */
function scriptedJev(answer, { fail = () => null, hold = () => null } = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const status = fail(body, requests.length);
    if (status !== null) return new Response(JSON.stringify({ error: 'scripted' }), { status, headers: { 'content-type': 'application/json' } });
    const wait = hold(body, requests.length);
    if (wait !== null) {
      await Promise.race([wait, new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))]);
    }
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const index = Number(/\d+$/.exec(id)?.[0] ?? 0);
      const want = answer(index, q.type === 'score' ? 'risk' : 'slice', body) ?? {};
      if (q.type === 'score') {
        const level = want.score ?? 1;
        answers[id] = { type: 'score', score: level, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? 1 : 0])), legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      } else {
        const keys = Object.keys(q.criteria);
        const win = want.choice ?? 'issue-fix';
        const p = want.p ?? 0.9;
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === win ? p : (1 - p) / (keys.length - 1)]));
        answers[id] = { type: 'choice', choice: win, probabilities, confidence: p };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 4000, output_tokens: 400 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, answer, { sourceEgress = DENIED, clock, ...script } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-slice-batch-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const jev = scriptedJev(answer, script);
  // Several requests start together and each reserves under the budget file's lock: a long wait so a loaded disk is not what the test races.
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: jev.fetch, env: {}, budgetLockTimeoutMs: 120_000, sourceEgress, ...(clock === undefined ? {} : { clock }) });
  tracker = trackEngine(engine);
  return { engine, requests: jev.requests };
}

/**
 * Distinct source-file tasks the rules cannot settle (so Jev is asked), each with the rules' own weak answer
 * (bounded-edit: one to five source files and a check) and features no other task has: the file count and the check kind.
 */
const task = (i, extra = {}) => ({ title: null, paths: Array.from({ length: 1 + (i % 5) }, (_, k) => `src/m${i}/f${k}.ts`), checkIds: [['unit-test'], ['lint'], ['typecheck'], ['build'], ['unit-test', 'lint']][Math.floor(i / 5) % 5], ...extra });
const ctx = (workspaceId = 'w-slice-batch') => ({ workspaceId, evidenceRevision: 'r1', deadlineMs: 60_000 });

async function batch(engine, hints, options = {}, workspaceId) {
  const out = new Map();
  await core.classifyTaskSliceBatch(engine, hints.map((h, i) => ({ key: `k${i}`, hints: h })), ctx(workspaceId), { assist: 'classify', onResult: (key, r) => out.set(key, r), ...options });
  return hints.map((_, i) => out.get(`k${i}`));
}

test('six tasks are one request of twelve questions; each task\'s answer lands on that task, with its own floors', async (t) => {
  // Task 0..5 get different answers: a clear refactor, a low-confidence one, a high-risk one, a slice that is not in the vocabulary, a clear feature, a clear issue-fix.
  const { engine, requests } = await setup(t, (i, kind) => {
    if (kind === 'risk') return { score: i === 2 ? 3 : 1 };
    return [{ choice: 'refactor', p: 0.9 }, { choice: 'debug', p: 0.4 }, { choice: 'feature', p: 0.9 }, { choice: 'unknown', p: 0.9 }, { choice: 'feature', p: 0.9 }, { choice: 'issue-fix', p: 0.9 }][i];
  });
  const r = await batch(engine, [0, 1, 2, 3, 4, 5].map((i) => task(i)));
  assert.equal(requests.length, 1, 'one request');
  assert.deepEqual(Object.keys(requests[0].questions), ['slice0', 'risk0', 'slice1', 'risk1', 'slice2', 'risk2', 'slice3', 'risk3', 'slice4', 'risk4', 'slice5', 'risk5']);
  assert.deepEqual(r.map((x) => [x.sliceId, x.source, x.reasonCode]), [
    ['refactor', 'jev', 'SLICE_JEV_OVER_RULES'],
    ['bounded-edit', 'rules', 'SLICE_JEV_LOW_CONFIDENCE'],
    [null, 'none', 'SLICE_HIGH_RISK'],
    ['bounded-edit', 'rules', 'SLICE_JEV_UNKNOWN'],
    ['feature', 'jev', 'SLICE_JEV_OVER_RULES'],
    ['issue-fix', 'jev', 'SLICE_JEV_OVER_RULES'],
  ]);
  assert.ok(r.every((x) => x.asked && x.jevDecisionId === r[0].jevDecisionId), 'they share the request\'s engine decision');
  assert.deepEqual(r.map((x) => x.cacheHit), [false, false, false, false, false, false]);
});

test('the request carries only counts, flags and codes: per-task facts under t0_ .. t5_, fixed question text, no path, title or check name', async (t) => {
  const { engine, requests } = await setup(t, () => ({}), { sourceEgress: DENIED });
  await batch(engine, [0, 1, 2].map((i) => task(i, { title: `fix the zebra crash number ${i}`, checkIds: ['zebra-unit-test'] })));
  const wire = JSON.stringify(requests);
  for (const leak of ['zebra', 'crash', 'src/m', 'f0.ts']) assert.equal(wire.includes(leak), false, `${leak} must not leave while egress is denied`);
  const facts = requests[0].state.facts;
  for (let i = 0; i < 3; i += 1) for (const name of ['files', 'extensions', 'roleSource', 'roleTest', 'checks', 'checkKinds', 'verb', 'titleSize']) assert.ok(`t${i}_${name}` in facts, `t${i}_${name}`);
  assert.equal(Object.keys(facts).filter((k) => !/^t[0-2]_/.test(k)).length, 0, 'every fact belongs to a task');
  assert.deepEqual([requests[0].state.untrustedEvidence, requests[0].state.withheldEvidence], [[], []]);
  // The question text is the single-task text with the task named by its index, and nothing else.
  const one = core.sliceQuestions();
  assert.deepEqual(requests[0].questions.slice1.criteria, one.slice.criteria, 'the same options and definitions');
  assert.deepEqual(requests[0].questions.risk1.criteria, one.risk.criteria, 'the same risk anchors');
  assert.match(requests[0].questions.slice1.instructions, /task 1\? They are the facts that start with t1_\.$/);
});

test('with egress approved a title goes as one screened span per task, led by its task; paths and check names still never go', async (t) => {
  const { engine, requests } = await setup(t, () => ({}), { sourceEgress: APPROVED });
  await batch(engine, [0, 1].map((i) => task(i, { title: `fix the zebra crash number ${i}`, checkIds: ['zebra-unit-test'] })));
  const spans = requests[0].state.untrustedEvidence;
  assert.deepEqual(spans.map((s) => s.text), ['Task 0 title: fix the zebra crash number 0', 'Task 1 title: fix the zebra crash number 1']);
  const wire = JSON.stringify(requests);
  for (const leak of ['src/m', 'zebra-unit']) assert.equal(wire.includes(leak), false, `${leak} never leaves`);
});

test('eight tasks are two requests (six and two), at the same time; one task alone goes the single way', async (t) => {
  const { engine, requests } = await setup(t, () => ({}));
  const eight = await batch(engine, Array.from({ length: 8 }, (_, i) => task(i)));
  assert.deepEqual(requests.map((r) => Object.keys(r.questions).length).sort((a, b) => a - b), [4, 12]);
  assert.deepEqual(eight.map((x) => x.source), eight.map(() => 'jev'));
  // Seven tasks, six and one: the one is a request of the single-task questions (`slice`, `risk`), so it shares the route's decision cache.
  requests.length = 0;
  const seven = await batch(engine, Array.from({ length: 7 }, (_, i) => task(20 + i)), {}, 'w-seven');
  assert.deepEqual(requests.map((r) => Object.keys(r.questions).join(',')).sort(), ['slice,risk', 'slice0,risk0,slice1,risk1,slice2,risk2,slice3,risk3,slice4,risk4,slice5,risk5'].sort());
  assert.deepEqual(seven.map((x) => x.source), seven.map(() => 'jev'));
});

test('a task the rules settle, or a gate stops, is answered without a request, exactly as when asked alone', async (t) => {
  const { engine, requests } = await setup(t, () => ({}));
  const r = await batch(engine, [{ title: null, paths: ['docs/a.md'], checkIds: [] }, { title: null, paths: ['.github/workflows/ci.yml'], checkIds: [] }, { title: null, paths: [], checkIds: [] }, task(1), task(2)]);
  assert.deepEqual(r.map((x) => x.reasonCode), ['SLICE_RULES_SURE', 'SLICE_HIGH_RISK', 'SLICE_NO_FEATURES', 'SLICE_JEV_OVER_RULES', 'SLICE_JEV_OVER_RULES']);
  assert.equal(requests.length, 1);
  assert.equal(Object.keys(requests[0].questions).length, 4, 'only the two tasks that need Jev are in the request');
  requests.length = 0;
  const gated = await batch(engine, [task(3), task(4)], { skipAsk: 'PLAN_JEV_KILL_SWITCH' }, 'w-gated');
  assert.deepEqual(gated.map((x) => [x.source, x.reasonCode]), [['rules', 'PLAN_JEV_KILL_SWITCH'], ['rules', 'PLAN_JEV_KILL_SWITCH']]);
  const off = await batch(engine, [task(3), task(4)], { assist: 'off' }, 'w-off');
  assert.deepEqual(off.map((x) => x.reasonCode), ['SLICE_ASSIST_OFF', 'SLICE_ASSIST_OFF']);
  const bare = await batch(null, [task(3)]);
  assert.equal(bare[0].reasonCode, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(requests.length, 0);
});

test('the same tasks asked again are answered from the engine\'s decision cache; a plan that shares tasks with an earlier one asks only about the new ones', async (t) => {
  const { engine, requests } = await setup(t, () => ({}));
  const first = await batch(engine, [0, 1, 2, 3].map((i) => task(i)), {}, 'w-memo');
  assert.equal(requests.length, 1);
  assert.deepEqual(first.map((x) => x.cacheHit), [false, false, false, false]);
  const again = await batch(engine, [0, 1, 2, 3].map((i) => task(i)), {}, 'w-memo');
  assert.equal(requests.length, 1, 'no new request');
  assert.deepEqual(again.map((x) => [x.source, x.cacheHit, x.asked]), [['jev', true, true], ['jev', true, true], ['jev', true, true], ['jev', true, true]]);
  // Two of the four again, two new ones: one request, for the two new tasks only.
  const mixed = await batch(engine, [task(1), task(2), task(7), task(8)], {}, 'w-memo');
  assert.equal(requests.length, 2);
  assert.equal(Object.keys(requests[1].questions).length, 4, 'two tasks, two questions each');
  assert.deepEqual(mixed.map((x) => x.cacheHit), [true, true, false, false]);
  // Another workspace never shares an answer.
  const other = await batch(engine, [task(1), task(2)], {}, 'w-other');
  assert.equal(requests.length, 3);
  assert.deepEqual(other.map((x) => x.cacheHit), [false, false]);
});

test('a remembered answer lives as long as the engine\'s own decision cache (ten minutes), and no longer', async (t) => {
  let nowMs = Date.parse('2026-10-04T12:00:00Z'); // pinned-clock: the engine's wall clock, which its caches and the memory read
  const { engine, requests } = await setup(t, () => ({}), { clock: { now: () => nowMs } });
  await batch(engine, [task(0), task(1)], {}, 'w-ttl');
  assert.equal(requests.length, 1);
  nowMs += 9 * 60 * 1000;
  const within = await batch(engine, [task(0), task(1)], {}, 'w-ttl');
  assert.equal(requests.length, 1, 'inside the ten minutes: answered from what is remembered');
  assert.deepEqual(within.map((x) => x.cacheHit), [true, true]);
  nowMs += 2 * 60 * 1000;
  const after = await batch(engine, [task(0), task(1)], {}, 'w-ttl');
  assert.equal(requests.length, 2, 'past ten minutes: asked again');
  assert.deepEqual(after.map((x) => x.cacheHit), [false, false]);
});

// JEV-0058: a task asked on its own (a plan whose tasks share one shape, or a route) goes the single way, which asks the
// single-task questions and is answered by the engine's decision cache, but the batch memory only knew batched answers.
// So a plan that added one task to such a plan asked about the old shape again, in the same request as the new one.
test('a shape asked alone is remembered as well: a plan that adds one task asks only about the new one, in a request of its own (JEV-0058)', async (t) => {
  const { engine, requests } = await setup(t, () => ({}));
  const settings = { assist: 'classify', mode: 'advise', deadlineMs: 60_000, totalMs: 120_000 };
  const plan = (tasks) => core.suggestPlanSlices(engine, tasks, { workspaceId: 'w-grow', evidenceRevision: 'r1' }, settings);
  // Four tasks with one shape are one question, asked the single way.
  const four = [0, 1, 2, 3].map((i) => ({ id: `e${i}`, ...task(0) }));
  const first = await plan(four);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions), ['slice', 'risk']);
  assert.deepEqual(first.map((x) => x.source), ['jev', 'jev', 'jev', 'jev']);
  // The same four and one new shape: only the new shape is asked, as a single task.
  const grown = await plan([...four, { id: 'e4', ...task(7) }]);
  assert.equal(requests.length, 2, 'one new request');
  assert.deepEqual(Object.keys(requests[1].questions), ['slice', 'risk'], `only the new task is asked; the request carried ${JSON.stringify(Object.keys(requests[1].questions))}`);
  assert.deepEqual(grown.map((x) => [x.taskId, x.source]), [['e0', 'jev'], ['e1', 'jev'], ['e2', 'jev'], ['e3', 'jev'], ['e4', 'jev']]);
  assert.deepEqual(grown.slice(0, 4).map((x) => [x.slice, x.risk, x.confidencePercent]), first.map((x) => [x.slice, x.risk, x.confidencePercent]), 'the old shape keeps its answer');
  // Two new shapes beside the old one: one request of the two new tasks (four questions), none for the old.
  const more = await plan([...four, { id: 'e5', ...task(8) }, { id: 'e6', ...task(9) }]);
  assert.equal(requests.length, 3);
  assert.deepEqual(Object.keys(requests[2].questions), ['slice0', 'risk0', 'slice1', 'risk1']);
  assert.equal(more.filter((x) => x.source === 'jev').length, 6);
});

test('a task the route asked is remembered for a plan too, for the same ten minutes as the decision cache and no longer (JEV-0058)', async (t) => {
  let nowMs = Date.parse('2026-10-04T12:00:00Z');
  const { engine, requests } = await setup(t, () => ({}), { clock: { now: () => nowMs } });
  const alone = await core.classifyTaskSlice(engine, task(0), ctx('w-route'), { assist: 'classify', record: false });
  assert.deepEqual([alone.source, alone.asked, alone.cacheHit], ['jev', true, false]);
  assert.equal(requests.length, 1);
  nowMs += 9 * 60 * 1000;
  const within = await batch(engine, [task(0), task(1)], {}, 'w-route');
  assert.equal(requests.length, 2, 'one request, for the task nobody had asked');
  assert.deepEqual(Object.keys(requests[1].questions), ['slice', 'risk']);
  assert.deepEqual(within.map((x) => [x.source, x.cacheHit]), [['jev', true], ['jev', false]]);
  nowMs += 2 * 60 * 1000;
  const after = await batch(engine, [task(0), task(1)], {}, 'w-route');
  assert.equal(requests.length, 3, 'past the ten minutes of the first answer, the first task is asked again (the second was answered a minute ago and still stands)');
  assert.deepEqual(Object.keys(requests[2].questions), ['slice', 'risk']);
  assert.deepEqual(after.map((x) => x.cacheHit), [false, true]);
  // Another workspace never shares it.
  const other = await batch(engine, [task(0), task(1)], {}, 'w-route-other');
  assert.equal(requests.length, 4);
  assert.deepEqual(other.map((x) => x.cacheHit), [false, false]);
});

test('a request that fails gives every task in it the rules answer with the reason; the other request is unaffected', async (t) => {
  const { engine } = await setup(t, () => ({}), { fail: (body) => (Object.keys(body.questions).length === 4 ? 422 : null) });
  const r = await batch(engine, Array.from({ length: 8 }, (_, i) => task(i)));
  assert.deepEqual(r.slice(0, 6).map((x) => x.source), ['jev', 'jev', 'jev', 'jev', 'jev', 'jev']);
  for (const x of r.slice(6)) {
    assert.equal(x.source, 'rules');
    assert.equal(x.sliceId, 'bounded-edit');
    assert.match(x.reasonCode, /^SLICE_JEV_/);
    assert.equal(x.asked, true);
  }
});

test('results are delivered per request, as each answers: the six-task request arrives while the two-task request is still out, and the held one arrives when it is released', async (t) => {
  // This is what lets a plan's shared deadline leave only the late request's tasks to the rules (the plan keeps what had been delivered by then; the hung-provider test above covers the deadline itself). Nothing here is timed: the test waits for a state.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { engine } = await setup(t, () => ({}), { hold: (body) => (Object.keys(body.questions).length === 4 ? gate : null) });
  t.after(() => release());
  const delivered = new Map();
  const done = core.classifyTaskSliceBatch(engine, Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, hints: task(i) })), ctx('w-held'), { assist: 'classify', onResult: (key, r) => delivered.set(key, r) });
  for (let i = 0; i < 1200 && delivered.size < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual([...delivered.keys()].sort(), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'], 'the answered request\'s tasks are in, the held one\'s are not');
  assert.ok([...delivered.values()].every((r) => r.source === 'jev'));
  release();
  await done;
  assert.equal(delivered.size, 8);
  assert.ok(delivered.get('k6').source === 'jev' && delivered.get('k7').source === 'jev');
});

test('through the plan: eight tasks make two requests, every task keeps its own record and decision id, and the cap still counts tasks', async (t) => {
  const { engine, requests } = await setup(t, () => ({}));
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, ...task(i) }));
  const list = await core.suggestPlanSlices(engine, tasks, { workspaceId: 'w-plan', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 60_000, totalMs: 120_000 });
  assert.equal(requests.length, 2, 'ten tasks, eight asked (the cap), in two requests');
  assert.deepEqual(list.map((x) => x.reasonCode).filter((c) => c === 'PLAN_JEV_CAP').length, 2);
  assert.equal(list.filter((x) => x.source === 'jev').length, 8);
  const ids = list.map((x) => x.decisionId);
  assert.equal(new Set(ids).size, 10, 'one recorded decision per task');
  for (const x of list.filter((y) => y.source === 'jev')) {
    const record = await engine.lookup(x.decisionId);
    assert.ok(record.reasonCodes.includes('SLICE_SOURCE_JEV') && record.reasonCodes.includes('SLICE_PLAN_TASK'), x.taskId);
  }
});

test('a REAL batched answer (fixtures/jev-real-batch.json: six tasks, twelve answers of jev-1.13.0) is accepted by the real validators and each task gets its own label', async (t) => {
  const REAL = JSON.parse(readFileSync(new URL('./fixtures/jev-real-batch.json', import.meta.url), 'utf8'));
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const real = REAL.answers[id];
      answers[id] = q.type === 'score' ? { type: 'score', score: real.score, probabilities: real.probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: real.confidence } : { type: 'choice', choice: real.choice, probabilities: real.probabilities, confidence: real.confidence };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: REAL.usage }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const home = mkdtempSync(join(tmpdir(), 'jevris-slice-batch-real-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch, env: {}, sourceEgress: DENIED });
  tracker = trackEngine(engine);
  const out = new Map();
  await core.classifyTaskSliceBatch(engine, REAL.tasks.map((x) => ({ key: x.id, hints: x })), { workspaceId: 'w-real-batch', evidenceRevision: 'r1', deadlineMs: 60_000 }, { assist: 'classify', onResult: (key, r) => out.set(key, r) });
  assert.deepEqual(Object.keys(requests[0].questions), Object.keys(REAL.answers), 'the request asks the questions the real answer answered');
  assert.deepEqual(REAL.tasks.map((x) => [x.id, out.get(x.id).source, out.get(x.id).sliceId, out.get(x.id).reasonCode]), [
    ['fix', 'jev', 'issue-fix', 'SLICE_JEV'],
    ['add', 'jev', 'feature', 'SLICE_JEV'],
    ['refactor', 'jev', 'refactor', 'SLICE_JEV'],
    ['review', 'jev', 'review', 'SLICE_JEV'],
    ['research', 'jev', 'research', 'SLICE_JEV'],
    ['debug', 'jev', 'debug', 'SLICE_JEV'],
  ]);
  assert.deepEqual(REAL.tasks.map((x) => out.get(x.id).risk), ['low', 'medium', 'low', 'low', 'low', 'medium']);
});
