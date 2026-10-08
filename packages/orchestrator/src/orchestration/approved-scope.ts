/**
 * The approved scope of the task a harness session is working on (INT-05, C06): the task's
 * write scopes are the approved paths, and a task declares no effects, so none is approved (a requested effect is out of scope).
 *
 * The sidecar's event op merges it into a hook body as `scope.approvedScope` before the
 * subscribers run, so the scope-change advice compares the harness's diff with the plan, not
 * with anything the harness claims. A session maps to a task through the owned-session record
 * (an owned worker); otherwise, when exactly one task is leased or running in the workspace,
 * that one, for advice only. Anything else is null: no approved scope is invented.
 *
 * OD-8 (owner decisions DOMAINS f294e43): the scope also carries the task's risk class and
 * `turnActuation`, D's gate for switching a Kilo or OpenCode main-session turn. C's route.turn
 * reads both; an absent scope, or anything but `bounded-auto`, means advise. `bounded-auto` needs
 * all of D's conditions:
 * - `routing.mainSession` is `plugin-bounded-auto` (the default; `advice-only` turns it off);
 * - the harness is Kilo or OpenCode (every other main session stays advice-only);
 * - the harness's `session.route` certify case passes (the caller answers it: `turnRouteCertified`);
 * - the session is linked to the task (owner decision 29423b6): its owned-session record (an owned
 *   worker, bound as soon as the harness names the session; the worker's events come from its
 *   worktree, which the sidecar resolves as a workspace of its own, and are read as the task's
 *   workspace through that worktree's record), or B's session link (`sessionLinkFor`,
 *   made by `jevris route --task <id> --link` or by the sidecar for a plan or handoff) for the same
 *   harness, to a task that is leased or running. The owned-session record wins when both exist.
 *   The single-active-task fallback feeds advice only and never switches a turn (SESSION_NOT_LINKED);
 * - the task is low-risk;
 * - the kill switch is not stopped, and no budget in the workspace is exhausted.
 * The 12 local outcomes on the slice are C's route-learning rule, applied on top of this gate.
 */
import { MAIN_SESSION_MODES, TURN_HARNESSES, type MainSessionMode } from '@jevris/contracts';
import { linkSession, sessionLinkFor } from '@jevris/store';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { rootIdentityId, workspaceWithId, type WorkspaceServices } from '../workspace.js';
import { isCertified } from '../hooks/certification.js';
import { readEffectiveConfig } from '../settings/config.js';
import { getTask, listTasks, type TaskRecord } from './tasks.js';
import { keepPlannedLink, ownedSessions, takePlannedLink, type OwnedSessionRecord } from './workers.js';
import { worktreesRoot, type WorktreeRecord } from '../worktree.js';

/** The certify feature a per-turn main-session switch needs (F's session.route case, OD-8). */
export const TURN_ROUTE_FEATURE = 'session.route';

/**
 * The certify feature a route through a serving host needs, or one that changes the session's
 * host (F's route.host case, 99943eb8; serving hosts R50): the route reaches that host, and a
 * project config that redefines the host refuses it. F certifies it only with session.route.
 */
export const HOST_ROUTE_FEATURE = 'route.host';

export type TurnActuation = 'bounded-auto' | 'advise';

export interface ApprovedScope {
  readonly taskId: string;
  readonly paths: readonly string[];
  readonly effects: readonly string[];
  /** The task's rules-only risk class (`low`, `medium`, `high`); absent when the task has none. */
  readonly risk?: string;
  /** `bounded-auto` only when every OD-8 condition above holds; otherwise `advise`. */
  readonly turnActuation: TurnActuation;
  /** Why the turn is advice only (a reason code), or null when it may be switched. */
  readonly turnReasonCode: string | null;
}

export interface ApprovedScopeOptions {
  /** The harness of the event (a HARNESS_IDS name, e.g. `kilocode`); absent or another harness: advise. */
  readonly harness?: string | null;
  readonly killSwitchStopped?: boolean;
  /** Whether the harness's session.route certify case passes (`turnRouteCertified`); default false. */
  readonly turnCertified?: boolean;
  /**
   * Owner decision 2026-10-08 (tiered routing, step 2b): ask the turn gate without its low-risk condition. A turn switched UP
   * by the shared tier rule is for work that is not low risk by definition (a protected path, a migration); every other
   * condition (the mode, the harness, the kill switch, the certification, the link to the task, the budget) still holds.
   * A step down never uses this: it keeps the low-risk condition.
   */
  readonly ignoreRisk?: boolean;
}

const RISK = /^[a-z][a-z-]{0,31}$/;

/** Owner decision 29423b6: a session not started for the task (the single-active-task fallback) never switches a turn. */
export const SESSION_NOT_LINKED = 'SESSION_NOT_LINKED';

/** A harness's main-session mode and whether its turns can be switched at all, before any per-session fact. */
export interface MainSessionView {
  readonly mode: MainSessionMode;
  readonly turnSwitching: 'possible' | 'advice-only';
  /** Why the turns are advice only; null when switching is possible. */
  readonly reasonCode: string | null;
}

/**
 * The per-harness half of D's turn gate (OD-8), pure, for status and explain (E's StatusPayload
 * mainSessions; B's status op calls it per harness, the CLI's local fallback with certified false).
 * `routing.mainSession` is one value; per harness:
 * - Kilo and OpenCode take it, except `owned-sdk-approved`, which is Claude's (they are advice-only then);
 * - Claude Code shows `owned-sdk-approved` when the setting says so, else advice-only;
 * - every other harness is advice-only.
 * Switching is possible only with `plugin-bounded-auto` on Kilo or OpenCode, the kill switch clear
 * and the harness's session.route certification current, checked in that order (the reason codes
 * are the turn gate's). A link, the task's risk and the budget are per turn and not decided here.
 */
export function mainSessionView(configured: unknown, harness: string, facts: { readonly certified: boolean; readonly killSwitchStopped: boolean | undefined }): MainSessionView {
  const advise = (mode: MainSessionMode, reasonCode: string): MainSessionView => ({ mode, turnSwitching: 'advice-only', reasonCode });
  if (!(MAIN_SESSION_MODES as readonly unknown[]).includes(configured)) return advise('advice-only', 'CONFIG_UNREADABLE');
  const setting = configured as MainSessionMode;
  const turnHarness = (TURN_HARNESSES as readonly string[]).includes(harness);
  const mode: MainSessionMode = turnHarness ? (setting === 'owned-sdk-approved' ? 'advice-only' : setting) : harness === 'claude' && setting === 'owned-sdk-approved' ? setting : 'advice-only';
  if (setting !== 'plugin-bounded-auto') return advise(mode, 'MAIN_SESSION_ADVICE_ONLY');
  if (!turnHarness) return advise(mode, 'HARNESS_ADVICE_ONLY');
  if (facts.killSwitchStopped !== false) return advise(mode, 'KILL_SWITCH');
  if (facts.certified !== true) return advise(mode, 'TURN_ROUTE_UNCERTIFIED');
  return { mode, turnSwitching: 'possible', reasonCode: null };
}

function turnGate(ws: WorkspaceServices, task: TaskRecord, options: ApprovedScopeOptions, linked: boolean): string | null {
  let configured: unknown;
  try {
    configured = readEffectiveConfig({ home: ws.home, workspaceRoot: ws.workspaceRoot }).config.routing.mainSession;
  } catch {
    return 'CONFIG_UNREADABLE';
  }
  const view = mainSessionView(configured, options.harness ?? '', { certified: options.turnCertified === true, killSwitchStopped: options.killSwitchStopped });
  if (view.reasonCode !== null) return view.reasonCode;
  if (!linked) return SESSION_NOT_LINKED;
  if (options.ignoreRisk !== true && task.risk !== 'low') return 'RISK_NOT_LOW';
  const exhausted = ws.state.list<{ readonly workspaceId?: string; readonly open?: boolean }>('budget-exhaustions').some((r) => r.workspaceId === ws.workspaceId && r.open === true);
  if (exhausted) return 'BUDGET_EXHAUSTED';
  return null;
}

function scopeOf(ws: WorkspaceServices, task: TaskRecord, options: ApprovedScopeOptions, linked: boolean): ApprovedScope {
  const reason = turnGate(ws, task, options, linked);
  return {
    taskId: task.node.id,
    paths: task.node.writeScopes.slice(0, 64),
    effects: [],
    ...(typeof task.risk === 'string' && RISK.test(task.risk) && task.risk !== 'unknown' ? { risk: task.risk } : {}),
    turnActuation: reason === null ? 'bounded-auto' : 'advise',
    turnReasonCode: reason,
  };
}

/** A task and the workspace it belongs to. */
export interface SessionTask {
  readonly ws: WorkspaceServices;
  readonly task: TaskRecord;
}

function real(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The task whose owned worktree this workspace is. An owned worker runs in its own git worktree,
 * which the sidecar resolves as a workspace of its own, so the worker's hook events arrive under
 * the worktree's id, not the task's. Only a worktree still in use counts, and only when its path
 * is this workspace's root.
 */
function worktreeTask(ws: WorkspaceServices): { readonly workspaceId: string; readonly taskId: string; readonly worktreeId: string } | undefined {
  const root = real(ws.workspaceRoot);
  if (root === null) return undefined;
  const tree = ws.host.list<WorktreeRecord>('worktrees').find((w) => w.state !== 'removed' && w.workspaceId !== ws.workspaceId && real(w.path) === root);
  return tree === undefined ? undefined : { workspaceId: tree.workspaceId, taskId: tree.taskId, worktreeId: tree.id };
}

function strictlyInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/** An owned-worker worktree of a workspace and the workspace id its hook events arrive under. */
export interface OwnedWorktreeWorkspace {
  readonly worktreeId: string;
  readonly taskId: string;
  readonly workspaceId: string;
}

/** The most worktrees `ownedWorktreeWorkspaces` returns (status shows at most 16 links). */
export const OWNED_WORKTREE_WORKSPACES_MAX = 16;

/**
 * This workspace's owned-worker worktrees still in use (not removed, path still resolving), newest
 * first, each with the id the sidecar gives its root (rootIdentityId, IPC-09). A worker's session
 * link is written under that id, not this workspace's, so status reads each worktree's view for
 * the links of its own task (B's status op). Only a worktree whose real path is still inside this
 * workspace's worktree directory counts, so a record whose path now resolves elsewhere (replaced
 * by a link) never opens another workspace's view, and only for a task of this workspace. Pure
 * and synchronous: realpath and local reads, no git, and an error skips that worktree.
 */
export function ownedWorktreeWorkspaces(ws: WorkspaceServices): readonly OwnedWorktreeWorkspace[] {
  const out: OwnedWorktreeWorkspace[] = [];
  const base = real(worktreesRoot(ws));
  if (base === null) return out;
  const trees = ws.host
    .list<WorktreeRecord>('worktrees')
    .filter((w) => w.workspaceId === ws.workspaceId && w.state !== 'removed')
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  for (const tree of trees) {
    if (out.length >= OWNED_WORKTREE_WORKSPACES_MAX) break;
    try {
      const root = real(tree.path);
      if (root === null || !strictlyInside(base, root)) continue;
      const workspaceId = rootIdentityId(root);
      if (workspaceId === undefined || workspaceId === ws.workspaceId) continue;
      if (getTask(ws, tree.taskId) === undefined) continue;
      out.push({ worktreeId: tree.id, taskId: tree.taskId, workspaceId });
    } catch {
      // Status is on the hot path: an unreadable worktree is skipped.
    }
  }
  return out;
}

function taskIn(ws: WorkspaceServices, taskId: string): SessionTask | undefined {
  const task = getTask(ws, taskId);
  return task === undefined ? undefined : { ws, task };
}

/**
 * The task an owned worker's session works on (owner decision 29423b6: a session a plan started
 * for its task), through its owned-session record: in this workspace, or, for an event from the
 * worker's own worktree, in the task's workspace when the record names that worktree.
 */
export function ownedSessionTask(ws: WorkspaceServices, sessionId: string): SessionTask | undefined {
  const here = ownedSessions(ws).find((s) => s.sessionId === sessionId);
  if (here !== undefined) return taskIn(ws, here.taskId);
  const tree = worktreeTask(ws);
  if (tree === undefined) return undefined;
  const session = ws.host.list<OwnedSessionRecord>('owned-sessions').find((s) => s.sessionId === sessionId && s.workspaceId === tree.workspaceId);
  if (session === undefined || session.taskId !== tree.taskId || session.worktreeId !== tree.worktreeId) return undefined;
  return taskIn(workspaceWithId(ws, tree.workspaceId), session.taskId);
}

/**
 * The leased or running task B's session link names for this session on this harness, if any:
 * in this workspace, or, from an owned worktree, its own task in the task's workspace.
 */
function linkedTask(ws: WorkspaceServices, sessionId: string, harness: string | null): SessionTask | undefined {
  if (harness === null) return undefined;
  const link = sessionLinkFor(ws.store, sessionId);
  if (link === undefined || link.harness !== harness) return undefined;
  let found = taskIn(ws, link.taskId);
  if (found === undefined) {
    const tree = worktreeTask(ws);
    if (tree !== undefined && tree.taskId === link.taskId) found = taskIn(workspaceWithId(ws, tree.workspaceId), link.taskId);
  }
  return found !== undefined && active(found.task) ? found : undefined;
}

function active(task: TaskRecord): boolean {
  return task.node.state === 'leased' || task.node.state === 'running';
}

export function approvedScopeFor(ws: WorkspaceServices, sessionId: string | null, options: ApprovedScopeOptions = {}): ApprovedScope | null {
  if (sessionId !== null) {
    // The owned session's task still feeds advice after its run; only a leased or running task's
    // session is linked for a turn switch, as with B's link.
    const owned = ownedSessionTask(ws, sessionId);
    if (owned !== undefined) return scopeOf(owned.ws, owned.task, options, active(owned.task));
    const linked = linkedTask(ws, sessionId, options.harness ?? null);
    if (linked !== undefined) return scopeOf(linked.ws, linked.task, options, true);
  }
  // Not linked: the one active task's scope still feeds advice, but never a turn switch (29423b6).
  const open = listTasks(ws, { states: ['leased', 'running'] });
  return open.length === 1 && open[0] !== undefined ? scopeOf(ws, open[0], options, false) : null;
}

/**
 * The plan link (owner decision 29423b6): a Kilo or OpenCode session an owned worker started for
 * its task is linked to that task in B's store (via `plan`, by the sidecar, audited), on the
 * first event of the session the sidecar sees, after it recorded the session. Only while the owned
 * session still runs on the lease that bound it, and only to a task that is leased or running. A
 * session a person already linked to another task is left as it is (never replaced). The link is
 * made where the sidecar recorded the session: the worker's worktree workspace. Returns the
 * outcome code, or null when this event has no plan link waiting. Never throws.
 */
export function linkPlannedSession(ws: WorkspaceServices, event: { readonly harness: string; readonly sessionId: string | null; readonly agentId: string | null }, nowMs: number): string | null {
  if (event.sessionId === null || event.agentId !== null) return null;
  const sessionId = event.sessionId;
  const pending = takePlannedLink(sessionId, event.harness);
  if (pending === undefined) return null;
  try {
    if (ws.store === undefined) return 'NO_STORE';
    const owned = ownedSessionTask(ws, sessionId);
    if (owned === undefined || owned.ws.workspaceId !== pending.workspaceId || owned.task.node.id !== pending.taskId) return 'NOT_OWNED';
    const record = owned.ws.host.list<OwnedSessionRecord>('owned-sessions').find((s) => s.workspaceId === pending.workspaceId && s.taskId === pending.taskId);
    if (record === undefined || record.state !== 'running' || record.leaseId !== pending.leaseId || record.sessionId !== sessionId) return 'NOT_RUNNING';
    if (!active(owned.task)) return 'TASK_NOT_ACTIVE';
    const linked = linkSession(ws.store, { sessionId, harness: event.harness, taskId: pending.taskId, via: 'plan', actor: 'sidecar', channel: 'sidecar', atMs: nowMs });
    if (linked.ok) return linked.result === 'linked' ? 'LINKED' : 'ALREADY_LINKED';
    if ('refusal' in linked) {
      // Recorded after this event's subscribers ran: tried again on the session's next event.
      if (linked.refusal === 'unknown-session') keepPlannedLink(sessionId, pending);
      return linked.refusal === 'session-already-linked' ? 'LINKED_BY_PERSON' : linked.refusal.toUpperCase().replace(/-/g, '_');
    }
    return 'STORE_REFUSED';
  } catch {
    return 'LINK_FAILED';
  }
}

type RouteCertificationInput = { readonly home: string; readonly harness: string; readonly nowMs: number; readonly harnessVersion?: string | null };

async function routeFeatureCertified(input: RouteCertificationInput, featureId: string): Promise<boolean> {
  if (!(TURN_HARNESSES as readonly string[]).includes(input.harness)) return false;
  const answer = await isCertified({
    home: input.home,
    harness: input.harness as (typeof TURN_HARNESSES)[number],
    featureId,
    nowMs: input.nowMs,
    ...(input.harnessVersion === undefined ? {} : { harnessVersion: input.harnessVersion }),
  });
  return answer.certified;
}

/** Whether the harness's session.route certify case covers its installed version, this OS and now (OD-8). Never throws. */
export async function turnRouteCertified(input: RouteCertificationInput): Promise<boolean> {
  return routeFeatureCertified(input, TURN_ROUTE_FEATURE);
}

/**
 * Whether the harness's route.host certify case covers its installed version, this OS and now
 * (serving hosts R50): a route through a host, or one that changes the session's host, actuates
 * only when this is true. Kilo and OpenCode only; never throws.
 */
export async function hostRouteCertified(input: RouteCertificationInput): Promise<boolean> {
  return routeFeatureCertified(input, HOST_ROUTE_FEATURE);
}
