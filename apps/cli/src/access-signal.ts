/**
 * Access limits on F's owned-worker ports (design `.planning/research/access-limits.md` 5.2-5.5,
 * R63-R67, R80). Each port reads its harness's error channel in memory and builds one access
 * signal in E's wire shape: codes, a reset and a pinned text pattern id, never a message, a body or
 * a header value. This module classifies it with core, uncertified (a worker never asserts its
 * own proof), and gives the port its status and a fixed reason naming the class and the row.
 *
 * The runner classifies the signal again in its own process (D's R70), with its own lookup of the
 * certify record; the port's finding is only its claim. A port attaches the signal only when core
 * gives it a class, so an outcome with no signal records nothing.
 *
 * The per-harness readers of the error channel live here too, so the ports and certify's
 * K16-K18 cases (R69) read a transcript the same way: Claude Code's stream-json, Codex's
 * `exec --json` and stderr, and Kilo's and OpenCode's `run --format json` error events.
 */
import { classifyAccessSignal, resetFromHeaders } from '@jevris/core';
import { AccessSignalWireSchema, defineContract, matchAccessText, type AccessAuthMode, type AccessLimitFinding, type AccessSignalPort, type AccessSignalWire } from '@jevris/contracts';

import { jsonLine, rec } from './owned-session.js';

const WireContract = defineContract<AccessSignalWire>({
  name: 'AccessSignalWire',
  description: 'An access signal as an owned-worker outcome carries it (ids, codes and times only).',
  schema: AccessSignalWireSchema,
});

/** A harness code a signal may carry: E's SignalCode, never free text. */
const SIGNAL_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A code as the wire takes it, else undefined (free text, too long, or not a string). */
export function signalCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && SIGNAL_CODE.test(value) ? value : undefined;
}

/** An HTTP status the wire takes (100-599), else undefined. */
export function signalStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * The error-text signal of one error-channel text: the pinned pattern that matched (with its
 * weekly flag, family and stated reset), or null. The text itself is dropped here.
 */
export function textAccessSignal(port: AccessSignalPort, text: string | null | undefined, nowMs: number): AccessSignalWire | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match = matchAccessText(text, port, nowMs);
  if (match === null) return null;
  const resetAtMs = match.resetAtMs === null || !Number.isFinite(match.resetAtMs) || match.resetAtMs < 0 ? null : Math.round(match.resetAtMs);
  return { port, channel: 'error-text', text: { pattern: match.pattern, weekly: match.weekly, family: match.family, resetAtMs, resetForm: resetAtMs === null ? null : match.resetForm } };
}

/** What a port reports when its run ended on an access limit (status, fixed reason, signal, finding). */
export interface PortAccess {
  readonly status: 'access-limit' | 'overloaded';
  /** Fixed text naming the class and core's row id (R80): never the harness's or provider's words. */
  readonly reason: string;
  readonly accessSignal: AccessSignalWire;
  readonly accessLimit: AccessLimitFinding;
  /** The reset the harness reported (ISO), when it reported one core accepts. */
  readonly resetAt?: string;
}

/**
 * Classifies a port's signal with core, uncertified, and names the outcome. Null when the signal
 * is not a valid wire signal or core gives it no class: the run then ends as it would without one.
 */
export function portAccess(signal: AccessSignalWire | null, authMode: AccessAuthMode, nowMs: number): PortAccess | null {
  if (signal === null) return null;
  const checked = WireContract.validate(signal);
  if (!checked.ok) return null;
  const access = classifyAccessSignal({ ...checked.value, certified: false }, authMode, nowMs);
  if (access === null) return null;
  const accessLimit: AccessLimitFinding = {
    class: access.class,
    signal: access.signal,
    weekly: access.weekly,
    resetBasis: access.resetBasis,
    ...(access.untilMs === null ? {} : { resetAtMs: access.untilMs }),
    ...(access.family === null ? {} : { family: access.family }),
  };
  const overloaded = access.class === 'overloaded';
  return {
    status: overloaded ? 'overloaded' : 'access-limit',
    reason: overloaded ? `the provider was overloaded (${access.signal})` : `the run hit an access limit: ${access.class} (${access.signal})`,
    accessSignal: checked.value,
    accessLimit,
    ...(access.reportedResetMs === null ? {} : { resetAt: new Date(access.reportedResetMs).toISOString() }),
  };
}

/** The most of one error message a text pattern is run on. */
const MAX_SCAN = 4096;

// Claude Code (R63): `claude -p --output-format stream-json`.

/** What the stream said about access (design 5.2): the last rejected rate-limit event and the last error enum. */
export interface ClaudeStreamAccess {
  rejected: { readonly rateLimitType?: string; readonly resetAtMs?: number } | null;
  lastError: string | null;
}

export function claudeStreamAccess(): ClaudeStreamAccess {
  return { rejected: null, lastError: null };
}

/** Notes one stream event's access fields: a rejected rate-limit event, an `api_retry` or assistant error code. */
export function noteClaudeAccess(event: { readonly [key: string]: unknown }, type: string, subtype: string | undefined, seen: ClaudeStreamAccess): void {
  if (type === 'assistant' || (type === 'system' && subtype === 'api_retry')) {
    const error = signalCode(event['error']);
    if (error !== undefined) seen.lastError = error;
  } else if (type === 'rate_limit_event') {
    const info = rec(event['rate_limit_info']);
    if (info?.['status'] !== 'rejected') return;
    const kind = signalCode(info['rateLimitType']);
    const resets = info['resetsAt'];
    const resetAtMs = typeof resets === 'number' && Number.isFinite(resets) && resets > 0 ? Math.round(resets < 1e12 ? resets * 1000 : resets) : undefined;
    seen.rejected = { ...(kind === undefined ? {} : { rateLimitType: kind }), ...(resetAtMs === undefined ? {} : { resetAtMs }) };
  }
}

/**
 * The access signal of a whole `claude -p --output-format stream-json` transcript (certify's
 * K16-K18, R69), read as the port reads it: null when the run ended on a successful result.
 */
export function claudeTranscriptAccess(stdout: string, nowMs: number): AccessSignalWire | null {
  const seen = claudeStreamAccess();
  let result: { readonly [key: string]: unknown } | undefined;
  for (const line of stdout.split('\n')) {
    const event = jsonLine(line);
    if (event === undefined || typeof event['type'] !== 'string') continue;
    const type = event['type'] as string;
    if (type === 'result') result = event;
    else noteClaudeAccess(event, type, typeof event['subtype'] === 'string' ? (event['subtype'] as string) : undefined, seen);
  }
  const isError = result?.['is_error'] === true;
  if (result !== undefined && !isError) return null;
  return claudeAccessSignal(seen, isError && typeof result?.['result'] === 'string' ? (result['result'] as string) : null, nowMs);
}

/**
 * The access signal of a run with no successful result (R63): a rejected rate-limit event wins;
 * else the last `api_retry` or assistant error enum, with the `is_error` result's pinned pattern
 * beside it (core reads the enum first, the pattern only when the enum gives no row).
 */
export function claudeAccessSignal(seen: ClaudeStreamAccess, errorText: string | null, nowMs: number): AccessSignalWire | null {
  if (seen.rejected !== null) return { port: 'claude', channel: 'structured', errorType: 'rate_limit_event', ...seen.rejected };
  const text = textAccessSignal('claude', errorText, nowMs);
  if (seen.lastError === null) return text;
  return { port: 'claude', channel: 'structured', errorType: seen.lastError, ...(text?.text === undefined ? {} : { text: text.text }) };
}

// Codex (R65): `codex exec --json`, and stderr of a run with no error event.

/** Patterns stderr may give (guard 5): the timed ones only, so stderr never pauses without expiry. */
const STDERR_PATTERNS: ReadonlySet<string> = new Set(['X1', 'X4', 'X5']);

/** What a Codex stream said about access: the `turn.failed` message's pattern, and the last matching `error` message's. */
export interface CodexStreamAccess {
  turnFailed: AccessSignalWire | null;
  streamError: AccessSignalWire | null;
}

export function codexStreamAccess(): CodexStreamAccess {
  return { turnFailed: null, streamError: null };
}

/** Notes one event: the first `turn.failed` message's pattern, and the last `error` message that matches (Codex reports retries as errors first). */
export function noteCodexAccess(event: { readonly [key: string]: unknown }, type: string, seen: CodexStreamAccess, nowMs: number): void {
  const message = type === 'turn.failed' ? rec(event['error'])?.['message'] : type === 'error' ? event['message'] : undefined;
  if (typeof message !== 'string') return;
  const matched = textAccessSignal('codex', message.slice(0, MAX_SCAN), nowMs);
  if (type === 'turn.failed') seen.turnFailed ??= matched;
  else if (matched !== null) seen.streamError = matched;
}

/**
 * The access signal of a whole `codex exec --json` transcript (certify's K16-K18, R69), read as
 * the port reads it: null when the turn completed and the exit was clean.
 */
export function codexTranscriptAccess(stdout: string, stderr: string, exitCode: number | null, nowMs: number): AccessSignalWire | null {
  const seen = codexStreamAccess();
  let completed = false;
  let failed = false;
  for (const line of stdout.split('\n')) {
    const event = jsonLine(line);
    if (event === undefined || typeof event['type'] !== 'string') continue;
    const type = event['type'] as string;
    if (type === 'turn.completed') completed = true;
    if (type === 'turn.failed' || type === 'error') failed = true;
    noteCodexAccess(event, type, seen, nowMs);
  }
  if (completed && !failed && (exitCode === 0 || exitCode === null)) return null;
  return codexAccessSignal(seen.turnFailed, seen.streamError, !failed && exitCode !== 0 && exitCode !== null ? stderr : null, nowMs);
}

/**
 * The access signal of a Codex run with no successful turn (R65): the `turn.failed` message's
 * pinned pattern, else an `error` message's, else, for a run that exited non-zero with no error
 * event, a timed pattern in the last 4 KiB of stderr.
 */
export function codexAccessSignal(turnFailed: AccessSignalWire | null, streamError: AccessSignalWire | null, stderrText: string | null, nowMs: number): AccessSignalWire | null {
  if (turnFailed !== null) return turnFailed;
  if (streamError !== null) return streamError;
  const fromStderr = textAccessSignal('codex', stderrText, nowMs);
  return fromStderr?.text !== undefined && STDERR_PATTERNS.has(fromStderr.text.pattern) ? fromStderr : null;
}

// Kilo and OpenCode (R66): `run --format json` error events.

/** The most of a `responseBody` parsed for its structured code (design 5.2); it is then dropped. */
const MAX_BODY = 8192;

/**
 * The structured code of an error body (`details.error_code`, else `error.code`, else
 * `error.type`), from a bounded JSON parse; null when there is none or the body is not JSON.
 */
export function bodyCode(body: unknown): string | null {
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error = rec(rec(parsed)?.['error']);
  return signalCode(rec(error?.['details'])?.['error_code']) ?? signalCode(error?.['code']) ?? signalCode(error?.['type']) ?? null;
}

/**
 * The access signal of an `error` event (R66, design 5.2): the error's name, `statusCode`, the
 * body code and the reset from `responseHeaders`, with `data.message`'s pinned pattern beside them
 * (core reads it only when no structured row matched). Everything else is dropped here.
 */
export function opencodeAccessSignal(port: 'opencode' | 'kilocode', error: unknown, nowMs: number): AccessSignalWire | null {
  const e = rec(error);
  const data = rec(e?.['data']);
  const name = e?.['name'] === 'APIError' || e?.['name'] === 'ProviderAuthError' ? (e['name'] as string) : undefined;
  const status = signalStatus(data?.['statusCode']);
  const code = name === 'APIError' ? bodyCode(data?.['responseBody']) : null;
  const headers = rec(data?.['responseHeaders']);
  const reset = headers === undefined ? null : resetFromHeaders(headers, nowMs);
  const message = typeof data?.['message'] === 'string' ? (data['message'] as string) : typeof error === 'string' ? error : null;
  const text = textAccessSignal(port, message, nowMs)?.text;
  if (name === undefined) return text === undefined ? null : { port, channel: 'error-text', text };
  return {
    port,
    channel: 'structured',
    errorType: name,
    ...(status === undefined ? {} : { status }),
    ...(code === null ? {} : { errorCode: code }),
    ...(reset === null ? {} : { resetAtMs: reset }),
    ...(text === undefined ? {} : { text }),
  };
}

/**
 * The access signal of a whole `run --format json` transcript (certify's K16-K18, R69), read as
 * the port reads it: the first `error` event's signal, or null when the run reported none.
 */
export function opencodeTranscriptAccess(stdout: string, port: 'opencode' | 'kilocode', nowMs: number): AccessSignalWire | null {
  for (const line of stdout.split('\n')) {
    const event = jsonLine(line);
    if (event?.['type'] === 'error') return opencodeAccessSignal(port, event['error'], nowMs);
  }
  return null;
}
