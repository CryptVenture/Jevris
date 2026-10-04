/**
 * Rehydration (MEM-09; SSOT §9.5, C21, US17, US18, E15).
 *
 * A resumed or compacted session gets its capsule back from Jevris state, never from the
 * transcript. The capsule is resolved by workspace and task; its recorded HEAD, branch,
 * lockfile hash, environment fingerprint and policy version are compared with the current
 * ones, stale receipts are invalidated, and the result is a bounded `additionalContext` text
 * with an explicit boundary line. Expired approvals appear only as history. When several
 * capsules could apply (no task given), the rules pick the newest when it also holds the most
 * unfinished work; otherwise Jev (Choice, C21) picks one from content-free features of each.
 */
import type { WorkspaceServices } from '../workspace.js';
import { refreshFreshness } from '../verify/completion.js';
import { receiptScopeOf } from '../verify/receipt-scope.js';
import { nodeGit, type GitPort } from '../verify/revision.js';
import { consultChoice } from '../capabilities/consult.js';
import { recordKey, safeText, sha256 } from '../util.js';
import { getCapsule, latestCapsule, type CapsuleItem, type CapsuleV2 } from './capsule.js';

export interface Validity {
  readonly headMatches: boolean;
  readonly branchMatches: boolean;
  readonly lockfileMatches: boolean;
  readonly environmentMatches: boolean;
  readonly policyMatches: boolean;
}

export interface RehydrateInput {
  readonly taskId: string | null;
  readonly capsuleId?: string | null;
  readonly git?: GitPort;
  readonly policyVersion?: string;
  readonly engine?: unknown;
  readonly remainingMs?: number;
  readonly nowMs?: number;
  /** Bound for the context text, in characters. */
  readonly cap?: number;
  /**
   * What the compaction summary left out (C20): item ids of the capsule, listed first with the reason. `omitted` are exact
   * mandatory items the summary no longer names (rules); `flagged` are decisions Jev judged likely dropped (advice).
   */
  readonly emphasis?: { readonly omitted: readonly string[]; readonly flagged: readonly string[] };
  /**
   * With no task and no capsule id: the capsule the rules would restore (the session start's workspace capsule).
   * It stands first among the candidates, so the rules answer with it, and Jev is asked only when another
   * capsule holds more unfinished work.
   */
  readonly preferred?: CapsuleV2;
}

export interface Rehydration {
  readonly found: boolean;
  readonly capsuleId: string | null;
  /** Why this capsule: `CAPSULE_GIVEN`, `TASK_GIVEN`, `ONE_CAPSULE`, `RULES_NEWEST_SURE`, `JEV_CHOICE` or a rules fallback's code. */
  readonly pickReason?: string;
  /** The Jev decision that picked it (C21), for `jevris explain`; null when rules did. */
  readonly pickDecisionId?: string | null;
  readonly validity: Validity | null;
  readonly invalidatedReceipts: readonly string[];
  readonly additionalContext: string | null;
  readonly historicalApprovals: number;
  readonly source: 'rules' | 'jev';
}

export function currentEnvironmentHash(): string {
  return sha256(`${process.platform}\n${process.arch}\n${process.version}`).slice(0, 32);
}

function candidates(ws: WorkspaceServices): readonly CapsuleV2[] {
  const out: CapsuleV2[] = [];
  for (const id of ws.state.list<string>('capsule-latest')) {
    const c = getCapsule(ws, id);
    if (c !== undefined) out.push(c);
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** How old a capsule is, as a bucket (never a time of day): a fixed vocabulary. */
function ageBucket(createdAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(createdAt));
  if (!Number.isFinite(ms)) return 'an unknown time';
  if (ms < 3_600_000) return 'under an hour';
  if (ms < 86_400_000) return 'under a day';
  if (ms < 7 * 86_400_000) return 'under a week';
  return 'over a week';
}

/** What a capsule has still open, as counts: the features a pick is made from (no text of the capsule). */
function openWork(c: CapsuleV2): { readonly openChecks: number; readonly running: number; readonly unresolved: number } {
  const n = (kind: CapsuleItem['kind']) => c.items.filter((i) => i.kind === kind).length;
  return { openChecks: n('open-check'), running: n('running-work'), unresolved: n('unresolved') };
}

/**
 * The capsule that continues a session that named none (C21). With one candidate, or an engine that is
 * not there, the newest answers. With several, the rules answer when the newest capsule also holds the
 * most unfinished work (open checks, running tasks, unresolved failures); when an older capsule holds more,
 * Jev picks from content-free features of each: its kind (workspace or task), its age bucket, how many
 * items are mandatory, and the counts of what is still open. The options are fixed text built from those
 * numbers; no objective, path or item text of a capsule is read into a request, so nothing needs egress.
 * Any miss is the newest capsule, with the reason.
 */
export async function resolveCapsule(ws: WorkspaceServices, input: RehydrateInput): Promise<{ readonly capsule: CapsuleV2 | undefined; readonly source: 'rules' | 'jev'; readonly reasonCode: string; readonly decisionId: string | null }> {
  if (input.capsuleId !== undefined && input.capsuleId !== null) return { capsule: getCapsule(ws, input.capsuleId), source: 'rules', reasonCode: 'CAPSULE_GIVEN', decisionId: null };
  if (input.taskId !== null) return { capsule: latestCapsule(ws, input.taskId) ?? latestCapsule(ws, null), source: 'rules', reasonCode: 'TASK_GIVEN', decisionId: null };
  const all = candidates(ws);
  const list = (input.preferred === undefined ? all : [input.preferred, ...all.filter((c) => c.id !== input.preferred?.id)]).slice(0, 4);
  if (list.length <= 1) return { capsule: list[0], source: 'rules', reasonCode: list.length === 0 ? 'NO_CAPSULE' : 'ONE_CAPSULE', decisionId: null };
  const work = list.map((c) => openWork(c));
  const unfinished = work.map((w) => w.openChecks + w.running + w.unresolved);
  // The newest capsule (the first) also holds the most unfinished work: the rules are sure.
  if (unfinished.every((n) => (unfinished[0] ?? 0) >= n)) return { capsule: list[0], source: 'rules', reasonCode: 'RULES_NEWEST_SURE', decisionId: null };
  if (input.engine === undefined) return { capsule: list[0], source: 'rules', reasonCode: 'RULES_NEWEST', decisionId: null };
  const nowMs = input.nowMs ?? Date.now();
  const options: { [k: string]: string } = {};
  list.forEach((c, i) => {
    const w = work[i] as ReturnType<typeof openWork>;
    options[`c${String(i)}`] = `Saved capsule ${String(i + 1)}: a ${c.taskId === null ? 'workspace' : 'task'} capsule written ${ageBucket(c.createdAt, nowMs)} ago with ${String(c.items.length)} items, ${String(c.items.filter((x) => x.mandatory).length)} of them mandatory, and ${String(w.openChecks)} open checks, ${String(w.running)} running tasks and ${String(w.unresolved)} unresolved failures.`;
  });
  const r = await consultChoice(input.engine, {
    capabilityId: 'C21',
    specVersion: '1',
    objective: 'Pick the saved capsule that continues the resumed session, from counts only (advice only).',
    instructions: 'A session resumed without naming a task. Which listed capsule has the most unfinished work to continue?',
    options,
    evidence: [],
    facts: { candidates: list.length },
    workspaceId: ws.workspaceId,
    evidenceRevision: (list[0]?.id ?? 'none').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100),
    ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
    rules: () => ({ choice: 'c0', reasonCode: 'RULES_NEWEST' }),
  });
  const picked = list[Number(r.value.slice(1))] ?? list[0];
  return { capsule: picked, source: r.source, reasonCode: r.reasonCode, decisionId: r.decisionId };
}

function line(item: CapsuleItem): string {
  const cls = item.epistemic === 'fact' ? '' : ` (${item.epistemic})`;
  return `- ${item.kind}${cls}: ${safeText(item.text, 600)}`;
}

export async function rehydrate(ws: WorkspaceServices, input: RehydrateInput): Promise<Rehydration> {
  const nowMs = input.nowMs ?? Date.now();
  const { capsule, source, reasonCode, decisionId } = await resolveCapsule(ws, input);
  if (capsule === undefined) return { found: false, capsuleId: null, pickReason: reasonCode, pickDecisionId: decisionId, validity: null, invalidatedReceipts: [], additionalContext: null, historicalApprovals: 0, source };
  const git = input.git ?? nodeGit();
  // Stale receipts are invalidated against the current revision before anything is restored. Its
  // snapshot is also the one the capsule is compared with: one git status on the answer path (K3).
  const fresh = await refreshFreshness({ workspaceRoot: ws.workspaceRoot, workspaceId: ws.workspaceId, receipts: ws.receipts, state: ws.state, git, scope: receiptScopeOf(ws) });
  const now = fresh.snapshot;
  const validity: Validity = {
    headMatches: now.head === capsule.revision.head,
    branchMatches: now.branch === capsule.revision.branch,
    lockfileMatches: now.lockfileHash === capsule.revision.lockfileHash,
    environmentMatches: capsule.environmentHash === currentEnvironmentHash(),
    policyMatches: input.policyVersion === undefined || input.policyVersion === capsule.policyVersion,
  };
  const historical = capsule.approvals.filter((a) => a.status === 'historical' || (a.expiresAt !== null && Date.parse(a.expiresAt) <= nowMs));
  const cap = Math.max(500, Math.min(input.cap ?? 7_500, 8_000));
  const warnings: string[] = [];
  if (!validity.headMatches) warnings.push(`HEAD moved since the capsule (${capsule.revision.head.slice(0, 12)} then, ${now.head.slice(0, 12)} now): re-check changed files before relying on them.`);
  if (!validity.branchMatches) warnings.push(`The branch changed (${capsule.revision.branch ?? 'detached'} then, ${now.branch ?? 'detached'} now).`);
  if (!validity.lockfileMatches) warnings.push('Dependencies changed since the capsule: earlier check results are stale.');
  if (!validity.environmentMatches) warnings.push('The environment differs from the one the capsule was written in.');
  if (!validity.policyMatches) warnings.push('The policy version changed: re-read the constraints below as current policy may be stricter.');
  if (fresh.invalidated.length > 0) warnings.push(`${String(fresh.invalidated.length)} check result(s) are stale and must run again.`);
  let text = `Jevris resumed context from capsule ${capsule.id}${capsule.taskId === null ? '' : ` for task ${capsule.taskId}`}. It is advice only: it grants no permission, and approvals listed as history are not active.\nObjective: ${safeText(capsule.objective, 800)}\n`;
  for (const w of warnings) text += `Warning: ${w}\n`;
  const items = capsule.items.filter((i) => i.kind !== 'approval');
  // C20: what the compaction summary left out comes first, with the reason; the rest follows in the usual order.
  const omitted = new Set(input.emphasis?.omitted ?? []);
  const flagged = new Set((input.emphasis?.flagged ?? []).filter((id) => !omitted.has(id)));
  const first = [...items.filter((i) => omitted.has(i.id)), ...items.filter((i) => flagged.has(i.id))];
  const firstIds = new Set(first.map((i) => i.id));
  const rest = items.filter((i) => !firstIds.has(i.id));
  const reasonOf = (i: CapsuleItem): string => (omitted.has(i.id) ? 'left out of the compaction summary' : 'the compaction summary may have dropped this decision');
  for (const item of [...first, ...rest.filter((i) => i.mandatory), ...rest.filter((i) => !i.mandatory)]) {
    const l = `${firstIds.has(item.id) ? `- (${reasonOf(item)}) ${line(item).slice(2)}` : line(item)}\n`;
    if (text.length + l.length > cap - 200) {
      text += `- (${String(capsule.items.length)} items in total; the rest stay in capsule ${capsule.id})\n`;
      break;
    }
    text += l;
  }
  const active = capsule.approvals.filter((a) => !historical.includes(a));
  for (const a of active) text += `Approval in force: ${safeText(a.scope, 200)}${a.expiresAt === null ? '' : ` (until ${a.expiresAt})`}\n`;
  for (const a of historical.slice(0, 5)) text += `History only (expired): ${safeText(a.scope, 200)}\n`;
  await ws.hook.transact((tx) => tx.put('rehydrations', recordKey(ws.workspaceId, capsule.id), { atMs: nowMs, validity }));
  return {
    found: true,
    capsuleId: capsule.id,
    pickReason: reasonCode,
    pickDecisionId: decisionId,
    validity,
    invalidatedReceipts: fresh.invalidated,
    additionalContext: text.slice(0, cap),
    historicalApprovals: historical.length,
    source,
  };
}
