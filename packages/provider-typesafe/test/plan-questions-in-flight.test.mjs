// Review of the plan slice hints (item 6, first bullet): docs/routing.md says the plan's questions run
// at the same time. The review thought the engine's interactive lane (four at once) held the rest back.
// It does not: no plan or live adviser request goes through the decision queues, so all eight questions
// of a plan are in flight together. This pins that with a barrier, not a clock: the provider answers
// nothing until the eighth request has arrived, so a limit of four would stop the plan at its wait.
// Scripted fetch, a temporary home, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

test('all eight questions of a plan are in flight before any is answered', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-plan-in-flight-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  let arrived = 0;
  let release;
  const allArrived = new Promise((resolve) => {
    release = resolve;
  });
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    arrived += 1;
    if (arrived >= 8) release();
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
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  // Eight tasks with eight different feature sets: eight distinct questions, the plan's cap.
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `T${i}`, paths: Array.from({ length: i + 1 }, (_, k) => `src/m${i}/f${k}.ts`), checkIds: ['unit-test'] }));
  const list = await core.suggestPlanSlices(engine, tasks, { workspaceId: 'w-in-flight', evidenceRevision: 'r1' }, { assist: 'classify', mode: 'advise', deadlineMs: 60_000, totalMs: 120_000, record: false });
  assert.equal(arrived, 8, 'eight requests reached the provider');
  assert.equal(list.filter((x) => x.source === 'jev').length, 8, 'and each was answered by Jev: none was held back or cut short');
});
