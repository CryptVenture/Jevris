import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { story } from './lib.mjs';
import { ownedWorkers, submit, taskNode, taskReader } from './owned.mjs';

// An owned worker is mid-run with uncommitted edits in its worktree when I cancel its task. A
// second task waits on it. The worker is D's scripted worker port: it writes its edit, then
// waits for a file that is only created after the cancel.
const EDIT = 'export const limit = 50; // half-finished edit\n';

story('US21', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/limit.mjs', 'export const limit = 10;\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['REQ-1'], description: 'the unit tests' }],
  });
  box.gitInit();
  const go = join(box.dir, 'worker-may-finish');
  await box.workerScript([
    { taskId: 'T1', writes: [{ path: 'lib/limit.mjs', text: EDIT }], status: 'completed', costUsd: 0.01, reason: 'raised the limit', waitForFile: go },
    { taskId: 'T2', writes: [{ path: 'lib/limit.mjs', text: 'export const limit = 60;\n' }], status: 'completed', costUsd: 0.01 },
  ]);
  await ownedWorkers(box);
  submit(box, [taskNode('T1', { title: 'Raise the limit', writeScopes: ['lib'] }), taskNode('T2', { title: 'Document the limit', writeScopes: ['lib'], dependencyIds: ['T1'] })], { leased: 1 });
  const task = taskReader(await box.mcp());
  assert.equal((await task('T1', 'running'))?.task?.state, 'running', 'T1 is not running');
  const worktree = () => {
    const blocks = box.git('worktree', 'list', '--porcelain').stdout.split('\n\n');
    const block = blocks.find((b) => /^branch refs\/heads\/jevris\/T1-/m.test(b));
    return block === undefined ? null : block.split('\n')[0].replace(/^worktree /, '');
  };
  const path = worktree();
  assert.notEqual(path, null, 'T1 has no worktree');
  for (let i = 0; i < 100 && !(existsSync(join(path, 'lib', 'limit.mjs')) && readFileSync(join(path, 'lib', 'limit.mjs'), 'utf8') === EDIT); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readFileSync(join(path, 'lib', 'limit.mjs'), 'utf8'), EDIT, 'the worker has not made its edit');

  await then('Jevris stops scheduling new work, signals owned processes, retains recoverable artifacts and never force-deletes an unknown dirty worktree', async () => {
    // Nothing is cancelled without a person's confirmation.
    const unconfirmed = box.jevris(['task', 'cancel', 'T1', '--json'], { json: true });
    assert.equal(unconfirmed.code, 2);
    assert.equal((await task('T1')).task.state, 'running');
    const cancelled = box.jevris(['task', 'cancel', 'T1', '--yes', '--json'], { json: true });
    evidence(cancelled.json);
    assert.equal(cancelled.code, 0, `task cancel: ${cancelled.stdout} ${cancelled.stderr}`);
    assert.deepEqual([cancelled.json.cancelled, cancelled.json.reasonCode], [true, 'CANCELLED']);
    assert.equal((cancelled.json.task?.task ?? cancelled.json.task)?.state, 'cancelled', `task cancel: ${cancelled.stdout}`);
    // The owned worker was signalled: releasing its wait later does not complete anything.
    writeFileSync(go, '');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const t1 = await task('T1');
    evidence(t1);
    assert.equal(t1.task.state, 'cancelled', `T1 is ${t1.task.state}`);
    assert.notEqual(t1.worker?.status, 'completed', 'the cancelled worker reported completion');
    // No new work: the task waiting on T1 is never leased.
    const t2 = await task('T2');
    assert.notEqual(t2.task.state, 'leased');
    assert.notEqual(t2.task.state, 'running');
    assert.equal(t2.worker, null, 'a worker started after the cancel');
    // The dirty worktree and its edit are kept; the main checkout is untouched.
    assert.equal(worktree(), path, 'the worktree was removed');
    assert.equal(readFileSync(join(path, 'lib', 'limit.mjs'), 'utf8'), EDIT, 'the uncommitted edit was lost');
    assert.match(box.git('-C', path, 'status', '--porcelain').stdout, /lib\/limit\.mjs/);
    assert.equal(box.read('work/lib/limit.mjs'), 'export const limit = 10;\n');
    // A repeated cancel still keeps the worktree.
    box.jevris(['task', 'cancel', 'T1', '--yes', '--json'], { json: true });
    assert.equal(existsSync(join(path, 'lib', 'limit.mjs')), true);
  });
});
