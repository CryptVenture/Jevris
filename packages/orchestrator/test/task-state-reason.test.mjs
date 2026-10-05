// JEV-0074: `jevris_get_task` showed `task.stateReason` only for a blocked task whose whole reason was a code, so a task that
// failed because its worker run threw said nothing about why, while docs/troubleshooting.md sent a person there. The task
// view now carries the reason CODE of a blocked, failed or cancelled task, additively and optionally, and never the recorded
// sentence: it can hold a path, a scope or a time. `taskStateReason` is the one rule; the view and the op are checked below
// through the real `task.get` op with the surface contract's own validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, cancelTask, drainBackgroundWorkers, getTask, leaseAuthorityFor, manifestHash, openWorkspace, parseManifest, setTaskOpDeps, sidecarOps, taskStateReason, taskTransition } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

test('a blocked task shows its reason when it is a code or leads with one, and nothing when it is text', () => {
  assert.equal(taskStateReason('blocked', 'DEPENDENCY_CANCELLED'), 'DEPENDENCY_CANCELLED');
  assert.equal(taskStateReason('blocked', 'LEASE_EXPIRED'), 'LEASE_EXPIRED');
  assert.equal(taskStateReason('blocked', 'ACCESS_LIMITED: usage-window on codex subscription openai paused until 2026-10-05T10:00:00Z'), 'ACCESS_LIMITED');
  assert.equal(taskStateReason('blocked', 'HOST_ROUTE_NOT_LAUNCHED: the linked session runs through openrouter (NOT_ON_SESSION_HOST); nothing ran direct at the maker'), 'HOST_ROUTE_NOT_LAUNCHED');
  assert.equal(taskStateReason('blocked', 'harness usage limit reached'), undefined);
  assert.equal(taskStateReason('blocked', 'waiting for the vendor fix'), undefined);
  assert.equal(taskStateReason('blocked', null), undefined);
});

test('a failed task shows the code its reason names, so a client can learn why it failed (JEV-0074)', () => {
  assert.equal(taskStateReason('failed', 'worker run failed (WORKER_RUN_FAILED)'), 'WORKER_RUN_FAILED');
  assert.equal(taskStateReason('failed', 'worker refused before starting (HOST_NO_LOGIN)'), 'HOST_NO_LOGIN');
  assert.equal(taskStateReason('failed', 'model claude-opus-5-5 is not available here (MODEL_GONE via claude)'), 'MODEL_GONE');
  assert.equal(taskStateReason('failed', 'model claude-opus-5-5 is not available here (MODEL_UNAVAILABLE)'), 'MODEL_UNAVAILABLE');
  assert.equal(taskStateReason('failed', 'FIRST_TRY_FAILED: the first-try model\'s check failed; one hand-off follows'), 'FIRST_TRY_FAILED');
  assert.equal(taskStateReason('failed', 'WORKER_RUN_FAILED'), 'WORKER_RUN_FAILED', 'a reason that is itself a code');
});

test('a cancelled task shows its reason only when the whole reason is a code: the rest is a person\'s own words', () => {
  assert.equal(taskStateReason('cancelled', 'RECONCILED_ABANDONED'), 'RECONCILED_ABANDONED');
  assert.equal(taskStateReason('cancelled', 'cancelled by the user'), undefined);
  assert.equal(taskStateReason('cancelled', 'budget exhausted: cancel-newest policy'), undefined);
  assert.equal(taskStateReason('cancelled', 'NOTE: not needed any more'), undefined, 'a person\'s words never read as a code');
  assert.equal(taskStateReason('cancelled', 'duplicate of T1 (SURVIVOR)'), undefined);
});

test('a reason with no code, and any other state, show nothing: never the recorded text, a path or an error message', () => {
  assert.equal(taskStateReason('failed', 'worker failed'), undefined);
  assert.equal(taskStateReason('failed', 'wrote outside allowed paths: src/../../secret.txt'), undefined);
  assert.equal(taskStateReason('failed', null), undefined);
  assert.equal(taskStateReason('failed', 'worker run failed (ENOENT: no such file /home/me/secret/x)'), undefined);
  assert.equal(taskStateReason('failed', 'the worker said (oops)'), undefined);
  assert.equal(taskStateReason('failed', 'x (CODE) and then free text'), undefined);
  assert.equal(taskStateReason('failed', 'worker run failed (lower_case)'), undefined);
  assert.equal(taskStateReason('failed', 'worker run failed (AB)'), undefined, 'a code is at least three characters, as the status contract takes it');
  for (const state of ['proposed', 'validated', 'ready', 'leased', 'running', 'awaiting-evidence', 'verifying', 'verified']) assert.equal(taskStateReason(state, 'WORKER_RUN_FAILED'), undefined, state);
});

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

/** The `task.get` op as the MCP tool reaches it, and the surface contract's own check of what it answers. */
async function fixture({ port }) {
  const dir = tempDir('jv-tsr-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
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
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 3 } }));
  setTaskOpDeps({ workerPort: async () => port });
  const call = (op, body, client = 'cli') => sidecarOps.find((o) => o.op === op).handle({
    op, client, scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
  });
  const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'] });
  const get = async (taskId) => {
    const answer = await call('task.get', { taskId }, 'mcp');
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(surfacePayloadContract('task.get').validate(answer.body).ok, true, `the answer fits the surface contract: ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  return {
    ws, call, task, get,
    done: async () => {
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const outcome = (input, over = {}) => ({ status: 'completed', reason: 'done', sessionId: null, requestedModel: input.model, actualModel: input.model, costUsd: 0.01, usage: null, turns: 1, durationMs: 1, ...over });

test('task.get carries the code of a task whose worker run threw, and nothing of the error (JEV-0074)', async () => {
  const f = await fixture({
    port: {
      run: async (input) => {
        throw Object.assign(new Error('FAKE-VENDOR-BODY /Users/someone/secret-project/key'), { code: 'EEXIST' });
      },
    },
  });
  try {
    const submitted = await f.call('plan.submit', { plan: { tasks: [f.task('T1', 'a')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await until(() => getTask(f.ws, 'T1')?.node.state === 'failed', 'the task to fail');
    await drainBackgroundWorkers();
    const view = await f.get('T1');
    assert.equal(view.task.state, 'failed');
    assert.equal(view.task.stateReason, 'WORKER_RUN_FAILED', JSON.stringify(view.task));
    assert.deepEqual(Object.keys(view.task).sort(), ['acceptanceCheckIds', 'dependencyIds', 'id', 'requirementIds', 'revision', 'stateReason', 'state'].sort(), 'one field added to the task view, none changed');
    assert.doesNotMatch(JSON.stringify(view), /FAKE-VENDOR-BODY|\/Users\/someone|EEXIST|worker run failed|threw/, 'a reason code, never the recorded text, the error code or the message');
    assert.equal(view.worker.status, 'failed', 'the worker line is as it was');
  } finally {
    await f.done();
  }
});

test('task.get shows no reason for a task whose failure has no code, a cancelled task with a person\'s words, and a task that is running (JEV-0074)', async () => {
  let open = () => {};
  const gate = new Promise((resolve) => (open = resolve));
  const f = await fixture({
    port: {
      run: async (input) => {
        if (input.taskId === 'T2') await gate;
        return outcome(input, input.taskId === 'T1' ? { status: 'failed', reason: 'FAKE-VENDOR-BODY exit 3' } : {});
      },
    },
  });
  try {
    // T1: a worker that returns `failed` ("worker failed", no code). T2: held running, then cancelled with free text.
    const submitted = await f.call('plan.submit', { plan: { tasks: [f.task('T1', 'a'), f.task('T2', 'b')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await until(() => getTask(f.ws, 'T1')?.node.state === 'failed' && getTask(f.ws, 'T2')?.node.state === 'running', 'T1 to fail and T2 to run');
    const failed = await f.get('T1');
    assert.equal(failed.task.state, 'failed');
    assert.equal(Object.hasOwn(failed.task, 'stateReason'), false, 'worker failed: no code, so no field');
    const running = await f.get('T2');
    assert.equal(running.task.state, 'running');
    assert.equal(Object.hasOwn(running.task, 'stateReason'), false);
    const cancelled = await cancelTask(f.ws, leaseAuthorityFor(f.ws), 'T2', 'not needed any more: FAKE-VENDOR-BODY');
    assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
    open();
    await until(() => getTask(f.ws, 'T2')?.node.state === 'cancelled', 'T2 to be cancelled');
    const view = await f.get('T2');
    assert.equal(view.task.state, 'cancelled');
    assert.equal(Object.hasOwn(view.task, 'stateReason'), false, 'a person\'s words are not a reason code');
  } finally {
    open();
    await f.done();
  }
});

test('task.get shows the code of a blocked task, with the text after it dropped, and of a cancelled one that is a code (JEV-0074)', async () => {
  // No worker port loads, so the tasks stay queued and only the transitions below move them.
  const f = await fixture({ port: null });
  try {
    const submitted = await f.call('plan.submit', { plan: { tasks: [f.task('B1', 'a'), f.task('B2', 'b'), f.task('B3', 'c')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    // Reasons Jevris writes, put on three queued tasks (the actor does not matter to the view).
    const put = (id, to, reason) => {
      const moved = taskTransition(f.ws, id, to, reason, { actor: 'human' });
      assert.equal(moved.ok, true, `${id} to ${to} from ${getTask(f.ws, id)?.node.state}: ${JSON.stringify(moved)}`);
    };
    put('B1', 'blocked', 'ACCESS_LIMITED: usage-window on codex subscription openai paused until 2026-10-05T10:00:00Z');
    put('B2', 'blocked', 'DEPENDENCY_CANCELLED');
    put('B3', 'cancelled', 'RECONCILED_ABANDONED');
    assert.equal((await f.get('B1')).task.stateReason, 'ACCESS_LIMITED');
    assert.equal((await f.get('B2')).task.stateReason, 'DEPENDENCY_CANCELLED', 'as before');
    assert.equal((await f.get('B3')).task.stateReason, 'RECONCILED_ABANDONED');
  } finally {
    await f.done();
  }
});
