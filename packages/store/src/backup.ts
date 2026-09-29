/**
 * Backup, restore and export (DATA-13, SSOT §16.3, §17.1).
 *
 * - `backupStore` uses the SQLite online backup API (a consistent copy while the store is
 *   open), makes the copy owner-only and runs `integrity_check` on it.
 * - `restoreStore` refuses while another process holds the writer role, refuses a backup that
 *   fails `integrity_check`, carries a foreign `hostScope` or a newer schema, then moves the
 *   current database aside and installs the backup (owner-only). The next open migrates it.
 * - `exportStoreJsonl` writes one JSON line per row of the durable tables, never the
 *   authorization MACs; integers are exact (bigint as decimal strings).
 */
import { chmodSync, closeSync, constants, copyFileSync, lstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { driverFor, restampHostScope, storeFiles } from './open.js';
import { field, num, refuse, str, write } from './access.js';
import { appendAuditRow } from './governance.js';
import { latestSchemaVersion, planMigrations } from './migrate.js';
import { immediately, readMeta, type SqlDriver } from './schema.js';
import { acquireWriterLock, releaseWriterLock, writerLockHolder } from './writer-lock.js';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

const require = createRequire(import.meta.url);

type ReadonlyDriverCtor = new (path: string, options: { readonly readonly: boolean; readonly fileMustExist: boolean }) => SqlDriver;

function openReadonly(path: string): SqlDriver {
  const loaded = require('better-sqlite3') as ReadonlyDriverCtor;
  const db = new loaded(path, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  return db;
}

function integrityOk(driver: SqlDriver): boolean {
  const rows = driver.pragma('integrity_check');
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const first: unknown = rows[0];
  return (first !== null && typeof first === 'object' ? Reflect.get(first, 'integrity_check') : first) === 'ok';
}

function privateFile(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export type BackupCheck = { readonly ok: true; readonly schemaVersion: number; readonly hostScope: string } | { readonly ok: false; readonly reason: 'backup-corrupt' | 'backup-foreign-host' | 'schema-newer' | 'backup-unreadable' };

/**
 * Checks a backup file without changing it: integrity, host scope, schema version. A backup
 * stamped with one of `adoptHostScopes` (an earlier scope of this machine and home, listed by
 * the caller) passes; its `hostScope` is then the stored one, for the restore to re-stamp.
 */
export function checkBackup(path: string, hostScope: string, adoptHostScopes: readonly string[] = []): BackupCheck {
  let db: SqlDriver;
  try {
    db = openReadonly(path);
  } catch {
    return { ok: false, reason: 'backup-unreadable' };
  }
  try {
    if (!integrityOk(db)) return { ok: false, reason: 'backup-corrupt' };
    const meta = db.prepare('SELECT schema_version, host_scope FROM schema_meta WHERE id = 1').get();
    const version = num(field(meta, 'schema_version'));
    const scope = str(field(meta, 'host_scope'));
    if (version === undefined || scope === undefined) return { ok: false, reason: 'backup-corrupt' };
    if (scope !== hostScope && !adoptHostScopes.includes(scope)) return { ok: false, reason: 'backup-foreign-host' };
    if (version > latestSchemaVersion()) return { ok: false, reason: 'schema-newer' };
    return { ok: true, schemaVersion: version, hostScope: scope };
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return { ok: false, reason: typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB')) ? 'backup-corrupt' : 'backup-unreadable' };
  } finally {
    try {
      db.close();
    } catch {
      // closed
    }
  }
}

/** A consistent, owner-only, integrity-checked copy of the open store. */
export async function backupStore(store: OpenStoreResult, destination: string, input: { readonly nowMs: number; readonly actor?: string }): Promise<{ readonly ok: true; readonly path: string } | StoreRefusal | { readonly ok: false; readonly reason: 'backup-corrupt' | 'destination-exists' }> {
  if (!store.ok) return refuse(store.reason);
  const driver = driverFor(store);
  if (driver === undefined) return refuse('store-unavailable');
  if (typeof destination !== 'string' || destination.length === 0) return refuse('invalid-input');
  if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined) return { ok: false, reason: 'destination-exists' };
  // Reserve the name owner-only first so the copy never exists with a wider mode.
  try {
    closeSync(openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600));
  } catch {
    return refuse('path-refused');
  }
  try {
    await driver.backup(destination);
    privateFile(destination);
  } catch {
    rmSync(destination, { force: true });
    return refuse('store-unavailable');
  }
  const checked = checkBackup(destination, store.hostScope);
  if (!checked.ok) {
    rmSync(destination, { force: true });
    return { ok: false, reason: 'backup-corrupt' };
  }
  write(store, ({ driver: d }) => appendAuditRow(d, { kind: 'store.backup', actor: input.actor ?? 'cli', channel: 'cli', atMs: input.nowMs }, { schemaVersion: checked.schemaVersion }), { ignoreAutomationRefusal: true });
  return { ok: true, path: destination };
}

export type RestoreResult =
  | { readonly ok: true; readonly restoredSchemaVersion: number; readonly previousMovedTo: string | null }
  | { readonly ok: false; readonly reason: 'writer-busy' | 'backup-corrupt' | 'backup-foreign-host' | 'schema-newer' | 'backup-unreadable' | 'restore-failed'; readonly holderPid?: number };

/**
 * Installs a backup as the store. The store must be closed (stop the sidecar first). The
 * current files move aside to `<db>.pre-restore-<ms>` so a restore can itself be undone.
 */
export function restoreStore(input: { readonly backupPath: string; readonly dbPath: string; readonly hostScope: string; readonly nowMs: number; readonly adoptHostScopes?: readonly string[] }): RestoreResult {
  const holder = writerLockHolder(input.dbPath);
  if (holder !== undefined && holder.alive) return { ok: false, reason: 'writer-busy', holderPid: holder.pid };
  const checked = checkBackup(input.backupPath, input.hostScope, input.adoptHostScopes ?? []);
  if (!checked.ok) return checked;
  let previousMovedTo: string | null = null;
  try {
    if (lstatSync(input.dbPath, { throwIfNoEntry: false }) !== undefined) {
      previousMovedTo = `${input.dbPath}.pre-restore-${String(input.nowMs)}`;
      for (const [index, file] of storeFiles(input.dbPath).entries()) {
        if (lstatSync(file, { throwIfNoEntry: false }) === undefined) continue;
        renameSync(file, `${previousMovedTo}${['', '-wal', '-shm'][index] ?? ''}`);
      }
    }
    const temp = `${input.dbPath}.restoring`;
    rmSync(temp, { force: true });
    closeSync(openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600));
    copyFileSync(input.backupPath, temp);
    privateFile(temp);
    // A backup under an adopted earlier scope is installed with this machine's scope.
    if (checked.hostScope !== input.hostScope && !restampFile(temp, checked.hostScope, input.hostScope)) {
      rmSync(temp, { force: true });
      return { ok: false, reason: 'restore-failed' };
    }
    renameSync(temp, input.dbPath);
  } catch {
    return { ok: false, reason: 'restore-failed' };
  }
  return { ok: true, restoredSchemaVersion: checked.schemaVersion, previousMovedTo };
}

type WritableDriverCtor = new (path: string, options: { readonly fileMustExist: boolean }) => SqlDriver;

function openWritable(path: string): SqlDriver {
  const loaded = require('better-sqlite3') as WritableDriverCtor;
  const db = new loaded(path, { fileMustExist: true });
  db.defaultSafeIntegers(true);
  return db;
}

function closeQuietly(db: SqlDriver): void {
  try {
    db.close();
  } catch {
    // closed
  }
}

/** Re-stamps a closed database file's host scope from `from` to `to`. */
function restampFile(path: string, from: string, to: string): boolean {
  let db: SqlDriver;
  try {
    db = openWritable(path);
  } catch {
    return false;
  }
  try {
    return restampHostScope(db, from, to);
  } catch {
    return false;
  } finally {
    closeQuietly(db);
  }
}

export type AdoptResult =
  | { readonly ok: true; readonly changed: boolean; readonly schemaVersion: number }
  | { readonly ok: false; readonly reason: 'not-found' | 'path-refused' | 'writer-busy' | 'store-corrupt' | 'schema-newer' | 'store-unavailable'; readonly holderPid?: number };

/**
 * `jevris store adopt`: re-stamps a closed store with this machine's host scope, whatever scope
 * it holds, and records a `store.adopt` audit row in the same transaction. The CLI calls it
 * only from an interactive terminal, after the user confirmed, and only for a store file that
 * is this user's and lies in this home's data directory. It takes the writer lock, so it
 * refuses while the sidecar runs, and refuses a symlinked, corrupt or newer-schema store.
 */
export function adoptStoreHostScope(input: { readonly dbPath: string; readonly hostScope: string; readonly nowMs: number; readonly actor: string }): AdoptResult {
  if (!ID.test(input.hostScope) || !ACTOR.test(input.actor)) return { ok: false, reason: 'store-unavailable' };
  let st;
  try {
    st = lstatSync(input.dbPath, { throwIfNoEntry: false });
    for (const file of storeFiles(input.dbPath)) {
      const other = lstatSync(file, { throwIfNoEntry: false });
      if (other !== undefined && other.isSymbolicLink()) return { ok: false, reason: 'path-refused' };
    }
  } catch {
    return { ok: false, reason: 'path-refused' };
  }
  if (st === undefined) return { ok: false, reason: 'not-found' };
  if (!st.isFile()) return { ok: false, reason: 'path-refused' };
  const lock = acquireWriterLock(input.dbPath, 'adopt');
  if (!lock.ok) return lock.reason === 'writer-busy' ? { ok: false, reason: 'writer-busy', ...(lock.holder === undefined ? {} : { holderPid: lock.holder.pid }) } : { ok: false, reason: 'path-refused' };
  let db: SqlDriver | undefined;
  try {
    db = openWritable(input.dbPath);
    const d = db;
    if (!integrityOk(d)) return { ok: false, reason: 'store-corrupt' };
    const meta = readMeta(d);
    if (meta === undefined || meta === 'unexpected-schema') return { ok: false, reason: 'store-unavailable' };
    if (meta.schemaVersion > latestSchemaVersion()) return { ok: false, reason: 'schema-newer' };
    if (meta.hostScope === input.hostScope) return { ok: true, changed: false, schemaVersion: meta.schemaVersion };
    const hasAudit = d.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() !== undefined;
    let changed = false;
    immediately(d.transaction(() => {
      const result = d.prepare('UPDATE schema_meta SET host_scope = ? WHERE id = 1 AND host_scope = ?').run(input.hostScope, meta.hostScope);
      const changes = result !== null && typeof result === 'object' ? Reflect.get(result, 'changes') : undefined;
      changed = changes === 1 || changes === 1n;
      if (changed && hasAudit) appendAuditRow(d, { kind: 'store.adopt', actor: input.actor, channel: 'terminal', atMs: input.nowMs }, { reasonCode: 'HOST_SCOPE_ADOPTED', schemaVersion: meta.schemaVersion });
    }));
    return changed ? { ok: true, changed: true, schemaVersion: meta.schemaVersion } : { ok: false, reason: 'store-unavailable' };
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return { ok: false, reason: typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB')) ? 'store-corrupt' : 'store-unavailable' };
  } finally {
    if (db !== undefined) closeQuietly(db);
    releaseWriterLock(lock.lock);
  }
}

const EXPORT_TABLES = [
  'schema_meta',
  'schema_migrations',
  'workspace',
  'session',
  'event',
  'decision_record',
  'decision_row',
  'proposed_action',
  'outbox_entry',
  'task',
  'task_edge',
  'task_transition',
  'task_exception',
  'verification_receipt',
  'capsule_index',
  'evidence_row',
  'receipt_row',
  'lease_row',
  'job_reservation',
  'audit_log',
] as const;

function jsonValue(value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Writes the store as JSONL (`{"table":..., "row":{...}}` per line), owner-only. */
export function exportStoreJsonl(store: OpenStoreResult, destination: string): { readonly ok: true; readonly rows: number; readonly tables: number } | StoreRefusal {
  if (!store.ok) return refuse(store.reason);
  const driver = driverFor(store);
  if (driver === undefined) return refuse('store-unavailable');
  let fd: number;
  try {
    fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch {
    return refuse('path-refused');
  }
  let rows = 0;
  let tables = 0;
  try {
    for (const table of EXPORT_TABLES) {
      const exists = driver.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (exists === undefined) continue;
      tables += 1;
      for (const row of driver.prepare(`SELECT * FROM ${table}`).all()) {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) out[key] = jsonValue(value);
        writeSync(fd, `${JSON.stringify({ table, row: out })}\n`);
        rows += 1;
      }
    }
  } catch {
    closeSync(fd);
    rmSync(destination, { force: true });
    return refuse('store-unavailable');
  }
  closeSync(fd);
  return { ok: true, rows, tables };
}

export type StoreInspection =
  | { readonly ok: true; readonly exists: false }
  | { readonly ok: true; readonly exists: true; readonly schemaVersion: number; readonly targetVersion: number; readonly pending: readonly { readonly version: number; readonly name: string; readonly destructive: boolean }[]; readonly backupBeforeApply: boolean }
  | { readonly ok: false; readonly reason: 'backup-corrupt' | 'backup-unreadable' | 'schema-newer' | 'migration-checksum' | 'migration-refused' };

/** Opens the store read-only and plans its migration without changing it (`jevris store migrate --dry-run`). */
export function inspectStore(dbPath: string): StoreInspection {
  if (lstatSync(dbPath, { throwIfNoEntry: false }) === undefined) return { ok: true, exists: false };
  let db: SqlDriver;
  try {
    db = openReadonly(dbPath);
  } catch {
    return { ok: false, reason: 'backup-unreadable' };
  }
  try {
    const plan = planMigrations(db);
    if (!plan.ok) return { ok: false, reason: plan.reason === 'schema-newer' || plan.reason === 'migration-checksum' ? plan.reason : 'migration-refused' };
    return { ok: true, exists: true, schemaVersion: plan.currentVersion, targetVersion: plan.targetVersion, pending: plan.pending, backupBeforeApply: plan.backupBeforeApply };
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return { ok: false, reason: typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB')) ? 'backup-corrupt' : 'backup-unreadable' };
  } finally {
    try {
      db.close();
    } catch {
      // closed
    }
  }
}
