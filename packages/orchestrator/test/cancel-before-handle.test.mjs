// A cancel that lands after the task shows `running` but before the run has registered its abort handle used to be filed as a
// request only, and the run saw it at its next heartbeat: a third of the lease's life (40 s with the default 120 s) later. The
// answer said "cancel requested" (CANCEL_PENDING), so the person was told the worker was stopping while it ran and spent.
// The run now looks for a filed request when it registers its handle, and `cancelTask` looks for a handle once its request is
// filed, so a cancel stops the run at once whichever of the two comes first. Both orders are fixed by the test with gates, so
// no timing decides them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, cancelTask, drainBackgroundWorkers, getTask, leaseAuthorityFor, manifestHash, openWorkspace, parseManifest, setTaskOpDeps, sidecarOps } from '../dist/index.js';
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * T1 runs on a port that ends only when its signal aborts, and says whether the signal was already aborted when the run began.
 * The first `publishFenced` of the run (the one that turns the task `running`) is held open after it committed, so the task
 * shows `running` while the run has not registered its handle.
 */
async function fixture() {
  const dir = tempDir('jv-cbh-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'a'), { recursive: true });
  mkdirSync(home, { recursive: true });
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
  const seen = { startHeld: false, portEntered: false, abortedAtStart: null };
  let openStart = () => {};
  const startGate = new Promise((resolve) => (openStart = resolve));
  let published = 0;
  const port = {
    run: (input) =>
      new Promise((resolve) => {
        seen.portEntered = true;
        seen.abortedAtStart = input.signal.aborted;
        const end = () => resolve({ status: 'aborted', reason: 'aborted', sessionId: 's1', requestedModel: input.model, actualModel: input.model, costUsd: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, turns: 0, durationMs: 1 });
        if (input.signal.aborted) end();
        else input.signal.addEventListener('abort', end, { once: true });
      }),
  };
  setTaskOpDeps({
    workerPort: async () => port,
    authority: (w) => {
      const real = leaseAuthorityFor(w);
      return {
        ...real,
        publishFenced: async (...args) => {
          const result = await real.publishFenced(...args);
          published += 1;
          // The first one is the start of the run: committed, and held before the run goes on to register its handle.
          if (published === 1) {
            seen.startHeld = true;
            await startGate;
          }
          return result;
        },
      };
    },
  });
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20_000, remainingMs: () => 20_000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
  });
  const submitted = call('plan.submit', { plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['a'], models: ['claude-sonnet-4-5'] }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
  return {
    ws, seen, call, openStart, submitted,
    done: async () => {
      openStart();
      // Whatever the test did, end the run now rather than at a heartbeat.
      await cancelTask(ws, leaseAuthorityFor(ws), 'T1', 'cleanup', Date.now(), 20_000).catch(() => undefined);
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a cancel filed after the task shows running but before the run registered its handle stops the run when it registers, not at the next heartbeat', async () => {
  const f = await fixture();
  try {
    await f.submitted;
    await until(() => f.seen.startHeld, 'the run to be committed as running with its handle not yet registered');
    assert.equal(getTask(f.ws, 'T1').node.state, 'running');
    const answered = await f.call('task.cancel', { taskId: 'T1' });
    assert.equal(answered.body.cancelRequested, true, 'no handle yet: the answer is cancel requested');
    // The run goes on, registers its handle, and finds the request.
    f.openStart();
    await until(() => getTask(f.ws, 'T1').node.state === 'cancelled', 'the task to be cancelled');
    assert.equal(f.seen.abortedAtStart, true, 'the run began already aborted: it did not wait for a heartbeat to see the cancel');
  } finally {
    await f.done();
  }
});

test('a cancel whose request is committed while the run registers its handle reaches the run at once (cancelTask looks for the handle after filing the request)', async () => {
  const f = await fixture();
  try {
    await f.submitted;
    await until(() => f.seen.startHeld, 'the run to be committed as running with its handle not yet registered');
    // The cancel has looked for a handle (none) and is about to file its request; hold that write.
    let filing = false;
    let releaseFiling = () => {};
    const filingGate = new Promise((resolve) => (releaseFiling = resolve));
    const slowHost = {
      ...f.ws.host,
      transact: async (fn, options) => {
        filing = true;
        await filingGate;
        return f.ws.host.transact(fn, options);
      },
    };
    const cancelling = cancelTask({ ...f.ws, host: slowHost }, leaseAuthorityFor(f.ws), 'T1', 'cancelled by the user', Date.now(), 20_000);
    await until(() => filing, 'the cancel to reach its request write');
    // Meanwhile the run registers its handle and looks for a request: there is none yet, so it goes on.
    f.openStart();
    await until(() => f.seen.portEntered, 'the run to begin');
    assert.equal(f.seen.abortedAtStart, false, 'no request was filed when the run looked');
    // The request is filed now: the cancel finds the handle and aborts the run itself.
    releaseFiling();
    const result = await cancelling;
    assert.deepEqual([result.cancelled, result.signalled, result.pending, result.reasonCode], [true, 'in-process', false, 'CANCELLED']);
    assert.equal(getTask(f.ws, 'T1').node.state, 'cancelled');
  } finally {
    await f.done();
  }
});
