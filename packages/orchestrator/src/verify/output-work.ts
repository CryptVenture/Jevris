/**
 * A check's output off the request loop (sidecar concurrency audit P6).
 *
 * Joining stdout and stderr into the stored `runner-output`, hashing it, decoding and parsing the
 * results and building the rules view of it are linear in the output, which a check may make
 * 16 MiB long: on the sidecar's event loop that held every other request for up to ~200 ms. For
 * an output of OFF_LOOP_OUTPUT_BYTES or more, the sidecar does that work in one long-lived worker
 * thread instead (the sidecar entry started again as a worker, as the maintenance sweep does, P10).
 *
 * The worker gets a copy of the bytes and answers the product (the joined bytes are transferred
 * back, not copied). Without a worker script (the CLI, an in-process daemon in a test) or when the
 * worker cannot start, fails or does not answer within OUTPUT_WORKER_TIMEOUT_MS, the caller does
 * the same work inline, exactly as before, so a verification never depends on the worker.
 */
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { rulesView, type BuiltView } from '../memory/distill.js';
import { parseResults, type ResultFormat, type StructuredResults } from './results.js';
import { bytesOf, utf8 } from '../util.js';

/** Between stdout and stderr in a stored `runner-output`. */
export const RUNNER_STDERR_SEPARATOR = '\n--- stderr ---\n';
/** An output this long or longer is processed in the worker thread, when there is one. */
export const OFF_LOOP_OUTPUT_BYTES = 256 * 1024;
/** A job the worker has not answered by then is done inline, and the worker is replaced. */
export const OUTPUT_WORKER_TIMEOUT_MS = 120_000;
/** The worker ends after this long with nothing to do; the next large output starts it again. */
export const OUTPUT_WORKER_IDLE_MS = 60_000;

export interface OutputJob {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly resultFormat: ResultFormat;
  /** The check's result file, already read (`resultFile`), or null. */
  readonly resultFileText: string | null;
  readonly command: string | null;
  readonly exitCode: number | null;
}

export interface OutputProduct {
  readonly results: StructuredResults | null;
  /** stdout, RUNNER_STDERR_SEPARATOR, stderr: the bytes stored as the check's `runner-output`. */
  readonly raw: Uint8Array;
  readonly stdoutLength: number;
  /** The sha256 of `raw` (its evidence handle is `ev:<sha256>`). */
  readonly sha256: string;
  /** The rules view of the output against that handle (what `distillStoredOutput` builds). */
  readonly view: BuiltView;
  readonly where: 'inline' | 'worker';
}

/** stdout, the separator and stderr in one buffer. */
export function joinOutput(stdout: Uint8Array, stderr: Uint8Array): Uint8Array {
  const sep = bytesOf(RUNNER_STDERR_SEPARATOR);
  const raw = new Uint8Array(stdout.length + sep.length + stderr.length);
  raw.set(stdout, 0);
  raw.set(sep, stdout.length);
  raw.set(stderr, stdout.length + sep.length);
  return raw;
}

/** The rules view of a stored check output (the view `distillStoredOutput` records for it). */
export function checkOutputView(handle: string, job: Pick<OutputJob, 'stdout' | 'stderr' | 'command' | 'exitCode'>, rawBytes: number): BuiltView {
  const sepBytes = bytesOf(RUNNER_STDERR_SEPARATOR).length;
  return rulesView({
    handle,
    command: job.command,
    exitCode: job.exitCode,
    out: job.stdout,
    err: job.stderr,
    rawBytes,
    stdoutOffset: 0,
    stderrOffset: job.stderr.length > 0 ? job.stdout.length + sepBytes : null,
  });
}

/** All of a check output's linear work, synchronously (the worker's job; small outputs inline). */
export function processOutput(job: OutputJob, where: OutputProduct['where'] = 'inline'): OutputProduct {
  const raw = joinOutput(job.stdout, job.stderr);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const results = parseResults(job.resultFormat, utf8(job.stdout), job.resultFileText);
  return { results, raw, stdoutLength: job.stdout.length, sha256, view: checkOutputView(`ev:${sha256}`, job, raw.length), where };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ------------------------------------------------------------------ the worker thread's side

/** True in the worker thread the sidecar starts for check output (its entry calls runOutputWorker). */
export function isOutputWorker(): boolean {
  return !isMainThread && isRecord(workerData) && workerData['jevrisOutput'] === 1;
}

function isJob(value: unknown): value is OutputJob {
  return (
    isRecord(value) &&
    value['stdout'] instanceof Uint8Array &&
    value['stderr'] instanceof Uint8Array &&
    typeof value['resultFormat'] === 'string' &&
    (value['resultFileText'] === null || typeof value['resultFileText'] === 'string') &&
    (value['command'] === null || typeof value['command'] === 'string') &&
    (value['exitCode'] === null || typeof value['exitCode'] === 'number')
  );
}

/** Worker side: answers each job, in order, until the sidecar ends the thread. */
export function runOutputWorker(): void {
  const port = parentPort;
  if (port === null) return;
  port.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message['id'] !== 'number') return;
    const id = message['id'];
    if (!isJob(message['job'])) {
      port.postMessage({ id, ok: false });
      return;
    }
    try {
      const product = processOutput(message['job'], 'worker');
      port.postMessage({ id, ok: true, product }, [product.raw.buffer as ArrayBuffer]);
    } catch {
      port.postMessage({ id, ok: false });
    }
  });
}

// ------------------------------------------------------------------ the sidecar's side

let script: string | URL | null = null;
let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (product: OutputProduct | null) => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function settleAll(): void {
  for (const [id, resolve] of [...waiting]) {
    waiting.delete(id);
    resolve(null);
  }
}

function stopWorker(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const current = worker;
  worker = null;
  settleAll();
  if (current !== null) void current.terminate().catch(() => undefined);
}

/**
 * The sidecar's entry, started again as the output worker (the sidecar sets it at start); null
 * turns the worker off. Changing it ends a running worker.
 */
export function setOutputWorkerScript(value: string | URL | null): void {
  stopWorker();
  script = value;
}

function isProduct(value: unknown): value is Omit<OutputProduct, 'where'> {
  return (
    isRecord(value) &&
    value['raw'] instanceof Uint8Array &&
    typeof value['stdoutLength'] === 'number' &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['sha256']) &&
    isRecord(value['view']) &&
    (value['results'] === null || isRecord(value['results']))
  );
}

function startWorker(): Worker | null {
  if (worker !== null) return worker;
  if (script === null) return null;
  let started: Worker;
  try {
    started = new Worker(script, { workerData: { jevrisOutput: 1 } });
  } catch {
    return null;
  }
  started.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message['id'] !== 'number') return;
    const resolve = waiting.get(message['id']);
    if (resolve === undefined) return;
    waiting.delete(message['id']);
    const product = message['ok'] === true && isProduct(message['product']) ? { ...message['product'], where: 'worker' as const } : null;
    resolve(product);
  });
  started.on('error', () => {
    if (worker === started) stopWorker();
  });
  started.on('exit', () => {
    if (worker === started) {
      worker = null;
      settleAll();
    }
  });
  // The worker never keeps the process alive; a job in flight does, through its timer.
  started.unref();
  worker = started;
  return started;
}

function scheduleIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  if (waiting.size > 0 || worker === null) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (waiting.size === 0) stopWorker();
  }, OUTPUT_WORKER_IDLE_MS);
  (idleTimer as { unref?: () => void }).unref?.();
}

/**
 * The job's product from the worker thread, or null when the caller should do the work inline:
 * the output is shorter than OFF_LOOP_OUTPUT_BYTES, no worker script is set, or the worker could
 * not start, failed or did not answer in time. Never throws.
 */
export async function processOutputOffLoop(job: OutputJob, timeoutMs: number = OUTPUT_WORKER_TIMEOUT_MS): Promise<OutputProduct | null> {
  if (job.stdout.length + job.stderr.length < OFF_LOOP_OUTPUT_BYTES) return null;
  const running = startWorker();
  if (running === null) return null;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const id = nextId;
  nextId += 1;
  return new Promise<OutputProduct | null>((resolve) => {
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      resolve(null);
      // A worker that does not answer is replaced; the next large output starts a fresh one.
      if (worker === running) stopWorker();
    }, timeoutMs);
    waiting.set(id, (product) => {
      clearTimeout(timer);
      resolve(product);
      scheduleIdle();
    });
    try {
      // A copy: the caller keeps its bytes for the inline fallback.
      running.postMessage({ id, job });
    } catch {
      waiting.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}
