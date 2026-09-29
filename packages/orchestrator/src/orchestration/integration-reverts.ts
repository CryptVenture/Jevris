/**
 * An integrated owned change that is later reverted labels its route `reverted` (audit P2,
 * coordinator 2026-09-27). Deterministic facts only: the commit that integrated each task (its
 * squash, recorded by integration.run) and git's standard revert line, `This reverts commit
 * <id>.`, in the latest commits reachable from HEAD. No other message text is read or kept; only commit
 * ids go into the record. Git runs through the asynchronous GitPort (never on the event loop),
 * and a HEAD already scanned is not scanned again.
 *
 * Only merges approved within the relabel window (30 days) are looked at, and C refuses a revert
 * after its window anyway. The window is never longer than the decision retention: a revert record
 * aged out by retention must not let the same merge be labelled again (B, 4d62ed8). A task whose route has no verified pass is not relabelled
 * (`routeTakesLabel`); its decisions still get the label (B's P4 join).
 */
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';
import { nodeGit, type GitPort } from '../verify/revision.js';
import { DEFAULT_GIT_TIMEOUT_MS } from '../worktree.js';
import { effectiveRetention } from '../settings/config.js';
import { listIntegrations } from './integration.js';
import { recordRouteOutcome } from './learning.js';

export const INTEGRATION_REVERTS = 'integration-reverts';
const REVERT_SCAN = 'revert-scan';
/** The relabel window: merges older than this are not scanned. */
export const REVERT_WINDOW_MS = 30 * 24 * 60 * 60_000;
/**
 * Commits read per scan, newest first from HEAD. The scan uses no date filter: git's commit dates
 * come from whichever clock made each commit, so only commit ids decide (C, test:future).
 */
export const REVERT_SCAN_MAX_COMMITS = 2000;
const COMMIT = /^[0-9a-f]{40,64}$/;
/** git's standard revert line; the only message text matched. */
const REVERT_LINE = /^This reverts commit ([0-9a-f]{40,64})\.?\s*$/gm;

export interface IntegrationRevertRecord {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly integratedCommit: string;
  readonly revertCommit: string;
  readonly atMs: number;
}

/** The relabel window, capped by the effective decision retention (a smaller setting shortens it). */
export function revertWindowMs(ws: WorkspaceServices): number {
  try {
    const days = effectiveRetention({ home: ws.home, workspaceRoot: ws.workspaceRoot }).decisionRetentionDays;
    return Math.max(0, Math.min(REVERT_WINDOW_MS, days * 24 * 60 * 60_000));
  } catch {
    return 0;
  }
}

/** The reverted commit ids named by git's revert line in the latest commits from HEAD, with the reverting commit. */
async function recentReverts(git: GitPort, root: string): Promise<ReadonlyMap<string, string> | null> {
  const log = await git.run(['log', `--max-count=${String(REVERT_SCAN_MAX_COMMITS)}`, '--format=%H%x1f%B%x1e', 'HEAD'], root);
  if (!log.ok) return null;
  const out = new Map<string, string>();
  for (const entry of log.stdout.split('\x1e')) {
    const [sha, body] = entry.split('\x1f');
    const reverting = (sha ?? '').trim();
    if (!COMMIT.test(reverting) || body === undefined) continue;
    for (const m of body.matchAll(REVERT_LINE)) if (m[1] !== undefined && !out.has(m[1])) out.set(m[1], reverting);
  }
  return out;
}

/**
 * Scans for reverts of integrated task commits and labels each reverted task once. Answers the
 * task ids newly labelled. Never throws; a git failure scans nothing.
 */
export async function detectIntegrationReverts(ws: WorkspaceServices, options: { readonly git?: GitPort; readonly nowMs?: number } = {}): Promise<readonly string[]> {
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = revertWindowMs(ws);
  const candidates = listIntegrations(ws)
    .filter((r) => r.state === 'merged' && r.approvedAtMs !== null && r.approvedAtMs >= nowMs - windowMs)
    .flatMap((r) => r.tasks.filter((t) => t.outcome === 'applied' && typeof t.integratedCommit === 'string' && COMMIT.test(t.integratedCommit)).map((t) => ({ taskId: t.taskId, commit: t.integratedCommit as string })))
    .filter((c) => ws.state.get<IntegrationRevertRecord>(INTEGRATION_REVERTS, recordKey(ws.workspaceId, c.taskId, c.commit)) === undefined);
  if (candidates.length === 0) return [];
  const git = options.git ?? nodeGit(DEFAULT_GIT_TIMEOUT_MS);
  try {
    const head = (await git.run(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], ws.workspaceRoot)).stdout.trim();
    if (!COMMIT.test(head)) return [];
    const scanKey = recordKey(ws.workspaceId, 'head');
    const lastScan = ws.state.get<{ readonly head: string; readonly candidates: number }>(REVERT_SCAN, scanKey);
    if (lastScan !== undefined && lastScan.head === head && lastScan.candidates === candidates.length) return [];
    const reverts = await recentReverts(git, ws.workspaceRoot);
    if (reverts === null) return [];
    const labelled: string[] = [];
    for (const c of candidates) {
      const revertCommit = reverts.get(c.commit);
      if (revertCommit === undefined) continue;
      const record: IntegrationRevertRecord = { workspaceId: ws.workspaceId, taskId: c.taskId, integratedCommit: c.commit, revertCommit, atMs: nowMs };
      await ws.state.transact((tx) => tx.put(INTEGRATION_REVERTS, recordKey(ws.workspaceId, c.taskId, c.commit), record));
      recordRouteOutcome(ws, c.taskId, 'reverted', { nowMs });
      labelled.push(c.taskId);
    }
    await ws.state.transact((tx) => tx.put(REVERT_SCAN, scanKey, { head, candidates: candidates.length - labelled.length }));
    return labelled;
  } catch {
    return [];
  }
}

const pending = new Set<Promise<unknown>>();

/** Runs a scan off the answer path (after a verification run or an integration op). */
export function detectIntegrationRevertsInBackground(ws: WorkspaceServices, options: { readonly git?: GitPort; readonly nowMs?: number } = {}): void {
  const p = detectIntegrationReverts(ws, options).catch(() => []);
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Waits for background scans (tests and orderly shutdown). */
export async function drainIntegrationReverts(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
