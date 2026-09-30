// JEV-0040: task.submit names why it refused a task (the field and its rule, or the check or scope
// involved) in an optional `detail`, as plan.submit does. The reason code and taskId keep their shape.
// JEV-0039: a verified or failed task can be reopened, so it keeps its write scope: a new task that
// writes the same path is refused unless it declares the dependency (the refusal names the pair).
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
  const dir = tempDir('jv-submit-detail-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const manifest = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [manifest], { unit: manifestHash(manifest) }, 'test');
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
  await submitPlan(ws, { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['mod/one'] }], ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 10_000_000 } });
  return { ws, ctx, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const node = (id, extra = {}) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}`], rootBudgetId: 'b1', ...extra });

async function submit(f, task) {
  const out = await op('task.submit').handle(f.ctx('task.submit', { task }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(surfacePayloadContract(SURFACE_OP_OF['task.submit']).validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

test('task.submit names the field and rule that refused a task (JEV-0040)', async () => {
  const f = await fixture();
  try {
    const path = await submit(f, node('T2', { expectedOutputs: ['out/file.txt'] }));
    assert.deepEqual([path.accepted, path.reasonCode, path.taskId], [false, 'INVALID_TASK', null]);
    assert.match(path.detail, /^expectedOutputs: names, not paths/);
    const noBudget = await submit(f, { ...node('T3'), rootBudgetId: undefined });
    assert.equal(noBudget.reasonCode, 'INVALID_TASK');
    assert.match(noBudget.detail, /^rootBudgetId: /);
    const notObject = await submit(f, 'nope');
    assert.equal(notObject.reasonCode, 'INVALID_TASK');
    assert.match(notObject.detail, /^task: /);
    // A refusal from the graph check names the check or the pair.
    const unknown = await submit(f, node('T4', { acceptanceCheckIds: ['nobody-approved-this'] }));
    assert.equal(unknown.reasonCode, 'UNKNOWN_CHECK');
    assert.equal(unknown.detail, 'nobody-approved-this');
    // An accepted task carries no detail.
    const ok = await submit(f, node('T5'));
    assert.equal(ok.accepted, true);
    assert.equal('detail' in ok, false);
  } finally {
    f.done();
  }
});

test('a write scope stays owned by a task that is not cancelled, and a declared dependency lifts the overlap (JEV-0039)', async () => {
  const f = await fixture();
  try {
    const clash = await submit(f, node('T2', { writeScopes: ['mod/one'] }));
    assert.equal(clash.accepted, false);
    assert.equal(clash.reasonCode, 'WRITE_OVERLAP');
    assert.equal(clash.detail, 'T1~T2');
    const ordered = await submit(f, node('T3', { writeScopes: ['mod/one'], dependencyIds: ['T1'] }));
    assert.equal(ordered.accepted, true, JSON.stringify(ordered));
  } finally {
    f.done();
  }
});
