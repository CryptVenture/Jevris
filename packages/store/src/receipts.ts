/**
 * Verification receipts (SSOT §10.5, §17.1 "receipt"; D's VER requirements). The runner and
 * the CI importer record a receipt through `recordVerificationReceipt`; nothing edits one
 * afterwards (a trigger refuses it) and an invalidated receipt never becomes current again.
 * Reads return frozen rows branded with `STORE_RECEIPT_ROW`, so completion can tell a row
 * the store returned from an object a frame or tool call supplied.
 */
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { field, isHash, isId, isKey, isMs, nullableStr, num, read, refuse, str, write } from './access.js';
import { demoteVerifiedTasks } from './tasks.js';

/** Brand on every receipt row read from the store. A JSON frame cannot carry a symbol. */
export const STORE_RECEIPT_ROW: unique symbol = Symbol.for('jevris.store.receipt-row');

export const RECEIPT_OUTCOMES = ['passed', 'failed', 'unknown', 'not-run'] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

export interface VerificationReceiptInput {
  readonly receiptId: string;
  readonly taskId: string | null;
  readonly checkId: string;
  readonly issuer: 'local-runner' | 'ci-import';
  readonly inputRevision: string;
  readonly scopeRevision: string;
  readonly runnerId: string;
  readonly environmentHash: string;
  readonly outcome: ReceiptOutcome;
  readonly rawHash: string | null;
  /** The full receipt record (argv, exit code, timings, structured results); no source text. */
  readonly body: unknown;
  readonly recordedAtMs: number;
}

export interface StoredReceipt {
  readonly [STORE_RECEIPT_ROW]: true;
  readonly receiptId: string;
  readonly taskId: string | null;
  readonly checkId: string;
  readonly issuer: 'local-runner' | 'ci-import';
  readonly inputRevision: string;
  readonly scopeRevision: string;
  readonly runnerId: string;
  readonly environmentHash: string;
  readonly outcome: ReceiptOutcome;
  readonly rawHash: string | null;
  readonly body: unknown;
  readonly validity: 'current' | 'invalidated';
  readonly recordedAtMs: number;
}

const BODY_CAP = 65_536;
const SOURCE_KEYS = new Set(['sourceBody', 'sourceText', 'fileText', 'source', 'prompt']);

function bodyText(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  for (const key of Object.keys(body)) if (SOURCE_KEYS.has(key)) return undefined;
  const text = JSON.stringify(body);
  return new TextEncoder().encode(text).length <= BODY_CAP ? text : undefined;
}

export function isStoreReceipt(value: unknown): value is StoredReceipt {
  return value !== null && typeof value === 'object' && Reflect.get(value, STORE_RECEIPT_ROW) === true;
}

function receiptRow(row: unknown): StoredReceipt | undefined {
  const receiptId = str(field(row, 'receipt_id'));
  const outcome = field(row, 'outcome');
  if (receiptId === undefined || !(RECEIPT_OUTCOMES as readonly unknown[]).includes(outcome)) return undefined;
  let body: unknown = {};
  try {
    body = JSON.parse(str(field(row, 'body')) ?? '{}');
  } catch {
    body = {};
  }
  return Object.freeze({
    [STORE_RECEIPT_ROW]: true as const,
    receiptId,
    taskId: nullableStr(field(row, 'task_id')),
    checkId: str(field(row, 'check_id')) ?? '',
    issuer: field(row, 'issuer') === 'ci-import' ? ('ci-import' as const) : ('local-runner' as const),
    inputRevision: str(field(row, 'input_revision')) ?? '',
    scopeRevision: str(field(row, 'scope_revision')) ?? '',
    runnerId: str(field(row, 'runner_id')) ?? '',
    environmentHash: str(field(row, 'environment_hash')) ?? '',
    outcome: outcome as ReceiptOutcome,
    rawHash: nullableStr(field(row, 'raw_hash')),
    body,
    validity: field(row, 'validity') === 'invalidated' ? ('invalidated' as const) : ('current' as const),
    recordedAtMs: num(field(row, 'recorded_at_ms')) ?? 0,
  });
}

/**
 * Records a receipt. The same id with the same content is idempotent (`duplicate: true`);
 * the same id with different content is refused (`conflict`): a receipt is never rewritten.
 */
export function recordVerificationReceipt(store: OpenStoreResult, input: VerificationReceiptInput): { readonly ok: true; readonly duplicate: boolean } | StoreRefusal {
  const body = bodyText(input.body);
  if (!isId(input.receiptId) || (input.taskId !== null && !isId(input.taskId)) || !isKey(input.checkId) || !['local-runner', 'ci-import'].includes(input.issuer)) return refuse('invalid-input');
  if (!isKey(input.inputRevision) || !isKey(input.scopeRevision) || !isKey(input.runnerId) || !isHash(input.environmentHash)) return refuse('invalid-input');
  if (!(RECEIPT_OUTCOMES as readonly string[]).includes(input.outcome) || (input.rawHash !== null && !isHash(input.rawHash)) || !isMs(input.recordedAtMs)) return refuse('invalid-input');
  if (body === undefined) return refuse('source-body-refused');
  return write(store, ({ driver, workspaceId }) => {
    const existing = receiptRow(driver.prepare('SELECT * FROM verification_receipt WHERE workspace_id = ? AND receipt_id = ?').get(workspaceId, input.receiptId));
    if (existing !== undefined) {
      const same =
        existing.checkId === input.checkId &&
        existing.outcome === input.outcome &&
        existing.inputRevision === input.inputRevision &&
        existing.taskId === input.taskId &&
        JSON.stringify(existing.body) === body;
      if (!same) return refuse('conflict');
      return { ok: true as const, duplicate: true };
    }
    driver
      .prepare(
        `INSERT INTO verification_receipt (workspace_id, receipt_id, task_id, check_id, issuer, input_revision, scope_revision, runner_id, environment_hash, outcome, raw_hash, body, recorded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, input.receiptId, input.taskId, input.checkId, input.issuer, input.inputRevision, input.scopeRevision, input.runnerId, input.environmentHash, input.outcome, input.rawHash, body, input.recordedAtMs);
    return { ok: true as const, duplicate: false };
  });
}

export function readVerificationReceipts(
  store: OpenStoreResult,
  filter: { readonly taskId?: string; readonly checkId?: string; readonly currentOnly?: boolean; readonly receiptIds?: readonly string[] } = {},
): readonly StoredReceipt[] {
  const result = read(store, ({ driver, workspaceId }) =>
    driver
      .prepare('SELECT * FROM verification_receipt WHERE workspace_id = ? ORDER BY recorded_at_ms, receipt_id')
      .all(workspaceId)
      .map(receiptRow)
      .filter(
        (r): r is StoredReceipt =>
          r !== undefined &&
          (filter.taskId === undefined || r.taskId === filter.taskId) &&
          (filter.checkId === undefined || r.checkId === filter.checkId) &&
          (filter.currentOnly !== true || r.validity === 'current') &&
          (filter.receiptIds === undefined || filter.receiptIds.includes(r.receiptId)),
      ),
  );
  return Array.isArray(result) ? result : [];
}

/**
 * Invalidates receipts: by id, by task, or every current receipt whose scope revision is not
 * `currentScopeRevision` (a changed revision, VER-03). Tasks verified by checks with an
 * invalidated receipt return to `awaiting-evidence`.
 */
export function invalidateVerificationReceipts(
  store: OpenStoreResult,
  input: { readonly receiptIds?: readonly string[]; readonly taskId?: string; readonly currentScopeRevision?: string; readonly checkIds?: readonly string[]; readonly nowMs: number },
): { readonly ok: true; readonly invalidated: readonly string[]; readonly demotedTasks: readonly string[] } | StoreRefusal {
  if (!isMs(input.nowMs)) return refuse('invalid-input');
  if (input.receiptIds === undefined && input.taskId === undefined && input.currentScopeRevision === undefined) return refuse('invalid-input');
  if (input.receiptIds !== undefined && !input.receiptIds.every(isId)) return refuse('invalid-input');
  if (input.taskId !== undefined && !isId(input.taskId)) return refuse('invalid-input');
  if (input.currentScopeRevision !== undefined && !isKey(input.currentScopeRevision)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const rows = driver
      .prepare("SELECT receipt_id, task_id, check_id, scope_revision FROM verification_receipt WHERE workspace_id = ? AND validity = 'current'")
      .all(workspaceId)
      .filter((row) => {
        const id = str(field(row, 'receipt_id'));
        if (input.receiptIds !== undefined && (id === undefined || !input.receiptIds.includes(id))) return false;
        if (input.taskId !== undefined && field(row, 'task_id') !== input.taskId) return false;
        if (input.checkIds !== undefined && !input.checkIds.includes(str(field(row, 'check_id')) ?? '')) return false;
        if (input.currentScopeRevision !== undefined && field(row, 'scope_revision') === input.currentScopeRevision) return false;
        return true;
      });
    const invalidated: string[] = [];
    const tasks: string[] = [];
    for (const row of rows) {
      const id = str(field(row, 'receipt_id')) ?? '';
      driver.prepare("UPDATE verification_receipt SET validity = 'invalidated' WHERE workspace_id = ? AND receipt_id = ?").run(workspaceId, id);
      invalidated.push(id);
      const taskId = str(field(row, 'task_id'));
      if (taskId !== undefined) tasks.push(taskId);
    }
    const demotedTasks = demoteVerifiedTasks(driver, workspaceId, tasks, input.nowMs);
    return { ok: true as const, invalidated, demotedTasks };
  });
}
