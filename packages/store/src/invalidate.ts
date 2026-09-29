import { automationRefusedGuard, driverFor, type OpenStoreResult } from './open.js';
import { immediately, type SqlDriver } from './schema.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SOURCE_KEYS = new Set(['sourceBody', 'sourceText', 'source', 'body', 'fileText']);
const EVIDENCE_KEYS = new Set(['workspaceId', 'evidenceId', 'contentHash', 'sourceRevision']);
const RECEIPT_KEYS = new Set(['workspaceId', 'receiptId', 'sourceRevision', 'evidenceId']);
const EDGE_KEYS = new Set(['workspaceId', 'fromKind', 'fromKey', 'toKind', 'toId', 'resolved']);

const NO_ROWS: readonly [] = [];

export interface GraphRow {
  readonly kind: 'receipt' | 'evidence';
  readonly id: string;
  readonly workspaceId: string;
  readonly validity: 'current' | 'invalidated';
  readonly sourceRevision: string;
  readonly contentHash: string | null;
}

export interface EdgeRow {
  readonly workspaceId: string;
  readonly fromKind: string;
  readonly fromKey: string;
  readonly toKind: 'receipt' | 'evidence';
  readonly toId: string;
  readonly resolved: 0 | 1;
}

export type MutationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'migration-refused' | 'invalid-input' | 'source-body-refused' | 'refused' | 'store-full' | 'store-corrupt' | 'store-io' | 'store-readonly';
    };

export type ListResult =
  | { readonly ok: true; readonly rows: readonly GraphRow[] }
  | { readonly ok: false; readonly reason: 'refused'; readonly rows: readonly [] };

export type EdgeListResult =
  | { readonly ok: true; readonly rows: readonly EdgeRow[] }
  | { readonly ok: false; readonly reason: 'refused'; readonly rows: readonly [] };

function refusal(reason: 'invalid-input' | 'source-body-refused' | 'refused'): MutationResult {
  return { ok: false, reason };
}

function emptyList(): ListResult {
  return { ok: false, reason: 'refused', rows: NO_ROWS };
}

function emptyEdges(): EdgeListResult {
  return { ok: false, reason: 'refused', rows: NO_ROWS };
}

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

function asObject(input: unknown): object | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input;
}

function fieldRefusal(
  input: object,
  allowed: ReadonlySet<string>,
): 'source-body-refused' | 'invalid-input' | undefined {
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (typeof key !== 'string' || SOURCE_KEYS.has(key)) return 'source-body-refused';
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return 'invalid-input';
  }
  return undefined;
}

function asResolved(value: unknown): 0 | 1 | undefined {
  if (value === 0 || value === 0n) return 0;
  if (value === 1 || value === 1n) return 1;
  return undefined;
}

function asKind(value: unknown): 'receipt' | 'evidence' | undefined {
  if (value === 'receipt' || value === 'evidence') return value;
  return undefined;
}

function asValidity(value: unknown): 'current' | 'invalidated' | undefined {
  if (value === 'current' || value === 'invalidated') return value;
  return undefined;
}

function readWorkspaceId(input: unknown): string | undefined | 'invalid' {
  if (input === undefined || input === null) return undefined;
  const record = asObject(input);
  if (record === undefined) return 'invalid';
  if (!Object.hasOwn(record, 'workspaceId')) return undefined;
  const value = own(record, 'workspaceId');
  if (!isId(value)) return 'invalid';
  return value;
}

function scopeRead(input: unknown): string | undefined {
  const requested = readWorkspaceId(input);
  if (typeof requested !== 'string') return undefined;
  return requested;
}

function requireWriteWorkspace(
  store: Extract<OpenStoreResult, { ok: true }>,
  input: object,
): string | MutationResult {
  const requested = readWorkspaceId(input);
  if (requested === undefined || requested === 'invalid') return refusal('refused');
  if (requested !== store.workspaceId) return refusal('invalid-input');
  return requested;
}

function blockedWrite(store: OpenStoreResult): MutationResult | undefined {
  const blocked = automationRefusedGuard(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('invalid-input');
  if (driverFor(store) === undefined) return refusal('invalid-input');
  return undefined;
}

function exists(driver: SqlDriver, sql: string, ...params: readonly unknown[]): boolean {
  const row = driver.prepare(sql).get(...params);
  return row !== undefined && row !== null;
}

function unresolvedEdge(
  driver: SqlDriver,
  workspaceId: string,
  toKind: 'receipt' | 'evidence',
  toId: string,
): boolean {
  return exists(
    driver,
    `SELECT 1 AS n FROM invalidation_edge
     WHERE workspace_id = ? AND to_kind = ? AND to_id = ? AND resolved = 0
     LIMIT 1`,
    workspaceId,
    toKind,
    toId,
  );
}

export function putEvidence(store: OpenStoreResult, input?: unknown): MutationResult {
  const blocked = blockedWrite(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('invalid-input');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('invalid-input');
  const record = asObject(input);
  if (record === undefined) return refusal('invalid-input');
  const fields = fieldRefusal(record, EVIDENCE_KEYS);
  if (fields !== undefined) return refusal(fields);
  const workspace = requireWriteWorkspace(store, record);
  if (typeof workspace !== 'string') return workspace;
  const evidenceId = own(record, 'evidenceId');
  const contentHash = own(record, 'contentHash');
  const sourceRevision = own(record, 'sourceRevision');
  if (!isId(evidenceId) || !isKey(contentHash) || !isKey(sourceRevision)) return refusal('invalid-input');
  const validity = unresolvedEdge(driver, workspace, 'evidence', evidenceId) ? 'invalidated' : 'current';
  const written = { ok: false };
  const run = driver.transaction(() => {
    if (
      exists(
        driver,
        'SELECT 1 AS n FROM evidence_row WHERE workspace_id = ? AND evidence_id = ?',
        workspace,
        evidenceId,
      )
    ) {
      return;
    }
    driver
      .prepare(
        `INSERT INTO evidence_row (
           workspace_id, evidence_id, content_hash, source_revision, validity
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workspace, evidenceId, contentHash, sourceRevision, validity);
    written.ok = true;
  });
  immediately(run);
  if (!written.ok) return refusal('invalid-input');
  return { ok: true };
}

export function putReceipt(store: OpenStoreResult, input?: unknown): MutationResult {
  const blocked = blockedWrite(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('invalid-input');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('invalid-input');
  const record = asObject(input);
  if (record === undefined) return refusal('invalid-input');
  const fields = fieldRefusal(record, RECEIPT_KEYS);
  if (fields !== undefined) return refusal(fields);
  const workspace = requireWriteWorkspace(store, record);
  if (typeof workspace !== 'string') return workspace;
  const receiptId = own(record, 'receiptId');
  const sourceRevision = own(record, 'sourceRevision');
  const evidenceId = own(record, 'evidenceId');
  if (!isId(receiptId) || !isKey(sourceRevision)) return refusal('invalid-input');
  if (evidenceId !== undefined && !isId(evidenceId)) return refusal('invalid-input');
  const validity = unresolvedEdge(driver, workspace, 'receipt', receiptId) ? 'invalidated' : 'current';
  const written = { ok: false };
  const run = driver.transaction(() => {
    if (
      exists(
        driver,
        'SELECT 1 AS n FROM receipt_row WHERE workspace_id = ? AND receipt_id = ?',
        workspace,
        receiptId,
      )
    ) {
      return;
    }
    driver
      .prepare(
        `INSERT INTO receipt_row (
           workspace_id, receipt_id, source_revision, validity, evidence_id
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workspace, receiptId, sourceRevision, validity, evidenceId === undefined ? null : evidenceId);
    written.ok = true;
  });
  immediately(run);
  if (!written.ok) return refusal('invalid-input');
  return { ok: true };
}

export function insertInvalidationEdge(store: OpenStoreResult, input?: unknown): MutationResult {
  const blocked = blockedWrite(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('invalid-input');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('invalid-input');
  const record = asObject(input);
  if (record === undefined) return refusal('invalid-input');
  const fields = fieldRefusal(record, EDGE_KEYS);
  if (fields !== undefined) return refusal(fields);
  const workspace = requireWriteWorkspace(store, record);
  if (typeof workspace !== 'string') return workspace;
  const fromKind = own(record, 'fromKind');
  const fromKey = own(record, 'fromKey');
  const toKind = asKind(own(record, 'toKind'));
  const toId = own(record, 'toId');
  const resolved = asResolved(own(record, 'resolved'));
  if (!isKey(fromKind) || !isKey(fromKey) || toKind === undefined || !isId(toId) || resolved === undefined) {
    return refusal('invalid-input');
  }
  const written = { ok: false };
  const run = driver.transaction(() => {
    if (
      exists(
        driver,
        `SELECT 1 AS n FROM invalidation_edge
         WHERE workspace_id = ? AND from_kind = ? AND from_key = ? AND to_kind = ? AND to_id = ?`,
        workspace,
        fromKind,
        fromKey,
        toKind,
        toId,
      )
    ) {
      return;
    }
    driver
      .prepare(
        `INSERT INTO invalidation_edge (
           workspace_id, from_kind, from_key, to_kind, to_id, resolved
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspace, fromKind, fromKey, toKind, toId, BigInt(resolved));
    if (resolved === 0) invalidateOne(driver, workspace, toKind, toId);
    written.ok = true;
  });
  immediately(run);
  if (!written.ok) return refusal('invalid-input');
  return { ok: true };
}

function invalidateOne(
  driver: SqlDriver,
  workspaceId: string,
  toKind: 'receipt' | 'evidence',
  toId: string,
): void {
  if (toKind === 'receipt') {
    driver
      .prepare(
        `UPDATE receipt_row SET validity = 'invalidated'
         WHERE workspace_id = ? AND receipt_id = ?`,
      )
      .run(workspaceId, toId);
    return;
  }
  driver
    .prepare(
      `UPDATE evidence_row SET validity = 'invalidated'
       WHERE workspace_id = ? AND evidence_id = ?`,
    )
    .run(workspaceId, toId);
}

export function reviseSource(
  store: OpenStoreResult,
  previousRevision?: unknown,
  nextRevision?: unknown,
): MutationResult {
  const blocked = blockedWrite(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('invalid-input');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('invalid-input');
  if (!isKey(previousRevision) || !isKey(nextRevision)) return refusal('invalid-input');
  const workspaceId = store.workspaceId;
  const changed = previousRevision !== nextRevision;
  const run = driver.transaction(() => {
    if (changed) {
      invalidateResolved(driver, workspaceId, previousRevision);
    }
    invalidateUnresolved(driver, workspaceId);
  });
  immediately(run);
  return { ok: true };
}

function invalidateResolved(driver: SqlDriver, workspaceId: string, previousRevision: string): void {
  driver
    .prepare(
      `UPDATE receipt_row
       SET validity = 'invalidated'
       WHERE workspace_id = ?
         AND receipt_id IN (
           SELECT to_id FROM invalidation_edge
           WHERE workspace_id = ?
             AND to_kind = 'receipt'
             AND resolved = 1
             AND from_key = ?
         )`,
    )
    .run(workspaceId, workspaceId, previousRevision);
  driver
    .prepare(
      `UPDATE evidence_row
       SET validity = 'invalidated'
       WHERE workspace_id = ?
         AND evidence_id IN (
           SELECT to_id FROM invalidation_edge
           WHERE workspace_id = ?
             AND to_kind = 'evidence'
             AND resolved = 1
             AND from_key = ?
         )`,
    )
    .run(workspaceId, workspaceId, previousRevision);
}

function invalidateUnresolved(driver: SqlDriver, workspaceId: string): void {
  driver
    .prepare(
      `UPDATE receipt_row
       SET validity = 'invalidated'
       WHERE workspace_id = ?
         AND receipt_id IN (
           SELECT to_id FROM invalidation_edge
           WHERE workspace_id = ?
             AND to_kind = 'receipt'
             AND resolved = 0
         )`,
    )
    .run(workspaceId, workspaceId);
  driver
    .prepare(
      `UPDATE evidence_row
       SET validity = 'invalidated'
       WHERE workspace_id = ?
         AND evidence_id IN (
           SELECT to_id FROM invalidation_edge
           WHERE workspace_id = ?
             AND to_kind = 'evidence'
             AND resolved = 0
         )`,
    )
    .run(workspaceId, workspaceId);
}

export function listCurrent(store: OpenStoreResult, input?: unknown): ListResult {
  return listRows(store, input, false);
}

export function listRetained(store: OpenStoreResult, input?: unknown): ListResult {
  return listRows(store, input, true);
}

function listRows(store: OpenStoreResult, input: unknown, retained: boolean): ListResult {
  if (!store.ok) return emptyList();
  const driver = driverFor(store);
  if (driver === undefined) return emptyList();
  const workspaceId = scopeRead(input);
  if (workspaceId === undefined) return emptyList();
  const validitySql = retained ? '' : " AND validity = 'current'";
  const receipts = driver
    .prepare(
      `SELECT receipt_id AS id, workspace_id, validity, source_revision, NULL AS content_hash
       FROM receipt_row
       WHERE workspace_id = ?${validitySql}
       ORDER BY receipt_id`,
    )
    .all(workspaceId);
  const evidence = driver
    .prepare(
      `SELECT evidence_id AS id, workspace_id, validity, source_revision, content_hash
       FROM evidence_row
       WHERE workspace_id = ?${validitySql}
       ORDER BY evidence_id`,
    )
    .all(workspaceId);
  const rows: GraphRow[] = [];
  for (const row of receipts) {
    const mapped = mapGraph(row, 'receipt');
    if (mapped !== undefined) rows.push(mapped);
  }
  for (const row of evidence) {
    const mapped = mapGraph(row, 'evidence');
    if (mapped !== undefined) rows.push(mapped);
  }
  return { ok: true, rows };
}

function mapGraph(row: unknown, kind: 'receipt' | 'evidence'): GraphRow | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const id = own(row, 'id');
  const workspaceId = own(row, 'workspace_id');
  const validity = asValidity(own(row, 'validity'));
  const sourceRevision = own(row, 'source_revision');
  const contentHash = own(row, 'content_hash');
  if (typeof id !== 'string' || typeof workspaceId !== 'string') return undefined;
  if (validity === undefined || typeof sourceRevision !== 'string') return undefined;
  if (contentHash !== null && typeof contentHash !== 'string') return undefined;
  return { kind, id, workspaceId, validity, sourceRevision, contentHash };
}

export function listEdges(store: OpenStoreResult, input?: unknown): EdgeListResult {
  if (!store.ok) return emptyEdges();
  const driver = driverFor(store);
  if (driver === undefined) return emptyEdges();
  const workspaceId = scopeRead(input);
  if (workspaceId === undefined) return emptyEdges();
  const found = driver
    .prepare(
      `SELECT workspace_id, from_kind, from_key, to_kind, to_id, resolved
       FROM invalidation_edge
       WHERE workspace_id = ?
       ORDER BY from_kind, from_key, to_kind, to_id`,
    )
    .all(workspaceId);
  const rows: EdgeRow[] = [];
  for (const row of found) {
    const mapped = mapEdge(row);
    if (mapped !== undefined) rows.push(mapped);
  }
  return { ok: true, rows };
}

function mapEdge(row: unknown): EdgeRow | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const workspaceId = own(row, 'workspace_id');
  const fromKind = own(row, 'from_kind');
  const fromKey = own(row, 'from_key');
  const toKind = asKind(own(row, 'to_kind'));
  const toId = own(row, 'to_id');
  const resolved = asResolved(own(row, 'resolved'));
  if (typeof workspaceId !== 'string' || typeof fromKind !== 'string' || typeof fromKey !== 'string') {
    return undefined;
  }
  if (toKind === undefined || typeof toId !== 'string' || resolved === undefined) return undefined;
  return { workspaceId, fromKind, fromKey, toKind, toId, resolved };
}
