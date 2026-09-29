/**
 * The production Jev transport on the official `@typesafe-ai/sdk` (PRV-05, §2.5).
 *
 * - `systemOne` with an explicit `apiKey` (from the host secret store) and an explicit API-root
 *   `baseURL`; the SDK never reads `TYPESAFE_API_KEY` or other environment configuration here.
 * - SDK retries are off (`maxRetries: 0`); retries are the engine's lane-aware policy.
 * - A per-attempt timeout chosen by the caller below the remaining decision budget bounds the
 *   whole call (connect, headers and body read) through a caller-owned deadline, whether or not
 *   the SDK timer or fetch honours its signal; the caller's AbortSignal cancels the request.
 * - The SDK logger discards everything, so no request or response body is ever logged.
 * - The raw response is read through a byte cap and handed back unparsed: validation is the
 *   engine's job (§7.5). The SDK's own parse is never used for a decision.
 */
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  type Logger,
  type SystemOneRequest,
} from '@typesafe-ai/sdk';
import {
  EXPLICIT_BASE_URL,
  LOCAL_EGRESS_HEADER,
  localEgressRefusal,
  type JevCallOptions,
  type LocalEgressRefusal,
  type JevTransport,
  type JevTransportResult,
  type JevWireRequest,
  type ProviderFailureKind,
} from '@jevris/contracts';
import { resetFromHeaders } from '@jevris/core';
import { callDeadline, readBodyCapped } from './call-deadline.js';

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

const discardingLogger: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const NO_RETRY = {
  maxRetries: 0,
  apiTimeoutError: false,
  apiConnectionError: false,
  httpStatuses: new Set<number>(),
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SdkTransportOptions {
  /** From the host secret store. Never from argv, the environment or a model. */
  readonly apiKey: string;
  /** The API root. Default and only production value: https://api.typesafe.ai (no /v1). */
  readonly baseURL?: string;
  /** Injected for tests and the conformance mock; default global fetch. */
  readonly fetch?: FetchLike;
  readonly maxResponseBytes?: number;
  readonly accountId?: string;
  /** Route id recorded with every decision. */
  readonly route?: string;
}

/** Per-call send state: whether bytes may have left, and why a local guard refused them. */
interface SendState {
  sent: boolean;
  oversize: boolean;
  localRefusal?: LocalEgressRefusal;
}

class ResponseTooLarge extends Error {
  constructor() {
    super('RESPONSE_TOO_LARGE');
  }
}

/**
 * A status's failure kind. 402 is `billing` (R77: disabled until the credential changes). A 400 or
 * 403 counts as billing only for a structured body code in a pinned list, and TypeSafe's billing
 * body is not known yet, so only 402 does.
 */
export function statusFailure(status: number): ProviderFailureKind {
  if (status === 401) return 'auth';
  if (status === 402) return 'billing';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status === 529) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'invalid-request';
}

/**
 * The server's delay in milliseconds, from core's one reset-header reader (`resetFromHeaders`:
 * `retry-after-ms`, `Retry-After` in seconds or an HTTP date, then the rate-limit reset headers).
 */
export function retryAfterFrom(headers: Headers | undefined, nowMs: number = Date.now()): number | null {
  if (headers === undefined) return null;
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (Object.keys(record).length < 64) record[name] = value;
  });
  const at = resetFromHeaders(record, nowMs);
  return at === null ? null : Math.max(0, at - nowMs);
}

async function readCapped(response: Response, cap: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  if (response.body === null) return new Uint8Array();
  return readBodyCapped(response.body, cap, signal, () => new ResponseTooLarge());
}

/**
 * Wraps fetch so the body the SDK buffers is already bounded: an oversize body is refused before
 * it is held in memory, the body read obeys the request's abort signal, and the call is marked
 * sent the moment fetch is invoked.
 */
function cappedFetch(inner: FetchLike, cap: number, state: SendState): FetchLike {
  return async (input, init) => {
    state.sent = true;
    const response = await inner(input, init);
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, cap, init?.signal ?? undefined);
    } catch (error) {
      if (error instanceof ResponseTooLarge) state.oversize = true;
      throw error;
    }
    if (response.status === 451 && response.headers.get(LOCAL_EGRESS_HEADER) !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
      } catch {
        parsed = null;
      }
      const refusal = localEgressRefusal(response.status, response.headers.get(LOCAL_EGRESS_HEADER), parsed);
      if (refusal !== null) {
        // Answered on this machine: nothing was sent, so nothing can be billed.
        state.sent = false;
        state.localRefusal = refusal;
      }
    }
    return new Response(bytes.byteLength === 0 && response.status === 204 ? null : (bytes as unknown as BodyInit), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function failureOf(
  error: unknown,
  state: SendState,
  signal: AbortSignal | undefined,
): { failure: ProviderFailureKind; status: number | null; retryAfterMs: number | null; requestId: string | null; localRefusal?: LocalEgressRefusal } {
  if (state.localRefusal !== undefined) return { failure: 'configuration', status: null, retryAfterMs: null, requestId: null, localRefusal: state.localRefusal };
  if (state.oversize) return { failure: 'response-too-large', status: null, retryAfterMs: null, requestId: null };
  if (error instanceof APIUserAbortError || aborted(signal)) return { failure: 'cancelled', status: null, retryAfterMs: null, requestId: null };
  if (error instanceof APITimeoutError) return { failure: 'timeout', status: null, retryAfterMs: null, requestId: null };
  if (error instanceof APIConnectionError) return { failure: 'connection', status: null, retryAfterMs: null, requestId: null };
  if (error instanceof APIError) {
    const retryAfterMs = error instanceof RateLimitError && error.retryAfterMs !== undefined ? error.retryAfterMs : retryAfterFrom(error.headers);
    return { failure: statusFailure(error.status), status: error.status, retryAfterMs, requestId: error.requestId ?? null };
  }
  if (error instanceof TypeSafeError) return { failure: 'configuration', status: null, retryAfterMs: null, requestId: null };
  return { failure: 'connection', status: null, retryAfterMs: null, requestId: null };
}

function accepted(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/.test(value);
}

export class SdkTransport implements JevTransport {
  readonly route: string;
  readonly providerId = 'typesafe';
  readonly accountId: string;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #fetch: FetchLike;
  readonly #cap: number;
  #calls = 0;

  constructor(options: SdkTransportOptions) {
    if (typeof options.apiKey !== 'string' || !accepted(options.apiKey)) throw new Error('PROVIDER_KEY_INVALID');
    const baseURL = options.baseURL ?? EXPLICIT_BASE_URL;
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(baseURL) && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(baseURL)) throw new Error('PROVIDER_BASE_URL');
    this.#cap = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.route = options.route ?? 'typesafe-sdk';
    this.accountId = options.accountId ?? 'primary';
    this.#apiKey = options.apiKey;
    this.#baseURL = baseURL;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** One client per call, so concurrent calls never share the sent/oversize state. */
  #client(state: SendState): TypeSafeClient {
    const counting: FetchLike = async (input, init) => {
      this.#calls += 1;
      const response = await this.#fetch(input, init);
      // A local egress refusal never reached the provider, so it is not a call.
      if (response.status === 451 && response.headers.get(LOCAL_EGRESS_HEADER) === 'refused') this.#calls -= 1;
      return response;
    };
    return new TypeSafeClient({
      apiKey: this.#apiKey,
      baseURL: this.#baseURL,
      defaultModel: 'jev-1.13.0',
      logLevel: 'off',
      logger: discardingLogger,
      retry: NO_RETRY,
      timeout: 10_000,
      fetch: cappedFetch(counting, this.#cap, state),
    });
  }

  get calls(): number {
    return this.#calls;
  }

  /**
   * One call bounded end to end by `options.timeoutMs`: connect, headers and the body read all sit
   * under one caller-owned deadline (`callDeadline`), which does not depend on the SDK timer or on
   * fetch honouring its signal. Expiry is `timeout` (DEADLINE); a caller abort is `cancelled`.
   */
  async call(request: JevWireRequest, options: JevCallOptions): Promise<JevTransportResult> {
    const started = performance.now();
    const elapsedMs = (): number => Math.max(0, Math.round(performance.now() - started));
    const state: SendState = { sent: false, oversize: false };
    if (aborted(options.signal)) {
      return { ok: false, failure: 'cancelled', status: null, retryAfterMs: null, sent: false, requestId: null, elapsedMs: elapsedMs() };
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return { ok: false, failure: 'deadline', status: null, retryAfterMs: null, sent: false, requestId: null, elapsedMs: elapsedMs() };
    }
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
    const deadline = callDeadline(timeoutMs, options.signal);
    try {
      const work = (async (): Promise<{ response: Response; body: Uint8Array }> => {
        const response = await this.#client(state)
          .systemOne(request as unknown as SystemOneRequest, { timeout: timeoutMs, retry: NO_RETRY, signal: deadline.signal })
          .asResponse();
        // The SDK hands back a body it already buffered; reading it is still under the deadline.
        const body = new Uint8Array(await response.arrayBuffer());
        return { response, body };
      })();
      const { response, body } = await deadline.guard(work);
      if (deadline.state === 'cancelled' || aborted(options.signal)) {
        return { ok: false, failure: 'cancelled', status: null, retryAfterMs: null, sent: true, requestId: null, elapsedMs: elapsedMs() };
      }
      if (deadline.state === 'expired') {
        return { ok: false, failure: 'timeout', status: null, retryAfterMs: null, sent: true, requestId: null, elapsedMs: elapsedMs() };
      }
      return { ok: true, status: response.status, body, requestId: response.headers.get('x-typesafe-request-id'), elapsedMs: elapsedMs() };
    } catch (error) {
      if (state.localRefusal === undefined && !state.oversize) {
        if (deadline.state === 'expired') return { ok: false, failure: 'timeout', status: null, retryAfterMs: null, sent: state.sent, requestId: null, elapsedMs: elapsedMs() };
        if (deadline.state === 'cancelled') return { ok: false, failure: 'cancelled', status: null, retryAfterMs: null, sent: state.sent, requestId: null, elapsedMs: elapsedMs() };
      }
      const mapped = failureOf(error, state, options.signal);
      return { ok: false, ...mapped, sent: state.sent, elapsedMs: elapsedMs() };
    } finally {
      deadline.dispose();
    }
  }
}

export function createSdkTransport(options: SdkTransportOptions): SdkTransport {
  return new SdkTransport(options);
}
