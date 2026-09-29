/**
 * Rehydration (MEM-09; SSOT §9.5, C21, US17, US18, E15).
 *
 * A resumed or compacted session gets its capsule back from Jevris state, never from the
 * transcript. The capsule is resolved by workspace and task; its recorded HEAD, branch,
 * lockfile hash, environment fingerprint and policy version are compared with the current
 * ones, stale receipts are invalidated, and the result is a bounded `additionalContext` text
 * with an explicit boundary line. Expired approvals appear only as history. When several
 * capsules could apply (no task given), Jev (Choice, C21) may pick one; the rules pick the
 * newest otherwise.
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
}

export interface Rehydration {
  readonly found: boolean;
  readonly capsuleId: string | null;
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

async function resolve(ws: WorkspaceServices, input: RehydrateInput): Promise<{ readonly capsule: CapsuleV2 | undefined; readonly source: 'rules' | 'jev' }> {
  if (input.capsuleId !== undefined && input.capsuleId !== null) return { capsule: getCapsule(ws, input.capsuleId), source: 'rules' };
  if (input.taskId !== null) return { capsule: latestCapsule(ws, input.taskId) ?? latestCapsule(ws, null), source: 'rules' };
  const list = candidates(ws).slice(0, 4);
  if (list.length <= 1 || input.engine === undefined) return { capsule: list[0], source: 'rules' };
  const options: { [k: string]: string } = {};
  list.forEach((c, i) => {
    options[`c${String(i)}`] = safeText(`${c.taskId === null ? 'Workspace' : `Task ${c.taskId}`}: ${c.objective}`, 300);
  });
  const r = await consultChoice(input.engine, {
    capabilityId: 'C21',
    specVersion: '1',
    objective: 'Pick the capsule that continues the resumed session.',
    instructions: 'A session resumed without naming a task. Which saved capsule should it continue?',
    options,
    evidence: list.map((c, i) => ({ id: `c${String(i)}`, text: `${c.createdAt} ${c.items.length} items, ${c.objective}`, sourceKind: 'tool' as const, priority: 'high' as const })),
    workspaceId: ws.workspaceId,
    evidenceRevision: list[0]?.id ?? 'none',
    ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
    rules: () => ({ choice: 'c0', reasonCode: 'RULES_NEWEST' }),
  });
  return { capsule: list[Number(r.value.slice(1))] ?? list[0], source: r.source };
}

function line(item: CapsuleItem): string {
  const cls = item.epistemic === 'fact' ? '' : ` (${item.epistemic})`;
  return `- ${item.kind}${cls}: ${safeText(item.text, 600)}`;
}

export async function rehydrate(ws: WorkspaceServices, input: RehydrateInput): Promise<Rehydration> {
  const nowMs = input.nowMs ?? Date.now();
  const { capsule, source } = await resolve(ws, input);
  if (capsule === undefined) return { found: false, capsuleId: null, validity: null, invalidatedReceipts: [], additionalContext: null, historicalApprovals: 0, source };
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
  for (const item of [...items.filter((i) => i.mandatory), ...items.filter((i) => !i.mandatory)]) {
    const l = `${line(item)}\n`;
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
    validity,
    invalidatedReceipts: fresh.invalidated,
    additionalContext: text.slice(0, cap),
    historicalApprovals: historical.length,
    source,
  };
}
