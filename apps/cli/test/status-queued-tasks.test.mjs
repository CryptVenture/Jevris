// JEV-0069: `jevris status` shows how many owned tasks are queued, next to the active workers, so "active workers: none"
// while work waits (the hand-over between two workers) cannot read as an idle queue. The field is optional (absent or
// null when the sidecar cannot count), additive (every existing line stays), and a count, never a list or text.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../../../packages/contracts/dist/index.js');
const { renderHuman } = await import('../dist/public/render.js');

const status = {
  jevrisMode: 'bounded-auto', killSwitch: 'clear', decisionHealth: 'healthy', degradedReason: null,
  routing: { modelPin: null, pinned: false }, activeWorkers: [], budget: { state: 'within', reservedMicroUsd: 0, limitMicroUsd: 5000000 },
  recentDecisions: [], unknownSlices: [], store: { state: 'ok', diagnostic: null },
};
const wrap = (result) => ({ schemaVersion: '1.0', command: 'status', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'ws-0123456789abcdef', root: null }, summary: 'A summary.', result });

test('the status contract takes queuedTasks as an optional, nullable count and nothing else', () => {
  const contract = c.surfacePayloadContract('status');
  assert.equal(contract.validate(status).ok, true, 'a status without the field is still valid');
  assert.equal(contract.validate({ ...status, queuedTasks: 0 }).ok, true);
  assert.equal(contract.validate({ ...status, queuedTasks: 5 }).ok, true);
  assert.equal(contract.validate({ ...status, queuedTasks: null }).ok, true);
  assert.equal(contract.validate({ ...status, queuedTasks: -1 }).ok, false);
  assert.equal(contract.validate({ ...status, queuedTasks: 1.5 }).ok, false);
  assert.equal(contract.validate({ ...status, queuedTasks: '3' }).ok, false);
  assert.equal(contract.validate({ ...status, queuedTasks: ['T1'] }).ok, false);
});

test('the CLI prints the queued tasks right after the active workers, and every existing line stays', () => {
  const without = renderHuman(wrap(status)).split('\n');
  const text = renderHuman(wrap({ ...status, queuedTasks: 3 })).split('\n');
  const at = text.indexOf('active workers: none');
  assert.notEqual(at, -1, 'the active workers line is still there');
  assert.equal(text[at + 1], 'queued tasks: 3', '"none" is never printed without the queue beside it');
  assert.deepEqual(text.filter((l) => l !== 'queued tasks: 3'), without, 'the one added line is the only change');
  assert.match(renderHuman(wrap({ ...status, queuedTasks: 0 })), /^queued tasks: 0$/m, 'an idle queue says 0');
  assert.match(renderHuman(wrap({ ...status, activeWorkers: ['T2'], queuedTasks: 4 })), /^active workers: T2\nqueued tasks: 4$/m);
});

test('no queued-tasks line when the sidecar did not count (the field absent or null)', () => {
  assert.doesNotMatch(renderHuman(wrap(status)), /queued tasks/);
  assert.doesNotMatch(renderHuman(wrap({ ...status, queuedTasks: null })), /queued tasks/);
});
