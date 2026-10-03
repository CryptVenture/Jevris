/**
 * Check relevance in the sidecar (owner decision 2026-10-01, Jev as an active decision aid): the
 * evidence a ranking needs, held in this workspace and sent nowhere, and the gates around it.
 *
 * `@jevris/core`'s `rankChecks` does the ranking (rules first, Jev from content-free features when
 * the rules are not sure). This module reads what Jevris already holds: each approved check's
 * last receipt state and the paths changed in the working tree. It hands those to the ranker as
 * local inputs; the ranker reduces them to counts, categories and codes before anything leaves.
 * The result is advice about ORDER (the Stop reminder, the order `jevris verify` runs the approved
 * checks in). It never removes, skips, waives or passes a check: only receipts decide done.
 */
import type { SidecarOpContext } from '@jevris/contracts';
import { rankChecks, rulesOrderOf, type CheckLastState, type CheckRanking, type DecisionEngine, type RelevanceCheck } from '@jevris/core';
import { changedFiles } from '../capabilities/repo.js';
import type { WorkspaceServices } from '../workspace.js';
import type { CheckStatus, CompletionReport } from './completion.js';
import { nodeGit, type GitPort } from './revision.js';
import { approvedManifests, verificationStatus } from './service.js';

/** The longest Jev is waited for on a Stop or a verify, in ms (the decision cache answers a repeat at once). */
export const RELEVANCE_WAIT_MS = 700;
/** Time kept back from the request's remaining time for the rest of the answer, in ms. */
export const RELEVANCE_MARGIN_MS = 450;
/**
 * The reason code of a ranking whose changed-files read was not in by the request's deadline (a
 * slow or locked git): the rules order with no change known, no Jev call and no record.
 */
export const RELEVANCE_GIT_DEADLINE = 'CHECK_RELEVANCE_GIT_DEADLINE';

/** A completion status as a check's last receipt state: a failing or passing receipt, or none current. */
export function lastStateOf(status: CheckStatus): CheckLastState {
  switch (status) {
    case 'passed':
      return 'passing';
    case 'failed':
      return 'failing';
    case 'stale':
    case 'unknown':
      return 'stale';
    default:
      return 'missing';
  }
}

/**
 * The engine the sidecar built, when `ctx.engine` looks like one (it can decide). An engine that
 * cannot record or look up a decision still ranks: the ranking is then not recorded.
 */
export function decisionEngineOf(engine: unknown): DecisionEngine | null {
  if (engine === null || engine === undefined || typeof engine !== 'object') return null;
  return typeof (engine as Partial<DecisionEngine>).decide === 'function' ? (engine as DecisionEngine) : null;
}

/**
 * The paths changed in the working tree against HEAD (staged, unstaged, untracked), workspace
 * relative; null when git cannot answer. Never throws. Names stay on this machine: the ranker
 * reduces them to counts and categories.
 */
export async function changedPathsOf(root: string, git?: GitPort): Promise<readonly string[] | null> {
  try {
    return await changedFiles(git ?? nodeGit(), root);
  } catch {
    return null;
  }
}

/**
 * An order says something when a change is known or a check failed last time. With neither, the
 * order is the usual one, and a Stop or a verify answer does not add a line about it.
 */
export function orderIsInformed(ranking: CheckRanking): boolean {
  return ranking.shape !== 'none' || ranking.firstWhy === 'failed';
}

export type RankContext = Pick<SidecarOpContext, 'engine' | 'mode' | 'jevAssist' | 'killSwitchStopped' | 'deadline'>;

export interface RankRequest {
  readonly ctx: RankContext;
  readonly workspaceId: string;
  readonly checks: readonly RelevanceCheck[];
  /** The changed paths, or a promise of them (started earlier so the git read overlaps other work). */
  readonly paths: Promise<readonly string[] | null> | readonly string[] | null;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  /** Override of the longest Jev wait, in ms (tests). */
  readonly waitMs?: number;
  /** Override of the time kept back from the request's remaining time, in ms (tests). */
  readonly marginMs?: number;
}

/**
 * The changed paths, or 'late' when they are not in within `waitMs`. A read that is already in
 * wins at any `waitMs`; one that rejects is no paths. The read itself is left to finish (or time
 * out) on its own; nothing here waits for it.
 */
async function pathsWithin(paths: RankRequest['paths'], waitMs: number): Promise<readonly string[] | null | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), Math.max(0, Math.floor(waitMs)));
  });
  try {
    return await Promise.race([Promise.resolve(paths).catch(() => null), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ranks the checks for this request. Rules answer when they are sure; Jev is asked when `jev.assist`
 * is `classify`, the mode and the kill switch allow it and there is time. Never throws, and never
 * waits past the request's own deadline, for Jev or for the changed-files read (a slow or locked
 * git): every miss is the rules order with a reason code.
 */
export async function rankApprovedChecks(request: RankRequest): Promise<CheckRanking> {
  const { ctx } = request;
  // The same deadline as the Jev wait below: the time left less the margin kept for the rest of the answer.
  const waited = await pathsWithin(request.paths, ctx.deadline.remainingMs() - (request.marginMs ?? RELEVANCE_MARGIN_MS));
  if (waited === 'late') return rulesOrderOf({ checks: request.checks, paths: null }, RELEVANCE_GIT_DEADLINE);
  const paths = waited;
  const input = { checks: request.checks, paths };
  try {
    const left = ctx.deadline.remainingMs() - (request.marginMs ?? RELEVANCE_MARGIN_MS);
    return await rankChecks(
      decisionEngineOf(ctx.engine),
      input,
      { workspaceId: request.workspaceId, ...(request.taskId == null ? {} : { taskId: request.taskId }), ...(request.sessionId == null ? {} : { sessionId: request.sessionId }) },
      {
        // Absent (a direct unit call) reads as classify, like the route op.
        assist: ctx.jevAssist === 'off' ? 'off' : 'classify',
        ...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
        killSwitchStopped: ctx.killSwitchStopped,
        deadlineMs: Math.max(0, Math.min(request.waitMs ?? RELEVANCE_WAIT_MS, Math.floor(left))),
      },
    );
  } catch {
    return rulesOrderOf(input, 'CHECK_RELEVANCE_ERROR');
  }
}

/**
 * The ranking for a `jevris verify` run: the approved checks (or `ids` of them), each with its last
 * receipt state as the workspace stands now, against the paths changed in the tree. The status read
 * is the same freshness read the run's own answer does; a failure of it is the usual order. Null
 * when fewer than two checks would run.
 */
export async function rankForRun(
  ctx: RankContext,
  ws: WorkspaceServices,
  input: { readonly ids: readonly string[]; readonly taskId: string | null; readonly git?: GitPort; readonly store?: import('@jevris/store').OpenStoreResult; readonly sessionId?: string | null },
): Promise<CheckRanking | null> {
  const manifests = approvedManifests(ws).filter((m) => input.ids.length === 0 || input.ids.includes(m.id));
  // Fewer than two checks have no order to give.
  if (manifests.length < 2) return null;
  const paths = changedPathsOf(ws.workspaceRoot, input.git);
  let states = new Map<string, CheckLastState>();
  try {
    const status = await verificationStatus(ws, { taskId: input.taskId, checkIds: [], ...(input.store === undefined ? {} : { store: input.store }), ...(input.git === undefined ? {} : { git: input.git }) });
    states = new Map(status.checks.map((c) => [c.checkId, lastStateOf(c.status)] as const));
  } catch {
    // The usual order: every check reads as not yet run.
  }
  const checks: RelevanceCheck[] = manifests.map((m) => ({ id: m.id, state: states.get(m.id) ?? 'missing', description: m.description ?? null }));
  return rankApprovedChecks({ ctx, workspaceId: ws.workspaceId, checks, paths, taskId: input.taskId, sessionId: input.sessionId ?? null });
}

/**
 * The ranking for a Stop: the mandatory approved checks (the ones the reminder names), each with the
 * state the completion read gave it, against the paths changed in the tree. Null when the work is
 * verified or fewer than two checks are missing: there is nothing to put in order.
 */
export async function rankForStop(
  ctx: RankContext,
  ws: WorkspaceServices,
  input: { readonly completion: CompletionReport; readonly root: string; readonly git?: GitPort; readonly taskId: string | null; readonly sessionId: string | null },
): Promise<CheckRanking | null> {
  const { completion } = input;
  if (completion.verified) return null;
  const missing = new Set(completion.missingEvidence.map((entry) => entry.split(':')[0] ?? entry));
  if (missing.size < 2) return null;
  const descriptions = new Map(approvedManifests(ws).map((m) => [m.id, m.description] as const));
  const checks: RelevanceCheck[] = completion.checks
    .filter((c) => c.mandatory)
    .map((c) => ({ id: c.checkId, state: lastStateOf(c.status), description: descriptions.get(c.checkId) ?? null }));
  return rankApprovedChecks({ ctx, workspaceId: ws.workspaceId, checks, paths: changedPathsOf(input.root, input.git), taskId: input.taskId, sessionId: input.sessionId });
}

/**
 * The missing-evidence entries (`<checkId>:<status>`) in the ranking's order; an entry whose check
 * the ranking does not name keeps its place after the named ones. Every entry is kept.
 */
export function orderMissingEvidence(missingEvidence: readonly string[], order: readonly string[]): string[] {
  const at = new Map(order.map((id, i) => [id, i] as const));
  return missingEvidence
    .map((entry, index) => ({ entry, index, at: at.get(entry.split(':')[0] ?? entry) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((x) => x.entry);
}
