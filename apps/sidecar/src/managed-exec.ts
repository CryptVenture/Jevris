/**
 * Windows managed-policy reads without a process spawn on most requests (sidecar concurrency audit
 * P8; owner decision ededdba: "cache the Windows kill-switch registry read").
 *
 * The enterprise kill switch and managed policy are read on every request (GOV-05). On Windows
 * each read runs `reg.exe query` (and `icacls` for an admin-owned file) through the `exec` port of
 * @jevris/cli/enterprise-policy, which blocked the event loop for the whole spawn. The sidecar
 * passes this caching port instead:
 *
 * - An answer younger than MANAGED_READ_TTL_MS (1 s) is served as it is.
 * - An older one, up to MANAGED_READ_MAX_STALE_MS (5 s), is served too, and one refresh starts
 *   with an asynchronous `execFile`. Under steady traffic a change lands within about a second
 *   and no request waits for a process.
 * - The first read of a command, and a read after more than 5 s without one, runs the command
 *   synchronously, so an answer is never older than 5 s (the kill switch never fails open on a
 *   stale cache after an idle spell).
 * - A refresh that could not run keeps the last real answer; the next read past the ttl tries
 *   again.
 */
import { execFile, spawnSync } from 'node:child_process';

export type ExecResult = { readonly status: number | null; readonly stdout: string };
export type SyncExec = (command: string, args: readonly string[]) => ExecResult;
export type AsyncExec = (command: string, args: readonly string[], done: (result: ExecResult) => void) => void;

export const MANAGED_READ_TTL_MS = 1000;
export const MANAGED_READ_MAX_STALE_MS = 5000;
const EXEC_TIMEOUT_MS = 5000;

export interface CachedExecOptions {
  readonly ttlMs?: number;
  readonly maxStaleMs?: number;
  readonly now?: () => number;
  readonly runSync?: SyncExec;
  readonly runAsync?: AsyncExec;
}

const defaultSync: SyncExec = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: EXEC_TIMEOUT_MS });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
};

/** Exit status from an execFile error: its numeric code, or null when the process did not run. */
export function execStatus(error: unknown): number | null {
  if (error === null || error === undefined) return 0;
  const code: unknown = typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'number' ? code : null;
}

const defaultAsync: AsyncExec = (command, args, done) => {
  try {
    execFile(command, [...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: EXEC_TIMEOUT_MS }, (error, stdout) => {
      done({ status: execStatus(error), stdout: typeof stdout === 'string' ? stdout : '' });
    });
  } catch {
    done({ status: null, stdout: '' });
  }
};

/** A caching `exec` port for readManagedKillSwitch and readManagedPolicy (see the header). */
export function cachedExec(options: CachedExecOptions = {}): SyncExec {
  const ttlMs = options.ttlMs ?? MANAGED_READ_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? MANAGED_READ_MAX_STALE_MS;
  const now = options.now ?? Date.now;
  const runSync = options.runSync ?? defaultSync;
  const runAsync = options.runAsync ?? defaultAsync;
  const cache = new Map<string, { result: ExecResult; atMs: number; refreshing: boolean }>();
  return (command: string, args: readonly string[]): ExecResult => {
    const key = JSON.stringify([command, ...args]);
    const hit = cache.get(key);
    const at = now();
    if (hit === undefined || at - hit.atMs > maxStaleMs) {
      const result = runSync(command, args);
      cache.set(key, { result, atMs: at, refreshing: false });
      return result;
    }
    if (at - hit.atMs > ttlMs && !hit.refreshing) {
      hit.refreshing = true;
      runAsync(command, args, (result) => {
        hit.refreshing = false;
        // A refresh that could not run (no status) keeps the last real answer.
        if (result.status !== null) {
          hit.result = result;
          hit.atMs = now();
        }
      });
    }
    return hit.result;
  };
}

let shared: { readonly exec?: SyncExec } | undefined;

/**
 * The options the sidecar passes to the managed-policy readers: on Windows one shared caching
 * port; elsewhere nothing, since the readers then use files only and start no process.
 */
export function sidecarManagedOptions(platform: string = process.platform): { readonly exec?: SyncExec } {
  if (platform !== 'win32') return {};
  shared ??= { exec: cachedExec() };
  return shared;
}
