// JEV-0057 and JEV-0066: a route's Jev wait is the hot budget's wait (700 ms of the 900 ms budget) whatever budget class the
// request asked for. A person's `jevris route` and an MCP `jevris_plan_route` ask the sidecar for the 5 s background budget (so
// that a loaded host does not fail the unrelated work around the call), and the op used to derive its Jev wait from that budget:
// min(5000 - 200, left - 100), about 4.8 s, where docs/routing.md and docs/architecture.md say at most 700 ms and the SSOT's
// hot-path rule is a 900 ms total for a semantic decision. The sidecar now tells an op the hot budget it runs with
// (`hotBudgetMs`), and the route's wait is never more than that budget less 200 ms.
//
// The route op is driven directly, as in slice-classify.test.mjs: an op context with a deadline that reads a fixed time left (no
// clock), a scripted Jev and a real engine in a temporary home. The wait is read as the deadline the op gives the engine (the wait
// plus the 1 s late grace), which is exact and does not depend on how fast the host is. The real request through a real sidecar,
// with a Jev that holds its answer, is apps/sidecar/test/route-jev-wait.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

/** The route's late grace: how long past its wait the engine lets an abandoned classification run (sidecar-ops.ts). */
const LATE_GRACE_MS = 1_000;
const SOURCE_TASK = { paths: ['src/parser/lexer.ts', 'src/parser/tokens.ts'], checkIds: ['test'] };
const REQUEST = { currentModel: 'claude-opus-5', task: SOURCE_TASK };

/** A scripted Jev that always says issue-fix at low risk; `hold` is a promise the test controls. Every request body is recorded. */
function scriptedFetch({ hold = null } = {}) {
  const requests = [];
  let answeredCount = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (hold !== null) await hold;
    answeredCount += 1;
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'score') {
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0]));
        answers[id] = { type: 'score', score: 1, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      } else {
        const keys = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === 'issue-fix' ? 0.9 : 0.1 / (keys.length - 1)]));
        answers[id] = { type: 'choice', choice: 'issue-fix', probabilities, confidence: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests, answered: () => answeredCount };
}

async function setup(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-wait-'));
  let tracker = null;
  // A call the test abandoned still settles the budget and the breaker and ends its journal entry in this home: wait for it, then remove the home.
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const script = scriptedFetch(options);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests, answered: script.answered };
}

/** A deadline that reads a fixed time left: what a test says about time is what the op reads. */
const fixedDeadline = (budgetMs, left = budgetMs) => ({ budgetMs, remainingMs: () => left, expired: () => left <= 0 });

function opCtx(home, body, engine, extra = {}) {
  return {
    op: 'route', client: 'cli', scopes: ['status', 'advice'], workspace: { id: 'w-route-wait', root: null }, body, home,
    signal: new AbortController().signal, deadline: fixedDeadline(60_200), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise', ...extra,
  };
}

async function route(home, body, engine, extra) {
  const out = await ops.route.handle(opCtx(home, body, engine, extra));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('route').validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

/** Waits for a state, with a generous bound; the wait ends as soon as it holds. */
async function until(condition, what) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, `${what} held before the generous bound`);
}

/**
 * Every `decide` the engine receives is seen first: `deadlineMs` is the call's own deadline (the wait plus the grace), and the
 * engine's clock is replaced with one no stall can use up, so a slow disk (the journal and budget writes come before the request
 * leaves) cannot end the call before the test has looked at it.
 */
function watchDecide(engine) {
  const seen = [];
  const original = engine.decide.bind(engine);
  engine.decide = (request, options) => {
    seen.push({ deadlineMs: request.spec.deadlineMs });
    return original(request, { ...options, deadline: { remainingMs: () => 60_000, expired: () => false } });
  };
  return seen;
}

/** The wait the route gave Jev for a request with `extra` (a deadline and the hot budget), read as the engine's deadline less the grace. */
async function waitOf(t, extra) {
  const { home, engine } = await setup(t);
  const seen = watchDecide(engine);
  await route(home, REQUEST, engine, extra);
  await until(() => seen.length === 1, 'the classification reached the engine');
  return seen[0].deadlineMs - LATE_GRACE_MS;
}

test('a request that asked for the 5 s background budget waits for Jev at most the hot budget less 200 ms: 700 ms, not 4.8 s (JEV-0057, JEV-0066)', async (t) => {
  assert.equal(await waitOf(t, { deadline: fixedDeadline(5000), hotBudgetMs: 900 }), 700, 'a person\'s command: the background budget in, the hot budget\'s wait out');
});

test('the hot budget\'s own wait is unchanged: a hook request has 900 ms and waits 700 ms, and a client with less time left waits for less', async (t) => {
  assert.equal(await waitOf(t, { deadline: fixedDeadline(900), hotBudgetMs: 900 }), 700, 'a hook: the 900 ms hot budget');
  // The time left less 100 ms still bounds it, whatever the budget class: 5 s of budget, 400 ms left.
  assert.equal(await waitOf(t, { deadline: fixedDeadline(5000, 400), hotBudgetMs: 900 }), 300, 'a client with 400 ms left waits 300 ms');
  // A request that has used part of its budget (an event that began before the hook started): the smaller of the two.
  assert.equal(await waitOf(t, { deadline: fixedDeadline(500), hotBudgetMs: 900 }), 300, 'a budget already cut to 500 ms waits 300 ms');
});

test('the cap follows the hot budget the sidecar runs with, so a test run that scales its budgets (or pins them) keeps the ratio: it is not a fixed 700', async (t) => {
  // A scaled run (JEVRIS_TEST_BUDGET_SCALE=6): 5400 ms hot, 30 000 ms background. The wait is the scaled hot budget less 200 ms.
  assert.equal(await waitOf(t, { deadline: fixedDeadline(30_000), hotBudgetMs: 5400 }), 5200);
  // A sidecar with its hot budget pinned to a test's own value.
  assert.equal(await waitOf(t, { deadline: fixedDeadline(5000), hotBudgetMs: 1500 }), 1300);
});

test('an op context that names no hot budget (a direct call) keeps the wait derived from the op\'s own budget, so the generous-budget tests of the route op still hold', async (t) => {
  assert.equal(await waitOf(t, { deadline: fixedDeadline(60_200) }), 60_000);
  assert.equal(await waitOf(t, { deadline: fixedDeadline(5000) }), 4800, 'nothing tells the op a hot budget, so nothing caps it');
});

test('a gate is the reason whatever the budget class: assist off, mode off and the kill switch answer their own code, and with under 150 ms to wait Jev is not asked', async (t) => {
  const { home, engine, requests } = await setup(t);
  const background = { deadline: fixedDeadline(5000), hotBudgetMs: 900 };
  for (const [extra, reasonCode] of [
    [{ jevAssist: 'off' }, 'SLICE_ASSIST_OFF'],
    [{ mode: 'off' }, 'SLICE_MODE_OFF'],
    [{ killSwitchStopped: true }, 'SLICE_KILL_SWITCH'],
    // No gate: only too little time counts. 5 s of budget but 240 ms left: 140 ms to wait, under the 150 ms a call needs.
    [{ deadline: fixedDeadline(5000, 240) }, 'SLICE_NO_TIME'],
  ]) {
    const out = await route(home, REQUEST, engine, { ...background, ...extra });
    assert.deepEqual([out.slice.sliceId, out.slice.source, out.slice.asked, out.slice.reasonCode], ['bounded-edit', 'rules', false, reasonCode], JSON.stringify(Object.keys(extra)));
  }
  assert.equal(requests.length, 0, 'no gate and no lack of time asks a model');
});

test('a Jev that has not answered when the wait ends is abandoned for the rules slice, whatever the budget class: SLICE_DEADLINE, and the held answer is never waited for', async (t) => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const { home, engine, requests, answered } = await setup(t, { hold });
  watchDecide(engine);
  try {
    const out = await route(home, REQUEST, engine, { deadline: fixedDeadline(5000), hotBudgetMs: 900 });
    assert.equal(answered(), 0, 'Jev had not answered when the route returned');
    assert.deepEqual([out.slice.sliceId, out.slice.source, out.slice.reasonCode], ['bounded-edit', 'rules', 'SLICE_DEADLINE']);
    await until(() => requests.length === 1, 'Jev was asked');
  } finally {
    release();
  }
});
