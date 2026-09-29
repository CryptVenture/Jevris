import { automationRefusedGuard, driverFor, type OpenStoreResult, type StoreRefusalReason } from './open.js';
import { markStale, publishCurrent } from './reconcile.js';
import { immediately, type SqlDriver } from './schema.js';
import { insertWorktree } from './worktree.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const TEXT_CAP = 512;
const EVIDENCE_BODY = 'stale';
const FEEDBACK_BODY = 'false-cancellation recorded';

const TASK_STATES = new Set([
  'proposed',
  'ready',
  'leased',
  'running',
  'awaiting-evidence',
  'verifying',
  'failed',
  'blocked',
  'cancelled',
]);

export const OWNED_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS worktree_row (
  workspace_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (workspace_id, worktree_id)
);

CREATE TABLE IF NOT EXISTS lease_row (
  workspace_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'proposed', 'ready', 'leased', 'running', 'awaiting-evidence',
    'verifying', 'failed', 'blocked', 'cancelled'
  )),
  directory TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  false_cancellation_feedback TEXT,
  PRIMARY KEY (workspace_id, lease_id),
  FOREIGN KEY (workspace_id, worktree_id)
    REFERENCES worktree_row (workspace_id, worktree_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lease_active_writer
  ON lease_row (workspace_id, resource_key)
  WHERE state IN ('leased', 'running');

CREATE TABLE IF NOT EXISTS lease_evidence (
  workspace_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  validity TEXT NOT NULL CHECK (validity = 'stale'),
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, evidence_id)
);
`;

class LeaseStop extends Error {
  readonly reason: 'refused' | 'invalid-input';

  constructor(reason: 'refused' | 'invalid-input') {
    super('stop');
    this.reason = reason;
  }
}

export interface IssuedLease {
  readonly ok: true;
  readonly leaseId: string;
  readonly taskId: string;
  readonly worktreeId: string;
  readonly fencingToken: bigint;
  readonly state: 'leased';
  readonly directory: string;
}

export type LeaseRefusal = {
  readonly ok: false;
  readonly reason: 'refused' | StoreRefusalReason;
};

export type IssueLeaseResult = IssuedLease | LeaseRefusal;

export interface LeaseRow {
  readonly leaseId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly worktreeId: string;
  readonly resourceKey: string;
  readonly fencingToken: bigint;
  readonly state: string;
  readonly directory: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly falseCancellationFeedback: string | null;
}

export interface LeaseEvidenceRow {
  readonly evidenceId: string;
  readonly leaseId: string;
  readonly fencingToken: bigint;
  readonly validity: 'stale';
  readonly body: string;
}

export interface StaleSuccessor {
  readonly state: 'ready';
  readonly worktreeId: string;
  readonly directory: string;
}

export interface StaleEvidenceResult {
  readonly ok: false;
  readonly reason: 'refused';
  readonly validity: 'stale';
  readonly published: false;
  readonly leaseState: 'blocked';
  readonly taskState: 'blocked';
  readonly successor: StaleSuccessor;
}

export type RecordStaleResult = StaleEvidenceResult | LeaseRefusal;

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isResource(value: unknown): value is string {
  return typeof value === 'string' && RESOURCE_PATTERN.test(value);
}

function isStamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
}

function isDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
}

function refusal(reason: LeaseRefusal['reason']): LeaseRefusal {
  return { ok: false, reason };
}

function asToken(value: unknown): bigint | undefined {
  if (typeof value !== 'bigint') return undefined;
  if (value < 1n) return undefined;
  return value;
}

export function ensureOwnedTables(driver: SqlDriver): void {
  driver.exec(OWNED_TABLES_SQL);
}

function guard(store: OpenStoreResult): LeaseRefusal | undefined {
  if (!store.ok) return refusal(store.reason);
  const blocked = automationRefusedGuard(store);
  if (blocked !== undefined) return refusal(blocked.reason);
  if (driverFor(store) === undefined) return refusal('store-unavailable');
  return undefined;
}

function nextToken(driver: SqlDriver, workspaceId: string): bigint {
  const row = driver
    .prepare(
      `SELECT fencing_token
       FROM lease_row
       WHERE workspace_id = ?
       ORDER BY fencing_token DESC
       LIMIT 1`,
    )
    .get(workspaceId);
  if (row === undefined || row === null) return 1n;
  if (typeof row !== 'object') throw new LeaseStop('refused');
  const token = asToken(own(row, 'fencing_token'));
  if (token === undefined) throw new LeaseStop('refused');
  return token + 1n;
}

function nextWorktreeId(driver: SqlDriver, workspaceId: string): string {
  const rows = driver
    .prepare('SELECT worktree_id FROM worktree_row WHERE workspace_id = ?')
    .all(workspaceId);
  const used = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const id = own(row, 'worktree_id');
    if (typeof id === 'string') used.add(id);
  }
  let n = used.size + 1;
  let id = `wt${n}`;
  while (used.has(id) || !isId(id)) {
    n += 1;
    id = `wt${n}`;
    if (n > 1000) throw new LeaseStop('refused');
  }
  return id;
}

function activeWriter(driver: SqlDriver, workspaceId: string, resourceKey: string): boolean {
  const row = driver
    .prepare(
      `SELECT 1 AS n
       FROM lease_row
       WHERE workspace_id = ? AND resource_key = ? AND state IN ('leased', 'running')
       LIMIT 1`,
    )
    .get(workspaceId, resourceKey);
  return row !== undefined && row !== null;
}

function crashedDirectory(driver: SqlDriver, workspaceId: string, directory: string): boolean {
  const row = driver
    .prepare(
      `SELECT 1 AS n
       FROM lease_row
       WHERE workspace_id = ? AND directory = ? AND state = 'blocked'
       LIMIT 1`,
    )
    .get(workspaceId, directory);
  return row !== undefined && row !== null;
}

export function issueLease(store: OpenStoreResult, input: unknown): IssueLeaseResult {
  const blocked = guard(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('store-unavailable');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('store-unavailable');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return refusal('invalid-input');
  const leaseId = own(input, 'leaseId');
  const taskId = own(input, 'taskId');
  const ownerId = own(input, 'ownerId');
  const resourceKey = own(input, 'resourceKey');
  const directory = own(input, 'directory');
  const heartbeatAt = own(input, 'heartbeatAt');
  const expiresAt = own(input, 'expiresAt');
  if (!isId(leaseId) || !isId(taskId) || !isId(ownerId)) return refusal('invalid-input');
  if (!isResource(resourceKey) || !isDirectory(directory) || !isStamp(heartbeatAt) || !isStamp(expiresAt)) {
    return refusal('invalid-input');
  }
  const workspaceId = store.workspaceId;
  let issued: IssuedLease | undefined;
  const run = driver.transaction(() => {
    if (activeWriter(driver, workspaceId, resourceKey)) throw new LeaseStop('refused');
    if (crashedDirectory(driver, workspaceId, directory)) throw new LeaseStop('refused');
    const fencingToken = nextToken(driver, workspaceId);
    const worktreeId = nextWorktreeId(driver, workspaceId);
    insertWorktree(driver, workspaceId, worktreeId, directory, 'leased');
    driver
      .prepare(
        `INSERT INTO lease_row (
           workspace_id, lease_id, task_id, owner_id, worktree_id, resource_key,
           fencing_token, state, directory, heartbeat_at, expires_at, false_cancellation_feedback
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'leased', ?, ?, ?, NULL)`,
      )
      .run(
        workspaceId,
        leaseId,
        taskId,
        ownerId,
        worktreeId,
        resourceKey,
        fencingToken,
        directory,
        heartbeatAt,
        expiresAt,
      );
    issued = {
      ok: true,
      leaseId,
      taskId,
      worktreeId,
      fencingToken,
      state: 'leased',
      directory,
    };
  });
  try {
    immediately(run);
  } catch (error) {
    if (error instanceof LeaseStop) return refusal(error.reason);
    return refusal('store-unavailable');
  }
  if (issued === undefined) return refusal('store-unavailable');
  return issued;
}

function loadLease(driver: SqlDriver, workspaceId: string, leaseId: string): LeaseRow | undefined {
  const row = driver
    .prepare(
      `SELECT lease_id, task_id, owner_id, worktree_id, resource_key, fencing_token, state,
              directory, heartbeat_at, expires_at, false_cancellation_feedback
       FROM lease_row
       WHERE workspace_id = ? AND lease_id = ?`,
    )
    .get(workspaceId, leaseId);
  return mapLease(row);
}

function mapLease(row: unknown): LeaseRow | undefined {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const leaseId = own(row, 'lease_id');
  const taskId = own(row, 'task_id');
  const ownerId = own(row, 'owner_id');
  const worktreeId = own(row, 'worktree_id');
  const resourceKey = own(row, 'resource_key');
  const fencingToken = asToken(own(row, 'fencing_token'));
  const state = own(row, 'state');
  const directory = own(row, 'directory');
  const heartbeatAt = own(row, 'heartbeat_at');
  const expiresAt = own(row, 'expires_at');
  const feedback = own(row, 'false_cancellation_feedback');
  if (!isId(leaseId) || !isId(taskId) || !isId(ownerId) || !isId(worktreeId)) return undefined;
  if (!isResource(resourceKey) || fencingToken === undefined) return undefined;
  if (typeof state !== 'string' || !TASK_STATES.has(state)) return undefined;
  if (!isDirectory(directory) || !isStamp(heartbeatAt) || !isStamp(expiresAt)) return undefined;
  const falseCancellationFeedback = feedback === null ? null : typeof feedback === 'string' ? capText(feedback) : null;
  return {
    leaseId,
    taskId,
    ownerId,
    worktreeId,
    resourceKey,
    fencingToken,
    state,
    directory,
    heartbeatAt,
    expiresAt,
    falseCancellationFeedback,
  };
}

function capText(text: string): string {
  if (text.length <= TEXT_CAP) return text;
  return text.slice(0, TEXT_CAP);
}

export function recordStaleResult(store: OpenStoreResult, input: unknown): RecordStaleResult {
  const blocked = guard(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('store-unavailable');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('store-unavailable');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return refusal('invalid-input');
  const leaseId = own(input, 'leaseId');
  const decisionId = own(input, 'decisionId');
  const evidenceId = own(input, 'evidenceId');
  const fencingToken = asToken(own(input, 'fencingToken'));
  if (!isId(leaseId) || !isId(decisionId) || !isId(evidenceId) || fencingToken === undefined) {
    return refusal('invalid-input');
  }
  const workspaceId = store.workspaceId;
  let successor: StaleSuccessor | undefined;
  const run = driver.transaction(() => {
    const current = loadLease(driver, workspaceId, leaseId);
    if (current === undefined || current.fencingToken !== fencingToken) throw new LeaseStop('refused');
    driver
      .prepare(
        `INSERT INTO lease_evidence (
           workspace_id, evidence_id, lease_id, fencing_token, validity, body
         ) VALUES (?, ?, ?, ?, 'stale', ?)`,
      )
      .run(workspaceId, evidenceId, leaseId, fencingToken, EVIDENCE_BODY);
    driver
      .prepare(
        `UPDATE lease_row
         SET state = 'blocked'
         WHERE workspace_id = ? AND lease_id = ?`,
      )
      .run(workspaceId, leaseId);
    const worktreeId = nextWorktreeId(driver, workspaceId);
    const directory = `reconciled-${worktreeId}`;
    insertWorktree(driver, workspaceId, worktreeId, directory, 'ready');
    const readyId = `ready${worktreeId}`;
    if (!isId(readyId)) throw new LeaseStop('refused');
    const readyToken = nextToken(driver, workspaceId);
    driver
      .prepare(
        `INSERT INTO lease_row (
           workspace_id, lease_id, task_id, owner_id, worktree_id, resource_key,
           fencing_token, state, directory, heartbeat_at, expires_at, false_cancellation_feedback
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, NULL)`,
      )
      .run(
        workspaceId,
        readyId,
        current.taskId,
        current.ownerId,
        worktreeId,
        current.resourceKey,
        readyToken,
        directory,
        current.heartbeatAt,
        current.expiresAt,
      );
    successor = { state: 'ready', worktreeId, directory };
  });
  try {
    immediately(run);
  } catch (error) {
    if (error instanceof LeaseStop) return refusal(error.reason);
    return refusal('store-unavailable');
  }
  const marked = markStale(store, decisionId);
  if (!marked.ok) return refusal('store-unavailable');
  const published = publishCurrent(store, decisionId);
  if (published.ok || successor === undefined) return refusal('refused');
  return {
    ok: false,
    reason: 'refused',
    validity: 'stale',
    published: false,
    leaseState: 'blocked',
    taskState: 'blocked',
    successor,
  };
}

export function readLeases(store: OpenStoreResult): readonly LeaseRow[] {
  if (!store.ok) return [];
  const driver = driverFor(store);
  if (driver === undefined) return [];
  const rows = driver
    .prepare(
      `SELECT lease_id, task_id, owner_id, worktree_id, resource_key, fencing_token, state,
              directory, heartbeat_at, expires_at, false_cancellation_feedback
       FROM lease_row
       WHERE workspace_id = ?`,
    )
    .all(store.workspaceId);
  const mapped: LeaseRow[] = [];
  for (const row of rows) {
    const lease = mapLease(row);
    if (lease !== undefined) mapped.push(lease);
  }
  return mapped;
}

export function readLeaseEvidence(store: OpenStoreResult): readonly LeaseEvidenceRow[] {
  if (!store.ok) return [];
  const driver = driverFor(store);
  if (driver === undefined) return [];
  const rows = driver
    .prepare(
      `SELECT evidence_id, lease_id, fencing_token, validity, body
       FROM lease_evidence
       WHERE workspace_id = ?`,
    )
    .all(store.workspaceId);
  const mapped: LeaseEvidenceRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const evidenceId = own(row, 'evidence_id');
    const leaseId = own(row, 'lease_id');
    const fencingToken = asToken(own(row, 'fencing_token'));
    const validity = own(row, 'validity');
    const body = own(row, 'body');
    if (!isId(evidenceId) || !isId(leaseId) || fencingToken === undefined) continue;
    if (validity !== 'stale' || typeof body !== 'string') continue;
    mapped.push({ evidenceId, leaseId, fencingToken, validity: 'stale', body: capText(body) });
  }
  return mapped;
}

export function recordFalseCancellation(
  store: OpenStoreResult,
  leaseId: string,
  owned: boolean,
): { readonly ok: true; readonly deletedWorktree: false } | LeaseRefusal {
  const blocked = guard(store);
  if (blocked !== undefined) return blocked;
  if (!store.ok) return refusal('store-unavailable');
  if (!owned || !isId(leaseId)) return refusal('refused');
  const driver = driverFor(store);
  if (driver === undefined) return refusal('store-unavailable');
  driver
    .prepare(
      `UPDATE lease_row
       SET state = 'cancelled', false_cancellation_feedback = ?
       WHERE workspace_id = ? AND lease_id = ?`,
    )
    .run(FEEDBACK_BODY, store.workspaceId, leaseId);
  return { ok: true, deletedWorktree: false };
}
