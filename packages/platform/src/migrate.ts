import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { pathApiFor, type JevrisPaths } from './paths.js';

/**
 * Moves the pre-v1.2 layout (~/.jevris, ~/.config/jevris) into the per-OS directories.
 * An entry moves only when the destination entry does not exist; nothing is overwritten.
 * A symlinked legacy root or entry is refused and left in place. On darwin the legacy
 * and current locations are the same, so nothing moves.
 */

export interface MigrationFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options: { readonly recursive?: boolean; readonly mode?: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  cp(from: string, to: string, options: { readonly recursive: boolean; readonly errorOnExist: boolean; readonly force: boolean }): Promise<void>;
  rm(path: string, options: { readonly recursive: boolean; readonly force: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
}

export interface MigrationReport {
  readonly moved: readonly string[];
  readonly leftovers: readonly string[];
  readonly refused: readonly string[];
}

const nodeFs: MigrationFs = { lstat, readdir, mkdir, rename, cp, rm, rmdir };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function exists(fs: MigrationFs, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The legacy-to-current pairs that differ on this layout. */
export function legacyPairs(paths: JevrisPaths): readonly { readonly from: string; readonly to: string; readonly kind: 'data' | 'config' }[] {
  const api = pathApiFor(paths.platform);
  const same = (left: string, right: string): boolean => {
    const a = api.normalize(left);
    const b = api.normalize(right);
    return paths.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  const pairs: { from: string; to: string; kind: 'data' | 'config' }[] = [];
  if (!same(paths.legacyData, paths.data)) pairs.push({ from: paths.legacyData, to: paths.data, kind: 'data' });
  if (!same(paths.legacyConfig, paths.config)) pairs.push({ from: paths.legacyConfig, to: paths.config, kind: 'config' });
  return pairs;
}

async function moveEntry(fs: MigrationFs, from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') return false;
  }
  try {
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(from, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function migrateLegacyLayout(paths: JevrisPaths, port: Partial<MigrationFs> = {}): Promise<MigrationReport> {
  const fs: MigrationFs = { ...nodeFs, ...port };
  const api = pathApiFor(paths.platform);
  const moved: string[] = [];
  const leftovers: string[] = [];
  const refused: string[] = [];
  for (const pair of legacyPairs(paths)) {
    let root;
    try {
      root = await fs.lstat(pair.from);
    } catch {
      continue;
    }
    if (root.isSymbolicLink() || !root.isDirectory()) {
      refused.push(pair.from);
      continue;
    }
    let names: string[];
    try {
      names = await fs.readdir(pair.from);
    } catch {
      refused.push(pair.from);
      continue;
    }
    for (const name of names.sort()) {
      const from = api.join(pair.from, name);
      const to = api.join(pair.to, name);
      let entry;
      try {
        entry = await fs.lstat(from);
      } catch {
        continue;
      }
      if (entry.isSymbolicLink()) {
        refused.push(from);
        continue;
      }
      if (pair.kind === 'data' && name === 'run') {
        // Sockets are ephemeral; an empty run directory is removed, a busy one stays.
        try {
          await fs.rmdir(from);
        } catch {
          leftovers.push(from);
        }
        continue;
      }
      if (await exists(fs, to)) {
        leftovers.push(from);
        continue;
      }
      try {
        await fs.mkdir(pair.to, { recursive: true, mode: 0o700 });
      } catch {
        leftovers.push(from);
        continue;
      }
      if (await moveEntry(fs, from, to)) moved.push(to);
      else leftovers.push(from);
    }
    try {
      await fs.rmdir(pair.from);
    } catch {
      // Not empty: the leftovers above explain why.
    }
  }
  return { moved, leftovers, refused };
}

/** Legacy roots that still exist and differ from the current layout. For doctor. */
export async function legacyLeftovers(paths: JevrisPaths, port: Partial<MigrationFs> = {}): Promise<readonly string[]> {
  const fs: MigrationFs = { ...nodeFs, ...port };
  const out: string[] = [];
  for (const pair of legacyPairs(paths)) {
    if (await exists(fs, pair.from)) out.push(pair.from);
  }
  return out;
}
