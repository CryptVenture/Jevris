/**
 * The scripted worker port for acceptance tests (W01-W04, US40): a WorkerPort that replays a
 * JSON script of file edits and outcomes inside the worker's worktree, instead of an Agent SDK
 * session. It exists so the sandboxed suite can drive owned workers end to end without the
 * optional SDK and without a real harness.
 *
 * Gating (all required; otherwise the port does not exist and the SDK port, or none, is used):
 * - the sidecar's environment has JEVRIS_TEST=1;
 * - the Jevris home carries a test-home marker, `<state>/test-home.json` with schemaVersion
 *   `jevris-test-home-1`, a regular file that is not group or world writable. A plain user
 *   environment, a release build and an installed runtime copy never have one, so setting the
 *   variables alone does nothing there;
 * - JEVRIS_TEST_WORKER_SCRIPT names an absolute, existing, valid script file;
 * - the process does not run from the user's installed runtime copy (`<data>/runtime/<version>`
 *   under the OS user's own Jevris home): there it is refused even with a marker.
 *
 * The script is data, never code: nothing is spawned, evaluated or imported, and a run with any
 * key beyond writes, status, reason, costUsd, waitForFile, promptTo, taskId, resetAt, modelUnavailable and harness (such as a command) makes the whole
 * script invalid. Writes stay inside the worktree it is given (absolute paths and `..` are
 * refused). `testWorkerPortStatus` returns a diagnostic line for status and doctor while active,
 * and the sidecar traces `orchestrator.test-worker-port` each time it is used.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { WORKER_RUN_STATUSES, validFinding, type ModelUnavailableFinding, type WorkerPort, type WorkerRunInput, type WorkerRunOutcome } from './workers.js';
import type { WorkerHarness } from './worker-auth.js';

export const TEST_HOME_MARKER = 'test-home.json';
export const TEST_HOME_MARKER_SCHEMA = 'jevris-test-home-1';
export const TEST_WORKER_SCHEMA = 'jevris-test-worker-1';

const STATUSES = new Set<WorkerRunOutcome['status']>(WORKER_RUN_STATUSES);
const MAX_WAIT_MS = 120_000;

interface ScriptedRun {
  readonly writes: readonly { readonly path: string; readonly text: string }[];
  readonly status: WorkerRunOutcome['status'];
  readonly reason: string;
  readonly costUsd: number | null;
  readonly waitForFile: string | null;
  /** Where to record the prompt the run received (absolute, beside the script only). */
  readonly promptTo: string | null;
  /** The task this run is for; null serves any task in order. */
  readonly taskId: string | null;
  /** For a usage-limit run: when the scripted harness says the limit lifts. */
  readonly resetAt: string | null;
  /** For a model-unavailable run: what the scripted port found (C's reason and port id). */
  readonly modelUnavailable: ModelUnavailableFinding | null;
  /** The harness the scripted session reports its id under, as a dispatching port would. */
  readonly harness: WorkerHarness | null;
}

const HARNESSES: ReadonlySet<string> = new Set<WorkerHarness>(['claude', 'codex', 'opencode', 'kilo', 'antigravity']);

export interface TestWorkerPortStatus {
  readonly active: boolean;
  readonly script: string | null;
  readonly reason: 'NOT_TEST_MODE' | 'INSTALLED_RUNTIME' | 'NO_TEST_HOME_MARKER' | 'NO_SCRIPT' | 'SCRIPT_NOT_ABSOLUTE' | 'SCRIPT_MISSING' | 'SCRIPT_INVALID' | 'ACTIVE';
  /** A line for status and doctor while the port is active or refused in test mode; null otherwise. */
  readonly diagnostic: string | null;
}

const RUN_KEYS = new Set(['writes', 'status', 'reason', 'costUsd', 'waitForFile', 'promptTo', 'taskId', 'resetAt', 'modelUnavailable', 'harness']);
const WRITE_KEYS = new Set(['path', 'text']);
const onlyKeys = (o: object, allowed: ReadonlySet<string>) => Object.keys(o).every((k) => allowed.has(k));

function parseScript(text: string, scriptPath: string): readonly ScriptedRun[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || (raw as { schemaVersion?: unknown }).schemaVersion !== TEST_WORKER_SCHEMA) return null;
  if (!onlyKeys(raw, new Set(['schemaVersion', 'runs']))) return null;
  const runs = (raw as { runs?: unknown }).runs;
  if (!Array.isArray(runs) || runs.length === 0 || runs.length > 64) return null;
  const out: ScriptedRun[] = [];
  for (const r of runs) {
    if (r === null || typeof r !== 'object' || Array.isArray(r) || !onlyKeys(r, RUN_KEYS)) return null;
    const run = r as { [k: string]: unknown };
    const status = typeof run['status'] === 'string' && STATUSES.has(run['status'] as WorkerRunOutcome['status']) ? (run['status'] as WorkerRunOutcome['status']) : 'completed';
    const writes: { path: string; text: string }[] = [];
    for (const w of Array.isArray(run['writes']) ? run['writes'].slice(0, 64) : []) {
      if (w === null || typeof w !== 'object' || !onlyKeys(w, WRITE_KEYS)) return null;
      const p = (w as { path?: unknown }).path;
      const t = (w as { text?: unknown }).text;
      if (typeof p !== 'string' || typeof t !== 'string' || t.length > 1024 * 1024) return null;
      writes.push({ path: p, text: t });
    }
    const wait = run['waitForFile'];
    const promptTo = run['promptTo'];
    const forTask = run['taskId'];
    const resetAt = run['resetAt'];
    if (resetAt !== undefined && (typeof resetAt !== 'string' || !Number.isFinite(Date.parse(resetAt)))) return null;
    const harness = run['harness'];
    if (harness !== undefined && (typeof harness !== 'string' || !HARNESSES.has(harness))) return null;
    const unavailable = run['modelUnavailable'] === undefined ? null : validFinding(run['modelUnavailable']);
    if (run['modelUnavailable'] !== undefined && unavailable === null) return null;
    if (forTask !== undefined && (typeof forTask !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(forTask))) return null;
    // The prompt record goes only beside the script (the sandbox), never anywhere else.
    if (promptTo !== undefined && (typeof promptTo !== 'string' || !isAbsolute(promptTo) || relative(dirname(resolve(scriptPath)), dirname(resolve(promptTo))) !== '')) return null;
    out.push({
      writes,
      status,
      reason: typeof run['reason'] === 'string' ? run['reason'].slice(0, 300) : status === 'completed' ? 'success' : status,
      costUsd: typeof run['costUsd'] === 'number' && Number.isFinite(run['costUsd']) && run['costUsd'] >= 0 ? run['costUsd'] : null,
      waitForFile: typeof wait === 'string' && isAbsolute(wait) ? wait : null,
      promptTo: typeof promptTo === 'string' ? promptTo : null,
      taskId: typeof forTask === 'string' ? forTask : null,
      resetAt: typeof resetAt === 'string' ? resetAt : null,
      modelUnavailable: unavailable,
      harness: typeof harness === 'string' ? (harness as WorkerHarness) : null,
    });
  }
  return out;
}

/** Whether `home` carries a valid test-home marker (a regular, owner-writable-only file). */
export function hasTestHomeMarker(home: string | undefined, platform: string = process.platform): boolean {
  if (home === undefined || home === '' || !isAbsolute(home)) return false;
  try {
    const file = join(jevrisPaths({ home, platform }).state, TEST_HOME_MARKER);
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return false;
    if (platform !== 'win32' && (st.mode & 0o022) !== 0) return false;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && (raw as { schemaVersion?: unknown }).schemaVersion === TEST_HOME_MARKER_SCHEMA;
  } catch {
    return false;
  }
}

/** Test seam and inputs for the installed-runtime check. */
export interface TestWorkerGateOptions {
  /** The running entry script; default `process.argv[1]`. */
  readonly entry?: string;
  /** The OS user's home, whose Jevris data holds the installed runtime; default the platform's. */
  readonly osHome?: string;
  readonly platform?: string;
  /** The environment for the user's XDG/AppData locations; default `process.env`. */
  readonly env?: { readonly [key: string]: string | undefined };
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `entry` sits inside the OS user's installed runtime copies (`<data>/runtime`). */
export function runsFromInstalledRuntime(options: TestWorkerGateOptions = {}): boolean {
  const entry = options.entry ?? process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const platform = options.platform ?? process.platform;
  try {
    return withinInstalledRuntime(entry, platform, options);
  } catch {
    // The install location cannot be worked out: treat the entry as installed (refuse the port).
    return true;
  }
}

function withinInstalledRuntime(entry: string, platform: string, options: TestWorkerGateOptions): boolean {
  const osHome = options.osHome === undefined ? {} : { osHome: options.osHome };
  // The user's install location, with and without their XDG/AppData overrides (never JEVRIS_HOME).
  const { JEVRIS_HOME: _ignored, ...userEnv } = options.env ?? process.env;
  const roots = [jevrisPaths({ platform, env: {}, ...osHome }).data, jevrisPaths({ platform, env: userEnv, ...osHome }).data].map((d) => realOrSelf(join(d, 'runtime')));
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const at = fold(realOrSelf(entry));
  return roots.some((root) => {
    const back = relative(fold(root), at);
    return back !== '' && !back.startsWith('..') && !isAbsolute(back);
  });
}

export function testWorkerPortStatus(env: { readonly [key: string]: string | undefined } = process.env, home?: string, options: TestWorkerGateOptions = {}): TestWorkerPortStatus {
  const script = env['JEVRIS_TEST_WORKER_SCRIPT'];
  const named = typeof script === 'string' && script !== '' ? script : null;
  const refused = (reason: TestWorkerPortStatus['reason']): TestWorkerPortStatus => ({
    active: false,
    script: named,
    reason,
    // Only a named script gets a line: a refused test port is worth seeing, an absent one is not.
    diagnostic: named === null ? null : `test worker port refused (${reason}): owned workers use the Agent SDK`,
  });
  if (env['JEVRIS_TEST'] !== '1') return refused('NOT_TEST_MODE');
  if (runsFromInstalledRuntime({ env, ...options })) return refused('INSTALLED_RUNTIME');
  if (!hasTestHomeMarker(home, options.platform)) return refused('NO_TEST_HOME_MARKER');
  if (named === null) return refused('NO_SCRIPT');
  if (!isAbsolute(named)) return refused('SCRIPT_NOT_ABSOLUTE');
  if (!existsSync(named)) return refused('SCRIPT_MISSING');
  try {
    if (parseScript(readFileSync(named, 'utf8'), named) === null) return refused('SCRIPT_INVALID');
  } catch {
    return refused('SCRIPT_INVALID');
  }
  return { active: true, script: named, reason: 'ACTIVE', diagnostic: 'test worker port ACTIVE: owned workers replay a test script, not a model session (JEVRIS_TEST)' };
}

function inside(root: string, rel: string): string | null {
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  const full = resolve(root, ...rel.split('/'));
  const back = relative(resolve(root), full);
  return back === '' || back.startsWith('..') || isAbsolute(back) ? null : full;
}

async function waitFor(path: string, signal: AbortSignal): Promise<boolean> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (signal.aborted || Date.now() - started > MAX_WAIT_MS) return false;
    await new Promise<void>((done) => {
      const t = setTimeout(done, 25);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        done();
      }, { once: true });
    });
  }
  return true;
}

/**
 * Runs replayed so far per script path. Owned work builds a new port for each lease, so the
 * position lives here: the script replays in order across leases, and its last run repeats.
 */
const positions = new Map<string, number>();
/** With task-keyed runs: the run indexes consumed so far per script path. */
const consumed = new Map<string, Set<number>>();

/**
 * The next run for this call. Without any task-keyed run the script replays in call order.
 * With them, a leased task takes the first unconsumed run keyed to it or to no task, so
 * parallel workers get their own runs whatever order they start in; once none is left, the
 * last run it could take repeats.
 */
function nextRun(script: string, runs: readonly ScriptedRun[], taskId: string | undefined): { readonly run: ScriptedRun | undefined; readonly n: number } {
  const next = (positions.get(script) ?? 0) + 1;
  positions.set(script, next);
  if (!runs.some((r) => r.taskId !== null)) return { run: runs[Math.min(next - 1, runs.length - 1)], n: next };
  const used = consumed.get(script) ?? new Set<number>();
  consumed.set(script, used);
  const fits = (r: ScriptedRun) => r.taskId === null || r.taskId === taskId;
  const index = runs.findIndex((r, i) => !used.has(i) && fits(r));
  if (index >= 0) {
    used.add(index);
    return { run: runs[index], n: next };
  }
  return { run: [...runs].reverse().find(fits), n: next };
}

/** The scripted port, or null when test mode or a valid script is absent. */
export function scriptedWorkerPort(env: { readonly [key: string]: string | undefined } = process.env, home?: string, options: TestWorkerGateOptions = {}): WorkerPort | null {
  const status = testWorkerPortStatus(env, home, options);
  if (!status.active || status.script === null) return null;
  const script = status.script;
  return {
    async run(input: WorkerRunInput): Promise<WorkerRunOutcome> {
      const started = Date.now();
      const runs = parseScript(readFileSync(script, 'utf8'), script) ?? [];
      const { run, n: next } = nextRun(script, runs, input.taskId);
      const base = { sessionId: `scripted-${String(next)}`, requestedModel: input.model, actualModel: input.model, usage: null, turns: 1 };
      if (run === undefined) return { ...base, status: 'failed', reason: 'no scripted run', costUsd: null, durationMs: Date.now() - started };
      // As F's ports do: the session id is reported once, as soon as the run has one.
      try {
        if (run.harness === null) input.onSessionId?.(base.sessionId);
        else input.onSessionId?.(base.sessionId, run.harness);
      } catch {
        // A throwing callback never fails the run.
      }
      if (run.promptTo !== null) {
        // Atomic: a reader never sees a partly written prompt record.
        const partial = `${run.promptTo}.${String(process.pid)}.partial`;
        writeFileSync(partial, input.prompt, { mode: 0o600 });
        renameSync(partial, run.promptTo);
      }
      for (const w of run.writes) {
        const full = inside(input.cwd, w.path);
        if (full === null) return { ...base, status: 'refused', reason: `scripted write outside the worktree: ${w.path.slice(0, 120)}`, costUsd: null, durationMs: Date.now() - started };
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, w.text);
      }
      if (run.waitForFile !== null && !(await waitFor(run.waitForFile, input.signal))) {
        return { ...base, status: 'aborted', reason: input.signal.aborted ? 'aborted' : 'scripted wait timed out', costUsd: run.costUsd, durationMs: Date.now() - started };
      }
      if (input.signal.aborted) return { ...base, status: 'aborted', reason: 'aborted', costUsd: run.costUsd, durationMs: Date.now() - started };
      return { ...base, status: run.status, reason: run.reason, costUsd: run.costUsd, durationMs: Date.now() - started, ...(run.resetAt === null ? {} : { resetAt: run.resetAt }), ...(run.modelUnavailable === null ? {} : { modelUnavailable: run.modelUnavailable }) };
    },
  };
}
