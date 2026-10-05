// JEV-0051, JEV-0052, JEV-0053, JEV-0054 and JEV-0047: the owned-mode orchestration scenarios an end-to-end tester
// ran against an installed Jevris (scripted workers held by flag files, one sandbox for the whole suite), run in
// process with the same plan fixtures. The first four failed in one run as a chain: the first test (two concurrent
// leases) saw one lease because the tasks queued in the suite's advice-only phase were still starting, and the
// next three then ran with a worker still holding a slot or an effect. Each test here pins what the product
// documents, so the tester's expectation can be written against it:
//   - at most orchestration.maxConcurrentWorkers (default 2) run at once; a task that finds the slots taken is queued
//     and starts when a slot frees (docs/routing.md "Owned workers", docs/settings.md "Workers");
//   - cancel releases the lease and keeps the worktree (docs/cli.md "jevris task cancel");
//   - the kill switch holds every owned effect still pending in the store, and only a person reconciles it after clear
//     (docs/security.md "The kill switch", docs/cli.md "jevris task reconcile");
//   - cancelling a task cancels nothing else, and an unrelated submit is still accepted (docs/cli.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdPendingEffects } from '@jevris/store';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, drainBackgroundWorkers, effectOperationId, getTask, heldTaskEffects, leaseAuthorityFor, listTasks, manifestHash, openWorkspace, ownedSessions, parseManifest, reconcileOwnedEffect, scriptedWorkerPort, setTaskOpDeps, sidecarOps } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

async function until(check, what) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const CHECKS = ['unit', 'interface', 'lint'];
const RUNNING = ['leased', 'running'];
const STARTED = ['leased', 'running', 'awaiting-evidence', 'verified'];

/** The tester's task: a TaskNode plus the scheduling fields the sidecar reads (expectedOutputs, models). */
const task = (id, { deps = [], scope, models = ['claude-opus-5-5'], budget = 'main-budget', noModel = false } = {}) => ({
  id, schemaVersion: '1.0', workspaceId: 'ws', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: deps, writeScopes: [scope ?? `notes/${id}.txt`],
  acceptanceCheckIds: CHECKS, expectedOutputs: [`${id}-out`], rootBudgetId: budget, ...(noModel ? {} : { models }),
});

/** A scripted run that writes notes/<id>.txt and reports 0.01 USD; `hold` makes it wait for the flag file named after the task. */
const scripted = (flags, id, hold) => ({ taskId: id, status: 'completed', reason: `scripted ${id}`, costUsd: 0.01, writes: [{ path: `notes/${id}.txt`, text: `${id}\n` }], ...(hold ? { waitForFile: join(flags, id) } : {}) });

/**
 * A workspace with the approved checks, owned workers at `managedWorkers`, the default cap, and a scripted worker port: `held` ids wait for
 * their flag file (release(id)), the others finish at once.
 */
async function fixture({ managedWorkers = 'bounded-auto', held = [], quick = [], authority } = {}) {
  const dir = tempDir('jv-oos-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const flags = join(dir, 'flags');
  mkdirSync(home, { recursive: true });
  mkdirSync(flags, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const manifests = CHECKS.map((id) => parseManifest({ id, argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest);
  await approveManifests(ws, manifests, Object.fromEntries(manifests.map((m) => [m.id, manifestHash(m)])), 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  const setWorkers = (mode) => writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: mode }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  setWorkers(managedWorkers);
  const script = join(dir, 'worker-script.json');
  writeFileSync(script, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: [...held.map((id) => scripted(flags, id, true)), ...quick.map((id) => scripted(flags, id, false))] }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home), ...(authority === undefined ? {} : { authority }) });
  const traces = [];
  const call = (op, body, extra = {}) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20_000, remainingMs: () => 20_000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: (e) => traces.push(e), ...extra,
  });
  const plan = (tasks, budget = 'main-budget') => call('plan.submit', { plan: { requirementIds: ['R1'], tasks }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: budget, limitMicroUsd: 5_000_000 } });
  const release = (...ids) => ids.forEach((id) => writeFileSync(join(flags, id), 'go'));
  const stateOf = (id) => getTask(ws, id)?.node.state;
  /** What `jevris status` lists as "active workers": the workspace's tasks leased or running. */
  const activeWorkers = () => listTasks(ws, { states: RUNNING }).map((t) => t.node.id).sort();
  const activeLeases = () => leaseAuthorityFor(ws).activeLeases(null).map((l) => l.lease.taskId).sort();
  return {
    ws, repo, store, call, plan, traces, setWorkers, release, stateOf, activeWorkers, activeLeases,
    done: async () => {
      release(...held);
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ----------------------------------------------------------------------------------------------- JEV-0051

test('JEV-0051: three independent tasks with distinct write scopes get two leases at the default cap, and the third starts when a slot frees', async () => {
  assert.equal(DEFAULT_CONFIG.orchestration.maxConcurrentWorkers, 2, 'docs/settings.md: orchestration.maxConcurrentWorkers defaults to 2');
  const f = await fixture({ held: ['hold-1', 'hold-2', 'hold-3'] });
  try {
    const submitted = await f.plan(['hold-1', 'hold-2', 'hold-3'].map((id) => task(id)));
    assert.equal(submitted.body.accepted, true, JSON.stringify(submitted.body));
    assert.equal(submitted.body.leaseIds.length, 2, 'two slots, two leases');
    assert.deepEqual(f.activeWorkers(), ['hold-1', 'hold-2']);
    assert.equal(f.stateOf('hold-3'), 'ready', 'the third waits behind the cap');
    // One slot frees and the queued task takes it, with no second submit.
    f.release('hold-1');
    await until(() => STARTED.includes(f.stateOf('hold-3')), 'hold-3 to start when hold-1 ended');
    assert.ok(RUNNING.includes(f.stateOf('hold-2')), 'the other running task is left alone');
  } finally {
    await f.done();
  }
});

test('JEV-0051: three tasks that share one write scope are not one lease: the plan is refused (WRITE_OVERLAP) and nothing is created or leased', async () => {
  const f = await fixture({ held: ['hold-1', 'hold-2', 'hold-3'] });
  try {
    const submitted = await f.plan(['hold-1', 'hold-2', 'hold-3'].map((id) => task(id, { scope: 'notes/shared.txt' })));
    assert.equal(submitted.body.accepted, false);
    assert.equal(submitted.body.reasonCode, 'PLAN_INVALID');
    assert.deepEqual([...new Set(submitted.body.issues.map((i) => i.code))], ['WRITE_OVERLAP']);
    assert.deepEqual(submitted.body.leaseIds, []);
    assert.deepEqual(listTasks(f.ws).map((t) => t.node.id), [], 'no task was created');
  } finally {
    await f.done();
  }
});

test('JEV-0051: a queued task that starts just before the submit holds a slot while `active workers` still reads none: the submit leases the one free slot and the rest start as slots free', async () => {
  // The tester's suite queues tasks while workers are advice-only (qa1, mcp-1, ...), raises workers, and its first submit starts them one by one as
  // slots free (JEV-0008). Its wait for "active workers: none" (two quiet polls) can fall between two of those starts. The test fixes that order:
  // the queue drain after the first run is held open before it takes a lease, so nothing is leased or running (what the poll reads) while a queued task
  // is about to take a slot.
  let acquires = 0;
  let reached = false;
  let open = () => {};
  const gate = new Promise((resolve) => (open = resolve));
  const f = await fixture({
    managedWorkers: 'advise',
    held: ['old-1', 'hold-1', 'hold-2', 'hold-3'],
    quick: ['int-ok'],
    authority: (w) => {
      const real = leaseAuthorityFor(w);
      return {
        ...real,
        acquire: async (...args) => {
          acquires += 1;
          // The first acquire is the submit of int-ok; the second is the drain that starts when int-ok ends.
          if (acquires === 2) {
            reached = true;
            await gate;
          }
          return real.acquire(...args);
        },
      };
    },
  });
  try {
    const queued = await f.plan([task('old-1')]);
    assert.deepEqual(queued.body.leaseIds, [], 'advice-only workers: queued');
    f.setWorkers('bounded-auto');
    const first = await f.plan([task('int-ok')]);
    assert.equal(first.body.leaseIds.length, 1);
    await until(() => reached && f.stateOf('int-ok') === 'awaiting-evidence', 'int-ok to end and its drain to wait before taking a lease');
    assert.deepEqual(f.activeWorkers(), [], 'what `jevris status` reads: active workers: none');
    assert.equal(f.stateOf('old-1'), 'ready', 'yet a queued task is about to start');
    open();
    await until(() => RUNNING.includes(f.stateOf('old-1')), 'the queued task to take its slot');
    const submitted = await f.plan(['hold-1', 'hold-2', 'hold-3'].map((id) => task(id)));
    assert.equal(submitted.body.leaseIds.length, 1, 'one slot is free: the cap (2) holds, and the submit leases only what is free');
    assert.deepEqual(f.activeWorkers(), ['hold-1', 'old-1']);
    // Nothing is stuck: as slots free the queued tasks start, in the order they were queued, with no second submit.
    f.release('old-1');
    await until(() => RUNNING.includes(f.stateOf('hold-2')), 'hold-2 to start when old-1 ended');
    assert.equal(f.stateOf('hold-3'), 'ready');
    f.release('hold-1');
    await until(() => RUNNING.includes(f.stateOf('hold-3')), 'hold-3 to start when hold-1 ended');
  } finally {
    open();
    await f.done();
  }
});

// ----------------------------------------------------------------------------------------------- JEV-0052

test('JEV-0052: cancelling a running task releases its lease and keeps its worktree and the scripted file (docs/cli.md: "Its worktree is kept")', async () => {
  const f = await fixture({ held: ['cancel-hold'] });
  try {
    const submitted = await f.plan([task('cancel-hold')]);
    assert.equal(submitted.body.leaseIds.length, 1);
    await until(() => f.stateOf('cancel-hold') === 'running', 'cancel-hold to run');
    const own = () => git(f.repo, 'worktree', 'list', '--porcelain').split('\n\n').map((b) => ({ path: (b.match(/^worktree (.+)$/m) ?? [])[1] ?? '', branch: (b.match(/^branch (.+)$/m) ?? [])[1] ?? '' })).filter((w) => /^refs\/heads\/jevris\/cancel-hold-[0-9a-f]+$/.test(w.branch));
    await until(() => own().length === 1 && existsSync(join(own()[0].path, 'notes', 'cancel-hold.txt')), 'the task worktree with its scripted file');
    const before = own().map((w) => w.path);
    const cancelled = await f.call('task.cancel', { taskId: 'cancel-hold' });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    await until(() => f.stateOf('cancel-hold') === 'cancelled', 'the task to be cancelled');
    await until(() => f.activeLeases().length === 0, 'the lease to be released');
    assert.deepEqual(f.activeWorkers(), []);
    assert.deepEqual(own().map((w) => w.path), before, 'cancel keeps the worktree');
    assert.ok(existsSync(join(before[0], 'notes', 'cancel-hold.txt')), 'and the scripted file in it');
    assert.equal(existsSync(join(f.repo, 'notes', 'cancel-hold.txt')), false, 'the main checkout never saw it');
    assert.equal(git(f.repo, 'status', '--porcelain').trim(), '');
    assert.equal(f.stateOf('cancel-hold'), 'cancelled', 'a cancelled task does not come back');
  } finally {
    await f.done();
  }
});

test('JEV-0052: a submit that finds both slots busy is queued with no lease (leaseIds []), and is leased when a slot frees; a worker nobody releases keeps its slot', async () => {
  const f = await fixture({ held: ['hold-1', 'hold-2', 'cancel-hold'] });
  try {
    const first = await f.plan([task('hold-1'), task('hold-2')]);
    assert.equal(first.body.leaseIds.length, 2);
    // What the tester's cancel test meets after a failed concurrency test: its own plan leases nothing, because the slots are taken.
    const second = await f.plan([task('cancel-hold')]);
    assert.equal(second.body.accepted, true);
    assert.deepEqual(second.body.leaseIds, [], 'queued, not refused');
    assert.equal(f.stateOf('cancel-hold'), 'ready');
    f.release('hold-1');
    await until(() => RUNNING.includes(f.stateOf('cancel-hold')), 'cancel-hold to be leased when a slot freed');
    // Its hold flag was never written, so it keeps the slot: `active workers` lists it for as long as it runs.
    assert.deepEqual(f.activeWorkers(), ['cancel-hold', 'hold-2']);
  } finally {
    await f.done();
  }
});

// ----------------------------------------------------------------------------------------------- JEV-0053

test('JEV-0053: the kill switch holds the one pending effect of one running worker; reconcile is refused while stopped, settles it after clear, and a second reconcile has nothing to do', async () => {
  const f = await fixture({ held: ['rec-hold'] });
  try {
    const submitted = await f.plan([task('rec-hold')]);
    assert.equal(submitted.body.leaseIds.length, 1);
    await until(() => ownedSessions(f.ws).some((o) => o.taskId === 'rec-hold' && o.state === 'running'), 'rec-hold to run');
    // `jevris kill-switch activate` prints "N pending effect(s) held for reconciliation" with N = held.length of this write.
    const held = holdPendingEffects(f.store, { nowMs: Date.now(), actor: 'tester', channel: 'cli' }).held;
    assert.deepEqual(held, [effectOperationId(submitted.body.leaseIds[0])], 'one worker in flight, one effect held');
    f.release('rec-hold');
    await drainBackgroundWorkers();
    assert.equal(f.stateOf('rec-hold'), 'blocked', 'the held effect keeps the task blocked');
    assert.equal(heldTaskEffects(f.ws).length, 1);
    // Reconcile is refused while the switch is stopped (the op also carries stoppedByKillSwitch, which the sidecar enforces before it runs).
    assert.equal(sidecarOps.find((o) => o.op === 'task.reconcile').stoppedByKillSwitch, true);
    const refused = reconcileOwnedEffect(f.ws, { taskId: 'rec-hold', resolution: 'applied', actor: 'tester', channel: 'cli', killSwitchStopped: true });
    assert.deepEqual([refused.ok, refused.reasonCode], [false, 'KILL_SWITCH']);
    assert.equal(heldTaskEffects(f.ws).length, 1, 'refused: still held');
    // After clear a person settles it, and the task leaves the held state.
    const settled = await f.call('task.reconcile', { taskId: 'rec-hold', resolution: 'applied' });
    assert.deepEqual([settled.body.reconciled, settled.body.reasonCode, settled.body.held], [true, 'RECONCILED', 0], JSON.stringify(settled.body));
    assert.notEqual(f.stateOf('rec-hold'), 'blocked');
    const again = await f.call('task.reconcile', { taskId: 'rec-hold', resolution: 'applied' });
    assert.deepEqual([again.body.reconciled, again.body.reasonCode], [false, 'NOT_HELD'], 'the CLI says "Nothing to reconcile" (exit 1)');
    await drainBackgroundWorkers();
  } finally {
    await f.done();
  }
});

test('JEV-0053: the kill switch holds every owned effect pending in the store, so a second worker still in flight makes it "2 pending effect(s)"', async () => {
  const f = await fixture({ held: ['stale-hold', 'rec-hold'] });
  try {
    // The second worker is the tester's earlier cancel-hold, left waiting because its test failed before it wrote the flag.
    const stale = await f.plan([task('stale-hold')]);
    const mine = await f.plan([task('rec-hold')]);
    assert.equal(stale.body.leaseIds.length + mine.body.leaseIds.length, 2);
    await until(() => ownedSessions(f.ws).filter((o) => o.state === 'running').length === 2, 'both workers to run');
    const held = holdPendingEffects(f.store, { nowMs: Date.now(), actor: 'tester', channel: 'cli' }).held;
    assert.deepEqual([...held].sort(), [...stale.body.leaseIds, ...mine.body.leaseIds].map(effectOperationId).sort(), 'the count is the pending owned effects in the store, not the tasks one test submitted');
    assert.equal(held.length, 2);
  } finally {
    await f.done();
  }
});

// ----------------------------------------------------------------------------------------------- JEV-0054

test('JEV-0054: cancelling a running task with a queued dependant blocks the dependant, frees the slot, and an unrelated task (named model or none) is accepted, leased and finishes', async () => {
  const f = await fixture({ held: ['dc-a'], quick: ['dc-later', 'dc-later2'] });
  try {
    const first = await f.plan([task('dc-a'), task('dc-b', { deps: ['dc-a'] })]);
    assert.equal(first.body.leaseIds.length, 1, 'only the first wave starts');
    await until(() => f.stateOf('dc-a') === 'running', 'dc-a to run');
    const cancelled = await f.call('task.cancel', { taskId: 'dc-a' });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    f.release('dc-a');
    await until(() => f.stateOf('dc-a') === 'cancelled', 'dc-a to be cancelled');
    await until(() => f.activeLeases().length === 0, 'the slot to be free');
    assert.deepEqual(f.activeWorkers(), [], 'the workers the tester waits on have finished');
    // The dependant is marked at the next scheduling pass after the cancellation lands (the answer, or the run's end drain).
    await until(() => f.stateOf('dc-b') === 'blocked', 'the queued dependant to be blocked');
    assert.equal(getTask(f.ws, 'dc-b').stateReason, 'DEPENDENCY_CANCELLED', 'a queued dependant says why it waits');
    // An unrelated submit that names no model (the tester's MCP call) is accepted; so is a plan under the same budget.
    const later = await f.call('task.submit', { task: task('dc-later', { noModel: true }) });
    assert.equal(later.body.accepted, true, `an unrelated submit was refused after the cancel: ${later.body.reasonCode}`);
    const planned = await f.plan([task('dc-later2')]);
    assert.equal(planned.body.accepted, true, JSON.stringify(planned.body));
    assert.equal(planned.body.leaseIds.length, 1, 'the freed slot runs it');
    await until(() => f.stateOf('dc-later2') === 'awaiting-evidence', 'dc-later2 to finish its run');
    await drainBackgroundWorkers();
    assert.deepEqual(f.activeLeases(), [], 'no lease is left held');
  } finally {
    await f.done();
  }
});

// ----------------------------------------------------------------------------------------------- JEV-0047

test('JEV-0047: the reason an accepted task.submit gives for a queued task names why it is queued: QUEUED (workers not automatic, or a prerequisite is not verified) or CAP_REACHED (every slot is busy)', async () => {
  const advice = await fixture({ managedWorkers: 'advise' });
  try {
    await advice.plan([task('seed')]);
    const queued = await advice.call('task.submit', { task: task('later') });
    assert.deepEqual([queued.body.accepted, queued.body.leaseIds, queued.body.reasonCode], [true, [], 'QUEUED'], 'workers are not automatic');
  } finally {
    await advice.done();
  }
  const f = await fixture({ held: ['hold-1', 'hold-2', 'hold-3'], quick: [] });
  try {
    const seed = await f.plan([task('hold-1')]);
    assert.equal(seed.body.leaseIds.length, 1);
    const leased = await f.call('task.submit', { task: task('hold-2') });
    assert.deepEqual([leased.body.accepted, leased.body.leaseIds.length, leased.body.reasonCode], [true, 1, 'LEASED']);
    const full = await f.call('task.submit', { task: task('hold-3') });
    assert.deepEqual([full.body.accepted, full.body.leaseIds, full.body.reasonCode], [true, [], 'CAP_REACHED'], 'every slot is busy: queued, and it starts when one frees');
    assert.equal(f.stateOf('hold-3'), 'ready');
    const waiting = await f.call('task.submit', { task: task('after-1', { deps: ['hold-1'] }) });
    assert.deepEqual([waiting.body.accepted, waiting.body.leaseIds, waiting.body.reasonCode], [true, [], 'QUEUED'], 'a task that waits for a prerequisite is queued, not capped');
    assert.equal(f.stateOf('after-1'), 'validated');
    f.release('hold-1');
    await until(() => RUNNING.includes(f.stateOf('hold-3')), 'hold-3 to start when a slot freed');
  } finally {
    await f.done();
  }
});

test('JEV-0047: the docs name every reason an accepted task.submit can give for a queued task', () => {
  const docs = readFileSync(fileURLToPath(new URL('../../../docs/settings.md', import.meta.url)), 'utf8');
  for (const code of ['LEASED', 'QUEUED', 'QUEUED_NO_MODEL', 'QUEUED_WORKER_UNSUPPORTED', 'CAP_REACHED', 'RESOURCE_BUSY', 'OVER_BUDGET', 'BUDGET_PAUSED']) {
    assert.ok(docs.includes(`\`${code}\``), `docs/settings.md (Workers) does not name ${code}`);
  }
});
