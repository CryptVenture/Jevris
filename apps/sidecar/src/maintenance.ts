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
 *
 * Stopping the worker never cuts it off inside the load of the SQLite addon (see "the native load"
 * below): a thread ended there takes the whole sidecar down with SIGABRT.
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
      /** Each delete chunk that removed rows: its rows and ms (see the store's SweepResult). */
      readonly chunks: readonly { readonly rows: number; readonly ms: number }[];
      readonly where: 'worker' | 'inline';
    }
  | { readonly ok: false; readonly reason: string; readonly where: 'worker' | 'inline' };

interface WorkerData {
  readonly jevrisMaintenance: 1;
  readonly job: SweepJob;
  /** The native-load state both threads read and write (see "the native load"). */
  readonly load: SharedArrayBuffer;
}

// ------------------------------------------------------------------ the native load

/**
 * Why a stop waits for the worker's native load, and never ends the thread inside it.
 *
 * `worker.terminate()` that lands while the worker is loading the SQLite addon (the first
 * `require('better-sqlite3')`, inside `openMaintenanceStore`) aborts the whole process: the addon's
 * initialiser meets the pending termination, node-addon-api cannot build its error and Node prints
 * `FATAL ERROR: Error::New napi_get_last_error_info` and raises SIGABRT. The window is a few
 * milliseconds on an idle host and much longer on a loaded one, where the worker's thread waits for
 * a CPU or for pages of the addon. A sidecar stopped within the first second of its life (a start
 * followed at once by `jevris sidecar stop`, `uninstall` or `data delete`) is still booting the
 * worker, so it died that way before it removed its endpoint file, and the next `jevris doctor`
 * showed "not-running" with a last run that "ended without cleaning up" until something started a
 * sidecar again.
 *
 * Both threads share one Int32 and move it with Atomics, so neither needs the other's event loop:
 *   idle -> loading   the worker, just before the load (it did not see `declined`)
 *   loading -> loaded the worker, when `openMaintenanceStore` returned (whatever it returned)
 *   idle -> declined  the sidecar, when it stops a worker that has not begun the load: the worker
 *                     never starts it, and ending the thread any time is safe
 * A stop that finds the worker `loading` waits (at most NATIVE_LOAD_WAIT_MS) for `loaded`, then
 * ends the thread: the sweep after the load is the design (its open chunk rolls back).
 */
export const NATIVE_LOAD = { idle: 0, loading: 1, loaded: 2, declined: 3 } as const;
/** The most a stop waits for a worker that is inside the native load; a load that takes longer is ended anyway. */
export const NATIVE_LOAD_WAIT_MS = 5000;
const NATIVE_LOAD_POLL_MS = 2;

function loadState(shared: unknown): Int32Array | undefined {
  return shared instanceof SharedArrayBuffer && shared.byteLength >= 4 ? new Int32Array(shared) : undefined;
}

/**
 * Worker side: call just before the first thing that loads the addon. False when the sidecar has
 * already asked the worker to stop: do not load it, and let the thread end. With no shared state (a
 * worker started by older code) it is true and nothing is recorded.
 */
export function enterNativeLoad(shared: unknown): boolean {
  const state = loadState(shared);
  if (state === undefined) return true;
  return Atomics.compareExchange(state, 0, NATIVE_LOAD.idle, NATIVE_LOAD.loading) !== NATIVE_LOAD.declined;
}

/** Worker side: call when the load is over, whether it succeeded or not. */
export function leaveNativeLoad(shared: unknown): void {
  const state = loadState(shared);
  if (state !== undefined) Atomics.store(state, 0, NATIVE_LOAD.loaded);
}

/**
 * Sidecar side: ends the worker thread without ever ending it inside the native load, unless the
 * load outlasts `loadWaitMs`. Resolves when the thread has been told to end. `exited` says the
 * worker has already gone.
 */
async function endWorker(worker: Worker, shared: SharedArrayBuffer, exited: () => boolean, loadWaitMs: number): Promise<void> {
  const state = new Int32Array(shared);
  if (Atomics.compareExchange(state, 0, NATIVE_LOAD.idle, NATIVE_LOAD.declined) === NATIVE_LOAD.loading) {
    const until = Date.now() + loadWaitMs;
    while (Atomics.load(state, 0) === NATIVE_LOAD.loading && !exited() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, NATIVE_LOAD_POLL_MS));
  }
  try {
    await worker.terminate();
  } catch {
    // already gone
  }
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
  return { ok: true, removed: { ...result.removed }, rawFiles: result.rawFiles, vacuumed: result.vacuumed, longestWriteMs: result.longestWriteMs ?? 0, chunks: result.chunks ?? [], where };
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
    // Declined: the sidecar is stopping and has not waited for a load, so none begins and the thread ends.
    if (!enterNativeLoad(data.load)) return;
    let store: ReturnType<StoreModule['openMaintenanceStore']>;
    try {
      store = api.openMaintenanceStore({ path: data.job.path, hostScope: data.job.hostScope });
    } finally {
      leaveNativeLoad(data.load);
    }
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
  /**
   * Stops the worker (sidecar shutdown); its open chunk rolls back. A worker that is loading the
   * SQLite addon is waited for first, so the stop never aborts the process (see "the native load").
   */
  stop(): Promise<void>;
}

/**
 * Starts the sweep in a worker running `script` (the sidecar entry). Answers the worker's outcome,
 * or a refusal: MAINTENANCE_WORKER_UNAVAILABLE (it did not start), MAINTENANCE_WORKER_FAILED (it
 * exited without an answer) or MAINTENANCE_WORKER_TIMEOUT. A stop waits at most `loadWaitMs` for a
 * worker that is loading the SQLite addon (see "the native load").
 */
export function sweepInWorker(script: string | URL, job: SweepJob, timeoutMs: number = SWEEP_WORKER_TIMEOUT_MS, loadWaitMs: number = NATIVE_LOAD_WAIT_MS): RunningSweep {
  let worker: Worker;
  const load = new SharedArrayBuffer(4);
  try {
    worker = new Worker(script, { workerData: { jevrisMaintenance: 1, job, load } satisfies WorkerData });
  } catch {
    return { done: Promise.resolve({ ok: false, reason: 'MAINTENANCE_WORKER_UNAVAILABLE', where: 'worker' }), stop: async () => undefined };
  }
  let settle!: (outcome: SweepOutcome) => void;
  const done = new Promise<SweepOutcome>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let exited = false;
  let ending: Promise<void> | undefined;
  /** Ends the thread once, never inside the native load. */
  const end = (): Promise<void> => (ending ??= endWorker(worker, load, () => exited, loadWaitMs));
  const finish = (outcome: SweepOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(outcome);
  };
  const timer = setTimeout(() => {
    finish({ ok: false, reason: 'MAINTENANCE_WORKER_TIMEOUT', where: 'worker' });
    void end();
  }, timeoutMs);
  timer.unref();
  worker.on('message', (message: unknown) => {
    if (isRecord(message) && typeof message['ok'] === 'boolean') finish(message as unknown as SweepOutcome);
    else finish({ ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' });
  });
  worker.on('error', () => finish({ ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' }));
  worker.on('exit', () => {
    exited = true;
    finish({ ok: false, reason: 'MAINTENANCE_WORKER_FAILED', where: 'worker' });
  });
  return {
    done,
    async stop() {
      finish({ ok: false, reason: 'MAINTENANCE_STOPPED', where: 'worker' });
      await end();
    },
  };
}
