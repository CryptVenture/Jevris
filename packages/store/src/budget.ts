import {
  automationRefusedGuard,
  driverFor,
  type OpenStoreResult,
  type StoreRefusalReason,
} from './open.js';
import { acceptMoney, type SqlDriver } from './schema.js';
import { write } from './access.js';

const BUDGET_KEYS = new Set([
  'remainingMicroUsd',
  'questions',
  'attempts',
  'usage',
  'consumedMicroUsd',
  'maxOwnedDecisions',
]);

const SOURCE_KEYS = new Set(['sourceBody', 'sourceText', 'source', 'body', 'fileText']);

export interface StoredUsage {
  readonly usageKnown: 0 | 1 | null;
  readonly inputTokens: bigint | null;
  readonly outputTokens: bigint | null;
  readonly consumedMicroUsd: bigint | null;
}

export type Admission =
  | { readonly ok: true; readonly usage: StoredUsage }
  | { readonly ok: false; readonly reason: StoreRefusalReason };

const EMPTY_USAGE: StoredUsage = {
  usageKnown: null,
  inputTokens: null,
  outputTokens: null,
  consumedMicroUsd: null,
};

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

export function hasBudgetFields(input: object): boolean {
  for (const key of Object.keys(input)) {
    if (BUDGET_KEYS.has(key)) return true;
  }
  return false;
}

function isOne(value: unknown): boolean {
  return value === 1 || value === 1n;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function asBigCount(row: unknown): bigint {
  if (row === undefined || row === null || typeof row !== 'object') return 0n;
  const value = own(row, 'n');
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

/**
 * What the workspace's owned decisions count against the remaining amount (DATA-06, DATA-07):
 * a decision with known usage counts its consumed cost; one with unknown usage is a
 * conservative hold at its full reservation until `reconcileOwnedUsage` settles it. Unknown
 * usage never refuses a later decision that still fits.
 */
function admittedReservationSum(driver: SqlDriver, workspaceId: string): bigint {
  const row = driver
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN usage_known = 1 AND consumed_micro_usd IS NOT NULL THEN consumed_micro_usd ELSE reservation_micro_usd END), 0) AS n
       FROM decision_row WHERE workspace_id = ?`,
    )
    .get(workspaceId);
  return asBigCount(row);
}

function ownedDecisionCount(driver: SqlDriver, workspaceId: string): bigint {
  const row = driver
    .prepare('SELECT COUNT(*) AS n FROM decision_row WHERE workspace_id = ?')
    .get(workspaceId);
  return asBigCount(row);
}

function usageFrom(input: object): Admission {
  if (!Object.hasOwn(input, 'usage')) {
    return {
      ok: true,
      usage: {
        usageKnown: 0,
        inputTokens: null,
        outputTokens: null,
        consumedMicroUsd: null,
      },
    };
  }
  const usage = own(input, 'usage');
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return { ok: false, reason: 'invalid-input' };
  }
  for (const key of Reflect.ownKeys(usage)) {
    if (typeof key !== 'string' || SOURCE_KEYS.has(key)) return { ok: false, reason: 'source-body-refused' };
  }
  const known = own(usage, 'known');
  if (known === false) {
    for (const key of Object.keys(usage)) {
      if (key !== 'known') return { ok: false, reason: 'invalid-input' };
    }
    return {
      ok: true,
      usage: {
        usageKnown: 0,
        inputTokens: null,
        outputTokens: null,
        consumedMicroUsd: null,
      },
    };
  }
  if (known !== true) return { ok: false, reason: 'invalid-input' };
  const inputTokens = own(usage, 'inputTokens');
  const outputTokens = own(usage, 'outputTokens');
  if (!isCount(inputTokens) || !isCount(outputTokens)) return { ok: false, reason: 'invalid-input' };
  if (!Object.hasOwn(input, 'consumedMicroUsd')) return { ok: false, reason: 'BUDGET' };
  const consumed = acceptMoney(own(input, 'consumedMicroUsd'));
  if (consumed === undefined) return { ok: false, reason: 'BUDGET' };
  return {
    ok: true,
    usage: {
      usageKnown: 1,
      inputTokens: BigInt(inputTokens),
      outputTokens: BigInt(outputTokens),
      consumedMicroUsd: consumed,
    },
  };
}

export function evaluateAdmission(
  driver: SqlDriver,
  workspaceId: string,
  input: object,
  reservation: bigint,
): Admission {
  if (!hasBudgetFields(input)) return { ok: true, usage: EMPTY_USAGE };
  if (!isOne(own(input, 'questions')) || !isOne(own(input, 'attempts'))) {
    return { ok: false, reason: 'BUDGET' };
  }
  if (Object.hasOwn(input, 'maxOwnedDecisions')) {
    const cap = own(input, 'maxOwnedDecisions');
    if (!isCount(cap)) return { ok: false, reason: 'invalid-input' };
    if (ownedDecisionCount(driver, workspaceId) >= BigInt(cap)) {
      return { ok: false, reason: 'BUDGET' };
    }
  }
  if (!Object.hasOwn(input, 'remainingMicroUsd')) return { ok: false, reason: 'BUDGET' };
  const remaining = acceptMoney(own(input, 'remainingMicroUsd'));
  if (remaining === undefined) return { ok: false, reason: 'BUDGET' };
  const admitted = admittedReservationSum(driver, workspaceId);
  if (remaining - admitted < reservation) return { ok: false, reason: 'BUDGET' };
  return usageFrom(input);
}

export function admitOwned(store: OpenStoreResult, input: unknown): Admission | { readonly ok: false; readonly reason: StoreRefusalReason } {
  if (!store.ok) return { ok: false, reason: store.reason };
  const blocked = automationRefusedGuard(store);
  if (blocked !== undefined) return blocked;
  const driver = driverFor(store);
  if (driver === undefined) return { ok: false, reason: 'store-unavailable' };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const reservation = acceptMoney(own(input, 'reservationMicroUsd'));
  if (reservation === undefined) return { ok: false, reason: 'money-refused' };
  const admission = evaluateAdmission(driver, store.workspaceId, input, reservation);
  if (!admission.ok) return admission;
  return { ok: true, usage: admission.usage };
}

export type ReconcileUsageResult =
  | { readonly ok: true; readonly releasedMicroUsd: bigint }
  | { readonly ok: false; readonly reason: StoreRefusalReason | 'not-held' };

/**
 * Settles a hold: records the provider-reported (or billing-export) usage of an owned decision
 * whose usage was unknown. The hold then counts the consumed cost instead of the reservation.
 * A decision whose usage is already known is not changed.
 */
export function reconcileOwnedUsage(
  store: OpenStoreResult,
  input: { readonly decisionId: string; readonly inputTokens: number; readonly outputTokens: number; readonly consumedMicroUsd: bigint },
): ReconcileUsageResult {
  if (typeof input.decisionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.decisionId)) return { ok: false, reason: 'invalid-input' };
  if (!isCount(input.inputTokens) || !isCount(input.outputTokens)) return { ok: false, reason: 'invalid-input' };
  const consumed = acceptMoney(input.consumedMicroUsd);
  if (consumed === undefined) return { ok: false, reason: 'money-refused' };
  const result = write(
    store,
    ({ driver, workspaceId }): ReconcileUsageResult => {
      const row = driver.prepare('SELECT reservation_micro_usd AS n FROM decision_row WHERE workspace_id = ? AND decision_id = ? AND usage_known = 0').get(workspaceId, input.decisionId);
      if (row === undefined || row === null) return { ok: false, reason: 'not-held' };
      const reserved = asBigCount(row);
      driver
        .prepare('UPDATE decision_row SET usage_known = 1, input_tokens = ?, output_tokens = ?, consumed_micro_usd = ? WHERE workspace_id = ? AND decision_id = ? AND usage_known = 0')
        .run(BigInt(input.inputTokens), BigInt(input.outputTokens), consumed, workspaceId, input.decisionId);
      return { ok: true, releasedMicroUsd: reserved > consumed ? reserved - consumed : 0n };
    },
    { ignoreAutomationRefusal: true },
  );
  return result;
}
