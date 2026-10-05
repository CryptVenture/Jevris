// JEV-0057 and JEV-0066: a person's `jevris route` waits for Jev at most 700 ms, not the 4.8 s the 5 s background budget gave it.
//
// docs/routing.md ("Milliseconds, honestly"), docs/architecture.md (the Hot row) and the SSOT's hot-path rule (a semantic decision
// has a 900 ms total budget, and fallback is the outcome when it cannot be met) say the call is abandoned at 700 ms (the hot budget
// less 200 ms) and the rules slice answers with SLICE_DEADLINE; the late answer only warms the decision cache. A person's command and
// an MCP tool call ask the sidecar for the background budget (5 s, so that a loaded host does not fail the work around the call), and
// the route op derived its Jev wait from that budget: with Jev answering in 1.2 s the route took 1.24 s and used Jev's slice, and
// with Jev holding 3 s it waited 3.05 s.
//
// The real route op answers a real request here: a daemon in this process (the real service, its socket, its budget classes and its
// op context), the request sent as the CLI sends it (scope cli, the background budget), and a stub Jev behind the real engine that
// holds its answer. The subject is a deadline, so the budgets are pinned to the product's own (EXACT_BUDGET_LIMITS) whatever scale
// the runner sets. The tests say what happened by state (the route returned while Jev had not answered; the held answer was
// recorded; the repeat was a cache hit), never by how long anything took.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { EXACT_BUDGET_LIMITS } from '../../../test/budget-scale.mjs';
import { trackEngine } from '../../../packages/provider-typesafe/test/engine-settle.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const provider = await import('@jevris/provider-typesafe');
const { surfacePayloadContract } = await import('@jevris/contracts');

const routeOp = provider.sidecarOps.find((def) => def.op === 'route');

/**
 * A Jev stub behind the real engine's transport. `holdMs` is how long a request is held before it is answered (a request the
 * engine abandons while it is held is counted as aborted and never answered). Every state is a counter the tests wait on.
 */
function holdingJev() {
  const state = { holdMs: 0, requests: 0, answered: 0, aborted: 0 };
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    state.requests += 1;
    const completed = await new Promise((resolve) => {
      if (state.holdMs <= 0) return resolve(true);
      const timer = setTimeout(() => resolve(true), state.holdMs);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(false);
      }, { once: true });
    });
    if (!completed) {
      state.aborted += 1;
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    state.answered += 1;
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
  return { fetch, state };
}

/** Waits for a state, with a generous bound; the wait ends as soon as it holds. */
async function until(condition, what) {
  const stop = performance.now() + 60_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, `${what} held before the generous bound`);
}

/** A real sidecar daemon on the product's exact budgets, with the real route op and a real engine whose Jev is held by the test. */
async function startRoute(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvrw-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const jev = holdingJev();
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: jev.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  const tracker = trackEngine(engine);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, engine, ops: [routeOp], limits: { ...EXACT_BUDGET_LIMITS } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(async () => {
    try {
      await started.daemon.stop('test');
      // The engine finishes a call the route abandoned (it settles the budget and the breaker, ends the journal entry): wait for that work, not for time.
      await tracker.settled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  /** `jevris route` as the CLI sends it: scope cli, the background budget (apps/cli personRequest), a task that names no slice. */
  const person = async (task, extra = {}) => {
    const answer = await sidecarRequest({ home, op: 'route', scope: 'cli', budget: 'background', workspace: root, timeoutMs: 20_000, body: { currentModel: 'claude-opus-5', task }, ...extra });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(surfacePayloadContract('route').validate(answer.result).ok, true, JSON.stringify(answer.result));
    return answer.result.slice;
  };
  return { jev, tracker, person };
}

// Three source-only tasks the rules are not sure about (a weak bounded-edit), so Jev is asked: each has features nothing else uses,
// because the decision cache answers a repeat of the same features.
const TASK_QUICK = { paths: ['src/a/one.ts', 'src/a/two.ts'], checkIds: ['unit'] };
const TASK_1200 = { paths: ['src/b/one.ts', 'src/b/two.ts', 'src/b/three.ts'], checkIds: ['unit'] };
const TASK_3000 = { paths: ['src/c/one.ts', 'src/c/two.ts', 'src/c/three.ts', 'src/c/four.ts'], checkIds: ['unit', 'lint'] };

test('a person\'s route still uses a Jev answer that comes inside the wait (the control: the cap shortens the wait, it does not stop Jev being asked)', { skip: managedHostSkip() }, async (t) => {
  const { jev, person } = await startRoute(t);
  const slice = await person(TASK_QUICK);
  assert.deepEqual([slice.sliceId, slice.source, slice.asked, slice.reasonCode], ['issue-fix', 'jev', true, 'SLICE_JEV_OVER_RULES']);
  assert.equal(jev.state.answered, 1);
});

test('a Jev that answers after 1.2 s is abandoned at the wait: the route answers the rules slice with SLICE_DEADLINE, then the late answer warms the cache (JEV-0057)', { skip: managedHostSkip() }, async (t) => {
  const { jev, tracker, person } = await startRoute(t);
  jev.state.holdMs = 1200;
  const slice = await person(TASK_1200);
  // The route returned while Jev had not answered: a state, not a duration. (Before the fix the route waited for it and used its slice.)
  assert.equal(jev.state.answered, 0, 'Jev had not answered when the route returned');
  assert.deepEqual([slice.sliceId, slice.source, slice.reasonCode], ['bounded-edit', 'rules', 'SLICE_DEADLINE'], JSON.stringify(slice));
  // The held answer arrives inside the engine's late grace, is recorded, and fills the decision cache.
  await until(() => jev.state.answered === 1, 'the held answer to be given');
  await tracker.settled();
  jev.state.holdMs = 0;
  const again = await person(TASK_1200);
  assert.deepEqual([again.sliceId, again.source, again.cacheHit], ['issue-fix', 'jev', true], 'a second identical route is answered from the cache');
  assert.equal(jev.state.requests, 1, 'and sends no request');
});

test('a Jev that holds its answer for 3 s is abandoned at the same wait, not waited for: SLICE_DEADLINE and the rules slice (JEV-0066)', { skip: managedHostSkip() }, async (t) => {
  const { jev, person } = await startRoute(t);
  jev.state.holdMs = 3000;
  const slice = await person(TASK_3000);
  assert.equal(jev.state.answered, 0, 'Jev had not answered when the route returned');
  assert.deepEqual([slice.sliceId, slice.source, slice.reasonCode], ['bounded-edit', 'rules', 'SLICE_DEADLINE'], JSON.stringify(slice));
});
