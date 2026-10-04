// Review of the plan slice hints (item 6, first bullet): docs/routing.md says the plan's questions run
// at the same time. The review thought the engine's interactive lane (four at once) held the rest back.
// It does not: no plan or live adviser request goes through the decision queues, so a plan's requests are
// all in flight together. A plan of eight tasks is two requests (six tasks, then two: two questions a task and
// at most twelve to a request). This pins that with a barrier, not a clock: the provider answers nothing
// until the second request has arrived, so a plan that asked them one after another would stop at its wait.
// Scripted fetch, a temporary home, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

test('both requests of a plan of eight tasks are in flight before either is answered', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-plan-in-flight-'));
  let tracker = null;
  // The engine's own tail (settling the budget, ending each journal entry) lands in this home: wait for it, then remove the home.
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  let arrived = 0;
  let release;
  const allArrived = new Promise((resolve) => {
    release = resolve;
  });
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    arrived += 1;
    if (arrived >= 2) release();
    await Promise.race([
      allArrived,
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
    ]);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'score') {
        answers[id] = { type: 'score', score: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])), legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 1 };
      } else {
        const keys = Object.keys(q.criteria);
        answers[id] = { type: 'choice', choice: 'issue-fix', probabilities: Object.fromEntries(keys.map((k) => [k, k === 'issue-fix' ? 0.9 : 0.1 / (keys.length - 1)])), confidence: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // The requests start together and each reserves from the budget file under its lock, which a call waits for at most 2 s before it falls
  // back to rules without sending (BUDGET_LOCKED): on a slow disk the last passed that, and the barrier below then never saw
  // its second request. The wait is lengthened for this test; what the test proves, both in flight together, is unchanged.
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch, env: {}, budgetLockTimeoutMs: 120_000, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  tracker = trackEngine(engine);
  // Eight tasks with eight different feature sets: eight distinct tasks, the plan's cap, in two requests.
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `T${i}`, paths: Array.from({ length: i + 1 }, (_, k) => `src/m${i}/f${k}.ts`), checkIds: ['unit-test'] }));
  const list = await core.suggestPlanSlices(engine, tasks, { workspaceId: 'w-in-flight', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 60_000, totalMs: 120_000, record: false });
  assert.equal(arrived, 2, 'two requests reached the provider: six tasks and two');
  assert.equal(list.filter((x) => x.source === 'jev').length, 8, 'and every task was answered by Jev: none was held back or cut short');
});
