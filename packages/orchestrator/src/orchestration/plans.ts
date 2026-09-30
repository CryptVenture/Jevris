/**
 * Plan and task submission (ORC-01, ORC-02). A plan is validated as a whole (§10.1); its root
 * budget goes to the host ledger and its nodes to B's store, each created `proposed` and then
 * moved to `validated` by the planner once the whole plan is in.
 */
import type { WorkspaceServices } from '../workspace.js';
import { approvedManifests } from '../verify/service.js';
import { validatePlan, type PlanIssue, type PlanResult } from './graph.js';
import type { BudgetPolicy, BudgetRecord } from './leases.js';
import { createTaskRecord, getTask, listTasks, taskStore, taskTransition, type TaskInput } from './tasks.js';
import type { TaskNode } from '@jevris/contracts';
import { hashOf, recordKey } from '../util.js';

export interface PlanSubmission {
  readonly tasks: readonly TaskInput[];
  readonly ownerId: string | null;
  readonly rootBudget: {
    readonly id: string;
    readonly limitMicroUsd: number;
    readonly shutdownReserveMicroUsd?: number;
    readonly policy?: BudgetPolicy;
  } | null;
  readonly requirementIds?: readonly string[];
  readonly availableResources?: readonly string[];
  /** Require acceptance checks to be approved runner checks (default true). */
  readonly requireApprovedChecks?: boolean;
}

export type SubmitPlanResult =
  | { readonly ok: true; readonly planId?: string; readonly rootBudgetId?: string; readonly taskIds: readonly string[]; readonly waves: readonly (readonly string[])[] }
  | { readonly ok: false; readonly issues: readonly PlanIssue[] };

export function checkPlan(ws: WorkspaceServices, plan: PlanSubmission, nowMs = Date.now()): PlanResult {
  return validatePlan(
    {
      workspaceId: ws.workspaceId,
      tasks: plan.tasks,
      ownerId: plan.ownerId,
      rootBudget: plan.rootBudget,
      ...(plan.requirementIds === undefined ? {} : { requirementIds: plan.requirementIds }),
      ...(plan.availableResources === undefined ? {} : { availableResources: plan.availableResources }),
      ...(plan.requireApprovedChecks === false ? {} : { approvedCheckIds: approvedManifests(ws).map((m) => m.id) }),
    },
    nowMs,
  );
}

/** Creates the nodes (in dependency order) and then validates each. */
function writeNodes(ws: WorkspaceServices, nodes: readonly TaskNode[], inputs: ReadonlyMap<string, TaskInput>, owner: string, nowMs: number): SubmitPlanResult | undefined {
  for (const node of nodes) {
    const made = createTaskRecord(ws, node, inputs.get(node.id) as TaskInput, owner, nowMs);
    if (!made.ok) return { ok: false, issues: [{ taskId: node.id, code: made.reasonCode === 'DUPLICATE_TASK' ? 'DUPLICATE_TASK' : 'INVALID_TASK' }] };
  }
  for (const node of nodes) taskTransition(ws, node.id, 'validated', 'PLAN_VALIDATED', { actor: 'planner', nowMs });
  return undefined;
}

export async function submitPlan(ws: WorkspaceServices, plan: PlanSubmission, nowMs = Date.now()): Promise<SubmitPlanResult> {
  const checked = checkPlan(ws, plan, nowMs);
  if (!checked.ok) return checked;
  if (taskStore(ws) === undefined) return { ok: false, issues: [{ taskId: '#plan', code: 'STORE_UNAVAILABLE' }] };
  const duplicate = checked.nodes.find((node) => getTask(ws, node.id) !== undefined);
  if (duplicate !== undefined) return { ok: false, issues: [{ taskId: duplicate.id, code: 'DUPLICATE_TASK' }] };
  const budget = plan.rootBudget as NonNullable<PlanSubmission['rootBudget']>;
  const owner = (plan.ownerId as string).trim();
  const inputs = new Map(plan.tasks.map((t) => [t.id, t]));
  // A reserve or policy the plan did not name is the default for a new budget and the recorded
  // value for an existing one: `budget update` may have changed the limit since (JEV-0034).
  const namedReserve = budget.shutdownReserveMicroUsd === undefined ? undefined : Math.min(budget.shutdownReserveMicroUsd, budget.limitMicroUsd - 1);
  const reserve = namedReserve ?? Math.min(Math.floor(budget.limitMicroUsd / 20), budget.limitMicroUsd - 1);
  const policy = budget.policy ?? 'finish-running';
  const planId = `plan-${hashOf({ ws: ws.workspaceId, tasks: checked.order, budget: budget.id, at: nowMs }).slice(0, 20)}`;
  // A budget id is written once: resubmitting the same budget reuses it, and a different limit,
  // a named reserve or policy that differs, or another owner under an existing id is refused (it
  // would reset the money). The limit is the recorded one, including after `budget update`.
  const conflict = await ws.host.transact((tx) => {
    const existing = tx.get<BudgetRecord>('budgets', budget.id);
    if (existing !== undefined) {
      if (
        existing.limitMicroUsd !== budget.limitMicroUsd ||
        (namedReserve !== undefined && existing.shutdownReserveMicroUsd !== namedReserve) ||
        (budget.policy !== undefined && existing.policy !== budget.policy) ||
        existing.ownerId !== owner
      ) {
        return true;
      }
    } else {
      tx.put('budgets', budget.id, {
        id: budget.id,
        workspaceId: ws.workspaceId,
        ownerId: owner,
        limitMicroUsd: budget.limitMicroUsd,
        shutdownReserveMicroUsd: reserve,
        policy,
        createdAt: new Date(nowMs).toISOString(),
      } satisfies BudgetRecord);
    }
    tx.put('plans', recordKey(ws.workspaceId, planId), { planId, workspaceId: ws.workspaceId, rootBudgetId: budget.id, ownerId: owner, taskIds: checked.order, createdAtMs: nowMs } satisfies PlanRecord);
    return false;
  });
  if (conflict) return { ok: false, issues: [{ taskId: '#plan', code: 'BUDGET_CONFLICT', detail: budget.id }] };
  const byId = new Map(checked.nodes.map((n) => [n.id, n]));
  const ordered = checked.order.map((id) => byId.get(id)).filter((n): n is TaskNode => n !== undefined);
  const failed = writeNodes(ws, ordered, inputs, owner, nowMs);
  if (failed !== undefined) return failed;
  return { ok: true, planId, rootBudgetId: budget.id, taskIds: checked.order, waves: checked.waves };
}

export interface PlanRecord {
  readonly planId: string;
  readonly workspaceId: string;
  readonly rootBudgetId: string;
  readonly ownerId: string;
  readonly taskIds: readonly string[];
  readonly createdAtMs: number;
}

export function getPlan(ws: WorkspaceServices, planId: string): PlanRecord | undefined {
  return ws.host.get<PlanRecord>('plans', recordKey(ws.workspaceId, planId));
}

/**
 * Adds one task to an existing plan (the `task.submit` op). Its dependencies must already
 * exist, its budget must exist, and the extended graph must still validate.
 */
export async function submitTask(ws: WorkspaceServices, input: TaskInput, rootBudgetId: string, ownerId: string, nowMs = Date.now()): Promise<SubmitPlanResult> {
  if (taskStore(ws) === undefined) return { ok: false, issues: [{ taskId: input.id, code: 'STORE_UNAVAILABLE' }] };
  const budget = ws.host.get<BudgetRecord>('budgets', rootBudgetId);
  if (budget === undefined || budget.workspaceId !== ws.workspaceId) return { ok: false, issues: [{ taskId: input.id, code: 'NO_ROOT_BUDGET' }] };
  const existing = listTasks(ws).filter((t) => t.node.state !== 'cancelled');
  // A cancelled task is out of the graph, so a task that depended on it (now blocked) must not
  // make every later submit fail: validate the live tasks against the live ids only (JEV-0035).
  const live = new Set(existing.map((t) => t.node.id));
  const asInputs: TaskInput[] = existing.map((t) => ({
    id: t.node.id,
    requirementIds: t.node.requirementIds,
    dependencyIds: t.node.dependencyIds.filter((d) => live.has(d)),
    writeScopes: t.node.writeScopes,
    acceptanceCheckIds: t.node.acceptanceCheckIds,
    expectedOutputs: t.expectedOutputs.length > 0 ? t.expectedOutputs : ['existing'],
  }));
  const checked = validatePlan(
    {
      workspaceId: ws.workspaceId,
      tasks: [...asInputs.filter((t) => t.id !== input.id), input],
      ownerId,
      rootBudget: { id: budget.id, limitMicroUsd: budget.limitMicroUsd },
      // Acceptance checks are the approved runner checks, as for a plan: a task added later does
      // not get to name one nobody approved (JEV-0038).
      approvedCheckIds: approvedManifests(ws).map((m) => m.id),
    },
    nowMs,
  );
  if (!checked.ok) {
    // Only what is wrong with the new task refuses it; a fault in another task is not its doing.
    const own = checked.issues.filter((i) => i.taskId === input.id || i.taskId === '#plan' || (i.code === 'WRITE_OVERLAP' && (i.detail ?? '').split('~').includes(input.id)));
    return { ok: false, issues: own.length > 0 ? own : checked.issues };
  }
  if (getTask(ws, input.id) !== undefined) return { ok: false, issues: [{ taskId: input.id, code: 'DUPLICATE_TASK' }] };
  const node = checked.nodes.find((n) => n.id === input.id);
  if (node === undefined) return { ok: false, issues: [{ taskId: input.id, code: 'INVALID_TASK' }] };
  const failed = writeNodes(ws, [{ ...node, rootBudgetId }], new Map([[input.id, input]]), ownerId, nowMs);
  if (failed !== undefined) return failed;
  return { ok: true, taskIds: [node.id], waves: [[node.id]] };
}
