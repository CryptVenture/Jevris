/**
 * Background verification at Stop (owner decision 2026-09-30, `verification.backgroundAtStop`).
 *
 * It is an opt-in actuation, off unless a person turned it on in their own settings, that extends
 * the Stop behaviour of the spec ("a Stop only requests missing evidence"): a main-session Stop
 * that finds mandatory approved checks missing or stale queues them in the background, through the
 * same scheduler as `jevris verify`, so the next Stop or session finds the receipts. It never
 * blocks or waits for a run, and it changes no receipt: the runner alone records results, under
 * the same independence and freshness rules.
 */
import { modeAllows, type SidecarOpContext } from '@jevris/contracts';
import { applyCheckOrder } from '@jevris/core';
import type { GitPort } from '../verify/revision.js';
import type { CompletionReport } from '../verify/completion.js';
import { scheduleVerification, verificationRunKey, pendingChecks } from '../verify/runs.js';
import { runVerification } from '../verify/service.js';
import { backgroundAtStopOf, readEffectiveConfig } from '../settings/config.js';
import type { WorkspaceServices } from '../workspace.js';

/** Why nothing was queued (content-free; a trace field, never shown to the person). */
export type StopQueueReason =
  | 'SETTING_OFF'
  | 'NOT_MAIN_SESSION'
  | 'TASK_SCOPED'
  | 'MODE_DOES_NOT_ACTUATE'
  | 'KILL_SWITCH'
  | 'NOTHING_MISSING'
  | 'ALREADY_PENDING'
  | 'ALREADY_TRIED'
  | 'QUEUED';

export interface StopQueueResult {
  readonly reason: StopQueueReason;
  /** The check ids handed to the scheduler (empty unless `reason` is QUEUED). */
  readonly queued: readonly string[];
}

/**
 * The input revision a background run was last launched at, per workspace and check. A run that
 * leaves no receipt at all (it was refused, or it died) is not launched again for the same
 * revision, so a Stop never loops on it. A receipt of any outcome already keeps a check from
 * being a candidate: only `missing` and `stale` are (a failing receipt at this revision is
 * `failed`, and a new revision makes it `stale` again). Held in memory: a sidecar restart loses
 * it together with the queued run.
 */
const launchedAt = new Map<string, string>();
const LAUNCHED_MAX = 512;

/** Test seam: forgets the launches, so a test starts clean. */
export function resetStopAutoVerifyState(): void {
  launchedAt.clear();
}

const launchKey = (workspaceId: string, checkId: string): string => `${workspaceId}\0${checkId}`;

export interface StopQueueInput {
  readonly ctx: SidecarOpContext;
  readonly ws: WorkspaceServices;
  /** The envelope's agent id: null for the main session. */
  readonly agentId: string | null;
  /** True when the session has an approved task scope (an owned worker session): it is not queued for. */
  readonly taskScoped: boolean;
  readonly completion: CompletionReport;
  readonly git?: GitPort;
  /** The check ranking's order (most relevant first): the queued checks run in it. Order only: the same checks run. */
  readonly order?: readonly string[];
}

/**
 * Queues the mandatory approved checks the Stop found missing or stale. It returns at once: the
 * run is not awaited, and a failure of the run never reaches the Stop answer.
 */
export async function queueMissingChecksAtStop(input: StopQueueInput): Promise<StopQueueResult> {
  const { ctx, ws, completion } = input;
  const none = (reason: StopQueueReason): StopQueueResult => ({ reason, queued: [] });
  // A subagent's Stop is a `worker.finished` (every adapter's subagentScope), so this is the
  // main session's; the agent id is checked as well, so a wrongly mapped event cannot queue.
  if (input.agentId !== null) return none('NOT_MAIN_SESSION');
  if (input.taskScoped) return none('TASK_SCOPED');
  let effective;
  try {
    effective = readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config;
  } catch {
    return none('SETTING_OFF');
  }
  if (backgroundAtStopOf(effective) !== 'on') return none('SETTING_OFF');
  // Jevris must be on and allowed to act (bounded-auto): the file's mode under the workspace and
  // administrator ceilings, and the mode the sidecar resolved for this request.
  if (!modeAllows(effective.mode, 'actuate') || (ctx.mode !== undefined && !modeAllows(ctx.mode, 'actuate'))) return none('MODE_DOES_NOT_ACTUATE');
  const stopped = ctx.killSwitchStopped || (ctx.killSwitchNow === undefined ? false : await ctx.killSwitchNow().catch(() => true));
  if (stopped) return none('KILL_SWITCH');
  const missing = completion.checks.filter((c) => c.mandatory && (c.status === 'missing' || c.status === 'stale')).map((c) => c.checkId);
  if (missing.length === 0) return none('NOTHING_MISSING');
  const waiting = pendingChecks(ws.workspaceId, missing);
  const open = missing.filter((id) => !waiting.has(id));
  if (open.length === 0) return none('ALREADY_PENDING');
  const fresh = applyCheckOrder(
    open.filter((id) => launchedAt.get(launchKey(ws.workspaceId, id)) !== completion.revision),
    (id) => id,
    input.order,
  );
  if (fresh.length === 0) return none('ALREADY_TRIED');
  for (const id of fresh) {
    if (launchedAt.size >= LAUNCHED_MAX) launchedAt.delete(launchedAt.keys().next().value as string);
    launchedAt.set(launchKey(ws.workspaceId, id), completion.revision);
  }
  const store = ws.store;
  const run = scheduleVerification(
    verificationRunKey(ws.workspaceId, null),
    fresh,
    (ids) => runVerification(ws, { taskId: null, checkIds: ids, origin: 'stop-background', ...(input.order === undefined ? {} : { order: input.order }), ...(store === undefined ? {} : { store }), ...(input.git === undefined ? {} : { git: input.git }) }),
    () => ctx.trace({ event: 'orchestrator.verify-started', reasonCode: 'STOP_BACKGROUND' }),
  );
  // The run outlives this Stop; nothing here waits for it.
  void run.catch(() => undefined);
  ctx.trace({ event: 'orchestrator.verify-queued-at-stop', reasonCode: 'STOP_BACKGROUND', checks: fresh.length });
  return { reason: 'QUEUED', queued: fresh };
}
