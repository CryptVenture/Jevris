import { readFileSync } from 'node:fs';

/**
 * Reads of a file another Jevris process may be writing or replacing (a pid file, the endpoint,
 * a lock, a journal, a settings file). On Windows a read meets EPERM, EBUSY or EACCES for a
 * moment while the writer, a scanner or an indexer holds the file; a reader that takes that for
 * "absent" or "unreadable" reports a running sidecar as not running (windows-latest, 84ccf26,
 * the same class as the test failure EBUSY in security-hook-e2e). These helpers retry a
 * transient error a few times with a short backoff (5, 10, 20, 40 ms: a hook's budget is 900 ms)
 * and then let the last error through, so every caller's own handling of a failed read is kept.
 */

/** Error codes that mean "try again in a moment". */
export const TRANSIENT_READ_CODES: readonly string[] = ['EPERM', 'EBUSY', 'EACCES'];
/** Attempts before the last error is let through. */
export const SHARED_READ_TRIES = 5;

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (Reflect.get(error, 'code') as string | undefined) : undefined);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `attempt`; a transient error is retried with backoff, any other error (ENOENT too) is thrown at once. */
export function retryTransientSync<T>(attempt: () => T, pause: (ms: number) => void = sleepSync): T {
  for (let n = 0; ; n += 1) {
    try {
      return attempt();
    } catch (error) {
      if (n + 1 >= SHARED_READ_TRIES || !TRANSIENT_READ_CODES.includes(codeOf(error) ?? '')) throw error;
      pause(5 * 2 ** n);
    }
  }
}

/** readFileSync(path, 'utf8') that retries a transient error. `read` and `pause` are test seams. */
export function readSharedFileSync(path: string, encoding: 'utf8', read: (path: string, encoding: 'utf8') => string = readFileSync, pause?: (ms: number) => void): string {
  return retryTransientSync(() => read(path, encoding), pause);
}
