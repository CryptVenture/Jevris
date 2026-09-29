/**
 * Owned worker effects (GOV-03, DATA-04, SSOT §16.5, §17.2): the durable record that lets the
 * kill switch hold an owned effect and a person settle it later.
 *
 * - beginOwnedEffect is written before the effect starts: decision, proposed-action and
 *   outbox rows with the effect `pending` and no acknowledgment. Idempotent on operationId.
 * - settleOwnedEffect is written after the run. A pending effect becomes `acknowledged`
 *   (applied) or `failed`. An effect the kill switch already held (`needs-reconciliation`)
 *   is never settled automatically: the answer is `held`, and the caller keeps its task
 *   blocked.
 * - heldEffects lists what waits for a person.
 * - reconcileEffect records a person's decision (applied or abandoned) from the CLI or a
 *   terminal, audited, once. Nothing here repeats an effect.
 *
 * The store never sees the effect's content: ids, a reservation and reason codes only.
 */
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { field, isMs, num, str, write, read } from './access.js';
import { appendAuditRow } from './governance.js';
import { acceptMoney, type SqlDriver } from './schema.js';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

export type OwnedEffectState = 'pending' | 'acknowledged' | 'failed' | 'needs-reconciliation' | 'abandoned';

export interface BeginOwnedEffectInput {
  readonly operationId: string;
  /** The decision the effect belongs to; defaults to the operation id. */
  readonly decisionId?: string;
  readonly kind: 'owned-worker';
  readonly reservationMicroUsd: number | bigint;
  readonly nowMs: number;
}

function refuse(reason: 'invalid-input' | 'money-refused'): StoreRefusal {
  return { ok: false, reason };
}

function stateOf(driver: SqlDriver, workspaceId: string, operationId: string): OwnedEffectState | undefined {
  const row = driver.prepare('SELECT effect_status FROM outbox_entry WHERE workspace_id = ? AND operation_id = ?').get(workspaceId, operationId);
  const status = str(field(row, 'effect_status'));
  return status === undefined ? undefined : (status as OwnedEffectState);
}

export function beginOwnedEffect(
  store: OpenStoreResult,
  input: BeginOwnedEffectInput,
): { readonly ok: true; readonly state: OwnedEffectState; readonly existing: boolean } | StoreRefusal {
  const decisionId = input.decisionId ?? input.operationId;
  if (!ID.test(input.operationId) || !ID.test(decisionId) || input.kind !== 'owned-worker' || !isMs(input.nowMs)) return refuse('invalid-input');
  const money = acceptMoney(input.reservationMicroUsd);
  if (money === undefined) return refuse('money-refused');
  return write(store, ({ driver, workspaceId }) => {
    const existing = stateOf(driver, workspaceId, input.operationId);
    if (existing !== undefined) return { ok: true as const, state: existing, existing: true };
    driver
      .prepare("INSERT INTO decision_row (workspace_id, decision_id, operation_id, reservation_micro_usd, usage_known, input_tokens, output_tokens, consumed_micro_usd, validity) VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, 'current')")
      .run(workspaceId, decisionId, input.operationId, money);
    driver.prepare('INSERT INTO proposed_action (workspace_id, decision_id, operation_id) VALUES (?, ?, ?)').run(workspaceId, decisionId, input.operationId);
    driver
      .prepare("INSERT INTO outbox_entry (workspace_id, decision_id, operation_id, effect_status, acknowledgment, process_observed) VALUES (?, ?, ?, 'pending', 'absent', 'unknown')")
      .run(workspaceId, decisionId, input.operationId);
    return { ok: true as const, state: 'pending' as const, existing: false };
  });
}

export interface SettleOwnedEffectInput {
  readonly operationId: string;
  readonly outcome: 'applied' | 'failed';
  readonly errorCode?: string;
  /** What the effect actually cost, or null when unknown (the reservation stays held). */
  readonly actualMicroUsd: number | bigint | null;
  readonly nowMs: number;
}

export function settleOwnedEffect(
  store: OpenStoreResult,
  input: SettleOwnedEffectInput,
): { readonly ok: true; readonly state: 'acknowledged' | 'failed' | 'held' | 'abandoned' } | { readonly ok: false; readonly reason: 'not-found' } | StoreRefusal {
  if (!ID.test(input.operationId) || (input.outcome !== 'applied' && input.outcome !== 'failed') || !isMs(input.nowMs)) return refuse('invalid-input');
  if (input.errorCode !== undefined && !CODE.test(input.errorCode)) return refuse('invalid-input');
  const actual = input.actualMicroUsd === null ? null : acceptMoney(input.actualMicroUsd);
  if (actual === undefined) return refuse('money-refused');
  return write(
    store,
    ({ driver, workspaceId }) => {
      const state = stateOf(driver, workspaceId, input.operationId);
      if (state === undefined) return { ok: false as const, reason: 'not-found' as const };
      // Held by the kill switch, or already decided by a person: never settled automatically.
      if (state === 'needs-reconciliation') return { ok: true as const, state: 'held' as const };
      if (state === 'abandoned') return { ok: true as const, state: 'abandoned' as const };
      if (state === 'acknowledged' || state === 'failed') return { ok: true as const, state };
      const next = input.outcome === 'applied' ? 'acknowledged' : 'failed';
      driver
        .prepare("UPDATE outbox_entry SET effect_status = ?, acknowledgment = 'present', process_observed = 'exited' WHERE workspace_id = ? AND operation_id = ? AND effect_status = 'pending'")
        .run(next, workspaceId, input.operationId);
      if (actual !== null) {
        driver.prepare('UPDATE decision_row SET usage_known = 1, consumed_micro_usd = ? WHERE workspace_id = ? AND operation_id = ?').run(actual, workspaceId, input.operationId);
      }
      return { ok: true as const, state: next };
    },
    // Settling records what already happened, so it works while automation is refused.
    { ignoreAutomationRefusal: true },
  );
}

export interface HeldEffect {
  readonly operationId: string;
  readonly decisionId: string;
  readonly reservationMicroUsd: number;
}

/** Effects waiting for a person (needs-reconciliation), for this workspace or, on the host store, all. */
export function heldEffects(store: OpenStoreResult): readonly HeldEffect[] {
  const result = read(store, ({ driver, workspaceId }) => {
    const sql =
      'SELECT o.operation_id, o.decision_id, d.reservation_micro_usd FROM outbox_entry AS o JOIN decision_row AS d ON d.workspace_id = o.workspace_id AND d.decision_id = o.decision_id ' +
      "WHERE o.effect_status = 'needs-reconciliation'" +
      (workspaceId === 'host' ? '' : ' AND o.workspace_id = ?') +
      ' ORDER BY o.operation_id LIMIT 1000';
    const rows = workspaceId === 'host' ? driver.prepare(sql).all() : driver.prepare(sql).all(workspaceId);
    return rows.map((row) => ({
      operationId: str(field(row, 'operation_id')) ?? '',
      decisionId: str(field(row, 'decision_id')) ?? '',
      reservationMicroUsd: num(field(row, 'reservation_micro_usd')) ?? 0,
    }));
  });
  return Array.isArray(result) ? result : [];
}

export interface ReconcileEffectInput {
  readonly operationId: string;
  readonly resolution: 'applied' | 'abandoned';
  readonly actor: string;
  readonly channel: 'terminal' | 'cli';
  readonly nowMs: number;
}

/** A person's decision on a held effect, audited once. A second call changes nothing. */
export function reconcileEffect(
  store: OpenStoreResult,
  input: ReconcileEffectInput,
): { readonly ok: true; readonly state: 'acknowledged' | 'abandoned'; readonly auditSeq: number | null } | { readonly ok: false; readonly reason: 'not-found' | 'not-held' } | StoreRefusal {
  if (!ID.test(input.operationId) || (input.resolution !== 'applied' && input.resolution !== 'abandoned')) return refuse('invalid-input');
  if (!ACTOR.test(input.actor) || (input.channel !== 'terminal' && input.channel !== 'cli') || !isMs(input.nowMs)) return refuse('invalid-input');
  return write(
    store,
    ({ driver, workspaceId }) => {
      const state = stateOf(driver, workspaceId, input.operationId);
      if (state === undefined) return { ok: false as const, reason: 'not-found' as const };
      const target = input.resolution === 'applied' ? 'acknowledged' : 'abandoned';
      if (state === target) return { ok: true as const, state: target, auditSeq: null };
      if (state !== 'needs-reconciliation') return { ok: false as const, reason: 'not-held' as const };
      driver
        .prepare("UPDATE outbox_entry SET effect_status = ?, acknowledgment = 'present', next_attempt_at_ms = NULL WHERE workspace_id = ? AND operation_id = ? AND effect_status = 'needs-reconciliation'")
        .run(target, workspaceId, input.operationId);
      const audited = appendAuditRow(
        driver,
        { kind: 'owned-effect.reconcile', actor: input.actor, channel: input.channel, atMs: input.nowMs },
        { operationId: input.operationId, workspaceId, resolution: input.resolution },
      );
      return { ok: true as const, state: target, auditSeq: audited.seq };
    },
    { ignoreAutomationRefusal: true },
  );
}
