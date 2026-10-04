import { unlinkSync } from 'node:fs';
import { retryTransientSync } from '@jevris/platform';

/** The calls `removeLockFile` makes; a test replaces them. */
export interface LockFileDeps {
  readonly unlinkSync?: (path: string) => void;
  readonly pause?: (ms: number) => void;
}

/**
 * Removes a lock file of the sidecar (the spawn lock a caller takes before it starts a sidecar, the
 * daemon lock a sidecar holds). Several processes read and remove these files at the same moment,
 * and on Windows an unlink meets EPERM, EBUSY or EACCES while another process has the file open
 * (a reader checking whether the lock is stale, a scanner, an indexer). Such an error is retried a
 * few times with a short wait (5, 10, 20, 40 ms) before the lock is treated as still held, so a
 * transient error does not leave a stale lock to be judged by its age. When the first unlink works,
 * as it does everywhere else, nothing waits and nothing more runs.
 *
 * Returns true when the file was removed. Any other outcome (the file stays after the retries, or
 * it was already gone, or the error is another one) is false, which the callers treat as before:
 * not fatal, and the lock is left to its owner or to its age.
 */
export function removeLockFile(path: string, deps: LockFileDeps = {}): boolean {
  const unlink = deps.unlinkSync ?? unlinkSync;
  try {
    retryTransientSync(() => unlink(path), deps.pause);
    return true;
  } catch {
    return false;
  }
}
