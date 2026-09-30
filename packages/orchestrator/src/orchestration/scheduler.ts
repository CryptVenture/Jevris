/**
 * Scheduler v2 (ORC-02, SSOT §10.2, C27, US19, US32).
 *
 * 1. A validated task becomes ready when every prerequisite is verified, by checks or by a
 *    human exception.
 * 2. Ready tasks are filtered by runner toolchains, data scope and model eligibility.
 * 3. Order: longest critical path first, then value per budget, then age, then id.
 * 4. Leases and reservations are taken in one transaction by the lease authority, which counts
 *    the global cap (default 2) from running leases, not from a caller's list.
 */
import type { WorkspaceServices } from '../workspace.js';
import { criticalPathLengths } from './graph.js';
import { DEFAULT_GLOBAL_CAP, type LeaseAuthority, type LeaseGrant, type LeaseRefusalCode } from './leases.js';
import type { ProcessIdentity } from './liveness.js';
import { listTasks, prerequisiteSatisfied, taskTransition, type TaskRecord } from './tasks.js';

export interface RunnerProfile {
  /** Toolchain programs available on this runner; undefined means "do not filter". */
  readonly toolchains?: readonly string[];
  readonly dataScopes?: readonly string[];
  readonly models?: readonly string[];
}

export interface ScheduleOptions {
  readonly authority: LeaseAuthority;
  readonly holder: ProcessIdentity;
  readonly cap?: number;
  readonly nowMs?: number;
  readonly runner?: RunnerProfile;
  readonly worktreeIdFor?: (task: TaskRecord) => string;
  readonly ttlMs?: number;
  /** Scheduling is off while the kill switch or a user stop is in force. */
  readonly stopped?: boolean;
  /** Only consider these task ids (e.g. the task just submitted). */
  readonly only?: readonly string[];
}

export type SkipReason = 'TOOLCHAIN_MISSING' | 'DATA_SCOPE' | 'MODEL_INELIGIBLE' | 'STOPPED' | LeaseRefusalCode;

export interface ScheduleOutcome {
  readonly promoted: readonly string[];
  readonly leased: readonly LeaseGrant[];
  readonly skipped: readonly { readonly taskId: string; readonly reason: SkipReason }[];
}

/** Reason recorded on a queued task whose prerequisite was cancelled (JEV-0035). */
export const DEPENDENCY_CANCELLED = 'DEPENDENCY_CANCELLED';

/**
 * A prerequisite that was cancelled can never be verified, so every queued task that depends on
 * it, directly or through another queued task, can never start. Nothing is cancelled for the
 * person: each is marked `blocked` with the reason DEPENDENCY_CANCELLED, so task status says why
 * it waits and a person decides (cancel it, or re-plan). Tasks that are leased, running or past
 * that are left alone.
 */
export function blockCancelledDependants(ws: WorkspaceServices, nowMs = Date.now()): readonly string[] {
  const all = listTasks(ws);
  // Cancelled tasks, and tasks already blocked by this rule, both pass the doom on.
  const doomed = new Set<string>(all.filter((t) => t.node.state === 'cancelled' || (t.node.state === 'blocked' && t.stateReason === DEPENDENCY_CANCELLED)).map((t) => t.node.id));
  const queued = all.filter((t) => t.node.state === 'proposed' || t.node.state === 'validated' || t.node.state === 'ready');
  const blocked: string[] = [];
  for (let changed = doomed.size > 0; changed; ) {
    changed = false;
    for (const task of queued) {
      if (doomed.has(task.node.id) || !task.node.dependencyIds.some((d) => doomed.has(d))) continue;
      const moved = taskTransition(ws, task.node.id, 'blocked', DEPENDENCY_CANCELLED, { actor: 'scheduler', nowMs, expectedRevision: task.node.revision });
      if (!moved.ok) continue;
      doomed.add(task.node.id);
      blocked.push(task.node.id);
      changed = true;
    }
  }
  return blocked.sort();
}

/**
 * Promotes validated tasks whose prerequisites are all verified (by checks or a human
 * exception) to `ready`. The store re-checks the dependencies and blocks a task with an
 * unknown one.
 */
export async function promoteReady(ws: WorkspaceServices, nowMs = Date.now()): Promise<readonly string[]> {
  const promoted: string[] = [];
  const all = listTasks(ws);
  const byId = new Map(all.map((t) => [t.node.id, t]));
  for (const task of all) {
    if (task.node.state !== 'validated') continue;
    const ok = task.node.dependencyIds.every((d) => {
      const dep = byId.get(d);
      return dep !== undefined && prerequisiteSatisfied(dep);
    });
    if (!ok) continue;
    const moved = taskTransition(ws, task.node.id, 'ready', 'PREREQUISITES_VERIFIED', { actor: 'scheduler', nowMs, expectedRevision: task.node.revision });
    if (moved.ok && moved.task.node.state === 'ready') promoted.push(task.node.id);
  }
  return promoted.sort();
}

export function orderCandidates(tasks: readonly TaskRecord[], all: readonly TaskRecord[]): readonly TaskRecord[] {
  const critical = criticalPathLengths(all.map((t) => t.node));
  const perBudget = (t: TaskRecord) => t.value / Math.max(1, t.estimateMicroUsd);
  return [...tasks].sort(
    (a, b) =>
      (critical.get(b.node.id) ?? 1) - (critical.get(a.node.id) ?? 1) ||
      perBudget(b) - perBudget(a) ||
      a.createdAtMs - b.createdAtMs ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
  );
}

function eligibility(task: TaskRecord, runner: RunnerProfile): SkipReason | null {
  if (runner.toolchains !== undefined && task.toolchains.some((t) => !runner.toolchains?.includes(t))) return 'TOOLCHAIN_MISSING';
  if (runner.dataScopes !== undefined && !runner.dataScopes.includes(task.dataScope)) return 'DATA_SCOPE';
  if (runner.models !== undefined && task.models.length > 0 && !task.models.some((m) => runner.models?.includes(m))) return 'MODEL_INELIGIBLE';
  return null;
}

export async function scheduleTasks(ws: WorkspaceServices, options: ScheduleOptions): Promise<ScheduleOutcome> {
  const nowMs = options.nowMs ?? Date.now();
  if (options.stopped === true) {
    const ready = listTasks(ws, { states: ['ready'] });
    return { promoted: [], leased: [], skipped: ready.map((t) => ({ taskId: t.node.id, reason: 'STOPPED' as const })) };
  }
  blockCancelledDependants(ws, nowMs);
  const promoted = await promoteReady(ws, nowMs);
  const all = listTasks(ws);
  const skipped: { taskId: string; reason: SkipReason }[] = [];
  const candidates: TaskRecord[] = [];
  for (const task of all) {
    if (task.node.state !== 'ready') continue;
    if (options.only !== undefined && !options.only.includes(task.node.id)) continue;
    const why = eligibility(task, options.runner ?? {});
    if (why !== null) skipped.push({ taskId: task.node.id, reason: why });
    else candidates.push(task);
  }
  const ordered = orderCandidates(candidates, all);
  const result = await options.authority.acquire(
    ws.workspaceId,
    ordered.map((task) => ({
      taskId: task.node.id,
      ownerId: task.ownerId,
      worktreeId: options.worktreeIdFor?.(task) ?? `wt-${task.node.id}`.slice(0, 128),
      reserveMicroUsd: task.estimateMicroUsd,
      holder: options.holder,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    })),
    { cap: Math.max(1, Math.min(options.cap ?? DEFAULT_GLOBAL_CAP, 64)), nowMs },
  );
  for (const r of result.refused) skipped.push({ taskId: r.taskId, reason: r.reasonCode });
  return { promoted, leased: result.granted, skipped };
}
