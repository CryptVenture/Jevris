/**
 * Plan (DAG) validation (ORC-01, SSOT §10.1, C03, C25).
 *
 * Beyond the contracts' structural check (duplicates, unknown dependencies, cycles, workspace
 * scope), a plan must: cover every stated requirement, give each node an acceptance check
 * (known to the approved manifest when one is given), an expected output and at least one
 * requirement, name only available resources, keep write sets of concurrent nodes disjoint,
 * and carry a root budget and an accountable owner.
 */
import { validateTaskGraph, type TaskNode } from '@jevris/contracts';
import { nodeFor, type TaskInput } from './tasks.js';

export type PlanIssueCode =
  | 'DUPLICATE_TASK'
  | 'UNKNOWN_DEPENDENCY'
  | 'SELF_DEPENDENCY'
  | 'CYCLE'
  | 'WORKSPACE_SCOPE'
  | 'INVALID_TASK'
  | 'NO_ACCEPTANCE_CHECK'
  | 'NO_REQUIREMENT'
  | 'WRITE_OVERLAP'
  | 'UNCOVERED_REQUIREMENT'
  | 'UNKNOWN_CHECK'
  | 'UNKNOWN_RESOURCE'
  | 'NO_EXPECTED_OUTPUT'
  | 'NO_ROOT_BUDGET'
  | 'NO_OWNER'
  | 'STORE_UNAVAILABLE'
  | 'BUDGET_CONFLICT';

export interface PlanIssue {
  readonly taskId: string;
  readonly code: PlanIssueCode;
  readonly detail?: string;
}

export interface PlanInput {
  readonly workspaceId: string;
  readonly tasks: readonly TaskInput[];
  readonly ownerId: string | null;
  readonly rootBudget: { readonly id: string; readonly limitMicroUsd: number } | null;
  /** Requirements the plan must cover (every id appears on at least one node). */
  readonly requirementIds?: readonly string[];
  /** When given, acceptance checks must be among these approved check ids. */
  readonly approvedCheckIds?: readonly string[];
  /** When given, resource keys must be among these. */
  readonly availableResources?: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly order: readonly string[]; readonly nodes: readonly TaskNode[]; readonly waves: readonly (readonly string[])[] }
  | { readonly ok: false; readonly issues: readonly PlanIssue[] };

function scopePrefix(scope: string): string {
  return scope.replace(/\/\*\*.*$/, '').replace(/\/\*$/, '').replace(/\*.*$/, '').replace(/\/+$/, '');
}

/** Two write scopes overlap when one covers the other (a glob reduces to its prefix). */
export function scopesOverlap(a: string, b: string): boolean {
  const x = scopePrefix(a);
  const y = scopePrefix(b);
  if (x === '' || y === '' || x === '.' || y === '.') return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); // path-hygiene: allow workspace-relative scope prefix
}

function ancestors(nodes: readonly TaskNode[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const out = new Set<string>();
    memo.set(id, out);
    for (const dep of byId.get(id)?.dependencyIds ?? []) {
      out.add(dep);
      for (const a of visit(dep)) out.add(a);
    }
    return out;
  };
  for (const n of nodes) visit(n.id);
  return memo;
}

/** Waves: nodes grouped by longest dependency depth, each wave sorted. */
export function wavesOf(nodes: readonly TaskNode[], order: readonly string[]): readonly (readonly string[])[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  for (const id of order) {
    const deps = byId.get(id)?.dependencyIds ?? [];
    depth.set(id, deps.length === 0 ? 0 : Math.max(...deps.map((d) => (depth.get(d) ?? 0) + 1)));
  }
  const waves: string[][] = [];
  for (const [id, d] of depth) (waves[d] ??= []).push(id);
  return waves.map((w) => w.sort());
}

export function validatePlan(input: PlanInput, nowMs = Date.now()): PlanResult {
  const issues: PlanIssue[] = [];
  if (input.ownerId === null || input.ownerId.trim().length === 0) issues.push({ taskId: '#plan', code: 'NO_OWNER' });
  if (input.rootBudget === null || !Number.isSafeInteger(input.rootBudget.limitMicroUsd) || input.rootBudget.limitMicroUsd <= 0) {
    issues.push({ taskId: '#plan', code: 'NO_ROOT_BUDGET' });
  }
  const budgetId = input.rootBudget?.id ?? 'budget';
  const nodes: TaskNode[] = [];
  input.tasks.forEach((t, index) => {
    const node = nodeFor(t, input.workspaceId, budgetId, nowMs);
    if (node === undefined) issues.push({ taskId: typeof t.id === 'string' && t.id.length <= 130 ? t.id : `#${String(index)}`, code: 'INVALID_TASK' });
    else nodes.push(node);
  });
  const structural = validateTaskGraph(nodes);
  if (!structural.ok) {
    for (const i of structural.issues) issues.push({ taskId: i.taskId, code: i.code });
    return { ok: false, issues };
  }
  const approved = input.approvedCheckIds === undefined ? undefined : new Set(input.approvedCheckIds);
  const resources = input.availableResources === undefined ? undefined : new Set(input.availableResources);
  const covered = new Set<string>();
  for (const t of input.tasks) {
    const id = t.id;
    if ((t.acceptanceCheckIds ?? []).length === 0) issues.push({ taskId: id, code: 'NO_ACCEPTANCE_CHECK' });
    for (const check of t.acceptanceCheckIds ?? []) if (approved !== undefined && !approved.has(check)) issues.push({ taskId: id, code: 'UNKNOWN_CHECK', detail: check });
    if ((t.requirementIds ?? []).length === 0) issues.push({ taskId: id, code: 'NO_REQUIREMENT' });
    for (const r of t.requirementIds ?? []) covered.add(r);
    if ((t.expectedOutputs ?? []).length === 0) issues.push({ taskId: id, code: 'NO_EXPECTED_OUTPUT' });
    for (const key of t.resourceKeys ?? []) if (resources !== undefined && !resources.has(key)) issues.push({ taskId: id, code: 'UNKNOWN_RESOURCE', detail: key });
  }
  for (const r of input.requirementIds ?? []) if (!covered.has(r)) issues.push({ taskId: '#plan', code: 'UNCOVERED_REQUIREMENT', detail: r });
  // Write sets of nodes that may run at the same time (neither is an ancestor of the other).
  const anc = ancestors(nodes);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i] as TaskNode;
      const b = nodes[j] as TaskNode;
      if (anc.get(a.id)?.has(b.id) === true || anc.get(b.id)?.has(a.id) === true) continue;
      const clash = a.writeScopes.find((x) => b.writeScopes.some((y) => scopesOverlap(x, y)));
      if (clash !== undefined) issues.push({ taskId: a.id < b.id ? a.id : b.id, code: 'WRITE_OVERLAP', detail: `${a.id}~${b.id}` });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, order: structural.order, nodes, waves: wavesOf(nodes, structural.order) };
}

/** Critical-path length (in nodes) from each node to the end of the graph. */
export function criticalPathLengths(nodes: readonly Pick<TaskNode, 'id' | 'dependencyIds'>[]): ReadonlyMap<string, number> {
  const dependants = new Map<string, string[]>();
  for (const n of nodes) for (const d of n.dependencyIds) dependants.set(d, [...(dependants.get(d) ?? []), n.id]);
  const memo = new Map<string, number>();
  const visit = (id: string, guard: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (guard.has(id)) return 1;
    guard.add(id);
    const next = dependants.get(id) ?? [];
    const len = 1 + (next.length === 0 ? 0 : Math.max(...next.map((n) => visit(n, guard))));
    guard.delete(id);
    memo.set(id, len);
    return len;
  };
  for (const n of nodes) visit(n.id, new Set());
  return memo;
}
