import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const INDEX = new URL('../dist/index.js', import.meta.url);
const store = await import(INDEX.href);
const {
  openStore,
  closeStore,
  commitOwned,
  readCommitted,
  automationRefusedGuard,
  latestSchemaVersion,
  migrations,
  migrationChecksum,
  planMigrations,
  filesystemKind,
  parseDarwinMounts,
  readDiagnostic,
  diagnosticPath,
  writerLockPath,
  storeFault,
} = store;
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dirs = [];
function tempDir() {
  const dir = makeTempDir('jevris-store-life-');
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

const LOCAL = () => ({ kind: 'local', label: 'test' });

function open(path, extra = {}) {
  return openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: LOCAL, ...extra });
}

function raw(path) {
  const db = new Database(path);
  db.defaultSafeIntegers(true);
  return db;
}

/** A database as v0.1 made it: schema 1, no schema_migrations table. */
function legacyDatabase(path) {
  const db = raw(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, package_label TEXT NOT NULL, host_scope TEXT NOT NULL);
    CREATE TABLE decision_row (workspace_id TEXT NOT NULL, decision_id TEXT NOT NULL, operation_id TEXT NOT NULL, reservation_micro_usd INTEGER NOT NULL, PRIMARY KEY (workspace_id, decision_id), UNIQUE (workspace_id, operation_id));
    CREATE TABLE proposed_action (workspace_id TEXT NOT NULL, decision_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY (workspace_id, decision_id));
    CREATE TABLE outbox_entry (workspace_id TEXT NOT NULL, decision_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY (workspace_id, decision_id));
    INSERT INTO schema_meta VALUES (1, 1, '0.1.0', 'hostA');
    INSERT INTO decision_row VALUES ('host', 'decOld', 'opOld', 42);
    INSERT INTO proposed_action VALUES ('host', 'decOld', 'opOld');
    INSERT INTO outbox_entry VALUES ('host', 'decOld', 'opOld');
  `);
  db.close();
}

test('a fresh store records every migration with its checksum and a schema version past 1 (DATA-01)', () => {
  const path = join(tempDir(), 'jevris.db');
  const opened = open(path);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.ok(latestSchemaVersion() > 1);
  assert.equal(opened.schemaVersion, latestSchemaVersion());
  assert.equal(opened.packageVersion, '0.1.0');
  closeStore(opened);
  const db = raw(path);
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map((r) => Number(r.version)), migrations().map((m) => m.version));
  for (const row of rows) {
    const migration = migrations().find((m) => m.version === Number(row.version));
    assert.equal(row.checksum, migrationChecksum(migration));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_lock').get().n, 0n);
  db.close();
});

test('a v0.1 store migrates in place, keeps its rows, and a dry run lists the plan without writing (DATA-01)', () => {
  const path = join(tempDir(), 'jevris.db');
  legacyDatabase(path);
  const before = raw(path);
  const plan = planMigrations(before);
  assert.equal(plan.ok, true);
  assert.equal(plan.currentVersion, 1);
  assert.equal(plan.targetVersion, latestSchemaVersion());
  assert.deepEqual(plan.pending.map((p) => p.version), migrations().map((m) => m.version));
  assert.equal(before.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 0n);
  before.close();

  const opened = open(path);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.schemaVersion, latestSchemaVersion());
  const kept = readCommitted(opened, 'decOld');
  assert.equal(kept.reservationMicroUsd, 42n);
  assert.deepEqual(commitOwned(opened, { decisionId: 'decNew', operationId: 'opNew', reservationMicroUsd: 1n }), { ok: true });
  closeStore(opened);
});

test('a newer schema is refused and never written (DATA-01)', () => {
  const path = join(tempDir(), 'jevris.db');
  const opened = open(path);
  closeStore(opened);
  const db = raw(path);
  db.prepare('UPDATE schema_meta SET schema_version = ? WHERE id = 1').run(BigInt(latestSchemaVersion() + 1));
  db.close();
  const before = readFileSync(path);
  assert.deepEqual(open(path), { ok: false, reason: 'schema-newer' });
  assert.deepEqual(readFileSync(path), before);
});

test('a changed migration stops owned automation instead of running on it (DATA-01)', () => {
  const path = join(tempDir(), 'jevris.db');
  closeStore(open(path));
  const db = raw(path);
  db.prepare("UPDATE schema_migrations SET checksum = 'x' WHERE version = 2").run();
  db.close();
  const opened = open(path);
  assert.equal(opened.ok, true);
  assert.deepEqual(automationRefusedGuard(opened), { ok: false, reason: 'migration-refused' });
  assert.deepEqual(commitOwned(opened, { decisionId: 'd1', operationId: 'o1', reservationMicroUsd: 1n }), { ok: false, reason: 'migration-refused' });
  closeStore(opened);
});

test('a destructive migration writes an owner-only VACUUM INTO backup first (DATA-01)', () => {
  const path = join(tempDir(), 'jevris.db');
  const first = open(path);
  commitOwned(first, { decisionId: 'decKeep', operationId: 'opKeep', reservationMicroUsd: 7n });
  closeStore(first);
  const list = [...migrations(), { version: latestSchemaVersion() + 1, name: 'drop-proposed', sql: 'CREATE TABLE IF NOT EXISTS x_new (a TEXT);', destructive: true }];
  const opened = open(path, { migration: { list } });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.schemaVersion, latestSchemaVersion() + 1);
  closeStore(opened);
  const dir = join(path, '..');
  const backups = readdirSync(dir).filter((n) => n.includes('.pre-v'));
  assert.equal(backups.length, 1);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, backups[0])).mode & 0o777, 0o600);
  const copy = raw(join(dir, backups[0]));
  assert.equal(copy.prepare("SELECT reservation_micro_usd AS r FROM decision_row WHERE decision_id = 'decKeep'").get().r, 7n);
  assert.equal(Number(copy.prepare('SELECT schema_version AS v FROM schema_meta').get().v), latestSchemaVersion());
  copy.close();
});

test('a process killed mid-migration leaves the old version and the next open resumes (DATA-01)', async () => {
  const path = join(tempDir(), 'jevris.db');
  legacyDatabase(path);
  const script = `
    const s = await import(${JSON.stringify(INDEX.href)});
    s.openStore({ path: ${JSON.stringify(path)}, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }),
      migration: { beforeCommit: (v) => { if (v === 3) process.kill(process.pid, 'SIGKILL'); } } });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  // Windows has no signals: process.kill ends the process with TerminateProcess and exit code 1,
  // which spawnSync reports as status 1 with no signal. The kill is just as abrupt.
  if (process.platform === 'win32') assert.deepEqual([child.status, child.signal], [1, null], child.stderr);
  else assert.equal(child.signal, 'SIGKILL', child.stderr);
  const mid = raw(path);
  assert.deepEqual(mid.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version)), [1, 2]);
  assert.equal(Number(mid.prepare('SELECT schema_version AS v FROM schema_meta').get().v), 2);
  assert.equal(mid.prepare('SELECT COUNT(*) AS n FROM migration_lock').get().n, 1n);
  mid.close();
  assert.equal(existsSync(writerLockPath(path)), true);

  const opened = open(path);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.schemaVersion, latestSchemaVersion());
  assert.equal(readCommitted(opened, 'decOld').reservationMicroUsd, 42n);
  assert.equal(automationRefusedGuard(opened), undefined);
  closeStore(opened);
  assert.equal(existsSync(writerLockPath(path)), false);
});

test('a live migration lock from another process refuses the open; a dead holder is taken over (DATA-01)', async () => {
  const path = join(tempDir(), 'jevris.db');
  legacyDatabase(path);
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const db = raw(path);
    db.exec('CREATE TABLE migration_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, holder_pid INTEGER NOT NULL, acquired_at_ms INTEGER NOT NULL)');
    db.prepare('INSERT INTO migration_lock VALUES (1, ?, ?, ?)').run('other', BigInt(sleeper.pid), BigInt(Date.now()));
    db.close();
    assert.deepEqual(open(path), { ok: false, reason: 'writer-busy' });
  } finally {
    sleeper.kill('SIGKILL');
    await new Promise((resolve) => sleeper.once('exit', resolve));
  }
  const opened = open(path);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  closeStore(opened);
});

test('two processes cannot both hold the writer role; a crashed holder is taken over (DATA-09)', async () => {
  const path = join(tempDir(), 'jevris.db');
  const script = `
    const s = await import(${JSON.stringify(INDEX.href)});
    const r = s.openStore({ path: ${JSON.stringify(path)}, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
    process.stdout.write(JSON.stringify({ ok: r.ok, reason: r.reason ?? null }) + '\\n');
    setTimeout(() => {}, 30000);
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise((resolve) => holder.stdout.once('data', (d) => resolve(String(d))));
  assert.deepEqual(JSON.parse(line), { ok: true, reason: null });
  const holderFile = JSON.parse(readFileSync(writerLockPath(path), 'utf8'));
  assert.equal(holderFile.pid, holder.pid);
  assert.equal(holderFile.role, 'sidecar');
  if (process.platform !== 'win32') assert.equal(statSync(writerLockPath(path)).mode & 0o777, 0o600);
  assert.deepEqual(open(path), { ok: false, reason: 'writer-busy' });
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  const opened = open(path);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(open(path), { ok: false, reason: 'writer-busy' });
  closeStore(opened);
});

test('a corrupt store is refused with a content-free diagnostic, and quick_check catches page damage (DATA-08)', () => {
  const dir = tempDir();
  const notADb = join(dir, 'header.db');
  writeFileSync(notADb, Buffer.alloc(8192, 0x41));
  assert.deepEqual(open(notADb), { ok: false, reason: 'store-corrupt' });
  const diagnostic = readDiagnostic(notADb);
  assert.equal(diagnostic.code, 'store-corrupt');
  assert.match(diagnostic.action, /jevris store restore/);
  const text = readFileSync(diagnosticPath(notADb), 'utf8');
  assert.equal(text.includes(dir), false);
  if (process.platform !== 'win32') assert.equal(statSync(diagnosticPath(notADb)).mode & 0o777, 0o600);

  const damaged = join(dir, 'pages.db');
  const good = open(damaged);
  for (let i = 0; i < 400; i += 1) commitOwned(good, { decisionId: `d${i}`, operationId: `o${i}`, reservationMicroUsd: BigInt(i) });
  closeStore(good);
  const db = raw(damaged);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  db.close();
  const size = statSync(damaged).size;
  const fd = openSync(damaged, 'r+');
  // Overwrite the cell area of the last data pages (the decision rows written above).
  for (let page = size / pageSize - 3; page < size / pageSize; page += 1) writeSync(fd, Buffer.alloc(pageSize / 2, 0xff), 0, pageSize / 2, pageSize * page + 64);
  closeSync(fd);
  const refused = open(damaged);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'store-corrupt');
  assert.equal(readDiagnostic(damaged).code, 'store-corrupt');
});

test('SQLITE_FULL stops owned automation and writes a diagnostic (DATA-08)', () => {
  const dir = tempDir();
  const path = join(dir, 'full.db');
  let handle;
  const opened = openStore({
    path,
    role: 'sidecar',
    workspaceId: 'host',
    hostScope: 'hostA',
    loadDriver: (p) => {
      handle = new Database(p);
      return handle;
    },
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const pages = Number(handle.pragma('page_count', { simple: true }));
  handle.pragma(`max_page_count = ${pages}`);
  let result;
  for (let i = 0; i < 2000; i += 1) {
    result = commitOwned(opened, { decisionId: `d${i}`, operationId: `o${i}`, reservationMicroUsd: 1n });
    if (!result.ok) break;
  }
  assert.deepEqual(result, { ok: false, reason: 'store-full' });
  assert.equal(storeFault(opened).code, 'store-full');
  assert.deepEqual(automationRefusedGuard(opened), { ok: false, reason: 'store-full' });
  assert.equal(readDiagnostic(path).code, 'store-full');
  assert.match(readDiagnostic(path).action, /Free space/);
  closeStore(opened);
});

test('a database on a network filesystem is refused on every platform (DATA-10)', () => {
  const dir = tempDir();
  assert.deepEqual(open(join(dir, 'n.db'), { fsKind: () => ({ kind: 'network', label: 'nfs' }) }), { ok: false, reason: 'network-filesystem' });
  assert.equal(existsSync(join(dir, 'n.db')), false);

  assert.equal(filesystemKind('/mnt/share', { platform: 'linux', statfsType: () => 0x6969, realpath: (p) => p }).kind, 'network');
  assert.equal(filesystemKind('/mnt/share', { platform: 'linux', statfsType: () => 0xff534d42, realpath: (p) => p }).label, 'cifs');
  assert.equal(filesystemKind('/home/u', { platform: 'linux', statfsType: () => 0xef53, realpath: (p) => p }).kind, 'local');
  assert.equal(filesystemKind('/home/u', { platform: 'linux', statfsType: () => { throw new Error('x'); }, realpath: (p) => p }).kind, 'unknown');

  const mounts = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
    '//user@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)',
    'server:/export on /Users/u/nfs (nfs, nodev, nosuid)',
  ].join('\n');
  assert.equal(parseDarwinMounts(mounts).length, 4);
  const darwin = (p) => filesystemKind(p, { platform: 'darwin', mountTable: () => mounts, realpath: (x) => x });
  assert.deepEqual(darwin('/Volumes/share/jevris'), { kind: 'network', label: 'smbfs' });
  assert.deepEqual(darwin('/Users/u/nfs/data'), { kind: 'network', label: 'nfs' });
  assert.deepEqual(darwin('/Users/u/nfsx'), { kind: 'local', label: 'apfs' });
  assert.deepEqual(darwin('/System/Volumes/Data/Users/u'), { kind: 'local', label: 'apfs' });

  const win = (p, type) => filesystemKind(p, { platform: 'win32', windowsDriveType: () => type, realpath: (x) => x });
  assert.equal(win('\\\\server\\share\\jevris', 'Fixed').kind, 'network');
  assert.equal(win('\\\\?\\UNC\\server\\share', 'Fixed').kind, 'network');
  assert.equal(win('Z:\\jevris', 'Network').kind, 'network');
  assert.equal(win('C:\\Users\\u\\AppData', 'Fixed').kind, 'local');
  assert.equal(win('\\\\?\\C:\\Users\\u', 'Fixed').kind, 'local');
  assert.equal(win('C:\\x', undefined).kind, 'unknown');

  // The real probe does not start PowerShell for the system drive: it is the boot volume.
  const saved = process.env.SystemDrive;
  process.env.SystemDrive = 'Q:';
  try {
    assert.deepEqual(filesystemKind('q:\\Users\\u', { platform: 'win32', realpath: (x) => x }), { kind: 'local', label: 'fixed' });
  } finally {
    if (saved === undefined) delete process.env.SystemDrive;
    else process.env.SystemDrive = saved;
  }
});

test('the real detector classifies this machine\'s temp directory without refusing it (DATA-10)', () => {
  const result = filesystemKind(tempDir());
  assert.notEqual(result.kind, 'network');
  const path = join(tempDir(), 'real.db');
  const opened = openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.ok(['local', 'unknown'].includes(opened.filesystem));
  closeStore(opened);
});

test('a foreign hostScope is refused before any migration writes (DATA-10)', () => {
  const path = join(tempDir(), 'jevris.db');
  legacyDatabase(path);
  const before = readFileSync(path);
  assert.deepEqual(open(path, { hostScope: 'hostB' }), { ok: false, reason: 'host-scope-mismatch' });
  assert.deepEqual(readFileSync(path), before);
  void pathToFileURL;
});
