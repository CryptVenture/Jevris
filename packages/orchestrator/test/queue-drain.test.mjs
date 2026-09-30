// JEV-0008: with more independent tasks than `maxConcurrentWorkers`, the queued task starts as
// soon as a slot frees: when a worker ends, and when its task is cancelled. It never starts once
// the kill switch is stopped, however the switch was set after the work began.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, drainBackgroundWorkers, getTask, manifestHash, openWorkspace, parseManifest, scriptedWorkerPort, setTaskOpDeps, sidecarOps } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function until(check, what) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** T1 and T2 run until released (go1, go2); T3 is queued behind the two-worker cap and finishes at once. */
async function fixture({ killSwitchNow } = {}) {
  const dir = tempDir('jv-qd-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  for (const d of ['a', 'b', 'c']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 2 } }));
  const go1 = join(dir, 'go1');
  const go2 = join(dir, 'go2');
  const path = join(dir, 'worker-script.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: [
    { taskId: 'T1', writes: [], status: 'completed', waitForFile: go1 },
    { taskId: 'T2', writes: [], status: 'completed', waitForFile: go2 },
    { taskId: 'T3', writes: [], status: 'completed' },
  ] }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: path };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  const traces = [];
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false,
    ...(killSwitchNow === undefined ? {} : { killSwitchNow }), engine: undefined, trace: (e) => traces.push(e),
  });
  const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'] });
  const plan = await call('plan.submit', { plan: { tasks: [task('T1', 'a'), task('T2', 'b'), task('T3', 'c')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
  assert.equal(plan.body.leaseIds.length, 2, 'the cap starts two workers');
  assert.equal(getTask(ws, 'T3').node.state, 'ready', 'the third waits');
  return {
    ws, call, traces, go1, go2,
    done: async () => {
      writeFileSync(go1, '');
      writeFileSync(go2, '');
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('cancelling a running task frees its slot: the queued task is leased and runs (JEV-0008)', async () => {
  const f = await fixture();
  try {
    const cancelled = await f.call('task.cancel', { taskId: 'T1' });
    assert.equal(cancelled.body.task.state, 'cancelled');
    await until(() => ['awaiting-evidence', 'leased', 'running'].includes(getTask(f.ws, 'T3').node.state), 'T3 to start');
    assert.ok(['leased', 'running'].includes(getTask(f.ws, 'T2').node.state), 'the other running task is left alone');
  } finally {
    await f.done();
  }
});

test('a worker that ends frees its slot: the queued task is leased and runs, with nobody else asking (JEV-0008)', async () => {
  const f = await fixture();
  try {
    assert.equal(getTask(f.ws, 'T3').node.state, 'ready');
    writeFileSync(f.go1, '');
    await until(() => getTask(f.ws, 'T3').node.state === 'awaiting-evidence', 'T3 to run after T1 ended');
    assert.notEqual(getTask(f.ws, 'T2').node.state, 'cancelled');
  } finally {
    await f.done();
  }
});

test('a worker that ends while the kill switch is stopped starts nothing: the switch is read live, not as the first request saw it (JEV-0008)', async () => {
  let stopped = false;
  const f = await fixture({ killSwitchNow: async () => stopped });
  try {
    stopped = true;
    writeFileSync(f.go1, '');
    await until(() => f.traces.some((e) => e.event === 'orchestrator.plan-continued' && e.reasonCode === 'KILL_SWITCH'), 'the drain to see the switch');
    assert.equal(getTask(f.ws, 'T3').node.state, 'ready', 'no new worker while stopped');
  } finally {
    await f.done();
  }
});
