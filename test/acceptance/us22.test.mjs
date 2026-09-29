import assert from 'node:assert/strict';
import { story } from './lib.mjs';
import { ownedWorkers, submit, taskNode, taskReader } from './owned.mjs';

// Two owned tasks were planned separately for the same objective and touch the same module; a
// third, unrelated task is cancelled plainly. The workers are D's scripted worker port.
story('US22', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/export.mjs', 'export const toCsv = (rows) => rows.join("\\n");\n');
  box.write('work/docs/notes.md', '# Notes\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['REQ-1'], description: 'the unit tests' }],
  });
  box.gitInit();
  await box.workerScript([
    { taskId: 'T1', writes: [{ path: 'lib/export.mjs', text: 'export const toCsv = (rows) => rows.map(String).join("\\n");\n' }], status: 'completed', costUsd: 0.01 },
    { taskId: 'T2', writes: [{ path: 'lib/export.mjs', text: 'export const toCsv = (rows) => rows.map((r) => `${r}`).join("\\n");\n' }], status: 'completed', costUsd: 0.01 },
    { taskId: 'T3', writes: [{ path: 'docs/notes.md', text: '# Notes\n\nRelease notes.\n' }], status: 'completed', costUsd: 0.01 },
  ]);
  // Three submits in a row, each leasing at once: the global cap (default 2) counts running
  // leases, and the sidecar answers the third submit while the first two may still run (git runs
  // off its event loop since eb6d6d5), so the cap is raised to the three tasks.
  await ownedWorkers(box, { maxWorkers: 3 });
  const title = 'Quote values in the CSV export';
  submit(box, [taskNode('T1', { title, writeScopes: ['lib'], rootBudgetId: 'first' })]);
  submit(box, [taskNode('T2', { title, writeScopes: ['lib'], rootBudgetId: 'second' })]);
  submit(box, [taskNode('T3', { title: 'Write the release notes', writeScopes: ['docs'], rootBudgetId: 'third' })]);
  const client = await box.mcp();
  const task = taskReader(client);
  for (const id of ['T1', 'T2', 'T3']) assert.equal((await task(id, 'awaiting-evidence'))?.task?.state, 'awaiting-evidence', `${id} did not finish`);

  await then('The system proposes reconciliation and cancels only owned work under policy, with false-cancellation feedback captured', async () => {
    // The advice names the duplicate pair and a survivor, and changes nothing by itself.
    const advice = box.jevris(['advise', 'C28', '--json'], { json: true });
    evidence(advice.json);
    assert.equal(advice.code, 0, advice.stderr);
    const result = advice.json.result;
    assert.equal(result.capabilityId, 'C28');
    assert.deepEqual(result.ranked.map((pair) => pair.id), ['T1~T2'], JSON.stringify(result));
    assert.match(result.ranked[0].reason, /^path overlap \d+%, objective overlap \d+%$/);
    assert.deepEqual(result.kept, ['T1']);
    const viaTool = await client.callTool({ name: 'jevris_advise', arguments: { capabilityId: 'C28' } });
    assert.deepEqual(viaTool.structuredContent.result.ranked.map((pair) => pair.id), ['T1~T2']);
    for (const id of ['T1', 'T2', 'T3']) assert.equal((await task(id)).task.state, 'awaiting-evidence', `the advice changed ${id}`);
    // No model tool can cancel; a person does, in the CLI.
    const { tools } = await client.listTools();
    assert.deepEqual(tools.filter((tool) => /cancel/.test(tool.name)).map((tool) => tool.name), []);
    const unconfirmed = box.jevris(['task', 'cancel', 'T2', '--duplicate-of', 'T1', '--json'], { json: true });
    assert.equal(unconfirmed.code, 2);
    assert.equal((await task('T2')).task.state, 'awaiting-evidence');
    const cancelled = box.jevris(['task', 'cancel', 'T2', '--duplicate-of', 'T1', '--yes', '--json'], { json: true });
    evidence(cancelled.json);
    assert.equal(cancelled.code, 0, cancelled.stdout);
    assert.equal(cancelled.json.cancelled, true);
    assert.equal((await task('T2')).task.state, 'cancelled');
    assert.equal((await task('T1')).task.state, 'awaiting-evidence', 'the survivor was touched');
    assert.equal((await task('T3')).task.state, 'awaiting-evidence', 'an unrelated task was touched');
    // The person decides the cancellation was wrong: recorded as a false cancellation.
    const reverted = box.jevris(['task', 'revert-duplicate', 'T2', '--yes', '--json'], { json: true });
    evidence(reverted.json);
    assert.equal(reverted.code, 0, reverted.stdout);
    assert.equal(reverted.json.reasonCode, 'FALSE_CANCELLATION_RECORDED');
    // Only a duplicate cancellation counts as feedback.
    assert.equal(box.jevris(['task', 'cancel', 'T3', '--yes', '--json'], { json: true }).code, 0);
    const plain = box.jevris(['task', 'revert-duplicate', 'T3', '--yes', '--json'], { json: true });
    evidence(plain.json);
    assert.equal(plain.json.reasonCode, 'NOT_A_DUPLICATE_CANCELLATION');
  });
});
