/**
 * Evidence-selection usage (audit P10, C34's measure). Each `evidence.select` is kept as its
 * selection id and ranked handle ids; each `evidence.get` as the handle read, the selection it
 * came from and its rank there. Ids, ranks and times only: never an intent, label or output.
 *
 * A read names its selection when the client sends one (`selectionId`); otherwise it joins the
 * latest selection of the last 30 minutes that ranked the handle, or none. Both collections are
 * orchestration history (B's retention sweeps them after the decision window). Nothing here
 * changes a ranking: the measure feeds a release proposal for the fixed boosts only.
 */
import type { WorkspaceServices } from '../workspace.js';
import { hashOf, recordKey } from '../util.js';

export const EVIDENCE_SELECTIONS = 'evidence-selections';
export const EVIDENCE_READS = 'evidence-reads';
/** Ranked handles kept per selection. */
export const SELECTION_RANK_MAX = 50;
/** How far back a read without a selection id looks for the selection that ranked its handle. */
export const SELECTION_JOIN_MS = 30 * 60_000;
/** The store id pattern a selection id follows (and a client's `selectionId` must match). */
export const SELECTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Recent selections held in memory per workspace, for the read join. */
const RECENT_MAX = 32;

export interface EvidenceSelectionRecord {
  readonly workspaceId: string;
  readonly selectionId: string;
  readonly rankedHandleIds: readonly string[];
  readonly atMs: number;
}

export interface EvidenceReadRecord {
  readonly workspaceId: string;
  readonly handleId: string;
  readonly selectionId: string | null;
  /** 1-based rank of the handle in its selection; null without one. */
  readonly rank: number | null;
  readonly atMs: number;
}

/** The handle id a selection ranks and a read names: the evidence.select item id form (`ev:<hash>` reads as `ev-<hash>`). */
export function usageHandleId(raw: string): string | null {
  const id = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128);
  return HANDLE.test(id) ? id : null;
}

const recent = new Map<string, EvidenceSelectionRecord[]>();

function recentFor(ws: WorkspaceServices, nowMs: number): EvidenceSelectionRecord[] {
  let list = recent.get(ws.workspaceId);
  if (list === undefined) {
    // First use in this process: seed from the ledger (the last join window only).
    list = ws.state
      .list<EvidenceSelectionRecord>(EVIDENCE_SELECTIONS)
      .filter((s) => s.workspaceId === ws.workspaceId && typeof s.atMs === 'number' && s.atMs >= nowMs - SELECTION_JOIN_MS)
      .sort((a, b) => a.atMs - b.atMs)
      .slice(-RECENT_MAX);
    recent.set(ws.workspaceId, list);
  }
  return list;
}

/** Keeps one selection (ranked handle ids, bounded) and answers its id; null when nothing was ranked. */
export async function recordEvidenceSelection(ws: WorkspaceServices, rankedIds: readonly string[], nowMs: number): Promise<string | null> {
  const ranked = [...new Set(rankedIds.map(usageHandleId).filter((id): id is string => id !== null))].slice(0, SELECTION_RANK_MAX);
  if (ranked.length === 0) return null;
  const selectionId = `sel-${hashOf([ws.workspaceId, ranked, nowMs, Math.random()]).slice(0, 24)}`;
  const record: EvidenceSelectionRecord = { workspaceId: ws.workspaceId, selectionId, rankedHandleIds: ranked, atMs: nowMs };
  await ws.hook.transact((tx) => tx.put(EVIDENCE_SELECTIONS, recordKey(ws.workspaceId, selectionId), record));
  const list = recentFor(ws, nowMs);
  list.push(record);
  if (list.length > RECENT_MAX) list.splice(0, list.length - RECENT_MAX);
  return selectionId;
}

/**
 * Keeps one read. A client's selection id is used when it names a kept selection of this
 * workspace; else the latest recent selection that ranked the handle; else none. A malformed id
 * is ignored, never refused.
 */
export async function recordEvidenceRead(ws: WorkspaceServices, handle: string, selectionId: unknown, nowMs: number): Promise<EvidenceReadRecord | null> {
  const handleId = usageHandleId(handle);
  if (handleId === null) return null;
  const named = typeof selectionId === 'string' && SELECTION_ID_PATTERN.test(selectionId) ? ws.state.get<EvidenceSelectionRecord>(EVIDENCE_SELECTIONS, recordKey(ws.workspaceId, selectionId)) : undefined;
  const from =
    named !== undefined && named.workspaceId === ws.workspaceId
      ? named
      : [...recentFor(ws, nowMs)].reverse().find((s) => s.atMs >= nowMs - SELECTION_JOIN_MS && s.atMs <= nowMs && s.rankedHandleIds.includes(handleId));
  const at = from === undefined ? -1 : from.rankedHandleIds.indexOf(handleId);
  const record: EvidenceReadRecord = { workspaceId: ws.workspaceId, handleId, selectionId: from?.selectionId ?? null, rank: at < 0 ? null : at + 1, atMs: nowMs };
  const key = recordKey(ws.workspaceId, hashOf([handleId, record.selectionId, nowMs, Math.random()]).slice(0, 32));
  await ws.hook.transact((tx) => tx.put(EVIDENCE_READS, key, record));
  return record;
}

/** Selections and reads in a workspace, for C34's measure: how often a ranked handle was read, and at which rank. */
export interface EvidenceUsage {
  readonly selections: number;
  readonly reads: number;
  /** Reads of a handle a selection ranked. */
  readonly readsFromSelection: number;
  /** Of the selections, the share of their top-k handles read later (null with no selection). */
  readonly precisionAtK: number | null;
  readonly k: number;
  /** Of the reads, the share that a selection had ranked (null with no read). */
  readonly recall: number | null;
}

export function evidenceUsage(ws: WorkspaceServices, k = 5): EvidenceUsage {
  const selections = ws.state.list<EvidenceSelectionRecord>(EVIDENCE_SELECTIONS).filter((s) => s.workspaceId === ws.workspaceId);
  const reads = ws.state.list<EvidenceReadRecord>(EVIDENCE_READS).filter((r) => r.workspaceId === ws.workspaceId);
  const readBy = new Map<string, Set<string>>();
  for (const r of reads) {
    if (r.selectionId === null) continue;
    const set = readBy.get(r.selectionId) ?? new Set<string>();
    set.add(r.handleId);
    readBy.set(r.selectionId, set);
  }
  let [shown, hit] = [0, 0];
  for (const s of selections) {
    const top = s.rankedHandleIds.slice(0, k);
    shown += top.length;
    const read = readBy.get(s.selectionId);
    hit += read === undefined ? 0 : top.filter((h) => read.has(h)).length;
  }
  const fromSelection = reads.filter((r) => r.selectionId !== null).length;
  return {
    selections: selections.length,
    reads: reads.length,
    readsFromSelection: fromSelection,
    precisionAtK: shown === 0 ? null : hit / shown,
    k,
    recall: reads.length === 0 ? null : fromSelection / reads.length,
  };
}

/** Forgets the in-memory recent selections (tests, and a workspace's data delete). */
export function resetEvidenceUsageCache(): void {
  recent.clear();
}
