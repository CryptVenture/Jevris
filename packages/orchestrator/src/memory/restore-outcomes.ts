/**
 * Capsule restore quality (audit P9, C17/C20/C21's measures). For each restore at a session
 * boundary D keeps one text-free row (collection `restore-outcomes`, keyed by session):
 *
 * - `delivered`: the context went out with every mandatory item and a valid capsule;
 * - `degraded`: it went out, but mandatory items did not fit, or the capsule no longer matched
 *   the checkout (head, branch, lockfile, environment or policy) or had receipts invalidated;
 * - `refused`: nothing went out (the harness is not certified for context, no capsule text, or
 *   the answer was not wanted; a later delivery replaces it).
 *
 * Then what followed: another restore request in the same session (a re-ask), the failure
 * families seen again among the next failures (a repeat of a failure from before the
 * compaction), the first check run, and whether the session later verified. Ids, hashes and
 * counts only: never item or diagnostic text. Mandatory facts stay pinned by rules; nothing here
 * changes a capsule or asks which constraints to forget.
 */
import type { WorkspaceServices } from '../workspace.js';
import { recordKey, safeText } from '../util.js';
import { loopSignals } from '../orchestration/loops.js';
import type { CapsuleV2 } from './capsule.js';
import type { Rehydration } from './rehydrate.js';

export const RESTORE_OUTCOMES = 'restore-outcomes';
/** Failed tool events after a restore that are watched for repeats of earlier failure families. */
export const RESTORE_WATCH_FAILURES = 50;
const ITEM_IDS_MAX = 64;
const FAMILIES_MAX = 64;

export type RestoreState = 'delivered' | 'degraded' | 'refused';

export interface RestoreOutcomeRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly capsuleId: string;
  readonly state: RestoreState;
  readonly reasonCode: string;
  readonly mandatoryItems: number;
  /** Mandatory items the delivered context did not carry (ids). */
  readonly omittedItemIds: readonly string[];
  /** Validity checks the capsule failed: head, branch, lockfile, environment, policy. */
  readonly invalid: readonly string[];
  readonly invalidatedReceipts: number;
  /** Diagnostic fingerprints (hashes) of the failures seen before the restore. */
  readonly priorFamilies: readonly string[];
  readonly attempts: number;
  readonly atMs: number;
  readonly reasks: number;
  readonly failuresWatched: number;
  readonly repeatFamilies: number;
  readonly checkStartedMs: number | null;
  readonly verifiedAtMs: number | null;
}

const key = (ws: WorkspaceServices, sessionId: string): string => recordKey(ws.workspaceId, sessionId);

const pending = new Set<Promise<unknown>>();

/** Runs a restore record off the hook's answer path: it never delays or fails the answer. */
export function restoreInBackground(work: Promise<unknown>): void {
  const p = work.catch(() => undefined);
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Waits for background restore records (tests and orderly shutdown). */
export async function drainRestoreOutcomes(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

function priorFamilies(ws: WorkspaceServices): readonly string[] {
  const seen = new Set<string>();
  for (const s of loopSignals(ws, null)) if (s.kind === 'diagnostic') seen.add(s.hash);
  return [...seen].slice(-FAMILIES_MAX);
}

/** Records how a restore went (latest attempt wins; follow-ups carry over for the same capsule). */
export async function recordRestore(
  ws: WorkspaceServices,
  input: { readonly sessionId: string; readonly capsule: CapsuleV2; readonly reasonCode: string; readonly delivered: boolean; readonly rehydration?: Rehydration; readonly nowMs: number },
): Promise<RestoreOutcomeRecord> {
  const mandatory = input.capsule.items.filter((i) => i.mandatory);
  const text = input.rehydration?.additionalContext ?? null;
  const omitted = input.delivered && text !== null ? mandatory.filter((i) => !text.includes(safeText(i.text, 600))).map((i) => i.id) : [];
  const v = input.rehydration?.validity ?? null;
  const invalid = v === null ? [] : ([['head', v.headMatches], ['branch', v.branchMatches], ['lockfile', v.lockfileMatches], ['environment', v.environmentMatches], ['policy', v.policyMatches]] as const).filter(([, ok]) => !ok).map(([n]) => n);
  const invalidatedReceipts = input.rehydration?.invalidatedReceipts.length ?? 0;
  const state: RestoreState = !input.delivered ? 'refused' : omitted.length > 0 || invalid.length > 0 || invalidatedReceipts > 0 ? 'degraded' : 'delivered';
  const families = priorFamilies(ws);
  return ws.hook.transact((tx) => {
    const prior = tx.get<RestoreOutcomeRecord>(RESTORE_OUTCOMES, key(ws, input.sessionId));
    const same = prior !== undefined && prior.capsuleId === input.capsule.id;
    const row: RestoreOutcomeRecord = {
      workspaceId: ws.workspaceId,
      sessionId: input.sessionId,
      capsuleId: input.capsule.id,
      state,
      reasonCode: input.reasonCode.slice(0, 64),
      mandatoryItems: mandatory.length,
      omittedItemIds: omitted.slice(0, ITEM_IDS_MAX),
      invalid,
      invalidatedReceipts,
      priorFamilies: same && prior.priorFamilies.length > 0 ? prior.priorFamilies : families,
      attempts: same ? prior.attempts + 1 : 1,
      atMs: input.nowMs,
      reasks: same ? prior.reasks : 0,
      failuresWatched: 0,
      repeatFamilies: 0,
      checkStartedMs: null,
      verifiedAtMs: null,
    };
    tx.put(RESTORE_OUTCOMES, key(ws, input.sessionId), row);
    return row;
  });
}

async function follow(ws: WorkspaceServices, sessionId: string | null, change: (row: RestoreOutcomeRecord) => RestoreOutcomeRecord | null): Promise<void> {
  if (sessionId === null) return;
  const k = key(ws, sessionId);
  const current = ws.state.get<RestoreOutcomeRecord>(RESTORE_OUTCOMES, k);
  if (current === undefined || current.state === 'refused' || change(current) === null) return;
  await ws.hook.transact((tx) => {
    const row = tx.get<RestoreOutcomeRecord>(RESTORE_OUTCOMES, k);
    if (row === undefined || row.state === 'refused') return;
    const next = change(row);
    if (next !== null) tx.put(RESTORE_OUTCOMES, k, next);
  });
}

/** Another restore request in the session after one went out (the model or the harness asked again). */
export function noteRestoreReask(ws: WorkspaceServices, sessionId: string | null, capsuleId: string): Promise<void> {
  return follow(ws, sessionId, (row) => (row.capsuleId === capsuleId ? { ...row, reasks: row.reasks + 1 } : null));
}

/** A failed tool event after the restore: counts a repeat when its fingerprint was seen before it (within the watch window). */
export function noteRestoreFailure(ws: WorkspaceServices, sessionId: string | null, fingerprint: string | null): Promise<void> {
  return follow(ws, sessionId, (row) => {
    if (row.failuresWatched >= RESTORE_WATCH_FAILURES) return null;
    const repeat = fingerprint !== null && row.priorFamilies.includes(fingerprint);
    return { ...row, failuresWatched: row.failuresWatched + 1, repeatFamilies: row.repeatFamilies + (repeat ? 1 : 0) };
  });
}

/** Restores a check run can follow up: delivered or degraded, before it, in the last day. */
export const RESTORE_CHECK_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The first check run after a restore. A check run names no session, so it follows up the
 * workspace's latest restore that went out before it (within a day).
 */
export function noteRestoreCheckStarted(ws: WorkspaceServices, nowMs: number): Promise<void> {
  const latest = ws.state
    .list<RestoreOutcomeRecord>(RESTORE_OUTCOMES)
    .filter((r) => r.workspaceId === ws.workspaceId && r.state !== 'refused' && r.atMs <= nowMs && r.atMs >= nowMs - RESTORE_CHECK_WINDOW_MS)
    .sort((a, b) => b.atMs - a.atMs)[0];
  if (latest === undefined) return Promise.resolve();
  return follow(ws, latest.sessionId, (row) => (row.checkStartedMs === null && row.capsuleId === latest.capsuleId ? { ...row, checkStartedMs: nowMs } : null));
}

/** The session verified after the restore. */
export function noteRestoreVerified(ws: WorkspaceServices, sessionId: string | null, nowMs: number): Promise<void> {
  return follow(ws, sessionId, (row) => (row.verifiedAtMs === null ? { ...row, verifiedAtMs: nowMs } : null));
}

export interface RestoreSummary {
  readonly delivered: number;
  readonly degraded: number;
  readonly refused: number;
  readonly omittedItems: number;
  readonly reasked: number;
  readonly withRepeats: number;
  readonly checkStarted: number;
  readonly verified: number;
}

/** Restores in the workspace and what followed them (C17/C20/C21's measures; ids and counts only). */
export function restoreSummary(ws: WorkspaceServices): RestoreSummary {
  const rows = ws.state.list<RestoreOutcomeRecord>(RESTORE_OUTCOMES).filter((r) => r.workspaceId === ws.workspaceId);
  const went = rows.filter((r) => r.state !== 'refused');
  return {
    delivered: rows.filter((r) => r.state === 'delivered').length,
    degraded: rows.filter((r) => r.state === 'degraded').length,
    refused: rows.filter((r) => r.state === 'refused').length,
    omittedItems: went.reduce((n, r) => n + r.omittedItemIds.length, 0),
    reasked: went.filter((r) => r.reasks > 0).length,
    withRepeats: went.filter((r) => r.repeatFamilies > 0).length,
    checkStarted: went.filter((r) => r.checkStartedMs !== null).length,
    verified: went.filter((r) => r.verifiedAtMs !== null).length,
  };
}
