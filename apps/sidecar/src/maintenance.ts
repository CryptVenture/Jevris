/**
 * Store maintenance off the request loop (sidecar concurrency audit P10; owner decision ededdba:
 * "give the store a second connection in a worker thread for maintenance").
 *
 * The retention sweep runs in a worker thread with its own SQLite connection (the store's
 * `openMaintenanceStore`, which only this process may open, and only while it holds the writer
 * lock). The sweep deletes in chunked transactions bounded in time (about SWEEP_CHUNK_MS each) and
 * returns free pages in steps sized the same way, sleeping SWEEP_PAUSE_MS between writes. The
 * sidecar's store writes are BEGIN IMMEDIATE, so one that meets a chunk waits on SQLite's busy
 * handler for about one chunk plus one retry step (worst case roughly 30 ms), never busy_timeout,
 * and the event loop never runs the sweep.
 *
 * The worker is the sidecar's own entry file started again as a worker (main.ts checks
 * `workerData`), so the bundle needs no second entry. Without a worker script (an in-process
 * daemon in tests) or when the worker cannot start, the caller runs the same chunked sweep inline.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

type StoreModule = typeof import('@jevris/store');

/** Most rows per delete transaction; the store shrinks chunks that take longer than SWEEP_CHUNK_MS. */
export const SWEEP_CHUNK_ROWS = 500;
/** Target time of one maintenance write transaction. */
export const SWEEP_CHUNK_MS = 8;
/**
 * The worker sleeps this long between writes. SQLite's busy handler retries after 1, 2, 5, 10, 15
 * and 20 ms, so a sidecar write that met a chunk finds the lock free in this gap: its worst wait
 * is about one chunk plus one retry step, not busy_timeout.
 */
export const SWEEP_PAUSE_MS = 20;
/** A sweep that has not answered by then is stopped; its open chunk rolls back. */
export const SWEEP_WORKER_TIMEOUT_MS = 10 * 60_000;

export interface SweepJob {
  readonly path: string;
  readonly hostScope: string;
  readonly policy: { readonly rawArtifactRetentionDays: number; readonly decisionRetentionDays: number };
  readonly nowMs: number;
  readonly rawDir: string;
}

export type SweepOutcome =
  | {
      readonly ok: true;
      readonly removed: { readonly [table: string]: number };
      readonly rawFiles: number;
      readonly vacuumed: boolean;
      /** The longest single maintenance write, in ms (see the store's SweepResult). */
      readonly longestWriteMs: number;
      readonly where: 'worker' | 'inline';
    }
  | { readonly ok: false; readonly reason: string; readonly where: 'worker' | 'inline' };

interface WorkerData {
  readonly jevrisMaintenance: 1;
  readonly job: SweepJob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True in a worker thread started by `sweepInWorker`. */
export function isMaintenanceWorker(): boolean {
  return !isMainThread && isRecord(workerData) && workerData['jevrisMaintenance'] === 1;
}

/** A synchronous sleep for the worker thread (never called on the sidecar's event loop). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sweepOptions(job: SweepJob, where: 'worker' | 'inline'): Parameters<StoreModule['sweepRetention']>[1] {
  // Inline there is no other connection to leave the lock to, so no pause.
  const pause = where === 'worker' ? { pause: () => sleepSync(SWEEP_PAUSE_MS) } : {};
  return { policy: job.policy, nowMs: job.nowMs, rawDir: job.rawDir, chunkRows: SWEEP_CHUNK_ROWS, chunkMs: SWEEP_CHUNK_MS, ...pause, vacuum: 'incremental' };
}

function outcomeOf(result: ReturnType<StoreModule['sweepRetention']>, where: 'worker' | 'inline'): SweepOutcome {
  if (!result.ok) return { ok: false, reason: result.reason, where };
  return { ok: true, removed: { ...result.removed }, rawFiles: result.rawFiles, vacuumed: result.vacuumed, longestWriteMs: result.longestWriteMs ?? 0, where };
}

/** The same chunked sweep on the caller's own connection (no worker available). */
export function sweepInline(api: StoreModule, store: Parameters<StoreModule['sweepRetention']>[0], job: SweepJob): SweepOutcome {
  return outcomeOf(api.sweepRetention(store, sweepOptions(job, 'inline')), 'inline');
}

/** Worker side: open the second connection, sweep, close, answer once. */
export async function runMaintenanceWorker(): Promise<void> {
  const data = workerData as WorkerData;
  const port = parentPort;
  if (port === null) return;
  let answer: SweepOutcome;
  try {
    const api: StoreModule = await import('@jevris/store');
    const store = api.openMaintenanceStore({ path: data.job.path, hostScope: data.job.hostScope });
    if (!store.ok) {
      answer = { ok: false, reason: store.reason, where: 'worker' };
    } else {
      try {
        answer = outcomeOf(api.sweepRetention(store, sweepOptions(data.job, 'worker')), 'worker');
      } finally {
        api.closeStore(store);
      }
    }
  } catch {
    answer = { ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' };
  }
  port.postMessage(answer);
}

export interface RunningSweep {
  readonly done: Promise<SweepOutcome>;
  /** Stops the worker (sidecar shutdown); its open chunk rolls back. */
  stop(): Promise<void>;
}

/**
 * Starts the sweep in a worker running `script` (the sidecar entry). Answers the worker's outcome,
 * or a refusal: MAINTENANCE_WORKER_UNAVAILABLE (it did not start), MAINTENANCE_WORKER_FAILED (it
 * exited without an answer) or MAINTENANCE_WORKER_TIMEOUT.
 */
export function sweepInWorker(script: string | URL, job: SweepJob, timeoutMs: number = SWEEP_WORKER_TIMEOUT_MS): RunningSweep {
  let worker: Worker;
  try {
    worker = new Worker(script, { workerData: { jevrisMaintenance: 1, job } satisfies WorkerData });
  } catch {
    return { done: Promise.resolve({ ok: false, reason: 'MAINTENANCE_WORKER_UNAVAILABLE', where: 'worker' }), stop: async () => undefined };
  }
  let settle!: (outcome: SweepOutcome) => void;
  const done = new Promise<SweepOutcome>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (outcome: SweepOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(outcome);
  };
  const timer = setTimeout(() => {
    finish({ ok: false, reason: 'MAINTENANCE_WORKER_TIMEOUT', where: 'worker' });
    void worker.terminate();
  }, timeoutMs);
  timer.unref();
  worker.on('message', (message: unknown) => {
    if (isRecord(message) && typeof message['ok'] === 'boolean') finish(message as unknown as SweepOutcome);
    else finish({ ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' });
  });
  worker.on('error', () => finish({ ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' }));
  worker.on('exit', () => finish({ ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' }));
  return {
    done,
    async stop() {
      finish({ ok: false, reason: 'MAINTENANCE_STOPPED', where: 'worker' });
      try {
        await worker.terminate();
      } catch {
        // already gone
      }
    },
  };
}
