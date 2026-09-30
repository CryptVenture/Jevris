// JEV-0006: a task field that breaks a rule is answered with the field and the rule, not a bare
// INVALID_REQUEST, and nothing is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { approveManifests, DEFAULT_CONFIG, listTasks, manifestHash, openWorkspace, parseManifest, parsePlanSubmission, readPlanSubmission, sidecarOps } from '../dist/index.js';
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

const task = (id, extra = {}) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}`], ...extra });
const body = (tasks) => ({ plan: { tasks }, ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 1_000_000 }, channel: 'terminal' });

test('plan.submit names the field and the rule for a path in expectedOutputs and creates nothing (JEV-0006)', async () => {
  const f = await fixture();
  try {
    const out = await op('plan.submit').handle(f.ctx('plan.submit', body([task('T1'), task('T2', { expectedOutputs: ['out/file.txt'] })])));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.body.accepted, false);
    assert.equal(out.body.reasonCode, 'PLAN_INVALID');
    assert.equal(out.body.issues.length, 1);
    const [issue] = out.body.issues;
    assert.equal(issue.taskId, 'T2');
    assert.equal(issue.code, 'INVALID_TASK');
    assert.match(issue.detail, /^expectedOutputs: names, not paths: /);
    assert.match(issue.detail, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$/);
    assert.ok(issue.detail.length <= 200);
    assert.equal(listTasks(f.ws).length, 0);
    assert.equal(f.ws.host.get('budgets', 'b1'), undefined);
  } finally {
    f.done();
  }
});

test('readPlanSubmission names the first bad task field; a body that is wrong elsewhere stays undefined (JEV-0006)', () => {
  const bad = readPlanSubmission(body([task('T1'), task('T2', { value: 500 })]));
  assert.equal(bad.submission, undefined);
  assert.deepEqual(bad.problem, { taskId: 'T2', field: 'value', rule: 'a whole number from 1 to 100', index: 1 });
  assert.equal(parsePlanSubmission(body([task('T1'), task('T2', { value: 500 })])), undefined);
  const noId = readPlanSubmission(body([{ requirementIds: [] }]));
  assert.equal(noId.problem.field, 'id');
  // A bad budget as well: no task is blamed for it.
  const both = readPlanSubmission({ ...body([task('T2', { value: 500 })]), rootBudget: { id: 'b1', limitMicroUsd: -1 } });
  assert.equal(both.submission, undefined);
  assert.equal(both.problem, undefined);
  assert.notEqual(readPlanSubmission(body([task('T1')])).submission, undefined);
});
