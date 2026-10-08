/**
 * Owned worker execution through the Claude Agent SDK (ORC-05, SSOT §10.2, §10.3, W01, C09).
 *
 * `runOwnedWorker` starts one `query()` session with the model, cwd (the task worktree),
 * allowed tools, turn cap and USD budget cap, consumes the whole message stream, and reports
 * the actual model, usage and cost from the SDK's own messages. Abort, interrupt and a wall
 * clock timeout are supported. Native permissions stay authoritative: permissionMode is always
 * `default`, and worktree switching tools are disallowed.
 *
 * The SDK is optional. It is loaded with a literal dynamic import; when it is absent the
 * result is `unsupported` with an install hint, and nothing else changes.
 *
 * API key only (owner decision 2026-09-26): Anthropic does not allow third-party products to
 * use claude.ai logins through the Agent SDK. A session starts only when ANTHROPIC_API_KEY is
 * in the environment; CLAUDE_CODE_OAUTH_TOKEN is removed from the session's environment; and a
 * session whose init message reports any other key source is aborted and refused. Subscription
 * logins run through the user's own harness CLI instead (F's CLI worker ports).
 */

import { classifyAccessSignal, resetFromHeaders } from '@jevris/core';
import { matchAccessText, type AccessLimitFinding, type AccessSignalWire } from '@jevris/contracts';

export const SDK_MISSING_MESSAGE = 'unsupported: install @anthropic-ai/claude-agent-sdk';
export const SDK_NEEDS_API_KEY = 'refused: the Agent SDK worker runs only with ANTHROPIC_API_KEY; a subscription login runs through the Claude Code CLI worker';
/** Variables never passed to an SDK session: a claude.ai login must not reach it. */
const LOGIN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'];

/** Tools an owned worker may be granted. Anything else is refused before a session starts. */
export const GRANTABLE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'MultiEdit', 'Write', 'Bash', 'NotebookEdit', 'TodoWrite'];

const DISALLOWED = ['EnterWorktree', 'ExitWorktree'];
const MAX_RESULT_TEXT = 8_000;

/** The subset of an SDK Query this module uses. */
export interface QueryHandle extends AsyncIterable<unknown> {
  interrupt?(): Promise<void>;
  close?(): void;
}

export interface QueryArgs {
  readonly prompt: string;
  readonly options: {
    readonly model: string;
    readonly cwd: string;
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
    readonly permissionMode: 'default';
    readonly abortController: AbortController;
    readonly env?: { readonly [key: string]: string | undefined };
    /** The SDK's `effort` option (Claude Agent SDK Options.effort); absent: the model's default. */
    readonly effort?: SdkEffort;
  };
}

/** The Agent SDK's effort levels (Options.effort, @anthropic-ai/claude-agent-sdk 0.3.282). */
export type SdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const SDK_EFFORTS: readonly SdkEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort passed to the SDK for a model, or null (none asked, or a Haiku model before 5.5, which
 * has no effort levels: the run keeps the model's default, as the Claude Code CLI worker does).
 * Haiku 5.5 takes effort `low` to `max`; the bare `haiku` alias may still mean Haiku 4.5, so it keeps none.
 */
export function sdkEffort(model: string, effort: string | undefined): SdkEffort | null {
  if (effort === undefined || (/haiku/i.test(model) && !/claude-haiku-[5-9]/i.test(model))) return null;
  return (SDK_EFFORTS as readonly string[]).includes(effort) ? (effort as SdkEffort) : null;
}

export type QueryFn = (args: QueryArgs) => QueryHandle;

export interface OwnedWorkerInput {
  readonly prompt: string;
  readonly model: string;
  /** The task worktree; the worker never runs in the user's checkout. */
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Test seam; production loads the SDK's `query`. */
  readonly query?: QueryFn;
  /** Test seam for the environment the key is read from; production uses process.env. */
  readonly env?: { readonly [key: string]: string | undefined };
  /** Receives each SDK message type as it arrives (no content). */
  readonly onEvent?: (event: { readonly type: string; readonly subtype?: string }) => void;
  /** Receives the interrupt function once the session exists. */
  readonly onStart?: (control: { readonly interrupt: () => void; readonly abort: () => void; readonly sessionId: () => string | null }) => void;
  /** The routed reasoning effort (G21); passed as the SDK's `effort` option (see `sdkEffort`). */
  readonly effort?: string;
  /**
   * Called at most once, with the first `session_id` the SDK reports (the value that becomes the
   * outcome's sessionId), so the runner links the session to its task while it runs (owner
   * decision 29423b6). A throwing callback never fails the run.
   */
  readonly onSessionId?: (sessionId: string) => void;
}

export interface WorkerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export type WorkerStatus = 'completed' | 'failed' | 'max-turns' | 'budget-exceeded' | 'aborted' | 'timeout' | 'unsupported' | 'refused' | 'access-limit' | 'overloaded';

export interface WorkerOutcome {
  readonly status: WorkerStatus;
  readonly reason: string;
  readonly sessionId: string | null;
  readonly requestedModel: string;
  /** The model the SDK reported (init message, else the largest modelUsage entry). */
  readonly actualModel: string | null;
  readonly costUsd: number | null;
  readonly usage: WorkerUsage | null;
  readonly modelUsage: { readonly [model: string]: { readonly costUsd: number; readonly inputTokens: number; readonly outputTokens: number } };
  readonly turns: number | null;
  readonly durationMs: number;
  readonly resultText: string | null;
  readonly messages: number;
  /** The effort the session was given (null: the model's default); absent before a session starts. */
  readonly effort?: SdkEffort | null;
  /**
   * A structured model-unavailable signal the session ended on (C's MODEL_UNAVAILABLE_SIGNALS
   * class id, never error text): the Claude API's HTTP 404 `not_found_error` for the requested
   * model. The orchestrator classifies it through C's table.
   */
  readonly modelSignal?: ModelSignal;
  /**
   * R64: the access signal the run ended on (E's wire shape: the HTTP status, the API's error type
   * and code, the stream's rate-limit type, a reset and a pinned text pattern id; never a message,
   * a body or a header value). The runner classifies it again in its own process (R70).
   */
  readonly accessSignal?: AccessSignalWire;
  /** This worker's own classification of `accessSignal` (status `access-limit` or `overloaded`). */
  readonly accessLimit?: AccessLimitFinding;
}

export interface ModelSignal {
  readonly port: 'claude-api';
  readonly signal: 'http-404-not-found-error';
}

/** The Claude API error's HTTP status and error type, read from structured fields only. */
function apiErrorShape(error: unknown): { readonly status: number | null; readonly type: string | null } {
  const e = rec(error);
  if (e === undefined) return { status: null, type: null };
  const status = typeof e['status'] === 'number' ? (e['status'] as number) : null;
  // The SDK's APIError carries the body as `error` ({ type: 'error', error: { type, ... } }).
  const body = rec(e['error']);
  const inner = rec(body?.['error']);
  const type = [inner?.['type'], body?.['type'] === 'error' ? undefined : body?.['type'], e['type']].find((t): t is string => typeof t === 'string') ?? null;
  return { status, type };
}

/** A vendor error type as the API spells it (`rate_limit_error`), else nothing: never free text. */
const ERROR_TYPE = /^[a-z][a-z_]{0,47}$/;

/**
 * The fixed text for a failed Agent SDK call (R80): the HTTP status and the API's error type when
 * the error carries them as structured fields, and never the message or the body.
 */
export function sdkFailureText(error: unknown): string {
  const shape = apiErrorShape(error);
  const status = shape.status !== null && Number.isInteger(shape.status) && shape.status >= 100 && shape.status <= 599 ? shape.status : null;
  const type = shape.type !== null && ERROR_TYPE.test(shape.type) ? shape.type : null;
  if (status === null && type === null) return 'the Agent SDK call failed';
  return `the Agent SDK call failed (${[status === null ? null : `HTTP ${String(status)}`, type].filter((part) => part !== null).join(' ')})`;
}

/** A vendor code as the wire takes it (`rate_limit`, `enforced_spend_limit_reached`): never text. */
const SIGNAL_CODE = /^[A-Za-z0-9._:-]{1,64}$/;
/** The response headers core's resetFromHeaders reads; no other header is looked at. */
const RESET_HEADER = /^(?:retry-after(?:-ms)?|anthropic-ratelimit-[a-z-]{1,40}-reset|x-ratelimit-reset(?:-[a-z-]{1,40})?)$/;

const code = (value: unknown): string | undefined => (typeof value === 'string' && SIGNAL_CODE.test(value) ? value : undefined);

/** The reset headers of an API error, lowercased, in memory only (fetch Headers or a plain record). */
function resetHeadersOf(headers: unknown): { readonly [name: string]: string } | null {
  const out: { [name: string]: string } = {};
  const add = (name: unknown, value: unknown): void => {
    if (typeof name !== 'string' || typeof value !== 'string') return;
    const key = name.toLowerCase();
    if (RESET_HEADER.test(key)) out[key] = value.slice(0, 128);
  };
  const h = headers as { forEach?: unknown; get?: unknown } | null | undefined;
  if (h !== null && h !== undefined && typeof h.forEach === 'function' && typeof h.get === 'function') {
    (h.forEach as (fn: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => add(name, value));
  } else {
    for (const [name, value] of Object.entries(rec(headers) ?? {})) add(name, value);
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * R64: the access signal of a failed Agent SDK call (design 5.2, `claude-api` rows): the HTTP
 * status, the body's `error.type` and `details.error_code`, the reset from the response headers,
 * and for a 400 only the id of the pinned pattern C5 its message matches. Read in memory; the
 * message and the body are dropped here. Null when the error carries no HTTP status.
 */
export function sdkAccessSignal(error: unknown, nowMs: number): AccessSignalWire | null {
  const e = rec(error);
  if (e === undefined) return null;
  const shape = apiErrorShape(error);
  const status = shape.status !== null && Number.isInteger(shape.status) && shape.status >= 100 && shape.status <= 599 ? shape.status : null;
  if (status === null) return null;
  const body = rec(e['error']);
  const inner = rec(body?.['error']);
  const details = rec(inner?.['details']) ?? rec(body?.['details']);
  const errorType = code(shape.type);
  const errorCode = code(details?.['error_code']);
  const headers = resetHeadersOf(e['headers']);
  const reset = headers === null ? null : resetFromHeaders(headers, nowMs);
  const message = typeof inner?.['message'] === 'string' ? (inner['message'] as string) : typeof e['message'] === 'string' ? (e['message'] as string) : null;
  const text = status === 400 && message !== null ? matchAccessText(message, 'claude-api', nowMs) : null;
  return {
    port: 'claude-api',
    channel: 'structured',
    status,
    ...(errorType === undefined ? {} : { errorType }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(reset === null ? {} : { resetAtMs: reset }),
    ...(text === null || text.pattern !== 'C5' ? {} : { text: { pattern: text.pattern, weekly: text.weekly, family: text.family, resetAtMs: text.resetAtMs, resetForm: text.resetForm } }),
  };
}

/** What the stream said about access (design 5.2): the last rejected rate-limit event and the last error enum. */
interface StreamAccess {
  rejected: { readonly rateLimitType?: string; readonly resetAtMs?: number } | null;
  lastError: string | null;
}

function noteStreamAccess(m: { readonly [key: string]: unknown }, type: string, subtype: string | undefined, seen: StreamAccess): void {
  if (type === 'rate_limit_event') {
    const info = rec(m['rate_limit_info']);
    if (info?.['status'] !== 'rejected') return;
    const kind = code(info['rateLimitType']);
    const resets = typeof info['resetsAt'] === 'number' && Number.isFinite(info['resetsAt']) && info['resetsAt'] > 0 ? Math.round((info['resetsAt'] as number) * 1000) : undefined;
    seen.rejected = { ...(kind === undefined ? {} : { rateLimitType: kind }), ...(resets === undefined ? {} : { resetAtMs: resets }) };
    return;
  }
  if ((type === 'system' && subtype === 'api_retry') || type === 'assistant') {
    const err = code(m['error']);
    if (err !== undefined) seen.lastError = err;
  }
}

/** The signal a run that did not succeed ended on: the stream's rejected rate limit, else the API error, else the last error enum. */
function endSignal(seen: StreamAccess, caught: AccessSignalWire | null): AccessSignalWire | null {
  if (seen.rejected !== null) return { port: 'claude-api', channel: 'structured', errorType: 'rate_limit_event', ...seen.rejected };
  if (caught !== null) return caught;
  return seen.lastError === null ? null : { port: 'claude-api', channel: 'structured', errorType: seen.lastError };
}

/** C's signal class for a Claude API 404 `not_found_error` (the requested model is gone), else null. */
export function modelSignalOf(error: unknown): ModelSignal | null {
  const shape = apiErrorShape(error);
  return shape.status === 404 && shape.type === 'not_found_error' ? { port: 'claude-api', signal: 'http-404-not-found-error' } : null;
}

let loaded: Promise<QueryFn | null> | undefined;

/** Loads the optional Agent SDK. Returns null when it is not installed. */
export async function loadAgentSdk(): Promise<QueryFn | null> {
  loaded ??= (async () => {
    try {
      const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { readonly query?: unknown };
      return typeof sdk.query === 'function' ? (sdk.query as QueryFn) : null;
    } catch {
      return null;
    }
  })();
  return loaded;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function rec(value: unknown): { readonly [key: string]: unknown } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { readonly [key: string]: unknown }) : undefined;
}

function refused(input: Pick<OwnedWorkerInput, 'model'>, reason: string, status: WorkerStatus = 'refused'): WorkerOutcome {
  return {
    status,
    reason,
    sessionId: null,
    requestedModel: input.model,
    actualModel: null,
    costUsd: null,
    usage: null,
    modelUsage: {},
    turns: null,
    durationMs: 0,
    resultText: null,
    messages: 0,
  };
}

export function validateWorkerInput(input: OwnedWorkerInput): string | null {
  if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 200_000) return 'prompt';
  if (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,127}$/.test(input.model)) return 'model';
  if (typeof input.cwd !== 'string' || input.cwd.length === 0) return 'cwd';
  if (!Array.isArray(input.allowedTools) || input.allowedTools.some((t) => !GRANTABLE_TOOLS.includes(t))) return 'allowedTools';
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 500) return 'maxTurns';
  if (typeof input.maxBudgetUsd !== 'number' || !(input.maxBudgetUsd > 0) || input.maxBudgetUsd > 1_000) return 'maxBudgetUsd';
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 24 * 3_600_000) return 'timeoutMs';
  if (input.effort !== undefined && !(SDK_EFFORTS as readonly string[]).includes(input.effort)) return 'effort';
  return null;
}

export async function runOwnedWorker(input: OwnedWorkerInput): Promise<WorkerOutcome> {
  const invalid = validateWorkerInput(input);
  if (invalid !== null) return refused(input, `invalid ${invalid}`);
  const query = input.query ?? (await loadAgentSdk());
  if (query === null) return refused(input, SDK_MISSING_MESSAGE, 'unsupported');
  // The real SDK always needs the key; an injected test query is checked only when a test env is given.
  const realSdk = input.query === undefined;
  const env = input.env ?? process.env;
  if ((realSdk || input.env !== undefined) && (env['ANTHROPIC_API_KEY'] ?? '') === '') return refused(input, SDK_NEEDS_API_KEY);
  const sessionEnv: { [key: string]: string | undefined } = {};
  for (const [key, value] of Object.entries(env)) if (!LOGIN_VARS.includes(key)) sessionEnv[key] = value;
  if (input.signal?.aborted === true) return refused(input, 'aborted before start', 'aborted');
  const controller = new AbortController();
  const started = Date.now();
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    controller.abort();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  let sessionId: string | null = null;
  let actualModel: string | null = null;
  let result: { readonly [key: string]: unknown } | undefined;
  let messages = 0;
  let handle: QueryHandle | undefined;
  let failure: string | null = null;
  let signal: ModelSignal | null = null;
  let keySource: string | null = null;
  const stream: StreamAccess = { rejected: null, lastError: null };
  let caught: AccessSignalWire | null = null;
  const effort = sdkEffort(input.model, input.effort);
  try {
    handle = query({
      prompt: input.prompt,
      options: {
        model: input.model,
        cwd: input.cwd,
        allowedTools: [...input.allowedTools],
        disallowedTools: DISALLOWED,
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd,
        permissionMode: 'default',
        abortController: controller,
        env: sessionEnv,
        ...(effort === null ? {} : { effort }),
      },
    });
    const h = handle;
    input.onStart?.({
      interrupt: () => {
        void h.interrupt?.();
      },
      abort: onAbort,
      sessionId: () => sessionId,
    });
    for await (const raw of handle) {
      messages += 1;
      const m = rec(raw);
      if (m === undefined) continue;
      const type = typeof m['type'] === 'string' ? (m['type'] as string) : 'unknown';
      const subtype = typeof m['subtype'] === 'string' ? (m['subtype'] as string) : undefined;
      input.onEvent?.(subtype === undefined ? { type } : { type, subtype });
      if (typeof m['session_id'] === 'string' && m['session_id'] !== '' && sessionId === null) {
        sessionId = m['session_id'] as string;
        try {
          input.onSessionId?.(sessionId);
        } catch {
          // The caller's bookkeeping never fails the run.
        }
      }
      if (type === 'system' && subtype === 'init' && typeof m['model'] === 'string') actualModel = m['model'] as string;
      if (type === 'system' && subtype === 'init' && (realSdk || m['apiKeySource'] !== undefined) && m['apiKeySource'] !== 'ANTHROPIC_API_KEY') {
        // Anything but the supplied key (a claude.ai login above all) ends the session at once.
        keySource = typeof m['apiKeySource'] === 'string' && /^[A-Za-z_]{1,40}$/.test(m['apiKeySource'] as string) ? (m['apiKeySource'] as string) : 'unreported';
        controller.abort();
        break;
      }
      if (type === 'result') result = m;
      noteStreamAccess(m, type, subtype, stream);
    }
  } catch (error) {
    signal = controller.signal.aborted ? null : modelSignalOf(error);
    caught = controller.signal.aborted ? null : sdkAccessSignal(error, Date.now());
    // A gone model is named by its class alone. No error text is ever kept (R80): the message
    // carries the API's body, so only the status and the error type, enum-checked, name it.
    failure = controller.signal.aborted ? 'aborted' : signal !== null ? 'the requested model was not found (HTTP 404 not_found_error)' : sdkFailureText(error);
  } finally {
    clearTimeout(timer);
    try {
      handle?.close?.();
    } catch {
      // closing a finished query is best effort
    }
  }
  const durationMs = Date.now() - started;
  const modelUsageRaw = rec(result?.['modelUsage']) ?? {};
  const modelUsage: { [model: string]: { costUsd: number; inputTokens: number; outputTokens: number } } = {};
  for (const [model, value] of Object.entries(modelUsageRaw)) {
    const u = rec(value);
    if (u === undefined) continue;
    modelUsage[model] = { costUsd: num(u['costUSD']), inputTokens: num(u['inputTokens']), outputTokens: num(u['outputTokens']) };
  }
  if (actualModel === null) {
    const top = Object.entries(modelUsage).sort((a, b) => b[1].outputTokens - a[1].outputTokens)[0];
    actualModel = top?.[0] ?? null;
  }
  const usageRaw = rec(result?.['usage']);
  const usage: WorkerUsage | null =
    usageRaw === undefined
      ? null
      : {
          inputTokens: num(usageRaw['input_tokens']),
          outputTokens: num(usageRaw['output_tokens']),
          cacheReadInputTokens: num(usageRaw['cache_read_input_tokens']),
          cacheCreationInputTokens: num(usageRaw['cache_creation_input_tokens']),
        };
  const cost = typeof result?.['total_cost_usd'] === 'number' ? (result['total_cost_usd'] as number) : null;
  const subtype = typeof result?.['subtype'] === 'string' ? (result['subtype'] as string) : null;
  let status: WorkerStatus;
  let reason: string;
  if (keySource !== null) [status, reason] = ['refused', `refused: the SDK session used key source ${keySource}, not ANTHROPIC_API_KEY`];
  else if (timedOut) [status, reason] = ['timeout', `no result within ${String(input.timeoutMs)} ms`];
  else if (aborted) [status, reason] = ['aborted', 'aborted by the caller'];
  else if (failure !== null) [status, reason] = ['failed', failure];
  else if (result === undefined) [status, reason] = ['failed', 'the stream ended without a result message'];
  else if (subtype === 'success' && result['is_error'] !== true) [status, reason] = ['completed', 'success'];
  else if (subtype === 'error_max_turns') [status, reason] = ['max-turns', subtype];
  else if (subtype === 'error_max_budget_usd') [status, reason] = ['budget-exceeded', subtype];
  else [status, reason] = ['failed', subtype !== null && ERROR_TYPE.test(subtype) ? subtype : 'error'];
  // R64: a run that did not succeed and was not stopped by Jevris may have ended on an access
  // limit. This worker classifies it only to pick its status; the runner classifies it again.
  // The Agent SDK runs only on an API key.
  const stopped = keySource !== null || timedOut || aborted;
  const accessSignal = status === 'completed' || stopped ? null : endSignal(stream, caught);
  const access = accessSignal === null ? null : classifyAccessSignal({ ...accessSignal, certified: false }, 'api-key', Date.now());
  if (access !== null) {
    [status, reason] = access.class === 'overloaded' ? ['overloaded', `the provider was overloaded (${access.signal})`] : ['access-limit', `the run hit an access limit: ${access.class} (${access.signal})`];
  }
  const accessLimit: AccessLimitFinding | null =
    access === null
      ? null
      : {
          class: access.class,
          signal: access.signal,
          weekly: access.weekly,
          resetBasis: access.resetBasis,
          ...(access.untilMs === null ? {} : { resetAtMs: access.untilMs }),
          ...(access.family === null ? {} : { family: access.family }),
        };
  const text = typeof result?.['result'] === 'string' ? (result['result'] as string).slice(0, MAX_RESULT_TEXT) : null;
  return {
    status,
    reason,
    sessionId,
    requestedModel: input.model,
    actualModel,
    costUsd: cost,
    usage,
    modelUsage,
    turns: typeof result?.['num_turns'] === 'number' ? (result['num_turns'] as number) : null,
    durationMs,
    resultText: text,
    messages,
    effort,
    ...(signal !== null && status === 'failed' ? { modelSignal: signal } : {}),
    ...(accessSignal === null || access === null ? {} : { accessSignal }),
    ...(accessLimit === null ? {} : { accessLimit }),
  };
}
