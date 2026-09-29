import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// DATA-10: the store's host scope comes from the stable machine id, not the host name, which
// on macOS follows the network. A store stamped by the earlier host-name formula for one of
// this machine's names is re-stamped on open; any other scope stays refused. The machine id
// and the host names are injected; no test runs ioreg, reg.exe or scutil.

const {
  hostScopeForStore,
  hostScopeId,
  hostScopeInfo,
  legacyHostScopeId,
  legacyHostScopes,
  ownStoreRefusedMessage,
  sidecarRequest,
  startDaemon,
  storeBelongsHere,
} = await import('../dist/index.js');
const { adoptStoreHostScope, backupStore, checkBackup, closeStore, openStore, readAudit, restoreStore } = await import('@jevris/store');
const { jevrisPaths } = await import('@jevris/platform');
const require = createRequire(import.meta.url);

const MACHINE_A = { ok: true, machineId: '4C4C4544-0042-3510-8052-B7C04F4E3732', source: 'ioplatformuuid', user: 'uid:501' };
const MACHINE_B = { ok: true, machineId: '9E0A2F11-7B7C-4E55-9D3E-1C2B3A4D5E6F', source: 'ioplatformuuid', user: 'uid:501' };
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

function tempHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-hscope-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function dbPathFor(home) {
  const data = jevrisPaths({ home }).data;
  mkdirSync(data, { recursive: true });
  return join(data, 'jevris.db');
}

/** A store created and closed under `scope`, as an earlier Jevris would have left it. */
function stampedStore(dbPath, scope) {
  const opened = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope: scope });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  closeStore(opened);
}

function storedScope(path) {
  const Database = require('better-sqlite3');
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT host_scope FROM schema_meta WHERE id = 1').get().host_scope;
  } finally {
    db.close();
  }
}

/** Ports for machine A that was called `names[0]` and is now called `now`. */
function ports(names, now = names[0], machine = MACHINE_A) {
  return { machine: () => machine, hostname: () => now, hostnames: () => names, platform: 'darwin' };
}

test('the scope is stable across host-name changes and differs by machine, user and home (DATA-10)', (t) => {
  const home = tempHome(t);
  const other = tempHome(t);
  const before = hostScopeId(home, ports(['Devs-Macbook-Pro.local']));
  const after = hostScopeId(home, ports(['dhcp-10-0-0-7.example.net']));
  assert.match(before, /^h[0-9a-f]{24}$/);
  assert.equal(after, before, 'a network name change keeps the scope');
  assert.notEqual(hostScopeId(home, ports(['x'], 'x', MACHINE_B)), before, 'another machine id');
  assert.notEqual(hostScopeId(home, ports(['x'], 'x', { ...MACHINE_A, user: 'uid:502' })), before, 'another user');
  assert.notEqual(hostScopeId(other, ports(['x'])), before, 'another home');
  assert.notEqual(before, legacyHostScopeId(home, 'Devs-Macbook-Pro.local', 'darwin'), 'never the host-name formula');
  assert.deepEqual(hostScopeInfo(home, ports(['x'])), { scope: before, source: 'machine-id', reason: null });
  // The scope is a hash: the raw id never appears in it.
  assert.equal(before.includes('4C4C4544'), false);
});

test('when the machine id cannot be read the scope falls back to the host-name formula (DATA-10)', (t) => {
  const home = tempHome(t);
  const unreadable = { machine: () => ({ ok: false, reason: 'machine-id-unreadable' }), hostname: () => 'box', platform: 'linux' };
  assert.deepEqual(hostScopeInfo(home, unreadable), { scope: legacyHostScopeId(home, 'box', 'linux'), source: 'host-name', reason: 'machine-id-unreadable' });
  // The formula is the one earlier releases used: host name, platform, real home.
  const { createHash } = require('node:crypto');
  assert.equal(legacyHostScopeId(home, 'box', 'linux'), `h${createHash('sha256').update(`box\0linux\0${home}`).digest('hex').slice(0, 24)}`);
  // Under JEVRIS_TEST the default reader is the test machine, never a system query.
  assert.equal(hostScopeInfo(home).source, 'machine-id');
});

test('a store stamped under an earlier host name of this machine is re-stamped on open (DATA-10)', (t) => {
  const home = tempHome(t);
  const dbPath = dbPathFor(home);
  const names = ['dhcp-10-0-0-7.example.net', 'Devs-Macbook-Pro', 'Devs-Macbook-Pro.local'];
  stampedStore(dbPath, legacyHostScopeId(home, 'Devs-Macbook-Pro.local', 'darwin'));
  const target = hostScopeForStore(home, dbPath, ports(names, names[0]));

  const opened = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', ...target });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.hostScopeMigrated, true);
  assert.equal(opened.hostScope, target.hostScope);
  closeStore(opened);
  assert.equal(storedScope(dbPath), target.hostScope);

  // Next open: the scope matches, nothing to migrate, and no candidate lookup is needed.
  let asked = 0;
  const again = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope: target.hostScope, adoptHostScopes: () => (asked += 1, []) });
  assert.equal(again.ok, true);
  assert.equal(again.hostScopeMigrated, undefined);
  assert.equal(asked, 0);
  closeStore(again);
});

test('a store under a scope that matches none of this machine\'s names stays refused (DATA-10)', (t) => {
  const home = tempHome(t);
  const dbPath = dbPathFor(home);
  const foreign = legacyHostScopeId(home, 'someone-elses-mac.local', 'darwin');
  stampedStore(dbPath, foreign);
  const refused = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', ...hostScopeForStore(home, dbPath, ports(['Devs-Macbook-Pro.local'])) });
  assert.deepEqual(refused, { ok: false, reason: 'host-scope-mismatch' });
  assert.equal(storedScope(dbPath), foreign, 'nothing was written');

  // Another machine's stable scope is refused too, even with every local name listed.
  const home2 = tempHome(t);
  const db2 = dbPathFor(home2);
  stampedStore(db2, hostScopeId(home2, ports(['x'], 'x', MACHINE_B)));
  const other = openStore({ path: db2, role: 'sidecar', workspaceId: 'host', ...hostScopeForStore(home2, db2, ports(['x'])) });
  assert.deepEqual(other, { ok: false, reason: 'host-scope-mismatch' });
});

test('adoption needs a file owned by this user inside this home (DATA-10)', { skip: UID === null ? 'POSIX uid' : false }, (t) => {
  const home = tempHome(t);
  const dbPath = dbPathFor(home);
  stampedStore(dbPath, legacyHostScopeId(home, 'mac.local', 'darwin'));
  assert.equal(storeBelongsHere(home, dbPath, { uid: UID }), true);
  assert.equal(storeBelongsHere(home, dbPath, { uid: UID + 1 }), false, 'another uid');
  const outside = tempHome(t);
  const copy = join(outside, 'jevris.db');
  copyFileSync(dbPath, copy);
  assert.equal(storeBelongsHere(home, copy, { uid: UID }), false, 'not in this home');
  assert.equal(storeBelongsHere(home, join(home, 'missing.db'), { uid: UID }), false);

  const refused = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', ...hostScopeForStore(home, dbPath, { ...ports(['mac.local']), uid: UID + 1 }) });
  assert.deepEqual(refused, { ok: false, reason: 'host-scope-mismatch' });
});

test('the default host-name candidates include os.hostname() (DATA-10)', (t) => {
  const home = tempHome(t);
  assert.equal(legacyHostScopes(home).includes(legacyHostScopeId(home, hostname())), true);
});

test('a backup under an earlier host-name scope restores with this machine\'s scope; a foreign one is refused (DATA-10)', async (t) => {
  const home = tempHome(t);
  const dbPath = dbPathFor(home);
  const legacy = legacyHostScopeId(home, 'mac.local', 'darwin');
  const opened = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope: legacy });
  assert.equal(opened.ok, true);
  const backup = join(home, 'before.db');
  assert.equal((await backupStore(opened, backup, { nowMs: 1 })).ok, true);
  closeStore(opened);

  const p = ports(['mac.local']);
  const target = hostScopeId(home, p);
  assert.deepEqual(checkBackup(backup, target), { ok: false, reason: 'backup-foreign-host' });
  const earlier = legacyHostScopes(home, p);
  assert.equal(checkBackup(backup, target, earlier).ok, true);
  assert.deepEqual(restoreStore({ backupPath: backup, dbPath, hostScope: target, nowMs: 2 }), { ok: false, reason: 'backup-foreign-host' });

  const restored = restoreStore({ backupPath: backup, dbPath, hostScope: target, nowMs: 3, adoptHostScopes: earlier });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(storedScope(dbPath), target, 'installed with this machine\'s scope');
  assert.equal(storedScope(backup), legacy, 'the backup itself is unchanged');
  const reopened = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope: target });
  assert.equal(reopened.ok, true);
  closeStore(reopened);
});

test('store adopt re-stamps any scope once, audits it, and refuses a busy store (DATA-10)', (t) => {
  const home = tempHome(t);
  const dbPath = dbPathFor(home);
  stampedStore(dbPath, 'hunknown00000000000000000');
  const target = hostScopeId(home, ports(['x']));

  const held = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope: 'hunknown00000000000000000' });
  assert.equal(held.ok, true);
  assert.equal(adoptStoreHostScope({ dbPath, hostScope: target, nowMs: 5, actor: 'ada' }).reason, 'writer-busy');
  closeStore(held);

  assert.deepEqual(adoptStoreHostScope({ dbPath, hostScope: target, nowMs: 6, actor: 'ada' }), { ok: true, changed: true, schemaVersion: held.schemaVersion });
  assert.equal(storedScope(dbPath), target);
  assert.equal(existsSync(`${dbPath}.writer`), false, 'the lock is released');
  assert.deepEqual(adoptStoreHostScope({ dbPath, hostScope: target, nowMs: 7, actor: 'ada' }), { ok: true, changed: false, schemaVersion: held.schemaVersion });

  const opened = openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope: target });
  assert.equal(opened.ok, true);
  const rows = readAudit(opened, { kinds: ['store.adopt'] });
  assert.equal(rows.length, 1);
  assert.deepEqual({ actor: rows[0].actor, channel: rows[0].channel, reasonCode: rows[0].detail.reasonCode }, { actor: 'ada', channel: 'terminal', reasonCode: 'HOST_SCOPE_ADOPTED' });
  closeStore(opened);

  assert.equal(adoptStoreHostScope({ dbPath: join(home, 'none.db'), hostScope: target, nowMs: 8, actor: 'ada' }).reason, 'not-found');
  const junk = join(home, 'junk.db');
  writeFileSync(junk, 'not a database');
  assert.equal(adoptStoreHostScope({ dbPath: junk, hostScope: target, nowMs: 9, actor: 'ada' }).reason, 'store-corrupt');
});

test('the sidecar migrates a legacy store on start and names the fix for its own refused store (DATA-10)', async (t) => {
  const home = tempHome(t);
  const dbPath = dbPathFor(home);
  // Stamped by an earlier Jevris under this machine's current name.
  stampedStore(dbPath, legacyHostScopeId(home, hostname()));
  const logs = [];
  let started = await startDaemon({ home, packageOps: false, idleMs: 0, log: (entry) => logs.push(entry) });
  assert.equal(started.ok, true);
  try {
    const health = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(health.result.store.state, 'ok', JSON.stringify(health.result.store));
    assert.equal(logs.filter((entry) => entry.event === 'store-host-scope' && entry.reasonCode === 'HOST_SCOPE_MIGRATED').length, 1);
  } finally {
    await started.daemon.stop('test');
  }
  assert.equal(storedScope(dbPath), hostScopeId(home));

  // A scope no name of this machine explains: refused, with the adopt and move-aside steps.
  rmSync(dbPath, { force: true });
  stampedStore(dbPath, 'hunknown00000000000000000');
  started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true);
  try {
    const health = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(health.result.store.state, 'unavailable');
    const text = health.result.store.diagnostic;
    assert.match(text, /earlier network name of this machine/);
    assert.match(text, /`jevris store adopt`/);
    assert.equal(text.includes(`${dbPath}.refused-`), true);
    assert.match(text, /`jevris sidecar stop`.*`jevris sidecar start`/);
  } finally {
    await started.daemon.stop('test');
  }
});

test('the refused-store message names the dated move-aside path (DATA-10)', () => {
  const text = ownStoreRefusedMessage('/home/ada/.jevris/jevris.db', Date.UTC(2026, 8, 26));
  assert.match(text, /move \/home\/ada\/\.jevris\/jevris\.db \(and any -wal and -shm file beside it\) to \/home\/ada\/\.jevris\/jevris\.db\.refused-2026-09-26/);
  assert.equal(text.includes('\n'), false);
});
