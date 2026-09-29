/**
 * The Jev conformance mock (PRV-04, R02, E04): a `fetch` that behaves like
 * `POST https://api.typesafe.ai/v1/systemone` and returns reproducible, Jev-shaped responses.
 *
 * It answers every question with the right primitive: a Choice distribution with a unique winner
 * and its confidence, a Score distribution with the expected score, legend and confidence, and a
 * Noul probability with no confidence field. Answers are a pure function of the question, so a
 * run is reproducible. Scenarios produce each failure the engine must handle: invalid bodies,
 * late responses, 401, 422, 429 (with Retry-After), 529, aborted and oversize responses.
 * `late-body` sends headers at once and then stalls the body, and `late-deaf` never answers; both
 * ignore the abort signal, so only the transport's own total deadline can end the call.
 *
 * It never opens a socket, never reads a credential and never touches the network.
 */
import type { JevQuestion } from '@jevris/contracts';

export const MOCK_MODEL = 'jev-1.13.0';
const KNOWN_MODELS = new Set([MOCK_MODEL, 'jev-latest', 'jev-preview']);

export const CONFORMANCE_SCENARIOS = [
  'valid',
  'invalid-distribution',
  'model-mismatch',
  'noul-confidence',
  'extra-field',
  'unknown-candidate',
  'tie',
  'late',
  'late-body',
  'late-deaf',
  'http-400',
  'http-401',
  'http-403',
  'http-422',
  'http-429',
  'http-500',
  'http-529',
  'aborted',
  'oversize',
  'connection',
  'not-json',
] as const;
export type ConformanceScenario = (typeof CONFORMANCE_SCENARIOS)[number];

export interface MockFetchOptions {
  /** One scenario for every call, or a script consumed call by call (the last entry repeats). */
  readonly scenario?: ConformanceScenario | readonly ConformanceScenario[];
  /** Delay for `late`, in ms. The delay is cancelled by the request's abort signal. */
  readonly lateMs?: number;
  /** Seconds sent in Retry-After for 429 and 529. */
  readonly retryAfterSeconds?: number;
  readonly oversizeBytes?: number;
  /** Records each request body for assertions. */
  readonly onRequest?: (body: unknown, headers: Headers) => void;
}

export interface MockFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  readonly calls: number;
  readonly requests: readonly unknown[];
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function weights(seed: string, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(1 + (fnv1a(`${seed}#${i}`) % 97));
  const winner = fnv1a(seed) % count;
  out[winner] = (out[winner] ?? 0) + 120;
  return out;
}

function normalize(values: readonly number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / sum);
}

/** jev-1.13.0 reports probabilities, confidences and scores rounded to 0.01 (measured live). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function answerFor(id: string, question: JevQuestion, scenario: ConformanceScenario): Record<string, unknown> {
  const seed = `${id}:${JSON.stringify(question)}`;
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    let probs = normalize(weights(seed, keys.length));
    if (scenario === 'tie' && keys.length >= 2) probs = keys.map((_, i) => (i < 2 ? 0.5 : 0));
    const probabilities: Record<string, number> = {};
    keys.forEach((key, i) => {
      probabilities[key] = round2(probs[i] ?? 0);
    });
    if (scenario === 'invalid-distribution') probabilities[keys[0] as string] = (probabilities[keys[0] as string] ?? 0) + 0.25;
    let best = keys[0] as string;
    for (const key of keys) if ((probabilities[key] ?? 0) > (probabilities[best] ?? 0)) best = key;
    return {
      type: 'choice',
      choice: scenario === 'unknown-candidate' ? 'not_a_listed_option' : best,
      probabilities,
      confidence: round2(probabilities[best] ?? 0),
    };
  }
  if (question.type === 'score') {
    const probs = normalize(weights(seed, question.criteria.length));
    const probabilities: Record<string, number> = {};
    const legend: Record<string, string> = {};
    let score = 0;
    question.criteria.forEach((criterion, i) => {
      probabilities[String(i)] = round2(probs[i] ?? 0);
      legend[String(i)] = criterion;
      score += i * (probs[i] ?? 0);
    });
    if (scenario === 'invalid-distribution') probabilities['0'] = (probabilities['0'] ?? 0) + 0.25;
    return { type: 'score', score: round2(score), probabilities, legend, confidence: round2(Math.max(...probs)) };
  }
  const noul = (fnv1a(seed) % 100) / 100;
  const answer: Record<string, unknown> = { type: 'noul', noul: scenario === 'invalid-distribution' ? 1.5 : noul };
  if (scenario === 'noul-confidence') answer['confidence'] = 0.9;
  return answer;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_mock', ...headers },
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const timer = ms === Number.POSITIVE_INFINITY ? undefined : setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/** Estimated provider-side input tokens: below the Jevris conservative estimate by design. */
function mockInputTokens(bodyText: string): number {
  return 250 + Math.ceil(bodyText.length / 4);
}

export function createMockFetch(options: MockFetchOptions = {}): MockFetch {
  const script = options.scenario === undefined ? ['valid' as const] : typeof options.scenario === 'string' ? [options.scenario] : [...options.scenario];
  const requests: unknown[] = [];
  let calls = 0;
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const scenario = (script[Math.min(calls, script.length - 1)] ?? 'valid') as ConformanceScenario;
    calls += 1;
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw abortError();
    if (!input.endsWith('/v1/systemone') || init?.method !== 'POST') return json(404, { error: 'not found' });
    const headers = new Headers(init.headers);
    const auth = headers.get('authorization') ?? '';
    if (!/^Bearer \S+$/.test(auth)) return json(401, { error: 'missing credential' });
    const text = typeof init.body === 'string' ? init.body : '';
    let body: { questions?: Record<string, JevQuestion>; model?: string } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json(400, { error: 'malformed JSON' });
    }
    requests.push(body);
    options.onRequest?.(body, headers);
    if (body.model !== undefined && !KNOWN_MODELS.has(body.model)) return json(400, { error: 'invalid model' });
    for (const question of Object.values(body.questions ?? {})) {
      const size = question.type === 'choice' ? Object.keys(question.criteria ?? {}).length : question.type === 'score' ? (question.criteria ?? []).length : 2;
      // Live jev-1.13.0 answers an empty criteria set with 400 (measured 2026-09-25); a single criterion is 422.
      if (size === 0) return json(400, { error: 'invalid question' });
      if (size < 2) return json(422, { error: 'invalid question' });
    }
    const retryAfter = String(options.retryAfterSeconds ?? 1);
    switch (scenario) {
      case 'http-400':
        return json(400, { error: 'invalid model' });
      case 'http-401':
        return json(401, { error: 'invalid api key' });
      case 'http-403':
        return json(403, { error: 'forbidden' });
      case 'http-422':
        return json(422, { error: 'request too large' });
      case 'http-429':
        return json(429, { error: 'rate limited' }, { 'retry-after': retryAfter });
      case 'http-500':
        return json(500, { error: 'server error' });
      case 'http-529':
        return json(529, { error: 'overloaded' }, { 'retry-after': retryAfter });
      case 'connection':
        throw new TypeError('fetch failed');
      case 'aborted':
        await wait(Number.POSITIVE_INFINITY, signal);
        throw abortError();
      case 'late':
        await wait(options.lateMs ?? 5000, signal);
        break;
      case 'late-deaf':
        // Headers never arrive and the abort signal is ignored.
        return new Promise<Response>(() => undefined);
      case 'late-body': {
        // Headers at once, the first bytes of a body, then a stall that ignores the abort signal.
        const stalled = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode(`{"model":"${MOCK_MODEL}",`));
          },
        });
        return new Response(stalled, { status: 200, headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_mock' } });
      }
      case 'not-json':
        return new Response('<html>gateway error</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      case 'oversize':
        return new Response(`{"model":"${MOCK_MODEL}","pad":"${'x'.repeat(options.oversizeBytes ?? 2_000_000)}"}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      default:
        break;
    }
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions ?? {})) answers[id] = answerFor(id, question, scenario);
    const response: Record<string, unknown> = {
      model: scenario === 'model-mismatch' ? 'jev-1.12.0' : body.model ?? MOCK_MODEL,
      answers,
      usage: { input_tokens: mockInputTokens(text), output_tokens: 13 * Object.keys(answers).length },
    };
    if (scenario === 'extra-field') response['debug_trace'] = 'unexpected';
    return json(200, response);
  };
  Object.defineProperty(fetchImpl, 'calls', { get: () => calls });
  Object.defineProperty(fetchImpl, 'requests', { get: () => requests });
  return fetchImpl as MockFetch;
}
