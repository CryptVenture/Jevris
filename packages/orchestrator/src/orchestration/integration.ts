/**
 * Controlled integration (ORC-07, SSOT §10.3, W04, D06, E29).
 *
 * `runIntegration` takes verified owned tasks and prepares their combined change without
 * touching the user's checkout:
 *
 * 1. Every task must be `verified` and have a live worktree. Each task's base commit must be
 *    an ancestor of the expected base, which is the main checkout's HEAD now.
 * 2. Each task's result becomes one commit object: its worktree (commits, staged, unstaged and
 *    untracked files) is snapshotted through a private index. The task worktree's index,
 *    HEAD and files are never changed.
 * 3. A fresh integration worktree is created at the expected base. Each task is squash-merged
 *    there (a three-way merge from the task's own base) and committed. A conflicting task is
 *    reported with its conflicting paths and rolled back, and the others continue.
 * 4. With no conflicts, the mandatory shared checks (the union of the tasks' acceptance checks
 *    and requirements) run in the integration worktree, and receipts come from the runner.
 * 5. The review advice for the combined change, measured from the expected base: review areas
 *    by ownership and sensitive paths (C44, VER-12) and whether it needs a qualified security
 *    review (C47, VER-14). Advice only: mandatory reviewers stay, and a negative answer
 *    certifies nothing.
 * 6. The readiness report is stored (state 'integrations').
 *
 * `startIntegration` is how the sidecar runs it: steps 1 to 6 take as long as the tasks' git work
 * and the project's own checks take, which no fixed request budget bounds (W04 took over 5 s on a
 * Windows runner with three small tasks). It stores a `running` report at once and runs the
 * integration after any other one of the same workspace, so the op can answer with the running
 * report and the CLI follows it with `integration.get`. A `running` report whose run is not in
 * this process (the sidecar stopped during it) reads as `blocked` with INTERRUPTED.
 *
 * `approveIntegration` is the explicit user approval (CLI only). It merges only a `ready`
 * report, only with --ff-only into a main checkout that is still at the expected base, has no
 * tracked changes, and whose integration branch still points at the reported commit. Nothing
 * is pushed. The worktrees are kept; removal stays a separate confirmed action.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { WorkspaceServices } from '../workspace.js';
import { openWorkspace } from '../workspace.js';
import { nodeGit, type GitPort } from '../verify/revision.js';
import { runVerification } from '../verify/service.js';
import { createWorktree, getWorktree, listWorktrees, DEFAULT_GIT_TIMEOUT_MS, type WorktreeRecord } from '../worktree.js';
import { getTask } from './tasks.js';
import { recordKey, redactSecrets, safeText } from '../util.js';
import { adviseCapability } from '../capabilities/registry.js';
import type { CapabilityAdvice } from '../capabilities/advice.js';

export const INTEGRATION_MAX_TASKS = 32;
const COMMIT = /^[0-9a-f]{40,64}$/;
/** Used only when the repository has no configured identity. */
const FALLBACK_IDENTITY = ['-c', 'user.name=Jevris', '-c', 'user.email=jevris@localhost.invalid'] as const;

export type IntegrationState = 'running' | 'blocked' | 'conflicts' | 'checks-failed' | 'ready' | 'merged';

export interface IntegrationTaskResult {
  readonly taskId: string;
  readonly outcome: 'applied' | 'conflict' | 'git-error' | 'empty' | 'not-verified' | 'no-worktree' | 'base-not-ancestor' | 'unreadable';
  readonly baseCommit: string | null;
  readonly paths: readonly string[];
  readonly conflictPaths: readonly string[];
  /** For `git-error`: git's own message (bounded, secrets redacted). A git failure is never reported as a conflict. */
  readonly error?: string;
  /** For `applied`: the commit that integrated the task (its squash), so a later `git revert` of it is recognised. */
  readonly integratedCommit?: string;
}

export interface IntegrationReport {
  readonly schemaVersion: 'jevris-integration-1';
  readonly id: string;
  readonly workspaceId: string;
  readonly taskIds: readonly string[];
  readonly state: IntegrationState;
  readonly reasonCode: string;
  /** The main checkout's HEAD the integration was prepared on. */
  readonly baseCommit: string | null;
  readonly branch: string | null;
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
  /** The integration branch tip that approval merges. */
  readonly integrationCommit: string | null;
  readonly tasks: readonly IntegrationTaskResult[];
  readonly checks: {
    readonly verified: boolean;
    readonly mandatoryCheckIds: readonly string[];
    readonly failing: readonly string[];
    readonly missingEvidence: readonly string[];
  } | null;
  /** C44 review areas and C47 security escalation for the combined change (advice only). */
  readonly review: { readonly areas: CapabilityAdvice | null; readonly security: CapabilityAdvice | null } | null;
  /** When the shared checks fail: C42 failure clusters ranked by likely shared cause (advice only). */
  readonly triage: CapabilityAdvice | null;
  readonly createdAtMs: number;
  readonly approvedBy: string | null;
  readonly approvedAtMs: number | null;
  readonly mergedCommit: string | null;
}

export interface IntegrationOptions {
  readonly git?: GitPort;
  readonly nowMs?: number;
  readonly signal?: AbortSignal;
  /** For the review advice: C's engine (advice only) and whether source egress is approved. */
  readonly engine?: unknown;
  readonly egressApproved?: boolean;
  /** The id to use (startIntegration's, whose running report it replaces); a new one otherwise. */
  readonly id?: string;
}

function gitFor(options: IntegrationOptions, env: { readonly [key: string]: string } = {}): GitPort {
  return options.git ?? nodeGit(DEFAULT_GIT_TIMEOUT_MS, env);
}

function lines(text: string): readonly string[] {
  return text.split('\0').flatMap((l) => l.split('\n')).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Git's own message for a failed command: bounded, one line per line, secrets redacted. */
function gitMessage(result: { readonly stdout: string; readonly stderr?: string }): string {
  const text = (result.stderr ?? '').trim() || result.stdout.trim() || 'git failed without a message';
  return safeText(redactSecrets(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).join(' | ')), 500);
}

async function identity(git: GitPort, cwd: string): Promise<readonly string[]> {
  const email = await git.run(['config', 'user.email'], cwd);
  const name = await git.run(['config', 'user.name'], cwd);
  return email.ok && email.stdout.trim() !== '' && name.ok && name.stdout.trim() !== '' ? [] : [...FALLBACK_IDENTITY];
}

export function integrationKey(ws: WorkspaceServices, id: string): string {
  return recordKey(ws.workspaceId, id);
}

/** The integrations this process is running, by integrationKey. */
const inFlight = new Set<string>();
/** Each workspace's latest integration run: the next one starts after it. */
const chains = new Map<string, Promise<unknown>>();

/** A `running` report whose run is not in this process was interrupted (the sidecar stopped). */
function current(ws: WorkspaceServices, row: IntegrationReport): IntegrationReport {
  return row.state === 'running' && !inFlight.has(integrationKey(ws, row.id)) ? { ...row, state: 'blocked', reasonCode: 'INTERRUPTED' } : row;
}

export function getIntegration(ws: WorkspaceServices, id: string): IntegrationReport | undefined {
  const row = ws.state.get<IntegrationReport>('integrations', integrationKey(ws, id));
  return row !== undefined && row.workspaceId === ws.workspaceId ? current(ws, row) : undefined;
}

export function listIntegrations(ws: WorkspaceServices): readonly IntegrationReport[] {
  return ws.state.list<IntegrationReport>('integrations').filter((r) => r.workspaceId === ws.workspaceId).map((r) => current(ws, r));
}

/** Resolves when every integration this process started has ended (tests, shutdown). */
export async function drainIntegrations(): Promise<void> {
  while (chains.size > 0) await Promise.allSettled([...chains.values()]);
}

async function store(ws: WorkspaceServices, report: IntegrationReport): Promise<IntegrationReport> {
  await ws.state.transact((tx) => tx.put('integrations', integrationKey(ws, report.id), report));
  return report;
}

function liveTree(ws: WorkspaceServices, taskId: string): WorktreeRecord | undefined {
  return listWorktrees(ws)
    .filter((t) => t.taskId === taskId && t.state !== 'removed' && existsSync(t.path))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
}

/** The task worktree's full result as one commit object, through a private index. */
async function snapshotCommit(ws: WorkspaceServices, tree: WorktreeRecord, options: IntegrationOptions): Promise<string | null> {
  const scratch = join(ws.dataDir, 'integrations', ws.workspaceId);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const indexFile = join(scratch, `index-${randomBytes(6).toString('hex')}`);
  const git = gitFor(options, { GIT_INDEX_FILE: indexFile });
  try {
    if (!(await git.run(['read-tree', 'HEAD'], tree.path)).ok) return null;
    if (!(await git.run(['add', '-A', '--', '.'], tree.path)).ok) return null;
    const written = await git.run(['write-tree'], tree.path);
    const head = await git.run(['rev-parse', 'HEAD'], tree.path);
    if (!written.ok || !head.ok) return null;
    const commit = await git.run([...(await identity(git, tree.path)), 'commit-tree', written.stdout.trim(), '-p', head.stdout.trim(), '-m', `jevris: result of task ${tree.taskId}`], tree.path);
    const id = commit.stdout.trim();
    return commit.ok && COMMIT.test(id) ? id : null;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function newIntegrationId(): string {
  return `int-${randomBytes(6).toString('hex')}`;
}

function reportBase(ws: WorkspaceServices, id: string, taskIds: readonly string[], nowMs: number): Omit<IntegrationReport, 'state' | 'reasonCode' | 'tasks'> {
  return {
    schemaVersion: 'jevris-integration-1',
    id,
    workspaceId: ws.workspaceId,
    taskIds,
    baseCommit: null,
    branch: null,
    worktreeId: null,
    worktreePath: null,
    integrationCommit: null,
    checks: null,
    review: null,
    triage: null,
    createdAtMs: nowMs,
    approvedBy: null,
    approvedAtMs: null,
    mergedCommit: null,
  };
}

/**
 * Starts an integration: its `running` report is stored before this resolves, and `done` gives
 * the final report. It runs after the workspace's previous integration, never beside it. A run
 * that throws ends `blocked` with INTERNAL, so no report stays running.
 */
export async function startIntegration(
  ws: WorkspaceServices,
  taskIds: readonly string[],
  options: Omit<IntegrationOptions, 'id'> = {},
): Promise<{ readonly running: IntegrationReport; readonly done: Promise<IntegrationReport> }> {
  const nowMs = options.nowMs ?? Date.now();
  const id = newIntegrationId();
  const unique = [...new Set(taskIds)].slice(0, INTEGRATION_MAX_TASKS);
  const key = integrationKey(ws, id);
  inFlight.add(key);
  let running: IntegrationReport;
  try {
    running = await store(ws, { ...reportBase(ws, id, unique, nowMs), state: 'running', reasonCode: 'RUNNING', tasks: [] });
  } catch (error) {
    inFlight.delete(key);
    throw error;
  }
  const previous = chains.get(ws.workspaceId) ?? Promise.resolve();
  const done: Promise<IntegrationReport> = previous
    .then(() => runIntegration(ws, unique, { ...options, nowMs, id }))
    .catch(() => store(ws, { ...running, state: 'blocked', reasonCode: 'INTERNAL' }))
    .finally(() => {
      inFlight.delete(key);
      if (chains.get(ws.workspaceId) === settled) chains.delete(ws.workspaceId);
    });
  const settled = done.then(() => undefined, () => undefined);
  chains.set(ws.workspaceId, settled);
  return { running, done };
}

/** Prepares the integration of verified owned tasks and stores its readiness report. */
export async function runIntegration(ws: WorkspaceServices, taskIds: readonly string[], options: IntegrationOptions = {}): Promise<IntegrationReport> {
  const git = gitFor(options);
  const nowMs = options.nowMs ?? Date.now();
  const id = options.id ?? newIntegrationId();
  const unique = [...new Set(taskIds)].slice(0, INTEGRATION_MAX_TASKS);
  const base = reportBase(ws, id, unique, nowMs);
  const head = await git.run(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], ws.workspaceRoot);
  const expected = head.stdout.trim();
  if (!head.ok || !COMMIT.test(expected)) return store(ws, { ...base, state: 'blocked', reasonCode: 'NOT_A_REPOSITORY', tasks: [] });
  // 1. Completion, worktree, expected base and ancestry for every task.
  const results: IntegrationTaskResult[] = [];
  const commits = new Map<string, string>();
  for (const taskId of unique) {
    const task = getTask(ws, taskId);
    const tree = liveTree(ws, taskId);
    const row = (outcome: IntegrationTaskResult['outcome'], paths: readonly string[] = []): IntegrationTaskResult => ({ taskId, outcome, baseCommit: tree?.baseCommit ?? null, paths, conflictPaths: [] });
    if (task === undefined || task.node.state !== 'verified') results.push(row('not-verified'));
    else if (tree === undefined) results.push(row('no-worktree'));
    else if (!(await git.run(['merge-base', '--is-ancestor', tree.baseCommit, expected], ws.workspaceRoot)).ok) results.push(row('base-not-ancestor'));
    else {
      const commit = await snapshotCommit(ws, tree, options);
      if (commit === null) {
        results.push(row('unreadable'));
        continue;
      }
      const changed = await git.run(['diff', '--name-only', '-z', tree.baseCommit, commit], tree.path);
      const paths = changed.ok ? lines(changed.stdout) : [];
      if (!changed.ok) results.push(row('unreadable'));
      else if (paths.length === 0) results.push(row('empty'));
      else {
        commits.set(taskId, commit);
        results.push(row('applied', paths));
      }
    }
  }
  const refused = results.find((r) => r.outcome !== 'applied');
  if (unique.length === 0 || refused !== undefined) {
    const reasonCode = unique.length === 0 ? 'NO_TASKS' : refused === undefined ? 'BLOCKED' : `TASK_${refused.outcome.toUpperCase().replace(/-/g, '_')}`;
    return store(ws, { ...base, baseCommit: expected, state: 'blocked', reasonCode, tasks: results });
  }
  // 2. A fresh integration worktree at the expected base.
  const allowed = [...new Set(unique.flatMap((t) => getTask(ws, t)?.node.writeScopes ?? []))];
  const created = await createWorktree(ws, { taskId: id, baseCommit: expected, allowedPaths: allowed, nowMs });
  if (!created.ok) return store(ws, { ...base, baseCommit: expected, state: 'blocked', reasonCode: created.reasonCode, tasks: results });
  const tree = created.worktree;
  const who = await identity(git, tree.path);
  // 3. Each task squash-merged and committed; a conflict is reported and rolled back.
  const applied: IntegrationTaskResult[] = [];
  for (const r of results) {
    const commit = commits.get(r.taskId) as string;
    // The merge gets the same identity as the commit: git 2.38 to 2.4x refuses a real (non
    // fast-forward) squash merge when no committer identity is configured.
    const merged = await git.run([...who, 'merge', '--squash', '--no-commit', commit], tree.path);
    if (!merged.ok) {
      // Only unmerged paths make a conflict; any other failure is git's error, reported as such.
      const unmerged = await git.run(['diff', '--name-only', '-z', '--diff-filter=U'], tree.path);
      const conflictPaths = unmerged.ok ? lines(unmerged.stdout) : [];
      await git.run(['reset', '--hard', '-q', 'HEAD'], tree.path);
      await git.run(['clean', '-fdq'], tree.path);
      applied.push(conflictPaths.length > 0 ? { ...r, outcome: 'conflict', conflictPaths } : { ...r, outcome: 'git-error', error: gitMessage(merged) });
      continue;
    }
    const title = (getTask(ws, r.taskId)?.title ?? '').replace(/[\r\n]+/g, ' ').slice(0, 72);
    const done = await git.run([...who, 'commit', '-q', '--no-verify', '-m', `Integrate task ${r.taskId}${title === '' ? '' : `: ${title}`}`], tree.path);
    if (!done.ok) {
      await git.run(['reset', '--hard', '-q', 'HEAD'], tree.path);
      await git.run(['clean', '-fdq'], tree.path);
    }
    const own = done.ok ? (await git.run(['rev-parse', 'HEAD'], tree.path)).stdout.trim() : '';
    applied.push(done.ok ? { ...r, ...(COMMIT.test(own) ? { integratedCommit: own } : {}) } : { ...r, outcome: 'git-error', error: gitMessage(done) });
  }
  const tip = (await git.run(['rev-parse', 'HEAD'], tree.path)).stdout.trim();
  const prepared = { ...base, baseCommit: expected, branch: tree.branch, worktreeId: tree.id, worktreePath: tree.path, integrationCommit: COMMIT.test(tip) ? tip : null, tasks: applied };
  if (applied.some((r) => r.outcome !== 'applied')) {
    const conflict = applied.some((r) => r.outcome === 'conflict');
    const gitError = applied.some((r) => r.outcome === 'git-error');
    return store(ws, { ...prepared, state: conflict ? 'conflicts' : 'blocked', reasonCode: conflict ? 'CONFLICTS' : gitError ? 'GIT_ERROR' : 'COMMIT_FAILED' });
  }
  // 4. The mandatory shared checks in the integration worktree.
  const checkIds = [...new Set(unique.flatMap((t) => getTask(ws, t)?.node.acceptanceCheckIds ?? []))];
  const requirementIds = [...new Set(unique.flatMap((t) => getTask(ws, t)?.node.requirementIds ?? []))];
  const target = openWorkspace({ home: ws.home, workspaceRoot: tree.path, workspaceId: ws.workspaceId, store: ws.store });
  const outcome = await runVerification(target, { taskId: id, checkIds, acceptanceCheckIds: checkIds, requirementIds, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const completion = outcome.completion;
  const checks = {
    verified: completion.verified,
    mandatoryCheckIds: completion.mandatoryCheckIds,
    failing: completion.checks.filter((c) => c.mandatory && c.status !== 'passed').map((c) => c.checkId),
    missingEvidence: completion.missingEvidence,
  };
  // 5. Review advice on the combined change.
  const advise = async (capabilityId: string): Promise<CapabilityAdvice | null> => {
    try {
      const r = await adviseCapability(target, { capabilityId, input: { base: expected }, taskId: capabilityId === 'C42' ? id : null, home: ws.home, engine: options.engine, egressApproved: options.egressApproved === true });
      return r.ok ? r.advice : null;
    } catch {
      return null;
    }
  };
  const review = { areas: await advise('C44'), security: await advise('C47') };
  const triage = completion.verified ? null : await advise('C42');
  // 6. The readiness report.
  return store(ws, { ...prepared, checks, review, triage, state: completion.verified ? 'ready' : 'checks-failed', reasonCode: completion.verified ? 'READY' : 'CHECKS_FAILED' });
}

export type ApproveIntegrationResult =
  | { readonly ok: true; readonly report: IntegrationReport }
  | { readonly ok: false; readonly reasonCode: 'UNKNOWN_INTEGRATION' | 'NOT_READY' | 'BASE_MOVED' | 'CHECKOUT_DIRTY' | 'INTEGRATION_CHANGED' | 'MERGE_FAILED' };

/** The user's approval: a fast-forward of the main checkout to the integration commit. */
export async function approveIntegration(ws: WorkspaceServices, id: string, actor: string, options: IntegrationOptions = {}): Promise<ApproveIntegrationResult> {
  const git = gitFor(options);
  const report = getIntegration(ws, id);
  if (report === undefined) return { ok: false, reasonCode: 'UNKNOWN_INTEGRATION' };
  if (report.state !== 'ready' || report.branch === null || report.integrationCommit === null || report.worktreeId === null) return { ok: false, reasonCode: 'NOT_READY' };
  const tree = getWorktree(ws, report.worktreeId);
  const tip = (await git.run(['rev-parse', '--verify', '-q', `refs/heads/${report.branch}`], ws.workspaceRoot)).stdout.trim();
  if (tree === undefined || tree.state === 'removed' || tip !== report.integrationCommit) return { ok: false, reasonCode: 'INTEGRATION_CHANGED' };
  const head = (await git.run(['rev-parse', 'HEAD'], ws.workspaceRoot)).stdout.trim();
  if (head !== report.baseCommit) return { ok: false, reasonCode: 'BASE_MOVED' };
  const status = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=no'], ws.workspaceRoot);
  if (!status.ok || status.stdout.length > 0) return { ok: false, reasonCode: 'CHECKOUT_DIRTY' };
  // --ff-only: git also refuses when an untracked file would be overwritten.
  if (!(await git.run(['merge', '--ff-only', '-q', report.integrationCommit], ws.workspaceRoot)).ok) return { ok: false, reasonCode: 'MERGE_FAILED' };
  const merged = (await git.run(['rev-parse', 'HEAD'], ws.workspaceRoot)).stdout.trim();
  const next: IntegrationReport = { ...report, state: 'merged', reasonCode: 'MERGED', approvedBy: actor.slice(0, 64), approvedAtMs: options.nowMs ?? Date.now(), mergedCommit: merged };
  return { ok: true, report: await store(ws, next) };
}
