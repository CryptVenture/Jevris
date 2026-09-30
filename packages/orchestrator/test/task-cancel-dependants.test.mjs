// JEV-0035 and JEV-0038 through the sidecar ops: cancelling a task others wait on marks them blocked
// with a reason code that task.get shows, and a later unrelated task.submit is still accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { approveManifests, DEFAULT_CONFIG, manifestHash, openWorkspace, parseManifest, sidecarOps, submitPlan, SURFACE_OP_OF } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const op = (name) => sidecarOps.find((o) => o.op === name);

async function fixture() {
  const dir = tempDir('jv-dep-cancel-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const manifest = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [manifest], { unit: manifestHash(manifest) }, 'test');
  // The queue is under test, not the workers: turn orchestration off.
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: false } }));
  const ctx = (name, body) => ({
    op: name,
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    deadline: { budgetMs: 20_000, remainingMs: () => 20_000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: () => {},
  });
  return { ws, ctx, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

function contractual(name, outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const checked = surfacePayloadContract(SURFACE_OP_OF[name]).validate(outcome.body);
  assert.equal(checked.ok, true, JSON.stringify(checked));
}

const node = (id, extra = {}) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}`], rootBudgetId: 'b1', ...extra });

test('task.cancel blocks the queued dependants, task.get shows why, and an unrelated task.submit is accepted (JEV-0035)', async () => {
  const f = await fixture();
  try {
    const plan = await submitPlan(f.ws, {
      tasks: [node('T1'), node('T2', { dependencyIds: ['T1'] }), node('T3')].map(({ rootBudgetId, ...t }) => t),
      ownerId: 'alice',
      channel: 'terminal',
      rootBudget: { id: 'b1', limitMicroUsd: 10_000_000 },
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const cancelled = await op('task.cancel').handle(f.ctx('task.cancel', { taskId: 'T1' }));
    contractual('task.cancel', cancelled);
    assert.equal(cancelled.body.task.state, 'cancelled');
    const dependant = await op('task.get').handle(f.ctx('task.get', { taskId: 'T2' }));
    contractual('task.get', dependant);
    assert.equal(dependant.body.task.state, 'blocked');
    assert.equal(dependant.body.task.stateReason, 'DEPENDENCY_CANCELLED');
    // A task that is not blocked carries no reason.
    const other = await op('task.get').handle(f.ctx('task.get', { taskId: 'T3' }));
    contractual('task.get', other);
    assert.equal(other.body.task.stateReason, undefined);
    // The unrelated submit that was refused with UNKNOWN_DEPENDENCY.
    const added = await op('task.submit').handle(f.ctx('task.submit', { task: node('T4') }));
    contractual('task.submit', added);
    assert.equal(added.body.accepted, true, JSON.stringify(added.body));
    // Naming the cancelled task is still refused, with the code for the new task.
    const named = await op('task.submit').handle(f.ctx('task.submit', { task: node('T5', { dependencyIds: ['T1'] }) }));
    assert.equal(named.body.accepted, false);
    assert.equal(named.body.taskId, 'T5');
    assert.equal(named.body.reasonCode, 'UNKNOWN_DEPENDENCY');
  } finally {
    f.done();
  }
});

// JEV-0038: task.submit takes the approved runner checks only, as plan.submit does.
test('task.submit refuses an acceptance check nobody approved, and accepts an approved one (JEV-0038)', async () => {
  const f = await fixture();
  try {
    const plan = await submitPlan(f.ws, { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['mod/T1'] }], ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 10_000_000 } });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const refused = await op('task.submit').handle(f.ctx('task.submit', { task: node('T2', { acceptanceCheckIds: ['nobody-approved-this'] }) }));
    contractual('task.submit', refused);
    assert.equal(refused.body.accepted, false);
    assert.equal(refused.body.taskId, 'T2');
    assert.equal(refused.body.reasonCode, 'UNKNOWN_CHECK');
    const approved = await op('task.submit').handle(f.ctx('task.submit', { task: node('T3') }));
    assert.equal(approved.body.accepted, true, JSON.stringify(approved.body));
  } finally {
    f.done();
  }
});
