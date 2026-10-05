// JEV-0068: a worker port whose `run` throws (a spawn that failed, an unexpected harness error) used to leave
// an unhandled rejection. The sidecar installs no handler, so the whole sidecar ended; the tasks queued behind
// the run never started (the queue drain was chained on success only); and the lease and the reservation were
// never settled. The run is now a failed run: the task fails with a fixed reason code, the effect settles
// failed with an unknown cost (the reservation stays held, nothing is guessed), the lease is released, the
// trace carries the code only, and the queue behind it starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, drainBackgroundWorkers, getTask, leaseAuthorityFor, manifestHash, openWorkspace, parseManifest, runLeasedTask, scheduleTasks, scriptedWorkerPort, selfIdentity, setTaskOpDeps, sidecarOps, submitPlan, workerRuns } from '../dist/index.js';
import { taskView } from '../dist/ops/task-ops.js';
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

/** What a thrown error must never leak: its message, and a path inside it. */
const LEAK = 'FAKE-VENDOR-BODY /Users/someone/secret-project/key';

/** The ways a port can fail to return an outcome. Each one is a different place the throw can land. */
const FAILURES = {
  'throws synchronously (a plain function)': () => {
    throw new Error(LEAK);
  },
  'rejects before its first await': async () => {
    throw new Error(LEAK);
  },
  'rejects after an await': async () => {
    await null;
    throw new Error(LEAK);
  },
  'returns a rejected promise': () => Promise.reject(new Error(LEAK)),
  'returns no outcome': async () => undefined,
  'throws a value that is not an Error': () => {
    throw LEAK;
  },
};

/** Cap one: T1 takes the only slot and fails the way the test says; T2 waits behind it and finishes at once. */
async function fixture(failure, portOverrides = {}) {
  const dir = tempDir('jv-wrt-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  for (const d of ['a', 'b']) mkdirSync(join(repo, d), { recursive: true });
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
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 1 } }));
  const script = join(dir, 'worker-script.json');
  writeFileSync(script, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: [{ taskId: 'T2', writes: [], status: 'completed', costUsd: 0.01 }] }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script };
  const scripted = scriptedWorkerPort(env, home);
  const ran = [];
  setTaskOpDeps({
    workerPort: async () => ({
      ...scripted,
      ...portOverrides,
      run: (input) => {
        ran.push(input.taskId);
        return input.taskId === 'T1' ? failure(input) : scripted.run(input);
      },
    }),
  });
  const traces = [];
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false,
    engine: undefined, trace: (e) => traces.push(e),
  });
  const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'] });
  const plan = await call('plan.submit', { plan: { tasks: [task('T1', 'a'), task('T2', 'b')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
  assert.equal(plan.body.leaseIds.length, 1, 'the cap starts one worker, and it is the one that fails');
  return {
    ws, call, traces, ran,
    done: async () => {
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [name, failure] of Object.entries(FAILURES)) {
  test(`a worker port that ${name} fails its task, settles its lease and starts the queue behind it, without an unhandled rejection (JEV-0068)`, async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const f = await fixture(failure);
    try {
      await until(() => getTask(f.ws, 'T2').node.state === 'awaiting-evidence', 'T2, queued behind the failed run, to run');
      await drainBackgroundWorkers();
      assert.deepEqual(rejections, [], 'a throwing port leaves no unhandled rejection (it would end the sidecar)');
      // The task fails with a fixed code, not with the error's text.
      const t1 = getTask(f.ws, 'T1');
      assert.equal(t1.node.state, 'failed');
      assert.equal(t1.node.leaseId ?? null, null, 'the failed task holds no lease');
      const history = JSON.stringify(t1);
      assert.match(history, /worker run failed \(WORKER_RUN_FAILED\)/);
      // The place the documentation sends a person to read why (docs/troubleshooting.md): `jevris_get_task` shows the code, and only the code (JEV-0074).
      const view = taskView(f.ws, 'T1');
      assert.equal(view.task.state, 'failed');
      assert.equal(view.task.stateReason, 'WORKER_RUN_FAILED', JSON.stringify(view.task));
      assert.doesNotMatch(JSON.stringify(view), /worker run failed|the worker port threw/, 'a reason code, never the recorded text');
      // Its run is recorded, failed, with a cost nobody knows and the effect settled (never left pending).
      const [run] = workerRuns(f.ws, 'T1');
      assert.ok(run !== undefined, 'the run is on record');
      assert.equal(run.status, 'failed');
      assert.equal(run.costUsd, null);
      assert.equal(run.effectState, 'failed');
      assert.match(run.reason, /^WORKER_RUN_FAILED: /);
      // The lease is released, and the reservation is held as uncertain: nothing spent is lost, nothing is guessed.
      assert.deepEqual(leaseAuthorityFor(f.ws).activeLeases(f.ws.workspaceId), [], 'no lease is left active');
      const states = f.ws.host.list('reservations').map((r) => r.reservation.state).sort();
      assert.deepEqual(states, ['committed', 'uncertain'], 'the failed run\'s unknown cost keeps its reservation held; the queued run\'s is committed');
      // The trace names the code and the task; nothing anywhere carries the error's text or path.
      assert.ok(f.traces.some((e) => e.event === 'orchestrator.worker-run-failed' && e.taskId === 'T1' && e.reasonCode === 'WORKER_RUN_FAILED'), 'the failure is traced by its code');
      for (const [where, value] of Object.entries({ task: history, run: JSON.stringify(run), traces: JSON.stringify(f.traces) })) {
        assert.ok(!value.includes('FAKE-VENDOR-BODY') && !value.includes('/Users/someone'), `${where} carries none of the thrown text`);
      }
      assert.deepEqual(f.ran, ['T1', 'T2'], 'the queued task ran once, after the failed one');
    } finally {
      process.off('unhandledRejection', onRejection);
      await f.done();
    }
  });
}

test('a thrown error keeps only a code shaped like a system code (ENOENT), never its message (JEV-0068)', async () => {
  const f = await fixture(async () => {
    throw Object.assign(new Error(LEAK), { code: 'ENOENT' });
  });
  try {
    await until(() => getTask(f.ws, 'T2').node.state === 'awaiting-evidence', 'T2 to run');
    const [run] = workerRuns(f.ws, 'T1');
    assert.match(run.reason, /^WORKER_RUN_FAILED: the worker port threw before it returned an outcome \(ENOENT\)$/);
  } finally {
    await f.done();
  }
});

test('an error code that is not shaped like a system code is dropped (JEV-0068)', async () => {
  const f = await fixture(async () => {
    throw Object.assign(new Error('x'), { code: 'rate limited: see https://vendor.invalid/body?token=FAKE' });
  });
  try {
    await until(() => getTask(f.ws, 'T2').node.state === 'awaiting-evidence', 'T2 to run');
    const [run] = workerRuns(f.ws, 'T1');
    assert.equal(run.reason, 'WORKER_RUN_FAILED: the worker port threw before it returned an outcome');
  } finally {
    await f.done();
  }
});

test('a throw outside the port\'s own run (the runner\'s harness lookup, after the effect began) fails the task, settles its lease and frees the slot too (JEV-0068)', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  let thrown = false;
  const f = await fixture(() => assert.fail('the port is never run for T1'), {
    // The runner reads this before the port's run starts, for the first leased task only.
    harnessFor: (...args) => {
      if (!thrown) {
        thrown = true;
        throw new Error(LEAK);
      }
      return null;
    },
  });
  try {
    await until(() => getTask(f.ws, 'T2').node.state === 'awaiting-evidence', 'T2, queued behind the failed run, to run');
    await drainBackgroundWorkers();
    assert.deepEqual(rejections, []);
    const t1 = getTask(f.ws, 'T1');
    assert.equal(t1.node.state, 'failed');
    assert.match(JSON.stringify(t1), /worker run failed \(WORKER_RUN_FAILED\)/);
    assert.deepEqual(leaseAuthorityFor(f.ws).activeLeases(f.ws.workspaceId), [], 'no lease is left active');
    const reservations = f.ws.host.list('reservations').map((r) => r.reservation.state).sort();
    assert.deepEqual(reservations, ['committed', 'uncertain'], 'the failed run\'s reservation is held as uncertain, the other run\'s is committed');
    assert.ok(f.traces.some((e) => e.event === 'orchestrator.worker-run-failed' && e.taskId === 'T1' && e.reasonCode === 'WORKER_RUN_FAILED'));
    assert.ok(!JSON.stringify([t1, f.traces]).includes('FAKE-VENDOR-BODY'), 'nothing carries the thrown text');
    assert.deepEqual(f.ran, ['T2']);
  } finally {
    process.off('unhandledRejection', onRejection);
    await f.done();
  }
});

test('a lease heartbeat that throws is not an unhandled rejection and does not stop the run: the next beat asks again (JEV-0068)', async () => {
  const dir = tempDir('jv-wrt-hb-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, 'a'), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    await submitPlan(ws, { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['a'], estimateMicroUsd: 500_000 }], ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    const real = leaseAuthorityFor(ws);
    let beats = 0;
    const authority = { ...real, heartbeat: async () => { beats += 1; throw new Error(LEAK); } };
    const [grant] = (await scheduleTasks(ws, { authority, holder: selfIdentity() })).leased;
    let abortedDuringRun = false;
    const result = await runLeasedTask(ws, grant, {
      authority,
      heartbeatMs: 10,
      model: 'claude-sonnet-4-5',
      allowedTools: [],
      prompt: 'p',
      port: {
        run: async (input) => {
          // The run lasts until the heartbeat has thrown twice: no guessed duration, the state decides.
          await until(() => beats >= 2, 'two heartbeats to have thrown');
          abortedDuringRun = input.signal.aborted;
          return { status: 'completed', reason: 'done', sessionId: null, requestedModel: input.model, actualModel: input.model, costUsd: 0.01, usage: null, turns: 1, durationMs: 1 };
        },
      },
    });
    assert.equal(abortedDuringRun, false, 'a heartbeat that threw did not read as a lost lease');
    assert.equal(result.finalState, 'awaiting-evidence');
    assert.deepEqual(rejections, [], 'the heartbeat\'s rejection was handled');
  } finally {
    process.off('unhandledRejection', onRejection);
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});
