/**
 * Worktree manager v2 (ORC-04, ORC-06, SSOT §10.3, US21, W04).
 *
 * - Each owned task works in its own git worktree under `<data>/worktrees/<workspaceId>/`,
 *   created from an explicit base commit on a Jevris branch.
 * - git 2.38 or later is required; git runs without a shell, with a configurable timeout and
 *   an env allowlist that keeps HOME, USERPROFILE and APPDATA (git needs them for config).
 * - `core.longpaths` is set on Windows.
 * - Allowed paths are enforced after a run from the real diff (committed and uncommitted
 *   changes plus untracked files) against the task's write scopes.
 * - Dependency-cache and port resource keys are assigned per worktree.
 * - The registry (including crashed trees) is persisted in the host ledger, so a restart still
 *   knows which trees are Jevris-owned and which crashed.
 * - Removal is only for a clean, owned tree and only with explicit confirmation. A dirty or
 *   unknown tree is never force-deleted; it is kept for the user.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { WorkspaceServices } from './workspace.js';
import { nodeGit, inScopes, type GitPort } from './verify/revision.js';
import { selfIdentity, livenessOf, type Liveness, type ProcessIdentity } from './orchestration/liveness.js';

export const MIN_GIT: readonly [number, number] = [2, 38];
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const PORT_BASE = 42_000;
const PORT_SPAN = 1_000;
const COMMIT = /^[0-9a-f]{7,64}$/;

export type WorktreeState = 'active' | 'crashed' | 'retained' | 'removed';

export interface WorktreeRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly allowedPaths: readonly string[];
  readonly resourceKeys: readonly string[];
  readonly port: number;
  readonly owner: ProcessIdentity;
  readonly state: WorktreeState;
  readonly createdAtMs: number;
  readonly note: string | null;
}

export interface WorktreeOptions {
  readonly git?: GitPort;
  readonly timeoutMs?: number;
  readonly platform?: string;
}

export type WorktreeStatus = 'clean' | 'dirty' | 'unknown';

function gitFor(options: WorktreeOptions): GitPort {
  return options.git ?? nodeGit(options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
}

export function parseGitVersion(text: string): readonly [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
}

export async function gitVersionOk(git: GitPort, cwd: string): Promise<{ readonly ok: boolean; readonly version: string | null }> {
  const r = await git.run(['--version'], cwd);
  const v = r.ok ? parseGitVersion(r.stdout) : null;
  if (v === null) return { ok: false, version: null };
  const ok = v[0] > MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] >= MIN_GIT[1]);
  return { ok, version: v.join('.') };
}

export function worktreesRoot(ws: WorkspaceServices): string {
  return join(ws.dataDir, 'worktrees', ws.workspaceId);
}

export type CreateWorktreeResult =
  | { readonly ok: true; readonly worktree: WorktreeRecord }
  | { readonly ok: false; readonly reasonCode: 'GIT_TOO_OLD' | 'NOT_A_REPOSITORY' | 'BAD_BASE' | 'BASE_NOT_ANCESTOR' | 'GIT_FAILED' | 'INVALID_TASK' };

export interface CreateWorktreeInput {
  readonly taskId: string;
  /** Explicit base commit; defaults to HEAD. */
  readonly baseCommit?: string;
  readonly allowedPaths: readonly string[];
  readonly lockfileHash?: string;
  readonly nowMs?: number;
}

export async function createWorktree(ws: WorkspaceServices, input: CreateWorktreeInput, options: WorktreeOptions = {}): Promise<CreateWorktreeResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.taskId)) return { ok: false, reasonCode: 'INVALID_TASK' };
  const git = gitFor(options);
  const root = ws.workspaceRoot;
  if (!(await gitVersionOk(git, root)).ok) return { ok: false, reasonCode: 'GIT_TOO_OLD' };
  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], root);
  if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, reasonCode: 'NOT_A_REPOSITORY' };
  const baseRef = input.baseCommit ?? 'HEAD';
  const resolved = await git.run(['rev-parse', '--verify', '-q', `${baseRef}^{commit}`], root);
  const base = resolved.stdout.trim();
  if (!resolved.ok || !COMMIT.test(base)) return { ok: false, reasonCode: 'BAD_BASE' };
  if (input.baseCommit !== undefined && !(await git.run(['merge-base', '--is-ancestor', base, 'HEAD'], root)).ok) return { ok: false, reasonCode: 'BASE_NOT_ANCESTOR' };
  const id = `wt-${randomBytes(6).toString('hex')}`;
  const dir = worktreesRoot(ws);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, id);
  const branch = `jevris/${input.taskId}-${id.slice(3)}`;
  const nowMs = input.nowMs ?? Date.now();
  // Reserve the registry row (and a port) before touching git, so a crash leaves a record.
  const record = await ws.host.transact((tx) => {
    const used = new Set(tx.list<WorktreeRecord>('worktrees').filter((w) => w.state === 'active').map((w) => w.port));
    let port = PORT_BASE;
    while (used.has(port) && port < PORT_BASE + PORT_SPAN) port += 1;
    const row: WorktreeRecord = {
      id,
      workspaceId: ws.workspaceId,
      taskId: input.taskId,
      path,
      branch,
      baseCommit: base,
      allowedPaths: [...input.allowedPaths],
      resourceKeys: [`port:${String(port)}`, `depcache:${(input.lockfileHash ?? 'none').slice(0, 16)}:${id}`],
      port,
      owner: selfIdentity(),
      state: 'active',
      createdAtMs: nowMs,
      note: null,
    };
    tx.put('worktrees', id, row);
    return row;
  });
  const added = await git.run(['worktree', 'add', '-b', branch, path, base], root);
  if (!added.ok) {
    await ws.host.transact((tx) => tx.put('worktrees', id, { ...record, state: 'removed', note: 'git worktree add failed' }));
    return { ok: false, reasonCode: 'GIT_FAILED' };
  }
  if ((options.platform ?? process.platform) === 'win32') await git.run(['config', 'core.longpaths', 'true'], path);
  return { ok: true, worktree: record };
}

export function getWorktree(ws: WorkspaceServices, id: string): WorktreeRecord | undefined {
  return ws.host.get<WorktreeRecord>('worktrees', id);
}

export function listWorktrees(ws: WorkspaceServices): readonly WorktreeRecord[] {
  return ws.host.list<WorktreeRecord>('worktrees').filter((w) => w.workspaceId === ws.workspaceId);
}

/** Git-detected status. Anything git cannot report is `unknown`, never assumed clean. */
export async function worktreeStatus(record: Pick<WorktreeRecord, 'path'>, options: WorktreeOptions = {}): Promise<WorktreeStatus> {
  if (!existsSync(record.path)) return 'unknown';
  const r = await gitFor(options).run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], record.path);
  if (!r.ok) return 'unknown';
  return r.stdout.length === 0 ? 'clean' : 'dirty';
}

/** Every path the worktree changed since its base: commits, staged, unstaged and untracked. */
export async function changedPaths(record: Pick<WorktreeRecord, 'path' | 'baseCommit'>, options: WorktreeOptions = {}): Promise<readonly string[] | null> {
  const git = gitFor(options);
  const committed = await git.run(['diff', '--name-only', '-z', record.baseCommit, 'HEAD'], record.path);
  const working = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], record.path);
  if (!committed.ok || !working.ok) return null;
  const out = new Set<string>();
  for (const p of committed.stdout.split('\0')) if (p.length > 0) out.add(p);
  for (const entry of working.stdout.split('\0')) if (entry.length > 3) out.add(entry.slice(3));
  return [...out].sort();
}

export interface AllowedPathsReport {
  readonly ok: boolean;
  readonly changed: readonly string[];
  readonly violations: readonly string[];
  /** True when git could not produce the diff; the run is then not accepted. */
  readonly unknown: boolean;
}

export async function enforceAllowedPaths(record: Pick<WorktreeRecord, 'path' | 'baseCommit' | 'allowedPaths'>, options: WorktreeOptions = {}): Promise<AllowedPathsReport> {
  const changed = await changedPaths(record, options);
  if (changed === null) return { ok: false, changed: [], violations: [], unknown: true };
  const violations = record.allowedPaths.length === 0 ? [...changed] : changed.filter((p) => !inScopes(p, record.allowedPaths));
  return { ok: violations.length === 0, changed, violations, unknown: false };
}

/**
 * Startup reconciliation: an active tree whose owner process is gone is recorded as crashed.
 * A crashed tree is never relaunched or deleted automatically.
 */
export async function recoverCrashedWorktrees(ws: WorkspaceServices, liveness: (owner: ProcessIdentity) => Liveness = (o) => livenessOf(o)): Promise<readonly string[]> {
  return ws.host.transact((tx) => {
    const crashed: string[] = [];
    for (const w of tx.list<WorktreeRecord>('worktrees')) {
      if (w.workspaceId !== ws.workspaceId || w.state !== 'active') continue;
      if (liveness(w.owner) !== 'dead') continue;
      tx.put('worktrees', w.id, { ...w, state: 'crashed', note: 'owner process ended without releasing the tree' });
      crashed.push(w.id);
    }
    return crashed;
  });
}

export type RemoveWorktreeResult =
  | { readonly removed: true }
  | { readonly removed: false; readonly reasonCode: 'UNKNOWN_WORKTREE' | 'NOT_OWNED' | 'NEEDS_CONFIRMATION' | 'DIRTY' | 'STATUS_UNKNOWN' | 'GIT_FAILED' };

/** Removes a clean, Jevris-owned tree after explicit confirmation. Never `--force`. */
export async function removeWorktree(ws: WorkspaceServices, id: string, confirm: boolean, options: WorktreeOptions = {}): Promise<RemoveWorktreeResult> {
  const record = getWorktree(ws, id);
  if (record === undefined) return { removed: false, reasonCode: 'UNKNOWN_WORKTREE' };
  if (record.workspaceId !== ws.workspaceId || !record.path.startsWith(worktreesRoot(ws))) return { removed: false, reasonCode: 'NOT_OWNED' };
  if (!confirm) return { removed: false, reasonCode: 'NEEDS_CONFIRMATION' };
  const status = await worktreeStatus(record, options);
  if (status === 'dirty') {
    await ws.host.transact((tx) => tx.put('worktrees', id, { ...record, state: 'retained', note: 'dirty: kept for the user' }));
    return { removed: false, reasonCode: 'DIRTY' };
  }
  if (status === 'unknown') {
    await ws.host.transact((tx) => tx.put('worktrees', id, { ...record, state: 'retained', note: 'status unknown: kept for the user' }));
    return { removed: false, reasonCode: 'STATUS_UNKNOWN' };
  }
  const git = gitFor(options);
  if (!(await git.run(['worktree', 'remove', record.path], ws.workspaceRoot)).ok) return { removed: false, reasonCode: 'GIT_FAILED' };
  await git.run(['branch', '-D', record.branch], ws.workspaceRoot);
  await ws.host.transact((tx) => tx.put('worktrees', id, { ...record, state: 'removed', note: 'removed after confirmation' }));
  return { removed: true };
}

export async function retainWorktree(ws: WorkspaceServices, id: string, note: string): Promise<void> {
  await ws.host.transact((tx) => {
    const record = tx.get<WorktreeRecord>('worktrees', id);
    if (record !== undefined) tx.put('worktrees', id, { ...record, state: 'retained', note: note.slice(0, 200) });
  });
}
