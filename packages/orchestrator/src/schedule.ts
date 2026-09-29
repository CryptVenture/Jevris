import { issueLease, leaseAndReserve, type OpenStoreResult } from '@jevris/store';

const WAIVER_OPS = new Set(['waive-lock', 'waive-budget', 'launch-conflicting']);
const LAUNCH_CAP = 2;

export interface ScheduleTask {
  readonly taskId: string;
  readonly state: string;
  readonly resourceKey: string;
  readonly dependsOn?: readonly string[];
  readonly ownerId?: string;
  readonly directory?: string;
}

export interface ScheduleInput {
  readonly tasks: readonly ScheduleTask[];
  readonly schedulingStopped: boolean;
  readonly killSwitchStopped: boolean;
  readonly op?: string;
  readonly jevApproved?: boolean;
  readonly store?: OpenStoreResult;
  readonly ownerId?: string;
  readonly now?: string;
}

export interface ScheduledLease {
  readonly taskId: string;
  readonly resourceKey: string;
  readonly state: 'leased';
}

export interface ScheduleResult {
  readonly ok: boolean;
  readonly refused: boolean;
  readonly leased: readonly ScheduledLease[];
  readonly reason?: 'cycle' | 'refused' | 'stopped';
}

function stopped(reason: 'cycle' | 'refused' | 'stopped'): ScheduleResult {
  return { ok: false, refused: true, leased: [], reason };
}

function hasCycle(tasks: readonly ScheduleTask[]): boolean {
  const byId = new Map<string, ScheduleTask>();
  for (const task of tasks) byId.set(task.taskId, task);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function walk(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const task = byId.get(id);
    const deps = task === undefined ? [] : (task.dependsOn ?? []);
    for (const dep of deps) {
      if (!byId.has(dep)) continue;
      if (walk(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const id of byId.keys()) {
    if (walk(id)) return true;
  }
  return false;
}

function selectable(tasks: readonly ScheduleTask[]): readonly ScheduleTask[] {
  const byId = new Map<string, ScheduleTask>();
  for (const task of tasks) byId.set(task.taskId, task);
  const chosen: ScheduleTask[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.state !== 'ready') continue;
    if (seen.has(task.resourceKey)) continue;
    const deps = task.dependsOn ?? [];
    let waiting = false;
    for (const dep of deps) {
      const prior = byId.get(dep);
      if (prior !== undefined && prior.state !== 'verified') waiting = true;
    }
    if (waiting) continue;
    seen.add(task.resourceKey);
    chosen.push(task);
    if (chosen.length === LAUNCH_CAP) break;
  }
  return chosen;
}

function persist(input: ScheduleInput, task: ScheduleTask): boolean {
  const store = input.store;
  if (store === undefined) return true;
  const ownerId = task.ownerId ?? input.ownerId ?? 'ownerA';
  const directory = task.directory ?? `pending-${task.taskId}`;
  const stamp = input.now ?? '1970-01-01T00:00:00Z';
  const issued = issueLease(store, {
    leaseId: task.taskId,
    taskId: task.taskId,
    ownerId,
    resourceKey: task.resourceKey,
    directory,
    heartbeatAt: stamp,
    expiresAt: stamp,
  });
  return issued.ok;
}

export function scheduleReady(input: ScheduleInput): ScheduleResult {
  if (input.op !== undefined && WAIVER_OPS.has(input.op)) {
    void input.jevApproved;
    return stopped('refused');
  }
  if (input.schedulingStopped || input.killSwitchStopped) return stopped('stopped');
  if (hasCycle(input.tasks)) return stopped('cycle');
  const leased: ScheduledLease[] = [];
  for (const task of selectable(input.tasks)) {
    if (!persist(input, task)) continue;
    leased.push({ taskId: task.taskId, resourceKey: task.resourceKey, state: 'leased' });
  }
  return { ok: true, refused: false, leased };
}

export interface LaunchOwnedInput {
  readonly store: OpenStoreResult;
  readonly leaseId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly resourceKey: string;
  readonly directory: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly reservationId: string;
  readonly reservedMicroUsd: bigint;
  readonly envelopeMicroUsd: bigint;
  readonly revision: string;
  readonly mandatoryCheckIds: readonly string[];
  readonly sessionFactory: () => unknown;
}

export type LaunchOwnedResult =
  | {
      readonly ok: true;
      readonly factoryCalled: true;
      readonly mandatoryCheckIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly factoryCalled: false;
      readonly reason: string;
      readonly mandatoryCheckIds: readonly string[];
    };

export function launchOwned(input: LaunchOwnedInput): LaunchOwnedResult {
  const reserved = leaseAndReserve(input.store, {
    leaseId: input.leaseId,
    taskId: input.taskId,
    ownerId: input.ownerId,
    resourceKey: input.resourceKey,
    directory: input.directory,
    heartbeatAt: input.heartbeatAt,
    expiresAt: input.expiresAt,
    reservationId: input.reservationId,
    reservedMicroUsd: input.reservedMicroUsd,
    envelopeMicroUsd: input.envelopeMicroUsd,
    revision: input.revision,
    mandatoryCheckIds: input.mandatoryCheckIds,
  });
  if (!reserved.ok) {
    return {
      ok: false,
      factoryCalled: false,
      reason: reserved.reason,
      mandatoryCheckIds: reserved.mandatoryCheckIds,
    };
  }
  input.sessionFactory();
  return {
    ok: true,
    factoryCalled: true,
    mandatoryCheckIds: reserved.mandatoryCheckIds,
  };
}
