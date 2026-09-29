import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { filesystemKind, type FsKindResult } from './fs-kind.js';
import { classifySqliteError, writeDiagnostic, type StoreDiagnostic } from './health.js';
import { latestSchemaVersion, migrateStore, storedSchemaVersion, type MigrateOptions } from './migrate.js';
import { reconcileOnOpen } from './reconcile.js';
import {
  STORE_PACKAGE_VERSION,
  immediately,
  insertMeta,
  markAutomationRefused,
  readAutomationRefused,
  readMeta,
  schemaMetaExists,
  type SqlDriver,
} from './schema.js';
import { acquireWriterLock, releaseWriterLock, writerLockHolder, type HeldWriterLock } from './writer-lock.js';

export { STORE_PACKAGE_VERSION };

const require = createRequire(import.meta.url);
const TEST_ROLE = 'in-process-test';
const PRODUCTION_ROLE = 'sidecar';
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const refusalReasons = [
  'store-unavailable',
  'production-writer-closed',
  'writer-busy',
  'host-scope-mismatch',
  'path-refused',
] as const;

export type ListedRefusal = (typeof refusalReasons)[number];

export type StoreRefusalReason =
  | ListedRefusal
  | 'journal-mode-refused'
  | 'money-refused'
  | 'source-body-refused'
  | 'invalid-input'
  | 'migration-refused'
  | 'schema-newer'
  | 'network-filesystem'
  | 'store-full'
  | 'store-corrupt'
  | 'store-io'
  | 'store-readonly'
  | 'oversize'
  | 'not-found'
  | 'conflict'
  | 'BUDGET';

export type StoreMigration = (driver: SqlDriver) => void;

export interface OpenStoreInput {
  readonly path: string;
  readonly role: string;
  readonly workspaceId: string;
  readonly hostScope: string;
  /**
   * Earlier scopes of this same machine and home that this open may adopt (DATA-10): a store
   * stamped with one of them is re-stamped to `hostScope` in one transaction before anything
   * else writes. The caller lists them only after checking that the file is this user's and
   * lies in this home's data directory; a function is called only when the scopes differ.
   * Any other scope stays `host-scope-mismatch`.
   */
  readonly adoptHostScopes?: readonly string[] | (() => readonly string[]);
  readonly loadDriver?: (filePath: string) => SqlDriver;
  readonly extraMigrations?: readonly StoreMigration[];
  /**
   * Filesystem classifier for the db directory (DATA-10). Defaults to the platform detector
   * for a real file; `false` skips it (in-memory test drivers).
   */
  readonly fsKind?: ((dir: string) => FsKindResult) | false;
  /** Cross-process writer lock (DATA-09). Defaults to on for a real file. */
  readonly writerLock?: boolean;
  /** Test seams for the migration run (crash injection, custom lists). */
  readonly migration?: Pick<MigrateOptions, 'list' | 'beforeCommit' | 'isAlive' | 'staleLockMs' | 'nowMs'>;
}

export interface OpenedStore {
  readonly ok: true;
  readonly resolvedPath: string;
  readonly workspaceId: string;
  readonly hostScope: string;
  readonly journalMode: 'wal';
  readonly foreignKeys: 'on';
  readonly busyTimeout: 2000;
  readonly schemaVersion: number;
  readonly packageVersion: string;
  /** Filesystem class of the db directory: `unknown` when detection could not run. */
  readonly filesystem: FsKindResult['kind'];
  /** Present when this open re-stamped an adopted earlier scope (reason HOST_SCOPE_MIGRATED). */
  readonly hostScopeMigrated?: true;
}

export interface StoreRefusal {
  readonly ok: false;
  readonly reason: StoreRefusalReason;
}

export type OpenStoreResult = OpenedStore | StoreRefusal;

interface LiveStore {
  readonly driver: SqlDriver;
  readonly workspaceId: string;
  readonly hostScope: string;
  /** Workspace ids with a view over this open store (one sidecar, many workspaces; IPC-09). */
  readonly views: Set<string>;
  readonly lock: HeldWriterLock | undefined;
  /** Set when SQLITE_FULL, CORRUPT or IO stopped owned automation (DATA-08). */
  fault: StoreDiagnostic | undefined;
  /** Run once, in order, just before the owner closes the store (P2: the hook-record flush). */
  readonly beforeClose: (() => void)[];
}

const live = new Map<string, LiveStore>();

function refusal(reason: StoreRefusalReason): StoreRefusal {
  return { ok: false, reason };
}

function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function isRefusedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  const normalized = resolved.split(sep).join('/');
  if (normalized.includes('plugins/claude')) return true;
  const parts = resolved.split(sep);
  for (const part of parts) {
    if (part === '.claude-plugin') return true;
  }
  return false;
}

/** The db and its -wal and -shm siblings (BLD-08). */
export function storeFiles(resolvedPath: string): readonly string[] {
  return [resolvedPath, `${resolvedPath}-wal`, `${resolvedPath}-shm`];
}

/** True when any store file is a symlink: the store never follows one (BLD-08). */
function storeSymlinked(resolvedPath: string): boolean {
  for (const file of storeFiles(resolvedPath)) {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st !== undefined && st.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Creates a missing store directory owner-only. On Linux the data directory
 * ($XDG_DATA_HOME/jevris) is apart from the state and runtime directories, so on a fresh home
 * nothing else has made it yet. An existing directory is used as it is; a parent that exists
 * but is not a directory is refused.
 */
function ensureStoreDir(resolvedPath: string): boolean {
  const dir = dirname(resolvedPath);
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return statSync(dir).isDirectory();
}

/**
 * Creates a missing db file exclusive at 0600 before SQLite opens it, so the db starts
 * owner-only; SQLite gives -wal and -shm the db's mode. On Windows the owner-only ACL is
 * inherited from the private data directory.
 */
function precreatePrivate(resolvedPath: string): void {
  if (lstatSync(resolvedPath, { throwIfNoEntry: false }) !== undefined) return;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  try {
    closeSync(openSync(resolvedPath, flags, 0o600));
  } catch (error) {
    // Another opener created it first; SQLite opens that file.
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST') return;
    throw error;
  }
}

/** Tightens existing store files to 0600 on POSIX (a db made before BLD-08 was 0644). */
function tightenStoreFiles(resolvedPath: string): void {
  if (process.platform === 'win32') return;
  for (const file of storeFiles(resolvedPath)) {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile() || (st.mode & 0o077) === 0) continue;
    chmodSync(file, 0o600);
  }
}

function isConstructor(value: unknown): value is new (filename: string) => SqlDriver {
  return typeof value === 'function';
}

function defaultLoadDriver(filePath: string): SqlDriver {
  const loaded = require('better-sqlite3');
  if (!isConstructor(loaded)) {
    throw new Error('addon');
  }
  return new loaded(filePath);
}

function tableCount(driver: SqlDriver): number {
  const row: unknown = driver.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  const n: unknown = row !== null && typeof row === 'object' ? Reflect.get(row, 'n') : undefined;
  return typeof n === 'bigint' ? Number(n) : typeof n === 'number' ? n : -1;
}

function pragmaSimple(driver: SqlDriver, source: string): unknown {
  return driver.pragma(source, { simple: true });
}

/**
 * Test-only disk-full injection for the operations drill (OBS-05): with JEVRIS_TEST=1 and
 * JEVRIS_TEST_STORE_FREE_PAGES=<n>, the store may grow by only n more pages, so the next write
 * past that fails with SQLITE_FULL exactly as on a full disk. Ignored outside test mode.
 */
function applyTestPageLimit(driver: SqlDriver): void {
  if (process.env['JEVRIS_TEST'] !== '1') return;
  const raw = process.env['JEVRIS_TEST_STORE_FREE_PAGES'];
  if (raw === undefined || !/^[0-9]{1,6}$/.test(raw)) return;
  const pages = Number(pragmaSimple(driver, 'page_count'));
  if (!Number.isSafeInteger(pages)) return;
  driver.pragma(`max_page_count = ${pages + Number(raw)}`);
}

function journalIsWal(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'wal';
}

function foreignKeysOn(value: unknown): boolean {
  return value === 1 || value === 1n || value === 'on' || value === 'ON';
}

function busyTimeoutSet(value: unknown): boolean {
  return value === 2000 || value === 2000n;
}

function closeQuietly(driver: SqlDriver): void {
  try {
    driver.close();
  } catch {
    return;
  }
}

export function driverFor(store: OpenedStore): SqlDriver | undefined {
  const current = live.get(store.resolvedPath);
  if (current === undefined) return undefined;
  if (current.workspaceId !== store.workspaceId && !current.views.has(store.workspaceId)) return undefined;
  return current.driver;
}

/**
 * A view of an open store scoped to another workspace. Every store function reads and writes
 * only `view.workspaceId` rows, so a handler holding the view cannot reach another workspace.
 * Closing a view is a no-op; the owner closes the store.
 */
export function workspaceView(store: OpenedStore, workspaceId: string): OpenedStore | undefined {
  if (!isId(workspaceId)) return undefined;
  const current = live.get(store.resolvedPath);
  if (current === undefined || current.workspaceId !== store.workspaceId) return undefined;
  if (workspaceId === store.workspaceId) return store;
  current.views.add(workspaceId);
  return Object.freeze({ ...store, workspaceId });
}

/**
 * Registers `fn` to run just before the owner closes this store, while it is still open (P2: the
 * hook-record buffer commits). A throwing callback does not stop the close.
 */
export function onStoreClose(store: OpenedStore, fn: () => void): void {
  const current = live.get(store.resolvedPath);
  if (current === undefined) return;
  if (current.workspaceId !== store.workspaceId && !current.views.has(store.workspaceId)) return;
  current.beforeClose.push(fn);
}

export function closeStore(store: OpenedStore): void {
  const current = live.get(store.resolvedPath);
  if (current === undefined) return;
  if (current.workspaceId !== store.workspaceId) return;
  for (const fn of current.beforeClose.splice(0)) {
    try {
      fn();
    } catch {
      // A failed flush loses at most the last second of hook bookkeeping (owner ededdba).
    }
  }
  try {
    current.driver.close();
  } finally {
    live.delete(store.resolvedPath);
    if (current.lock !== undefined) releaseWriterLock(current.lock);
  }
}

/**
 * The store-maintenance connection (sidecar concurrency audit P10, owner ededdba): a second
 * connection to a store this same process already holds as its single writer, for a worker thread
 * that runs the retention sweep off the request loop.
 *
 * - Refused unless the writer lock is held, live, by this process (`writer-busy`): a second
 *   process can never open it, and neither can a CLI next to a running sidecar.
 * - It never migrates, adopts a host scope or re-stamps anything: the schema must be exactly the
 *   latest (`store-unavailable`) and the host scope the one given (`host-scope-mismatch`).
 * - WAL, foreign keys and the same busy timeout as the writer, with `secure_delete` on.
 * - `closeStore` closes it and never touches the writer lock.
 */
export function openMaintenanceStore(input: { readonly path: string; readonly hostScope: string; readonly workspaceId?: string }): OpenStoreResult {
  const workspaceId = input.workspaceId ?? 'host';
  if (!isId(workspaceId) || !isId(input.hostScope)) return refusal('invalid-input');
  if (typeof input.path !== 'string' || input.path.length === 0 || isRefusedPath(input.path)) return refusal('path-refused');
  const resolvedPath = resolve(input.path);
  if (live.has(resolvedPath)) return refusal('writer-busy');
  try {
    if (storeSymlinked(resolvedPath)) return refusal('path-refused');
  } catch {
    return refusal('path-refused');
  }
  const holder = writerLockHolder(resolvedPath);
  if (holder === undefined || !holder.alive || holder.pid !== process.pid) return refusal('writer-busy');
  let driver: SqlDriver;
  try {
    driver = defaultLoadDriver(resolvedPath);
  } catch (error) {
    return refuseFault(resolvedPath, error, 'open');
  }
  try {
    driver.defaultSafeIntegers(true);
    driver.pragma('journal_mode = WAL');
    driver.pragma('foreign_keys = ON');
    driver.pragma('busy_timeout = 2000');
    driver.pragma('secure_delete = ON');
    if (!journalIsWal(pragmaSimple(driver, 'journal_mode')) || !foreignKeysOn(pragmaSimple(driver, 'foreign_keys'))) {
      closeQuietly(driver);
      return refusal('journal-mode-refused');
    }
    if (!schemaMetaExists(driver) || storedSchemaVersion(driver) !== latestSchemaVersion()) {
      closeQuietly(driver);
      return refusal('store-unavailable');
    }
    const meta = readMeta(driver);
    if (meta === undefined || meta === 'unexpected-schema') {
      closeQuietly(driver);
      return refusal('store-unavailable');
    }
    if (meta.hostScope !== input.hostScope) {
      closeQuietly(driver);
      return refusal('host-scope-mismatch');
    }
    live.set(resolvedPath, { driver, workspaceId, hostScope: meta.hostScope, views: new Set<string>(), beforeClose: [], lock: undefined, fault: undefined });
    return Object.freeze({
      ok: true,
      resolvedPath,
      workspaceId,
      hostScope: meta.hostScope,
      journalMode: 'wal',
      foreignKeys: 'on',
      busyTimeout: 2000,
      schemaVersion: meta.schemaVersion,
      packageVersion: meta.packageLabel,
      filesystem: 'unknown',
    });
  } catch (error) {
    closeQuietly(driver);
    return refuseFault(resolvedPath, error, 'open');
  }
}

/**
 * Records a store fault from a caught error. Returns true when the error was a fault
 * (SQLITE_FULL, CORRUPT, NOTADB, IOERR, READONLY): owned automation for this store stops and
 * a content-free diagnostic is written. Ordinary errors return false.
 */
export function recordStoreFault(store: OpenStoreResult, error: unknown, phase: StoreDiagnostic['phase'] = 'write'): boolean {
  const fault = classifySqliteError(error);
  if (fault === undefined || !store.ok) return fault !== undefined;
  const current = live.get(store.resolvedPath);
  const diagnostic = writeDiagnostic(store.resolvedPath, fault, phase, Date.now());
  if (current !== undefined) current.fault = diagnostic;
  return true;
}

/** A refusal for a caught store fault (after recording it), or undefined for other errors. */
export function faultRefusal(store: OpenStoreResult, error: unknown): StoreRefusal | undefined {
  const fault = classifySqliteError(error);
  if (fault === undefined) return undefined;
  recordStoreFault(store, error);
  return refusal(fault.code);
}

/** The fault that stopped owned automation for this store, if any. */
export function storeFault(store: OpenStoreResult): StoreDiagnostic | undefined {
  if (!store.ok) return undefined;
  return live.get(store.resolvedPath)?.fault;
}

function refuseFault(resolvedPath: string, error: unknown, phase: StoreDiagnostic['phase']): StoreRefusal {
  const fault = classifySqliteError(error);
  if (fault === undefined) return refusal('store-unavailable');
  writeDiagnostic(resolvedPath, fault, phase, Date.now());
  return refusal(fault.code);
}

function quickCheckOk(driver: SqlDriver): boolean {
  const rows = driver.pragma('quick_check');
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const first: unknown = rows[0];
  const value = first !== null && typeof first === 'object' ? Reflect.get(first, 'quick_check') : first;
  return value === 'ok';
}

export function openStore(input: OpenStoreInput): OpenStoreResult {
  if (input.role !== TEST_ROLE && input.role !== PRODUCTION_ROLE) return refusal('production-writer-closed');
  if (!isId(input.workspaceId) || !isId(input.hostScope)) return refusal('invalid-input');
  if (typeof input.path !== 'string' || input.path.length === 0) return refusal('path-refused');
  if (isRefusedPath(input.path)) return refusal('path-refused');

  const resolvedPath = resolve(input.path);
  if (live.has(resolvedPath)) return refusal('writer-busy');
  try {
    if (storeSymlinked(resolvedPath)) return refusal('path-refused');
  } catch {
    return refusal('path-refused');
  }

  const realFile = input.loadDriver === undefined;
  if (realFile) {
    try {
      if (!ensureStoreDir(resolvedPath)) return refusal('path-refused');
    } catch {
      return refusal('path-refused');
    }
  }
  // DATA-10: never a database on a network filesystem.
  let filesystem: FsKindResult['kind'] = 'unknown';
  const classify = input.fsKind ?? (realFile ? (dir: string) => filesystemKind(dir) : false);
  if (classify !== false) {
    const kind = classify(dirname(resolvedPath));
    if (kind.kind === 'network') return refusal('network-filesystem');
    filesystem = kind.kind;
  }

  // DATA-09: one writer process per store file.
  let lock: HeldWriterLock | undefined;
  if (input.writerLock ?? realFile) {
    const taken = acquireWriterLock(resolvedPath, input.role);
    if (!taken.ok) return refusal(taken.reason);
    lock = taken.lock;
  }
  const unlock = (): void => {
    if (lock !== undefined) releaseWriterLock(lock);
  };

  let driver: SqlDriver;
  try {
    const load = input.loadDriver;
    if (load === undefined) precreatePrivate(resolvedPath);
    driver = load !== undefined ? load(resolvedPath) : defaultLoadDriver(resolvedPath);
  } catch (error) {
    unlock();
    return realFile ? refuseFault(resolvedPath, error, 'open') : refusal('store-unavailable');
  }

  try {
    driver.defaultSafeIntegers(true);
    // P10: a new store returns free pages in small steps (`incremental_vacuum` after each sweep)
    // instead of a whole-file VACUUM that would hold the write lock. The mode can only be chosen
    // while the file is still empty, before WAL mode writes its first page; an older store keeps
    // reusing its free pages.
    if (realFile && tableCount(driver) === 0 && Number(pragmaSimple(driver, 'page_count')) === 0) driver.pragma('auto_vacuum = INCREMENTAL');
    driver.pragma('journal_mode = WAL');
    driver.pragma('foreign_keys = ON');
    driver.pragma('busy_timeout = 2000');
    const journalMode = pragmaSimple(driver, 'journal_mode');
    const foreignKeys = pragmaSimple(driver, 'foreign_keys');
    const busyTimeout = pragmaSimple(driver, 'busy_timeout');
    if (!journalIsWal(journalMode) || !foreignKeysOn(foreignKeys) || !busyTimeoutSet(busyTimeout)) {
      closeQuietly(driver);
      unlock();
      return refusal('journal-mode-refused');
    }
    // DATA-08: a corrupt store is refused with a diagnostic, never written.
    if (realFile && !quickCheckOk(driver)) {
      closeQuietly(driver);
      unlock();
      writeDiagnostic(resolvedPath, { code: 'store-corrupt', sqliteCode: 'SQLITE_CORRUPT' }, 'quick-check', Date.now());
      return refusal('store-corrupt');
    }

    // Refuse a foreign host scope or a newer schema before any migration writes; adopt an
    // earlier scope of this machine and home (a host-name scope) by re-stamping it.
    let hostScopeMigrated = false;
    if (schemaMetaExists(driver)) {
      const before = readMeta(driver);
      if (before !== undefined && before !== 'unexpected-schema' && before.hostScope !== input.hostScope) {
        if (!mayAdopt(input.adoptHostScopes, before.hostScope, input.hostScope) || !restampHostScope(driver, before.hostScope, input.hostScope)) {
          closeQuietly(driver);
          unlock();
          return refusal('host-scope-mismatch');
        }
        hostScopeMigrated = true;
      }
    }
    const latest = latestSchemaVersion(input.migration?.list);
    if (storedSchemaVersion(driver) > latest) {
      closeQuietly(driver);
      unlock();
      return refusal('schema-newer');
    }

    const migrated = migrateStore(driver, { ...(realFile ? { dbPath: resolvedPath } : {}), ...(input.migration ?? {}) });
    let migrationFailed = false;
    if (!migrated.ok) {
      if (migrated.reason === 'schema-newer') {
        closeQuietly(driver);
        unlock();
        return refusal('schema-newer');
      }
      if (migrated.reason === 'migration-busy') {
        closeQuietly(driver);
        unlock();
        return refusal('writer-busy');
      }
      // A failed or changed migration stops actuation rather than run on a partly
      // understood schema (SSOT §17.1).
      migrationFailed = true;
    }

    if (!schemaMetaExists(driver)) {
      closeQuietly(driver);
      unlock();
      return refusal('store-unavailable');
    }
    const meta = readMeta(driver);
    if (meta === 'unexpected-schema') {
      closeQuietly(driver);
      unlock();
      return refusal('store-unavailable');
    }
    if (meta === undefined) {
      insertMeta(driver, input.hostScope, migrated.ok ? migrated.toVersion : storedSchemaVersion(driver) || 1);
    } else if (meta.hostScope !== input.hostScope) {
      closeQuietly(driver);
      unlock();
      return refusal('host-scope-mismatch');
    }
    if (migrationFailed) markAutomationRefused(driver);

    const stored = readMeta(driver);
    if (stored === undefined || stored === 'unexpected-schema') {
      closeQuietly(driver);
      unlock();
      return refusal('store-unavailable');
    }
    if (stored.hostScope !== input.hostScope) {
      closeQuietly(driver);
      unlock();
      return refusal('host-scope-mismatch');
    }

    const extrasOk = runExtraMigrations(driver, input.extraMigrations);
    if (!extrasOk) {
      closeQuietly(driver);
      unlock();
      return refusal('store-unavailable');
    }
    const afterMigration = readMeta(driver);
    if (afterMigration === undefined || afterMigration === 'unexpected-schema') {
      closeQuietly(driver);
      unlock();
      return refusal('store-unavailable');
    }
    if (afterMigration.hostScope !== input.hostScope) {
      closeQuietly(driver);
      unlock();
      return refusal('host-scope-mismatch');
    }

    reconcileOnOpen(driver);
    if (realFile) tightenStoreFiles(resolvedPath);
    if (realFile) applyTestPageLimit(driver);

    live.set(resolvedPath, {
      driver,
      workspaceId: input.workspaceId,
      hostScope: afterMigration.hostScope,
      views: new Set<string>(),
      beforeClose: [],
      lock,
      fault: undefined,
    });
    return Object.freeze({
      ok: true,
      resolvedPath,
      workspaceId: input.workspaceId,
      hostScope: afterMigration.hostScope,
      journalMode: 'wal',
      foreignKeys: 'on',
      busyTimeout: 2000,
      schemaVersion: afterMigration.schemaVersion,
      packageVersion: afterMigration.packageLabel,
      filesystem,
      ...(hostScopeMigrated ? { hostScopeMigrated: true as const } : {}),
    });
  } catch (error) {
    closeQuietly(driver);
    live.delete(resolvedPath);
    unlock();
    return realFile ? refuseFault(resolvedPath, error, 'open') : refusal('store-unavailable');
  }
}

function mayAdopt(adopt: OpenStoreInput['adoptHostScopes'], stored: string, wanted: string): boolean {
  if (adopt === undefined || stored === wanted || !isId(stored)) return false;
  let list: readonly string[];
  try {
    list = typeof adopt === 'function' ? adopt() : adopt;
  } catch {
    return false;
  }
  return Array.isArray(list) && list.includes(stored);
}

/**
 * Re-stamps `schema_meta.host_scope` from `from` to `to` in one transaction; false when the
 * row did not hold `from` (nothing changed).
 */
export function restampHostScope(driver: SqlDriver, from: string, to: string): boolean {
  if (!isId(from) || !isId(to)) return false;
  let changed = false;
  immediately(driver.transaction(() => {
    const result = driver.prepare('UPDATE schema_meta SET host_scope = ? WHERE id = 1 AND host_scope = ?').run(to, from);
    const changes = result !== null && typeof result === 'object' ? Reflect.get(result, 'changes') : undefined;
    changed = changes === 1 || changes === 1n;
  }));
  return changed;
}

function runExtraMigrations(
  driver: SqlDriver,
  extras: readonly StoreMigration[] | undefined,
): boolean {
  if (extras === undefined) return true;
  for (const migration of extras) {
    if (typeof migration !== 'function') return false;
    try {
      immediately(driver.transaction(() => {
        migration(driver);
      }));
    } catch {
      try {
        if (schemaMetaExists(driver)) markAutomationRefused(driver);
      } catch {
        return false;
      }
      return true;
    }
  }
  return true;
}

export interface MigrationRefusal {
  readonly ok: false;
  readonly reason: 'migration-refused' | StoreDiagnostic['code'];
}

/**
 * Refuses owned automation when a migration failed (schema_meta flag) or a store fault
 * (full, corrupt, IO) was recorded in this process.
 */
export function automationRefusedGuard(store: OpenStoreResult): MigrationRefusal | undefined {
  if (!store.ok) return undefined;
  const current = live.get(store.resolvedPath);
  if (current?.fault !== undefined) return { ok: false, reason: current.fault.code };
  const driver = driverFor(store);
  if (driver === undefined) return undefined;
  try {
    if (!readAutomationRefused(driver)) return undefined;
  } catch (error) {
    if (recordStoreFault(store, error)) return { ok: false, reason: live.get(store.resolvedPath)?.fault?.code ?? 'store-io' };
    return { ok: false, reason: 'migration-refused' };
  }
  return { ok: false, reason: 'migration-refused' };
}
