// planTaskGraph (`plan --graph`, jevris_plan): the graph checks look at the TaskNode part of a task
// and ignore scheduling fields; a self-dependency is named as such (JEV-0004, JEV-0016).
import test from 'node:test';
import assert from 'node:assert/strict';

const { planTaskGraph } = await import('../dist/index.js');

const node = (id, dependencyIds = []) => ({
  id,
  schemaVersion: '1.0',
  workspaceId: 'ws-1',
  revision: 'r1',
  state: 'proposed',
  requirementIds: ['R1'],
  dependencyIds,
  writeScopes: [`src/${id}`],
  acceptanceCheckIds: ['unit'],
  rootBudgetId: 'b1',
});

test('JEV-0004: title, models and expectedOutputs are accepted and change nothing', () => {
  const plain = planTaskGraph([node('a'), node('b', ['a'])]);
  assert.equal(plain.valid, true);
  for (const extra of [{ title: 'Build the parser' }, { models: ['claude-haiku-4-5'] }, { expectedOutputs: ['parser'] }, { title: 't', models: ['m'], expectedOutputs: ['o'], labels: ['x'] }]) {
    const plan = planTaskGraph([{ ...node('a'), ...extra }, node('b', ['a'])]);
    assert.deepEqual(plan, plain, JSON.stringify(extra));
  }
});

test('JEV-0004: a task that is not a TaskNode is still INVALID_TASK', () => {
  for (const bad of [null, 'a', 7, [], { ...node('a'), state: 'nope' }, { ...node('a'), dependencyIds: undefined }]) {
    const plan = planTaskGraph([bad]);
    assert.equal(plan.valid, false);
    assert.deepEqual(plan.issues, [{ taskId: '#0', code: 'INVALID_TASK' }]);
  }
  const { id, ...noId } = node('a');
  assert.deepEqual(planTaskGraph([{ ...noId, title: 't' }]).issues, [{ taskId: '#0', code: 'INVALID_TASK' }]);
});

test('JEV-0016: a self-dependency is SELF_DEPENDENCY with its advice line', () => {
  const plan = planTaskGraph([node('a', ['a']), node('b', ['a'])]);
  assert.equal(plan.valid, false);
  assert.deepEqual(plan.issues, [{ taskId: 'a', code: 'SELF_DEPENDENCY' }]);
  assert.deepEqual(plan.advice, ['Remove the dependencies of tasks on themselves.']);
});
