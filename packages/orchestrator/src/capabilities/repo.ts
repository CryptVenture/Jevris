/**
 * Bounded repository reads for capability evidence (C34, C41, C44, C47, C57, C59, C61).
 *
 * Every read stays inside an approved root: paths are resolved, real paths are checked for
 * containment (a symlink out of the root is refused), and sizes and counts are capped. Git
 * output is `-z` separated and converted with node:path, so Windows paths and paths with
 * spaces work. Nothing here uploads anything; callers pass bounded spans to advice.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitPort } from '../verify/revision.js';

export const MAX_LISTED_FILES = 20_000;
export const MAX_SPAN_BYTES = 4_096;
export const MAX_FILE_BYTES = 256 * 1024;

/** True when `child` is `root` or inside it (case-insensitive where the OS is). */
export function within(root: string, child: string, platform: string = process.platform): boolean {
  const fold = platform === 'win32' || platform === 'darwin' ? (s: string) => s.toLowerCase() : (s: string) => s;
  const rel = relative(fold(resolve(root)), fold(resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A path key for de-duplication: case-folded on macOS and Windows. */
export function pathKey(path: string, platform: string = process.platform): string {
  const r = resolve(path);
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
}

/** Joins a git-style relative path (forward slashes) under a root with node:path. */
export function underRoot(root: string, gitPath: string): string {
  return join(root, ...gitPath.split('/').filter((p) => p !== '' && p !== '.'));
}

function zsplit(out: string, max: number): string[] {
  return out.split('\0').filter((s) => s.length > 0).slice(0, max);
}

/** Files git knows in the root (tracked plus untracked, ignoring ignored), bounded. */
export async function listFiles(git: GitPort, root: string, max = MAX_LISTED_FILES): Promise<readonly string[] | null> {
  const r = await git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  if (!r.ok) return null;
  return [...new Set(zsplit(r.stdout, max))].sort();
}

/**
 * Paths changed relative to `base` (default HEAD): committed-since-base, staged, unstaged and
 * untracked. Null when git cannot answer (then callers treat the impact as unknown).
 */
export async function changedFiles(git: GitPort, root: string, base = 'HEAD', max = 2_000): Promise<readonly string[] | null> {
  const diff = await git.run(['diff', '--name-only', '-z', base, '--'], root);
  if (!diff.ok) return null;
  const untracked = await git.run(['ls-files', '-z', '--others', '--exclude-standard'], root);
  return [...new Set([...zsplit(diff.stdout, max), ...(untracked.ok ? zsplit(untracked.stdout, max) : [])])].sort().slice(0, max);
}

/** Unified diff with no context against `base`, capped; null when git cannot answer. */
export async function diffText(git: GitPort, root: string, paths: readonly string[] = [], base = 'HEAD', maxBytes = 512 * 1024): Promise<string | null> {
  const r = await git.run(['diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--', ...paths.slice(0, 200)], root);
  if (!r.ok) return null;
  return r.stdout.length > maxBytes ? r.stdout.slice(0, maxBytes) : r.stdout;
}

/** Lines added and removed per file in a unified diff. */
export function diffLines(diff: string): Map<string, { added: string[]; removed: string[] }> {
  const out = new Map<string, { added: string[]; removed: string[] }>();
  let current: { added: string[]; removed: string[] } | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file !== null) {
      current = { added: [], removed: [] };
      out.set(file[1] ?? '', current);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (current === undefined) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return out;
}

/**
 * Reads at most `maxBytes` of a file inside `root`. Refuses a path (or a symlink target)
 * outside the root, a directory, and binary content. Returns null on any refusal.
 */
export function readBounded(root: string, gitPath: string, maxBytes = MAX_FILE_BYTES): { readonly text: string; readonly truncated: boolean; readonly bytes: number } | null {
  const full = underRoot(root, gitPath);
  if (!within(root, full)) return null;
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(full);
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  if (!within(realRoot, real)) return null;
  let fd: number | undefined;
  try {
    const st = statSync(real);
    if (!st.isFile()) return null;
    const size = Math.min(st.size, maxBytes);
    const buf = new Uint8Array(size);
    fd = openSync(real, 'r');
    const n = readSync(fd, buf, 0, size, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) return null;
    return { text: new TextDecoder().decode(bytes), truncated: st.size > maxBytes, bytes: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A bounded span of lines around `line` (1-based), at most MAX_SPAN_BYTES. */
export function spanAround(text: string, line: number, radius = 6): { readonly start: number; readonly end: number; readonly text: string } {
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  let span = lines.slice(start - 1, end).join('\n');
  if (span.length > MAX_SPAN_BYTES) span = span.slice(0, MAX_SPAN_BYTES);
  return { start, end, text: span };
}

/** The path separator-agnostic top-level module of a git path (`packages/core/src/x.ts` -> `packages/core`). */
export function moduleOf(gitPath: string): string {
  const parts = gitPath.split('/');
  if (parts.length <= 1) return '.';
  if ((parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'crates' || parts[0] === 'libs' || parts[0] === 'services') && parts.length > 2) return `${parts[0]}/${parts[1]}`; // path-hygiene: allow a module id, not a filesystem path
  return parts[0] ?? '.';
}

export const PATH_SEP = sep;
