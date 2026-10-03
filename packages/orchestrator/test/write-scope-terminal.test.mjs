// JEV-0039 (by design, owner decision still open): task.submit checks a new task's write scopes against
// every task that is not cancelled. A task that is active, verified or failed keeps its scope, because a
// verified or failed task can be reopened by the state machine; only a cancelled task is out of the
// graph and releases it. A declared dependency on the holder lifts the overlap. This pins both
// directions with real task states: a worker run that ends verified, a task moved to failed, and a
// cancelled one. Scripted workers, temp home and repository; no model, no harness binary.
// The pinned behaviour is by design and is an owner-visible rule (docs/mcp.md, jevris_submit_task): do not change it to make a test pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, drainBackgroundWorkers, getTask, manifestHash, openWorkspace, parseManifest, scriptedWorkerPort, setTaskOpDeps, sidecarOps, transitionTask } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function fixture(runs) {
  const dir = tempDir('jv-wst-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  for (const d of ['mod', 'lib']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'lib', 'b.txt'), 'b\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'shared', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { shared: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const script = join(dir, 'worker-script.json');
  writeFileSync(script, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: runs.map((writes) => ({ writes, status: 'completed', costUsd: 0.01 })) }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
  });
  const node = (id, scope, extra = {}) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['shared'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'], rootBudgetId: 'b1', ...extra });
  const submit = async (task) => {
    const out = await call('task.submit', { task });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.body;
  };
  return {
    ws, call, node, submit,
    done: async () => {
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a verified or failed task keeps its write scope, a cancelled one releases it, and a declared dependency lifts the overlap (JEV-0039)', async () => {
  const w = (path, text) => [{ path, text }];
  const f = await fixture([w('mod/a.txt', 'a2\n'), w('mod/a.txt', 'a3\n'), w('lib/b.txt', 'b2\n'), w('lib/b.txt', 'b3\n')]);
  try {
    // T1 runs and is verified by its approved check: terminal, and it still holds `mod`.
    const first = await f.call('plan.submit', { plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['shared'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(first.ok, true, JSON.stringify(first));
    await drainBackgroundWorkers();
    assert.equal(getTask(f.ws, 'T1').node.state, 'awaiting-evidence', 'T1 is active, not terminal');
    const clashActive = await f.submit(f.node('T0', 'mod'));
    assert.deepEqual([clashActive.accepted, clashActive.reasonCode, clashActive.detail], [false, 'WRITE_OVERLAP', 'T1~T0'], 'an active task holds its scope');
    const verified = await f.call('verify', { taskId: 'T1', checkIds: [] });
    assert.equal(getTask(f.ws, 'T1').node.state, 'verified', JSON.stringify(verified.body));
    const clashVerified = await f.submit(f.node('T2', 'mod'));
    assert.deepEqual([clashVerified.accepted, clashVerified.reasonCode, clashVerified.detail], [false, 'WRITE_OVERLAP', 'T1~T2'], 'a verified task still holds its scope');
    const lifted = await f.submit(f.node('T3', 'mod', { dependencyIds: ['T1'] }));
    assert.equal(lifted.accepted, true, `a declared dependency on the verified holder lifts the overlap: ${JSON.stringify(lifted)}`);
    await drainBackgroundWorkers();

    // T4 runs, then ends failed: terminal, and it still holds `lib`.
    const t4 = await f.submit(f.node('T4', 'lib'));
    assert.equal(t4.accepted, true, JSON.stringify(t4));
    await drainBackgroundWorkers();
    const failed = await transitionTask(f.ws, 'T4', 'failed', 'worker gave up');
    assert.equal(failed.ok, true, JSON.stringify(failed));
    assert.equal(getTask(f.ws, 'T4').node.state, 'failed');
    const clashFailed = await f.submit(f.node('T5', 'lib'));
    assert.deepEqual([clashFailed.accepted, clashFailed.reasonCode, clashFailed.detail], [false, 'WRITE_OVERLAP', 'T4~T5'], 'a failed task still holds its scope');

    // Cancelled is the one state that releases it: the same submit is now accepted.
    const cancelled = await f.call('task.cancel', { taskId: 'T4' });
    assert.equal(cancelled.body.task.state, 'cancelled', JSON.stringify(cancelled));
    const released = await f.submit(f.node('T5', 'lib'));
    assert.equal(released.accepted, true, `a cancelled task releases its scope: ${JSON.stringify(released)}`);
  } finally {
    await f.done();
  }
});
