// JEV-0069: `active workers` lists only the tasks leased or running. Between one worker ending and the next queued task
// being leased it read "none" while tasks still waited, and no status field said how many waited, so a client could not
// tell an idle queue from a hand-over in progress. Status now carries `queuedTasks`: the tasks in state ready or validated.
// The queue is idle when that is 0 and no worker is active.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { surfacePayloadContract } = await import('@jevris/contracts');
const { DEFAULT_CONFIG, approveManifests, getTask, leaseAuthorityFor, manifestHash, openWorkspace, parseManifest, setTaskOpDeps } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');
const store = await import('@jevris/store');

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

test('status counts the queued tasks (ready or validated) and not the ones leased, running or past that (JEV-0069)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-status-queued-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const status = async () => {
      const answer = await sidecarRequest({ home, op: 'status', scope: 'mcp', workspace: root, body: {} });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(surfacePayloadContract('status').validate(answer.result).ok, true, 'the contract carries the field');
      return answer.result;
    };
    assert.equal((await status()).queuedTasks, 0, 'a workspace with no tasks has none queued');
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root });
    const view = started.daemon.state.storeFor({ id: registered.result.id, root: registered.result.root });
    const task = (taskId, states) => {
      assert.equal(store.createTask(view, { taskId, ownerId: 'planner', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], record: { writeScopes: ['src'], risk: 'low' }, nowMs: 1 }).ok, true);
      for (const [to, actor] of states) assert.equal(store.transitionTask(view, { taskId, to, actor, reasonCode: 'TEST', nowMs: 2 }).ok, true, to);
    };
    task('P1', []);
    task('V1', [['validated', 'planner']]);
    task('V2', [['validated', 'planner']]);
    task('R1', [['validated', 'planner'], ['ready', 'scheduler']]);
    task('L1', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]);
    task('N1', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler'], ['running', 'runner']]);
    task('E1', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler'], ['running', 'runner'], ['awaiting-evidence', 'runner']]);
    task('F1', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler'], ['running', 'runner'], ['failed', 'runner']]);
    const result = await status();
    assert.deepEqual(result.activeWorkers, ['L1', 'N1']);
    assert.equal(result.queuedTasks, 3, 'V1, V2 and R1 wait; a proposed task, a leased, a running, an awaiting-evidence and a failed one do not');
    // Global status (no workspace) has no tasks to count.
    const global = await sidecarRequest({ home, op: 'status', scope: 'cli', body: {} });
    assert.equal(global.ok, true, JSON.stringify(global));
    assert.ok(global.result.queuedTasks === null || global.result.queuedTasks === undefined);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('a queue handed from one worker to the next never reads idle while tasks wait: queued counts 5, 4, 3, 2, 1, 0 and no gap shows none with nothing queued (JEV-0069)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-status-queue-')));
  const root = join(home, 'ws');
  mkdirSync(join(root, 'a'), { recursive: true });
  writeFileSync(join(root, 'a', 'x.txt'), 'x\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 1 } }));
  const started = await startDaemon({ home, packageOps: true, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  // Each task's run waits for its own gate. Each hand-over is held where the worker has ended and the next task is not
  // yet leased: the instant that read "active workers: none" before the queue was shown.
  const gates = new Map();
  const gate = (id) => {
    if (!gates.has(id)) {
      let open = () => {};
      const opened = new Promise((resolve) => (open = resolve));
      gates.set(id, { open, opened, started: false });
    }
    return gates.get(id);
  };
  let hold;
  const armHold = () => {
    let release = () => {};
    let reached = () => {};
    const open = new Promise((resolve) => (release = resolve));
    const at = new Promise((resolve) => (reached = resolve));
    hold = { open, at, release, reached };
    return hold;
  };
  const port = {
    run: async (input) => {
      const g = gate(input.taskId);
      g.started = true;
      await g.opened;
      return { status: 'completed', reason: 'done', sessionId: null, requestedModel: input.model, actualModel: input.model, costUsd: 0.01, usage: null, turns: 1, durationMs: 1 };
    },
  };
  setTaskOpDeps({
    workerPort: async () => port,
    authority: (w) => {
      const real = leaseAuthorityFor(w);
      return {
        ...real,
        acquire: async (...args) => {
          // The drain after a run's end asks for the next lease: hold it here when a hold is armed.
          const current = hold;
          if (current !== undefined && gates.size > 0) {
            hold = undefined;
            current.reached();
            await current.open;
          }
          return real.acquire(...args);
        },
      };
    },
  });
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root });
    const view = started.daemon.state.storeFor({ id: registered.result.id, root: registered.result.root });
    const ws = openWorkspace({ home, workspaceRoot: root, workspaceId: registered.result.id, store: view });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    const status = async () => {
      const answer = await sidecarRequest({ home, op: 'status', scope: 'mcp', workspace: root, body: {} });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      return { active: answer.result.activeWorkers, queued: answer.result.queuedTasks };
    };
    const ids = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const task = (id) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [`a/${id}`], models: ['claude-sonnet-4-5'] });
    const submitted = await sidecarRequest({ home, op: 'plan.submit', scope: 'cli', workspace: root, timeoutMs: 60_000, body: { plan: { tasks: ids.map(task) }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 50_000_000 } } });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.result.leaseIds.length, 1, 'the cap starts one worker; the other five queue');
    await until(() => gate('T1').started, 'T1 to run');
    assert.deepEqual(await status(), { active: ['T1'], queued: 5 });

    const readings = [];
    for (const [i, id] of ids.entries()) {
      const next = ids[i + 1];
      if (next !== undefined) {
        const held = armHold();
        gate(id).open();
        // The run has ended and the lease is released; the next task has not been leased: the hand-over, held open.
        await held.at;
        await until(() => getTask(ws, id)?.node.state === 'awaiting-evidence', `${id} to end`);
        const gap = await status();
        readings.push({ during: `after ${id} ended, before ${next} is leased`, ...gap });
        assert.deepEqual(gap, { active: [], queued: ids.length - 1 - i }, `the gap after ${id}: no worker, and the ${ids.length - 1 - i} that wait are counted`);
        held.release();
        await until(() => gate(next).started, `${next} to run`);
        assert.deepEqual(await status(), { active: [next], queued: ids.length - 2 - i });
      } else {
        gate(id).open();
        await until(() => getTask(ws, id)?.node.state === 'awaiting-evidence', `${id} to end`);
      }
    }
    // Every task has run: nothing active and nothing queued is the idle queue.
    await until(async () => {
      const s = await status();
      return s.active.length === 0 && s.queued === 0;
    }, 'the queue to read idle');
    for (const reading of readings) assert.ok(!(reading.active.length === 0 && reading.queued === 0), `${reading.during}: the queue never reads idle while a task waits`);
    assert.deepEqual(readings.map((r) => r.queued), [5, 4, 3, 2, 1]);
  } finally {
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) gate(id).open();
    if (hold !== undefined) hold.release();
    await started.daemon.stop('test');
    setTaskOpDeps({});
    rmSync(home, { recursive: true, force: true });
  }
});
