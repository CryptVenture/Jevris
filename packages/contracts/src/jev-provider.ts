/**
 * The Jev provider port (§2.5, §7.5, §7.6, R02). One production transport (the official SDK),
 * one offline native reference check and one conformance mock all implement `JevTransport`.
 * The decision engine talks only to `JevTransport`; response bodies are raw bytes that the
 * engine validates as hostile input. Nothing here carries a credential: a transport receives
 * its key from the host secret store when it is constructed, never through a call.
 */
import type { JevQuestions } from './decision.js';
import type { Json } from './json.js';

/** The native request: pinned model, state packet and one to twelve questions. */
export interface JevWireRequest {
  readonly model: string;
  readonly state: string | readonly Json[] | { readonly [key: string]: Json };
  readonly questions: JevQuestions;
}

/**
 * Failure kinds. Each maps to one handling rule (§7.6):
 * - `auth` (401) and `forbidden` (403) are never retried; 401 disables the provider until the
 *   configuration changes.
 * - `invalid-request` (400, 422) is never retried unchanged; a 422 is repacked once.
 * - `rate-limited` (429), `overloaded` (529), `server` (5xx), `timeout` and `connection` are
 *   transient: background work retries them with backoff; the hot path does not.
 * - `cancelled` and `deadline` end the decision with its fallback.
 */
export const PROVIDER_FAILURE_KINDS = [
  'auth',
  'forbidden',
  'invalid-request',
  'rate-limited',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'cancelled',
  'deadline',
  'response-too-large',
  'invalid-response',
  'configuration',
  // Access limits R59 and R77: 402, or a pinned structured billing code. Not transient; it
  // disables provider calls until the credential changes.
  'billing',
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export const TRANSIENT_FAILURE_KINDS: readonly ProviderFailureKind[] = Object.freeze([
  'rate-limited',
  'overloaded',
  'server',
  'timeout',
  'connection',
]);

export interface JevCallOptions {
  /** Cancels the in-flight request (session cancellation or the decision deadline). */
  readonly signal?: AbortSignal;
  /** Per-attempt timeout. Always below the remaining decision budget. */
  readonly timeoutMs: number;
}

export type JevTransportResult =
  | {
      readonly ok: true;
      readonly status: number;
      /** The raw response body. The caller validates it; the transport never repairs it. */
      readonly body: Uint8Array;
      readonly requestId: string | null;
      readonly elapsedMs: number;
      /** A gateway that cannot reveal its resolved model: the answer is advisory-only (§2.6). */
      readonly advisoryOnly?: boolean;
      /** The route reported no usage; it stays unknown, never zero. */
      readonly usageUnknown?: boolean;
    }
  | {
      readonly ok: false;
      readonly failure: ProviderFailureKind;
      readonly status: number | null;
      /** Server retry delay (Retry-After / retry-after-ms), when the provider sent one. */
      readonly retryAfterMs: number | null;
      /** True when bytes may have reached the provider, so the call may still be billed. */
      readonly sent: boolean;
      readonly requestId: string | null;
      readonly elapsedMs: number;
      /**
       * The host's egress guard answered locally (status 451, `x-jevris-egress: refused`):
       * nothing left the machine. Recorded as a local refusal, never as a provider failure.
       */
      readonly localRefusal?: LocalEgressRefusal;
    };

/** Reasons a local egress guard refuses a request before it is sent (GOV-01, GOV-08). */
export const LOCAL_EGRESS_REFUSALS = ['EGRESS_NOT_APPROVED', 'SECRET_BLOCKED'] as const;
export type LocalEgressRefusal = (typeof LOCAL_EGRESS_REFUSALS)[number];

/** The header a local egress guard sets on its 451 answer. */
export const LOCAL_EGRESS_HEADER = 'x-jevris-egress';

/**
 * Reads a local egress guard's answer: status 451 with `x-jevris-egress: refused` and a body
 * `{ error: { reasonCode } }`. Anything else is not a local refusal.
 */
export function localEgressRefusal(status: number, header: string | null, body: unknown): LocalEgressRefusal | null {
  if (status !== 451 || header !== 'refused') return null;
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const code = error !== null && typeof error === 'object' ? (error as { reasonCode?: unknown }).reasonCode : undefined;
  if (code === 'EGRESS_SECRET_BLOCKED' || code === 'SECRET_BLOCKED') return 'SECRET_BLOCKED';
  return 'EGRESS_NOT_APPROVED';
}

export interface JevTransport {
  /** Stable route id, part of the decision cache key: `typesafe-sdk`, `typesafe-native`, `mock`, `gateway-*`. */
  readonly route: string;
  /** Provider and account for the circuit breaker (§7.6: per provider/account, not per repository). */
  readonly providerId: string;
  readonly accountId: string;
  /** Number of requests that reached the transport's fetch. */
  readonly calls: number;
  call(request: JevWireRequest, options: JevCallOptions): Promise<JevTransportResult>;
}

/** Token usage as reported by the provider. Unknown usage is `null`, never zero. */
export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
