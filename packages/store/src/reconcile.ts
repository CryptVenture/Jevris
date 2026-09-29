import { driverFor, type OpenStoreResult } from './open.js';
import { acceptMoney, type SqlDriver } from './schema.js';

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

export function reconcileOnOpen(driver: SqlDriver): void {
  driver
    .prepare(
      `UPDATE outbox_entry
       SET effect_status = 'needs-reconciliation'
       WHERE effect_status = 'pending' AND acknowledgment = 'absent'`,
    )
    .run();
}

export interface EffectDisposition {
  readonly repeatable: false;
  readonly effectStatus: string;
  readonly processObserved: string;
  readonly outboxCount: number;
}

export function effectDisposition(
  store: OpenStoreResult,
  operationId: string,
): EffectDisposition | undefined {
  if (!store.ok) return undefined;
  const driver = driverFor(store);
  if (driver === undefined) return undefined;
  const row = driver
    .prepare(
      `SELECT effect_status, process_observed
       FROM outbox_entry
       WHERE workspace_id = ? AND operation_id = ?`,
    )
    .get(store.workspaceId, operationId);
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const effectStatus = own(row, 'effect_status');
  const processObserved = own(row, 'process_observed');
  if (typeof effectStatus !== 'string' || typeof processObserved !== 'string') return undefined;
  const counted = driver
    .prepare('SELECT COUNT(*) AS n FROM outbox_entry WHERE workspace_id = ? AND operation_id = ?')
    .get(store.workspaceId, operationId);
  const rawCount =
    counted !== undefined && counted !== null && typeof counted === 'object' ? own(counted, 'n') : 0;
  const outboxCount = typeof rawCount === 'bigint' ? Number(rawCount) : typeof rawCount === 'number' ? rawCount : 0;
  return {
    repeatable: false,
    effectStatus,
    processObserved,
    outboxCount,
  };
}

export function noteMissingProcess(
  store: OpenStoreResult,
  operationId: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'invalid-input' | 'store-unavailable' } {
  if (!store.ok) return { ok: false, reason: 'store-unavailable' };
  const driver = driverFor(store);
  if (driver === undefined) return { ok: false, reason: 'store-unavailable' };
  driver
    .prepare(
      `UPDATE outbox_entry
       SET process_observed = 'missing'
       WHERE workspace_id = ? AND operation_id = ?`,
    )
    .run(store.workspaceId, operationId);
  const after = effectDisposition(store, operationId);
  if (after === undefined) return { ok: false, reason: 'invalid-input' };
  return { ok: true };
}

export function publishCurrent(
  store: OpenStoreResult,
  decisionId: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'refused' | 'store-unavailable' } {
  if (!store.ok) return { ok: false, reason: 'store-unavailable' };
  const driver = driverFor(store);
  if (driver === undefined) return { ok: false, reason: 'store-unavailable' };
  const row = driver
    .prepare(
      `SELECT d.validity AS validity, o.effect_status AS effect_status
       FROM decision_row AS d
       INNER JOIN outbox_entry AS o
         ON o.workspace_id = d.workspace_id AND o.decision_id = d.decision_id
       WHERE d.workspace_id = ? AND d.decision_id = ?`,
    )
    .get(store.workspaceId, decisionId);
  if (row === undefined || row === null || typeof row !== 'object') {
    if (invalidatedTarget(driver, store.workspaceId, decisionId)) {
      return { ok: false, reason: 'refused' };
    }
    return { ok: false, reason: 'refused' };
  }
  const validity = own(row, 'validity');
  const effectStatus = own(row, 'effect_status');
  if (validity === 'stale' || validity === 'invalidated' || effectStatus === 'needs-reconciliation') {
    return { ok: false, reason: 'refused' };
  }
  if (invalidatedTarget(driver, store.workspaceId, decisionId)) {
    return { ok: false, reason: 'refused' };
  }
  return { ok: true };
}

function invalidatedTarget(driver: SqlDriver, workspaceId: string, id: string): boolean {
  const receipt = driver
    .prepare('SELECT validity FROM receipt_row WHERE workspace_id = ? AND receipt_id = ?')
    .get(workspaceId, id);
  if (rowValidity(receipt) === 'invalidated') return true;
  const evidence = driver
    .prepare('SELECT validity FROM evidence_row WHERE workspace_id = ? AND evidence_id = ?')
    .get(workspaceId, id);
  return rowValidity(evidence) === 'invalidated';
}

function rowValidity(row: unknown): string | undefined {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  const validity = own(row, 'validity');
  return typeof validity === 'string' ? validity : undefined;
}

export function markStale(
  store: OpenStoreResult,
  decisionId: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'store-unavailable' | 'invalid-input' } {
  if (!store.ok) return { ok: false, reason: 'store-unavailable' };
  const driver = driverFor(store);
  if (driver === undefined) return { ok: false, reason: 'store-unavailable' };
  driver
    .prepare("UPDATE decision_row SET validity = 'stale' WHERE workspace_id = ? AND decision_id = ?")
    .run(store.workspaceId, decisionId);
  return { ok: true };
}

function labelledAmount(labels: object | undefined, key: string): bigint | undefined {
  if (labels === undefined || !Object.hasOwn(labels, key)) return undefined;
  return acceptMoney((labels as Record<string, unknown>)[key]);
}

export function billingReport(
  _store: OpenStoreResult,
  labels?: {
    readonly subscriptionActual?: bigint | 'unknown';
    readonly apiEquivalentEstimate?: bigint | 'unmeasured';
    readonly counterfactualHypothetical?: bigint | 'hypothetical';
  },
): {
  readonly nonOwnedBilling: 'unknown';
  readonly savingMicroUsd: null;
  readonly applied: false;
  readonly subscriptionActual: bigint | 'unknown';
  readonly apiEquivalentEstimate: bigint | 'unmeasured';
  readonly counterfactualHypothetical: bigint | 'hypothetical';
} {
  const suppliedSubscription = labelledAmount(labels, 'subscriptionActual');
  const suppliedEstimate = labelledAmount(labels, 'apiEquivalentEstimate');
  const suppliedCounterfactual = labelledAmount(labels, 'counterfactualHypothetical');
  return {
    nonOwnedBilling: 'unknown',
    savingMicroUsd: null,
    applied: false,
    subscriptionActual: suppliedSubscription === undefined ? 'unknown' : suppliedSubscription,
    apiEquivalentEstimate: suppliedEstimate === undefined ? 'unmeasured' : suppliedEstimate,
    counterfactualHypothetical: suppliedCounterfactual === undefined ? 'hypothetical' : suppliedCounterfactual,
  };
}
