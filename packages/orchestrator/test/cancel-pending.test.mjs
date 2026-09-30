// A cancel whose abort was delivered to a running in-process run, but whose end is not published
// inside the caller's deadline, answers "cancel pending", not "nothing cancelled": the task then
// reaches `cancelled` on its own. The run here ignores the abort until the test releases it, so the
// order (answer first, end second) is fixed by the test and no timing decides it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, cancelPending, cancelTask, drainBackgroundWorkers, getTask, leaseAuthorityFor, manifestHash, openWorkspace, parseManifest, setTaskOpDeps, sidecarOps, workerRuns } from '../dist/index.js';
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

/** T1 runs on a port that honours an abort only once `release()` is called (its end publishes late). */
async function fixture() {
  const dir = tempDir('jv-cp-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'a'), { recursive: true });
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
  let started;
  const running = new Promise((resolve) => (started = resolve));
  let release = () => {};
  let abortSeen = false;
  const gate = new Promise((resolve) => (release = resolve));
  const port = {
    run: (input) =>
      new Promise((resolve) => {
        started();
        input.signal.addEventListener('abort', () => {
          abortSeen = true;
          // The abort is delivered now; the run's end is published only when the test lets it.
          void gate.then(() => resolve({ status: 'aborted', reason: 'aborted', sessionId: 's1', requestedModel: input.model, actualModel: input.model, costUsd: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, turns: 0, durationMs: 1 }));
        }, { once: true });
      }),
  };
  setTaskOpDeps({ workerPort: async () => port });
  // remainingMs() is 101: the cancel waits 1 ms for the run's end, a fixed short wait, never a window a run could beat.
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 900, remainingMs: () => 101, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
  });
  const plan = await call('plan.submit', { plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['a'], models: ['claude-sonnet-4-5'] }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
  assert.equal(plan.body.leaseIds.length, 1);
  await running;
  return {
    ws, call, release, abortSeen: () => abortSeen,
    done: async () => {
      release();
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task.cancel whose abort was delivered but whose run ends after the deadline answers cancel-requested, and the task then reaches cancelled', async () => {
  const f = await fixture();
  try {
    const first = await f.call('task.cancel', { taskId: 'T1' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(f.abortSeen(), true, 'the abort was delivered');
    assert.equal(first.body.task.state, 'running', 'the run has not published its end yet');
    assert.equal(first.body.cancelRequested, true, 'the answer says the cancel is pending, not that nothing was cancelled');
    assert.equal(cancelPending(f.ws, 'T1'), true);
    // A second cancel while pending answers the same, and starts nothing twice.
    const second = await f.call('task.cancel', { taskId: 'T1' });
    assert.equal(second.body.task.state, 'running');
    assert.equal(second.body.cancelRequested, true);
    // task.get shows the pending cancel too.
    const view = await f.call('task.get', { taskId: 'T1' });
    assert.equal(view.body.cancelRequested, true);
    // The run's end lands: the task is cancelled, the request is gone, and a further cancel is terminal.
    f.release();
    await until(() => getTask(f.ws, 'T1').node.state === 'cancelled', 'T1 to be cancelled');
    await until(() => !cancelPending(f.ws, 'T1'), 'the pending flag to clear');
    const done = await f.call('task.get', { taskId: 'T1' });
    assert.equal(done.body.task.state, 'cancelled');
    assert.equal('cancelRequested' in done.body, false, 'no pending flag once cancelled');
    assert.equal(workerRuns(f.ws, 'T1').length, 1);
    const late = await cancelTask(f.ws, leaseAuthorityFor(f.ws), 'T1');
    assert.deepEqual([late.cancelled, late.reasonCode, late.pending], [false, 'TERMINAL', false]);
  } finally {
    await f.done();
  }
});

test('cancelTask reports pending when the abort was delivered but the end is not yet published, and CANCELLED when it is', async () => {
  const f = await fixture();
  try {
    const pending = await cancelTask(f.ws, leaseAuthorityFor(f.ws), 'T1', 'cancelled by the user', Date.now(), 1);
    assert.deepEqual([pending.cancelled, pending.reasonCode, pending.pending, pending.signalled], [true, 'CANCEL_PENDING', true, 'in-process']);
    f.release();
    await until(() => getTask(f.ws, 'T1').node.state === 'cancelled', 'T1 to be cancelled');
  } finally {
    await f.done();
  }
});
