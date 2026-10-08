/**
 * The per-session tier memo (owner decisions 2026-10-08, tiered routing, step 2b): the model tier last judged for a
 * session's main work, kept in memory for ten minutes.
 *
 * Why it exists. A subagent launch (PreToolUse) is on the hook hot path and must make NO new Jev call. Whether a
 * write-capable subagent may be routed UP is the shared tier rule's answer for the session's own work, which was judged
 * when the main-session tier was asked for (`jevris route` with a task, over the models eligible on the session's
 * harness). This memo carries that answer to the subagent hook and, on Kilo and OpenCode, to a turn's route.turn, so
 * neither asks again. It holds ids, codes and a tier: no task text, no path, no title.
 *
 * It lives in the sidecar's memory only (bounded, newest wins, expires after `SESSION_TIER_MEMO_TTL_MS`), so a restart
 * forgets it and the use sites read "no memo" as the baseline tier: nothing goes up without a fresh judgement.
 */
import type { ModelTier, ModelTierBasis } from './model-tier.js';

/** Ten minutes: the lifetime of a memo (owner design 2026-10-08). */
export const SESSION_TIER_MEMO_TTL_MS = 600_000;
const CAP = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface SessionTierMemo {
  readonly tier: ModelTier;
  /** The model the tier named (the baseline for `baseline`). */
  readonly targetModelId: string;
  /** The model the session's work was judged against: a memo for another baseline is not used. */
  readonly baselineModelId: string;
  readonly basis: ModelTierBasis;
  /** `TIER_*` reason codes of the decision (at most 16). */
  readonly reasonCodes: readonly string[];
  readonly atMs: number;
}

/**
 * A route request carries a session id only when its caller knows it (the CLI's `jevris route` and the MCP tool do not), so a
 * memo from one that does not is kept under the harness's slot for the workspace, and a reader takes the newer of its own
 * session's memo and that slot. Two sessions of one harness in one workspace can share the slot for its ten minutes.
 */
export function harnessTierSlot(harness: string): string {
  return `harness:${harness}`;
}

const memos = new Map<string, SessionTierMemo>();

function keyOf(workspaceId: string, sessionId: string): string | null {
  return ID.test(workspaceId) && ID.test(sessionId) ? `${workspaceId}\u0000${sessionId}` : null;
}

/** Keeps the tier judged for a session. Returns false when an id, a code or the time is not valid. */
export function noteSessionTier(workspaceId: string, sessionId: string, memo: SessionTierMemo): boolean {
  const key = keyOf(workspaceId, sessionId);
  if (key === null || !ID.test(memo.targetModelId) || !ID.test(memo.baselineModelId) || !Number.isFinite(memo.atMs)) return false;
  const reasonCodes = memo.reasonCodes.filter((c) => CODE.test(c)).slice(0, 16);
  memos.delete(key);
  memos.set(key, { ...memo, reasonCodes });
  while (memos.size > CAP) memos.delete(memos.keys().next().value as string);
  return true;
}

function fresh(key: string | null, nowMs: number): SessionTierMemo | null {
  if (key === null) return null;
  const memo = memos.get(key);
  if (memo === undefined) return null;
  if (!(nowMs - memo.atMs <= SESSION_TIER_MEMO_TTL_MS) || nowMs < memo.atMs - SESSION_TIER_MEMO_TTL_MS) {
    memos.delete(key);
    return null;
  }
  return memo;
}

/**
 * The session's memo when it is still fresh at `nowMs`, else null (an expired memo is dropped). With `harness`, the
 * harness's slot for the workspace (a route request that named no session) counts too: the newer of the two wins.
 */
export function readSessionTier(workspaceId: string, sessionId: string, nowMs: number, harness?: string): SessionTierMemo | null {
  const own = fresh(keyOf(workspaceId, sessionId), nowMs);
  const slot = harness === undefined ? null : fresh(keyOf(workspaceId, harnessTierSlot(harness)), nowMs);
  if (own === null) return slot;
  return slot !== null && slot.atMs > own.atMs ? slot : own;
}

/** Test seam: forgets every memo. */
export function clearSessionTierMemos(): void {
  memos.clear();
}
