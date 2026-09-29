/**
 * Deterministic plan analysis for the `plan` op (§10.1, §12.1 C03/C07).
 *
 * Ids, dependencies and cycles are checked in code (`validateTaskGraph`); waves, the critical
 * path, the ready set and parallel write-scope overlaps are computed here. A Jev Score may be
 * added on top as a decomposition audit, but it never replaces these checks and is never
 * labelled feasibility.
 */
import { validateTaskGraph, type PlanPayload, type TaskNode } from '@jevris/contracts';

function scopeRoot(scope: string): string {
  const star = scope.indexOf('*');
  const head = star === -1 ? scope : scope.slice(0, star);
  return head.replace(/\/+$/, '');
}

/** Two write scopes overlap when one covers the other; a bare glob covers everything. */
export function writeScopesOverlap(a: string, b: string): boolean {
  const ra = scopeRoot(a);
  const rb = scopeRoot(b);
  if (ra.length === 0 || rb.length === 0) return true;
  return ra === rb || ra.startsWith(rb + '/') || rb.startsWith(ra + '/');
}

type Issue = PlanPayload['issues'][number];

/** The deterministic plan payload for a task list (untrusted input). */
export function planTaskGraph(tasks: readonly unknown[]): PlanPayload {
  const checked = validateTaskGraph(tasks);
  if (!checked.ok) {
    const issues: Issue[] = checked.issues.slice(0, 1024).map((issue) => ({ taskId: issue.taskId.slice(0, 130), code: issue.code }));
    const codes = new Set(issues.map((issue) => issue.code));
    const advice: string[] = [];
    if (codes.has('CYCLE')) advice.push('Break the dependency cycle; a cyclic graph cannot be scheduled.');
    if (codes.has('UNKNOWN_DEPENDENCY')) advice.push('Add the missing tasks or remove the dependencies on them.');
    if (codes.has('SELF_DEPENDENCY')) advice.push('Remove the dependencies of tasks on themselves.');
    if (codes.has('INVALID_TASK')) advice.push('Fix the task nodes that do not match the TaskNode contract.');
    if (codes.has('DUPLICATE_TASK')) advice.push('Give every task a unique id.');
    if (codes.has('WORKSPACE_SCOPE')) advice.push('Keep every task in one workspace.');
    return { valid: false, taskCount: tasks.length, order: [], waves: [], criticalPath: [], ready: [], issues, advice };
  }
  const nodes = new Map<string, TaskNode>();
  for (const raw of tasks) nodes.set((raw as TaskNode).id, raw as TaskNode);
  const depth = new Map<string, number>();
  const via = new Map<string, string | null>();
  for (const id of checked.order) {
    const node = nodes.get(id) as TaskNode;
    let best = 0;
    let from: string | null = null;
    for (const dep of node.dependencyIds) {
      const d = (depth.get(dep) ?? 0) + 1;
      if (d > best || (d === best && from !== null && dep < from)) {
        best = d;
        from = dep;
      }
    }
    depth.set(id, best);
    via.set(id, from);
  }
  const waves: string[][] = [];
  for (const id of checked.order) {
    const d = depth.get(id) ?? 0;
    while (waves.length <= d) waves.push([]);
    (waves[d] as string[]).push(id);
  }
  let tail: string | null = null;
  let tailDepth = -1;
  for (const id of checked.order) {
    const d = depth.get(id) ?? 0;
    if (d > tailDepth) {
      tailDepth = d;
      tail = id;
    }
  }
  const criticalPath: string[] = [];
  while (tail !== null) {
    criticalPath.unshift(tail);
    tail = via.get(tail) ?? null;
  }
  const finished = new Set(['verified', 'cancelled']);
  const ready = checked.order.filter((id) => {
    const node = nodes.get(id) as TaskNode;
    if (node.state !== 'proposed' && node.state !== 'ready') return false;
    return node.dependencyIds.every((dep) => nodes.get(dep)?.state === 'verified');
  });
  const issues: Issue[] = [];
  for (const id of checked.order) {
    const node = nodes.get(id) as TaskNode;
    if (node.acceptanceCheckIds.length === 0) issues.push({ taskId: id, code: 'NO_ACCEPTANCE_CHECK' });
    if (node.requirementIds.length === 0) issues.push({ taskId: id, code: 'NO_REQUIREMENT' });
  }
  const reach = new Map<string, Set<string>>();
  for (const id of checked.order) {
    const node = nodes.get(id) as TaskNode;
    const set = new Set<string>();
    for (const dep of node.dependencyIds) {
      set.add(dep);
      for (const up of reach.get(dep) ?? []) set.add(up);
    }
    reach.set(id, set);
  }
  const open = checked.order.filter((id) => !finished.has((nodes.get(id) as TaskNode).state));
  const overlapping = new Set<string>();
  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const a = open[i] as string;
      const b = open[j] as string;
      if (reach.get(a)?.has(b) === true || reach.get(b)?.has(a) === true) continue;
      const na = nodes.get(a) as TaskNode;
      const nb = nodes.get(b) as TaskNode;
      if (na.writeScopes.some((sa) => nb.writeScopes.some((sb) => writeScopesOverlap(sa, sb)))) {
        overlapping.add(a);
        overlapping.add(b);
      }
    }
  }
  for (const id of [...overlapping].sort()) issues.push({ taskId: id, code: 'WRITE_OVERLAP' });
  const advice: string[] = [];
  if (issues.some((issue) => issue.code === 'NO_ACCEPTANCE_CHECK')) advice.push('Give every task at least one acceptance check; completion needs a runner receipt.');
  if (issues.some((issue) => issue.code === 'NO_REQUIREMENT')) advice.push('Link every task to the requirement it covers.');
  if (overlapping.size > 0) advice.push('Tasks that can run in parallel share a write scope; add a dependency or split the scope.');
  advice.push(`${waves.length} wave(s); the critical path has ${criticalPath.length} task(s).`);
  if (ready.length > 0) advice.push(`Ready now: ${ready.slice(0, 8).join(', ')}${ready.length > 8 ? ' and more' : ''}.`);
  return {
    valid: issues.length === 0,
    taskCount: checked.order.length,
    order: [...checked.order],
    waves,
    criticalPath,
    ready,
    issues: issues.slice(0, 1024),
    advice: advice.slice(0, 32).map((line) => line.slice(0, 500)),
  };
}
