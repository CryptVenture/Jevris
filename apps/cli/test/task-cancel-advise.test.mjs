// US21 and US22 surfaces against a real sidecar: `jevris task cancel` (D's task.cancel, CLI
// only, confirmed by a person) and `jevris advise` / jevris_advise (D's orchestration and
// verification capabilities through capability.advise). Pairs: unconfirmed and confirmed
// cancel of a running owned task; C28 with one active task and with two overlapping ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { ownedRepo, submit, taskNode } from './owned-sandbox.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const guardsFalse = (advice) => Object.values(advice.guards).every((flag) => flag === false);

test('task cancel needs a person, then cancels the running owned task and keeps its worktree (US21)', { skip: managedHostSkip() }, async (t) => {
  const box = await ownedRepo(t, 1);
  submit(box, [taskNode('T1')]);
  const unconfirmed = box.jevris(['task', 'cancel', 'T1'], { json: true });
  assert.equal(unconfirmed.code, 2, 'cancelled without confirmation');
  const client = await box.mcp();
  const before = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId: 'T1' } })).structuredContent.result;
  assert.notEqual(before.task.state, 'cancelled');

  const cancelled = box.jevris(['task', 'cancel', 'T1', '--yes'], { json: true });
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  assert.deepEqual([cancelled.json.command, cancelled.json.cancelled, cancelled.json.reasonCode, cancelled.json.task.state], ['task cancel', true, 'CANCELLED', 'cancelled']);
  const after = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId: 'T1' } })).structuredContent.result;
  assert.equal(after.task.state, 'cancelled');
  // Cancelling it again cancels nothing.
  const again = box.jevris(['task', 'cancel', 'T1', '--yes'], { json: true });
  assert.deepEqual([again.code, again.json.cancelled, again.json.reasonCode, again.json.task.state], [1, false, 'NOT_CANCELLED', 'cancelled']);
  // A plain cancellation is not a duplicate one, so it cannot be reverted as one.
  const plain = box.jevris(['task', 'revert-duplicate', 'T1', '--yes'], { json: true });
  assert.deepEqual([plain.code, plain.json.command, plain.json.recorded, plain.json.reasonCode], [1, 'task revert-duplicate', false, 'NOT_A_DUPLICATE_CANCELLATION']);
  const human = box.jevris(['task', 'cancel', 'T-none', '--yes']);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /nothing was cancelled/i);

  // No model tool cancels a task.
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => /cancel/.test(name)), []);
  assert.equal(existsSync(join(box.work, 'src', 'a.js')), true); // test-hygiene: not product source
});

test('advise C28 reports no overlap for one active task and flags two tasks writing the same scope (US22)', { skip: managedHostSkip() }, async (t) => {
  const box = await ownedRepo(t, 2);
  submit(box, [taskNode('T1', { title: 'Fix the parser bug' })]);
  const one = box.jevris(['advise', 'C28'], { json: true });
  assert.equal(one.code, 0, one.stdout + one.stderr);
  assert.equal(one.json.mode, 'full');
  assert.equal(one.json.result.capabilityId, 'C28');
  assert.equal(one.json.result.reasonCode, 'NO_OVERLAP');
  assert.equal(guardsFalse(one.json.result), true);

  submit(box, [taskNode('T2', { rootBudgetId: 'second', title: 'Fix the parser bug' })], 'second');
  const client = await box.mcp();
  const two = (await client.callTool({ name: 'jevris_advise', arguments: { capabilityId: 'C28' } })).structuredContent;
  assert.equal(two.command, 'capability.advise');
  assert.equal(two.result.capabilityId, 'C28');
  assert.notEqual(two.result.reasonCode, 'NO_OVERLAP', JSON.stringify(two.result));
  assert.ok(two.result.ranked.some((item) => /T1/.test(`${item.id} ${item.label}`) && /T2/.test(`${item.id} ${item.label} ${item.reason}`)), JSON.stringify(two.result.ranked));
  assert.equal(guardsFalse(two.result), true);
  // Advice changed nothing: both tasks are still active.
  for (const taskId of ['T1', 'T2']) {
    const view = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId } })).structuredContent.result;
    assert.notEqual(view.task.state, 'cancelled');
  }

  // The person accepts it: T2 is cancelled as a duplicate of T1, and T1 keeps running.
  assert.equal(box.jevris(['task', 'revert-duplicate', 'T2'], { json: true }).code, 2, 'reverted without confirmation');
  assert.equal(box.jevris(['task', 'cancel', 'T2', '--duplicate-of', 'T2', '--yes'], { json: true }).code, 2, 'a task is not its own duplicate');
  const dup = box.jevris(['task', 'cancel', 'T2', '--duplicate-of', 'T1', '--yes'], { json: true });
  assert.equal(dup.code, 0, dup.stdout + dup.stderr);
  assert.deepEqual([dup.json.cancelled, dup.json.duplicateOf, dup.json.task.state], [true, 'T1', 'cancelled']);
  const survivor = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId: 'T1' } })).structuredContent.result;
  assert.notEqual(survivor.task.state, 'cancelled');
  // Then says it was wrong: recorded once as a false cancellation.
  const reverted = box.jevris(['task', 'revert-duplicate', 'T2', '--yes'], { json: true });
  assert.equal(reverted.code, 0, reverted.stdout + reverted.stderr);
  assert.deepEqual([reverted.json.recorded, reverted.json.reasonCode, reverted.json.taskId], [true, 'FALSE_CANCELLATION_RECORDED', 'T2']);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).filter((name) => /cancel|revert/.test(name)), []);
});

test('advise passes only the capability\'s own input keys, checked before any request', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  assert.equal(box.startSidecar().code, 0);
  const role = box.jevris(['advise', 'C26', '--input', '{"phase":"verifier"}'], { json: true });
  assert.equal(role.code, 0, role.stdout + role.stderr);
  assert.equal(role.json.result.capabilityId, 'C26');
  const impact = box.jevris(['advise', 'C41', '--input', '{"base":"HEAD"}'], { json: true });
  assert.equal(impact.code, 0, impact.stdout + impact.stderr);
  for (const argv of [
    ['advise', 'C57'],
    ['advise', 'C41', '--input', '{"checkId":"unit"}'],
    ['advise', 'C41', '--input', '{"base":"--upload-pack=x"}'],
    ['advise', 'C26', '--input', '{"phase":"admin"}'],
    ['advise', 'C41', '--input', 'not json'],
  ]) {
    const refused = box.jevris(argv, { json: true });
    assert.equal(refused.code, 2, `${argv.join(' ')}: ${refused.stdout}`);
  }
  const client = await box.mcp();
  const wrong = await client.callTool({ name: 'jevris_advise', arguments: { capabilityId: 'C46', input: { base: 'HEAD' } } });
  assert.equal(wrong.isError, true, 'a key of another capability is refused');
});
