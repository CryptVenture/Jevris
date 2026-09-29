/**
 * The durable model (DATA-02, SSOT §17.1): workspace by root identity, session, append-only
 * event with a unique delivery key and a size cap, the capsule index (a new version on
 * changed content) and outbox retry state with bounded retries.
 */
import type { OpenStoreResult, StoreRefusal } from './open.js';
import {
  StoreStop,
  field,
  isHash,
  isId,
  isKey,
  isMs,
  nullableNum,
  nullableStr,
  num,
  read,
  refuse,
  str,
  write,
} from './access.js';
import { noteSessionEvent } from './learning.js';
import { dropLink } from './session-link.js';

export const EVENT_PAYLOAD_CAP = 65_536;
export const OUTBOX_DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 300_000;

// ---------------------------------------------------------------- workspace

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly rootIdentity: string;
  readonly rootPath: string;
  readonly trust: 'untrusted' | 'trusted' | 'restricted';
  readonly egressPolicy: 'deny' | 'allowlist' | 'allow';
  readonly configRevision: string;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
}

function workspaceRow(row: unknown): WorkspaceRow | undefined {
  const workspaceId = str(field(row, 'workspace_id'));
  const rootIdentity = str(field(row, 'root_identity'));
  const rootPath = str(field(row, 'root_path'));
  const trust = str(field(row, 'trust'));
  const egressPolicy = str(field(row, 'egress_policy'));
  if (workspaceId === undefined || rootIdentity === undefined || rootPath === undefined) return undefined;
  return {
    workspaceId,
    rootIdentity,
    rootPath,
    trust: trust === 'trusted' || trust === 'restricted' ? trust : 'untrusted',
    egressPolicy: egressPolicy === 'allow' || egressPolicy === 'allowlist' ? egressPolicy : 'deny',
    configRevision: str(field(row, 'config_revision')) ?? '',
    createdAtMs: num(field(row, 'created_at_ms')) ?? 0,
    lastSeenAtMs: num(field(row, 'last_seen_at_ms')) ?? 0,
  };
}

/**
 * Registers a workspace by its root identity (device and inode hash, never the path alone).
 * The same identity at a new path keeps its id and updates the path; a different id for a
 * known identity is a conflict. Only the host store handle (the sidecar's) may register.
 */
export function registerWorkspace(
  store: OpenStoreResult,
  input: { readonly workspaceId: string; readonly rootIdentity: string; readonly rootPath: string; readonly nowMs: number },
): { readonly ok: true; readonly workspace: WorkspaceRow; readonly created: boolean } | StoreRefusal {
  if (!isId(input.workspaceId) || !isKey(input.rootIdentity) || typeof input.rootPath !== 'string' || input.rootPath.length === 0 || input.rootPath.length > 4096 || !isMs(input.nowMs)) {
    return refuse('invalid-input');
  }
  if (store.ok && store.workspaceId !== 'host' && store.workspaceId !== input.workspaceId) return refuse('invalid-input');
  return write(store, ({ driver }) => {
    const existing = workspaceRow(driver.prepare('SELECT * FROM workspace WHERE root_identity = ?').get(input.rootIdentity));
    if (existing !== undefined) {
      if (existing.workspaceId !== input.workspaceId) throw new StoreStop('conflict');
      driver.prepare('UPDATE workspace SET root_path = ?, last_seen_at_ms = ? WHERE workspace_id = ?').run(input.rootPath, input.nowMs, input.workspaceId);
      return { ok: true as const, workspace: { ...existing, rootPath: input.rootPath, lastSeenAtMs: input.nowMs }, created: false };
    }
    const byId = driver.prepare('SELECT 1 AS n FROM workspace WHERE workspace_id = ?').get(input.workspaceId);
    if (byId !== undefined) throw new StoreStop('conflict');
    driver
      .prepare('INSERT INTO workspace (workspace_id, root_identity, root_path, created_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(input.workspaceId, input.rootIdentity, input.rootPath, input.nowMs, input.nowMs);
    const created = workspaceRow(driver.prepare('SELECT * FROM workspace WHERE workspace_id = ?').get(input.workspaceId));
    if (created === undefined) throw new StoreStop('store-unavailable');
    return { ok: true as const, workspace: created, created: true };
  });
}

export function getWorkspace(store: OpenStoreResult, workspaceId: string): WorkspaceRow | undefined {
  if (!isId(workspaceId)) return undefined;
  const result = read(store, ({ driver }) => workspaceRow(driver.prepare('SELECT * FROM workspace WHERE workspace_id = ?').get(workspaceId)));
  return result !== undefined && !Object.hasOwn(result, 'ok') ? (result as WorkspaceRow) : undefined;
}

export function listWorkspaces(store: OpenStoreResult): readonly WorkspaceRow[] {
  const result = read(store, ({ driver }) =>
    driver
      .prepare('SELECT * FROM workspace ORDER BY created_at_ms, workspace_id')
      .all()
      .map(workspaceRow)
      .filter((w): w is WorkspaceRow => w !== undefined),
  );
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------- session

export interface SessionInput {
  readonly sessionId: string;
  readonly harness: string;
  readonly harnessVersion?: string | null;
  readonly requestedModel?: string | null;
  /** The model the harness actually ran; null or absent stays unknown (never guessed). */
  readonly actualModel?: string | null;
  readonly state: 'active' | 'ended' | 'unknown';
  readonly atMs: number;
  /** The event kind that carried this (a code), for the session's model-change record (P5). */
  readonly source?: string;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly harness: string;
  readonly harnessVersion: string | null;
  readonly requestedModel: string | null;
  readonly actualModel: string | null;
  readonly state: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 _.:/@+-]{0,127}$/;

function optionalLabel(value: unknown): string | null | 'bad' {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && LABEL.test(value) ? value : 'bad';
}

/**
 * Records a session. A later write fills in values that were unknown but never replaces a
 * known actual model with unknown.
 */
export function recordSession(store: OpenStoreResult, input: SessionInput): { readonly ok: true } | StoreRefusal {
  const harnessVersion = optionalLabel(input.harnessVersion);
  const requestedModel = optionalLabel(input.requestedModel);
  const actualModel = optionalLabel(input.actualModel);
  if (!isKey(input.sessionId) || typeof input.harness !== 'string' || !LABEL.test(input.harness) || harnessVersion === 'bad' || requestedModel === 'bad' || actualModel === 'bad') return refuse('invalid-input');
  if (!['active', 'ended', 'unknown'].includes(input.state) || !isMs(input.atMs)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const previousModel = nullableStr(field(driver.prepare('SELECT actual_model FROM session WHERE workspace_id = ? AND session_id = ?').get(workspaceId, input.sessionId), 'actual_model'));
    driver
      .prepare(
        `INSERT INTO session (workspace_id, session_id, harness, harness_version, requested_model, actual_model, state, started_at_ms, ended_at_ms, last_seen_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, session_id) DO UPDATE SET
           harness_version = COALESCE(excluded.harness_version, session.harness_version),
           requested_model = COALESCE(excluded.requested_model, session.requested_model),
           actual_model = COALESCE(excluded.actual_model, session.actual_model),
           state = excluded.state,
           ended_at_ms = CASE WHEN excluded.state = 'ended' THEN excluded.ended_at_ms ELSE session.ended_at_ms END,
           last_seen_at_ms = MAX(COALESCE(session.last_seen_at_ms, 0), excluded.last_seen_at_ms)`,
      )
      .run(workspaceId, input.sessionId, input.harness, harnessVersion, requestedModel, actualModel, input.state, input.atMs, input.state === 'ended' ? input.atMs : null, input.atMs);
    // Owner 29423b6: a session's task link ends with the session.
    if (input.state === 'ended') dropLink(driver, workspaceId, input.sessionId, { actor: 'sidecar', channel: 'system', atMs: input.atMs });
    // P5: a change of the known actual model is appended, and the session's open model advice
    // is resolved (followed, overridden, or no change at the session's end).
    noteSessionEvent(driver, workspaceId, { sessionId: input.sessionId, previousModel, actualModel, ended: input.state === 'ended', atMs: input.atMs, source: input.source ?? 'unknown' });
    return { ok: true as const };
  });
}

export function getSession(store: OpenStoreResult, sessionId: string): SessionRow | undefined {
  if (!isKey(sessionId)) return undefined;
  const result = read(store, ({ driver, workspaceId }) => {
    const row = driver.prepare('SELECT * FROM session WHERE workspace_id = ? AND session_id = ?').get(workspaceId, sessionId);
    if (row === undefined) return undefined;
    return {
      sessionId,
      harness: str(field(row, 'harness')) ?? '',
      harnessVersion: nullableStr(field(row, 'harness_version')),
      requestedModel: nullableStr(field(row, 'requested_model')),
      actualModel: nullableStr(field(row, 'actual_model')),
      state: str(field(row, 'state')) ?? 'unknown',
      startedAtMs: num(field(row, 'started_at_ms')) ?? 0,
      endedAtMs: nullableNum(field(row, 'ended_at_ms')),
    };
  });
  return result !== undefined && !Object.hasOwn(result, 'ok') ? (result as SessionRow) : undefined;
}

/**
 * W09: native harness sessions seen since `sinceMs` (started then, or still active), for status
 * to report as outside Jevris ownership. Counts only; nothing about a session's content. With the
 * host view, `workspaceId` narrows to one workspace.
 */
export function countNativeSessions(store: OpenStoreResult, filter: { readonly sinceMs: number; readonly workspaceId?: string }): number | StoreRefusal {
  if (!isMs(filter.sinceMs)) return refuse('invalid-input');
  return read(store, ({ driver, workspaceId }) => {
    const ws = workspaceId === 'host' ? filter.workspaceId : workspaceId;
    const where = "(started_at_ms >= ? OR state = 'active' OR ended_at_ms >= ?)";
    const row = ws === undefined
      ? driver.prepare(`SELECT COUNT(*) AS n FROM session WHERE ${where}`).get(filter.sinceMs, filter.sinceMs)
      : driver.prepare(`SELECT COUNT(*) AS n FROM session WHERE workspace_id = ? AND ${where}`).get(ws, filter.sinceMs, filter.sinceMs);
    return num(field(row, 'n')) ?? 0;
  });
}

// ---------------------------------------------------------------- event

export interface EventInput {
  readonly deliveryKey: string;
  readonly sessionId?: string | null;
  readonly nativeKind: string;
  readonly revision?: string | null;
  /** sha256 of the redacted payload; the payload itself is never stored here. */
  readonly payloadHash: string;
  readonly payloadBytes: number;
  readonly receivedAtMs: number;
}

export type AppendEventResult = { readonly ok: true; readonly seq: number; readonly duplicate: boolean } | StoreRefusal;

export interface AppendEventOptions {
  /**
   * How long a delivery key marks a repeat as a redelivery. Without it a key dedups for as long
   * as its row is kept. With it, a repeat whose receivedAtMs is at or after the latest row for the
   * key and less than the window later is a duplicate; a later one is a new event, stored under
   * `<key>#<seq>` (`#` is outside the key alphabet, so no caller key can collide with it).
   */
  readonly dedupWindowMs?: number;
}

/**
 * Appends one event. The delivery key is unique per workspace: a redelivery returns the
 * original sequence (`duplicate: true`) and writes nothing. Events are append-only (a
 * trigger refuses UPDATE and DELETE outside retention).
 */
export function appendEvent(store: OpenStoreResult, input: EventInput, options: AppendEventOptions = {}): AppendEventResult {
  if (!isKey(input.deliveryKey) || typeof input.nativeKind !== 'string' || !LABEL.test(input.nativeKind) || !isHash(input.payloadHash) || !isMs(input.receivedAtMs)) return refuse('invalid-input');
  if (!Number.isSafeInteger(input.payloadBytes) || input.payloadBytes < 0) return refuse('invalid-input');
  if (input.payloadBytes > EVENT_PAYLOAD_CAP) return refuse('oversize');
  const sessionId = input.sessionId ?? null;
  if (sessionId !== null && !isKey(sessionId)) return refuse('invalid-input');
  const revision = input.revision ?? null;
  if (revision !== null && !isKey(revision)) return refuse('invalid-input');
  const windowMs = options.dedupWindowMs;
  if (windowMs !== undefined && (!Number.isSafeInteger(windowMs) || windowMs <= 0)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    let storedKey = input.deliveryKey;
    if (windowMs === undefined) {
      const existing = driver.prepare('SELECT seq FROM event WHERE workspace_id = ? AND delivery_key = ?').get(workspaceId, input.deliveryKey);
      if (existing !== undefined) return { ok: true as const, seq: num(field(existing, 'seq')) ?? 0, duplicate: true };
    } else {
      // The latest row for this key: the key itself or a later `<key>#<seq>` ('$' follows '#').
      const latest = driver
        .prepare('SELECT seq, received_at_ms FROM event WHERE workspace_id = ? AND (delivery_key = ? OR (delivery_key >= ? AND delivery_key < ?)) ORDER BY seq DESC LIMIT 1')
        .get(workspaceId, input.deliveryKey, `${input.deliveryKey}#`, `${input.deliveryKey}$`);
      if (latest !== undefined) {
        const seq = num(field(latest, 'seq')) ?? 0;
        const at = num(field(latest, 'received_at_ms')) ?? 0;
        if (input.receivedAtMs >= at && input.receivedAtMs - at < windowMs) return { ok: true as const, seq, duplicate: true };
        storedKey = '';
      }
    }
    const next = (num(field(driver.prepare('SELECT MAX(seq) AS m FROM event WHERE workspace_id = ?').get(workspaceId), 'm')) ?? 0) + 1;
    if (storedKey === '') storedKey = `${input.deliveryKey}#${next}`;
    driver
      .prepare('INSERT INTO event (workspace_id, seq, delivery_key, session_id, native_kind, revision, payload_hash, payload_bytes, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, next, storedKey, sessionId, input.nativeKind, revision, input.payloadHash, input.payloadBytes, input.receivedAtMs);
    return { ok: true as const, seq: next, duplicate: false };
  });
}

export function countEvents(store: OpenStoreResult): number {
  const result = read(store, ({ driver, workspaceId }) => num(field(driver.prepare('SELECT COUNT(*) AS n FROM event WHERE workspace_id = ?').get(workspaceId), 'n')) ?? 0);
  return typeof result === 'number' ? result : 0;
}

// ---------------------------------------------------------------- capsule index

export interface CapsuleInput {
  readonly capsuleId: string;
  readonly taskId?: string | null;
  readonly encoderVersion: string;
  readonly contentHash: string;
  readonly retentionClass?: 'standard' | 'pinned';
  readonly nowMs: number;
}

export interface CapsuleRow {
  readonly capsuleId: string;
  readonly version: number;
  readonly taskId: string | null;
  readonly encoderVersion: string;
  readonly contentHash: string;
  readonly retentionClass: 'standard' | 'pinned';
  readonly validity: 'current' | 'invalidated' | 'superseded';
  readonly createdAtMs: number;
}

function capsuleRow(row: unknown): CapsuleRow | undefined {
  const capsuleId = str(field(row, 'capsule_id'));
  const version = num(field(row, 'version'));
  if (capsuleId === undefined || version === undefined) return undefined;
  const validity = str(field(row, 'validity'));
  return {
    capsuleId,
    version,
    taskId: nullableStr(field(row, 'task_id')),
    encoderVersion: str(field(row, 'encoder_version')) ?? '',
    contentHash: str(field(row, 'content_hash')) ?? '',
    retentionClass: field(row, 'retention_class') === 'pinned' ? 'pinned' : 'standard',
    validity: validity === 'invalidated' || validity === 'superseded' ? validity : 'current',
    createdAtMs: num(field(row, 'created_at_ms')) ?? 0,
  };
}

/**
 * Indexes a capsule. Changed content (hash) or encoder makes a new version and supersedes
 * the previous one; the same content returns the current version.
 */
export function putCapsule(store: OpenStoreResult, input: CapsuleInput): { readonly ok: true; readonly capsule: CapsuleRow; readonly created: boolean } | StoreRefusal {
  const taskId = input.taskId ?? null;
  const retentionClass = input.retentionClass ?? 'standard';
  if (!isId(input.capsuleId) || (taskId !== null && !isId(taskId)) || !isKey(input.encoderVersion) || !isHash(input.contentHash) || !isMs(input.nowMs)) return refuse('invalid-input');
  if (retentionClass !== 'standard' && retentionClass !== 'pinned') return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const current = capsuleRow(
      driver.prepare("SELECT * FROM capsule_index WHERE workspace_id = ? AND capsule_id = ? AND validity = 'current' ORDER BY version DESC LIMIT 1").get(workspaceId, input.capsuleId),
    );
    if (current !== undefined && current.contentHash === input.contentHash && current.encoderVersion === input.encoderVersion) {
      if (current.retentionClass !== retentionClass && input.retentionClass !== undefined) {
        // Pinning changes the retention class only (it is not content): same version.
        driver.prepare('UPDATE capsule_index SET retention_class = ? WHERE workspace_id = ? AND capsule_id = ?').run(retentionClass, workspaceId, input.capsuleId);
        return { ok: true as const, capsule: { ...current, retentionClass }, created: false };
      }
      return { ok: true as const, capsule: current, created: false };
    }
    const last = num(field(driver.prepare('SELECT MAX(version) AS v FROM capsule_index WHERE workspace_id = ? AND capsule_id = ?').get(workspaceId, input.capsuleId), 'v')) ?? 0;
    driver.prepare("UPDATE capsule_index SET validity = 'superseded' WHERE workspace_id = ? AND capsule_id = ? AND validity = 'current'").run(workspaceId, input.capsuleId);
    driver
      .prepare('INSERT INTO capsule_index (workspace_id, capsule_id, version, task_id, encoder_version, content_hash, retention_class, validity, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, input.capsuleId, last + 1, taskId, input.encoderVersion, input.contentHash, retentionClass, 'current', input.nowMs);
    const capsule = capsuleRow(driver.prepare('SELECT * FROM capsule_index WHERE workspace_id = ? AND capsule_id = ? AND version = ?').get(workspaceId, input.capsuleId, last + 1));
    if (capsule === undefined) throw new StoreStop('store-unavailable');
    return { ok: true as const, capsule, created: true };
  });
}

export function currentCapsule(store: OpenStoreResult, capsuleId: string): CapsuleRow | undefined {
  if (!isId(capsuleId)) return undefined;
  const result = read(store, ({ driver, workspaceId }) =>
    capsuleRow(driver.prepare("SELECT * FROM capsule_index WHERE workspace_id = ? AND capsule_id = ? AND validity = 'current' ORDER BY version DESC LIMIT 1").get(workspaceId, capsuleId)),
  );
  return result !== undefined && !Object.hasOwn(result, 'ok') ? (result as CapsuleRow) : undefined;
}

/** Pins or unpins the current capsule (the pinned-memory retention class, DATA-11). */
export function setCapsuleRetention(store: OpenStoreResult, capsuleId: string, retentionClass: 'standard' | 'pinned'): { readonly ok: true } | StoreRefusal {
  if (!isId(capsuleId) || (retentionClass !== 'standard' && retentionClass !== 'pinned')) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const changed = driver.prepare('UPDATE capsule_index SET retention_class = ? WHERE workspace_id = ? AND capsule_id = ?').run(retentionClass, workspaceId, capsuleId);
    if (num(field(changed, 'changes')) === 0) throw new StoreStop('not-found');
    return { ok: true as const };
  });
}

export function invalidateCapsule(store: OpenStoreResult, capsuleId: string): { readonly ok: true } | StoreRefusal {
  if (!isId(capsuleId)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    driver.prepare("UPDATE capsule_index SET validity = 'invalidated' WHERE workspace_id = ? AND capsule_id = ? AND validity = 'current'").run(workspaceId, capsuleId);
    return { ok: true as const };
  });
}

/**
 * DATA-12 `data delete --scope capsules`: removes capsule index rows, pinned ones included (the
 * person asked for the delete). A workspace view removes its own rows; the host view removes
 * every workspace's rows, or one workspace's when `workspaceId` is given. Returns the count.
 */
export function deleteCapsuleIndex(store: OpenStoreResult, filter: { readonly workspaceId?: string } = {}): { readonly ok: true; readonly removed: number } | StoreRefusal {
  if (filter.workspaceId !== undefined && !isId(filter.workspaceId)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const ws = workspaceId === 'host' ? filter.workspaceId : workspaceId;
    const count = (sql: string, ...args: string[]): number => num(field(driver.prepare(sql).get(...args), 'n')) ?? 0;
    const removed = ws === undefined ? count('SELECT COUNT(*) AS n FROM capsule_index') : count('SELECT COUNT(*) AS n FROM capsule_index WHERE workspace_id = ?', ws);
    if (ws === undefined) driver.prepare('DELETE FROM capsule_index').run();
    else driver.prepare('DELETE FROM capsule_index WHERE workspace_id = ?').run(ws);
    return { ok: true as const, removed };
  });
}

// ---------------------------------------------------------------- outbox retry

export type OutboxAttemptResult =
  | { readonly ok: true; readonly state: 'applied' }
  | { readonly ok: true; readonly state: 'retry'; readonly retryCount: number; readonly nextAttemptAtMs: number }
  | { readonly ok: true; readonly state: 'exhausted'; readonly retryCount: number }
  | StoreRefusal;

export function backoffMs(retryCount: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, retryCount - 1));
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Records one delivery attempt for an outbox entry. Success marks it applied. A failure
 * schedules a bounded exponential retry; after `max_retries` the entry becomes
 * `needs-reconciliation` (it is never repeated blindly, SSOT §17.2).
 */
export function recordOutboxAttempt(
  store: OpenStoreResult,
  input: { readonly decisionId: string; readonly succeeded: boolean; readonly errorCode?: string; readonly nowMs: number },
): OutboxAttemptResult {
  if (!isId(input.decisionId) || !isMs(input.nowMs) || typeof input.succeeded !== 'boolean') return refuse('invalid-input');
  if (!input.succeeded && (input.errorCode === undefined || !ERROR_CODE.test(input.errorCode))) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const row = driver.prepare('SELECT effect_status, retry_count, max_retries FROM outbox_entry WHERE workspace_id = ? AND decision_id = ?').get(workspaceId, input.decisionId);
    if (row === undefined) throw new StoreStop('not-found');
    if (input.succeeded) {
      driver
        .prepare("UPDATE outbox_entry SET effect_status = 'acknowledged', acknowledgment = 'present', next_attempt_at_ms = NULL, last_error_code = NULL WHERE workspace_id = ? AND decision_id = ?")
        .run(workspaceId, input.decisionId);
      return { ok: true as const, state: 'applied' as const };
    }
    const retryCount = (num(field(row, 'retry_count')) ?? 0) + 1;
    const maxRetries = num(field(row, 'max_retries')) ?? OUTBOX_DEFAULT_MAX_RETRIES;
    if (retryCount >= maxRetries) {
      driver
        .prepare("UPDATE outbox_entry SET retry_count = ?, effect_status = 'needs-reconciliation', next_attempt_at_ms = NULL, last_error_code = ? WHERE workspace_id = ? AND decision_id = ?")
        .run(retryCount, input.errorCode, workspaceId, input.decisionId);
      return { ok: true as const, state: 'exhausted' as const, retryCount };
    }
    const nextAttemptAtMs = input.nowMs + backoffMs(retryCount);
    driver
      .prepare("UPDATE outbox_entry SET retry_count = ?, effect_status = 'pending', next_attempt_at_ms = ?, last_error_code = ? WHERE workspace_id = ? AND decision_id = ?")
      .run(retryCount, nextAttemptAtMs, input.errorCode, workspaceId, input.decisionId);
    return { ok: true as const, state: 'retry' as const, retryCount, nextAttemptAtMs };
  });
}

/** Outbox entries due for another attempt (pending, retries left, backoff elapsed). */
export function dueOutbox(store: OpenStoreResult, nowMs: number): readonly { readonly decisionId: string; readonly operationId: string; readonly retryCount: number }[] {
  const result = read(store, ({ driver, workspaceId }) =>
    driver
      .prepare(
        `SELECT decision_id, operation_id, retry_count FROM outbox_entry
         WHERE workspace_id = ? AND effect_status = 'pending' AND retry_count < max_retries
           AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?
         ORDER BY next_attempt_at_ms`,
      )
      .all(workspaceId, nowMs)
      .map((row) => ({ decisionId: str(field(row, 'decision_id')) ?? '', operationId: str(field(row, 'operation_id')) ?? '', retryCount: num(field(row, 'retry_count')) ?? 0 })),
  );
  return Array.isArray(result) ? result : [];
}
