/**
 * Input revision and freshness producers (VER-03, C39, SSOT §10.5, §9.5).
 *
 * revision = HEAD plus a hash of the dirty tree (changed and untracked files with content
 * hashes). A scoped revision covers only the declared input paths of a check, so an edit
 * outside a check's inputs leaves its receipt current, and an edit inside invalidates it.
 * Unknown dependency relationships (no declared scope) fall back to the whole tree.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveExecutable } from '@jevris/platform';
import { sha256, stableJson } from '../util.js';
import { hashFilesAsync, snapshotBudget, type HashBudget } from './file-hash.js';

export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'mix.lock',
  'packages.lock.json',
  'gradle.lockfile',
];

const MAX_FILES = 20_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.jevris', 'dist', 'target', '.venv', '__pycache__', '.next', 'build']); // path-hygiene: allow workspace-relative directory names

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  /** git's own message, when the port captured it (for reporting a git failure). */
  readonly stderr?: string;
}

/**
 * How the orchestrator runs git. Asynchronous: a git process never holds the sidecar's event
 * loop, so a slow repository cannot stall other requests or a subscriber's slice timer (A's
 * triage, 2026-09-27).
 */
export interface GitPort {
  run(args: readonly string[], cwd: string): Promise<GitResult>;
}

function gitEnv(): { readonly [key: string]: string | undefined } {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG'];
  const env: { [key: string]: string | undefined } = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/** The most git output kept; more fails the call (as spawnSync's maxBuffer did). */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** The most of git's own message kept. */
const ERR_KEEP = 1024 * 1024;

function decode(chunks: readonly Uint8Array[], total: number): string {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    if (at + chunk.length > total) break;
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes.subarray(0, at));
}

/**
 * git without a shell, off the event loop: the call resolves when git exits, and a call past
 * `timeoutMs` kills git and resolves not ok. It never rejects.
 */
export function nodeGit(timeoutMs = 30_000, extraEnv: { readonly [key: string]: string } = {}, program?: { readonly command: string; readonly prefixArgs?: readonly string[] }): GitPort {
  // `program` is a test seam: a stand-in git (for example node running a script), never set in product code.
  const resolved = program?.command ?? resolveExecutable('git') ?? 'git';
  const prefix = program?.prefixArgs ?? [];
  return {
    run(args, cwd) {
      return new Promise<GitResult>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(resolved, [...prefix, '-c', 'core.quotepath=off', ...args], { shell: false, windowsHide: true, cwd, env: { ...gitEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
          resolve({ ok: false, stdout: '', stderr: '' });
          return;
        }
        const out: Uint8Array[] = [];
        const err: Uint8Array[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let failed = false;
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: ok && !failed, stdout: decode(out, outBytes), stderr: decode(err, Math.min(errBytes, ERR_KEEP)) });
        };
        const stop = () => {
          failed = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        };
        const timer = setTimeout(() => {
          stop();
          finish(false);
        }, timeoutMs);
        child.stdout?.on('data', (chunk: Uint8Array) => {
          outBytes += chunk.length;
          if (outBytes > GIT_MAX_BUFFER) stop();
          else out.push(chunk);
        });
        child.stderr?.on('data', (chunk: Uint8Array) => {
          if (errBytes + chunk.length <= ERR_KEEP) err.push(chunk);
          errBytes += chunk.length;
        });
        child.on('error', () => finish(false));
        child.on('close', (code) => finish(code === 0));
      });
    },
  };
}

export interface FileHash {
  readonly path: string;
  readonly status: string;
  readonly hash: string;
}

export interface RevisionSnapshot {
  readonly kind: 'git' | 'tree';
  readonly head: string;
  readonly branch: string | null;
  readonly dirtyHash: string;
  readonly revision: string;
  readonly dirty: readonly FileHash[];
  readonly lockfileHash: string;
}

/** Posix-style workspace-relative path, the same on every OS. */
export function relPath(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

function parsePorcelain(stdout: string): readonly { readonly status: string; readonly path: string }[] {
  const out: { status: string; path: string }[] = [];
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? '';
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    out.push({ status, path });
    // A rename or copy is followed by the original path.
    if (status.includes('R') || status.includes('C')) i += 1;
  }
  return out;
}

/** The files under `dir` (sorted walk, at most MAX_FILES), asynchronously: no directory read holds the loop. */
async function walkTree(root: string, dir: string, out: string[], scopes: readonly string[] | null): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      const st = await stat(full);
      isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue;
    } catch {
      continue;
    }
    if (isDir) {
      await walkTree(root, full, out, scopes);
      if (out.length >= MAX_FILES) return;
      continue;
    }
    if (scopes !== null && !inScopes(relPath(root, full), scopes)) continue;
    out.push(full);
    if (out.length >= MAX_FILES) return;
  }
}

/** A path is in scope when it equals a scope or sits under it. `**` style globs reduce to their prefix. */
export function inScopes(path: string, scopes: readonly string[]): boolean {
  for (const raw of scopes) {
    const scope = raw.replace(/\/\*\*.*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
    if (scope === '' || scope === '.' || scope === '**') return true;
    if (path === scope || path.startsWith(`${scope}/`)) return true;
  }
  return false;
}

async function lockfileHash(root: string, budget: HashBudget): Promise<string> {
  const hashes = await hashFilesAsync(LOCKFILES.map((name) => join(root, name)), budget);
  const rows: string[] = [];
  LOCKFILES.forEach((name, i) => {
    const h = hashes[i] as string;
    if (h !== 'missing') rows.push(`${name}:${h}`);
  });
  return sha256(rows.join('\n'));
}

/**
 * One `git status --porcelain=v2 --branch` answer: HEAD, branch and the changed paths with their
 * porcelain v1 status codes (`.` becomes a space), so the revision is the same as before. Null
 * when the answer is not a work-tree status, and the caller asks git step by step instead.
 */
function parseStatusV2(stdout: string): { readonly head: string; readonly branch: string | null; readonly entries: readonly { readonly status: string; readonly path: string }[] } | null {
  let head: string | null = null;
  let branch: string | null = null;
  const entries: { status: string; path: string }[] = [];
  const parts = stdout.split('\0');
  const after = (entry: string, fields: number): string | null => {
    let at = 0;
    for (let n = 0; n < fields; n += 1) {
      at = entry.indexOf(' ', at) + 1;
      if (at === 0) return null;
    }
    return entry.slice(at);
  };
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? '';
    if (entry === '') continue;
    if (entry.startsWith('# branch.oid ')) head = entry.slice(13).trim();
    else if (entry.startsWith('# branch.head ')) {
      const name = entry.slice(14).trim();
      branch = name === '(detached)' || name === '' ? null : name;
    } else if (entry.startsWith('# ')) continue;
    else if (entry.startsWith('? ')) entries.push({ status: '??', path: entry.slice(2) });
    else if (entry.startsWith('! ')) entries.push({ status: '!!', path: entry.slice(2) });
    else if (entry.startsWith('1 ') || entry.startsWith('2 ') || entry.startsWith('u ')) {
      const path = after(entry, entry[0] === '1' ? 8 : entry[0] === '2' ? 9 : 10);
      if (path === null) return null;
      entries.push({ status: entry.slice(2, 4).replace(/\./g, ' '), path });
      // A rename or copy is followed by the original path.
      if (entry[0] === '2') i += 1;
    } else return null;
  }
  if (head === null) return null;
  return { head: head === '(initial)' ? 'no-commit' : head, branch, entries };
}

export async function snapshotRevision(root: string, git: GitPort = nodeGit()): Promise<RevisionSnapshot> {
  // One git process on the hot path (the Stop hook works inside the sidecar's subscriber slice).
  const combined = await git.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--no-renames'], root);
  const parsed = combined.ok ? parseStatusV2(combined.stdout) : null;
  if (parsed !== null) return gitSnapshot(root, parsed.head, parsed.branch, parsed.entries);
  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], root);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    const budget = snapshotBudget();
    const paths: string[] = [];
    await walkTree(root, root, paths, null);
    const hashes = await hashFilesAsync(paths, budget);
    const files: FileHash[] = paths.map((full, i) => ({ path: relPath(root, full), status: 'F', hash: hashes[i] as string }));
    const dirtyHash = sha256(stableJson(files));
    return {
      kind: 'tree',
      head: 'no-git',
      branch: null,
      dirtyHash,
      revision: `tree-${dirtyHash.slice(0, 24)}`,
      dirty: files,
      lockfileHash: await lockfileHash(root, budget),
    };
  }
  const headRun = await git.run(['rev-parse', '--verify', '-q', 'HEAD'], root);
  const head = headRun.ok ? headRun.stdout.trim() : 'no-commit';
  const branchRun = await git.run(['symbolic-ref', '--short', '-q', 'HEAD'], root);
  const branch = branchRun.ok && branchRun.stdout.trim().length > 0 ? branchRun.stdout.trim() : null;
  const status = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], root);
  return gitSnapshot(root, head, branch, parsePorcelain(status.stdout));
}

async function gitSnapshot(root: string, head: string, branch: string | null, entries: readonly { readonly status: string; readonly path: string }[]): Promise<RevisionSnapshot> {
  // Content hashes off the loop, cached by file identity, within one snapshot's byte budget (P5).
  const budget = snapshotBudget();
  const hashes = await hashFilesAsync(entries.map((entry) => join(root, entry.path)), budget);
  const dirty: FileHash[] = entries.map((entry, i) => ({ path: entry.path, status: entry.status, hash: hashes[i] as string }));
  dirty.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const dirtyHash = sha256(stableJson(dirty));
  const short = head === 'no-commit' ? 'nocommit' : head.slice(0, 16);
  return {
    kind: 'git',
    head,
    branch,
    dirtyHash,
    revision: dirty.length === 0 ? `g-${short}` : `g-${short}-${dirtyHash.slice(0, 16)}`,
    dirty,
    lockfileHash: await lockfileHash(root, budget),
  };
}

/**
 * The revision of the paths a check depends on. With no scopes it is the whole revision
 * (conservative). With scopes it hashes the committed tree entries and dirty files under them.
 */
export async function scopedRevision(root: string, snapshot: RevisionSnapshot, scopes: readonly string[] | undefined, git: GitPort = nodeGit()): Promise<string> {
  if (scopes === undefined || scopes.length === 0) return snapshot.revision;
  let committed = '';
  if (snapshot.kind === 'git' && snapshot.head !== 'no-commit') {
    const listing = await git.run(['ls-tree', '-r', '--full-tree', snapshot.head], root);
    if (!listing.ok) return snapshot.revision;
    committed = listing.stdout
      .split('\n')
      .filter((line) => {
        const tab = line.indexOf('\t');
        return tab > 0 && inScopes(line.slice(tab + 1), scopes);
      })
      .join('\n');
  } else if (snapshot.kind === 'tree') {
    committed = stableJson(snapshot.dirty.filter((row) => inScopes(row.path, scopes)));
  }
  const dirty = snapshot.kind === 'git' ? snapshot.dirty.filter((row) => inScopes(row.path, scopes)) : [];
  // The lockfile always counts: a dependency change can change any check's behaviour.
  return `s-${sha256(`${committed}\n${stableJson(dirty)}\n${snapshot.lockfileHash}`).slice(0, 32)}`;
}

export interface RevisionChange {
  readonly changed: boolean;
  readonly branchChanged: boolean;
  readonly lockfileChanged: boolean;
  readonly headChanged: boolean;
  readonly changedPaths: readonly string[];
}

export function compareSnapshots(previous: RevisionSnapshot | undefined, next: RevisionSnapshot): RevisionChange {
  if (previous === undefined) {
    return { changed: true, branchChanged: false, lockfileChanged: false, headChanged: false, changedPaths: [] };
  }
  const before = new Map(previous.dirty.map((row) => [row.path, row.hash]));
  const after = new Map(next.dirty.map((row) => [row.path, row.hash]));
  const paths = new Set<string>();
  for (const [path, hash] of after) if (before.get(path) !== hash) paths.add(path);
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);
  return {
    changed: previous.revision !== next.revision,
    branchChanged: previous.branch !== next.branch,
    lockfileChanged: previous.lockfileHash !== next.lockfileHash,
    headChanged: previous.head !== next.head,
    changedPaths: [...paths].sort(),
  };
}
