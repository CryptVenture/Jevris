import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  criticalPathLengths,
  getPlan,
  getTask,
  leaseAuthorityFor,
  listTasks,
  nodeFor,
  reasonCode,
  livenessOf,
  processStartMs,
  openWorkspace,
  scheduleTasks,
  selfIdentity,
  submitPlan,
  submitTask,
  taskTransition,
  transitionTask,
  validatePlan,
  waiveTask,
  hostIdentity,
  isThisHost,
  legacyHostId,
  openLedger,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { mintAuthorization } from '@jevris/store';
import { tempDir } from './temp-dirs.mjs';

function fixture() {
  const dir = tempDir('jv-orc-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  return { ws, authority: leaseAuthorityFor(ws), done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const task = (id, extra = {}) => ({
  id,
  requirementIds: ['R1'],
  acceptanceCheckIds: ['unit'],
  expectedOutputs: ['patch'],
  writeScopes: [`mod/${id}`],
  ...extra,
});

const plan = (tasks, extra = {}) => ({
  tasks,
  ownerId: 'alice',
  rootBudget: { id: 'b1', limitMicroUsd: 10_000_000, shutdownReserveMicroUsd: 1_000_000 },
  requireApprovedChecks: false,
  ...extra,
});

test('the plan validator refuses cycles, unknown deps, overlapping concurrent writes, and missing owner, budget, checks or outputs (ORC-01)', () => {
  const base = { workspaceId: 'ws1', ownerId: 'alice', rootBudget: { id: 'b', limitMicroUsd: 100 } };
  const codes = (r) => (r.ok ? [] : [...new Set(r.issues.map((i) => i.code))].sort());
  assert.deepEqual(codes(validatePlan({ ...base, tasks: [task('a', { dependencyIds: ['b'] }), task('b', { dependencyIds: ['a'] })] })), ['CYCLE']);
  assert.deepEqual(codes(validatePlan({ ...base, tasks: [task('a', { dependencyIds: ['zz'] })] })), ['UNKNOWN_DEPENDENCY']);
  assert.deepEqual(codes(validatePlan({ ...base, tasks: [task('a', { writeScopes: ['src'] }), task('b', { writeScopes: ['src/x.ts'] })] })), ['WRITE_OVERLAP']);
  // The same write set is fine when one node depends on the other.
  assert.equal(validatePlan({ ...base, tasks: [task('a', { writeScopes: ['src'] }), task('b', { writeScopes: ['src/x.ts'], dependencyIds: ['a'] })] }).ok, true);
  assert.deepEqual(
    codes(validatePlan({ ...base, ownerId: ' ', rootBudget: null, tasks: [task('a', { acceptanceCheckIds: [], expectedOutputs: [], requirementIds: [] })] })),
    ['NO_ACCEPTANCE_CHECK', 'NO_EXPECTED_OUTPUT', 'NO_OWNER', 'NO_REQUIREMENT', 'NO_ROOT_BUDGET'],
  );
  assert.deepEqual(codes(validatePlan({ ...base, requirementIds: ['R1', 'R2'], tasks: [task('a')] })), ['UNCOVERED_REQUIREMENT']);
  assert.deepEqual(codes(validatePlan({ ...base, availableResources: ['gpu'], tasks: [task('a', { resourceKeys: ['db'] })] })), ['UNKNOWN_RESOURCE']);
  assert.deepEqual(codes(validatePlan({ ...base, approvedCheckIds: ['lint'], tasks: [task('a')] })), ['UNKNOWN_CHECK']);
  const ok = validatePlan({ ...base, tasks: [task('a'), task('b', { dependencyIds: ['a'] }), task('c')] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.waves, [['a', 'c'], ['b']]);
  assert.equal(criticalPathLengths(ok.nodes).get('a'), 2);
});

test('dependants release only on verified or waived prerequisites; the cap counts running leases (ORC-02)', async () => {
  const f = fixture();
  try {
    const submitted = await submitPlan(f.ws, plan([task('a'), task('b', { dependencyIds: ['a'] }), task('c'), task('d')]));
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const holder = selfIdentity();
    const first = await scheduleTasks(f.ws, { authority: f.authority, holder, cap: 2 });
    // a has the longest critical path, so it goes first; then c (older than d by id order).
    assert.deepEqual(first.leased.map((g) => g.lease.taskId), ['a', 'c']);
    assert.ok(first.skipped.some((s) => s.taskId === 'd' && s.reason === 'CAP_REACHED'));
    assert.equal(getTask(f.ws, 'b').node.state, 'validated');
    // A second pass counts the two running leases, not the caller's list.
    const second = await scheduleTasks(f.ws, { authority: f.authority, holder, cap: 2 });
    assert.equal(second.leased.length, 0);
    // Without an authorization minted on the terminal, no exception is accepted.
    assert.equal(waiveTask(f.ws, 'a', { principal: 'lead-dev', reason: 'covered by manual QA', authorizationId: 'anone' }).ok, false);
    assert.equal(taskTransition(f.ws, 'a', 'running', 'WORKER_STARTED', { actor: 'runner' }).ok, true);
    assert.equal(taskTransition(f.ws, 'a', 'awaiting-evidence', 'WORKER_FINISHED', { actor: 'runner' }).ok, true);
    assert.equal(waiveTask(f.ws, 'a', { principal: 'lead-dev', reason: 'covered by manual QA', authorizationId: 'anone' }).reasonCode, 'AUTHORIZATION_REFUSED');
    const auth = mintAuthorization(f.ws.store, { principal: 'lead-dev', actionClass: 'task.exception', scope: `${f.ws.workspaceId}:a`, ttlMs: 60_000, channel: 'terminal', nowMs: Date.now() });
    assert.equal(auth.ok, true, JSON.stringify(auth));
    const waived = waiveTask(f.ws, 'a', { principal: 'lead-dev', reason: 'covered by manual QA', authorizationId: auth.authorizationId });
    assert.equal(waived.ok, true, JSON.stringify(waived));
    assert.equal(waived.task.verifiedBy, 'exception');
    const third = await scheduleTasks(f.ws, { authority: f.authority, holder, cap: 3 });
    assert.ok(third.promoted.includes('b'));
    assert.equal(third.leased.length, 1);
    const lease = first.leased[0];
    assert.ok(Date.parse(lease.lease.expiresAt) > Date.parse(lease.lease.heartbeatAt));
    assert.equal(lease.reservation.state, 'reserved');
  } finally {
    f.done();
  }
});

test('filters and ordering: toolchain, data scope, model eligibility, resource keys and budget (ORC-02)', async () => {
  const f = fixture();
  try {
    await submitPlan(
      f.ws,
      plan([
        task('needs-cargo', { toolchains: ['cargo'] }),
        task('secret-data', { dataScope: 'pii' }),
        task('opus-only', { models: ['claude-opus'] }),
        task('db-1', { resourceKeys: ['db'], value: 90 }),
        task('db-2', { resourceKeys: ['db'], value: 10 }),
        task('huge', { estimateMicroUsd: 9_500_000 }),
      ]),
    );
    const out = await scheduleTasks(f.ws, {
      authority: f.authority,
      holder: selfIdentity(),
      cap: 10,
      runner: { toolchains: ['node'], dataScopes: ['workspace'], models: ['claude-sonnet'] },
    });
    const why = Object.fromEntries(out.skipped.map((s) => [s.taskId, s.reason]));
    assert.equal(why['needs-cargo'], 'TOOLCHAIN_MISSING');
    assert.equal(why['secret-data'], 'DATA_SCOPE');
    assert.equal(why['opus-only'], 'MODEL_INELIGIBLE');
    assert.equal(why['db-2'], 'RESOURCE_BUSY');
    assert.equal(why['huge'], 'OVER_BUDGET');
    assert.deepEqual(out.leased.map((g) => g.lease.taskId), ['db-1']);
  } finally {
    f.done();
  }
});

test('expiry blocks for reconciliation; reconcile settles spend conservatively; fencing refuses an old token (ORC-03)', async () => {
  const f = fixture();
  try {
    await submitPlan(f.ws, plan([task('a')]));
    const t0 = Date.now();
    const holder = selfIdentity();
    const first = await scheduleTasks(f.ws, { authority: f.authority, holder, nowMs: t0, ttlMs: 10_000 });
    const old = first.leased[0].lease;
    assert.equal((await f.authority.heartbeat(f.ws.workspaceId, old.id, old.fencingToken, t0 + 5_000)).ok, true);
    assert.deepEqual(await f.authority.sweep(f.ws.workspaceId, t0 + 10_000, () => 'alive'), []);
    const expired = await f.authority.sweep(f.ws.workspaceId, t0 + 16_000, () => 'alive');
    assert.deepEqual(expired, [old.id]);
    assert.equal(getTask(f.ws, 'a').node.state, 'blocked');
    // Blocked tasks are not rescheduled until reconciled.
    assert.equal((await scheduleTasks(f.ws, { authority: f.authority, holder, nowMs: t0 + 17_000 })).leased.length, 0);
    assert.equal((await f.authority.reconcile(f.ws.workspaceId, 'a', { spentMicroUsd: null, resume: true }, t0 + 18_000)).ok, true);
    const rsv = f.ws.host.list('reservations').find((r) => r.leaseId === old.id);
    assert.equal(rsv.reservation.state, 'committed');
    assert.equal(rsv.reservation.actualMicroUsd, rsv.reservation.reservedMicroUsd);
    const second = await scheduleTasks(f.ws, { authority: f.authority, holder, nowMs: t0 + 19_000 });
    const fresh = second.leased[0].lease;
    assert.ok(fresh.fencingToken > old.fencingToken);
    const stale = await f.authority.publishFenced(f.ws.workspaceId, 'a', old.fencingToken, () => 'wrote', t0 + 19_500);
    assert.deepEqual(stale, { ok: false, reasonCode: 'STALE_TOKEN' });
    const good = await f.authority.publishFenced(f.ws.workspaceId, 'a', fresh.fencingToken, () => 'wrote', t0 + 19_500);
    assert.deepEqual(good, { ok: true, value: 'wrote' });
  } finally {
    f.done();
  }
});

test('a dead holder is swept even before its heartbeat expires; liveness checks PID and start time (ORC-03)', async () => {
  const f = fixture();
  try {
    await submitPlan(f.ws, plan([task('a')]));
    await scheduleTasks(f.ws, { authority: f.authority, holder: selfIdentity() });
    assert.equal((await f.authority.sweep(f.ws.workspaceId, Date.now(), () => 'dead')).length, 1);
    const me = selfIdentity();
    assert.equal(livenessOf(me), me.startedAtMs === null ? 'unknown' : 'alive');
    assert.equal(livenessOf({ ...me, startedAtMs: 1 }, { exists: () => true, startMs: () => 999_999 }), 'dead');
    assert.equal(livenessOf({ ...me, pid: 999_999_9 }, { exists: () => false }), 'dead');
    assert.equal(livenessOf({ ...me, hostId: 'h-other' }), 'other-host');
    assert.match(hostIdentity(), /^(?:m[0-9a-f]{24}|h-[0-9a-f]{16})$/);
  } finally {
    f.done();
  }
});

test('this process\'s start time is read once: its own lease sweeps start no process after the first (ORC-03; a PowerShell start each on Windows)', () => {
  const first = processStartMs(process.pid);
  assert.equal(selfIdentity().startedAtMs, first);
  const cp = createRequire(import.meta.url)('node:child_process');
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];
  const originals = names.map((name) => cp[name]);
  let started = 0;
  names.forEach((name, i) => {
    cp[name] = (...args) => {
      started += 1;
      return originals[i](...args);
    };
  });
  // ESM imports of node:child_process see the patch only once the builtin exports are synced.
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 5; i += 1) assert.equal(processStartMs(process.pid), first);
    assert.equal(livenessOf(selfIdentity()), first === null ? 'unknown' : 'alive');
  } finally {
    names.forEach((name, i) => {
      cp[name] = originals[i];
    });
    syncBuiltinESMExports();
  }
  assert.equal(started, first === null ? started : 0, 'a known own start time is not read again');
});

test('the verified state cannot be set by a transition call, and submitTask extends a plan (ORC-01)', async () => {
  const f = fixture();
  try {
    await submitPlan(f.ws, plan([task('a')]));
    assert.deepEqual(await transitionTask(f.ws, 'a', 'verified', 'model says done'), { ok: false, reasonCode: 'VERIFY_REQUIRES_COMPLETION' });
    assert.deepEqual(await transitionTask(f.ws, 'a', 'running', 'skip'), { ok: false, reasonCode: 'ILLEGAL_TRANSITION' });
    const added = await submitTask(f.ws, task('b', { dependencyIds: ['a'] }), 'b1', 'alice');
    assert.equal(added.ok, true);
    const clash = await submitTask(f.ws, task('c', { writeScopes: ['mod/a'] }), 'b1', 'alice');
    assert.equal(clash.ok, false);
    assert.equal(clash.issues[0].code, 'WRITE_OVERLAP');
    assert.equal((await submitTask(f.ws, task('d'), 'nope', 'alice')).issues[0].code, 'NO_ROOT_BUDGET');
  } finally {
    f.done();
  }
});

test('without a store, tasks and receipts are unavailable and nothing is written (DATA-03)', async () => {
  const dir = tempDir('jv-orc-nostore-');
  try {
    const home = join(dir, 'home');
    const repo = join(dir, 'repo');
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home } });
    assert.equal(ws.store, undefined);
    assert.equal(ws.receipts.available, false);
    const planned = await submitPlan(ws, plan([task('a')]));
    assert.deepEqual(planned, { ok: false, issues: [{ taskId: '#plan', code: 'STORE_UNAVAILABLE' }] });
    assert.deepEqual(listTasks(ws), []);
    assert.equal(getTask(ws, 'a'), undefined);
    assert.equal(taskTransition(ws, 'a', 'ready', 'X', { actor: 'planner' }).reasonCode, 'STORE_UNAVAILABLE');
    assert.equal(waiveTask(ws, 'a', { principal: 'p', reason: 'r', authorizationId: 'a1' }).reasonCode, 'STORE_UNAVAILABLE');
    assert.deepEqual(ws.receipts.list(ws.workspaceId), []);
    assert.equal(await ws.receipts.invalidate(ws.workspaceId, ['r1'], 'x'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a task left leased without an active lease is swept to blocked; ids outside the store pattern are refused (ORC-03)', async () => {
  const f = fixture();
  try {
    assert.equal((await submitPlan(f.ws, plan([task('a'), task('b')]))).ok, true);
    const first = await scheduleTasks(f.ws, { authority: f.authority, holder: selfIdentity(), cap: 2 });
    assert.equal(first.leased.length, 2);
    const grant = first.leased.find((g) => g.lease.taskId === 'a');
    // A release without the task move (a crash between the two) leaves an orphan.
    assert.equal((await f.authority.release(f.ws.workspaceId, grant.lease.id, grant.lease.fencingToken, { actualMicroUsd: 0 }, Date.now())).ok, true);
    assert.equal(getTask(f.ws, 'a').node.state, 'leased');
    assert.deepEqual(await f.authority.sweep(f.ws.workspaceId, Date.now(), () => 'alive'), []);
    const swept = getTask(f.ws, 'a');
    assert.equal(swept.node.state, 'blocked');
    assert.equal(swept.leaseId, null);
    assert.equal(getTask(f.ws, 'b').node.state, 'leased', 'a task with an active lease is left alone');
    assert.equal((await f.authority.reconcile(f.ws.workspaceId, 'a', { spentMicroUsd: null, resume: true }, Date.now())).ok, true);
    assert.equal(getTask(f.ws, 'a').node.state, 'ready');
    // Readable reasons survive next to the store's codes; codes stay codes.
    assert.equal(taskTransition(f.ws, 'a', 'blocked', 'waiting for the vendor fix', { actor: 'human' }).task.stateReason, 'waiting for the vendor fix');
    assert.equal(taskTransition(f.ws, 'a', 'ready', 'UNBLOCKED', { actor: 'human' }).task.stateReason, 'UNBLOCKED');
    assert.equal(taskTransition(f.ws, 'a', 'validated', 'x', { actor: 'planner', expectedRevision: 'r1' }).reasonCode, 'STALE_REVISION');
    assert.equal(taskTransition(f.ws, 'a', 'validated', 'x', { actor: 'planner', expectedRevision: 'rX' }).reasonCode, 'STALE_REVISION');
    assert.equal(taskTransition(f.ws, 'no.such', 'ready', 'x', { actor: 'planner' }).reasonCode, 'UNKNOWN_TASK');
    assert.equal(nodeFor({ id: 'has.dot' }, f.ws.workspaceId, 'b1'), undefined);
    assert.equal(reasonCode('9 lives left'), 'R_9_LIVES_LEFT');
  } finally {
    f.done();
  }
});

test('a plan records its id; a budget id is written once and a conflicting resubmission is refused (ORC-01, ORC-10)', async () => {
  const f = fixture();
  try {
    const first = await submitPlan(f.ws, plan([task('a')]));
    assert.equal(first.ok, true);
    assert.match(first.planId, /^plan-[a-f0-9]{20}$/);
    assert.equal(first.rootBudgetId, 'b1');
    assert.deepEqual(getPlan(f.ws, first.planId).taskIds, ['a']);
    // The same budget again is reused; a different limit under the same id would reset the money.
    assert.equal((await submitPlan(f.ws, plan([task('b')]))).ok, true);
    const bigger = await submitPlan(f.ws, { ...plan([task('c')]), rootBudget: { id: 'b1', limitMicroUsd: 999_999_999 } });
    assert.deepEqual(bigger, { ok: false, issues: [{ taskId: '#plan', code: 'BUDGET_CONFLICT', detail: 'b1' }] });
    assert.equal(getTask(f.ws, 'c'), undefined, 'a refused plan creates no task');
  } finally {
    f.done();
  }
});

test('P3 (sidecar concurrency audit): transactions in one process queue on an in-process mutex, in order, with none lost; a wait is bounded by the caller signal or waitMs; a lock this process left behind is taken over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jv-mutex-'));
  try {
    const ledger = openLedger(dir, { staleMs: 600_000, lockWaitMs: 30_000 });
    // A second ledger object on the same directory shares the queue.
    const other = openLedger(dir, { staleMs: 600_000, lockWaitMs: 30_000 });
    const order = [];
    const bump = (l, i) => l.transact((tx) => {
      order.push(i);
      tx.put('counter', 'n', (tx.get('counter', 'n') ?? 0) + 1);
    });
    await Promise.all(Array.from({ length: 40 }, (_, i) => bump(i % 2 === 0 ? ledger : other, i)));
    assert.equal(ledger.get('counter', 'n'), 40, 'no lost update');
    assert.deepEqual(order, Array.from({ length: 40 }, (_, i) => i), 'first come, first served');
    // An aborted caller writes nothing, and the queue moves on.
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(ledger.transact((tx) => tx.put('counter', 'n', -1), { signal: gone.signal }), /lock wait aborted/);
    // A caller queued behind a transaction that is waiting on another process's lock gives up when
    // its signal aborts; the one ahead of it still runs once that lock is released.
    const theirs = () => {
      mkdirSync(join(dir, '.lock'));
      writeFileSync(join(dir, '.lock', 'owner'), JSON.stringify({ pid: process.ppid, host: hostname(), nonce: 'theirs', at: Date.now() }));
    };
    theirs();
    const ahead = bump(ledger, 40);
    const waiting = new AbortController();
    const queued = ledger.transact((tx) => tx.put('counter', 'n', -2), { signal: waiting.signal });
    waiting.abort();
    await assert.rejects(queued, /lock wait aborted/);
    rmSync(join(dir, '.lock'), { recursive: true, force: true });
    await ahead;
    assert.equal(ledger.get('counter', 'n'), 41);
    // Another live process holds the directory lock: waitMs bounds the wait.
    theirs();
    await assert.rejects(ledger.transact((tx) => tx.put('counter', 'n', -3), { waitMs: 50 }), /lock busy/);
    // A lock this process left behind (its own pid, a nonce it does not hold) is taken over at once.
    writeFileSync(join(dir, '.lock', 'owner'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'leftover', at: Date.now() }));
    await ledger.transact((tx) => tx.put('counter', 'n', 100), { waitMs: 50 });
    assert.equal(ledger.get('counter', 'n'), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the host id is the stable machine id, so leases, liveness and the ledger lock survive a network rename; records stamped by an earlier name stay this host\'s (DATA-10, B a08d9fc)', async () => {
  const machine = (id) => () => ({ ok: true, machineId: id, source: 'test', user: 'uid:501' });
  const unreadable = () => ({ ok: false, reason: 'machine-id-unreadable' });
  // The same machine under two network names has one id; another machine has another.
  const before = hostIdentity({ machine: machine('mac-1'), hostname: () => 'Alexs-MacBook.local' });
  const after = hostIdentity({ machine: machine('mac-1'), hostname: () => 'Alexs-MacBook-2.local' });
  assert.match(before, /^m[0-9a-f]{24}$/);
  assert.equal(after, before);
  assert.notEqual(hostIdentity({ machine: machine('mac-2'), hostname: () => 'Alexs-MacBook.local' }), before);
  assert.doesNotMatch(before, /mac-1/, 'the raw machine id is never kept');
  // An unreadable machine id falls back to the earlier host-name id.
  assert.equal(hostIdentity({ machine: unreadable, hostname: () => 'box' }), legacyHostId('box'));
  // Earlier records: the old h- id or a raw name (an old ledger lock) of any name this machine went by.
  const ports = { machine: machine('mac-1'), hostname: () => 'Alexs-MacBook-2.local', hostnames: () => ['Alexs-MacBook-2.local', 'Alexs-MacBook', 'Alexs-MacBook.local'] };
  for (const host of [before, legacyHostId('Alexs-MacBook.local'), legacyHostId('Alexs-MacBook'), legacyHostId('Alexs-MacBook-2.local'), 'Alexs-MacBook.local']) assert.equal(isThisHost(host, ports), true, host);
  for (const host of [hostIdentity({ machine: machine('mac-2') }), legacyHostId('someone-elses-box'), 'someone-elses-box', 'h-0000000000000000']) assert.equal(isThisHost(host, ports), false, host);
  // Liveness: a holder recorded under this machine's current name (the old formula) is judged here, not left to the heartbeat.
  const me = selfIdentity();
  assert.equal(livenessOf({ ...me, hostId: legacyHostId(hostname()), pid: 999_999_9 }, { exists: () => false }), 'dead');
  assert.equal(livenessOf({ ...me, hostId: hostIdentity({ machine: machine('another-machine') }) }), 'other-host');
  // Ledger lock: an owner file written by host name, whose process is gone, is reclaimed at once, not after staleMs.
  const dir = mkdtempSync(join(tmpdir(), 'jv-host-'));
  try {
    const ledger = openLedger(dir, { staleMs: 600_000, lockWaitMs: 5_000 });
    mkdirSync(join(dir, '.lock'), { recursive: true });
    writeFileSync(join(dir, '.lock', 'owner'), JSON.stringify({ pid: 999_999_9, host: hostname(), nonce: 'old', at: Date.now() }));
    // staleMs is ten minutes and the wait is bounded: the write succeeds only because the dead owner is this host's.
    await ledger.transact((tx) => tx.put('things', 'a', { v: 1 }));
    assert.deepEqual(ledger.get('things', 'a'), { v: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger commit writes on fs/promises: from the moment the transaction function returns, this process reads all of its writes, and a later transaction sees them on disk', async () => {
  const dir = tempDir('jv-ledger-async-');
  const ledger = openLedger(join(dir, 'state'));
  let during;
  const committed = ledger.transact((tx) => {
    tx.put('pairs', 'a', { n: 1 });
    tx.put('pairs', 'b', { n: 2 });
    // Runs while the commit is on the disk (or just after it): never half the transaction.
    setImmediate(() => {
      during = [ledger.get('pairs', 'a'), ledger.get('pairs', 'b'), ledger.list('pairs').length];
    });
    return 'ok';
  });
  assert.equal(await committed, 'ok');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(during, [{ n: 1 }, { n: 2 }, 2]);
  // A fresh ledger on the same directory (another process's view) reads the files.
  const other = openLedger(join(dir, 'state'));
  assert.deepEqual([other.get('pairs', 'a'), other.get('pairs', 'b')], [{ n: 1 }, { n: 2 }]);
  await ledger.transact((tx) => tx.delete('pairs', 'a'));
  assert.equal(other.get('pairs', 'a'), undefined);
  assert.deepEqual(other.list('pairs'), [{ n: 2 }]);
  // A throwing transaction writes nothing and leaves nothing in flight.
  await assert.rejects(ledger.transact((tx) => {
    tx.put('pairs', 'c', { n: 3 });
    throw new Error('boom');
  }), /boom/);
  assert.equal(ledger.get('pairs', 'c'), undefined);
});
