// JEV-0070: with a pause-all budget, the first task that did not fit was refused OVER_BUDGET, which paused the budget. A
// later look at the queue (the drain after a worker ended) met the paused budget and refused the same task again as
// BUDGET_PAUSED, and `budget status` showed that one: the reason of one task flip-flopped, and the docs named neither code.
// The contract: a task keeps the reason of its first refusal while the episode is open, so the first is OVER_BUDGET; a task
// that is first refused while the budget is already paused is BUDGET_PAUSED; and the budget's own state (paused, its policy)
// is shown beside the reasons, never inside them. An answered episode (a resume or a raise) starts the reasons again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, drainBackgroundWorkers, getTask, manifestHash, openWorkspace, parseManifest, setTaskOpDeps, sidecarOps } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function until(check, what) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Two workers fit the owned envelope (limit 30,000 minus the 5,000 reserve, 10,000 each) and run until released; the third
 * (C) does not fit and is refused. Their vendor usage is unknown (no costUsd), so their reservations stay held in full when
 * they end: C still does not fit at the next look at the queue.
 */
async function fixture(policy) {
  const dir = tempDir('jv-brr-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  for (const d of ['a', 'b', 'c', 'd']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 3 } }));
  let go = () => {};
  const goes = new Promise((resolve) => (go = resolve));
  setTaskOpDeps({
    workerPort: async () => ({
      run: async (input) => {
        await goes;
        return { status: input.signal.aborted ? 'aborted' : 'completed', reason: 'done', sessionId: null, requestedModel: input.model, actualModel: input.model, costUsd: null, usage: null, turns: 1, durationMs: 1 };
      },
    }),
  });
  const traces = [];
  const call = (op, body, client = 'cli') => sidecarOps.find((o) => o.op === op).handle({
    op, client, scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: (e) => traces.push(e),
  });
  const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-opus-5', 'claude-sonnet-5'], estimateMicroUsd: 10_000 });
  const plan = await call('plan.submit', { plan: { tasks: [task('A', 'a'), task('B', 'b'), task('C', 'c')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 30_000, shutdownReserveMicroUsd: 5_000, policy } });
  assert.equal(plan.body.leaseIds.length, 2, JSON.stringify(plan.body));
  /** What `jevris budget status` shows: the budget's own state, and each refused task with its reason. */
  const view = async () => {
    const got = (await call('budget.get', { budgetId: 'b1' })).body;
    return { paused: got.budget.paused, policy: got.budget.policy, refused: (got.exhaustion?.refused ?? []).map((r) => [r.taskId, r.reasonCode]).sort(), open: got.exhaustion?.open };
  };
  return {
    ws, call, traces, task, view,
    /** Lets the two workers end, and the drain after each of them look at the queue again. */
    release: async () => {
      go();
      await until(() => ['A', 'B'].every((id) => ['awaiting-evidence', 'cancelled', 'failed'].includes(getTask(ws, id)?.node.state ?? '')), 'the workers to end');
      await drainBackgroundWorkers();
    },
    done: async () => {
      go();
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('pause-all: the first refusal is OVER_BUDGET and stays OVER_BUDGET when a later drain looks at the paused budget again (JEV-0070)', async () => {
  const f = await fixture('pause-all');
  try {
    assert.deepEqual(await f.view(), { paused: true, policy: 'pause-all', refused: [['C', 'OVER_BUDGET']], open: true }, 'the refusal paused the budget; C is refused for its size');
    const looked = f.traces.filter((e) => e.event === 'orchestrator.budget-exhausted').length;
    await f.release();
    assert.ok(f.traces.filter((e) => e.event === 'orchestrator.budget-exhausted').length > looked, 'a drain after a worker ended looked at the queue again and met the paused budget');
    assert.deepEqual(await f.view(), { paused: true, policy: 'pause-all', refused: [['C', 'OVER_BUDGET']], open: true }, 'C keeps the reason of its first refusal; the pause is the budget\'s state, shown beside it');
  } finally {
    await f.done();
  }
});

test('pause-all: a task first refused while the budget is already paused is BUDGET_PAUSED, and the task refused before keeps OVER_BUDGET beside it (JEV-0070)', async () => {
  const f = await fixture('pause-all');
  try {
    const d = await f.call('task.submit', { task: { ...f.task('D', 'd'), rootBudgetId: 'b1' } });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.body.reasonCode, 'BUDGET_PAUSED', 'the answer to the submit that was refused for the pause');
    assert.equal(getTask(f.ws, 'D').node.state, 'ready');
    assert.deepEqual(await f.view(), { paused: true, policy: 'pause-all', refused: [['C', 'OVER_BUDGET'], ['D', 'BUDGET_PAUSED']], open: true }, 'C stays listed with its reason when a later request refuses another task');
    await f.release();
    assert.deepEqual(await f.view(), { paused: true, policy: 'pause-all', refused: [['C', 'OVER_BUDGET'], ['D', 'BUDGET_PAUSED']], open: true }, 'and neither flips when the drain looks again');
  } finally {
    await f.done();
  }
});

test('pause-all: a resume at the same limit answers the episode; a task that still does not fit is OVER_BUDGET again, and the budget is not paused again (JEV-0070)', async () => {
  const f = await fixture('pause-all');
  try {
    await f.release();
    const resumed = (await f.call('budget.update', { budgetId: 'b1', resume: true, actor: 'alice' })).body;
    assert.deepEqual([resumed.updated, resumed.budget.paused], [true, false], JSON.stringify(resumed));
    assert.deepEqual(resumed.exhaustion.refused.map((r) => [r.taskId, r.reasonCode]), [['C', 'OVER_BUDGET']]);
    assert.deepEqual(await f.view(), { paused: false, policy: 'pause-all', refused: [['C', 'OVER_BUDGET']], open: true });
  } finally {
    await f.done();
  }
});

for (const policy of ['finish-running', 'cancel-newest']) {
  test(`${policy}: the budget is never paused, and a task refused for its size is OVER_BUDGET at every look at the queue (JEV-0070)`, async () => {
    const f = await fixture(policy);
    try {
      assert.deepEqual(await f.view(), { paused: false, policy, refused: [['C', 'OVER_BUDGET']], open: true });
      await f.release();
      assert.deepEqual(await f.view(), { paused: false, policy, refused: [['C', 'OVER_BUDGET']], open: true });
    } finally {
      await f.done();
    }
  });
}
