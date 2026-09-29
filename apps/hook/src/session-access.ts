/**
 * Access limits seen in interactive sessions (R68; design `.planning/research/access-limits.md`
 * 6.1 and 5.5). The launcher adds one access signal, in E's wire shape, to the payload of an event
 * that ends a turn on an error; D's subscriber classifies it in the sidecar (R71).
 *
 * - Claude Code: `StopFailure` (kind `turn.failed`, `worker.failed` for a subagent): its `error`
 *   code (the hooks reference, code.claude.com/docs/en/hooks#stopfailure; the older `error_type`
 *   is read when `error` is absent), and the id of a pinned C pattern that its `error_details`,
 *   else its `last_assistant_message` (the API error string), else an `error_message`, matches.
 * - Kilo and OpenCode: an assistant `message.updated` whose `info.error` is set (kind
 *   `message.completed`, payload `errored: true`): the error's name, `statusCode`, the
 *   structured code of a bounded `responseBody` parse, and a pinned pattern id from
 *   `data.message`. A `session.error` (kind `turn.failed`) carries one only when its error names
 *   the provider (`data.providerID`, as a ProviderAuthError does); an APIError reaches Jevris on
 *   the failed message too, so it is sent once, from there (B's review of R68). The reset comes
 *   from the error's `responseHeaders` (retry-after and the known reset headers, read by
 *   contracts' `resetFromHeaders`; only the time is kept).
 * - Antigravity: `Stop` (kind `turn.stopped`) whose `terminationReason` is `"error"`: the id of a
 *   pinned G pattern its `error` string matches (the hooks reference: "the error message if
 *   termination was caused by a system error"). Text only and uncertified, so core holds a credit
 *   or blocked match as a timed pause (OP-4). The provider is Google's: Antigravity has no custom
 *   endpoint. The Stop stays `turn.stopped` (coordinator's option b).
 *
 * The message, the body and the header values are read in memory here and dropped: only codes and
 * a pattern id leave. A signal is sent only when the provider is known and nothing redirects its
 * endpoint (guard 6, OP-12): the caller's `redirected` check.
 */
import { AccessSignalWireSchema, defineContract, matchAccessText, resetFromHeaders, type AccessSignalPort, type AccessSignalWire, type LauncherName, type NormalizedHarnessEvent } from '@jevris/contracts';

const WireContract = defineContract<AccessSignalWire>({
  name: 'AccessSignalWire',
  description: 'An access signal as a hook event carries it (ids, codes and times only).',
  schema: AccessSignalWireSchema,
});

const SIGNAL_CODE = /^[A-Za-z0-9._:-]{1,64}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The most of a `responseBody` parsed for its structured code; it is then dropped. */
const MAX_BODY = 8192;
const FAILED_KINDS: ReadonlySet<string> = new Set(['turn.failed', 'worker.failed']);

type Rec = { readonly [key: string]: unknown };

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;
}

function code(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && SIGNAL_CODE.test(value) ? value : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** The structured code of an error body: `details.error_code`, else `error.code`, else `error.type`. */
function bodyCode(body: unknown): string | undefined {
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = rec(rec(parsed)?.['error']);
  return code(rec(error?.['details'])?.['error_code']) ?? code(error?.['code']) ?? code(error?.['type']);
}

function textOf(port: AccessSignalPort, text: unknown, nowMs: number): AccessSignalWire['text'] | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const match = matchAccessText(text, port, nowMs);
  return match === null ? undefined : { pattern: match.pattern, weekly: match.weekly, family: match.family, resetAtMs: match.resetAtMs, resetForm: match.resetForm };
}

function valid(signal: AccessSignalWire | null): AccessSignalWire | null {
  if (signal === null) return null;
  const checked = WireContract.validate(signal);
  return checked.ok ? checked.value : null;
}

/** What the launcher found: the signal, and the provider whose endpoint guard 6 must check. */
export interface SessionAccess {
  readonly signal: AccessSignalWire;
  /** `anthropic` for Claude Code; the error's or message's provider id for Kilo and OpenCode. */
  readonly provider: string;
}

/** The signal of a Kilo or OpenCode error object (`{name, data}`), or null. */
function pluginSignal(port: 'kilocode' | 'opencode', error: unknown, nowMs: number): AccessSignalWire | null {
  const e = rec(error);
  const data = rec(e?.['data']);
  const name = e?.['name'] === 'APIError' || e?.['name'] === 'ProviderAuthError' ? (e['name'] as string) : undefined;
  const status = httpStatus(data?.['statusCode']);
  const errorCode = name === 'APIError' ? bodyCode(data?.['responseBody']) : undefined;
  const headers = rec(data?.['responseHeaders']);
  const reset = name === 'APIError' && headers !== undefined ? resetFromHeaders(headers, nowMs) : null;
  const text = textOf(port, data?.['message'], nowMs);
  if (name === undefined) return text === undefined ? null : { port, channel: 'error-text', text };
  return {
    port,
    channel: 'structured',
    errorType: name,
    ...(status === undefined ? {} : { status }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(reset === null || !Number.isSafeInteger(Math.round(reset)) || reset <= nowMs ? {} : { resetAtMs: Math.round(reset) }),
    ...(text === undefined ? {} : { text }),
  };
}

/**
 * The access signal of one normalized event, read from its native input (see the module comment),
 * or null: an event that did not end a turn on an error, or whose error gives no code or pattern.
 */
export function sessionAccessOf(harness: LauncherName, event: NormalizedHarnessEvent, native: unknown, nowMs: number): SessionAccess | null {
  const input = rec(native);
  if (input === undefined) return null;
  if (harness === 'claude') {
    if (!FAILED_KINDS.has(event.kind) || event.nativeEventName !== 'StopFailure') return null;
    const errorType = code(input['error']) ?? code(input['error_type']);
    const text = textOf('claude', input['error_details'], nowMs) ?? textOf('claude', input['last_assistant_message'], nowMs) ?? textOf('claude', input['error_message'], nowMs);
    if (errorType === undefined && text === undefined) return null;
    const signal = valid(errorType === undefined ? { port: 'claude', channel: 'error-text', ...(text === undefined ? {} : { text }) } : { port: 'claude', channel: 'structured', errorType, ...(text === undefined ? {} : { text }) });
    return signal === null ? null : { signal, provider: 'anthropic' };
  }
  if (harness === 'agy') {
    if (event.kind !== 'turn.stopped' || event.nativeEventName !== 'Stop' || input['terminationReason'] !== 'error') return null;
    const text = textOf('antigravity', input['error'], nowMs);
    const signal = text === undefined ? null : valid({ port: 'antigravity', channel: 'error-text', text });
    return signal === null ? null : { signal, provider: 'google' };
  }
  if (harness !== 'kilo' && harness !== 'opencode') return null;
  const port = harness === 'kilo' ? 'kilocode' : 'opencode';
  const props = rec(rec(input['event'])?.['properties']);
  if (props === undefined) return null;
  let error: unknown;
  let provider: unknown;
  if (event.kind === 'message.completed' && event.payload['errored'] === true) {
    const info = rec(props['info']);
    error = info?.['error'];
    provider = info?.['providerID'];
  } else if (FAILED_KINDS.has(event.kind) && event.nativeEventName === 'session.error') {
    error = props['error'];
    provider = rec(rec(error)?.['data'])?.['providerID'];
  } else return null;
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) return null;
  const signal = valid(pluginSignal(port, error, nowMs));
  return signal === null ? null : { signal, provider };
}
