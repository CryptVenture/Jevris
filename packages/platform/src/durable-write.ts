import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { pathApiFor } from './paths.js';

/**
 * The one durable-write helper (BLD-01).
 *
 * 1. Refuses a destination or parent directory that is a symlink.
 * 2. Removes stale temps for the same destination (unique temps and the legacy fixed
 *    names `<dest>.tmp`, `<dest>.<id>.tmp`) older than `staleMs`.
 * 3. Writes a unique temp `.<base>.<pid>.<random>.jtmp` next to the destination,
 *    created exclusively (O_EXCL, O_NOFOLLOW where the OS has it) at `mode`.
 * 4. Flushes the temp, then renames it over the destination. EPERM, EBUSY and EACCES
 *    (Windows: the target is open or being scanned) are retried with backoff.
 * 5. On any failure only this call's temp is removed. It never throws.
 *
 * A leftover temp from a killed write never blocks a later write: temp names are unique.
 */

export interface DurableHandle {
  writeFile(data: Uint8Array | string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableFs {
  open(path: string, flags: number, mode: number): Promise<DurableHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: boolean }): Promise<void>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; readonly mtimeMs: number }>;
  readdir(path: string): Promise<string[]>;
}

export interface DurableWriteOptions {
  /** File mode for the new file. Default 0o600. */
  readonly mode?: number;
  /** Rename attempts after the first. Default 6. */
  readonly retries?: number;
  /** Temps older than this are removed before the write. Default 60 s. */
  readonly staleMs?: number;
  /**
   * Whether the write first lists the destination's folder for stale temps of the same destination
   * (default true). The listing costs time in proportion to the folder's size, so a writer whose
   * destinations are fresh and unique (one file per decision) turns it off and sweeps the folder
   * once with `removeStaleTempsIn`.
   */
  readonly sweepStaleTemps?: boolean;
  readonly platform?: string;
  readonly fs?: Partial<DurableFs>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Wall clock for stale-temp age. */
  readonly now?: () => number;
  /** Runs on the flushed temp before the rename, e.g. to apply an owner-only ACL. */
  readonly beforeRename?: (tempPath: string) => Promise<boolean> | boolean;
}

export type DurableWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

export const RETRYABLE_RENAME_CODES: readonly string[] = ['EPERM', 'EBUSY', 'EACCES'];
const TEMP_SUFFIX = '.jtmp';

const nodeFs: DurableFs = {
  open: (path, flags, mode) => open(path, flags, mode),
  rename,
  rm: (path, options) => rm(path, options),
  lstat,
  readdir,
};

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'EUNKNOWN';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `name` is a temp that a writer for `base` (the destination's base name) left behind. */
export function isTempFor(base: string, name: string): boolean {
  const unique = new RegExp(`^\\.${escapeRegExp(base)}\\.\\d+\\.[0-9a-f]+${escapeRegExp(TEMP_SUFFIX)}$`);
  if (unique.test(name)) return true;
  // Legacy fixed names from the pre-v1.2 writers: <base>.tmp and <base>.<label>.tmp.
  if (name === `${base}.tmp`) return true;
  const legacy = new RegExp(`^${escapeRegExp(base)}\\.[A-Za-z0-9_-]{1,64}\\.tmp$`);
  return legacy.test(name);
}

export function tempNameFor(base: string, pid: number, random: string): string {
  return `.${base}.${pid}.${random}${TEMP_SUFFIX}`;
}

/** Removes stale temps for `destination`. Returns the removed paths. Never throws. */
export async function removeStaleTemps(destination: string, options: DurableWriteOptions = {}): Promise<readonly string[]> {
  const api = pathApiFor(options.platform ?? process.platform);
  const fs: DurableFs = { ...nodeFs, ...options.fs };
  const staleMs = options.staleMs ?? 60_000;
  const now = (options.now ?? Date.now)();
  const dir = api.dirname(destination);
  const base = api.basename(destination);
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isTempFor(base, name)) continue;
    const full = api.join(dir, name);
    try {
      const st = await fs.lstat(full);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (now - st.mtimeMs < staleMs) continue;
      await fs.rm(full, { force: true });
      removed.push(full);
    } catch {
      continue;
    }
  }
  return removed;
}

/** A temp this helper's writers made (`.<base>.<pid>.<hex>.jtmp`), for any destination. */
const ANY_UNIQUE_TEMP = /^\..+\.\d+\.[0-9a-f]+\.jtmp$/;

/**
 * Removes every stale temp of this helper's writers in `dir`, whatever its destination: what a write
 * killed part-way leaves behind. One folder listing; never throws. Returns the removed paths.
 */
export async function removeStaleTempsIn(dir: string, options: DurableWriteOptions = {}): Promise<readonly string[]> {
  const api = pathApiFor(options.platform ?? process.platform);
  const fs: DurableFs = { ...nodeFs, ...options.fs };
  const staleMs = options.staleMs ?? 60_000;
  const now = (options.now ?? Date.now)();
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!ANY_UNIQUE_TEMP.test(name)) continue;
    const full = api.join(dir, name);
    try {
      const st = await fs.lstat(full);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (now - st.mtimeMs < staleMs) continue;
      await fs.rm(full, { force: true });
      removed.push(full);
    } catch {
      continue;
    }
  }
  return removed;
}

async function symlinked(fs: DurableFs, path: string): Promise<boolean | 'error'> {
  try {
    return (await fs.lstat(path)).isSymbolicLink();
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? false : 'error';
  }
}

export async function renameWithRetry(
  from: string,
  to: string,
  options: Pick<DurableWriteOptions, 'fs' | 'retries' | 'sleep'> = {},
): Promise<DurableWriteResult> {
  const fs: DurableFs = { ...nodeFs, ...options.fs };
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 6;
  let delay = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return { ok: true };
    } catch (error) {
      const code = errorCode(error);
      if (!RETRYABLE_RENAME_CODES.includes(code) || attempt >= retries) return { ok: false, code };
      await sleep(delay);
      delay *= 2;
    }
  }
}

export async function durableWrite(
  destination: string,
  data: Uint8Array | string,
  options: DurableWriteOptions = {},
): Promise<DurableWriteResult> {
  const api = pathApiFor(options.platform ?? process.platform);
  const fs: DurableFs = { ...nodeFs, ...options.fs };
  if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) {
    return { ok: false, code: 'EINVAL' };
  }
  const dir = api.dirname(destination);
  const base = api.basename(destination);
  const destLink = await symlinked(fs, destination);
  if (destLink !== false) return { ok: false, code: destLink === true ? 'ESYMLINK' : 'ELSTAT' };
  const dirLink = await symlinked(fs, dir);
  if (dirLink !== false) return { ok: false, code: dirLink === true ? 'ESYMLINK' : 'ELSTAT' };
  if (options.sweepStaleTemps !== false) await removeStaleTemps(destination, options);

  const temp = api.join(dir, tempNameFor(base, process.pid, randomBytes(6).toString('hex')));
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let handle: DurableHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(temp, flags, options.mode ?? 0o600);
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.beforeRename !== undefined && !(await options.beforeRename(temp))) {
      await fs.rm(temp, { force: true });
      return { ok: false, code: 'EACL' };
    }
    const renamed = await renameWithRetry(temp, destination, options);
    if (!renamed.ok) {
      await fs.rm(temp, { force: true });
      return renamed;
    }
    return { ok: true };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The temp is removed below.
      }
    }
    if (created) {
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // Only this call's temp is removed.
      }
    }
    return { ok: false, code: errorCode(error) };
  }
}
