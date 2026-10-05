/**
 * git off the request loop (the K3 lifecycle load and the W10 handoff failures on windows-latest).
 *
 * Starting a process is not asynchronous work: `spawn` makes the operating system create it inside the call,
 * on the calling thread (on Windows that is `CreateProcess`, and a loaded runner took hundreds of milliseconds
 * to seconds for one). The sidecar runs a `git status` for every PreCompact (the capsule), restore and Stop,
 * and for every handoff, so four sessions compacting together stood its single event loop still for the sum
 * of four process creations: every hook in flight then ended as a client timeout (windows-latest, CI run
 * 37329307976: a stall of 3.7 s, four PreCompact, four restore and 50 subagent hooks lost) while the driver's own
 * loop, on the same machine, never stopped.
 *
 * So the sidecar starts git from a small pool of worker threads (GIT_WORKERS of them, so concurrent starts
 * overlap), each running `runGitSelfContained` from source: a worker loads no module of the product, so it
 * starts in milliseconds and costs a few MiB. A call goes to a worker only once that worker has said it is ready;
 * before that, and whenever the pool is off (the CLI, an in-process daemon in a test), a worker cannot start, dies
 * or does not answer, the caller runs git itself exactly as before (`runGitProcess`), so git never depends on the
 * workers. A call the worker did not answer in time is given up as a git timeout would be, and that worker is
 * replaced. The sidecar turns the pool on at start (`enableGitWorkers`); it ends when the sidecar has had no git
 * call for GIT_WORKER_IDLE_MS.
 */
import { Worker } from 'node:worker_threads';
import { GIT_RUNNER_SOURCE, type GitRequest, type GitResult } from './git-process.js';

/** Worker threads in the pool: concurrent process creations that can overlap. */
export const GIT_WORKERS = 4;
/** The pool ends after this long with no git call; the next call is run inline and starts it again. */
export const GIT_WORKER_IDLE_MS = 5 * 60_000;
/** A call is given up this long after its own timeout if its worker has not answered it. */
export const GIT_WORKER_GRACE_MS = 3_000;
/** Workers started after a failure, over the life of the process; past it git is run inline for good. */
export const GIT_WORKER_RESTARTS_MAX = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The source of one worker: git runs, each answered to its own caller, concurrently, until the thread ends. */
const WORKER_SOURCE = `
'use strict';
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const run = (${GIT_RUNNER_SOURCE});
parentPort.on('message', (message) => {
  const id = message !== null && typeof message === 'object' ? message.id : undefined;
  if (typeof id !== 'number') return;
  Promise.resolve()
    .then(() => run(spawn, message.request, message.program))
    .then(
      (result) => parentPort.postMessage({ id, ok: result.ok, stdout: result.stdout, stderr: result.stderr || '' }),
      () => parentPort.postMessage({ id, ok: false, stdout: '', stderr: '' }),
    );
});
parentPort.postMessage({ ready: true });
`;

interface Slot {
  readonly worker: Worker;
  ready: boolean;
  /** Calls this worker has not answered. */
  inFlight: number;
}

let enabled = false;
let restarts = 0;
let nextId = 1;
let slots: Slot[] = [];
const waiting = new Map<number, { readonly slot: Slot; readonly settle: (result: GitResult | null) => void }>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function endSlot(slot: Slot): void {
  slots = slots.filter((item) => item !== slot);
  for (const [id, call] of [...waiting]) {
    if (call.slot !== slot) continue;
    waiting.delete(id);
    call.settle(null);
  }
  void slot.worker.terminate().catch(() => undefined);
}

function stopPool(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  for (const slot of [...slots]) endSlot(slot);
}

/**
 * Turns the worker pool on (the sidecar does it at start) or off. Turning it off ends the workers, and any call they
 * had not answered is run inline by its caller. Turning it on starts nothing: `warmGitWorkers` does, or the first call.
 */
export function enableGitWorkers(value: boolean): void {
  if (!value) stopPool();
  enabled = value;
  restarts = 0;
}

/** Whether a git call now goes to a worker thread (one is up and has said it is ready). */
export function gitWorkerReady(): boolean {
  return slots.some((slot) => slot.ready);
}

/** Workers in the pool, ready or not. */
export function gitWorkerCount(): number {
  return slots.length;
}

function scheduleIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  if (waiting.size > 0 || slots.length === 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (waiting.size === 0) stopPool();
  }, GIT_WORKER_IDLE_MS);
  (idleTimer as { unref?: () => void }).unref?.();
}

function startSlot(): void {
  if (!enabled || slots.length >= GIT_WORKERS || restarts > GIT_WORKER_RESTARTS_MAX) return;
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
  } catch {
    restarts = GIT_WORKER_RESTARTS_MAX + 1;
    return;
  }
  const slot: Slot = { worker, ready: false, inFlight: 0 };
  const failed = (): void => {
    if (!slots.includes(slot)) return;
    restarts += 1;
    endSlot(slot);
  };
  worker.on('message', (message: unknown) => {
    if (!isRecord(message)) return;
    if (message['ready'] === true) {
      slot.ready = true;
      return;
    }
    if (typeof message['id'] !== 'number') return;
    const call = waiting.get(message['id']);
    if (call === undefined) return;
    waiting.delete(message['id']);
    call.settle(typeof message['ok'] === 'boolean' && typeof message['stdout'] === 'string' ? { ok: message['ok'], stdout: message['stdout'], stderr: typeof message['stderr'] === 'string' ? message['stderr'] : '' } : null);
  });
  worker.on('error', failed);
  worker.on('exit', failed);
  // A worker never keeps the process alive; a call in flight does, through its timer.
  worker.unref();
  slots.push(slot);
}

/** Starts the whole pool now (the sidecar does it once it is up), so the first git calls already find workers ready. A no-op when the pool is off. */
export function warmGitWorkers(): void {
  while (enabled && slots.length < GIT_WORKERS && restarts <= GIT_WORKER_RESTARTS_MAX) {
    const before = slots.length;
    startSlot();
    if (slots.length === before) break;
  }
}

/**
 * The result of `request` (run as `program`) from a worker thread, or null when the caller should run git itself: the pool
 * is off, no worker is ready yet (the pool is started for the next call), the worker failed, or it was ended before it answered.
 * A call the worker did not answer in time gets a git timeout's result (not ok). Never throws.
 */
export async function runGitOffLoop(request: GitRequest, program: string): Promise<GitResult | null> {
  if (!enabled) return null;
  if (slots.length === 0) warmGitWorkers();
  const ready = slots.filter((slot) => slot.ready);
  if (ready.length === 0) return null;
  const slot = ready.reduce((best, item) => (item.inFlight < best.inFlight ? item : best));
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const id = nextId;
  nextId += 1;
  slot.inFlight += 1;
  return new Promise<GitResult | null>((resolve) => {
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      resolve({ ok: false, stdout: '', stderr: '' });
      // A worker that does not answer is replaced (ending it settles this call, already answered above, with nothing).
      restarts += 1;
      endSlot(slot);
      warmGitWorkers();
    }, request.timeoutMs + GIT_WORKER_GRACE_MS);
    waiting.set(id, {
      slot,
      settle: (result) => {
        clearTimeout(timer);
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        resolve(result);
        scheduleIdle();
      },
    });
    try {
      slot.worker.postMessage({ id, request, program });
    } catch {
      waiting.delete(id);
      clearTimeout(timer);
      slot.inFlight = Math.max(0, slot.inFlight - 1);
      resolve(null);
    }
  });
}
