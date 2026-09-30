/**
 * Asynchronous line writers for the sidecar log and trace (sidecar concurrency audit P7; owner
 * decision ededdba: "make logging and trace writes asynchronous").
 *
 * - A line is queued in memory and written on the next turn of the event loop, together with every
 *   other line queued by then, by one asynchronous append. At most one write is in flight; lines
 *   queued meanwhile go in the next one. The request path never waits on the disk.
 * - Memory is bounded: past `maxPendingBytes` a line is dropped and counted, never blocking.
 * - Rotation (the log) follows a byte counter seeded once from the file size, not a stat per line.
 * - `flushSync` writes what is queued at once, for shutdown and for a trace file that is being
 *   closed; a write in flight then finishes first on the libuv pool.
 */
import { appendFile, appendFileSync, rename, renameSync, statSync, unlink, unlinkSync, write, writeSync } from 'node:fs';

/** Queued bytes past which a line is dropped (and counted). */
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface LineWriter {
  /** Queues one line (with its newline). False when it was dropped. */
  write(line: string): boolean;
  /** Writes everything queued now, synchronously. */
  flushSync(): void;
  /** Lines dropped: the queue was full, or the disk refused a write. */
  dropped(): number;
  /** Bytes the file holds as far as this writer knows (its counter). */
  size(): number;
  /**
   * Writes what is queued, then runs `fn` once no write is in flight (at once, or when the one in
   * flight completes), so a file descriptor is never closed under a pending write.
   */
  drainThen(fn: () => void): void;
}

interface Target {
  /** Starts an asynchronous write of `chunk`; calls back with success. */
  writeAsync(chunk: string, done: (ok: boolean) => void): void;
  writeSync(chunk: string): boolean;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function createWriter(target: Target, initialSize: number, options: { readonly maxPendingBytes?: number; readonly rotate?: (size: number, incoming: number) => boolean }): LineWriter {
  const maxPending = options.maxPendingBytes ?? MAX_PENDING_BYTES;
  let queue: string[] = [];
  let queuedBytes = 0;
  let inFlight = false;
  let scheduled = false;
  let dropped = 0;
  let size = initialSize;
  let waiters: (() => void)[] = [];

  const takeChunk = (): { readonly chunk: string; readonly lines: number; readonly bytes: number } | undefined => {
    if (queue.length === 0) return undefined;
    const chunk = queue.join('');
    const taken = { chunk, lines: queue.length, bytes: queuedBytes };
    queue = [];
    queuedBytes = 0;
    return taken;
  };

  const flush = (): void => {
    scheduled = false;
    if (inFlight) return;
    const taken = takeChunk();
    if (taken === undefined) return;
    if (options.rotate?.(size, taken.bytes) === true) size = 0;
    inFlight = true;
    target.writeAsync(taken.chunk, (ok) => {
      inFlight = false;
      if (ok) size += taken.bytes;
      else dropped += taken.lines;
      if (waiters.length > 0) {
        // A closing file: write the rest now, then let the closer go.
        flushNow();
        const run = waiters;
        waiters = [];
        for (const fn of run) fn();
        return;
      }
      if (queue.length > 0) schedule();
    });
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(flush);
  };

  const flushNow = (): void => {
    const taken = takeChunk();
    if (taken === undefined) return;
    if (options.rotate?.(size, taken.bytes) === true) size = 0;
    if (target.writeSync(taken.chunk)) size += taken.bytes;
    else dropped += taken.lines;
  };

  return {
    write(line: string): boolean {
      const bytes = byteLength(line);
      if (queuedBytes + bytes > maxPending) {
        dropped += 1;
        return false;
      }
      queue.push(line);
      queuedBytes += bytes;
      schedule();
      return true;
    },
    flushSync(): void {
      flushNow();
    },
    drainThen(fn: () => void): void {
      if (!inFlight) {
        flushNow();
        fn();
        return;
      }
      waiters.push(fn);
    },
    dropped: () => dropped,
    size: () => size,
  };
}

/** The file-system calls the log writer makes; a test replaces them to make a rename fail. */
export interface LogFs {
  readonly appendFile: typeof appendFile;
  readonly appendFileSync: typeof appendFileSync;
  readonly rename: typeof rename;
  readonly renameSync: typeof renameSync;
  readonly statSync: typeof statSync;
  readonly unlink: typeof unlink;
  readonly unlinkSync: typeof unlinkSync;
}

const NODE_FS: LogFs = { appendFile, appendFileSync, rename, renameSync, statSync, unlink, unlinkSync };

/** A rename onto an existing `.1` fails on Windows while a scanner or another handle holds it. */
const RETRIABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Rename attempts before the old `.1` is replaced instead; the waits between are 5, 10, 20, 40 ms. */
export const ROTATE_RENAME_TRIES = 5;
const backoffMs = (attempt: number): number => 5 * 2 ** attempt;
const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The sidecar log: appends to `path` (owner-only), and moves it to `<path>.1` once it would pass
 * `rotateBytes`. The rename happens before the chunk that would cross the limit is written.
 *
 * A rename that fails with EPERM, EBUSY or EACCES is tried again a few times, then the old `.1` is
 * removed and the rename tried once more. Only if that also fails is the chunk appended to the
 * un-rotated file, and the rotation stays pending for the next write: a rotation is never skipped
 * silently and a line is never dropped or moved. A missing source (ENOENT) is nothing to rotate.
 */
export function pathLineWriter(path: string, rotateBytes: number, options: { readonly maxPendingBytes?: number; readonly fs?: Partial<LogFs> } = {}): LineWriter {
  const fs: LogFs = { ...NODE_FS, ...options.fs };
  let initial = 0;
  try {
    initial = fs.statSync(path).size;
  } catch {
    initial = 0;
  }
  const old = `${path}.1`;
  let rotatePending = false;
  const target: Target = {
    writeAsync(chunk, done) {
      const append = (): void => {
        fs.appendFile(path, chunk, { mode: 0o600 }, (error) => done(error === null || error === undefined));
      };
      if (!rotatePending) return append();
      rotatePending = false;
      const attempt = (n: number): void => {
        fs.rename(path, old, (error) => {
          if (error === null || error === undefined || codeOf(error) === 'ENOENT') return append();
          if (!RETRIABLE.has(codeOf(error) ?? '')) return append();
          if (n + 1 < ROTATE_RENAME_TRIES) {
            setTimeout(() => attempt(n + 1), backoffMs(n));
            return;
          }
          // Replace: drop the old `.1`, then one more rename.
          fs.unlink(old, () => {
            fs.rename(path, old, (last) => {
              if (last !== null && last !== undefined && codeOf(last) !== 'ENOENT') rotatePending = true;
              append();
            });
          });
        });
      };
      attempt(0);
    },
    writeSync(chunk) {
      try {
        if (rotatePending) {
          rotatePending = false;
          let rotated = false;
          for (let n = 0; n < ROTATE_RENAME_TRIES && !rotated; n += 1) {
            try {
              fs.renameSync(path, old);
              rotated = true;
            } catch (error) {
              const code = codeOf(error);
              if (code === 'ENOENT' || !RETRIABLE.has(code ?? '')) {
                rotated = true; // nothing to rotate, or not a failure a retry can mend
              } else if (n + 1 < ROTATE_RENAME_TRIES) sleepSync(backoffMs(n));
            }
          }
          if (!rotated) {
            try {
              fs.unlinkSync(old);
            } catch {
              // no old file to replace
            }
            try {
              fs.renameSync(path, old);
            } catch (error) {
              if (codeOf(error) !== 'ENOENT') rotatePending = true;
            }
          }
        }
        fs.appendFileSync(path, chunk, { mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },
  };
  return createWriter(target, initial, {
    ...(options.maxPendingBytes !== undefined ? { maxPendingBytes: options.maxPendingBytes } : {}),
    rotate: (size, incoming) => {
      if (size > 0 && size + incoming > rotateBytes) {
        rotatePending = true;
        return true;
      }
      return false;
    },
  });
}

/** A trace file already opened (owner-only, O_APPEND, no symlink) by its caller. */
export function fdLineWriter(fd: number, initialSize: number, options: { readonly maxPendingBytes?: number } = {}): LineWriter {
  const target: Target = {
    writeAsync(chunk, done) {
      write(fd, chunk, (error) => done(error === null || error === undefined));
    },
    writeSync(chunk) {
      try {
        writeSync(fd, chunk);
        return true;
      } catch {
        return false;
      }
    },
  };
  return createWriter(target, initialSize, options);
}
