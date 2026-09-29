/**
 * What every owned-worker port shares (ORC-05; owner directive 2026-09-26, "all harnesses
 * complete"): the input checks, the one streaming session with its wall-clock timeout, the
 * caller's abort and the tree kill, and the small parsers for usage limits and counts. Each
 * port (claude-worker, codex-worker, opencode-worker, kilo-worker, antigravity-worker) keeps
 * only what is its harness's own: the argv, the environment and the event format.
 *
 * - The prompt goes on stdin, never argv. Keys and tokens stay in the environment.
 * - Cancellation (the caller's AbortSignal), the wall-clock timeout and a port's own caps each
 *   kill the whole process tree.
 * - Effort (C's router, 2026-09-26) is a fixed level, never free text: a port passes the
 *   harness's nearest level at or below it and records the level it actually passed.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchStreaming, type LaunchExit } from './live-harness.js';
import type { ModelRegistry } from '@jevris/contracts';
import type { AuthMode } from './harness-auth.js';

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

/**
 * `model-unavailable` (C's found-gone table): the harness said the model does not exist here or
 * this sign-in cannot use it. The outcome then carries `modelUnavailable` ({reasonCode, port,
 * authMode}) for D to record; it is not the task's failure. It ranks after a port's refusal,
 * abort, timeout and access limit.
 *
 * `access-limit` and `overloaded` (access limits R63-R67, D's R70): the run ended on a rate limit,
 * a usage window, exhausted credit, a blocked account or an overloaded provider. The outcome then
 * carries `accessSignal` (E's wire shape) and the port's `accessLimit`; the runner classifies the
 * signal again. No port reports `usage-limit` any more; it stays for runs recorded before.
 */
export type OwnedWorkerStatus = 'completed' | 'failed' | 'max-turns' | 'budget-exceeded' | 'aborted' | 'timeout' | 'unsupported' | 'refused' | 'usage-limit' | 'model-unavailable' | 'access-limit' | 'overloaded';

/** C's effort levels, lowest first. Absent means the model's default. */
export type WorkerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const WORKER_EFFORTS: readonly WorkerEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The tool names D grants owned workers (the Claude names); every port accepts this list. */
export const OWNED_GRANTABLE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'MultiEdit', 'Write', 'Bash', 'NotebookEdit', 'TodoWrite'];
export const OWNED_WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export interface OwnedUsage {
  readonly inputTokens: number;
  /** Output tokens with reasoning tokens included (C's cost model charges both at the output price). */
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/**
 * The first-use check (owner approval 2026-09-26, "certified pending first use"): what the
 * session's first event showed before any tool ran. `ok: false` names why (a reason code); the
 * run is then stopped where the harness reports enough to decide, and the feature is demoted
 * (worker-evidence.ts). Null when the session produced no first event to check.
 */
export interface InitCheck {
  readonly ok: boolean;
  readonly reasonCode: string | null;
}

export const INIT_OK: InitCheck = { ok: true, reasonCode: null };
export function initFailed(reasonCode: string): InitCheck {
  return { ok: false, reasonCode };
}

/** The same directory, after links (a worktree under /tmp is /private/tmp on macOS). */
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

export type SessionControl = { readonly interrupt: () => void; readonly abort: () => void; readonly sessionId: () => string | null };

/** Reports the first non-null session id to `onSessionId`, once; later ids and a throwing callback are ignored. */
export function sessionIdReporter(onSessionId: ((sessionId: string) => void) | undefined): (sessionId: string | null) => void {
  let sent = false;
  return (sessionId) => {
    if (sent || sessionId === null || onSessionId === undefined) return;
    sent = true;
    try {
      onSessionId(sessionId);
    } catch {
      // Binding the session is the caller's work; it never fails the run.
    }
  };
}

/** The input every port takes (D's WorkerRunInput, plus the injected binary and environment). */
export interface OwnedWorkerInputBase {
  readonly prompt: string;
  readonly model: string;
  /** The task worktree; the session never runs in the user's checkout. */
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onStart?: (control: SessionControl) => void;
  /**
   * Called once, as soon as the harness first names its session (the id that ends up as the
   * outcome's sessionId), so the orchestrator can bind it to the lease while the run is live.
   * A throw here never fails the run.
   */
  readonly onSessionId?: (sessionId: string) => void;
  /** The decided auth mode (never a key or token value). Absent: the environment as it is. */
  readonly auth?: AuthMode;
  /** C's effort level; absent means the model's default (nothing is passed). */
  readonly effort?: WorkerEffort;
  /** The binary and any leading arguments. Default: the harness's name on PATH. Tests inject a stub. */
  readonly command?: { readonly file: string; readonly args?: readonly string[] };
  /** The child's environment before auth shaping. Default: this process's environment. */
  readonly env?: { readonly [key: string]: string | undefined };
  /**
   * The text-matched found-gone signals certified for this binary version (model-signals.ts).
   * A port on the harness's own binary fills it from the capture; absent means none, so a
   * text-matched signal is reported but never makes the run `model-unavailable`.
   */
  readonly certifiedModelSignals?: readonly string[];
  /**
   * The loaded model registry that spells the model for the harness (harness-model.ts). Absent:
   * the bundled snapshot. D's port passes the registry it loaded for the provider lookup.
   */
  readonly registry?: ModelRegistry;
  /**
   * Serving hosts R52 (agreed with D): a pinned serving host (`openrouter`, `kilo`) to run the
   * registry `model` through, on OpenCode and Kilo only. The port starts the one host spelling
   * core gives, or refuses; it never falls back to the maker. Absent: the maker route. Only D's
   * workers.ts sets it, and only once the parked task-ops wiring (owner) passes a host.
   */
  readonly servingHost?: string;
}

/** A serving host id as the registry pins it (contracts SERVING_HOSTS). */
const SERVING_HOST = /^[a-z][a-z0-9-]{0,31}$/;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

/** The first invalid field's name, or null. `model` may widen the model-id pattern. */
export function validateOwnedInput(input: OwnedWorkerInputBase, options: { readonly model?: RegExp } = {}): string | null {
  if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000) return 'prompt';
  if (typeof input.model !== 'string' || !(options.model ?? MODEL).test(input.model) || input.model.includes('..')) return 'model';
  if (typeof input.cwd !== 'string' || input.cwd.length === 0) return 'cwd';
  if (!Array.isArray(input.allowedTools) || input.allowedTools.some((t) => !OWNED_GRANTABLE_TOOLS.includes(t))) return 'allowedTools';
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 500) return 'maxTurns';
  if (typeof input.maxBudgetUsd !== 'number' || !(input.maxBudgetUsd > 0) || input.maxBudgetUsd > 1_000) return 'maxBudgetUsd';
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 24 * 3_600_000) return 'timeoutMs';
  if (input.auth !== undefined && input.auth !== 'subscription' && input.auth !== 'api-key') return 'auth';
  if (input.effort !== undefined && !WORKER_EFFORTS.includes(input.effort)) return 'effort';
  if (input.servingHost !== undefined && (typeof input.servingHost !== 'string' || !SERVING_HOST.test(input.servingHost))) return 'servingHost';
  return null;
}

/**
 * The harness level for C's `effort`: the level itself when the harness has it, else the
 * nearest harness level below it, else the harness's lowest. Null when no effort was asked.
 */
export function nearestEffort<L extends string>(effort: WorkerEffort | undefined, levels: readonly L[]): L | null {
  if (effort === undefined || levels.length === 0) return null;
  const rank = (level: string): number => {
    const at = (WORKER_EFFORTS as readonly string[]).indexOf(level);
    return at === -1 ? (level === 'minimal' ? -1 : Number.NaN) : at;
  };
  const wanted = rank(effort);
  let best: L | null = null;
  for (const level of levels) {
    const r = rank(level);
    if (Number.isNaN(r) || r > wanted) continue;
    if (best === null || r > rank(best)) best = level;
  }
  return best ?? levels[0] ?? null;
}

export function rec(value: unknown): { readonly [key: string]: unknown } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { readonly [key: string]: unknown }) : undefined;
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The first non-empty line, at most `max` characters. */
export function clip(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? line.slice(0, max) : line;
}

/** One JSON object per line; anything else (notices, noise) is undefined, never fatal. */
export function jsonLine(line: string): { readonly [key: string]: unknown } | undefined {
  try {
    return rec(JSON.parse(line));
  } catch {
    return undefined;
  }
}

// The usage-limit text and header readers moved to core (access limits R60): each port now builds
// an access signal (access-signal.ts) and core's `resetFromHeaders` reads the reset headers.

export interface SessionEnd {
  readonly exit: LaunchExit;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/**
 * Runs one streaming session: starts `file` with `args` in `cwd`, writes `input` to stdin,
 * hands each stdout line to `onLine` with a `stop` that kills the tree (a port's own caps), and
 * enforces the caller's abort and the wall-clock timeout.
 */
export async function runStreamingSession(options: {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: { readonly [key: string]: string };
  readonly input: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onStart?: (control: SessionControl) => void;
  readonly sessionId: () => string | null;
  readonly onLine: (line: string, stop: () => void) => void;
}): Promise<SessionEnd> {
  const started = Date.now();
  let timedOut = false;
  let aborted = false;
  let stop: () => void = () => {};
  const launched = launchStreaming(options.file, options.args, { cwd: options.cwd, env: options.env, input: options.input, onLine: (line) => options.onLine(line, stop) });
  stop = launched.kill;
  const timer = setTimeout(() => {
    timedOut = true;
    launched.kill();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    launched.kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  options.onStart?.({ interrupt: onAbort, abort: onAbort, sessionId: options.sessionId });
  const exit = await launched.done;
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', onAbort);
  const stderr = await launched.stderr;
  return { exit, stderr, durationMs: Date.now() - started, timedOut, aborted };
}

/** The status every port decides first, in this order: its own refusal, abort, timeout, then its caps. */
export function interruptedStatus(end: SessionEnd, timeoutMs: number): readonly [OwnedWorkerStatus, string] | null {
  if (end.aborted) return ['aborted', 'aborted by the caller'];
  if (end.timedOut) return ['timeout', `no result within ${String(timeoutMs)} ms`];
  return null;
}
