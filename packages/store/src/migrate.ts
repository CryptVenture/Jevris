/**
 * Versioned store migrations (DATA-01, SSOT §17.1).
 *
 * - `schema_migrations` records each applied version with a checksum of its SQL. A changed
 *   migration (checksum mismatch) or an unknown applied version refuses the open.
 * - A database whose `schema_version` is newer than this build knows is refused
 *   (`schema-newer`): an older Jevris never writes a schema it does not understand.
 * - The run holds a lock row (`migration_lock`) taken under `BEGIN IMMEDIATE`, so two
 *   processes never migrate at once. A lock left by a killed process is taken over when its
 *   holder is gone or the row is older than `staleLockMs`.
 * - Each migration runs in its own `BEGIN IMMEDIATE` transaction together with its
 *   `schema_migrations` row and the `schema_version` bump, so a process killed mid-migration
 *   leaves the previous version intact and the next open resumes from there.
 * - A migration marked `destructive` first writes a `VACUUM INTO` backup next to the db.
 * - Schema versions are distinct from package versions.
 *
 * Rollback (documented in docs/store.md): stop the sidecar, move the db aside, and restore
 * the `*.pre-v<N>.bak` backup or a `jevris store backup` file with `jevris store restore`,
 * then run the matching older Jevris. Additive migrations need no rollback for an older
 * build to be refused cleanly: it sees `schema-newer` and runs rules-only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { OWNED_TABLES_SQL } from './lease.js';
import { JOB_RESERVATION_SQL } from './reservation.js';
import {
  SCHEMA_SQL,
  SCHEMA_VERSION_2_SQL,
  ensureAutomationRefusedColumn,
  ensureEffectColumns,
  type SqlDriver,
} from './schema.js';
import { DURABLE_MODEL_SQL, TASK_MODEL_SQL, LEDGER_MODEL_SQL, GOVERNANCE_MODEL_SQL } from './schema-v2.js';
import { DECISION_FEEDBACK_SQL, LEARNING_RECORDS_SQL } from './learning.js';
import { HOOK_RECORDS_SQL } from './hook-records.js';
import { PROVIDER_CONSENT_SQL } from './provider-consent.js';
import { SESSION_LINK_SQL, ensureSessionLastSeen } from './session-link.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** The migration's DDL; its checksum is what `schema_migrations` records. */
  readonly sql: string;
  /** Idempotent follow-up in the same transaction (column additions for old databases). */
  readonly apply?: (driver: SqlDriver) => void;
  /** Takes a `VACUUM INTO` backup first. */
  readonly destructive?: boolean;
}

const BASELINE_SQL = [SCHEMA_SQL, SCHEMA_VERSION_2_SQL, OWNED_TABLES_SQL, JOB_RESERVATION_SQL].join('\n');

let cached: readonly Migration[] | undefined;

/** The ordered migrations this build knows. Built lazily (the SQL comes from sibling modules). */
export function migrations(): readonly Migration[] {
  if (cached !== undefined) return cached;
  cached = Object.freeze([
    {
      version: 1,
      name: 'baseline',
      sql: BASELINE_SQL,
      apply: (driver: SqlDriver) => {
        ensureAutomationRefusedColumn(driver);
        ensureEffectColumns(driver);
      },
    },
    { version: 2, name: 'durable-model', sql: DURABLE_MODEL_SQL },
    { version: 3, name: 'task-model', sql: TASK_MODEL_SQL },
    { version: 4, name: 'decision-ledger', sql: LEDGER_MODEL_SQL },
    { version: 5, name: 'governance', sql: GOVERNANCE_MODEL_SQL },
    { version: 6, name: 'learning-records', sql: LEARNING_RECORDS_SQL },
    { version: 7, name: 'decision-feedback', sql: DECISION_FEEDBACK_SQL },
    { version: 8, name: 'hook-records', sql: HOOK_RECORDS_SQL },
    { version: 9, name: 'provider-consent', sql: PROVIDER_CONSENT_SQL },
    { version: 10, name: 'session-link', sql: SESSION_LINK_SQL, apply: ensureSessionLastSeen },
  ]);
  return cached;
}

export function latestSchemaVersion(list: readonly Migration[] = migrations()): number {
  return list.reduce((max, m) => Math.max(max, m.version), 0);
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`).digest('hex');
}

const BOOKKEEPING_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  holder_pid INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL
);
`;

export type MigrationRefusalReason = 'schema-newer' | 'migration-checksum' | 'migration-busy' | 'migration-failed';

export interface MigrationPlanStep {
  readonly version: number;
  readonly name: string;
  readonly destructive: boolean;
}

export interface MigrationPlan {
  readonly ok: true;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pending: readonly MigrationPlanStep[];
  readonly backupBeforeApply: boolean;
}

export interface MigrationApplied {
  readonly ok: true;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
  readonly backups: readonly string[];
}

export interface MigrationRefusal {
  readonly ok: false;
  readonly reason: MigrationRefusalReason;
  readonly detail?: string;
}

export interface MigrateOptions {
  /** The db path, for the `VACUUM INTO` backup name. Absent (in-memory tests): no backup. */
  readonly dbPath?: string;
  readonly nowMs?: () => number;
  readonly staleLockMs?: number;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  /** Test seam: the list of migrations (defaults to this build's). */
  readonly list?: readonly Migration[];
  /** Test seam: runs after a migration's DDL and before its commit (crash injection). */
  readonly beforeCommit?: (version: number) => void;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function field(row: unknown, key: string): unknown {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  return Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;
}

function tableExists(driver: SqlDriver, name: string): boolean {
  const row = driver.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined && row !== null;
}

/** The `schema_version` in `schema_meta`, or 0 for a fresh database. */
export function storedSchemaVersion(driver: SqlDriver): number {
  if (!tableExists(driver, 'schema_meta')) return 0;
  return num(field(driver.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get(), 'schema_version')) ?? 0;
}

interface AppliedRow {
  readonly version: number;
  readonly checksum: string;
}

function appliedRows(driver: SqlDriver): readonly AppliedRow[] {
  if (!tableExists(driver, 'schema_migrations')) return [];
  const rows: AppliedRow[] = [];
  for (const row of driver.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()) {
    const version = num(field(row, 'version'));
    const checksum = field(row, 'checksum');
    if (version !== undefined && typeof checksum === 'string') rows.push({ version, checksum });
  }
  return rows;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EPERM';
  }
}

/**
 * Checks the stored schema against this build: newer versions and changed migrations are
 * refused. Returns the plan (read-only; nothing is written). Used by `store migrate --dry-run`.
 */
export function planMigrations(driver: SqlDriver, options: Pick<MigrateOptions, 'list'> = {}): MigrationPlan | MigrationRefusal {
  const list = options.list ?? migrations();
  const latest = latestSchemaVersion(list);
  const current = storedSchemaVersion(driver);
  if (current > latest) return { ok: false, reason: 'schema-newer', detail: `stored schema ${String(current)} is newer than ${String(latest)}` };
  const known = new Map(list.map((m) => [m.version, m]));
  const applied = appliedRows(driver);
  for (const row of applied) {
    const migration = known.get(row.version);
    if (migration === undefined) return { ok: false, reason: 'schema-newer', detail: `applied migration ${String(row.version)} is unknown` };
    if (migrationChecksum(migration) !== row.checksum) return { ok: false, reason: 'migration-checksum', detail: `migration ${String(row.version)} changed` };
  }
  const done = new Set(applied.map((r) => r.version));
  // A database made before schema_migrations existed is at schema 1 with no rows: the
  // baseline (idempotent DDL) runs again and is recorded.
  const pending = list
    .filter((m) => !done.has(m.version))
    .sort((a, b) => a.version - b.version)
    .map((m) => ({ version: m.version, name: m.name, destructive: m.destructive === true }));
  return {
    ok: true,
    currentVersion: Math.max(current, ...applied.map((r) => r.version), 0),
    targetVersion: latest,
    pending,
    backupBeforeApply: pending.some((p) => p.destructive),
  };
}

function takeLock(driver: SqlDriver, holder: string, pid: number, nowMs: number, staleLockMs: number, isAlive: (pid: number) => boolean): boolean {
  driver.exec('BEGIN IMMEDIATE');
  try {
    const row = driver.prepare('SELECT holder, holder_pid, acquired_at_ms FROM migration_lock WHERE id = 1').get();
    if (row !== undefined && row !== null) {
      const otherPid = num(field(row, 'holder_pid')) ?? 0;
      const at = num(field(row, 'acquired_at_ms')) ?? 0;
      const fresh = nowMs - at < staleLockMs;
      if (field(row, 'holder') !== holder && fresh && otherPid !== pid && isAlive(otherPid)) {
        driver.exec('ROLLBACK');
        return false;
      }
    }
    driver
      .prepare('INSERT INTO migration_lock (id, holder, holder_pid, acquired_at_ms) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, holder_pid = excluded.holder_pid, acquired_at_ms = excluded.acquired_at_ms')
      .run(holder, pid, nowMs);
    driver.exec('COMMIT');
    return true;
  } catch (error) {
    try {
      driver.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw error;
  }
}

function releaseLock(driver: SqlDriver, holder: string): void {
  try {
    driver.prepare('DELETE FROM migration_lock WHERE id = 1 AND holder = ?').run(holder);
  } catch {
    // A stale row is taken over by the next run.
  }
}

function backupPath(dbPath: string, version: number, nowMs: number): string {
  return `${dbPath}.pre-v${String(version)}-${String(nowMs)}.bak`;
}

/**
 * Applies every pending migration. Refuses a newer schema, a changed migration, and a
 * concurrent migrator; a failure rolls that migration back and reports `migration-failed`
 * (the caller refuses owned automation rather than run on a partly understood schema).
 */
export function migrateStore(driver: SqlDriver, options: MigrateOptions = {}): MigrationApplied | MigrationRefusal {
  const list = options.list ?? migrations();
  const now = options.nowMs ?? Date.now;
  driver.exec(BOOKKEEPING_SQL);
  const plan = planMigrations(driver, { list });
  if (!plan.ok) return plan;
  if (plan.pending.length === 0) return { ok: true, fromVersion: plan.currentVersion, toVersion: plan.currentVersion, applied: [], backups: [] };

  const pid = options.pid ?? process.pid;
  const holder = `${String(pid)}:${randomBytes(8).toString('hex')}`;
  if (!takeLock(driver, holder, pid, now(), options.staleLockMs ?? 60_000, options.isAlive ?? defaultAlive)) {
    return { ok: false, reason: 'migration-busy' };
  }
  const applied: number[] = [];
  const backups: string[] = [];
  try {
    // Re-plan under the lock: another process may have finished some steps meanwhile.
    const locked = planMigrations(driver, { list });
    if (!locked.ok) return locked;
    const byVersion = new Map(list.map((m) => [m.version, m]));
    for (const step of locked.pending) {
      const migration = byVersion.get(step.version);
      if (migration === undefined) continue;
      if (migration.destructive === true && options.dbPath !== undefined && storedSchemaVersion(driver) > 0) {
        const target = backupPath(options.dbPath, migration.version, now());
        driver.prepare('VACUUM INTO ?').run(target);
        if (process.platform !== 'win32') chmodSync(target, 0o600);
        backups.push(target);
      }
      driver.exec('BEGIN IMMEDIATE');
      try {
        driver.exec(migration.sql);
        migration.apply?.(driver);
        driver
          .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, migrationChecksum(migration), now());
        if (tableExists(driver, 'schema_meta')) {
          driver.prepare('UPDATE schema_meta SET schema_version = ? WHERE id = 1 AND schema_version < ?').run(migration.version, migration.version);
        }
        options.beforeCommit?.(migration.version);
        driver.exec('COMMIT');
        applied.push(migration.version);
      } catch {
        try {
          driver.exec('ROLLBACK');
        } catch {
          // rolled back by SQLite
        }
        return { ok: false, reason: 'migration-failed', detail: `migration ${String(migration.version)} (${migration.name}) failed and was rolled back` };
      }
    }
    return { ok: true, fromVersion: locked.currentVersion, toVersion: latestSchemaVersion(list), applied, backups };
  } finally {
    releaseLock(driver, holder);
  }
}
