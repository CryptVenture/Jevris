import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { story } from './lib.mjs';
import { ownedWorkers, submit, taskNode, taskReader } from './owned.mjs';

// A test keeps failing because its database service is not running: the diagnostic names a
// refused connection and nothing in the source. The worker is D's scripted worker port.
const MISSING_SERVICE = 'Error: connect ECONNREFUSED 127.0.0.1:5432 (the postgres service is not running)';
const WEAK = 'claude-haiku-4-5';
const STRONG = 'claude-sonnet-4-5';

story('US08', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/users.mjs', 'export const table = "users";\n');
  box.write('work/check-db.mjs', `console.error(${JSON.stringify(MISSING_SERVICE)});\nprocess.exit(1);\n`);
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, 'check-db.mjs'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['DB-1'], description: 'the database integration tests' }],
  });
  box.gitInit();
  const relaunched = join(box.dir, 'relaunched-prompt.txt');
  await box.workerScript([
    { writes: [{ path: 'lib/users.mjs', text: 'export const table = "users_v2";\n' }], status: 'failed', costUsd: 0.01, reason: MISSING_SERVICE },
    { writes: [], status: 'failed', costUsd: 0.01, reason: MISSING_SERVICE, promptTo: relaunched },
  ]);
  await ownedWorkers(box);
  submit(box, [taskNode('T1', { title: 'Rename the users table', requirementIds: ['DB-1'], writeScopes: ['lib'], models: [WEAK, STRONG] })]);
  const task = taskReader(await box.mcp());
  assert.equal((await task('T1', 'failed'))?.task?.state, 'failed', 'the owned worker did not fail');
  // The failing check's own receipt carries the same missing-service diagnostic.
  const verify = box.jevris(['verify', '--check', 'unit'], { json: true });
  assert.equal(verify.json.result.checks[0].outcome, 'failed');

  await then('The proposed next step requests environment evidence instead of automatically escalating the coding model', async () => {
    const advice = box.jevris(['recover', '--failure', MISSING_SERVICE, '--failure', MISSING_SERVICE, '--failure', MISSING_SERVICE, '--task', 'T1'], { json: true });
    evidence(advice.json);
    assert.equal(advice.code, 0, advice.stderr);
    assert.equal(advice.json.result.classification, 'environment-failure');
    assert.equal(advice.json.result.action, 'ask-focused-question');
    assert.notEqual(advice.json.result.action, 'route-stronger-worker');
    assert.match(advice.json.result.advice, /Next step: request environment evidence\./);
    assert.match(advice.json.result.advice, /An environment failure is not escalated\./);
    assert.equal(advice.json.result.signals.environmentFailures, 3);
    // Nothing was relaunched: the task is still the weak worker's failed run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await task('T1');
    evidence(after);
    assert.equal(after.task.state, 'failed');
    assert.equal(after.worker.requestedModel, WEAK, 'a stronger model was launched');
    assert.equal(existsSync(relaunched), false, 'a second worker started');
  });
});
