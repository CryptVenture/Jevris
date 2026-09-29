import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Admission and background scheduling for the sidecar (concurrency audit 07aa380: P4, K1, K2;
 * owner decisions ededdba). One event loop serves every client, so priority is by admission:
 *
 * - Hot and background requests have separate pools. A background op never takes a hot slot, and
 *   a full pool answers BUSY at once instead of letting the client time out.
 * - A request that outlives its deadline keeps running (its effect may be half done), but it
 *   gives back its hot slot and holds an overrun slot until it settles. Overrun work counts
 *   against the background pool, and when it reaches the hot pool's size, new hot requests are
 *   answered BUSY: the loop is saturated, and a prompt BUSY is better than a late DEADLINE.
 * - No shedding (owner): observe-only background work is never dropped or coalesced. It runs
 *   through a bounded executor, FIFO per key (workspace, session, agent, subscriber), and starts
 *   only when no hot request is in flight, or when nothing else of its own runs, so it always
 *   progresses. Past a memory bound, queued work spills to a spool file (mode 0600) and comes
 *   back in order; a spool left by a stopped sidecar is run at the next start.
 */

export type AdmissionClass = 'hot' | 'background';

export interface AdmissionLimits {
  readonly hot: number;
  readonly background: number;
  /**
   * Hot slots kept for the answer lane (owner decision ededdba, D's K3): a SessionStart restore, a
   * Stop reminder or a PreCompact capsule is admitted from these when the hot pool is full or the
   * loop is saturated with overrun work, so load never turns its answer into BUSY.
   */
  readonly answer: number;
}

export const DEFAULT_ADMISSION: AdmissionLimits = { hot: 24, background: 8, answer: 8 };

export interface AdmitOptions {
  /** The request is on the answer lane (a MAC'd frame flag the service has checked). */
  readonly answer?: boolean;
}

export interface AdmissionSlot {
  readonly cls: AdmissionClass;
  /** The request is answered and its work is done: the slot is free. */
  release(): void;
  /** The request is answered but its work runs on: the slot frees, and the work holds an overrun slot until it settles. */
  overrun(work: Promise<unknown>): void;
}

export interface AdmissionCounts {
  readonly hot: number;
  readonly background: number;
  readonly overrun: number;
  /** Answer-lane requests holding one of the kept slots. */
  readonly answer: number;
}

export interface Admission {
  readonly limits: AdmissionLimits;
  /** A slot, or undefined when the class is full (the caller answers BUSY). */
  admit(cls: AdmissionClass, options?: AdmitOptions): AdmissionSlot | undefined;
  counts(): AdmissionCounts;
  /** Runs after any slot or overrun settles (the executor starts its next job). */
  onIdle(listener: () => void): void;
  /** The overrun work still running (for a drain at close). */
  overrunWork(): readonly Promise<unknown>[];
}

export function createAdmission(input: Partial<AdmissionLimits> = {}): Admission {
  const limits: AdmissionLimits = {
    hot: positive(input.hot, DEFAULT_ADMISSION.hot),
    background: positive(input.background, DEFAULT_ADMISSION.background),
    answer: positive(input.answer, DEFAULT_ADMISSION.answer),
  };
  let hot = 0;
  let background = 0;
  let answer = 0;
  const overrun = new Set<Promise<unknown>>();
  const listeners: (() => void)[] = [];
  const settled = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener never breaks admission.
      }
    }
  };
  return {
    limits,
    admit(cls, options = {}) {
      // An answer-lane request takes an ordinary hot slot while there is one, else a kept slot.
      let pool: 'hot' | 'background' | 'answer';
      if (cls === 'hot') {
        if (hot < limits.hot && overrun.size < limits.hot) pool = 'hot';
        else if (options.answer === true && answer < limits.answer) pool = 'answer';
        else return undefined;
      } else {
        if (background + overrun.size >= limits.background) return undefined;
        pool = 'background';
      }
      if (pool === 'hot') hot += 1;
      else if (pool === 'answer') answer += 1;
      else background += 1;
      let done = false;
      const free = (): boolean => {
        if (done) return false;
        done = true;
        if (pool === 'hot') hot -= 1;
        else if (pool === 'answer') answer -= 1;
        else background -= 1;
        return true;
      };
      return {
        cls,
        release() {
          if (free()) settled();
        },
        overrun(work) {
          if (!free()) return;
          const tail = work.then(
            () => undefined,
            () => undefined,
          );
          overrun.add(tail);
          void tail.finally(() => {
            overrun.delete(tail);
            settled();
          });
          settled();
        },
      };
    },
    counts: () => ({ hot, background, overrun: overrun.size, answer }),
    onIdle(listener) {
      listeners.push(listener);
    },
    overrunWork: () => [...overrun],
  };
}

// ---------------------------------------------------------------- background executor

export interface BackgroundJob {
  /** FIFO key: jobs of one key run one at a time, in order. */
  readonly key: string;
  /** A short name for traces (a subscriber name). */
  readonly label: string;
  /** Estimated memory held while the job waits in memory. */
  readonly bytes: number;
  run(): Promise<unknown>;
  /** The job as text for the spool, or undefined when it cannot be spooled (it stays in memory). */
  spool?(): string | undefined;
}

export interface ExecutorEvent {
  readonly event: 'job-spooled' | 'job-failed' | 'spool-unreadable' | 'spool-write-failed';
  readonly key: string;
  readonly label: string;
}

export interface ExecutorOptions {
  /** At most this many background jobs (held work included) run at once. */
  readonly concurrency?: number;
  /** Queued jobs kept in memory up to this many bytes; past it, jobs go to the spool. */
  readonly memoryBytes?: number;
  /** Whether a hot request is in flight: new background work waits while one is, unless nothing background runs. */
  readonly hotBusy: () => boolean;
  /** The spool folder (created mode 0700); without it every job stays in memory. */
  readonly spoolDir?: string;
  /** Turns a spooled job's text back into a job; undefined when it cannot be revived. */
  readonly revive?: (text: string) => BackgroundJob | undefined;
  readonly onEvent?: (event: ExecutorEvent) => void;
}

export interface ExecutorDepth {
  readonly running: number;
  readonly held: number;
  readonly queued: number;
  readonly spooled: number;
}

export interface BackgroundExecutor {
  /** Queues the jobs a stopped sidecar left in the spool (call once the jobs can be revived); returns how many. */
  recoverSpool(): number;
  /** Queues a job behind its key's earlier work; `spooled` when it went to the spool. */
  enqueue(job: BackgroundJob): 'queued' | 'spooled';
  /** Work already running for a key (a subscriber past its slice): later jobs of the key wait for it, and it counts toward concurrency. */
  hold(key: string, label: string, work: Promise<unknown>): void;
  /** True while the key has work queued, spooled, running or held. */
  pending(key: string): boolean;
  /** Resolves true when the key has nothing pending, false when the signal aborts first. */
  settled(key: string, signal?: AbortSignal): Promise<boolean>;
  /** Tries to start queued work (after a hot request finishes). */
  kick(): void;
  depth(): ExecutorDepth;
  /** Waits up to ms for every job to finish; queued jobs keep running, spooled ones stay spooled. */
  drain(ms: number): Promise<void>;
  /** Stops starting jobs; what is queued in memory is spooled when it can be, so the next start runs it. */
  close(): void;
}

interface Entry {
  readonly seq: number;
  readonly key: string;
  readonly label: string;
  readonly bytes: number;
  job?: BackgroundJob;
  spoolFile?: string;
}

const SPOOL_SUFFIX = '.job';
const SPOOL_NAME = /^(\d{16})-(\d{6})\.job$/;

export function createBackgroundExecutor(options: ExecutorOptions): BackgroundExecutor {
  const concurrency = positive(options.concurrency, 4);
  const memoryBytes = positive(options.memoryBytes, 16 * 1024 * 1024);
  const queues = new Map<string, Entry[]>();
  const busyKeys = new Map<string, number>();
  const waiters = new Map<string, (() => void)[]>();
  const inFlight = new Set<Promise<unknown>>();
  let running = 0;
  let held = 0;
  let queued = 0;
  let spooled = 0;
  let memory = 0;
  let seq = 0;
  let closed = false;
  let scheduled = false;
  const bootTag = String(Date.now()).padStart(16, '0');

  const emit = (event: ExecutorEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Tracing never breaks the executor.
    }
  };

  const keyPending = (key: string): boolean => (queues.get(key)?.length ?? 0) > 0 || (busyKeys.get(key) ?? 0) > 0;

  const wake = (key: string): void => {
    if (keyPending(key)) return;
    const list = waiters.get(key);
    if (list === undefined) return;
    waiters.delete(key);
    for (const resolve of list) resolve();
  };

  const markBusy = (key: string, delta: number): void => {
    const next = (busyKeys.get(key) ?? 0) + delta;
    if (next <= 0) busyKeys.delete(key);
    else busyKeys.set(key, next);
  };

  const track = (key: string, work: Promise<unknown>, kind: 'run' | 'hold'): void => {
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(tail);
    void tail.finally(() => {
      inFlight.delete(tail);
      if (kind === 'run') running -= 1;
      else held -= 1;
      markBusy(key, -1);
      wake(key);
      schedule();
    });
  };

  const spoolDir = options.spoolDir;
  const writeSpool = (entry: Entry, text: string): boolean => {
    if (spoolDir === undefined) return false;
    try {
      mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
      const file = join(spoolDir, `${bootTag}-${String(entry.seq).padStart(6, '0')}${SPOOL_SUFFIX}`);
      writeFileSync(file, JSON.stringify({ key: entry.key, label: entry.label, job: text }), { mode: 0o600 });
      entry.spoolFile = file;
      return true;
    } catch {
      emit({ event: 'spool-write-failed', key: entry.key, label: entry.label });
      return false;
    }
  };

  const materialize = (entry: Entry): BackgroundJob | undefined => {
    if (entry.job !== undefined) return entry.job;
    if (entry.spoolFile === undefined) return undefined;
    let revived: BackgroundJob | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(entry.spoolFile, 'utf8'));
      const text = parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'job') : undefined;
      revived = typeof text === 'string' ? options.revive?.(text) : undefined;
    } catch {
      revived = undefined;
    }
    try {
      unlinkSync(entry.spoolFile);
    } catch {
      // Already gone.
    }
    if (revived === undefined) emit({ event: 'spool-unreadable', key: entry.key, label: entry.label });
    return revived;
  };

  /** The oldest queue head whose key has nothing running. */
  const nextEntry = (): Entry | undefined => {
    let best: Entry | undefined;
    for (const [key, list] of queues) {
      const head = list[0];
      if (head === undefined || (busyKeys.get(key) ?? 0) > 0) continue;
      if (best === undefined || head.seq < best.seq) best = head;
    }
    return best;
  };

  const startNext = (): boolean => {
    if (closed || running + held >= concurrency) return false;
    if (running + held > 0 && options.hotBusy()) return false;
    const entry = nextEntry();
    if (entry === undefined) return false;
    const list = queues.get(entry.key) ?? [];
    list.shift();
    if (list.length === 0) queues.delete(entry.key);
    queued -= 1;
    if (entry.spoolFile !== undefined) spooled -= 1;
    else memory -= entry.bytes;
    const job = materialize(entry);
    if (job === undefined) {
      wake(entry.key);
      return true;
    }
    running += 1;
    markBusy(entry.key, 1);
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(job.run());
    } catch (error) {
      work = Promise.reject(error);
    }
    work.catch(() => emit({ event: 'job-failed', key: entry.key, label: entry.label }));
    track(entry.key, work, 'run');
    return true;
  };

  function schedule(): void {
    if (scheduled || closed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      while (startNext()) {
        // Start what the limits allow; each start is one job.
      }
    });
  }

  const add = (entry: Entry): void => {
    const list = queues.get(entry.key);
    if (list === undefined) queues.set(entry.key, [entry]);
    else list.push(entry);
    queued += 1;
  };

  return {
    recoverSpool() {
      // A spool left by a stopped sidecar runs first, in its order.
      if (spoolDir === undefined || options.revive === undefined) return 0;
      let names: string[] = [];
      try {
        names = readdirSync(spoolDir).filter((name) => SPOOL_NAME.test(name)).sort();
      } catch {
        names = [];
      }
      const known = new Set<string>();
      for (const list of queues.values()) for (const entry of list) if (entry.spoolFile !== undefined) known.add(entry.spoolFile);
      let recovered = 0;
      for (const name of names) {
        const file = join(spoolDir, name);
        if (known.has(file)) continue;
        let key = 'spool';
        let label = 'spool';
        try {
          const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
          if (parsed !== null && typeof parsed === 'object') {
            const k = Reflect.get(parsed, 'key');
            const l = Reflect.get(parsed, 'label');
            if (typeof k === 'string') key = k;
            if (typeof l === 'string') label = l;
          }
        } catch {
          // Unreadable: materialize removes it and counts it.
        }
        seq += 1;
        add({ seq, key, label, bytes: 0, spoolFile: file });
        spooled += 1;
        recovered += 1;
      }
      if (recovered > 0) schedule();
      return recovered;
    },
    enqueue(job) {
      seq += 1;
      const entry: Entry = { seq, key: job.key, label: job.label, bytes: Math.max(0, job.bytes) };
      let where: 'queued' | 'spooled' = 'queued';
      if (memory + entry.bytes > memoryBytes && job.spool !== undefined) {
        const text = job.spool();
        if (text !== undefined && writeSpool(entry, text)) where = 'spooled';
      }
      if (where === 'queued') {
        entry.job = job;
        memory += entry.bytes;
      } else {
        spooled += 1;
        emit({ event: 'job-spooled', key: entry.key, label: entry.label });
      }
      add(entry);
      schedule();
      return where;
    },
    hold(key, _label, work) {
      held += 1;
      markBusy(key, 1);
      track(key, work, 'hold');
    },
    pending: keyPending,
    settled(key, signal) {
      if (!keyPending(key)) return Promise.resolve(true);
      if (signal?.aborted === true) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const done = (value: boolean): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = (): void => {
          const list = waiters.get(key);
          if (list !== undefined) {
            const index = list.indexOf(onSettled);
            if (index >= 0) list.splice(index, 1);
          }
          done(false);
        };
        const onSettled = (): void => done(true);
        const list = waiters.get(key);
        if (list === undefined) waiters.set(key, [onSettled]);
        else list.push(onSettled);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    kick: schedule,
    depth: () => ({ running, held, queued: queued - spooled, spooled }),
    async drain(ms) {
      const until = Date.now() + Math.max(0, ms);
      // Open, it waits for spooled work too; closed, spooled work stays for the next start.
      while ((inFlight.size > 0 || (closed ? queued - spooled : queued) > 0) && Date.now() < until) {
        if (inFlight.size === 0) {
          if (closed) break;
          schedule();
        }
        const pendingWork = [...inFlight];
        await Promise.race([
          pendingWork.length > 0 ? Promise.all(pendingWork) : new Promise<void>((resolve) => setImmediate(() => resolve())),
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), Math.max(1, until - Date.now()));
            timer.unref?.();
          }),
        ]);
      }
    },
    close() {
      closed = true;
      // What waits in memory goes to the spool when it can, so the next start runs it.
      for (const list of queues.values()) {
        for (const entry of list) {
          if (entry.job === undefined || entry.job.spool === undefined) continue;
          const text = entry.job.spool();
          if (text !== undefined && writeSpool(entry, text)) {
            memory -= entry.bytes;
            delete entry.job;
            spooled += 1;
          }
        }
      }
    },
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
