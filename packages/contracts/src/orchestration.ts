/** Chapter 6.2 orchestration contracts: TaskNode, AgentLease, BudgetReservation. */
import { defineContract, timestampMs } from './contract.js';
import { Id, IdList, MAX_SAFE_INTEGER, NonNegativeInteger, PositiveInteger, Timestamp } from './primitives.js';
import * as S from './schema.js';

export const TASK_STATES = [
  'proposed',
  'validated',
  'ready',
  'leased',
  'running',
  'awaiting-evidence',
  'verifying',
  'verified',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A write scope is a workspace-relative, forward-slash path pattern. No absolute path, no `..`. */
export const WRITE_SCOPE_PATTERN = '^(?![/\\\\])(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._*/-]{1,256}$';

export const TaskNodeSchema = S.object({
  id: Id,
  schemaVersion: S.literal('1.0'),
  workspaceId: Id,
  revision: Id,
  state: S.enumOf(TASK_STATES),
  requirementIds: IdList(),
  dependencyIds: IdList(),
  writeScopes: S.array(S.string({ pattern: WRITE_SCOPE_PATTERN }), { maxItems: 256, uniqueItems: true }),
  acceptanceCheckIds: IdList(),
  rootBudgetId: Id,
});
export type TaskNode = S.Static<typeof TaskNodeSchema>;

export const TaskNodeContract = defineContract<TaskNode>({
  name: 'TaskNode',
  description: 'A task with requirement ids, dependencies, write scope, acceptance checks and state/revision (§6.2).',
  schema: TaskNodeSchema,
  refine: (value, issue) => {
    if (value.dependencyIds.includes(value.id)) issue('/dependencyIds', 'SELF_DEPENDENCY');
  },
});

export interface TaskGraphIssue {
  readonly taskId: string;
  readonly code: 'DUPLICATE_TASK' | 'UNKNOWN_DEPENDENCY' | 'SELF_DEPENDENCY' | 'CYCLE' | 'WORKSPACE_SCOPE' | 'INVALID_TASK';
}

export type TaskGraphResult =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly issues: readonly TaskGraphIssue[] };

/** Validates a task graph. A cyclic graph cannot be scheduled (§6.2); the result is a stable topological order. */
export function validateTaskGraph(nodes: readonly unknown[]): TaskGraphResult {
  const issues: TaskGraphIssue[] = [];
  const byId = new Map<string, TaskNode>();
  let workspaceId: string | undefined;
  nodes.forEach((raw, index) => {
    const checked = TaskNodeContract.validate(raw);
    if (!checked.ok) {
      issues.push({ taskId: `#${index}`, code: 'INVALID_TASK' });
      return;
    }
    const node = checked.value;
    if (byId.has(node.id)) issues.push({ taskId: node.id, code: 'DUPLICATE_TASK' });
    byId.set(node.id, node);
    workspaceId ??= node.workspaceId;
    if (node.workspaceId !== workspaceId) issues.push({ taskId: node.id, code: 'WORKSPACE_SCOPE' });
  });
  for (const node of byId.values()) {
    for (const dependency of node.dependencyIds) {
      if (!byId.has(dependency)) issues.push({ taskId: node.id, code: 'UNKNOWN_DEPENDENCY' });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  // Kahn's algorithm with a sorted ready set for a deterministic order.
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of byId.values()) {
    remaining.set(node.id, node.dependencyIds.length);
    for (const dependency of node.dependencyIds) {
      const list = dependents.get(dependency) ?? [];
      list.push(node.id);
      dependents.set(dependency, list);
    }
  }
  const ready = [...remaining.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== byId.size) {
    const cyclic = [...remaining.entries()].filter(([, count]) => count > 0).map(([id]) => id).sort();
    return { ok: false, issues: cyclic.map((taskId) => ({ taskId, code: 'CYCLE' as const })) };
  }
  return { ok: true, order };
}

export const AgentLeaseSchema = S.object({
  id: Id,
  taskId: Id,
  ownerId: Id,
  workspaceId: Id,
  worktreeId: Id,
  fencingToken: PositiveInteger,
  heartbeatAt: Timestamp,
  expiresAt: Timestamp,
});
export type AgentLease = S.Static<typeof AgentLeaseSchema>;

export const AgentLeaseContract = defineContract<AgentLease>({
  name: 'AgentLease',
  description: 'Owner, task, worktree, heartbeat, fencing token and expiry of one writer (§6.2).',
  schema: AgentLeaseSchema,
  refine: (value, issue) => {
    if (timestampMs(value.expiresAt) <= timestampMs(value.heartbeatAt)) issue('/expiresAt', 'EXPIRY_NOT_AFTER_HEARTBEAT');
  },
});

export const RESERVATION_STATES = ['reserved', 'committed', 'released', 'uncertain'] as const;

export const BudgetReservationSchema = S.object({
  id: Id,
  budgetId: Id,
  ownerId: Id,
  currency: S.literal('USD'),
  reservedMicroUsd: NonNegativeInteger,
  actualMicroUsd: S.nullable(NonNegativeInteger),
  state: S.enumOf(RESERVATION_STATES),
  revision: Id,
});
export type BudgetReservation = S.Static<typeof BudgetReservationSchema>;

export const BudgetReservationContract = defineContract<BudgetReservation>({
  name: 'BudgetReservation',
  description: 'A fixed-point micro-USD reservation. Unknown spend is uncertain, never zero (§6.2).',
  schema: BudgetReservationSchema,
  refine: (value, issue) => {
    if (value.state === 'committed' && value.actualMicroUsd === null) issue('/actualMicroUsd', 'COMMITTED_WITHOUT_ACTUAL');
    if ((value.state === 'reserved' || value.state === 'uncertain') && value.actualMicroUsd !== null) {
      issue('/actualMicroUsd', 'ACTUAL_BEFORE_COMMIT');
    }
  },
});

/**
 * The micro-USD a reservation holds against its budget. Reserved and uncertain hold the full
 * reservation (uncertain spend is never assumed to be zero); committed holds the actual;
 * released holds nothing.
 */
export function heldMicroUsd(reservation: BudgetReservation): number {
  switch (reservation.state) {
    case 'reserved':
    case 'uncertain':
      return reservation.reservedMicroUsd;
    case 'committed':
      return reservation.actualMicroUsd ?? reservation.reservedMicroUsd;
    case 'released':
      return 0;
  }
}

export type BudgetCheck =
  | { readonly ok: true; readonly heldMicroUsd: number }
  | { readonly ok: false; readonly reasonCode: 'OVER_BUDGET' | 'WRONG_BUDGET' | 'UNSAFE_INTEGER'; readonly heldMicroUsd: number };

/** Concurrent reservations cannot exceed the owned budget (§6.2). */
export function reservationsWithinBudget(
  budgetId: string,
  limitMicroUsd: number,
  reservations: readonly BudgetReservation[],
): BudgetCheck {
  let held = 0;
  for (const reservation of reservations) {
    if (reservation.budgetId !== budgetId) return { ok: false, reasonCode: 'WRONG_BUDGET', heldMicroUsd: held };
    held += heldMicroUsd(reservation);
    if (!Number.isSafeInteger(held) || held > MAX_SAFE_INTEGER) return { ok: false, reasonCode: 'UNSAFE_INTEGER', heldMicroUsd: held };
  }
  if (!Number.isSafeInteger(limitMicroUsd) || held > limitMicroUsd) return { ok: false, reasonCode: 'OVER_BUDGET', heldMicroUsd: held };
  return { ok: true, heldMicroUsd: held };
}
