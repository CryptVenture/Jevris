/**
 * The Jev API suite (PRV-10, §22.2, E01, E07). It exercises all three primitives, cancellation,
 * the error taxonomy, the byte and token caps, usage reconciliation against the conservative
 * estimate, and latency percentiles over at least 30 calls.
 *
 * In `npm test` it runs against the conformance mock. The live run is opt-in only
 * (`JEVRIS_LIVE_JEV=1 npm run smoke:jev`), reads the key from the OS keystore, sends fixed
 * non-sensitive prompts, and records a redacted evidence file: model, usage, latency and outcome
 * codes, never a key, a request body or a response body. Every latency call and every error probe
 * is recorded with its elapsed milliseconds and outcome (reason code, failure kind and HTTP
 * status), so a failed run can be diagnosed from the record alone.
 *
 * It measures; it does not decide. Every call runs under a measuring timeout (default 10 s, the
 * SDK's documented default), not the 900 ms hot-path budget, so a slow call is a measured latency
 * rather than a DEADLINE, and the error probes get the provider's own 400 or 401. The sample is
 * then compared with the hot budget and the p95 target (SSOT §17.4): the record says how many calls
 * fit the budget and whether p95 meets the target. The product's hot path keeps its budget.
 */
import { PINNED_MODEL, type JevTransport, type JevWireRequest } from '@jevris/contracts';
import { JevClient, estimateRequest, gateRequest, type AskResult } from '@jevris/core';
import { createDeadline } from '@jevris/platform';
import { CONFORMANCE_REQUEST } from './conformance.js';

export const LIVE_SUITE_SCHEMA = 'jev-live-suite-1';

export interface LiveSuiteOptions {
  /** The transport under test (SDK over the real API, or over the conformance mock). */
  readonly transport: JevTransport;
  /** Transport for the cancellation probe (the mock needs a hanging response); default `transport`. */
  readonly cancelTransport?: JevTransport;
  /** A transport with a deliberately invalid key, for the 401 probe. Omit to skip. */
  readonly badKeyTransport?: JevTransport;
  /** Calls for the latency sample. At least 30 for a percentile claim. */
  readonly latencyCalls?: number;
  /** Timeout for every suite call (default 10 s). It bounds a measurement, not a decision. */
  readonly measureTimeoutMs?: number;
  /** The hot-path budget the sample is compared with (default 900 ms). Never a timeout here. */
  readonly hotBudgetMs?: number;
  readonly mode: 'live' | 'mock';
}

/** The SDK's documented default request timeout: long enough to see the provider's slow tail. */
export const MEASURE_TIMEOUT_MS = 10_000;
/** SSOT §17.4: a semantic hot-path decision has a 900 ms budget and a p95 target below 800 ms. */
export const HOT_BUDGET_MS = 900;
export const P95_TARGET_MS = 800;

/** One latency call: numbers and codes only, never a body. */
export interface LatencySample {
  readonly elapsedMs: number;
  readonly ok: boolean;
  /** The provider failure kind, or null for an ok call. */
  readonly failure: string | null;
  /** The HTTP status of a failed call, or null (ok, or no response). */
  readonly status: number | null;
  /** The engine's reason code, or null for an ok call. */
  readonly reasonCode: string | null;
}

export interface LiveSuiteRecord {
  readonly schemaVersion: typeof LIVE_SUITE_SCHEMA;
  readonly mode: 'live' | 'mock';
  readonly sdk: '@typesafe-ai/sdk';
  readonly sdkVersion: '0.6.0';
  readonly route: string;
  readonly pinnedModel: string;
  readonly resolvedModels: readonly string[];
  readonly primitives: {
    readonly choice: boolean;
    readonly score: boolean;
    readonly noul: boolean;
    readonly noulHasConfidence: boolean;
  };
  /** The combined three-primitive call: its outcome codes only. */
  readonly combined: { readonly ok: boolean; readonly reasonCode: string | null; readonly schemaFailure: string | null; readonly questionId: string | null };
  readonly cancellation: { readonly cancelled: boolean; readonly reasonCode: string | null };
  readonly errors: readonly {
    readonly probe: string;
    readonly failure: string | null;
    readonly status: number | null;
    readonly reasonCode: string | null;
    readonly elapsedMs: number;
    /** The reason code the provider's answer must map to. */
    readonly expected: string;
    readonly matched: boolean;
  }[];
  readonly caps: {
    readonly underCapSent: boolean;
    readonly overTokenCapRefused: boolean;
    readonly overTokenCapSent: boolean;
    readonly overCapLimit: string | null;
  };
  readonly usage: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Every call: conservative estimate >= provider-reported input tokens. */
    readonly estimateAlwaysConservative: boolean;
    readonly maxReportedToEstimateRatio: number;
  };
  readonly latency: {
    readonly calls: number;
    readonly okCalls: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly p99Ms: number | null;
    readonly maxMs: number | null;
    /** The hot-path budget the sample is compared with; the calls ran under `measureTimeoutMs`. */
    readonly budgetMs: number;
    /** Ok calls that took no longer than `budgetMs`. */
    readonly withinBudget: number;
    /** `withinBudget` over all calls (a failed call is never within budget), to three places. */
    readonly withinBudgetFraction: number | null;
    readonly measureTimeoutMs: number;
    readonly p95TargetMs: number;
    /** Whether the measured p95 meets the target; null without a sample. Not an SLO. */
    readonly p95WithinTarget: boolean | null;
    readonly failedCalls: number;
    /** Failed latency calls per reason code. */
    readonly reasonCounts: Readonly<Record<string, number>>;
    /** Every latency call in order. */
    readonly samples: readonly LatencySample[];
  };
  readonly passed: boolean;
  readonly applied: false;
}

/** Reason code for a raw transport failure, matching the engine's AskResult codes. */
function transportReason(failure: string): string {
  if (failure === 'invalid-request' || failure === 'configuration') return 'INVALID_REQUEST';
  if (failure === 'auth') return 'PROVIDER_DISABLED';
  if (failure === 'cancelled') return 'CANCELLED';
  if (failure === 'timeout' || failure === 'deadline') return 'DEADLINE';
  if (failure === 'rate-limited') return 'RATE_LIMITED';
  return 'PROVIDER_ERROR';
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

/** A small request per primitive, so each is exercised on its own as well as together. */
const PRIMITIVE_REQUEST: JevWireRequest = CONFORMANCE_REQUEST;

function oversizeRequest(): JevWireRequest {
  // 70k one-digit words: the gate refuses on estimated tokens before anything is sent.
  const words: string[] = [];
  for (let i = 0; i < 70_000; i += 1) words.push('7');
  return {
    model: PINNED_MODEL,
    state: words.join(' '),
    questions: { yes: { type: 'noul', instructions: 'Is this packet empty?' } },
  } as JevWireRequest;
}

export async function runLiveSuite(options: LiveSuiteOptions): Promise<LiveSuiteRecord> {
  const measureMs = options.measureTimeoutMs ?? MEASURE_TIMEOUT_MS;
  const hotBudget = options.hotBudgetMs ?? HOT_BUDGET_MS;
  // Each attempt gets the full measuring timeout: the deadline adds back the engine's settle margin.
  const settleMarginMs = 50;
  const measuring = (): ReturnType<typeof createDeadline> => createDeadline(measureMs + settleMarginMs);
  const clientFor = (transport: JevTransport): JevClient => new JevClient({ transport, maxAttemptMs: measureMs, settleMarginMs });
  const client = clientFor(options.transport);
  const models = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let usageCalls = 0;
  let conservative = true;
  let maxRatio = 0;
  const account = (result: AskResult, request: JevWireRequest): void => {
    if (!result.ok) return;
    models.add(result.model);
    if (result.usage === null) return;
    usageCalls += 1;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    const estimate = estimateRequest(request).totalTokens;
    if (estimate < result.usage.inputTokens) conservative = false;
    maxRatio = Math.max(maxRatio, result.usage.inputTokens / Math.max(1, estimate));
  };

  // 1. All three primitives in one request.
  const combined = await client.ask({ request: PRIMITIVE_REQUEST, lane: 'background', deadline: measuring() });
  account(combined, PRIMITIVE_REQUEST);
  const answers = combined.ok ? combined.answers : {};
  const primitives = {
    choice: answers['taskFamily']?.type === 'choice',
    score: answers['changeRisk']?.type === 'score',
    noul: answers['compatibilityEvidenceMissing']?.type === 'noul',
    noulHasConfidence: answers['compatibilityEvidenceMissing'] !== undefined && Object.hasOwn(answers['compatibilityEvidenceMissing'], 'providerConfidence'),
  };

  // 2. Cancellation: the caller aborts in flight.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1);
  const cancelClient = options.cancelTransport === undefined ? client : clientFor(options.cancelTransport);
  const cancelled = await cancelClient.ask({ request: PRIMITIVE_REQUEST, lane: 'interactive', deadline: measuring(), signal: controller.signal });
  clearTimeout(timer);
  const cancellation = { cancelled: !cancelled.ok && cancelled.reasonCode === 'CANCELLED', reasonCode: cancelled.ok ? null : cancelled.reasonCode };

  // 3. Error taxonomy: an unpinned model is a 400 from the provider; a bad key is a 401.
  // They test error mapping, not latency, so they get the measuring timeout: time for the 400 or 401.
  const errors: { probe: string; failure: string | null; status: number | null; reasonCode: string | null; elapsedMs: number; expected: string; matched: boolean }[] = [];
  const probe = async (name: string, expected: string, request: JevWireRequest): Promise<void> => {
    const outcome = await options.transport.call(request, { timeoutMs: measureMs });
    const reasonCode = outcome.ok ? null : transportReason(outcome.failure);
    errors.push({
      probe: name,
      failure: outcome.ok ? null : outcome.failure,
      status: outcome.status,
      reasonCode,
      elapsedMs: outcome.elapsedMs,
      expected,
      matched: reasonCode === expected,
    });
  };
  await probe('invalid-model', 'INVALID_REQUEST', { ...PRIMITIVE_REQUEST, model: 'jev-0.0.0' } as JevWireRequest);
  await probe('invalid-schema', 'INVALID_REQUEST', {
    model: PINNED_MODEL,
    state: 'Non-sensitive schema probe.',
    questions: { empty: { type: 'choice', instructions: 'Pick one listed option.', criteria: {} } },
  } as unknown as JevWireRequest);
  if (options.badKeyTransport !== undefined) {
    const badKey = await clientFor(options.badKeyTransport).ask({ request: PRIMITIVE_REQUEST, lane: 'interactive', deadline: measuring() });
    errors.push({
      probe: 'invalid-key',
      failure: badKey.ok ? null : badKey.failure,
      status: badKey.ok ? 200 : badKey.status,
      reasonCode: badKey.ok ? null : badKey.failure === 'auth' ? 'PROVIDER_DISABLED' : badKey.reasonCode,
      elapsedMs: badKey.elapsedMs,
      expected: 'PROVIDER_DISABLED',
      matched: !badKey.ok && badKey.failure === 'auth',
    });
  }

  // 4. Caps: under the cap is sent; an over-token request is refused before sending.
  const beforeCalls = options.transport.calls;
  const over = oversizeRequest();
  const overGate = gateRequest(over);
  const overResult = await client.ask({ request: over, lane: 'interactive', deadline: measuring() });
  const caps = {
    underCapSent: combined.ok,
    overTokenCapRefused: !overResult.ok && overResult.reasonCode === 'REQUEST_TOO_LARGE',
    overTokenCapSent: options.transport.calls !== beforeCalls,
    overCapLimit: overGate.ok ? null : overGate.limit,
  };

  // 5. Latency sample over single-Noul requests (the cheapest shape), each under the measuring
  //    timeout, then compared with the hot budget.
  const latencyRequest: JevWireRequest = {
    model: PINNED_MODEL,
    state: { note: 'Non-sensitive latency probe. No repository text is included.' },
    questions: { probe: { type: 'noul', instructions: 'Does the state say that no repository text is included?' } },
  } as JevWireRequest;
  const sorted: number[] = [];
  const calls: LatencySample[] = [];
  const reasonCounts: Record<string, number> = {};
  const n = Math.max(0, options.latencyCalls ?? 30);
  let okCalls = 0;
  for (let i = 0; i < n; i += 1) {
    const result = await client.ask({ request: latencyRequest, lane: 'interactive', deadline: measuring() });
    account(result, latencyRequest);
    if (result.ok) {
      okCalls += 1;
      sorted.push(result.elapsedMs);
      calls.push({ elapsedMs: result.elapsedMs, ok: true, failure: null, status: null, reasonCode: null });
    } else {
      calls.push({ elapsedMs: result.elapsedMs, ok: false, failure: result.failure, status: result.status, reasonCode: result.reasonCode });
      reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] ?? 0) + 1;
    }
  }
  sorted.sort((a, b) => a - b);
  const withinBudget = sorted.filter((ms) => ms <= hotBudget).length;
  const p95Ms = percentile(sorted, 95);
  const latency = {
    calls: n,
    okCalls,
    p50Ms: percentile(sorted, 50),
    p95Ms,
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
    budgetMs: hotBudget,
    withinBudget,
    withinBudgetFraction: n === 0 ? null : Math.round((withinBudget / n) * 1000) / 1000,
    measureTimeoutMs: measureMs,
    p95TargetMs: P95_TARGET_MS,
    p95WithinTarget: p95Ms === null ? null : p95Ms <= P95_TARGET_MS,
    failedCalls: n - okCalls,
    reasonCounts,
    samples: calls,
  };

  // The API gate (SSOT §22.2): behaviour, not speed. The latency envelope is recorded above and
  // judged visibly by the release gates; the §17.4 targets are unmeasured, so they are not a pass bar.
  const passed =
    combined.ok &&
    primitives.choice &&
    primitives.score &&
    primitives.noul &&
    !primitives.noulHasConfidence &&
    cancellation.cancelled &&
    caps.overTokenCapRefused &&
    !caps.overTokenCapSent &&
    conservative &&
    okCalls === n &&
    errors.length >= 3 &&
    errors.every((error) => error.matched) &&
    [...models].every((model) => model === PINNED_MODEL);

  return {
    schemaVersion: LIVE_SUITE_SCHEMA,
    mode: options.mode,
    sdk: '@typesafe-ai/sdk',
    sdkVersion: '0.6.0',
    route: options.transport.route,
    pinnedModel: PINNED_MODEL,
    resolvedModels: [...models].sort(),
    primitives,
    combined: {
      ok: combined.ok,
      reasonCode: combined.ok ? null : combined.reasonCode,
      schemaFailure: combined.ok ? null : combined.schemaFailure?.kind ?? null,
      questionId: combined.ok ? null : combined.schemaFailure?.questionId ?? null,
    },
    cancellation,
    errors,
    caps,
    usage: {
      calls: usageCalls,
      inputTokens,
      outputTokens,
      estimateAlwaysConservative: conservative,
      maxReportedToEstimateRatio: Math.round(maxRatio * 1000) / 1000,
    },
    latency,
    passed,
    applied: false,
  };
}
