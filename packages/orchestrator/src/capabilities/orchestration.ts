/**
 * Orchestration and agent-management capabilities (SSOT §12.4): C25 DAG dependency
 * suggestions, C26 worker-role allocation, C28 duplicate-work detection, C30 worker handoff
 * readiness.
 *
 * - C25 suggests dependencies between planned tasks; code refuses any suggestion that would
 *   close a cycle, and every suggestion waits for a planner's review (nothing is applied).
 * - C26 picks among installed agents whose tool allowlists cover the phase, least privilege
 *   first; no tool is ever added to an agent.
 * - C28 groups owned tasks that touch the same paths and objectives, keeps one survivor per
 *   group, and recommends cancelling the others only with the user's approval. A false
 *   cancellation is recorded only when a user reverts one (`recordDuplicateRevert`).
 * - C30 lists what a handoff is missing (requirements, checks, outputs, scope, source
 *   references, the latest diff); a passing answer never replaces the acceptance checks.
 */
import { isAbsolute, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { getPlan } from '../orchestration/plans.js';
import { getTask, listTasks, type TaskRecord } from '../orchestration/tasks.js';
import { ownedSessions, workerRuns } from '../orchestration/workers.js';
import { getWorktree } from '../worktree.js';
import { recordKey, sha256, type Rec } from '../util.js';
import { consultChoice, consultNoul } from './consult.js';
import { abstainAdvice, advice, byScore, type CapabilityContext, type CapabilityDefinition, type RankedItem } from './advice.js';
import { changedFiles, moduleOf, pathKey, readBounded } from './repo.js';
import { parseSkillMeta, words } from './retrieval.js';

function strOf(input: Rec, key: string, max = 500): string {
  const v = input[key];
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function strsOf(input: Rec, key: string, maxItems = 64, maxLen = 500): string[] {
  const v = input[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.slice(0, maxLen)) : [];
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const norm = (s: string) => s.replace(/\/\*\*.*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
  return a.some((x) => b.some((y) => {
    const p = norm(x);
    const q = norm(y);
    return p === q || p === '' || q === '' || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
  }));
}

// ------------------------------------------------------------------ C25 dependencies

function tasksFor(cx: CapabilityContext, input: Rec): readonly TaskRecord[] {
  const planId = strOf(input, 'planId', 64);
  const plan = planId === '' ? undefined : getPlan(cx.ws, planId);
  if (plan !== undefined) return plan.taskIds.map((id) => getTask(cx.ws, id)).filter((t): t is TaskRecord => t !== undefined);
  return listTasks(cx.ws, { states: ['proposed', 'validated', 'ready', 'blocked'] });
}

/** True when adding from -> to (to depends on from) would close a cycle. */
export function closesCycle(edges: ReadonlyMap<string, readonly string[]>, dependent: string, prerequisite: string): boolean {
  // A cycle appears if `prerequisite` already (transitively) depends on `dependent`.
  const seen = new Set<string>();
  const stack = [prerequisite];
  while (stack.length > 0) {
    const n = stack.pop() ?? '';
    if (n === dependent) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const d of edges.get(n) ?? []) stack.push(d);
  }
  return false;
}

const C25: CapabilityDefinition = {
  id: 'C25',
  title: 'DAG dependency suggestions',
  primitive: 'Choice',
  async handle(cx, input) {
    const tasks = tasksFor(cx, input);
    if (tasks.length < 2) return abstainAdvice(C25, 'TOO_FEW_TASKS', 'At least two planned tasks are needed for a dependency suggestion.');
    const edges = new Map<string, string[]>(tasks.map((t) => [t.node.id, [...t.node.dependencyIds]]));
    const candidates: { dependent: TaskRecord; prerequisite: TaskRecord; reason: string; score: number }[] = [];
    for (const a of tasks) {
      for (const b of tasks) {
        if (a === b || a.node.dependencyIds.includes(b.node.id) || b.node.dependencyIds.includes(a.node.id)) continue;
        // b produces something a mentions, or both write the same scope (an order is needed).
        const produces = b.expectedOutputs.filter((o) => words(`${a.title} ${a.node.requirementIds.join(' ')}`).some((w) => words(o).includes(w)) || a.node.writeScopes.includes(o));
        const overlap = scopesOverlap(a.node.writeScopes, b.node.writeScopes);
        if (produces.length === 0 && !overlap) continue;
        if (a.node.id < b.node.id && overlap && produces.length === 0 && candidates.some((c) => c.dependent === b && c.prerequisite === a)) continue;
        candidates.push({ dependent: a, prerequisite: b, reason: produces.length > 0 ? `needs ${produces.slice(0, 3).join(', ')} from ${b.node.id}` : `both write ${a.node.writeScopes.find((s) => scopesOverlap([s], b.node.writeScopes)) ?? 'a shared scope'}`, score: produces.length > 0 ? 0.8 : 0.5 });
      }
    }
    const ranked: RankedItem[] = [];
    const refused: string[] = [];
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: 'INTERFACE_OVERLAP', decisionId: null };
    for (const c of candidates.sort((x, y) => y.score - x.score || (x.dependent.node.id < y.dependent.node.id ? -1 : 1)).slice(0, 12)) {
      const id = `${c.dependent.node.id}<-${c.prerequisite.node.id}`;
      if (closesCycle(edges, c.dependent.node.id, c.prerequisite.node.id)) {
        refused.push(`${id}: would close a cycle`);
        continue;
      }
      const got = await consultChoice(cx.engine, {
        capabilityId: 'C25',
        specVersion: '1',
        objective: 'Suggest whether one planned task should wait for another. A planner reviews every suggestion.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(id).slice(0, 32),
        evidence: [
          { id: 'dependent', text: `${c.dependent.node.id}: ${c.dependent.title}; writes ${c.dependent.node.writeScopes.join(', ')}`, sourceKind: 'policy', priority: 'high' },
          { id: 'prerequisite', text: `${c.prerequisite.node.id}: ${c.prerequisite.title}; outputs ${c.prerequisite.expectedOutputs.join(', ')}`, sourceKind: 'policy', priority: 'high' },
        ],
        instructions: `Should ${c.dependent.node.id} wait for ${c.prerequisite.node.id}?`,
        options: { depends: 'It needs the other task’s result first.', independent: 'They can run in either order.', unsure: 'The evidence does not show.' },
        rules: () => ({ choice: c.score >= 0.8 ? 'depends' : 'unsure', reasonCode: 'INTERFACE_OVERLAP' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      if (got.source === 'jev') consult = got;
      if (got.value === 'independent') continue;
      edges.set(c.dependent.node.id, [...(edges.get(c.dependent.node.id) ?? []), c.prerequisite.node.id]);
      ranked.push({ id, label: `${c.dependent.node.id} depends on ${c.prerequisite.node.id}`, score: got.value === 'depends' ? c.score : c.score / 2, reason: `${c.reason}${got.value === 'unsure' ? ' (ambiguous: planner decides)' : ''}` });
    }
    ranked.sort(byScore);
    return advice(
      C25,
      {
        verb: ranked.length > 0 ? 'ask' : 'report',
        summary: ranked.length > 0 ? `${String(ranked.length)} dependency suggestions for the planner to review; nothing was changed or scheduled.` : 'No dependency to suggest.',
        ranked,
        question: ranked[0] === undefined ? null : `Should ${ranked[0].label}?`,
        requiresApproval: ranked.length > 0,
        notes: refused.length > 0 ? [`Refused (cycles): ${refused.slice(0, 8).join('; ')}`] : [],
      },
      consult,
    );
  },
};

// ------------------------------------------------------------------ C26 roles

export const ROLES = ['explorer', 'implementer', 'verifier', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

const PHASE_TOOLS: { readonly [R in Role]: readonly string[] } = {
  explorer: ['Read', 'Grep', 'Glob'],
  implementer: ['Read', 'Edit', 'Write'],
  verifier: ['Read', 'Bash'],
  reviewer: ['Read', 'Grep'],
};

export interface InstalledAgent {
  readonly name: string;
  readonly description: string;
  /** Null: the agent inherits every tool (least privilege last). */
  readonly tools: readonly string[] | null;
  readonly path: string;
}

function parseTools(frontmatter: string): readonly string[] | null {
  const inline = /^tools:\s*(.+)$/m.exec(frontmatter);
  if (inline !== null && (inline[1] ?? '').trim() !== '') {
    const v = (inline[1] ?? '').trim().replace(/^\[|\]$/g, '');
    return v.split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter((t) => /^[A-Za-z][A-Za-z0-9_:*().-]{0,63}$/.test(t)).slice(0, 64);
  }
  const block = /^tools:\s*\r?\n((?:\s+-\s*.+\r?\n?)+)/m.exec(frontmatter);
  if (block !== null) return (block[1] ?? '').split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter((t) => /^[A-Za-z][A-Za-z0-9_:*().-]{0,63}$/.test(t)).slice(0, 64);
  return null;
}

/** Installed agent definitions (Claude and OpenCode formats), metadata only. */
export function installedAgents(home: string, workspaceRoot: string, env: CapabilityContext['env'], platform: string = process.platform): readonly InstalledAgent[] {
  const xdg = env['XDG_CONFIG_HOME'];
  const config = typeof xdg === 'string' && isAbsolute(xdg) ? xdg : join(home, '.config');
  const dirs = [join(workspaceRoot, '.claude', 'agents'), join(home, '.claude', 'agents'), join(workspaceRoot, '.opencode', 'agent'), join(config, 'opencode', 'agent')];
  const out: InstalledAgent[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort().slice(0, 128);
    } catch {
      continue;
    }
    for (const n of names) {
      const read = readBounded(dir, n, 16 * 1024);
      if (read === null) continue;
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read.text)?.[1] ?? '';
      const meta = parseSkillMeta(read.text);
      const name = meta.name !== null && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(meta.name) ? meta.name : n.replace(/\.md$/, '');
      const key = pathKey(name, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, description: (meta.description ?? '').slice(0, 300), tools: parseTools(fm), path: join(dir, n) });
    }
  }
  return out;
}

function roleOf(agent: InstalledAgent): Role | null {
  const w = new Set(words(`${agent.name} ${agent.description}`));
  if (w.has('review') || w.has('reviewer')) return 'reviewer';
  if (w.has('verify') || w.has('verifier') || w.has('test') || w.has('tester') || w.has('qa')) return 'verifier';
  if (w.has('explore') || w.has('explorer') || w.has('research') || w.has('investigator') || w.has('locator')) return 'explorer';
  if (w.has('implement') || w.has('implementer') || w.has('builder') || w.has('executor') || w.has('developer')) return 'implementer';
  return null;
}

const C26: CapabilityDefinition = {
  id: 'C26',
  title: 'Worker-role allocation',
  primitive: 'Choice',
  async handle(cx, input) {
    const phase = strOf(input, 'phase', 32) as Role;
    if (!(ROLES as readonly string[]).includes(phase)) return abstainAdvice(C26, 'PHASE_REQUIRED', `Name the phase: ${ROLES.join(', ')}.`);
    const required = [...new Set([...PHASE_TOOLS[phase], ...strsOf(input, 'requiredTools', 32, 64)])];
    const agents = installedAgents(cx.home, cx.ws.workspaceRoot, cx.env, cx.platform);
    // Eligible: the agent's allowlist covers every required tool (an agent without a list has all).
    const eligible = agents.filter((a) => a.tools === null || required.every((t) => a.tools?.includes(t) === true));
    const ranked: RankedItem[] = eligible
      .map((a) => ({ id: a.name, label: `${a.name}: ${a.description}`, score: (roleOf(a) === phase ? 0.5 : 0) + (a.tools === null ? 0 : 0.5 / Math.max(1, a.tools.length - required.length + 1)), reason: a.tools === null ? 'inherits every tool (least privilege last)' : `${String(a.tools.length)} tools: ${a.tools.join(', ')}` }))
      .sort(byScore);
    if (ranked.length === 0) return advice(C26, { verb: 'pause', summary: `No installed agent's tool allowlist covers the ${phase} phase (${required.join(', ')}). No permission was added.`, recommendation: 'none', reasonCode: 'NO_ELIGIBLE_AGENT' });
    const options: { [key: string]: string } = {};
    for (const r of ranked.slice(0, 8)) options[r.id] = `${r.label} (${r.reason})`.slice(0, 300);
    const top = ranked[0];
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C26',
      specVersion: '1',
      objective: `Choose the least-privileged installed agent for the ${phase} phase.`,
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(ranked.map((r) => r.id).join(',')).slice(0, 32),
      evidence: [{ id: 'task', text: strOf(input, 'intent', 1000) || phase, sourceKind: 'user', priority: 'high' }],
      facts: { phase, requiredTools: required.join(',') },
      instructions: `Which listed agent should take the ${phase} phase? Prefer the one with the fewest tools that still covers it.`,
      options,
      rules: () => ({ choice: top?.id ?? '', reasonCode: 'LEAST_PRIVILEGE' }),
      ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
    });
    return advice(
      C26,
      {
        verb: 'rank',
        summary: `Suggested ${phase}: ${got.value}. Its tool allowlist is used as installed; nothing was added.`,
        recommendation: got.value,
        ranked,
        kept: required,
        notes: [`${String(agents.length - eligible.length)} installed agents lack a required tool and were not considered.`],
      },
      got,
    );
  },
};

// ------------------------------------------------------------------ C28 duplicates

const ACTIVE = ['leased', 'running', 'awaiting-evidence'] as const;
const PROGRESS: { readonly [s: string]: number } = { 'awaiting-evidence': 3, running: 2, leased: 1 };

async function touched(cx: CapabilityContext, task: TaskRecord): Promise<readonly string[]> {
  const run = workerRuns(cx.ws, task.node.id).at(-1);
  const session = ownedSessions(cx.ws).find((s) => s.taskId === task.node.id);
  const wtId = session?.worktreeId ?? run?.worktreeId ?? null;
  const wt = wtId === null ? undefined : getWorktree(cx.ws, wtId);
  const files = wt === undefined ? null : await changedFiles(cx.git, wt.path, wt.baseCommit, 500);
  return [...(files ?? run?.changedPaths ?? []), ...task.node.writeScopes];
}

export interface DuplicateGroup {
  readonly survivor: string;
  readonly duplicates: readonly string[];
  readonly overlap: number;
}

const C28: CapabilityDefinition = {
  id: 'C28',
  title: 'Duplicate-work detection',
  primitive: 'Noul',
  async handle(cx) {
    const active = listTasks(cx.ws, { states: [...ACTIVE] });
    if (active.length < 2) return advice(C28, { verb: 'report', summary: 'Fewer than two active tasks: nothing can duplicate.', reasonCode: 'NO_OVERLAP' });
    const owned = new Set(ownedSessions(cx.ws).map((s) => s.taskId));
    const paths = new Map(await Promise.all(active.map(async (t) => [t.node.id, await touched(cx, t)] as const)));
    const parent = new Map(active.map((t) => [t.node.id, t.node.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) ?? r;
      return r;
    };
    const pairs: RankedItem[] = [];
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: 'PATH_OVERLAP', decisionId: null };
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i];
        const b = active[j];
        if (a === undefined || b === undefined) continue;
        const pa = paths.get(a.node.id) ?? [];
        const pb = paths.get(b.node.id) ?? [];
        const pathScore = jaccard(pa, pb);
        const moduleScore = jaccard(pa.map(moduleOf), pb.map(moduleOf));
        const objScore = jaccard(words(a.title), words(b.title));
        const score = pathScore * 0.4 + moduleScore * 0.3 + objScore * 0.3;
        if (score < 0.3) continue;
        let same = score >= 0.5;
        if (score < 0.7 && cx.engine !== undefined) {
          const got = await consultNoul(cx.engine, {
            capabilityId: 'C28',
            specVersion: '1',
            objective: 'Decide whether two active tasks are doing the same work.',
            workspaceId: cx.ws.workspaceId,
            evidenceRevision: sha256(`${a.node.id}:${b.node.id}`).slice(0, 32),
            evidence: [
              { id: 'a', text: `${a.node.id}: ${a.title}; touches ${(paths.get(a.node.id) ?? []).slice(0, 20).join(', ')}`, sourceKind: 'tool', priority: 'high' },
              { id: 'b', text: `${b.node.id}: ${b.title}; touches ${(paths.get(b.node.id) ?? []).slice(0, 20).join(', ')}`, sourceKind: 'tool', priority: 'high' },
            ],
            facts: { pathOverlap: Math.round(pathScore * 100), objectiveOverlap: Math.round(objScore * 100) },
            instructions: 'Are these two tasks duplicating the same work?',
            whenTrue: 'They do the same work; one result is enough.',
            whenFalse: 'They are different pieces of work.',
            rules: () => ({ value: score >= 0.5, reasonCode: 'PATH_OVERLAP' }),
            ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
          });
          if (got.source === 'jev') consult = got;
          same = got.value;
        }
        if (!same) continue;
        parent.set(find(b.node.id), find(a.node.id));
        pairs.push({ id: `${a.node.id}~${b.node.id}`, label: `${a.node.id} and ${b.node.id}`, score, reason: `path overlap ${String(Math.round(pathScore * 100))}%, objective overlap ${String(Math.round(objScore * 100))}%` });
      }
    }
    const groups = new Map<string, TaskRecord[]>();
    for (const t of active) {
      if (!pairs.some((p) => p.id.split('~').includes(t.node.id))) continue;
      const g = groups.get(find(t.node.id)) ?? [];
      g.push(t);
      groups.set(find(t.node.id), g);
    }
    const result: DuplicateGroup[] = [];
    for (const g of groups.values()) {
      // Survivor: the most progressed, then the oldest; only owned tasks are ever cancelled.
      const sorted = [...g].sort((x, y) => (PROGRESS[y.node.state] ?? 0) - (PROGRESS[x.node.state] ?? 0) || x.createdAtMs - y.createdAtMs);
      const survivor = sorted[0];
      if (survivor === undefined) continue;
      result.push({ survivor: survivor.node.id, duplicates: sorted.slice(1).map((t) => t.node.id), overlap: Math.max(...pairs.filter((p) => p.id.includes(survivor.node.id)).map((p) => p.score ?? 0), 0) });
    }
    const cancel = result.flatMap((g) => g.duplicates.filter((d) => owned.has(d)));
    const merge = result.flatMap((g) => g.duplicates.filter((d) => !owned.has(d)));
    return advice(
      C28,
      {
        verb: result.length > 0 ? 'ask' : 'report',
        summary: result.length === 0 ? 'No duplicated work found.' : `${String(result.length)} duplicate groups. Keep ${result.map((g) => g.survivor).join(', ')}; ${cancel.length > 0 ? `cancel ${cancel.join(', ')} after your approval` : 'nothing is owned to cancel'}${merge.length > 0 ? `; merge ${merge.join(', ')} by hand (not owned)` : ''}.`,
        recommendation: result.length === 0 ? 'none' : cancel.length > 0 ? 'cancel' : 'merge',
        ranked: pairs.sort(byScore),
        kept: result.map((g) => g.survivor),
        question: cancel.length > 0 ? `Cancel ${cancel.join(', ')}? Their worktrees and artifacts are kept.` : null,
        requiresApproval: cancel.length > 0,
        notes: ['Cancellation applies only to owned tasks, only after approval, and keeps every worktree.'],
      },
      consult,
    );
  },
};

/** A user reverted a duplicate cancellation: record it as a false cancellation (C28 feedback). */
export async function recordDuplicateRevert(ws: CapabilityContext['ws'], input: { readonly taskId: string; readonly actor: string; readonly nowMs?: number }): Promise<{ readonly ok: boolean; readonly reasonCode: string }> {
  const task = getTask(ws, input.taskId);
  if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
  if (task.node.state !== 'cancelled') return { ok: false, reasonCode: 'NOT_CANCELLED' };
  await ws.state.transact((tx) => tx.put('duplicate-feedback', recordKey(ws.workspaceId, input.taskId), { workspaceId: ws.workspaceId, taskId: input.taskId, falseCancellation: true, actor: input.actor.slice(0, 64), atMs: input.nowMs ?? Date.now() }));
  return { ok: true, reasonCode: 'FALSE_CANCELLATION_RECORDED' };
}

// ------------------------------------------------------------------ C30 handoff

const C30: CapabilityDefinition = {
  id: 'C30',
  title: 'Worker handoff readiness',
  primitive: 'Noul',
  async handle(cx, input) {
    const taskId = cx.taskId ?? strOf(input, 'taskId', 130);
    const task = taskId === '' ? undefined : getTask(cx.ws, taskId);
    if (task === undefined) return abstainAdvice(C30, 'UNKNOWN_TASK', 'Name a planned task to hand off.');
    const sourceRefs = strsOf(input, 'sourceRefs', 64, 300);
    const missing: string[] = [];
    if (task.node.requirementIds.length === 0) missing.push('requirement ids');
    if (task.node.acceptanceCheckIds.length === 0) missing.push('acceptance checks');
    if (task.expectedOutputs.length === 0) missing.push('expected outputs');
    if (task.node.writeScopes.length === 0) missing.push('write scopes');
    if (sourceRefs.length === 0) missing.push('source references (files or symbols the worker must read)');
    const run = workerRuns(cx.ws, task.node.id).at(-1);
    if (run !== undefined && run.changedPaths.length > 0 && strOf(input, 'diffHandle', 140) === '') missing.push('the latest diff (a prior worker changed files)');
    let consult: { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null } = { source: 'rules', reasonCode: missing.length > 0 ? 'CONTRACT_INCOMPLETE' : 'CONTRACT_COMPLETE', decisionId: null };
    if (missing.length === 0 && cx.engine !== undefined) {
      const got = await consultNoul(cx.engine, {
        capabilityId: 'C30',
        specVersion: '1',
        objective: 'Check whether a worker handoff still lacks context. Acceptance checks decide completion regardless.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(`${task.node.id}:${sourceRefs.join(',')}`).slice(0, 32),
        evidence: [{ id: 'contract', text: `${task.title}; requirements ${task.node.requirementIds.join(', ')}; outputs ${task.expectedOutputs.join(', ')}; scope ${task.node.writeScopes.join(', ')}; sources ${sourceRefs.join(', ')}`, sourceKind: 'policy', priority: 'mandatory' }],
        instructions: 'Is essential context still missing from this handoff?',
        whenTrue: 'A worker would have to guess something important.',
        whenFalse: 'The handoff has what a worker needs.',
        rules: () => ({ value: false, reasonCode: 'CONTRACT_COMPLETE' }),
        ...(cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs }),
      });
      consult = got;
      if (got.value) missing.push('context Jev flagged as missing (review the task description)');
    }
    return advice(
      C30,
      {
        verb: missing.length > 0 ? 'ask' : 'report',
        summary: missing.length > 0 ? `Not ready to hand off ${task.node.id}: add ${missing.join('; ')}.` : `${task.node.id} has a complete handoff contract. Its acceptance checks still decide completion.`,
        recommendation: missing.length > 0 ? 'require-context' : 'ready',
        ranked: missing.map((m, i) => ({ id: `missing-${String(i + 1)}`, label: m, score: null, reason: 'required before handoff' })),
        question: missing[0] === undefined ? null : `Please provide ${missing[0]} for ${task.node.id}.`,
        kept: task.node.acceptanceCheckIds,
        validation: task.node.acceptanceCheckIds,
      },
      consult,
    );
  },
};

export const ORCHESTRATION_CAPABILITIES: readonly CapabilityDefinition[] = [C25, C26, C28, C30];
