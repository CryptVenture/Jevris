/**
 * Automatic resume after an access limit (R76; design `.planning/research/access-limits.md`
 * sections 9.3 and 7.4). B's 60 s tick in the sidecar calls `resumeAccessBlocked` for each open
 * workspace.
 *
 * A task that an access limit or an overload blocked (an `access-blocked` row, R70) goes back to
 * ready once, and owned work continues, when all of these hold:
 * - the kill switch is clear, orchestration is on and managed workers are `bounded-auto`;
 * - the row allows it (`autoResume`: not a repeat after an automatic resume, and not an overload
 *   whose retries are used up) and has not been resumed;
 * - its wait is over: the pause ended (`untilMs` passed), or it was cleared (by a person, by a
 *   success, or by a new key for the task's harness), or, for an overload, its retry time came;
 * - no pause now covers the task's model on the harness and sign-in it ran on;
 * - the task is still blocked with the reason its row stands for;
 * - its plan approval still stands: every acceptance check of the task is still approved.
 * The row is marked resumed before the task moves, so a crash between the two never resumes it
 * twice (OP-5: once per episode; a limit again waits for a person). The scheduler's reservation
 * applies the budget as for any lease (W09).
 */
import { modeAllows, type SidecarOpContext } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, accessPauseFor, loadModelRegistry, readAccessLimits, type AccessLimitEntry } from '@jevris/core';
import type { WorkspaceServices } from '../workspace.js';
import { readEffectiveConfig } from '../settings/config.js';
import { getTask, taskTransition } from '../orchestration/tasks.js';
import { ACCESS_BLOCKED_COLLECTION, launchFingerprint, runAccessScope, type AccessBlockedRow } from '../orchestration/access-limits.js';
import { approvedManifests } from '../verify/service.js';
import { recordKey } from '../util.js';
import { continueOwnedWork } from './task-ops.js';

/** The reason a resumed task carries back to ready (design 11). */
export const ACCESS_LIMIT_RESET = 'ACCESS_LIMIT_RESET';

export interface ResumeAccessResult {
  /** The tasks moved back to ready. */
  readonly resumed: readonly string[];
  /** Why no row was looked at (KILL_SWITCH, NOT_BOUNDED_AUTO, ACCESS_LIMITS_UNREADABLE), else OK. */
  readonly reasonCode: 'OK' | 'KILL_SWITCH' | 'NOT_BOUNDED_AUTO' | 'ACCESS_LIMITS_UNREADABLE';
}

export interface ResumeAccessOptions {
  /** Test seam; production continues owned work through task-ops. */
  readonly continueWork?: (ctx: SidecarOpContext, ws: WorkspaceServices) => Promise<unknown>;
  /** Where the key the next launch would use is read, to see a new key (design 4.4); default the process's. */
  readonly env?: { readonly [key: string]: string | undefined };
}

/**
 * Whether a row's wait is over at `nowMs`, given the record's entries: its time has passed, or
 * (a limit, not an overload) its entry is gone from the record. A new key is checked by the
 * caller, which knows the scope.
 */
export function accessWaitOver(row: AccessBlockedRow, entries: readonly AccessLimitEntry[], nowMs: number): boolean {
  if (row.untilMs !== null && row.untilMs <= nowMs) return true;
  return row.class !== 'overloaded' && row.scopeKey !== null && !entries.some((e) => e.key === row.scopeKey);
}

/** The state reason a row stands for: an overload blocks with PROVIDER_OVERLOADED, a limit with ACCESS_LIMITED. */
function blockedWith(row: AccessBlockedRow, reason: string | null | undefined): boolean {
  return (reason ?? '').startsWith(row.class === 'overloaded' ? 'PROVIDER_OVERLOADED:' : 'ACCESS_LIMITED:');
}

function unreadable(ctx: SidecarOpContext): ResumeAccessResult {
  ctx.trace({ event: 'orchestrator.access-resume-skipped', reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
  return { resumed: [], reasonCode: 'ACCESS_LIMITS_UNREADABLE' };
}

/**
 * Moves each due access-blocked task of the workspace back to ready, once, and continues owned work (R76).
 * `ctx` is the sidecar's own op context: `continueOwnedWork` reads its home, engine, kill switch
 * and trace.
 */
export async function resumeAccessBlocked(ctx: SidecarOpContext, ws: WorkspaceServices, nowMs: number, options: ResumeAccessOptions = {}): Promise<ResumeAccessResult> {
  if (ctx.killSwitchStopped === true) return { resumed: [], reasonCode: 'KILL_SWITCH' };
  const config = readEffectiveConfig({ home: ws.home, workspaceRoot: ws.workspaceRoot }).config;
  if (!config.orchestration.enabled || !modeAllows(config.routing.managedWorkers, 'actuate')) return { resumed: [], reasonCode: 'NOT_BOUNDED_AUTO' };
  const rows = ws.host.list<AccessBlockedRow>(ACCESS_BLOCKED_COLLECTION).filter((r) => r.workspaceId === ws.workspaceId && !r.resumed && r.autoResume);
  if (rows.length === 0) return { resumed: [], reasonCode: 'OK' };
  // A record that cannot be read resumes nothing (B's MEDIUM 40): core reads a damaged file as
  // no entries, which here would look like every pause cleared. The next tick tries again.
  let entries: readonly AccessLimitEntry[];
  try {
    const read = await readAccessLimits(ws.home);
    if (!read.readable) return unreadable(ctx);
    entries = read.entries;
  } catch {
    return unreadable(ctx);
  }
  const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const approved = new Set(approvedManifests(ws).map((m) => m.id));
  const env = options.env ?? process.env;
  const resumed: string[] = [];
  for (const row of rows) {
    const scope = row.harness !== undefined && row.model !== undefined ? runAccessScope(registry, row.harness, row.model, row.authMode ?? 'unknown', null, row.servingHost) : null;
    // With the key the next launch would use: an untimed pause recorded with another key no
    // longer covers the task (the launch clears it, FINGERPRINT).
    const fingerprint = scope === null || row.harness === undefined ? null : launchFingerprint(row.harness, row.authMode ?? 'unknown', env, scope.servingHost);
    const pause = scope === null ? null : accessPauseFor(entries, scope, nowMs, { fingerprint });
    const newKey = row.class !== 'overloaded' && scope !== null && fingerprint !== null && pause === null;
    if (!accessWaitOver(row, entries, nowMs) && !newKey) continue;
    // Another pause on the scope the task would run in keeps it blocked, the row left for later.
    if (pause !== null) continue;
    const task = getTask(ws, row.taskId);
    if (task === undefined || task.node.state !== 'blocked' || !blockedWith(row, task.stateReason)) continue;
    // A check approval revoked since the plan was approved leaves the task for a person.
    if (!task.node.acceptanceCheckIds.every((id) => approved.has(id))) continue;
    const key = recordKey(ws.workspaceId, row.taskId);
    let marked = false;
    await ws.host.transact((tx) => {
      const current = tx.get<AccessBlockedRow>(ACCESS_BLOCKED_COLLECTION, key);
      if (current === undefined || current.resumed || current.blockedAtMs !== row.blockedAtMs) return;
      tx.put(ACCESS_BLOCKED_COLLECTION, key, { ...current, resumed: true, resumedAtMs: nowMs });
      marked = true;
    });
    if (!marked) continue;
    const back = taskTransition(ws, row.taskId, 'ready', ACCESS_LIMIT_RESET, { actor: 'scheduler', nowMs });
    // A move that fails leaves the task blocked for a person; the row stays resumed (OP-5).
    if (back.ok) resumed.push(row.taskId);
    else ctx.trace({ event: 'orchestrator.access-resume-skipped', reasonCode: back.reasonCode });
  }
  if (resumed.length > 0) {
    ctx.trace({ event: 'orchestrator.access-resumed', reasonCode: ACCESS_LIMIT_RESET });
    await (options.continueWork ?? continueOwnedWork)(ctx, ws);
  }
  return { resumed, reasonCode: 'OK' };
}
