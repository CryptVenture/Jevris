/**
 * The native HTTP reference path (PRV-06, §2.5), ported from `ssot_docs/reference/jev-client.ts`.
 *
 * It is an offline contract check, not a second production client: the conformance suite runs
 * the same fixtures through it and through the SDK transport and requires identical outcomes.
 * The sidecar never constructs it. It uses plain `fetch`, refuses redirects, reads the body
 * through a byte cap under the same caller-owned total deadline as the SDK port, and never logs.
 */
import { LOCAL_EGRESS_HEADER, localEgressRefusal, type JevCallOptions, type JevTransport, type JevTransportResult, type JevWireRequest } from '@jevris/contracts';
import { callDeadline, readBodyCapped } from './call-deadline.js';
import { DEFAULT_MAX_RESPONSE_BYTES, retryAfterFrom, statusFailure, type FetchLike } from './sdk-transport.js';

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true;
}

export interface NativeTransportOptions {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly baseURL?: string;
  readonly maxResponseBytes?: number;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

class ResponseTooLarge extends Error {
  constructor() {
    super('RESPONSE_TOO_LARGE');
  }
}

export class NativeReferenceTransport implements JevTransport {
  readonly route = 'typesafe-native';
  readonly providerId = 'typesafe';
  readonly accountId = 'primary';
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #url: string;
  readonly #cap: number;
  #calls = 0;

  constructor(options: NativeTransportOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '' || /[\r\n\0]/.test(options.apiKey)) throw new Error('PROVIDER_KEY_INVALID');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#url = new URL('v1/systemone', `${(options.baseURL ?? 'https://api.typesafe.ai').replace(/\/+$/, '')}/`).href;
    this.#cap = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  get calls(): number {
    return this.#calls;
  }

  async call(request: JevWireRequest, options: JevCallOptions): Promise<JevTransportResult> {
    const started = performance.now();
    const elapsedMs = (): number => Math.max(0, Math.round(performance.now() - started));
    const failed = (failure: Extract<JevTransportResult, { ok: false }>['failure'], sent: boolean, status: number | null = null, retryAfterMs: number | null = null): JevTransportResult => ({
      ok: false,
      failure,
      status,
      retryAfterMs,
      sent,
      requestId: null,
      elapsedMs: elapsedMs(),
    });
    if (aborted(options.signal)) return failed('cancelled', false);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return failed('deadline', false);
    const serialized = JSON.stringify(request);
    // One caller-owned deadline over connect, headers and body, even when fetch ignores its signal.
    const deadline = callDeadline(options.timeoutMs, options.signal);
    let sent = false;
    try {
      this.#calls += 1;
      sent = true;
      const response = await deadline.guard(
        this.#fetch(this.#url, {
          method: 'POST',
          redirect: 'error',
          signal: deadline.signal,
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: serialized,
        }),
      );
      const requestId = response.headers.get('x-typesafe-request-id');
      if (response.status === 451 && response.headers.get(LOCAL_EGRESS_HEADER) !== null) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(await deadline.guard(response.text())) as unknown;
        } catch {
          parsed = null;
        }
        const refusal = localEgressRefusal(response.status, response.headers.get(LOCAL_EGRESS_HEADER), parsed);
        if (refusal !== null) {
          // Answered on this machine: nothing was sent, so nothing can be billed.
          this.#calls -= 1;
          return { ...(failed('configuration', false) as Extract<JevTransportResult, { ok: false }>), localRefusal: refusal };
        }
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ...failed(statusFailure(response.status), true, response.status, retryAfterFrom(response.headers)), requestId } as JevTransportResult;
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.#cap) {
        await response.body?.cancel().catch(() => undefined);
        return failed('response-too-large', true);
      }
      if (response.body === null) return failed('invalid-response', true);
      let body: Uint8Array;
      try {
        body = await deadline.guard(readBodyCapped(response.body, this.#cap, deadline.signal, () => new ResponseTooLarge()));
      } catch (error) {
        if (error instanceof ResponseTooLarge) return failed('response-too-large', true);
        throw error;
      }
      if (deadline.state === 'cancelled' || aborted(options.signal)) return failed('cancelled', true);
      if (deadline.state === 'expired') return failed('timeout', true);
      return { ok: true, status: response.status, body, requestId, elapsedMs: elapsedMs() };
    } catch (error) {
      if (deadline.state === 'expired') return failed('timeout', sent);
      if (deadline.state === 'cancelled' || aborted(options.signal)) return failed('cancelled', sent);
      if (isAbort(error)) return failed('cancelled', sent);
      return failed('connection', sent);
    } finally {
      deadline.dispose();
    }
  }
}

export function createNativeReferenceTransport(options: NativeTransportOptions): NativeReferenceTransport {
  return new NativeReferenceTransport(options);
}
