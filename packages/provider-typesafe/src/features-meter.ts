/**
 * The call meter of the Jev feature suite (`smoke:jev:features`). It wraps the `fetch` the SDK
 * transport uses, so every request that leaves is counted with numbers only: how long the network
 * round trip took, the HTTP status, the request and response sizes and the provider-reported token
 * usage. It never keeps a request or a response body, never reads a header and never sees the key
 * (the SDK adds the key below this wrapper's view of the body; the wrapper reads only `init.body`).
 *
 * It is also the suite's safety net:
 * - a hard cap on calls and on spend (micro-USD, from the reported usage and the dated tariff): once
 *   a cap is reached nothing more is sent, and the wrapper answers locally with a refusal;
 * - the first 401, 402 or 403, or three 429s in a row, halts the run: nothing more is sent. Nothing
 *   loops on a failing call.
 *
 * Money is integer micro-USD. The tariff is core's `JEV_TARIFF` (input tokens only).
 */
import { JEV_TARIFF, jevCostMicroUsd } from '@jevris/core';
import type { FetchLike } from './sdk-transport.js';

/** One request that left the machine (or was refused by the cap before leaving). Numbers and codes only. */
export interface MeterRow {
  /** 1-based position among the calls this meter saw. */
  readonly n: number;
  /** The network round trip: request sent to body read, in ms. */
  readonly networkMs: number;
  /** The HTTP status, or null when no response came (a connection error, or a call the cap refused). */
  readonly status: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** Questions in the request body (0 when it could not be read). */
  readonly questions: number;
  /** True when the cap or a halt refused it locally: nothing was sent. */
  readonly refused: boolean;
  /** Micro-USD of this call from its reported usage; 0 when none was reported. */
  readonly costMicroUsd: number;
  /** The shape of each answer in the response: numbers only (see `AnswerStat`). Empty when none could be read. */
  readonly answers: readonly AnswerStat[];
  /** How many of the meter's privacy probes (strings that must not leave) the request body contained. */
  readonly leaks: number;
}

/**
 * What one answer looked like, as numbers: the top two probabilities of a choice or a score (so the
 * margin between them can be read), the provider's confidence, and the score or the Noul probability.
 * No answer text, no key, no option name. The question id is the suite's own fixed template id.
 */
export interface AnswerStat {
  readonly id: string;
  readonly type: 'choice' | 'score' | 'noul';
  readonly p1: number | null;
  readonly p2: number | null;
  readonly confidence: number | null;
  /** The score (a score answer) or the probability of yes (a Noul); null for a choice. */
  readonly value: number | null;
}

export interface MeterLimits {
  /** The most calls that may leave. */
  readonly maxCalls: number;
  /** The most spend, in micro-USD, from reported usage; a call is refused once this is reached. */
  readonly maxMicroUsd: number;
}

export interface MeterTotals {
  readonly calls: number;
  readonly refused: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  /** Calls by HTTP status (`200`, `429`, `none`). */
  readonly statuses: Readonly<Record<string, number>>;
}

export interface CallMeter {
  /** The wrapped fetch, for `createSdkTransport({ fetch })`. */
  readonly fetch: FetchLike;
  /** Every row so far, in order. Treat as read-only. */
  readonly rows: readonly MeterRow[];
  /** Why the meter stopped sending (a status, a cap), or null while it still sends. */
  readonly halted: string | null;
  totals(): MeterTotals;
  /** Totals of the rows from position `from` (0-based, as `rows.length` was then) to now. */
  since(from: number): MeterTotals;
  /** Stops sending at once (the suite's own abort). */
  halt(reason: string): void;
  /**
   * Strings that must not leave the machine (a title, a path, a prompt): each request body is checked
   * for them and `MeterRow.leaks` counts how many it held. The strings are kept only in memory.
   */
  setProbes(probes: readonly string[]): void;
}

const STOP_STATUSES = new Set([401, 402, 403]);
/** Three throttles in a row are a storm: stop rather than keep asking. */
const THROTTLE_STORM = 3;

function questionCount(body: unknown): number {
  if (typeof body !== 'string') return 0;
  try {
    const parsed = JSON.parse(body) as { questions?: unknown };
    return parsed.questions !== null && typeof parsed.questions === 'object' ? Object.keys(parsed.questions).length : 0;
  } catch {
    return 0;
  }
}

function usageOf(text: string): { readonly input: number; readonly output: number } | null {
  try {
    const parsed = JSON.parse(text) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const input = parsed.usage?.input_tokens;
    const output = parsed.usage?.output_tokens;
    return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? { input, output } : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The numeric shape of each answer in a response body; empty when the body is not a Jev answer. */
function answerStats(text: string): AnswerStat[] {
  try {
    const parsed = JSON.parse(text) as { answers?: Record<string, { type?: unknown; probabilities?: unknown; confidence?: unknown; score?: unknown; noul?: unknown }> };
    if (parsed.answers === null || typeof parsed.answers !== 'object') return [];
    const out: AnswerStat[] = [];
    for (const [id, answer] of Object.entries(parsed.answers)) {
      if (answer === null || typeof answer !== 'object') continue;
      if (answer.type === 'noul') {
        out.push({ id, type: 'noul', p1: null, p2: null, confidence: null, value: numberOrNull(answer.noul) });
        continue;
      }
      if (answer.type !== 'choice' && answer.type !== 'score') continue;
      const values = answer.probabilities !== null && typeof answer.probabilities === 'object' ? Object.values(answer.probabilities as Record<string, unknown>).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => b - a) : [];
      out.push({ id, type: answer.type, p1: values[0] ?? null, p2: values[1] ?? null, confidence: numberOrNull(answer.confidence), value: answer.type === 'score' ? numberOrNull(answer.score) : null });
    }
    return out;
  } catch {
    return [];
  }
}

function totalsOf(rows: readonly MeterRow[]): MeterTotals {
  const statuses: Record<string, number> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicroUsd = 0;
  let refused = 0;
  for (const row of rows) {
    const key = row.status === null ? 'none' : String(row.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    costMicroUsd += row.costMicroUsd;
    if (row.refused) refused += 1;
  }
  return { calls: rows.length - refused, refused, inputTokens, outputTokens, costMicroUsd, statuses };
}

/**
 * For a developer capturing a fixture by hand: told each exchange's request and response text. The
 * suite script never sets it, nothing here stores the text, and the key is not in either body.
 */
export type ExchangeObserver = (exchange: { readonly n: number; readonly status: number; readonly request: string; readonly response: string }) => void;

/** Wraps `inner` (the network fetch, or the conformance mock) with counting, caps and the halt rules. */
export function createCallMeter(inner: FetchLike, limits: MeterLimits, now: () => number = () => performance.now(), observe?: ExchangeObserver): CallMeter {
  const rows: MeterRow[] = [];
  let halted: string | null = null;
  let probes: readonly string[] = [];
  let throttled = 0;
  let spent = 0;
  let sent = 0;

  const refuse = (requestBytes: number, reason: string): never => {
    rows.push({ n: rows.length + 1, networkMs: 0, status: null, inputTokens: null, outputTokens: null, requestBytes, responseBytes: 0, questions: 0, refused: true, costMicroUsd: 0, answers: [], leaks: 0 });
    // A local refusal in the shape the transport already handles as a connection fault: nothing was sent.
    throw new TypeError(`fetch refused locally: ${reason}`);
  };

  const meteredFetch: FetchLike = async (input, init) => {
    const requestBytes = typeof init?.body === 'string' ? init.body.length : 0;
    if (halted !== null) return refuse(requestBytes, halted);
    if (sent >= limits.maxCalls) {
      halted = 'CALL_CAP';
      return refuse(requestBytes, halted);
    }
    if (spent >= limits.maxMicroUsd) {
      halted = 'SPEND_CAP';
      return refuse(requestBytes, halted);
    }
    sent += 1;
    const body = typeof init?.body === 'string' ? init.body : '';
    const leaks = probes.filter((probe) => probe.length > 0 && body.includes(probe)).length;
    const started = now();
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      rows.push({ n: rows.length + 1, networkMs: Math.max(0, Math.round(now() - started)), status: null, inputTokens: null, outputTokens: null, requestBytes, responseBytes: 0, questions: questionCount(init?.body), refused: false, costMicroUsd: 0, answers: [], leaks });
      throw error;
    }
    // Read a copy: the caller gets the original response untouched.
    let text = '';
    try {
      text = await response.clone().text();
    } catch {
      text = '';
    }
    const usage = response.status === 200 ? usageOf(text) : null;
    const cost = usage === null ? 0 : jevCostMicroUsd(usage.input, usage.output, JEV_TARIFF);
    spent += cost;
    rows.push({
      n: rows.length + 1,
      networkMs: Math.max(0, Math.round(now() - started)),
      status: response.status,
      inputTokens: usage === null ? null : usage.input,
      outputTokens: usage === null ? null : usage.output,
      requestBytes,
      responseBytes: text.length,
      questions: questionCount(init?.body),
      refused: false,
      costMicroUsd: cost,
      answers: response.status === 200 ? answerStats(text) : [],
      leaks,
    });
    if (observe !== undefined) {
      try {
        observe({ n: rows.length, status: response.status, request: typeof init?.body === 'string' ? init.body : '', response: text });
      } catch {
        // An observer is a developer's aid; its failure changes nothing.
      }
    }
    if (STOP_STATUSES.has(response.status)) halted = `HTTP_${String(response.status)}`;
    throttled = response.status === 429 ? throttled + 1 : 0;
    if (throttled >= THROTTLE_STORM) halted = 'HTTP_429_STORM';
    return response;
  };

  return {
    fetch: meteredFetch,
    rows,
    get halted() {
      return halted;
    },
    totals: () => totalsOf(rows),
    since: (from) => totalsOf(rows.slice(Math.max(0, from))),
    halt: (reason) => {
      halted = reason;
    },
    setProbes: (list) => {
      probes = [...list];
    },
  };
}

/** The percentile of a list of numbers by nearest rank (null for an empty list). */
export function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export interface Distribution {
  readonly n: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** n, min, p50, p95, p99 and max of a list of numbers. */
export function distributionOf(values: readonly number[]): Distribution {
  return { n: values.length, min: percentileOf(values, 0), p50: percentileOf(values, 50), p95: percentileOf(values, 95), p99: percentileOf(values, 99), max: percentileOf(values, 100) };
}
