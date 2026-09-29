/**
 * Omission audit and restore-once (MEM-06; SSOT §9.3, C20, W03).
 *
 * After a summary (a native compaction summary, a handoff note or any text the harness gives
 * us), every mandatory capsule item must still be recognisable. Exact material is checked
 * deterministically: declared ids (constraint ids, open-check ids, task ids) match only on
 * token boundaries, so `C1` never matches inside `C10`, and constraint text matches by the
 * hash of its normalised form or by a token-bounded containment. Jev (Noul, C20) may flag a
 * likely omission of non-exact items such as decisions; it never clears an exact item.
 *
 * A missing item is restored once, at the next documented boundary (for Claude, the
 * SessionStart `compact` or `resume` hook, or the next UserPromptSubmit), through a supported
 * context path. The pending restore is keyed by capsule and session; after it is taken it is
 * never repeated for that capsule.
 */
import type { WorkspaceServices } from '../workspace.js';
import type { CapsuleItem, CapsuleV2 } from './capsule.js';
import { normaliseText } from './capsule.js';
import { consultNoul } from '../capabilities/consult.js';
import { recordKey, safeText, sha256 } from '../util.js';

/** Escapes a literal for a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `id` appears in `text` as a whole token (letters, digits, `_`, `-` and `.` bind). */
export function containsId(text: string, id: string): boolean {
  if (id.length === 0) return false;
  return new RegExp(`(?<![A-Za-z0-9_.-])${literal(id)}(?![A-Za-z0-9_])`).test(text);
}

/** Leading declared id of a constraint, e.g. `C1: never ...` or `[SEC-2] ...`. */
export function declaredId(text: string): string | null {
  const m = /^\s*\[?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\d)\]?\s*[:.)\]-]/.exec(text);
  return m?.[1] ?? null;
}

function sentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => normaliseText(s.replace(/^[-*•\d.)\s]+/, '')))
    .filter((s) => s.length > 0);
}

export interface AuditFinding {
  readonly itemId: string;
  readonly kind: CapsuleItem['kind'];
  readonly text: string;
  readonly matchedBy: 'id' | 'text-hash' | 'text' | null;
}

export interface AuditResult {
  readonly checked: number;
  readonly present: readonly AuditFinding[];
  readonly missing: readonly AuditFinding[];
  /** Optional items Jev flagged as likely omitted (advice only). */
  readonly flagged: readonly AuditFinding[];
  readonly source: 'rules' | 'jev';
}

function exactMatch(item: CapsuleItem, summary: string, summaryHashes: ReadonlySet<string>, normalisedSummary: string): AuditFinding['matchedBy'] {
  const ids: string[] = [];
  const declared = declaredId(item.text);
  if (declared !== null) ids.push(declared);
  if (item.kind === 'open-check' || item.kind === 'running-work' || item.kind === 'unresolved') {
    const m = /^(?:Check|Task) ([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(item.text);
    if (m?.[1] !== undefined) ids.push(m[1]);
  }
  if (ids.some((id) => containsId(summary, id))) return 'id';
  const norm = normaliseText(item.text);
  if (summaryHashes.has(sha256(norm).slice(0, 32))) return 'text-hash';
  if (norm.length >= 12 && new RegExp(`(?<![a-z0-9])${literal(norm)}(?![a-z0-9])`).test(normalisedSummary)) return 'text';
  return null;
}

export interface AuditInput {
  readonly summary: string;
  readonly engine?: unknown;
  readonly egressApproved?: boolean;
  readonly remainingMs?: number;
}

export async function auditOmissions(ws: WorkspaceServices, capsule: CapsuleV2, input: AuditInput): Promise<AuditResult> {
  const normalisedSummary = normaliseText(input.summary);
  const summaryHashes = new Set(sentences(input.summary).map((s) => sha256(s).slice(0, 32)));
  const present: AuditFinding[] = [];
  const missing: AuditFinding[] = [];
  const mandatory = capsule.items.filter((i) => i.mandatory && i.id !== 'reference-index');
  for (const item of mandatory) {
    const by = exactMatch(item, input.summary, summaryHashes, normalisedSummary);
    const finding = { itemId: item.id, kind: item.kind, text: item.text, matchedBy: by };
    (by === null ? missing : present).push(finding);
  }
  const flagged: AuditFinding[] = [];
  let source: 'rules' | 'jev' = 'rules';
  if (input.engine !== undefined && input.egressApproved === true) {
    for (const item of capsule.items.filter((i) => !i.mandatory && i.kind === 'decision').slice(0, 6)) {
      if (exactMatch(item, input.summary, summaryHashes, normalisedSummary) !== null) continue;
      const r = await consultNoul(input.engine, {
        capabilityId: 'C20',
        specVersion: '1',
        objective: 'Flag a decision that a compaction summary likely dropped.',
        instructions: 'Does the summary omit or contradict this accepted decision?',
        whenTrue: 'The decision is missing from or contradicted by the summary.',
        whenFalse: 'The summary keeps the decision, possibly in other words.',
        evidence: [
          { id: 'decision', text: item.text, sourceKind: 'user', priority: 'mandatory' },
          { id: 'summary', text: input.summary.slice(0, 6000), sourceKind: 'tool', priority: 'high' },
        ],
        workspaceId: ws.workspaceId,
        evidenceRevision: capsule.id,
        ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
        rules: () => ({ value: false, reasonCode: 'RULES_NO_FLAG' }),
      });
      if (r.source === 'jev') source = 'jev';
      if (r.value) flagged.push({ itemId: item.id, kind: item.kind, text: item.text, matchedBy: null });
    }
  }
  return { checked: mandatory.length, present, missing, flagged, source };
}

// ------------------------------------------------------------------------- restore-once

interface PendingRestore {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly sessionId: string;
  readonly itemIds: readonly string[];
  readonly createdAtMs: number;
  readonly taken: boolean;
}

/** Queues the missing items for one restore at the next boundary of this session. */
export async function queueRestore(ws: WorkspaceServices, capsuleId: string, sessionId: string, itemIds: readonly string[], nowMs = Date.now()): Promise<boolean> {
  if (itemIds.length === 0) return false;
  const key = recordKey(ws.workspaceId, capsuleId, sessionId);
  return ws.hook.transact((tx) => {
    const prior = tx.get<PendingRestore>('restores', key);
    if (prior !== undefined) return false; // restore once: a capsule is never queued twice per session
    tx.put('restores', key, { workspaceId: ws.workspaceId, capsuleId, sessionId, itemIds: [...itemIds].slice(0, 128), createdAtMs: nowMs, taken: false } satisfies PendingRestore);
    return true;
  });
}

export type RestoreCommit =
  | { readonly state: 'taken'; readonly items: readonly CapsuleItem[] }
  | { readonly state: 'nothing-pending' | 'already-taken' | 'not-wanted' };

/**
 * Takes the pending restore for a session, once, and only while `wanted()` says the answer that
 * carries it will be used (checked inside the transaction, so it is taken exactly when that
 * answer goes out). Not wanted, the restore stays pending for the next boundary (US14).
 */
export async function commitRestore(ws: WorkspaceServices, capsule: CapsuleV2, sessionId: string, wanted: () => boolean): Promise<RestoreCommit> {
  const key = recordKey(ws.workspaceId, capsule.id, sessionId);
  const taken = await ws.hook.transact((tx): RestoreCommit | readonly string[] => {
    const prior = tx.get<PendingRestore>('restores', key);
    if (prior === undefined) return { state: 'nothing-pending' };
    if (prior.taken) return { state: 'already-taken' };
    if (!wanted()) return { state: 'not-wanted' };
    tx.put('restores', key, { ...prior, taken: true });
    return prior.itemIds;
  });
  if (!Array.isArray(taken)) return taken as RestoreCommit;
  const ids = new Set(taken);
  return { state: 'taken', items: capsule.items.filter((i) => ids.has(i.id)) };
}

/**
 * Takes the pending restore for a session, once. Returns the items to restore, or null when
 * nothing is pending or it was already taken.
 */
export async function takeRestore(ws: WorkspaceServices, capsule: CapsuleV2, sessionId: string): Promise<readonly CapsuleItem[] | null> {
  const taken = await commitRestore(ws, capsule, sessionId, () => true);
  return taken.state === 'taken' ? taken.items : null;
}

/** Whether this capsule was already restored (or queued) for the session. */
export function restoreState(ws: WorkspaceServices, capsuleId: string, sessionId: string): 'none' | 'pending' | 'taken' {
  const row = ws.state.get<PendingRestore>('restores', recordKey(ws.workspaceId, capsuleId, sessionId));
  return row === undefined ? 'none' : row.taken ? 'taken' : 'pending';
}

/** The model-visible restore text: bounded, marked as advice, never a permission. */
export function restoreText(items: readonly CapsuleItem[], capsuleId: string, cap = 7_500): string {
  const head = `Jevris restored context from capsule ${capsuleId}. It is advice only: it grants no permission and does not replace your instructions.\n`;
  let out = head;
  for (const item of items) {
    const line = `- [${item.kind}${item.epistemic === 'fact' ? '' : `, ${item.epistemic}`}] ${safeText(item.text, 600)}\n`;
    if (out.length + line.length > cap - 80) {
      out += `- (more items remain in capsule ${capsuleId}; export it with the handoff export operation)\n`;
      break;
    }
    out += line;
  }
  return out;
}
