export const STORE_PACKAGE_VERSION = '0.1.0';
/** The baseline schema version; later versions come from migrate.ts (`latestSchemaVersion`). */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  package_label TEXT NOT NULL,
  host_scope TEXT NOT NULL,
  automation_refused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS decision_row (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  reservation_micro_usd INTEGER NOT NULL,
  usage_known INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  consumed_micro_usd INTEGER,
  validity TEXT NOT NULL DEFAULT 'current',
  PRIMARY KEY (workspace_id, decision_id),
  UNIQUE (workspace_id, operation_id)
);

CREATE TABLE IF NOT EXISTS proposed_action (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, decision_id),
  FOREIGN KEY (workspace_id, decision_id)
    REFERENCES decision_row (workspace_id, decision_id)
);

CREATE TABLE IF NOT EXISTS outbox_entry (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  effect_status TEXT NOT NULL DEFAULT 'pending',
  acknowledgment TEXT NOT NULL DEFAULT 'absent',
  process_observed TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (workspace_id, decision_id),
  FOREIGN KEY (workspace_id, decision_id)
    REFERENCES decision_row (workspace_id, decision_id)
);
`;

export interface SqlStatement {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): readonly unknown[];
}

export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  defaultSafeIntegers(toggle?: boolean): void;
  transaction(fn: () => void): () => void;
  close(): void;
  backup(filename: string): Promise<unknown>;
}

/**
 * Runs a write transaction built with `driver.transaction(fn)` as `BEGIN IMMEDIATE` (a savepoint
 * when nested). Since the maintenance worker (P10) a second connection can hold the write lock.
 * A deferred transaction that reads and then writes would get SQLITE_BUSY at once when another
 * connection wrote meanwhile, without waiting (the busy handler is not called for that upgrade);
 * an immediate one takes the write lock first and waits up to `busy_timeout`.
 */
export function immediately(run: () => void): void {
  const immediate: unknown = Reflect.get(run, 'immediate');
  if (typeof immediate === 'function') immediate.call(run);
  else run();
}

export interface StoredMeta {
  readonly schemaVersion: number;
  readonly packageLabel: string;
  readonly hostScope: string;
}

const SIGNED_MAX = 9223372036854775807n;

export function acceptMoney(value: unknown): bigint | undefined {
  if (typeof value !== 'bigint') return undefined;
  if (value < 0n || value > SIGNED_MAX) return undefined;
  return value;
}

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function asSchemaVersion(value: unknown): number | undefined {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return undefined;
  return n;
}

export function readMeta(driver: SqlDriver): StoredMeta | 'unexpected-schema' | undefined {
  const row = driver
    .prepare('SELECT schema_version, package_label, host_scope FROM schema_meta WHERE id = 1')
    .get();
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const schemaVersion = asSchemaVersion(own(row, 'schema_version'));
  const packageLabel = own(row, 'package_label');
  const hostScope = own(row, 'host_scope');
  if (typeof packageLabel !== 'string' || typeof hostScope !== 'string') return 'unexpected-schema';
  if (schemaVersion === undefined) return 'unexpected-schema';
  return { schemaVersion, packageLabel, hostScope };
}

export function insertMeta(driver: SqlDriver, hostScope: string, schemaVersion = 1): void {
  driver
    .prepare(
      'INSERT INTO schema_meta (id, schema_version, package_label, host_scope, automation_refused) VALUES (1, ?, ?, ?, 0)',
    )
    .run(BigInt(schemaVersion), STORE_PACKAGE_VERSION, hostScope);
}

function countOf(row: unknown): bigint | number | undefined {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const value = own(row, 'n');
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  return undefined;
}

export function ensureAutomationRefusedColumn(driver: SqlDriver): void {
  const row = driver
    .prepare(
      "SELECT COUNT(*) AS n FROM pragma_table_info('schema_meta') WHERE name = 'automation_refused'",
    )
    .get();
  const count = countOf(row);
  if (count === 0 || count === 0n) {
    driver.exec('ALTER TABLE schema_meta ADD COLUMN automation_refused INTEGER NOT NULL DEFAULT 0');
  }
}

export function schemaMetaExists(driver: SqlDriver): boolean {
  const row = driver
    .prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  return row !== undefined && row !== null;
}

export function readAutomationRefused(driver: SqlDriver): boolean {
  const row = driver.prepare('SELECT automation_refused FROM schema_meta WHERE id = 1').get();
  if (row === undefined || row === null || typeof row !== 'object') return false;
  const value = own(row, 'automation_refused');
  return value === 1 || value === 1n;
}

export function markAutomationRefused(driver: SqlDriver): void {
  driver.prepare('UPDATE schema_meta SET automation_refused = 1 WHERE id = 1').run();
}

function columnExists(driver: SqlDriver, table: string, name: string): boolean {
  const row = driver
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(name);
  const count = countOf(row);
  return count !== 0 && count !== 0n && count !== undefined;
}

export const SCHEMA_VERSION_2_SQL = `
CREATE TABLE IF NOT EXISTS evidence_row (
  workspace_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'current' CHECK (validity IN ('current', 'invalidated')),
  PRIMARY KEY (workspace_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS receipt_row (
  workspace_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'current' CHECK (validity IN ('current', 'invalidated')),
  evidence_id TEXT,
  PRIMARY KEY (workspace_id, receipt_id)
);

CREATE TABLE IF NOT EXISTS invalidation_edge (
  workspace_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_key TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
  PRIMARY KEY (workspace_id, from_kind, from_key, to_kind, to_id)
);
`;

export function ensureSchemaVersion2Tables(driver: SqlDriver): void {
  driver.exec(SCHEMA_VERSION_2_SQL);
}

export function ensureEffectColumns(driver: SqlDriver): void {
  const columns: readonly { readonly table: string; readonly name: string; readonly ddl: string }[] = [
    { table: 'decision_row', name: 'usage_known', ddl: 'ALTER TABLE decision_row ADD COLUMN usage_known INTEGER' },
    { table: 'decision_row', name: 'input_tokens', ddl: 'ALTER TABLE decision_row ADD COLUMN input_tokens INTEGER' },
    { table: 'decision_row', name: 'output_tokens', ddl: 'ALTER TABLE decision_row ADD COLUMN output_tokens INTEGER' },
    {
      table: 'decision_row',
      name: 'consumed_micro_usd',
      ddl: 'ALTER TABLE decision_row ADD COLUMN consumed_micro_usd INTEGER',
    },
    {
      table: 'decision_row',
      name: 'validity',
      ddl: "ALTER TABLE decision_row ADD COLUMN validity TEXT NOT NULL DEFAULT 'current'",
    },
    {
      table: 'outbox_entry',
      name: 'effect_status',
      ddl: "ALTER TABLE outbox_entry ADD COLUMN effect_status TEXT NOT NULL DEFAULT 'pending'",
    },
    {
      table: 'outbox_entry',
      name: 'acknowledgment',
      ddl: "ALTER TABLE outbox_entry ADD COLUMN acknowledgment TEXT NOT NULL DEFAULT 'absent'",
    },
    {
      table: 'outbox_entry',
      name: 'process_observed',
      ddl: "ALTER TABLE outbox_entry ADD COLUMN process_observed TEXT NOT NULL DEFAULT 'unknown'",
    },
  ];
  for (const column of columns) {
    if (!columnExists(driver, column.table, column.name)) driver.exec(column.ddl);
  }
}
