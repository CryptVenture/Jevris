/**
 * Retry policy (PRV-07, §7.6). The hot path makes one attempt. Background evaluation retries
 * 429, 529 and selected transient failures with bounded exponential backoff, jitter and
 * `Retry-After`. Authentication and schema errors are never retried unchanged: a 401, a billing
 * refusal (402) or a 403 account restriction disables the provider until the configuration
 * changes (R77, SPEC §17.3), and a 422 is repacked once.
 */
import type { ProviderFailureKind } from '@jevris/contracts';

export type DecisionLane = 'interactive' | 'background';

export type FailureDisposition = 'retry' | 'repack' | 'disable' | 'stop';

export interface RetryPolicy {
  /** Total attempts including the first. Interactive work always uses 1. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of each delay randomly subtracted, from 0 to 1. */
  readonly jitter: number;
  /** A longer server delay is capped here. */
  readonly maxRetryAfterMs: number;
}

export const BACKGROUND_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8000,
  jitter: 0.25,
  maxRetryAfterMs: 30_000,
});

export const INTERACTIVE_RETRY_POLICY: RetryPolicy = Object.freeze({ ...BACKGROUND_RETRY_POLICY, maxAttempts: 1 });

export function retryPolicyFor(lane: DecisionLane, background: RetryPolicy = BACKGROUND_RETRY_POLICY): RetryPolicy {
  return lane === 'interactive' ? INTERACTIVE_RETRY_POLICY : background;
}

/** What to do after a transport failure. `status` distinguishes 400 from 422. */
export function failureDisposition(failure: ProviderFailureKind, status: number | null): FailureDisposition {
  switch (failure) {
    case 'auth':
    case 'billing':
    case 'forbidden':
      return 'disable';
    case 'invalid-request':
      return status === 422 ? 'repack' : 'stop';
    case 'rate-limited':
    case 'overloaded':
    case 'server':
    case 'timeout':
    case 'connection':
      return 'retry';
    default:
      return 'stop';
  }
}

/**
 * Delay before retry number `retry` (1 = first retry). Exponential from the base, capped, with
 * jitter subtracted. A server `Retry-After` is honoured up to the cap and never shortened.
 */
export function backoffDelayMs(retry: number, policy: RetryPolicy, retryAfterMs: number | null, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(30, retry - 1));
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const r = Math.min(1, Math.max(0, random()));
  const jittered = Math.max(0, Math.round(base - base * policy.jitter * r));
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return jittered;
  return Math.max(jittered, Math.min(Math.round(retryAfterMs), policy.maxRetryAfterMs));
}
