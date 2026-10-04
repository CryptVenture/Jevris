import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, workflow } from './lib.mjs';
import { ownedWorkers } from './owned.mjs';
import { verifySettled } from './verify-run.mjs';

// W04: a parallel monorepo migration. The workers are D's scripted worker port (test mode plus
// the sandbox's test-home marker); the graph validation, the scheduler's waves and leases, the
// separate worktrees, the plan continuing after a verified task, the integration worktree and its
// shared checks, the approval merge and the crashed-lease reconciliation are the product's.
const MODEL = 'claude-sonnet-4-5';
const LOCK_BEFORE = '{"lockfileVersion":3,"packages":{}}\n';
const LOCK_AFTER = '{"lockfileVersion":3,"packages":{"packages/a":{"version":"2.0.0"}}}\n';

const node = (id, dependencyIds, writeScopes, rootBudgetId = 'migration') => ({
  id,
  schemaVersion: '1.0',
  workspaceId: 'mono',
  revision: 'r1',
  state: 'proposed',
  title: `Migrate ${id}`,
  requirementIds: ['MIG-1'],
  dependencyIds,
  writeScopes,
  acceptanceCheckIds: ['shared'],
  expectedOutputs: ['patch'],
  models: [MODEL],
  rootBudgetId,
});
// Plain `jevris plan` validates the bare TaskNode contract only.
const bare = ({ title, models, expectedOutputs, ...rest }) => rest;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

workflow('W04', 'A parallel monorepo migration', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { jevrisPaths } = await load('platform');
  box.write('work/packages/a/index.mjs', 'export const a = 1;\n');
  box.write('work/packages/b/index.mjs', 'export const b = 1;\n');
  box.write('work/packages/c/index.mjs', 'export const c = 1;\n');
  box.write('work/package-lock.json', LOCK_BEFORE);
  // The shared check: every package loads and the lockfile parses.
  box.write('work/check-shared.mjs', "import { readFileSync } from 'node:fs';\nawait import('./packages/a/index.mjs');\nawait import('./packages/b/index.mjs');\nawait import('./packages/c/index.mjs');\nJSON.parse(readFileSync('package-lock.json', 'utf8'));\nconsole.log('shared checks ok');\n");
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'shared', argv: [process.execPath, 'check-shared.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['MIG-1'], description: 'the shared monorepo checks' }],
  });
  box.gitInit();
  // Each run is keyed to its task, so the parallel workers get theirs whichever starts first.
  await box.workerScript([
    { taskId: 'A', writes: [{ path: 'packages/a/index.mjs', text: 'export const a = 2;\n' }], status: 'completed', costUsd: 0.02, reason: 'migrated package a' },
    { taskId: 'B', writes: [{ path: 'packages/b/index.mjs', text: 'export const b = 2;\n' }], status: 'completed', costUsd: 0.02, reason: 'migrated package b' },
    { taskId: 'L', writes: [{ path: 'package-lock.json', text: LOCK_AFTER }], status: 'completed', costUsd: 0.01, reason: 'updated the lockfile' },
  ]);
  await ownedWorkers(box);
  const client = await box.mcp();
  const task = async (taskId, until) => {
    let result;
    for (let i = 0; i < 150; i += 1) {
      result = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId } })).structuredContent?.result;
      if (until === undefined || result?.task?.state === until) break;
      await sleep(100);
    }
    return result;
  };
  const worktrees = (taskId) => box.git('worktree', 'list', '--porcelain').stdout.split('\n').filter((line) => line.startsWith(`branch refs/heads/jevris/${taskId}-`));
  const head = () => box.git('rev-parse', 'HEAD').stdout.trim();

  await then('deterministic graph validation detects the shared lockfile dependency', () => {
    // Two tasks that could run in parallel both write the lockfile: refused before any worker.
    const racing = box.write('racing.json', [bare(node('A', [], ['packages/a', 'package-lock.json'])), bare(node('L', [], ['package-lock.json']))]);
    const refused = box.jevris(['plan', '--graph', racing], { json: true });
    evidence(refused.json);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.result.valid, false);
    assert.deepEqual(refused.json.result.issues.map((issue) => [issue.taskId, issue.code]), [['A', 'WRITE_OVERLAP'], ['L', 'WRITE_OVERLAP']]);
    // With the lockfile task after A, the graph is valid: A and B in parallel, L serialized.
    const fixed = box.write('fixed.json', [bare(node('A', [], ['packages/a'])), bare(node('B', [], ['packages/b'])), bare(node('L', ['A'], ['package-lock.json']))]);
    const valid = box.jevris(['plan', '--graph', fixed], { json: true });
    evidence(valid.json);
    assert.equal(valid.code, 0, `plan: ${valid.stdout}`);
    assert.deepEqual(valid.json.result.waves, [['A', 'B'], ['L']]);
    assert.deepEqual(valid.json.result.ready, ['A', 'B']);
  });

  await then('two workers start in separate worktrees and the lockfile task is serialized', async () => {
    const plan = box.write('plan.json', { tasks: [node('A', [], ['packages/a']), node('B', [], ['packages/b']), node('L', ['A'], ['package-lock.json'])] });
    const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'migration', '--limit-micro-usd', '5000000', '--authorization', box.authorizeBudget('migration'), '--yes'], { json: true });
    evidence(submitted.json);
    assert.equal(submitted.code, 0, `plan --submit: ${submitted.stdout} ${submitted.stderr}`);
    assert.deepEqual(submitted.json.waves, [['A', 'B'], ['L']]);
    assert.equal(submitted.json.leaseIds.length, 2, 'A and B were not leased together');
    const [a, b] = [await task('A', 'awaiting-evidence'), await task('B', 'awaiting-evidence')];
    evidence({ a, b });
    assert.equal(a.task.state, 'awaiting-evidence');
    assert.equal(b.task.state, 'awaiting-evidence');
    assert.equal(worktrees('A').length, 1);
    assert.equal(worktrees('B').length, 1);
    // The lockfile task waits for A: no lease, no worker, no worktree.
    const l = await task('L');
    assert.equal(l.task.state, 'validated', `L is ${l.task.state}`);
    assert.equal(l.worker, null);
    assert.equal(worktrees('L').length, 0);
    assert.equal(box.read('work/packages/a/index.mjs'), 'export const a = 1;\n', 'a worker wrote into the main checkout');
  });

  await then('each worker produces a patch and fresh check receipts in its own worktree', async () => {
    for (const id of ['A', 'B']) {
      const verify = await verifySettled(box, ['--task', id], { task: id });
      evidence(verify.json);
      assert.equal(verify.code, 0, `verify --task ${id}: ${verify.stdout}`);
      assert.equal(verify.json.result.checks[0].fresh, true);
    }
    // A verified: the plan continues and the serialized lockfile task runs now.
    const l = await task('L', 'awaiting-evidence');
    evidence(l);
    assert.equal(l.task.state, 'awaiting-evidence', `L is ${l.task?.state}`);
    assert.equal(worktrees('L').length, 1);
    assert.equal((await verifySettled(box, ['--task', 'L'], { task: 'L' })).code, 0, 'verify --task L failed');
    for (const id of ['A', 'B', 'L']) {
      const done = await task(id);
      assert.equal(done.task.state, 'verified', `${id} is ${done.task.state}`);
      assert.equal(done.receipts[0].fresh, true);
    }
  });

  await then('the integration applies the patches to the expected base and reruns the shared checks', () => {
    const base = head();
    const run = box.jevris(['integrate', 'A', 'B', 'L'], { json: true });
    evidence(run.json);
    assert.equal(run.code, 0, `integrate: ${run.stdout} ${run.stderr}`);
    const report = run.json.report;
    assert.equal(report.state, 'ready');
    assert.equal(report.baseCommit, base);
    assert.deepEqual(report.tasks.map((t) => [t.taskId, t.outcome]), [['A', 'applied'], ['B', 'applied'], ['L', 'applied']]);
    assert.deepEqual(report.checks, { verified: true, mandatoryCheckIds: ['shared'], failing: [], missingEvidence: [] });
    // Nothing reaches the checkout before a person approves.
    assert.equal(head(), base);
    assert.equal(box.read('work/package-lock.json'), LOCK_BEFORE);
    const approved = box.jevris(['integrate', 'approve', report.id, '--yes'], { json: true });
    evidence(approved.json);
    assert.equal(approved.code, 0, `integrate approve: ${approved.stdout}`);
    assert.equal(approved.json.merged, true);
    assert.equal(approved.json.reasonCode, 'MERGED');
    assert.equal(head(), approved.json.report.mergedCommit);
    assert.equal(box.git('merge-base', '--is-ancestor', base, 'HEAD').code, 0, 'the merge did not fast-forward from the base');
    assert.equal(box.read('work/packages/a/index.mjs'), 'export const a = 2;\n');
    assert.equal(box.read('work/packages/b/index.mjs'), 'export const b = 2;\n');
    assert.equal(box.read('work/package-lock.json'), LOCK_AFTER);
    assert.equal(box.git('status', '--porcelain').stdout, '');
  });

  await then('a conflicting patch is reported and nothing is merged', async () => {
    await box.workerScript([{ writes: [{ path: 'packages/b/index.mjs', text: 'export const b = 3;\n' }], status: 'completed', costUsd: 0.01, reason: 'changed package b again' }]);
    const plan = box.write('plan-d.json', { tasks: [node('D', [], ['packages/b'], 'migration-d')] });
    assert.equal(box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'migration-d', '--limit-micro-usd', '2000000', '--authorization', box.authorizeBudget('migration-d'), '--yes'], { json: true }).json?.leaseIds?.length, 1, 'D was not leased');
    assert.equal((await task('D', 'awaiting-evidence'))?.task?.state, 'awaiting-evidence');
    assert.equal((await verifySettled(box, ['--task', 'D'], { task: 'D' })).code, 0, 'verify --task D failed');
    // Someone changes the same line on main after D's worktree was made.
    box.write('work/packages/b/index.mjs', 'export const b = 5;\n');
    box.git('commit', '-q', '-am', 'hotfix b on main');
    const base = head();
    const run = box.jevris(['integrate', 'D'], { json: true });
    evidence(run.json);
    assert.equal(run.code, 1);
    assert.equal(run.json.report.state, 'conflicts');
    assert.deepEqual(run.json.report.tasks.map((t) => [t.taskId, t.outcome, t.conflictPaths]), [['D', 'conflict', ['packages/b/index.mjs']]]);
    assert.equal(run.json.report.checks, null);
    const approved = box.jevris(['integrate', 'approve', run.json.report.id, '--yes'], { json: true });
    evidence(approved.json);
    assert.equal(approved.code, 1);
    assert.deepEqual([approved.json.merged, approved.json.reasonCode], [false, 'NOT_READY']);
    assert.equal(head(), base);
    assert.equal(box.read('work/packages/b/index.mjs'), 'export const b = 5;\n');
    assert.equal(box.git('status', '--porcelain').stdout, '');
  });

  await then('a crashed worker\'s lease expires into reconciliation, not an immediate relaunch into the same directory', async () => {
    const go = join(box.dir, 'crashed-worker-may-finish');
    await box.workerScript([{ writes: [{ path: 'packages/c/index.mjs', text: 'export const c = 2;\n' }], status: 'completed', costUsd: 0.01, reason: 'migrated package c', waitForFile: go }]);
    const plan = box.write('plan-e.json', { tasks: [node('E', [], ['packages/c'], 'migration-e')] });
    assert.equal(box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'migration-e', '--limit-micro-usd', '2000000', '--authorization', box.authorizeBudget('migration-e'), '--yes'], { json: true }).json?.leaseIds?.length, 1, 'E was not leased');
    assert.equal((await task('E', 'running'))?.task?.state, 'running');
    const [first] = worktrees('E');
    // The crash: the sidecar, and the worker inside it, die mid-run.
    const pid = Number.parseInt(readFileSync(join(jevrisPaths({ home: box.home }).runtime, 'sidecar.pid'), 'utf8'), 10);
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await sleep(50);
    }
    assert.equal(box.startSidecar().code, 0, 'the sidecar did not restart');
    const crashed = await task('E', 'blocked');
    evidence(crashed);
    assert.equal(crashed.task.state, 'blocked', `after the crash E is ${crashed.task.state}`);
    assert.equal(crashed.worker, null, 'the killed run reported a result');
    assert.deepEqual(worktrees('E'), [first], 'the crashed task was relaunched without a person');
    // Nothing moves until a person reconciles: a later look finds the same blocked task.
    await sleep(500);
    assert.equal((await task('E')).task.state, 'blocked');
    // A person reconciles; the task resumes under a new lease in a new worktree.
    await box.workerScript([{ writes: [{ path: 'packages/c/index.mjs', text: 'export const c = 2;\n' }], status: 'completed', costUsd: 0.01, reason: 'migrated package c' }]);
    const reconciled = box.jevris(['task', 'reconcile', 'E', '--abandoned', '--yes'], { json: true });
    evidence(reconciled.json);
    assert.equal(reconciled.code, 0, `task reconcile: ${reconciled.stdout} ${reconciled.stderr}`);
    assert.equal(reconciled.json.reconciled, true);
    assert.equal(reconciled.json.taskState, 'leased', 'the reconciled task was not leased again');
    const resumed = await task('E', 'awaiting-evidence');
    evidence(resumed);
    assert.equal(resumed.task.state, 'awaiting-evidence');
    assert.equal(resumed.worker.status, 'completed');
    const now = worktrees('E');
    assert.equal(now.length, 2, 'the resumed worker did not get its own worktree');
    assert.equal(now.includes(first), true, 'the crashed worker\'s worktree was not retained');
  });

  await then('nothing from the crashed lease replaces the current task state or its evidence', async () => {
    // A worker killed with its process never returns, so after a real crash nothing from the old
    // lease reaches the task: the worker line and the state are the new lease's, and no late
    // result is counted. A worker that does return after a newer lease (its holder judged dead
    // while it ran) is kept as a stale run and counted in lateResults without changing the task:
    // packages/orchestrator/test/test-worker.test.mjs, "a crashed worker: ... the late result is
    // kept without replacing state", drives that through the same sidecar ops in one process.
    writeFileSync(join(box.dir, 'crashed-worker-may-finish'), '');
    await sleep(500);
    const current = await task('E');
    evidence(current);
    assert.equal(current.task.state, 'awaiting-evidence');
    assert.equal(current.worker.status, 'completed');
    assert.equal(current.lateResults ?? 0, 0);
    assert.deepEqual(current.receipts, [], 'a worker result became evidence');
    const verify = await verifySettled(box, ['--task', 'E'], { task: 'E' });
    assert.equal(verify.code, 0, `verify --task E: ${verify.stdout}`);
    assert.equal((await task('E')).task.state, 'verified');
  });
});
