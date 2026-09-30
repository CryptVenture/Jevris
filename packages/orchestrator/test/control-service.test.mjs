import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardStdin } from '../../../scripts/child-stdin.mjs';
import {
  CONTROL_CLIENT_SCHEMA,
  controlClient,
  getTask,
  hostIdentity,
  legacyHostId,
  leaseAuthorityFor,
  ledgerLeaseAuthority,
  migrateToControlService,
  openLedger,
  openWorkspace,
  remoteLeaseAuthority,
  scheduleTasks,
  selfIdentity,
  setBudget,
  sidecarOps,
  startControlService,
  submitPlan,
  tokenDigest,
} from '../dist/index.js';
import { writePrivateFile } from '@jevris/platform';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const DIST = import.meta.resolve('../dist/index.js');
const token = () => randomBytes(24).toString('hex');
// The client's timeout is a wall-clock wait on an idle socket, and the service runs in this very
// process. A Windows runner that stalls the process for 10 s (180d3cd on Node 24: this test took
// 11.5 s instead of 0.4 s and the first acquire answered CONTROL_UNAVAILABLE) trips the 10 s
// default with nothing wrong in the service. Generous here; the product default stays 10 s.
const CLIENT_TIMEOUT_MS = 120_000;

const holder = { hostId: 'h-test', pid: 1, startedAtMs: 1, sessionId: null };

/** An in-memory task port: what a host's store does for the lease authority. */
function memoryPort(tasks) {
  const rows = new Map(tasks.map((t) => [t.id, { state: 'ready', rootBudgetId: 'b1', resourceKeys: [], leaseId: null, ...t }]));
  const view = (r) => ({ node: { state: r.state, rootBudgetId: r.rootBudgetId }, resourceKeys: r.resourceKeys });
  return {
    rows,
    get: (id) => (rows.has(id) ? view(rows.get(id)) : undefined),
    leased(id, leaseId) {
      const r = rows.get(id);
      if (r === undefined || r.state !== 'ready') return false;
      rows.set(id, { ...r, state: 'leased', leaseId });
      return true;
    },
    expired(id, leaseId) {
      const r = rows.get(id);
      if (r === undefined || r.leaseId !== leaseId) return false;
      rows.set(id, { ...r, state: 'blocked', leaseId: null });
      return true;
    },
    reconciled(id, resume) {
      const r = rows.get(id);
      if (r === undefined || r.state !== 'blocked') return { ok: false, reasonCode: 'NOT_BLOCKED' };
      rows.set(id, { ...r, state: resume ? 'ready' : 'cancelled' });
      return { ok: true };
    },
    holding: () => [...rows.entries()].filter(([, r]) => r.leaseId !== null).map(([taskId, r]) => ({ taskId, leaseId: r.leaseId })),
  };
}

async function host(dir, name, url, secret, tasks, budget = { limitMicroUsd: 10_000_000 }) {
  const ledger = openLedger(join(dir, name));
  await setBudget(ledger, { id: 'b1', workspaceId: 'w1', ownerId: 'alice', shutdownReserveMicroUsd: 0, policy: 'finish-running', ...budget });
  const port = memoryPort(tasks);
  const client = controlClient({ url, token: () => secret, timeoutMs: CLIENT_TIMEOUT_MS });
  const authority = remoteLeaseAuthority({ client, ledger, tasksFor: (w) => (w === 'w1' ? port : undefined), hostId: `h-${name}` });
  return { ledger, port, client, authority };
}

const request = (taskId, extra = {}) => ({ taskId, ownerId: 'alice', worktreeId: `wt-${taskId}`, reserveMicroUsd: 1_000, holder, ...extra });

test('control service: tokens select one tenant; tenants never see each other; transport and input are guarded (ORC-12)', async () => {
  const dir = tempDir('jv-ctl-');
  const [ta, tb] = [token(), token()];
  const svc = await startControlService({ root: join(dir, 'svc'), tenants: [{ id: 'acme', tokenSha256: tokenDigest(ta) }, { id: 'beta', tokenSha256: tokenDigest(tb) }] });
  try {
    const a = await host(dir, 'a', svc.url, ta, [{ id: 't1' }]);
    const got = await a.authority.acquire('w1', [request('t1')], { cap: 2, nowMs: Date.now() });
    assert.equal(got.granted.length, 1);
    assert.equal(a.port.rows.get('t1').state, 'leased');
    assert.equal(a.authority.activeLeases('w1').length, 1);
    // Tenant beta holds the same workspace and task ids and sees none of acme's leases.
    const b = await host(dir, 'b', svc.url, tb, [{ id: 't1' }]);
    assert.equal((await b.client.call('leases', { workspaceId: 'w1' })).result.active.length, 0);
    assert.equal((await b.authority.acquire('w1', [request('t1')], { cap: 2, nowMs: Date.now() })).granted.length, 1);
    assert.equal((await b.authority.heartbeat('w1', got.granted[0].lease.id, 1, Date.now())).reasonCode, 'UNKNOWN_LEASE');
    // A wrong token is refused before the body is read; health needs no token and says nothing else.
    const wrong = controlClient({ url: svc.url, token: () => token(), timeoutMs: CLIENT_TIMEOUT_MS });
    assert.equal((await wrong.call('leases', { workspaceId: 'w1' })).reason, 'unauthorized');
    const health = await fetch(new URL('v1/health', svc.url));
    assert.deepEqual(await health.json(), { schemaVersion: 'jevris-control-1' });
    const raw = await fetch(new URL('v1/leases', svc.url), { method: 'POST', headers: { authorization: `Bearer ${ta}` }, body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(raw.status, 413);
    const bad = await a.client.call('acquire', { workspaceId: 'w1', cap: 1, requests: [{ taskId: 't2' }], budgets: [] });
    assert.deepEqual([bad.ok, bad.code], [false, 'INVALID_REQUEST']);
    // Each tenant has its own ledger directory.
    assert.equal(existsSync(join(dir, 'svc', 'tenants', 'acme', 'leases')), true);
    assert.equal(existsSync(join(dir, 'svc', 'tenants', 'beta', 'leases')), true);
    // Bearer tokens never cross a network in plain text, and never sit in a URL.
    await assert.rejects(startControlService({ root: join(dir, 'x'), host: '0.0.0.0', tenants: [{ id: 'acme', tokenSha256: tokenDigest(ta) }] }), /TLS/);
    assert.throws(() => controlClient({ url: 'http://ctl.example.invalid/', token: () => ta }), /https/);
    assert.throws(() => controlClient({ url: `https://u:${ta}@ctl.example.invalid/`, token: () => ta }), /credentials/);
    await assert.rejects(startControlService({ root: join(dir, 'y'), tenants: [{ id: 'Bad Id', tokenSha256: tokenDigest(ta) }] }), /tenant id/);
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control service: cap, resource keys, budgets and fencing hold across hosts; expiry blocks and reconcile settles (ORC-12)', async () => {
  const dir = tempDir('jv-ctl-');
  const secret = token();
  let now = Date.parse('2026-09-01T00:00:00Z');
  const svc = await startControlService({ root: join(dir, 'svc'), tenants: [{ id: 'acme', tokenSha256: tokenDigest(secret) }], clock: () => now });
  try {
    const tasks = [{ id: 'a' }, { id: 'b', resourceKeys: ['db'] }, { id: 'c', resourceKeys: ['db'] }, { id: 'd' }];
    const h1 = await host(dir, 'h1', svc.url, secret, tasks, { limitMicroUsd: 3_500 });
    const h2 = await host(dir, 'h2', svc.url, secret, tasks, { limitMicroUsd: 3_500 });
    const first = await h1.authority.acquire('w1', [request('a'), request('b')], { cap: 3, nowMs: now });
    assert.deepEqual(first.granted.map((g) => g.lease.taskId), ['a', 'b']);
    // Host 2 cannot take a task host 1 holds, nor a resource key it holds, and shares the cap and budget.
    const second = await h2.authority.acquire('w1', [request('a'), request('c'), request('d'), request('b')], { cap: 3, nowMs: now });
    assert.deepEqual(second.granted.map((g) => g.lease.taskId), ['d']);
    assert.deepEqual(Object.fromEntries(second.refused.map((r) => [r.taskId, r.reasonCode])), { a: 'ALREADY_LEASED', c: 'RESOURCE_BUSY', b: 'ALREADY_LEASED' });
    const over = await h2.authority.acquire('w1', [request('c')], { cap: 9, nowMs: now });
    assert.equal(over.refused[0].reasonCode, 'RESOURCE_BUSY');
    const capped = await h2.authority.acquire('w1', [request('x')], { cap: 3, nowMs: now });
    assert.equal(capped.refused[0].reasonCode, 'UNKNOWN_TASK');
    h2.port.rows.set('x', { state: 'ready', rootBudgetId: 'b1', resourceKeys: [], leaseId: null });
    assert.equal((await h2.authority.acquire('w1', [request('x')], { cap: 3, nowMs: now })).refused[0].reasonCode, 'CAP_REACHED');
    // Fencing: host 1's token publishes; after expiry and a re-lease, the old token is stale.
    const leaseA = first.granted[0].lease;
    assert.deepEqual(await h1.authority.publishFenced('w1', 'a', leaseA.fencingToken, (tx) => (tx.put('marks', 'a', 1), 'wrote'), now), { ok: true, value: 'wrote' });
    assert.equal(h1.ledger.get('marks', 'a'), 1);
    assert.equal((await h1.authority.heartbeat('w1', leaseA.id, leaseA.fencingToken, now)).ok, true);
    now += 10 * 60_000;
    const expired = await h1.authority.sweep('w1', now, () => 'alive');
    assert.equal(expired.length, 3);
    assert.equal(h1.port.rows.get('a').state, 'blocked');
    assert.equal((await h1.authority.publishFenced('w1', 'a', leaseA.fencingToken, () => 'late', now)).ok, false);
    assert.equal((await h1.authority.reconcile('w1', 'a', { spentMicroUsd: 400, resume: true }, now)).ok, true);
    assert.equal(h1.port.rows.get('a').state, 'ready');
    const again = await h1.authority.acquire('w1', [request('a')], { cap: 3, nowMs: now });
    assert.equal(again.granted[0].lease.fencingToken, leaseA.fencingToken + 1);
    assert.equal((await h1.authority.publishFenced('w1', 'a', leaseA.fencingToken, () => 'stale', now)).reasonCode, 'STALE_TOKEN');
    // Budget: uncertain reservations count in full, so the shared budget refuses more work.
    const budget = await h2.authority.acquire('w1', [request('c', { reserveMicroUsd: 1_000 })], { cap: 9, nowMs: now });
    assert.equal(budget.refused[0]?.reasonCode, 'OVER_BUDGET');
    // A later budget decision on either host reaches the service (the later revision wins).
    await h2.ledger.transact((tx) => tx.put('budgets', 'b1', { ...h2.ledger.get('budgets', 'b1'), limitMicroUsd: 50_000, updatedAtMs: Date.now() + 1 }));
    const raised = await h2.authority.acquire('w1', [request('c')], { cap: 9, nowMs: now });
    assert.deepEqual([raised.granted.length, raised.refused], [1, []]);
    // A dead holder on the calling host is expired at once; other hosts' holders wait for their TTL.
    // (Host 2 has not swept, so its copy of d still says leased; its own sweep would block it.)
    assert.equal(h2.port.rows.get('d').state, 'leased');
    h2.port.rows.set('e', { state: 'ready', rootBudgetId: 'b1', resourceKeys: [], leaseId: null });
    const d = await h2.authority.acquire('w1', [request('e', { holder: { hostId: 'h-h2', pid: 7, startedAtMs: 7, sessionId: null } })], { cap: 9, nowMs: now });
    assert.equal(d.granted.length, 1);
    assert.deepEqual(await h1.authority.sweep('w1', now, () => 'dead'), []);
    assert.deepEqual(await h2.authority.sweep('w1', now, (h) => (h.pid === 7 ? 'dead' : 'alive')), [d.granted[0].lease.id]);
    assert.equal(h2.port.rows.get('e').state, 'blocked');
    assert.equal(h2.port.rows.get('d').state, 'blocked', 'the orphaned local lease is blocked for reconciliation');
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control service: a dead holder stamped with this machine\'s earlier host-name id is still this host\'s to sweep; another machine\'s is left to its TTL (DATA-10)', async () => {
  const dir = tempDir('jv-ctl-legacy-');
  const secret = token();
  const now = Date.parse('2026-09-01T00:00:00Z');
  const svc = await startControlService({ root: join(dir, 'svc'), tenants: [{ id: 'acme', tokenSha256: tokenDigest(secret) }], clock: () => now });
  try {
    const ledger = openLedger(join(dir, 'h'));
    await setBudget(ledger, { id: 'b1', workspaceId: 'w1', ownerId: 'alice', shutdownReserveMicroUsd: 0, policy: 'finish-running', limitMicroUsd: 10_000_000 });
    const port = memoryPort([{ id: 'old' }, { id: 'theirs' }, { id: 'new' }]);
    // No hostId option: the authority is this machine (the stable id, and its earlier names).
    const authority = remoteLeaseAuthority({ client: controlClient({ url: svc.url, token: () => secret, timeoutMs: CLIENT_TIMEOUT_MS }), ledger, tasksFor: () => port });
    const mine = { hostId: legacyHostId(hostname()), pid: 7, startedAtMs: 7, sessionId: null };
    const theirs = { hostId: legacyHostId('someone-elses-box'), pid: 8, startedAtMs: 8, sessionId: null };
    const current = { hostId: hostIdentity(), pid: 9, startedAtMs: 9, sessionId: null };
    const got = await authority.acquire('w1', [request('old', { holder: mine }), request('theirs', { holder: theirs }), request('new', { holder: current })], { cap: 9, nowMs: now });
    assert.equal(got.granted.length, 3);
    const byTask = Object.fromEntries(got.granted.map((g) => [g.lease.taskId, g.lease.id]));
    const swept = await authority.sweep('w1', now, () => 'dead');
    assert.deepEqual([...swept].sort(), [byTask.old, byTask.new].sort());
    assert.deepEqual([port.rows.get('old').state, port.rows.get('new').state, port.rows.get('theirs').state], ['blocked', 'blocked', 'leased']);
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control service: several processes contend for one plan and the service grants each task once within the cap (ORC-12)', async () => {
  const dir = tempDir('jv-ctl-');
  const secret = token();
  // The service runs in its own process too.
  const svcProc = guardStdin(spawn(
    process.execPath,
    ['--input-type=module', '-e', `import { startControlService } from ${JSON.stringify(DIST)}; const c = JSON.parse(process.env.CTL); const s = await startControlService({ root: c.root, tenants: [{ id: 'acme', tokenSha256: c.digest }] }); process.stdout.write(s.url + '\\n'); process.stdin.on('end', () => s.close().then(() => process.exit(0))); process.stdin.resume();`],
    { env: { ...process.env, CTL: JSON.stringify({ root: join(dir, 'svc'), digest: tokenDigest(secret) }) }, stdio: ['pipe', 'pipe', 'inherit'] },
  ));
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      svcProc.stdout.on('data', (c) => {
        out += c;
        if (out.includes('\n')) resolve(out.trim());
      });
      svcProc.on('exit', () => reject(new Error('service exited')));
    });
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const child = (n) =>
      new Promise((resolve, reject) => {
        const p = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { controlClient, openLedger, remoteLeaseAuthority, setBudget } from ${JSON.stringify(DIST)};
             const c = JSON.parse(process.env.CTL);
             const ledger = openLedger(c.ledger);
             await setBudget(ledger, { id: 'b1', workspaceId: 'w1', ownerId: 'alice', limitMicroUsd: 1e9, shutdownReserveMicroUsd: 0, policy: 'finish-running' });
             const rows = new Map(c.ids.map((id) => [id, { state: 'ready', leaseId: null }]));
             const port = { get: (id) => rows.has(id) ? { node: { state: rows.get(id).state, rootBudgetId: 'b1' }, resourceKeys: id === 't5' || id === 't6' ? ['db'] : [] } : undefined,
               leased: (id, leaseId) => (rows.set(id, { state: 'leased', leaseId }), true), expired: () => false, reconciled: () => ({ ok: true }), holding: () => [] };
             const authority = remoteLeaseAuthority({ client: controlClient({ url: c.url, token: () => process.env.CTL_TOKEN, timeoutMs: 120000 }), ledger, tasksFor: () => port, hostId: c.host });
             const got = await authority.acquire('w1', c.ids.map((taskId) => ({ taskId, ownerId: 'alice', worktreeId: 'wt-' + taskId, reserveMicroUsd: 10, holder: { hostId: c.host, pid: process.pid, startedAtMs: null, sessionId: null } })), { cap: 4, nowMs: Date.now() });
             process.stdout.write(JSON.stringify({ granted: got.granted.map((g) => g.lease.taskId), refused: got.refused.map((r) => r.reasonCode) }));`,
          ],
          { env: { ...process.env, CTL: JSON.stringify({ url, ids, ledger: join(dir, `host-${n}`), host: `h-${n}` }), CTL_TOKEN: secret }, stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let out = '';
        p.stdout.on('data', (c) => (out += c));
        p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`client ${n} exited ${code}`))));
      });
    const results = await Promise.all([1, 2, 3, 4].map(child));
    const granted = results.flatMap((r) => r.granted);
    assert.equal(granted.length, 4, 'the tenant-wide cap holds across processes');
    assert.equal(new Set(granted).size, granted.length, 'no task is granted twice');
    assert.ok(!(granted.includes('t5') && granted.includes('t6')), 'one holder per resource key');
    assert.ok(results.flatMap((r) => r.refused).every((c) => ['ALREADY_LEASED', 'CAP_REACHED', 'RESOURCE_BUSY'].includes(c)));
    const client = controlClient({ url, token: () => secret, timeoutMs: CLIENT_TIMEOUT_MS });
    assert.equal((await client.call('leases', { workspaceId: 'w1' })).result.active.length, 4);
  } finally {
    svcProc.stdin.end();
    await new Promise((r) => (svcProc.exitCode === null ? svcProc.on('exit', r) : r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control service: a configured host schedules through it; a workspace migrates once from the CLI and the local authority then refuses (ORC-12)', async () => {
  const dir = tempDir('jv-ctl-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const store = testStore(dir);
  const secret = token();
  const svc = await startControlService({ root: join(dir, 'svc'), tenants: [{ id: 'acme', tokenSha256: tokenDigest(secret) }, { id: 'other', tokenSha256: tokenDigest(token()) }] });
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const call = (op, body, client = 'cli') => sidecarOps.find((o) => o.op === op).handle({
      op, client, scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
    });
    const status = async () => (await call('control.status', {})).body;
    const bRequest = [{ taskId: 'b', ownerId: 'alice', worktreeId: 'wt-b', reserveMicroUsd: 1, holder: selfIdentity() }];
    const task = (id) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}`] });
    await submitPlan(ws, { tasks: [task('a'), task('b')], ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 10_000_000 }, requireApprovedChecks: false });
    // A single-host lease exists before the move.
    assert.equal((await status()).reasonCode, 'SINGLE_HOST');
    const local = leaseAuthorityFor(ws);
    assert.equal((await scheduleTasks(ws, { authority: local, holder: selfIdentity(), only: ['a'] })).leased.length, 1);
    const leaseA = local.activeLeases(ws.workspaceId)[0].lease;
    // Settings name a token file; a file others can read is refused (POSIX modes; Windows checks the ACL).
    const tokenFile = join(dir, 'secrets', 'control-token');
    const settings = (extra = {}) => writeFileSync(join(ws.configDir, 'control.json'), JSON.stringify({ schemaVersion: CONTROL_CLIENT_SCHEMA, url: svc.url, tokenFile, ...extra }));
    mkdirSync(ws.configDir, { recursive: true });
    if (process.platform !== 'win32') {
      mkdirSync(join(dir, 'secrets'));
      writeFileSync(tokenFile, secret, { mode: 0o644 });
      chmodSync(tokenFile, 0o644);
      settings({ rev: 1 });
      assert.equal((await status()).reasonCode, 'CONTROL_TOKEN_UNUSABLE');
      assert.equal((await leaseAuthorityFor(ws).acquire(ws.workspaceId, bRequest, { cap: 2, nowMs: Date.now() })).refused[0].reasonCode, 'CONTROL_UNAVAILABLE');
      rmSync(tokenFile);
    }
    assert.equal((await writePrivateFile(tokenFile, secret)).ok, true);
    settings({ rev: 2 });
    const reachable = await status();
    assert.deepEqual([reachable.reasonCode, reachable.reachable, reachable.url], ['CONTROL_SERVICE', true, svc.url]);
    assert.doesNotMatch(JSON.stringify(reachable), new RegExp(secret), 'the token never appears in an answer');
    // Migration is a person's CLI act, once.
    assert.equal((await call('control.migrate', { actor: 'alice' }, 'mcp')).reasonCode, 'CLI_ONLY');
    const moved = await call('control.migrate', { actor: 'alice' });
    assert.deepEqual([moved.body.migrated, moved.body.imported.leases, moved.body.imported.budgets], [true, 1, 1]);
    assert.equal((await call('control.migrate', { actor: 'alice' })).body.reasonCode, 'ALREADY_MIGRATED');
    // Without control settings the moved workspace leases nothing locally.
    rmSync(join(ws.configDir, 'control.json'));
    assert.equal((await status()).reasonCode, 'CONTROL_SERVICE_REQUIRED');
    assert.equal((await leaseAuthorityFor(ws).acquire(ws.workspaceId, bRequest, { cap: 2, nowMs: Date.now() })).refused[0].reasonCode, 'CONTROL_SERVICE_REQUIRED');
    // Unusable settings refuse too; they never fall back to a host-local authority.
    settings({ tokenFile: 'relative' });
    assert.equal((await status()).reasonCode, 'CONTROL_SETTINGS_UNUSABLE');
    assert.equal((await leaseAuthorityFor(ws).acquire(ws.workspaceId, bRequest, { cap: 2, nowMs: Date.now() })).refused[0].reasonCode, 'CONTROL_UNAVAILABLE');
    // Configured: the scheduler leases through the service, and the migrated lease still holds.
    settings({ rev: 3 });
    const remote = leaseAuthorityFor(ws);
    assert.equal((await remote.heartbeat(ws.workspaceId, leaseA.id, leaseA.fencingToken, Date.now())).ok, true);
    const after = await scheduleTasks(ws, { authority: remote, holder: selfIdentity(), only: ['b'] });
    assert.equal(after.leased.length, 1);
    assert.equal(getTask(ws, 'b').node.state, 'leased');
    assert.equal(remote.activeLeases(ws.workspaceId).length, 2);
    // The migrated state cannot be imported twice, even from a copy of the host ledger.
    const client = controlClient({ url: svc.url, token: () => secret, timeoutMs: CLIENT_TIMEOUT_MS });
    const copy = { ...ws, host: { ...ws.host, get: (c, id) => (c === 'control-migrations' ? undefined : ws.host.get(c, id)) } };
    assert.equal((await migrateToControlService(copy, client)).reasonCode, 'IMPORT_CONFLICT');
    // The single-host ledger stays as it was: the service holds its own copy.
    assert.equal(ledgerLeaseAuthority(ws.host, () => undefined).activeLeases(ws.workspaceId).length, 1);
    assert.match(hostIdentity(), /^(?:m[0-9a-f]{24}|h-[0-9a-f]{16})$/);
  } finally {
    await svc.close();
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Containers (opt-in): JEVRIS_TEST_DOCKER_IMAGE=node:22-bookworm-slim runs two client containers
// against a service container on a private Docker network. Skipped unless Docker and the image
// variable are present.
const image = process.env.JEVRIS_TEST_DOCKER_IMAGE;
const docker = image !== undefined && image !== '' && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
test('control service: containers on a private network share one lease authority (ORC-12, opt-in)', { skip: docker ? false : 'set JEVRIS_TEST_DOCKER_IMAGE and run Docker to exercise containers' }, async () => {
  const net = `jv-ctl-${randomBytes(4).toString('hex')}`;
  const secret = token();
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const run = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
  assert.equal(run(['network', 'create', net]).status, 0);
  try {
    const svcScript = `import('/repo/packages/orchestrator/dist/index.js').then(async (m) => { await m.startControlService({ root: '/tmp/svc', host: '0.0.0.0', port: 7443, allowPlaintext: true, tenants: [{ id: 'acme', tokenSha256: process.env.DIGEST }] }); })`;
    assert.equal(run(['run', '-d', '--rm', '--name', `${net}-svc`, '--network', net, '-v', `${repoRoot}:/repo:ro`, '-e', `DIGEST=${tokenDigest(secret)}`, image, 'node', '-e', svcScript]).status, 0);
    const clientScript = `import('/repo/packages/orchestrator/dist/index.js').then(async (m) => {
      const ledger = m.openLedger('/tmp/host'); await m.setBudget(ledger, { id: 'b1', workspaceId: 'w1', ownerId: 'a', limitMicroUsd: 1e9, shutdownReserveMicroUsd: 0, policy: 'finish-running' });
      const rows = new Map(['t1','t2','t3'].map((id) => [id, 'ready']));
      const port = { get: (id) => ({ node: { state: rows.get(id), rootBudgetId: 'b1' }, resourceKeys: [] }), leased: (id) => (rows.set(id, 'leased'), true), expired: () => false, reconciled: () => ({ ok: true }), holding: () => [] };
      for (let i = 0; i < 50; i++) { const h = await fetch('http://${net}-svc:7443/v1/health').catch(() => null); if (h) break; await new Promise((r) => setTimeout(r, 200)); }
      const a = m.remoteLeaseAuthority({ client: m.controlClient({ url: 'http://${net}-svc:7443/', token: () => process.env.CTL_TOKEN, allowPlaintext: true }), ledger, tasksFor: () => port, hostId: process.env.HOSTNAME });
      const got = await a.acquire('w1', ['t1','t2','t3'].map((taskId) => ({ taskId, ownerId: 'a', worktreeId: 'w', reserveMicroUsd: 1, holder: { hostId: process.env.HOSTNAME, pid: 1, startedAtMs: null, sessionId: null } })), { cap: 2, nowMs: Date.now() });
      console.log(JSON.stringify(got.granted.map((g) => g.lease.taskId)));
    })`;
    // Both client containers run at once.
    const runAsync = (args) =>
      new Promise((resolve) => {
        const p = spawn('docker', args, { env: { ...process.env, CTL_TOKEN: secret }, stdio: ['ignore', 'pipe', 'inherit'] });
        let stdout = '';
        p.stdout.on('data', (c) => (stdout += c));
        p.on('exit', (status) => resolve({ status, stdout }));
      });
    const outs = await Promise.all([1, 2].map(() => runAsync(['run', '--rm', '--network', net, '-v', `${repoRoot}:/repo:ro`, '-e', 'CTL_TOKEN', image, 'node', '-e', clientScript])));
    assert.deepEqual(outs.map((o) => o.status), [0, 0]);
    const granted = outs.flatMap((o) => JSON.parse(o.stdout.trim().split('\n').pop()));
    assert.equal(granted.length, 2);
    assert.equal(new Set(granted).size, 2);
  } finally {
    run(['rm', '-f', `${net}-svc`]);
    run(['network', 'rm', net]);
  }
});
