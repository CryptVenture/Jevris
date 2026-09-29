import {
  automationRefusedGuard,
  driverFor,
  faultRefusal,
  type OpenStoreResult,
  type StoreRefusalReason,
} from './open.js';
import { evaluateAdmission, type StoredUsage } from './budget.js';
import { acceptMoney, immediately, type SqlDriver } from './schema.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SOURCE_KEYS = new Set(['sourceBody', 'sourceText', 'source', 'body', 'fileText']);
const ALLOWED_KEYS = new Set([
  'decisionId',
  'operationId',
  'reservationMicroUsd',
  'remainingMicroUsd',
  'questions',
  'attempts',
  'usage',
  'consumedMicroUsd',
  'maxOwnedDecisions',
  'acknowledgment',
]);

class WriteStop extends Error {
  readonly reason: StoreRefusalReason;

  constructor(reason: StoreRefusalReason) {
    super('stop');
    this.reason = reason;
  }
}

export interface CommittedRow {
  readonly decisionId: string;
  readonly operationId: string;
  readonly reservationMicroUsd: bigint;
  readonly applied: false;
  readonly nonOwnedBilling: 'unknown';
  readonly decisionPresent: true;
  readonly proposedActionPresent: true;
  readonly outboxPresent: true;
  readonly usageKnown: boolean | null;
  readonly inputTokens: bigint | null;
  readonly outputTokens: bigint | null;
}

export type CommitResult =
  | { readonly ok: true }
  | { readonly ok: true; readonly existing: true }
  | { readonly ok: false; readonly reason: StoreRefusalReason };

function refusal(reason: StoreRefusalReason): CommitResult {
  return { ok: false, reason };
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function fieldRefusal(input: object): StoreRefusalReason | undefined {
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (typeof key !== 'string' || SOURCE_KEYS.has(key)) return 'source-body-refused';
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) return 'invalid-input';
  }
  return undefined;
}

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

export function commitOwned(
  store: OpenStoreResult,
  input: unknown,
  callback?: () => void,
): CommitResult {
  if (!store.ok) return refusal(store.reason);
  const driver = driverFor(store);
  if (driver === undefined) return refusal('store-unavailable');
  const migrated = automationRefusedGuard(store);
  if (migrated !== undefined) return migrated;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return refusal('invalid-input');
  }
  const blocked = fieldRefusal(input);
  if (blocked !== undefined) return refusal(blocked);
  if (callback !== undefined && typeof callback !== 'function') return refusal('invalid-input');

  const decisionId = own(input, 'decisionId');
  const operationId = own(input, 'operationId');
  const reservationMicroUsd = own(input, 'reservationMicroUsd');
  if (!isId(decisionId) || !isId(operationId)) return refusal('invalid-input');
  const money = acceptMoney(reservationMicroUsd);
  if (money === undefined) return refusal('money-refused');

  const duplicate = driver
    .prepare(
      'SELECT operation_id FROM decision_row WHERE workspace_id = ? AND operation_id = ?',
    )
    .get(store.workspaceId, operationId);
  if (duplicate !== undefined) return { ok: true, existing: true };

  const acknowledgment = own(input, 'acknowledgment');
  const ack = acknowledgment === undefined ? 'absent' : acknowledgment;
  if (ack !== 'absent' && ack !== 'present') return refusal('invalid-input');
  const effectStatus = ack === 'absent' ? 'needs-reconciliation' : 'acknowledged';

  const insertDecision = driver.prepare(
    `INSERT INTO decision_row (
       workspace_id, decision_id, operation_id, reservation_micro_usd,
       usage_known, input_tokens, output_tokens, consumed_micro_usd, validity
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current')`,
  );
  const insertAction = driver.prepare(
    'INSERT INTO proposed_action (workspace_id, decision_id, operation_id) VALUES (?, ?, ?)',
  );
  const insertOutbox = driver.prepare(
    `INSERT INTO outbox_entry (
       workspace_id, decision_id, operation_id, effect_status, acknowledgment, process_observed
     ) VALUES (?, ?, ?, ?, ?, 'unknown')`,
  );
  const run = driver.transaction(() => {
    const admitted = evaluateAdmission(driver, store.workspaceId, input, money);
    if (!admitted.ok) throw new WriteStop(admitted.reason);
    const usage: StoredUsage = admitted.usage;
    insertDecision.run(
      store.workspaceId,
      decisionId,
      operationId,
      money,
      usage.usageKnown,
      usage.inputTokens,
      usage.outputTokens,
      usage.consumedMicroUsd,
    );
    insertAction.run(store.workspaceId, decisionId, operationId);
    insertOutbox.run(store.workspaceId, decisionId, operationId, effectStatus, ack);
    if (callback !== undefined) callback();
  });
  try {
    immediately(run);
  } catch (error) {
    if (error instanceof WriteStop) return refusal(error.reason);
    const fault = faultRefusal(store, error);
    if (fault !== undefined) return fault;
    throw error;
  }
  return { ok: true };
}

export function readCommitted(store: OpenStoreResult, decisionId: string): CommittedRow | undefined {
  if (!store.ok) return undefined;
  const driver = driverFor(store);
  if (driver === undefined) return undefined;
  return readRow(driver, store.workspaceId, decisionId);
}

function readRow(driver: SqlDriver, workspaceId: string, decisionId: string): CommittedRow | undefined {
  const row = driver
    .prepare(
      `SELECT
         d.decision_id AS decision_id,
         d.operation_id AS operation_id,
          d.reservation_micro_usd AS reservation_micro_usd,
          d.usage_known AS usage_known,
          d.input_tokens AS input_tokens,
          d.output_tokens AS output_tokens,
          p.operation_id AS proposed_operation_id,
          o.operation_id AS outbox_operation_id
       FROM decision_row AS d
       INNER JOIN proposed_action AS p
         ON p.workspace_id = d.workspace_id AND p.decision_id = d.decision_id
       INNER JOIN outbox_entry AS o
         ON o.workspace_id = d.workspace_id AND o.decision_id = d.decision_id
       WHERE d.workspace_id = ? AND d.decision_id = ?`,
    )
    .get(workspaceId, decisionId);
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const foundDecision = own(row, 'decision_id');
  const foundOperation = own(row, 'operation_id');
  const money = own(row, 'reservation_micro_usd');
  const proposed = own(row, 'proposed_operation_id');
  const outbox = own(row, 'outbox_operation_id');
  if (typeof foundDecision !== 'string' || typeof foundOperation !== 'string') return undefined;
  if (typeof money !== 'bigint') return undefined;
  if (typeof proposed !== 'string' || typeof outbox !== 'string') return undefined;
  return {
    decisionId: foundDecision,
    operationId: foundOperation,
    reservationMicroUsd: money,
    applied: false,
    nonOwnedBilling: 'unknown',
    decisionPresent: true,
    proposedActionPresent: true,
    outboxPresent: true,
    usageKnown: asUsageKnown(own(row, 'usage_known')),
    inputTokens: asToken(own(row, 'input_tokens')),
    outputTokens: asToken(own(row, 'output_tokens')),
  };
}

function asUsageKnown(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  return null;
}

function asToken(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  return null;
}
