/**
 * Capsule v2, assembly and packing (MEM-01, MEM-02, MEM-03, MEM-04, MEM-05; SSOT §9.1-§9.3,
 * C17, C18).
 *
 * A capsule is assembled from Jevris state, extractively: the task ledger (graph snapshot and
 * running work), declared constraints and objective, `git status -z` with content hashes,
 * approved checks without a current passing receipt (open checks), the loop ledger's rejected
 * approaches, accepted decisions, approvals with scope, and source handles. Each item carries
 * an epistemic class (fact, hypothesis, preference); nothing turns a hypothesis into a fact.
 *
 * Packing puts mandatory items first. When mandatory items alone exceed the budget, the full
 * list is written as an immutable reference index in the evidence store and the capsule keeps
 * the handle: nothing is silently dropped. Optional items are ranked (C18: Jev Score when the
 * engine is present and source egress is approved, rules otherwise; skipped on short deadlines)
 * and fitted into what remains, with a truncation flag.
 */
import type { MemoryCapsule } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { approvedManifests } from '../verify/service.js';
import { refreshFreshness } from '../verify/completion.js';
import { receiptScopeOf } from '../verify/receipt-scope.js';
import { nodeGit, snapshotRevision, type GitPort } from '../verify/revision.js';
import { listTasks } from '../orchestration/tasks.js';
import { rejectedApproaches } from '../orchestration/loops.js';
import { consultScore } from '../capabilities/consult.js';
import { estimateTokens, hashOf, recordKey, safeText, sha256 } from '../util.js';
import { randomBytes } from 'node:crypto';

export const CAPSULE_SCHEMA = 'jevris-capsule-2';

export type ItemKind =
  | 'objective'
  | 'constraint'
  | 'decision'
  | 'changed-file'
  | 'open-check'
  | 'unresolved'
  | 'rejected-approach'
  | 'hypothesis'
  | 'next-action'
  | 'approval'
  | 'running-work'
  | 'source-handle';

export type Epistemic = 'fact' | 'hypothesis' | 'preference';

export interface CapsuleItem {
  readonly id: string;
  readonly kind: ItemKind;
  readonly text: string;
  readonly epistemic: Epistemic;
  readonly mandatory: boolean;
  /** Evidence handles, receipt ids or signal ids the item rests on. */
  readonly refs: readonly string[];
  readonly source: 'user' | 'jevris-state' | 'git' | 'receipt' | 'loop-ledger' | 'import';
  /** Hash of the normalised text, for the omission audit. */
  readonly textHash: string;
}

export interface ApprovalEntry {
  readonly id: string;
  readonly scope: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly status: 'active' | 'historical';
}

export interface CapsuleV2 {
  readonly schemaVersion: typeof CAPSULE_SCHEMA;
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly objective: string;
  readonly revision: { readonly head: string; readonly branch: string | null; readonly revision: string; readonly lockfileHash: string };
  readonly environmentHash: string;
  readonly policyVersion: string;
  readonly items: readonly CapsuleItem[];
  readonly taskGraph: readonly { readonly id: string; readonly state: string; readonly dependencyIds: readonly string[] }[];
  readonly approvals: readonly ApprovalEntry[];
  /** When mandatory material exceeded the budget: the handle of the full immutable index. */
  readonly referenceIndex: { readonly handle: string; readonly itemCount: number } | null;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly truncated: boolean;
  readonly droppedOptional: number;
  readonly ranking: 'jev' | 'rules' | 'none';
  readonly createdAt: string;
  readonly supersedes: string | null;
  readonly contentHash: string;
}

export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function item(kind: ItemKind, id: string, text: string, opts: Partial<Pick<CapsuleItem, 'epistemic' | 'mandatory' | 'refs' | 'source'>> = {}): CapsuleItem {
  const clean = safeText(text, 1000);
  return {
    id,
    kind,
    text: clean,
    epistemic: opts.epistemic ?? 'fact',
    mandatory: opts.mandatory ?? false,
    refs: [...(opts.refs ?? [])].slice(0, 16),
    source: opts.source ?? 'jevris-state',
    textHash: sha256(normaliseText(clean)).slice(0, 32),
  };
}

// ------------------------------------------------------------------------ declared state

export interface DeclaredState {
  readonly objective: string | null;
  readonly constraints: readonly { readonly id: string; readonly text: string }[];
  readonly decisions: readonly { readonly id: string; readonly text: string; readonly rationaleRefs: readonly string[] }[];
  readonly hypotheses: readonly { readonly id: string; readonly text: string; readonly refs: readonly string[] }[];
  readonly preferences: readonly { readonly id: string; readonly text: string }[];
  readonly approvals: readonly ApprovalEntry[];
}

const EMPTY: DeclaredState = { objective: null, constraints: [], decisions: [], hypotheses: [], preferences: [], approvals: [] };

export function declaredState(ws: WorkspaceServices, taskId: string | null): DeclaredState {
  return ws.state.get<DeclaredState>('declared', recordKey(ws.workspaceId, taskId ?? '-')) ?? EMPTY;
}

/** Records the user's objective and exact constraints (the checkpoint op, CLI or hook). */
export async function declare(
  ws: WorkspaceServices,
  taskId: string | null,
  patch: {
    readonly objective?: string | null;
    readonly constraints?: readonly string[];
    readonly decisions?: readonly { readonly text: string; readonly rationaleRefs?: readonly string[] }[];
    readonly hypotheses?: readonly { readonly text: string; readonly refs?: readonly string[] }[];
    readonly preferences?: readonly string[];
    readonly approvals?: readonly Omit<ApprovalEntry, 'status'>[];
  },
): Promise<DeclaredState> {
  const key = recordKey(ws.workspaceId, taskId ?? '-');
  return ws.state.transact((tx) => {
    const prior = tx.get<DeclaredState>('declared', key) ?? EMPTY;
    const addUnique = <T extends { readonly id: string }>(list: readonly T[], extra: readonly T[]) => {
      const seen = new Set(list.map((x) => x.id));
      return [...list, ...extra.filter((x) => !seen.has(x.id))].slice(-256);
    };
    const idFor = (prefix: string, text: string) => `${prefix}-${sha256(normaliseText(text)).slice(0, 12)}`;
    const next: DeclaredState = {
      objective: patch.objective === undefined ? prior.objective : patch.objective === null ? null : patch.objective.slice(0, 4000),
      constraints: addUnique(prior.constraints, (patch.constraints ?? []).filter((c) => c.trim().length > 0).map((c) => ({ id: idFor('K', c), text: c.slice(0, 1000) }))),
      decisions: addUnique(prior.decisions, (patch.decisions ?? []).map((d) => ({ id: idFor('D', d.text), text: d.text.slice(0, 1000), rationaleRefs: [...(d.rationaleRefs ?? [])] }))),
      hypotheses: addUnique(prior.hypotheses, (patch.hypotheses ?? []).map((h) => ({ id: idFor('H', h.text), text: h.text.slice(0, 1000), refs: [...(h.refs ?? [])] }))),
      preferences: addUnique(prior.preferences, (patch.preferences ?? []).map((p) => ({ id: idFor('P', p), text: p.slice(0, 1000) }))),
      approvals: addUnique(prior.approvals, (patch.approvals ?? []).map((a) => ({ ...a, status: 'active' as const }))),
    };
    tx.put('declared', key, next);
    return next;
  });
}

// ------------------------------------------------------------------------------ assembly

export interface AssembleInput {
  readonly taskId: string | null;
  readonly budgetTokens?: number;
  readonly git?: GitPort;
  readonly engine?: unknown;
  /** Jev ranking of optional items only with approved source egress (§9.1, C18). */
  readonly egressApproved?: boolean;
  readonly remainingMs?: number;
  readonly policyVersion?: string;
  readonly nowMs?: number;
}

export interface AssembleResult {
  readonly capsule: CapsuleV2;
  readonly mandatory: readonly CapsuleItem[];
  readonly optionalRanked: readonly CapsuleItem[];
  /** The first Jev decision that ranked an optional item (null when rules ranked them). */
  readonly decisionId: string | null;
}

/** Every candidate item from Jevris state, before packing. */
export async function gatherItems(ws: WorkspaceServices, taskId: string | null, git: GitPort, nowMs: number): Promise<{ readonly items: CapsuleItem[]; readonly declared: DeclaredState; readonly snapshot: Awaited<ReturnType<typeof snapshotRevision>> }> {
  const declared = declaredState(ws, taskId);
  const global = taskId === null ? EMPTY : declaredState(ws, null);
  const items: CapsuleItem[] = [];
  const objective = declared.objective ?? global.objective;
  if (objective !== null) items.push(item('objective', 'objective', objective, { mandatory: true, source: 'user' }));
  for (const c of [...global.constraints, ...declared.constraints]) items.push(item('constraint', c.id, c.text, { mandatory: true, source: 'user' }));
  for (const d of [...global.decisions, ...declared.decisions]) items.push(item('decision', d.id, d.text, { refs: d.rationaleRefs, source: 'user' }));
  for (const h of [...global.hypotheses, ...declared.hypotheses]) items.push(item('hypothesis', h.id, h.text, { epistemic: 'hypothesis', refs: h.refs }));
  for (const p of [...global.preferences, ...declared.preferences]) items.push(item('decision', p.id, `Preference: ${p.text}`, { epistemic: 'preference', source: 'user' }));
  // Approvals: expired ones are history, never active permissions.
  for (const a of [...global.approvals, ...declared.approvals]) {
    const expired = a.expiresAt !== null && Date.parse(a.expiresAt) <= nowMs;
    items.push(item('approval', a.id, `${expired ? 'Expired approval (history only)' : 'Approval'}: ${a.scope}${a.expiresAt === null ? '' : ` until ${a.expiresAt}`}`, { mandatory: !expired, source: 'user' }));
  }
  // Task graph: running work and unresolved failures are mandatory.
  const tasks = listTasks(ws);
  for (const t of tasks) {
    if (['leased', 'running', 'awaiting-evidence', 'verifying'].includes(t.node.state)) {
      items.push(item('running-work', `task-${t.node.id}`, `Task ${t.node.id} (${t.title}) is ${t.node.state}.`, { mandatory: true }));
    }
    if (t.node.state === 'failed' || t.node.state === 'blocked') {
      items.push(item('unresolved', `task-${t.node.id}`, `Task ${t.node.id} is ${t.node.state}: ${t.stateReason ?? 'no reason recorded'}.`, { mandatory: true }));
    }
  }
  // Stale receipts are invalidated against the current revision before open checks are read, or a
  // receipt for an edited file would still count as passing. Its snapshot is the one used below
  // (one git status on this path, as in rehydrate).
  const { snapshot } = await refreshFreshness({ workspaceRoot: ws.workspaceRoot, workspaceId: ws.workspaceId, receipts: ws.receipts, state: ws.state, git, scope: receiptScopeOf(ws) });
  // Changed files with hashes, from git.
  for (const f of snapshot.dirty.slice(0, 200)) items.push(item('changed-file', `file-${sha256(f.path).slice(0, 12)}`, `${f.path} (${f.status.trim() || 'changed'}) sha256:${f.hash.slice(0, 16)}`, { source: 'git', refs: [f.hash] }));
  // Open checks: approved checks with no current passing receipt.
  const latest = ws.receipts.latest(ws.workspaceId, taskId);
  for (const m of approvedManifests(ws)) {
    const row = latest.get(m.id);
    const passing = row !== undefined && row.validity === 'current' && row.receipt.outcome === 'passed';
    if (!passing && m.mandatory) {
      const why = row === undefined ? 'no receipt' : row.validity !== 'current' ? 'stale receipt' : `last outcome ${row.receipt.outcome}`;
      items.push(item('open-check', `check-${m.id}`, `Check ${m.id} is open (${why}).`, { mandatory: true, source: 'receipt', refs: row === undefined ? [] : [row.receipt.id] }));
      if (row !== undefined && row.receipt.outcome === 'failed') {
        items.push(item('unresolved', `fail-${m.id}`, `Check ${m.id} failed: ${row.receipt.outcomeReason}.`, { mandatory: true, source: 'receipt', refs: [row.receipt.id, ...(row.receipt.rawOutputHandle === null ? [] : [row.receipt.rawOutputHandle])] }));
      }
    }
    if (row?.receipt.rawOutputHandle !== null && row?.receipt.rawOutputHandle !== undefined) {
      items.push(item('source-handle', `h-${m.id}`, `Raw output of ${m.id}: ${row.receipt.rawOutputHandle}`, { source: 'receipt', refs: [row.receipt.rawOutputHandle] }));
    }
  }
  for (const r of rejectedApproaches(ws, taskId)) items.push(item('rejected-approach', `rej-${r.fingerprint}`, r.text, { mandatory: true, source: 'loop-ledger', refs: r.evidence }));
  // Next safe actions, derived deterministically.
  const open = items.filter((i) => i.kind === 'open-check').map((i) => i.id.slice(6));
  if (open.length > 0) items.push(item('next-action', 'next-checks', `Run the open checks: ${open.slice(0, 10).join(', ')} (jevris verify).`));
  const blocked = tasks.filter((t) => t.node.state === 'blocked').map((t) => t.node.id);
  if (blocked.length > 0) items.push(item('next-action', 'next-reconcile', `Reconcile blocked tasks before rescheduling: ${blocked.slice(0, 10).join(', ')}.`));
  return { items, declared, snapshot };
}

const DEFAULT_BUDGET = 3_000;

async function rankOptional(ws: WorkspaceServices, optional: readonly CapsuleItem[], input: AssembleInput): Promise<{ readonly ranked: readonly CapsuleItem[]; readonly by: 'jev' | 'rules'; readonly decisionId: string | null }> {
  const rulesOrder = (list: readonly CapsuleItem[]) => {
    const weight: { readonly [K in ItemKind]?: number } = { decision: 5, 'next-action': 4, hypothesis: 3, 'changed-file': 2, 'source-handle': 1 };
    return [...list].sort((a, b) => (weight[b.kind] ?? 0) - (weight[a.kind] ?? 0) || (a.id < b.id ? -1 : 1));
  };
  // Jev only with approved egress and time to spare; at most 12 scored items per capsule.
  if (input.engine === undefined || input.egressApproved !== true || (input.remainingMs !== undefined && input.remainingMs < 1_500)) {
    return { ranked: rulesOrder(optional), by: 'rules', decisionId: null };
  }
  const scored = new Map<string, number>();
  let usedJev = false;
  let decisionId: string | null = null;
  for (const it of rulesOrder(optional).slice(0, 12)) {
    const r = await consultScore(input.engine, {
      capabilityId: 'C18',
      specVersion: '1',
      objective: 'Rank how useful an optional memory item is for continuing the task.',
      instructions: 'Rate how useful this item is for continuing the current task after context compaction.',
      anchors: ['Irrelevant to the task', 'Marginally useful', 'Useful background', 'Needed to continue correctly'],
      evidence: [{ id: it.id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'item', text: it.text, sourceKind: 'file', priority: 'optional' }],
      workspaceId: ws.workspaceId,
      evidenceRevision: 'capsule',
      taskId: input.taskId,
      rules: () => ({ score: it.kind === 'decision' ? 3 : 1, reasonCode: 'RULES' }),
    });
    if (r.source === 'jev') {
      usedJev = true;
      decisionId ??= r.decisionId ?? null;
    }
    scored.set(it.id, r.value);
  }
  const ranked = rulesOrder(optional).sort((a, b) => (scored.get(b.id) ?? -1) - (scored.get(a.id) ?? -1));
  return { ranked, by: usedJev ? 'jev' : 'rules', decisionId };
}

export async function assembleCapsule(ws: WorkspaceServices, input: AssembleInput): Promise<AssembleResult> {
  const nowMs = input.nowMs ?? Date.now();
  const git = input.git ?? nodeGit();
  const budget = Math.max(200, Math.min(input.budgetTokens ?? DEFAULT_BUDGET, 200_000));
  const { items, declared, snapshot } = await gatherItems(ws, input.taskId, git, nowMs);
  const mandatory = items.filter((i) => i.mandatory);
  const optional = items.filter((i) => !i.mandatory);
  const cost = (list: readonly CapsuleItem[]) => list.reduce((n, i) => n + estimateTokens(i.text) + 8, 0);
  let kept: CapsuleItem[] = [];
  let referenceIndex: CapsuleV2['referenceIndex'] = null;
  let truncated = false;
  const mandatoryCost = cost(mandatory);
  if (mandatoryCost > budget) {
    // Keep what fits in order, and write the complete mandatory list behind one handle.
    const meta = await ws.evidence.put({
      workspaceId: ws.workspaceId,
      kind: 'capsule-reference-index',
      bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 'jevris-capsule-index-1', items: mandatory }, null, 2)),
      retention: 'pinned',
      nowMs,
    });
    referenceIndex = { handle: meta.handle, itemCount: mandatory.length };
    let used = estimateTokens(meta.handle) + 16;
    for (const m of mandatory) {
      const c = estimateTokens(m.text) + 8;
      if (used + c > budget) {
        truncated = true;
        continue;
      }
      kept.push(m);
      used += c;
    }
    kept.push(item('source-handle', 'reference-index', `Full mandatory list (${String(mandatory.length)} items) is at ${meta.handle}; retrieve it before acting.`, { mandatory: true, refs: [meta.handle] }));
  } else {
    kept = [...mandatory];
  }
  const { ranked, by, decisionId } = await rankOptional(ws, optional, input);
  let used = cost(kept);
  let dropped = 0;
  for (const o of ranked) {
    const c = estimateTokens(o.text) + 8;
    if (used + c > budget || referenceIndex !== null) {
      dropped += 1;
      truncated = true;
      continue;
    }
    kept.push(o);
    used += c;
  }
  const tasks = listTasks(ws).map((t) => ({ id: t.node.id, state: t.node.state, dependencyIds: [...t.node.dependencyIds] }));
  const priorId = ws.state.get<string>('capsule-latest', recordKey(ws.workspaceId, input.taskId ?? '-')) ?? null;
  const body: Omit<CapsuleV2, 'contentHash'> = {
    schemaVersion: CAPSULE_SCHEMA,
    id: `cap-${randomBytes(8).toString('hex')}`,
    workspaceId: ws.workspaceId,
    taskId: input.taskId,
    objective: safeText(declared.objective ?? declaredState(ws, null).objective ?? 'No objective recorded.', 4000),
    revision: { head: snapshot.head, branch: snapshot.branch, revision: snapshot.revision, lockfileHash: snapshot.lockfileHash },
    environmentHash: sha256(`${process.platform}\n${process.arch}\n${process.version}`).slice(0, 32),
    policyVersion: input.policyVersion ?? 'default',
    items: kept,
    taskGraph: tasks.slice(0, 256),
    approvals: [...declaredState(ws, null).approvals, ...(input.taskId === null ? [] : declared.approvals)].map((a) => ({
      ...a,
      status: a.expiresAt !== null && Date.parse(a.expiresAt) <= nowMs ? ('historical' as const) : a.status,
    })),
    referenceIndex,
    budgetTokens: budget,
    usedTokens: used,
    truncated,
    droppedOptional: dropped,
    ranking: optional.length === 0 ? ('none' as const) : by,
    createdAt: new Date(nowMs).toISOString(),
    supersedes: priorId,
  };
  const capsule: CapsuleV2 = { ...body, contentHash: `sha256:${hashOf(body)}` };
  return { capsule, mandatory, optionalRanked: ranked, decisionId };
}

/** Assembles and persists a capsule; the latest capsule per workspace and task is tracked. */
export async function writeCapsule(ws: WorkspaceServices, input: AssembleInput): Promise<CapsuleV2> {
  return (await writeCapsuleDecided(ws, input)).capsule;
}

/** Writes the capsule and names the Jev decision that ranked it (null when rules did). */
export async function writeCapsuleDecided(ws: WorkspaceServices, input: AssembleInput): Promise<{ readonly capsule: CapsuleV2; readonly decisionId: string | null }> {
  const { capsule: assembled, decisionId } = await assembleCapsule(ws, input);
  const latestKey = recordKey(ws.workspaceId, assembled.taskId ?? '-');
  let capsule = assembled;
  await ws.state.transact((tx) => {
    // The chain link is read inside the transaction (K2): two compactions assembled at once must
    // not both claim the same predecessor, so the later commit supersedes the earlier one.
    const latest = tx.get<string>('capsule-latest', latestKey) ?? null;
    if (latest !== assembled.supersedes) {
      const { contentHash: _stale, ...body } = assembled;
      const relinked = { ...body, supersedes: latest };
      capsule = { ...relinked, contentHash: `sha256:${hashOf(relinked)}` };
    }
    tx.put('capsules', capsule.id, capsule);
    tx.put('capsule-latest', latestKey, capsule.id);
  });
  return { capsule, decisionId };
}

export function getCapsule(ws: WorkspaceServices, id: string): CapsuleV2 | undefined {
  const c = ws.state.get<CapsuleV2>('capsules', id);
  return c !== undefined && c.workspaceId === ws.workspaceId ? c : undefined;
}

export function latestCapsule(ws: WorkspaceServices, taskId: string | null): CapsuleV2 | undefined {
  const id = ws.state.get<string>('capsule-latest', recordKey(ws.workspaceId, taskId ?? '-'));
  return id === undefined ? undefined : getCapsule(ws, id);
}

/** Upgrades a v1.0 contract capsule (MemoryCapsule) to v2 (MEM-01). */
export function upgradeV1(v1: MemoryCapsule, nowMs = Date.now()): CapsuleV2 {
  const items: CapsuleItem[] = [
    item('objective', 'objective', v1.objective, { mandatory: true, source: 'import' }),
    ...v1.pinnedEvidence.map((e) => item('source-handle', `ev-${e.id}`, `Pinned evidence ${e.id} (${e.sourceKind}, ${e.trust}) ${e.contentHash}`, { mandatory: true, refs: [e.id], source: 'import' })),
    ...v1.optionalEvidence.map((e) => item('source-handle', `ev-${e.id}`, `Evidence ${e.id} (${e.sourceKind}) ${e.contentHash}`, { refs: [e.id], source: 'import' })),
    ...v1.unresolvedItems.map((u, i) => item('unresolved', `u-${String(i)}`, u, { mandatory: true, source: 'import' })),
    ...v1.hypotheses.map((h, i) => item('hypothesis', `h-${String(i)}`, h, { epistemic: 'hypothesis', source: 'import' })),
  ];
  const body: Omit<CapsuleV2, 'contentHash'> = {
    schemaVersion: CAPSULE_SCHEMA,
    id: v1.id,
    workspaceId: v1.workspaceId,
    taskId: v1.taskIds[0] ?? null,
    objective: safeText(v1.objective, 4000),
    revision: { head: 'unknown', branch: null, revision: v1.revision, lockfileHash: 'unknown' },
    environmentHash: 'unknown',
    policyVersion: 'unknown',
    items,
    taskGraph: v1.taskIds.map((id) => ({ id, state: 'unknown', dependencyIds: [] })),
    approvals: v1.authorizationHistoryRefs.map((id) => ({ id, scope: 'imported approval reference', grantedAt: 'unknown', expiresAt: v1.validUntil, status: 'historical' as const })),
    referenceIndex: null,
    budgetTokens: 0,
    usedTokens: items.reduce((n, i) => n + estimateTokens(i.text), 0),
    truncated: false,
    droppedOptional: 0,
    ranking: 'none' as const,
    createdAt: new Date(nowMs).toISOString(),
    supersedes: null,
  };
  return { ...body, contentHash: `sha256:${hashOf(body)}` };
}
