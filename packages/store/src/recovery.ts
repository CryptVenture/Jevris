/**
 * Restart reconciliation (DATA-04, SSOT §17.2, C31). Run once when the sidecar starts,
 * across every workspace in the store:
 *
 * - leases past `expires_at` still leased or running become `blocked` (blocked for
 *   reconciliation), and their tasks move to `blocked` with LEASE_EXPIRED;
 * - tasks left `leased` or `running` with no live lease are active jobs whose process is
 *   gone: they move to `blocked` with PROCESS_LOST (never auto-resumed or auto-failed);
 * - open job reservations become `uncertain` (they may have been spent);
 * - decisions with uncommitted (unknown) usage are counted as holds for the budget;
 * - pending outbox entries without an acknowledgment become `needs-reconciliation`.
 *
 * A missing process does not prove a remote tool had no effect, so nothing here marks an
 * effect failed-and-safe-to-repeat.
 */
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { field, isMs, num, str, write } from './access.js';
import { appendAuditRow } from './governance.js';
import type { SqlDriver } from './schema.js';

export interface RestartReconciliation {
  readonly ok: true;
  readonly expiredLeases: number;
  readonly blockedTasks: readonly string[];
  readonly uncertainReservations: number;
  readonly unknownUsageHolds: number;
  readonly outboxNeedsReconciliation: number;
}

function changes(result: unknown): number {
  return num(field(result, 'changes')) ?? 0;
}

function blockTask(driver: SqlDriver, workspaceId: string, taskId: string, reason: string, nowMs: number): boolean {
  const row = driver.prepare("SELECT state FROM task WHERE workspace_id = ? AND task_id = ? AND state IN ('leased', 'running')").get(workspaceId, taskId);
  if (row === undefined) return false;
  const from = str(field(row, 'state')) ?? 'running';
  driver.prepare("UPDATE task SET state = 'blocked', revision = revision + 1, state_reason = ?, updated_at_ms = ? WHERE workspace_id = ? AND task_id = ?").run(reason, nowMs, workspaceId, taskId);
  const seq = (num(field(driver.prepare('SELECT MAX(seq) AS m FROM task_transition WHERE workspace_id = ? AND task_id = ?').get(workspaceId, taskId), 'm')) ?? 0) + 1;
  driver
    .prepare("INSERT INTO task_transition (workspace_id, task_id, seq, from_state, to_state, actor, reason_code, at_ms) VALUES (?, ?, ?, ?, 'blocked', 'reconciler', ?, ?)")
    .run(workspaceId, taskId, seq, from, reason, nowMs);
  return true;
}

/** Reconciles every workspace once at start. */
export function reconcileRestart(store: OpenStoreResult, input: { readonly nowMs: number }): RestartReconciliation | StoreRefusal {
  if (!isMs(input.nowMs)) return { ok: false, reason: 'invalid-input' };
  const nowIso = new Date(input.nowMs).toISOString();
  return write(store, ({ driver }) => {
    const blockedTasks: string[] = [];
    const expired = driver
      .prepare("SELECT workspace_id, lease_id, task_id FROM lease_row WHERE state IN ('leased', 'running') AND expires_at < ?")
      .all(nowIso);
    for (const lease of expired) {
      const ws = str(field(lease, 'workspace_id')) ?? '';
      driver.prepare("UPDATE lease_row SET state = 'blocked' WHERE workspace_id = ? AND lease_id = ?").run(ws, str(field(lease, 'lease_id')) ?? '');
      const taskId = str(field(lease, 'task_id')) ?? '';
      if (blockTask(driver, ws, taskId, 'LEASE_EXPIRED', input.nowMs)) blockedTasks.push(`${ws}:${taskId}`);
    }
    // Active jobs with no live lease: the worker process is gone.
    const orphaned = driver
      .prepare(
        `SELECT t.workspace_id, t.task_id FROM task AS t
         WHERE t.state IN ('leased', 'running')
           AND NOT EXISTS (SELECT 1 FROM lease_row AS l WHERE l.workspace_id = t.workspace_id AND l.task_id = t.task_id AND l.state IN ('leased', 'running') AND l.expires_at >= ?)`,
      )
      .all(nowIso);
    for (const row of orphaned) {
      const ws = str(field(row, 'workspace_id')) ?? '';
      const taskId = str(field(row, 'task_id')) ?? '';
      if (blockTask(driver, ws, taskId, 'PROCESS_LOST', input.nowMs)) blockedTasks.push(`${ws}:${taskId}`);
    }
    const uncertainReservations = changes(driver.prepare("UPDATE job_reservation SET state = 'uncertain' WHERE state = 'reserved'").run());
    const unknownUsageHolds =
      (num(field(driver.prepare('SELECT COUNT(*) AS n FROM decision_row WHERE usage_known = 0 OR usage_known IS NULL').get(), 'n')) ?? 0) +
      (num(field(driver.prepare('SELECT COUNT(*) AS n FROM decision_record WHERE usage_known = 0 AND provider_calls > 0').get(), 'n')) ?? 0);
    const outboxNeedsReconciliation = changes(
      driver.prepare("UPDATE outbox_entry SET effect_status = 'needs-reconciliation', next_attempt_at_ms = NULL WHERE effect_status = 'pending' AND acknowledgment = 'absent'").run(),
    );
    return { ok: true as const, expiredLeases: expired.length, blockedTasks, uncertainReservations, unknownUsageHolds, outboxNeedsReconciliation };
  });
}

/**
 * Translates a durable wall-clock deadline into this process's monotonic clock (SSOT §17.2).
 * Remaining time is the deadline minus now. A wall clock earlier than the recording time
 * (a backwards jump) cannot tell how much time passed, so the deadline is treated as
 * expired rather than extended; a redelivered message never gets a fresh deadline.
 */
export function translateDeadline(input: { readonly deadlineAtMs: number; readonly recordedAtMs: number; readonly nowMs: number; readonly monotonicNowMs: number }): { readonly monotonicDeadlineMs: number; readonly remainingMs: number } | 'expired' {
  const { deadlineAtMs, recordedAtMs, nowMs, monotonicNowMs } = input;
  if (![deadlineAtMs, recordedAtMs, nowMs, monotonicNowMs].every((v) => Number.isFinite(v))) return 'expired';
  if (nowMs < recordedAtMs) return 'expired';
  const remaining = Math.min(deadlineAtMs - nowMs, deadlineAtMs - recordedAtMs);
  if (!(remaining > 0)) return 'expired';
  return { monotonicDeadlineMs: monotonicNowMs + remaining, remainingMs: remaining };
}

/**
 * Kill-switch activation (GOV-03): every owned effect that is still pending without an
 * acknowledgment moves to `needs-reconciliation` (never repeated automatically), and the
 * activation is audited with the ids it held. Returns the held operation ids (at most 200).
 */
export function holdPendingEffects(
  store: OpenStoreResult,
  input: { readonly nowMs: number; readonly actor: string; readonly channel: 'terminal' | 'cli'; readonly reason?: string; readonly policyRestored?: string },
): { readonly ok: true; readonly held: readonly string[]; readonly auditSeq: number } | StoreRefusal {
  if (!isMs(input.nowMs)) return { ok: false, reason: 'invalid-input' };
  return write(
    store,
    ({ driver }) => {
      const rows = driver.prepare("SELECT operation_id FROM outbox_entry WHERE effect_status = 'pending' AND acknowledgment = 'absent' ORDER BY operation_id LIMIT 200").all();
      const held = rows.map((row) => str(field(row, 'operation_id')) ?? '').filter((id) => id.length > 0);
      driver.prepare("UPDATE outbox_entry SET effect_status = 'needs-reconciliation', next_attempt_at_ms = NULL WHERE effect_status = 'pending' AND acknowledgment = 'absent'").run();
      const reason = typeof input.reason === 'string' ? input.reason.replace(/[^A-Za-z0-9 _.:/@+,=-]/g, ' ').slice(0, 160) : null;
      const audited = appendAuditRow(driver, { kind: 'kill-switch.activate', actor: input.actor, channel: input.channel, atMs: input.nowMs }, { held: held.length, heldIds: held.slice(0, 20), reason, policyRestored: typeof input.policyRestored === 'string' && /^sha256:[a-f0-9]{16}$/.test(input.policyRestored) ? input.policyRestored : null });
      return { ok: true as const, held, auditSeq: audited.seq };
    },
    { ignoreAutomationRefusal: true },
  );
}
