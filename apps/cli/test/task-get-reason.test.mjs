// JEV-0074: the task view of `task.get` carries a reason CODE for a blocked, failed or cancelled task, optionally. The CLI prints it
// as `reason: <code>` and the surface contract takes only a code, so a recorded sentence (a path, a scope, a time) cannot reach a client.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../../../packages/contracts/dist/index.js');
const { renderHuman } = await import('../dist/public/render.js');

const view = (task) => ({ taskId: 'T1', found: true, task: { id: 'T1', revision: 'r8', requirementIds: ['R1'], dependencyIds: [], acceptanceCheckIds: ['unit'], ...task }, receipts: [], worker: null });
const wrap = (result) => ({ schemaVersion: '1.0', command: 'task.get', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'ws-0123456789abcdef', root: null }, summary: 'Task T1 is failed.', result });

test('the task contract takes a reason code on a failed task, and only a code', () => {
  const contract = c.surfacePayloadContract('task.get');
  assert.equal(contract.validate(view({ state: 'failed' })).ok, true, 'optional: a failed task without one is valid');
  assert.equal(contract.validate(view({ state: 'failed', stateReason: 'WORKER_RUN_FAILED' })).ok, true);
  assert.equal(contract.validate(view({ state: 'cancelled', stateReason: 'RECONCILED_ABANDONED' })).ok, true);
  assert.equal(contract.validate(view({ state: 'failed', stateReason: 'worker run failed (WORKER_RUN_FAILED)' })).ok, false, 'never the recorded sentence');
  assert.equal(contract.validate(view({ state: 'failed', stateReason: 'WORKER_RUN_FAILED: the worker port threw (EEXIST)' })).ok, false);
  assert.equal(contract.validate(view({ state: 'failed', stateReason: '/Users/me/secret' })).ok, false);
});

test('the CLI prints the reason code of a failed task on its own line, and no line when there is none', () => {
  const text = renderHuman(wrap(view({ state: 'failed', stateReason: 'WORKER_RUN_FAILED' }))).split('\n');
  const at = text.indexOf('state: failed');
  assert.notEqual(at, -1);
  assert.equal(text[at + 1], 'reason: WORKER_RUN_FAILED', 'the reason is the line after the state');
  assert.doesNotMatch(renderHuman(wrap(view({ state: 'failed' }))), /^reason:/m);
  assert.match(renderHuman(wrap(view({ state: 'blocked', stateReason: 'DEPENDENCY_CANCELLED' }))), /^reason: DEPENDENCY_CANCELLED$/m, 'a blocked task prints it as before');
});
