import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { ownedWorkers, submit, taskNode } from '../../../test/acceptance/owned.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// JEV-0074: a task whose worker run threw is `failed`, and `jevris_get_task` must say why: docs/troubleshooting.md sends a person
// to `task.stateReason`, and the field was present only on a blocked task. This is the E2E tester's own scenario against the real
// pieces: a spawned sidecar with a scripted owned worker whose writes collide (`a` as a file, then `a/b` under it, so the port throws
// inside its run), and the real MCP server answering `jevris_get_task`, whose structured result the MCP SDK checks against the
// tool's output schema. The reason is the code `WORKER_RUN_FAILED` and never the error: no message, no error code, no path.

const SECRET = 'FAKE-VENDOR-BODY';

test('jevris_get_task shows WORKER_RUN_FAILED as the stateReason of a task whose worker run threw, and nothing of the error (JEV-0074)', { skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  box.write('work/jevris.checks.json', { schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', description: 'unit tests' }] });
  box.gitInit();
  await box.workerScript([
    { taskId: 'boom', status: 'completed', costUsd: 0.01, writes: [{ path: 'a', text: SECRET }, { path: 'a/b', text: SECRET }] },
    { taskId: 'behind', status: 'completed', costUsd: 0.01, writes: [{ path: 'notes/behind.txt', text: 'ok\n' }] },
  ]);
  await ownedWorkers(box, { maxWorkers: 1 });
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  // One slot: `boom` runs and throws; `behind` queues and starts when the failed run ends.
  submit(box, [taskNode('boom', { writeScopes: ['a', 'a/b'] }), taskNode('behind', { writeScopes: ['notes/behind.txt'] })], { leased: 1 });
  const client = await box.mcp();
  const get = async (taskId, state) => {
    let result;
    for (let i = 0; i < 300; i += 1) {
      const answer = await client.callTool({ name: 'jevris_get_task', arguments: { taskId } });
      result = answer.structuredContent?.result;
      if (result?.task?.state === state) return { result, text: JSON.stringify(answer) };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`task ${taskId} did not reach ${state}: ${JSON.stringify(result)}`);
  };
  const failed = await get('boom', 'failed');
  assert.equal(failed.result.task.stateReason, 'WORKER_RUN_FAILED', `the failed task says why: ${JSON.stringify(failed.result.task)}`);
  assert.deepEqual(Object.keys(failed.result.task).sort(), ['acceptanceCheckIds', 'dependencyIds', 'id', 'requirementIds', 'revision', 'state', 'stateReason'], 'one field added, none changed');
  assert.doesNotMatch(failed.text, new RegExp(`${SECRET}|EEXIST|ENOTDIR|worker port threw|worker run failed`), 'a reason code, never the error, its code or the recorded sentence');
  assert.equal(failed.result.worker.status, 'failed');
  // The sidecar stayed up and the queue behind the failed run started (JEV-0068), which is what the client sees next to the reason.
  const behind = await get('behind', 'awaiting-evidence');
  assert.equal(Object.hasOwn(behind.result.task, 'stateReason'), false, 'a task that ran has no reason to give');
});
