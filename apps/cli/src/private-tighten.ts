/**
 * Owner-only Jevris files (B's private-file rule, 2026-09-26). Everything under the Jevris home
 * is private: every directory 0700 and every file 0600 on POSIX, the owner-only ACL on Windows.
 *
 * An older Jevris wrote receipts 0644 and ~/.jevris 0755. `jevris install` tightens them on
 * upgrade, and doctor names what is still loose. The walk:
 * - only removes group and other bits (mode & ~0o077), never widens a mode;
 * - only touches entries this uid owns;
 * - never follows a symlink: it is skipped and reported;
 * - never leaves the Jevris folders (data, state, runtime, config);
 * - is bounded (depth 8, 100 000 entries).
 */
import { chmod, lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { applyOwnerOnlyAcl, jevrisPaths } from '@jevris/platform';

export const PRIVATE_WALK_DEPTH = 8;
export const PRIVATE_WALK_ENTRIES = 100_000;

export interface LooseEntry {
  /** Absolute path. */
  readonly path: string;
  readonly kind: 'dir' | 'file' | 'symlink';
  /** The octal mode, for example 0644 (null for a symlink). */
  readonly mode: string | null;
  /** tightened, left (another owner, or a failed chmod), symlink (skipped), or found (check only). */
  readonly outcome: 'tightened' | 'left' | 'symlink' | 'found';
}

export interface PrivateWalkOptions {
  readonly home: string;
  /** Tighten (install) or only report (doctor). */
  readonly repair: boolean;
  readonly platform?: string;
  /** Test seam for the current uid. */
  readonly uid?: number;
  /** Test seam for chmod. */
  readonly chmod?: (path: string, mode: number) => Promise<void>;
}

interface Stat {
  readonly mode: number;
  readonly uid?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The Jevris folders the rule covers: data (the Jevris home), state, runtime and config. */
export function privateRoots(home: string, platform: string = process.platform): readonly string[] {
  const paths = jevrisPaths({ home, platform });
  const dirs = [...new Set([paths.data, paths.state, paths.runtime, paths.config])];
  const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  return dirs.filter((dir) => !dirs.some((other) => other !== dir && inside(other, dir)));
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/** Walks the Jevris folders; with `repair` it tightens what it may. Returns every loose entry. */
export async function walkPrivate(options: PrivateWalkOptions): Promise<readonly LooseEntry[]> {
  const platform = options.platform ?? process.platform;
  const getuid: unknown = Reflect.get(process, 'getuid');
  const uid = options.uid ?? (typeof getuid === 'function' ? (Reflect.apply(getuid, process, []) as number) : undefined);
  const doChmod = options.chmod ?? ((path: string, mode: number) => chmod(path, mode));
  const out: LooseEntry[] = [];
  let seen = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (seen >= PRIVATE_WALK_ENTRIES) return;
    seen += 1;
    let st: Stat;
    try {
      st = (await lstat(path)) as Stat;
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      out.push({ path, kind: 'symlink', mode: null, outcome: 'symlink' });
      return;
    }
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) return;
    if (platform === 'win32') {
      if (options.repair && isDir && depth === 0) applyOwnerOnlyAcl(path, true, { platform });
    } else if ((st.mode & 0o077) !== 0) {
      const mode = octal(st.mode);
      if (!options.repair) out.push({ path, kind: isDir ? 'dir' : 'file', mode, outcome: 'found' });
      else if (uid !== undefined && st.uid !== undefined && st.uid !== uid) out.push({ path, kind: isDir ? 'dir' : 'file', mode, outcome: 'left' });
      else {
        try {
          await doChmod(path, st.mode & 0o777 & ~0o077);
          out.push({ path, kind: isDir ? 'dir' : 'file', mode, outcome: 'tightened' });
        } catch {
          out.push({ path, kind: isDir ? 'dir' : 'file', mode, outcome: 'left' });
        }
      }
    }
    if (!isDir || depth >= PRIVATE_WALK_DEPTH) return;
    let names: readonly string[];
    try {
      names = await readdir(path);
    } catch {
      return;
    }
    for (const name of [...names].sort()) await visit(join(path, name), depth + 1);
  };
  for (const root of privateRoots(options.home, platform)) await visit(root, 0);
  return out;
}

/** Doctor's lines: `privateFiles: ok`, or one line naming the loose entries and the fix. */
export function privateFileLines(home: string, loose: readonly LooseEntry[]): readonly string[] {
  const wide = loose.filter((entry) => entry.outcome !== 'symlink');
  const links = loose.filter((entry) => entry.outcome === 'symlink');
  const lines: string[] = [];
  const shown = (entries: readonly LooseEntry[]): string => {
    const names = entries.slice(0, 5).map((entry) => `${relative(home, entry.path) || '.'}${entry.mode === null ? '' : ` ${entry.mode}`}`);
    return `${names.join(', ')}${entries.length > 5 ? ` and ${entries.length - 5} more` : ''}`;
  };
  if (wide.length > 0) lines.push(`privateFiles: ${wide.length} Jevris ${wide.length === 1 ? 'entry is' : 'entries are'} readable by other users (${shown(wide)}); fix: jevris install (it makes them owner-only)`);
  if (links.length > 0) lines.push(`privateFiles: ${links.length} symlink${links.length === 1 ? '' : 's'} inside the Jevris folders, not followed (${shown(links)}); remove ${links.length === 1 ? 'it' : 'them'} if you did not create ${links.length === 1 ? 'it' : 'them'}`);
  if (lines.length === 0) lines.push('privateFiles: ok');
  return lines;
}

/**
 * Doctor's privateFiles lines in place of the host-health ones. On POSIX the walk covers every
 * entry under the Jevris folders (host-health checks only the top level); on Windows the
 * host-health ACL lines stay, each with the fix.
 */
export async function doctorPrivateLines(home: string, hostLines: readonly string[], options: { readonly platform?: string; readonly uid?: number } = {}): Promise<readonly string[]> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return hostLines.map((line) => (line.startsWith('privateFiles: wide ') ? `${line}; fix: jevris install (it makes the Jevris folders owner-only)` : line));
  const mine = privateFileLines(home, await walkPrivate({ home, repair: false, platform, ...(options.uid === undefined ? {} : { uid: options.uid }) }));
  const out: string[] = [];
  let placed = false;
  for (const line of hostLines) {
    if (!line.startsWith('privateFiles: ')) {
      out.push(line);
      continue;
    }
    if (!placed) out.push(...mine);
    placed = true;
  }
  if (!placed) out.push(...mine);
  return out;
}
