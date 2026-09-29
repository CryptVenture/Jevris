/**
 * The Jev client used by the decision engine (PRV-01..PRV-08). It wraps one `JevTransport`
 * (the SDK port in production, the native check or the conformance mock offline) with:
 *
 * - request validation and the token/byte/question gate, with one repack before refusal;
 * - the persisted circuit breaker per provider and account;
 * - a per-attempt timeout below the remaining decision budget and caller cancellation;
 * - lane-aware retries (the hot path makes one attempt);
 * - §7.5 validation of the raw response body, with a redacted failure description.
 *
 * It returns answers, the resolved model, provider usage and duration. It never logs a body.
 */
import { contentHash, sha256Hex, type JevTransport, type JevTransportResult, type JevUsage, type JevWireRequest, type ProviderFailureKind } from '@jevris/contracts';
import type { CircuitBreaker } from './decision-circuit.js';
import { backoffDelayMs, failureDisposition, retryPolicyFor, type DecisionLane, type RetryPolicy, BACKGROUND_RETRY_POLICY } from './decision-retry.js';
import { gateRequest, DEFAULT_REQUEST_CAPS, type RequestCaps, type RequestEstimate } from './decision-tokens.js';
import {
  DEFAULT_VALIDATION_POLICY,
  validateJevRequest,
  validateJevResponse,
  type SchemaFailureKind,
  type ValidatedAnswer,
  type ValidationPolicy,
} from './decision-validate.js';

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true;
}

export interface DeadlineLike {
  remainingMs(): number;
  expired(): boolean;
}

export interface JevClientOptions {
  readonly transport: JevTransport;
  readonly breaker?: CircuitBreaker;
  /** Fingerprint of the configured credential, so a 401 disables until the configuration changes. */
  readonly credentialFingerprint?: string | null;
  readonly validation?: ValidationPolicy;
  readonly caps?: RequestCaps;
  readonly backgroundRetry?: RetryPolicy;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  /** Time kept back from each attempt for validation and returning the fallback. */
  readonly settleMarginMs?: number;
  /** Upper bound for a single attempt. */
  readonly maxAttemptMs?: number;
}

export interface AskInput {
  readonly request: JevWireRequest;
  readonly lane: DecisionLane;
  readonly deadline: DeadlineLike;
  readonly signal?: AbortSignal;
  /** Observation-only work (advice, shadow) may run while the breaker is observe-only. */
  readonly observation?: boolean;
  /** A harmless health probe (fixed non-sensitive request). */
  readonly probe?: boolean;
  /**
   * Called at most once when the request does not fit, or on a 422. Returns a smaller request, or
   * null to refuse. It must never silently cut mandatory facts (the packet builder guarantees this).
   */
  readonly repack?: (stateTokensOver: number) => JevWireRequest | null;
}

export type AskReason =
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'TOO_MANY_QUESTIONS'
  | 'CIRCUIT_OPEN'
  | 'PROVIDER_DISABLED'
  /** The provider refused for billing (a 402): disabled until the credential changes (R77). */
  | 'PROVIDER_BILLING'
  | 'OBSERVE_ONLY'
  | 'DEADLINE'
  | 'CANCELLED'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'MODEL_MISMATCH'
  /** The host's egress guard refused the request locally; nothing was sent (GOV-01, GOV-08). */
  | 'SECRET_BLOCKED'
  | 'EGRESS_NOT_APPROVED';

export type AskResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly answers: Readonly<Record<string, ValidatedAnswer>>;
      /** Provider-reported usage; null only when the route reported none (never zero-filled). */
      readonly usage: JevUsage | null;
      readonly elapsedMs: number;
      readonly attempts: number;
      readonly repacked: boolean;
      /** False while the breaker is observe-only or the route cannot reveal its model. */
      readonly automation: boolean;
      readonly route: string;
      readonly request: JevWireRequest;
      readonly requestHash: string;
      readonly responseHash: string;
      readonly requestId: string | null;
      readonly estimate: RequestEstimate;
    }
  | {
      readonly ok: false;
      readonly reasonCode: AskReason;
      readonly failure: ProviderFailureKind | null;
      readonly schemaFailure: { readonly kind: SchemaFailureKind; readonly questionId: string | null } | null;
      readonly status: number | null;
      /** True when a request may have reached the provider (so it may be billed). */
      readonly sent: boolean;
      readonly usage: JevUsage | null;
      readonly model: string | null;
      readonly elapsedMs: number;
      readonly attempts: number;
      readonly repacked: boolean;
      readonly requestHash: string | null;
      readonly responseHash: string | null;
    };

type AskFailure = Extract<AskResult, { ok: false }>;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', done);
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

function reasonForFailure(failure: ProviderFailureKind): AskReason {
  if (failure === 'cancelled') return 'CANCELLED';
  if (failure === 'deadline' || failure === 'timeout') return 'DEADLINE';
  if (failure === 'response-too-large' || failure === 'invalid-response') return 'INVALID_RESPONSE';
  if (failure === 'configuration' || failure === 'invalid-request') return 'INVALID_REQUEST';
  if (failure === 'billing') return 'PROVIDER_BILLING';
  return 'PROVIDER_ERROR';
}

export class JevClient {
  readonly #transport: JevTransport;
  readonly #breaker: CircuitBreaker | undefined;
  readonly #fingerprint: string | null;
  readonly #validation: ValidationPolicy;
  readonly #caps: RequestCaps;
  readonly #backgroundRetry: RetryPolicy;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #settleMarginMs: number;
  readonly #maxAttemptMs: number;

  constructor(options: JevClientOptions) {
    this.#transport = options.transport;
    this.#breaker = options.breaker;
    this.#fingerprint = options.credentialFingerprint ?? null;
    this.#validation = options.validation ?? DEFAULT_VALIDATION_POLICY;
    this.#caps = options.caps ?? DEFAULT_REQUEST_CAPS;
    this.#backgroundRetry = options.backgroundRetry ?? BACKGROUND_RETRY_POLICY;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#settleMarginMs = options.settleMarginMs ?? 50;
    this.#maxAttemptMs = options.maxAttemptMs ?? 10_000;
  }

  get route(): string {
    return this.#transport.route;
  }

  get pinnedModel(): string {
    return this.#validation.pinnedModel;
  }

  get breakerKey(): string {
    return `${this.#transport.providerId}:${this.#transport.accountId}`;
  }

  get calls(): number {
    return this.#transport.calls;
  }

  async ask(input: AskInput): Promise<AskResult> {
    const started = performance.now();
    const elapsed = (): number => Math.max(0, Math.round(performance.now() - started));
    let attempts = 0;
    let repacked = false;
    const fail = (
      reasonCode: AskReason,
      extra: Partial<Omit<AskFailure, 'ok' | 'reasonCode' | 'elapsedMs' | 'attempts' | 'repacked'>> = {},
    ): AskFailure => ({
      ok: false,
      reasonCode,
      failure: extra.failure ?? null,
      schemaFailure: extra.schemaFailure ?? null,
      status: extra.status ?? null,
      sent: extra.sent ?? false,
      usage: extra.usage ?? null,
      model: extra.model ?? null,
      elapsedMs: elapsed(),
      attempts,
      repacked,
      requestHash: extra.requestHash ?? null,
      responseHash: extra.responseHash ?? null,
    });

    if (aborted(input.signal)) return fail('CANCELLED');
    if (input.deadline.expired()) return fail('DEADLINE');

    let request = input.request;
    const checked = validateJevRequest(request);
    if (!checked.ok) return fail('INVALID_REQUEST');
    if (checked.request.model !== this.#validation.pinnedModel) return fail('INVALID_REQUEST');
    request = checked.request;

    let gate = gateRequest(request, this.#caps);
    if (!gate.ok && gate.reasonCode === 'REQUEST_TOO_LARGE' && input.repack !== undefined) {
      const smaller = input.repack(gate.stateTokensOver);
      repacked = true;
      if (smaller === null) return fail('REQUEST_TOO_LARGE');
      const rechecked = validateJevRequest(smaller);
      if (!rechecked.ok) return fail('INVALID_REQUEST');
      request = rechecked.request;
      gate = gateRequest(request, this.#caps);
    }
    if (!gate.ok) return fail(gate.reasonCode);
    // The estimate of the request actually sent: a 422 repack below replaces it (P7 compares it with reported usage).
    let estimate = gate.estimate;

    const key = this.breakerKey;
    const admission = this.#breaker?.admit(key, {
      observation: input.observation === true || input.probe === true,
      fingerprint: this.#fingerprint,
      ...(input.probe === true ? { probe: true } : {}),
    }) ?? { admitted: true as const, automation: true, probeOnly: false as const };
    if (!admission.admitted) return fail(admission.reasonCode);

    const policy = retryPolicyFor(input.lane, this.#backgroundRetry);
    let requestHash = contentHash(request);
    let lastFailure: AskFailure | null = null;
    let usedRepackOn422 = repacked;
    let sentAny = false;

    while (attempts < policy.maxAttempts) {
      if (aborted(input.signal)) return fail('CANCELLED', { sent: sentAny, requestHash });
      const remaining = input.deadline.remainingMs() - this.#settleMarginMs;
      if (remaining <= 0) return lastFailure ?? fail('DEADLINE', { sent: sentAny, requestHash });
      const timeoutMs = Math.max(1, Math.min(this.#maxAttemptMs, Math.floor(remaining)));
      attempts += 1;
      const outcome: JevTransportResult = await this.#transport.call(request, {
        timeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (outcome.ok) {
        sentAny = true;
        if (aborted(input.signal)) return fail('CANCELLED', { sent: true, requestHash });
        if (input.deadline.expired()) return fail('DEADLINE', { sent: true, requestHash });
        const responseHash = `sha256:${sha256Hex(outcome.body)}`;
        const validated = validateJevResponse(outcome.body, request.questions, this.#validation);
        if (!validated.ok) {
          // A malformed body is not a transport fault: it does not trip the breaker, and it is never retried.
          return fail(validated.failure === 'model-mismatch' ? 'MODEL_MISMATCH' : 'INVALID_RESPONSE', {
            sent: true,
            schemaFailure: { kind: validated.failure, questionId: validated.questionId },
            status: outcome.status,
            usage: validated.usage,
            model: validated.model,
            requestHash,
            responseHash,
          });
        }
        this.#breaker?.recordSuccess(key, validated.model, input.probe === true ? { probe: true } : {});
        await this.#breaker?.persist();
        return {
          ok: true,
          model: validated.model,
          answers: validated.answers,
          usage: outcome.usageUnknown === true ? null : validated.usage,
          elapsedMs: elapsed(),
          attempts,
          repacked,
          automation: admission.automation && outcome.advisoryOnly !== true,
          route: this.#transport.route,
          request,
          requestHash,
          responseHash,
          requestId: outcome.requestId,
          estimate,
        };
      }
      if (outcome.localRefusal !== undefined) {
        // A local refusal is not a provider failure: no breaker count, never retried, not sent.
        return fail(outcome.localRefusal, { sent: sentAny, requestHash });
      }
      sentAny = sentAny || outcome.sent;
      this.#breaker?.recordFailure(key, outcome.failure, this.#fingerprint, outcome.retryAfterMs);
      const disposition = failureDisposition(outcome.failure, outcome.status);
      lastFailure = fail(reasonForFailure(outcome.failure), { failure: outcome.failure, status: outcome.status, sent: sentAny, requestHash });
      if (disposition === 'disable' || disposition === 'stop') break;
      if (disposition === 'repack') {
        if (usedRepackOn422 || input.repack === undefined) break;
        const smaller = input.repack(Math.ceil(estimate.stateTokens / 4));
        usedRepackOn422 = true;
        repacked = true;
        if (smaller === null) break;
        const rechecked = validateJevRequest(smaller);
        if (!rechecked.ok) break;
        const regated = gateRequest(rechecked.request, this.#caps);
        if (!regated.ok) break;
        request = rechecked.request;
        estimate = regated.estimate;
        requestHash = contentHash(request);
        // A repacked request is a changed request, so it may be sent once more.
        if (attempts >= policy.maxAttempts) attempts = policy.maxAttempts - 1;
        continue;
      }
      if (attempts >= policy.maxAttempts) break;
      const delay = backoffDelayMs(attempts, policy, outcome.retryAfterMs, this.#random);
      if (delay >= input.deadline.remainingMs() - this.#settleMarginMs) break;
      await this.#sleep(delay, input.signal);
    }
    await this.#breaker?.persist();
    return lastFailure ?? fail('PROVIDER_ERROR', { sent: sentAny, requestHash });
  }
}

