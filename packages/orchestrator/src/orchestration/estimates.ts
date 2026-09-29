/**
 * Plan and budget estimate accuracy, and per-slice task volume (audit P11, D's side).
 *
 * After every owned run and at completion, D keeps one text-free row per task (collection
 * `task-estimates`, workspace ledger): the task's estimate against the committed actual of its
 * leases, the runs' wall time and tokens, and the task's state. `estimateAccuracy` reports it for
 * plan status and cost.report; `sliceVolume` gives the measured p90 tokens of a slice's finished
 * runs, which C's router may use as the task volume, never below its default (reservations stay
 * conservative). Nothing here changes an estimate, a reservation or a budget cap.
 */
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';
import { getTask, type TaskRecord } from './tasks.js';
import type { WorkerRunRecord } from './workers.js';

export const TASK_ESTIMATES = 'task-estimates';
/** Finished runs a slice needs before its measured volume is given. */
export const SLICE_VOLUME_MIN_RUNS = 5;

export interface TaskEstimateRecord {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly sliceId: string | null;
  readonly risk: TaskRecord['risk'];
  readonly rootBudgetId: string | null;
  readonly estimateMicroUsd: number;
  /** The committed actuals of the task's leases; null while any is uncertain or none committed. */
  readonly actualMicroUsd: number | null;
  readonly runs: number;
  readonly wallMs: number;
  /** Input tokens including cache reads and writes; null when a run reported no usage. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly state: TaskRecord['node']['state'];
  readonly atMs: number;
}

interface ReservationRow {
  readonly workspaceId?: string;
  readonly leaseId?: string;
  readonly reservation?: { readonly state?: string; readonly actualMicroUsd?: number | null };
}

function runsOf(ws: WorkspaceServices, taskId: string): readonly WorkerRunRecord[] {
  return ws.host.list<WorkerRunRecord>('worker-runs').filter((r) => r.workspaceId === ws.workspaceId && r.taskId === taskId && r.stale !== true);
}

/** Rewrites the task's estimate row from its runs and reservations. Never throws into the task path. */
export async function recordTaskEstimate(ws: WorkspaceServices, taskId: string, nowMs: number): Promise<TaskEstimateRecord | null> {
  const task = getTask(ws, taskId);
  if (task === undefined) return null;
  const runs = runsOf(ws, taskId);
  if (runs.length === 0) return null;
  const leases = new Set(runs.map((r) => r.leaseId));
  const reservations = ws.host.list<ReservationRow>('reservations').filter((r) => r.workspaceId === ws.workspaceId && r.leaseId !== undefined && leases.has(r.leaseId));
  const committed = reservations.filter((r) => r.reservation?.state === 'committed' && typeof r.reservation.actualMicroUsd === 'number');
  const actual = reservations.length > 0 && committed.length === reservations.length ? committed.reduce((n, r) => n + (r.reservation?.actualMicroUsd ?? 0), 0) : null;
  const usageKnown = runs.every((r) => r.usage !== null);
  const record: TaskEstimateRecord = {
    workspaceId: ws.workspaceId,
    taskId,
    sliceId: task.sliceId,
    risk: task.risk,
    rootBudgetId: task.node.rootBudgetId ?? null,
    estimateMicroUsd: Math.max(0, Math.trunc(task.estimateMicroUsd)),
    actualMicroUsd: actual,
    runs: runs.length,
    wallMs: runs.reduce((n, r) => n + Math.max(0, Math.round(r.durationMs)), 0),
    inputTokens: usageKnown ? runs.reduce((n, r) => n + (r.usage === null ? 0 : r.usage.inputTokens + r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens), 0) : null,
    outputTokens: usageKnown ? runs.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0) : null,
    state: task.node.state,
    atMs: nowMs,
  };
  await ws.state.transact((tx) => tx.put(TASK_ESTIMATES, recordKey(ws.workspaceId, taskId), record));
  return record;
}

export function taskEstimates(ws: WorkspaceServices): readonly TaskEstimateRecord[] {
  return ws.state.list<TaskEstimateRecord>(TASK_ESTIMATES).filter((r) => r.workspaceId === ws.workspaceId);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** The nearest-rank percentile (p in 0..1). */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
}

export interface EstimateAccuracy {
  readonly tasks: number;
  /** Tasks with a committed actual and a non-zero estimate: the ones the ratios use. */
  readonly compared: number;
  readonly estimateMicroUsd: number;
  readonly actualMicroUsd: number;
  /** Median of actual / estimate over the compared tasks; null with none. */
  readonly medianRatio: number | null;
  /** Compared tasks that spent more than their estimate. */
  readonly underEstimated: number;
}

/** Estimate against committed actual for the workspace's finished tasks (optionally one root budget). */
export function estimateAccuracy(ws: WorkspaceServices, filter: { readonly rootBudgetId?: string } = {}): EstimateAccuracy {
  const rows = taskEstimates(ws).filter((r) => filter.rootBudgetId === undefined || r.rootBudgetId === filter.rootBudgetId);
  const compared = rows.filter((r): r is TaskEstimateRecord & { readonly actualMicroUsd: number } => r.actualMicroUsd !== null && r.estimateMicroUsd > 0);
  return {
    tasks: rows.length,
    compared: compared.length,
    estimateMicroUsd: compared.reduce((n, r) => n + r.estimateMicroUsd, 0),
    actualMicroUsd: compared.reduce((n, r) => n + r.actualMicroUsd, 0),
    medianRatio: median(compared.map((r) => r.actualMicroUsd / r.estimateMicroUsd)),
    underEstimated: compared.filter((r) => r.actualMicroUsd > r.estimateMicroUsd).length,
  };
}

export interface SliceVolume {
  readonly n: number;
  readonly p90InputTokens: number;
  readonly p90OutputTokens: number;
}

/** The measured p90 tokens per finished run of a slice's tasks in this workspace; null below SLICE_VOLUME_MIN_RUNS. */
export function sliceVolume(ws: WorkspaceServices, sliceId: string): SliceVolume | null {
  const tasks = new Set(taskEstimates(ws).filter((r) => r.sliceId === sliceId).map((r) => r.taskId));
  const runs = ws.host.list<WorkerRunRecord>('worker-runs').filter((r) => r.workspaceId === ws.workspaceId && tasks.has(r.taskId) && r.stale !== true && r.usage !== null);
  if (runs.length < SLICE_VOLUME_MIN_RUNS) return null;
  const input = runs.map((r) => (r.usage === null ? 0 : r.usage.inputTokens + r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens));
  const output = runs.map((r) => r.usage?.outputTokens ?? 0);
  return { n: runs.length, p90InputTokens: percentile(input, 0.9) ?? 0, p90OutputTokens: percentile(output, 0.9) ?? 0 };
}
