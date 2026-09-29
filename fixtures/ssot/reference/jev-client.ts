/**
 * Native TypeSafe HTTP reference, based on SOURCES S03/S04. No vendor SDK dependency.
 * Deliberately narrower request subset: pinned models, string instructions/criteria,
 * <=12 questions, 2..255 Choice options, 2..10 Score levels. Limits below are
 * Jevris proposals, not additional provider guarantees. Not a full egress gateway.
 */
import type { Json } from './contracts.js';
export type Question =
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } };
export interface JevRequest {
  readonly model: string;
  readonly state: string | readonly Json[] | { readonly [key: string]: Json };
  readonly questions: Readonly<Record<string, Question>>;
}
export type Answer =
  | { readonly type: 'choice'; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  | { readonly type: 'score'; readonly score: number; readonly probabilities: Readonly<Record<string, number>>; readonly legend: Readonly<Record<string, string>>; readonly confidence: number }
  | { readonly type: 'noul'; readonly noul: number };
export interface JevResponse {
  readonly model: string; readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}
export type ErrorCode = 'CONFIGURATION' | 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'MODEL_MISMATCH' |
  'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE' | 'DEADLINE' | 'CANCELLED' | 'HTTP' | 'NETWORK';
export class JevError extends Error {
  constructor(readonly code: ErrorCode, readonly status?: number, readonly retryable = false) {
    super(`Jev request failed: ${code}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'JevError';
  }
}
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const pinnedModel = /^jev-\d+\.\d+\.\d+$/;
const EPSILON = 1e-6; // Validate against real provider precision before certification.
function fail(code: ErrorCode): never { throw new JevError(code); }
function object(value: unknown, code: ErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code);
  return value as Record<string, unknown>;
}
function sameKeys(value: Record<string, unknown>, expected: readonly string[], code: ErrorCode): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(k => !expected.includes(k) || dangerous.has(k))) fail(code);
}
function text(value: unknown, maximum: number, code: ErrorCode): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) fail(code);
}
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('INVALID_RESPONSE');
  return value;
}
/** Reject cycles, accessors, class instances and non-JSON data without invoking getters. */
function assertJson(value: unknown, code: ErrorCode, seen = new Set<object>(), depth = 0): void {
  if (depth > 24) fail(code);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(code); return; }
  if (typeof value !== 'object' || seen.has(value)) fail(code);
  if (!Array.isArray(value)) object(value, code);
  else if (Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) fail(code);
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(code);
    assertJson(descriptor.value, code, seen, depth + 1);
  }
  seen.delete(value);
}
export function validateRequest(value: unknown): string {
  const code = 'INVALID_REQUEST';
  assertJson(value, code);
  const r = object(value, code); sameKeys(r, ['model', 'state', 'questions'], code);
  if (typeof r.model !== 'string' || !pinnedModel.test(r.model)) fail(code);
  if (!(typeof r.state === 'string' || (typeof r.state === 'object' && r.state !== null))) fail(code);
  const questions = object(r.questions, code); const ids = Object.keys(questions);
  if (ids.length === 0 || ids.length > 12 || ids.some(id => !idPattern.test(id) || dangerous.has(id))) fail(code);
  for (const qValue of Object.values(questions)) {
    const q = object(qValue, code); text(q.instructions, 8192, code);
    if (q.type === 'choice') {
      sameKeys(q, ['type', 'instructions', 'criteria'], code);
      const criteria = object(q.criteria, code); const options = Object.keys(criteria);
      if (options.length < 2 || options.length > 255 || options.some(k => !idPattern.test(k))) fail(code);
      Object.values(criteria).forEach(v => text(v, 2048, code));
    } else if (q.type === 'score') {
      sameKeys(q, ['type', 'instructions', 'criteria'], code);
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) fail(code);
      q.criteria.forEach((v: unknown) => text(v, 2048, code));
    } else if (q.type === 'noul') {
      sameKeys(q, q.criteria === undefined ? ['type', 'instructions'] : ['type', 'instructions', 'criteria'], code);
      if (q.criteria !== undefined) {
        const criteria = object(q.criteria, code); sameKeys(criteria, ['true', 'false'], code);
        text(criteria.true, 2048, code); text(criteria.false, 2048, code);
      }
    } else fail(code);
  }
  return JSON.stringify(r);
}
function distribution(value: unknown, keys: readonly string[]): Record<string, number> {
  const raw = object(value, 'INVALID_RESPONSE'); sameKeys(raw, keys, 'INVALID_RESPONSE');
  const result: Record<string, number> = {}; let sum = 0;
  for (const key of keys) { const p = probability(raw[key]); result[key] = p; sum += p; }
  if (Math.abs(sum - 1) > EPSILON) fail('INVALID_RESPONSE');
  return result;
}
export function validateResponse(request: JevRequest, value: unknown): JevResponse {
  // Public entry point also checks the request; responses never define their own question schema.
  validateRequest(request); assertJson(value, 'INVALID_RESPONSE');
  const r = object(value, 'INVALID_RESPONSE');
  if (r.model !== request.model) fail('MODEL_MISMATCH');
  const raw = object(r.answers, 'INVALID_RESPONSE');
  sameKeys(raw, Object.keys(request.questions), 'INVALID_RESPONSE');
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const a = object(raw[id], 'INVALID_RESPONSE');
    if (a.type !== question.type) fail('INVALID_RESPONSE');
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: probability(a.noul) }; continue;
    }
    const confidence = probability(a.confidence);
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria); const p = distribution(a.probabilities, options);
      if (typeof a.choice !== 'string' || !options.includes(a.choice)) fail('INVALID_RESPONSE');
      const chosen = p[a.choice];
      if (chosen === undefined || chosen + EPSILON < Math.max(...Object.values(p))) fail('INVALID_RESPONSE');
      answers[id] = { type: 'choice', choice: a.choice, probabilities: p, confidence };
    } else {
      const keys = question.criteria.map((_, index) => String(index)); const p = distribution(a.probabilities, keys);
      const rawLegend = object(a.legend, 'INVALID_RESPONSE'); sameKeys(rawLegend, keys, 'INVALID_RESPONSE');
      const legend: Record<string, string> = {}; let expected = 0;
      for (const [index, criterion] of question.criteria.entries()) {
        const key = String(index);
        if (rawLegend[key] !== criterion) fail('INVALID_RESPONSE');
        legend[key] = criterion; expected += index * (p[key] ?? 0);
      }
      if (typeof a.score !== 'number' || !Number.isFinite(a.score) || Math.abs(a.score - expected) > EPSILON) fail('INVALID_RESPONSE');
      answers[id] = { type: 'score', score: a.score, probabilities: p, legend, confidence };
    }
  }
  const u = object(r.usage, 'INVALID_RESPONSE');
  for (const key of ['input_tokens', 'output_tokens']) {
    if (typeof u[key] !== 'number' || !Number.isSafeInteger(u[key]) || u[key] < 0) fail('INVALID_RESPONSE');
  }
  return { model: request.model, answers,
    usage: { input_tokens: u.input_tokens as number, output_tokens: u.output_tokens as number } };
}
export interface ClientConfig {
  readonly apiKey: string;
  /** Dependency injection for trusted tests/host code only; never accept from an agent request. */
  readonly fetchImpl?: typeof fetch;
  readonly maxRequestBytes?: number; readonly maxResponseBytes?: number;
}
export interface EvaluateOptions {
  readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly deadlineAtMs?: number;
}
export class JevClient {
  readonly #apiKey: string; readonly #fetch: typeof fetch;
  readonly #maxRequestBytes: number; readonly #maxResponseBytes: number;
  constructor(config: ClientConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0 || /[\r\n]/.test(config.apiKey)) fail('CONFIGURATION');
    this.#apiKey = config.apiKey;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
    this.#maxRequestBytes = config.maxRequestBytes ?? 131_072;
    this.#maxResponseBytes = config.maxResponseBytes ?? 1_048_576;
    for (const size of [this.#maxRequestBytes, this.#maxResponseBytes]) {
      if (!Number.isSafeInteger(size) || size < 1 || size > 16_777_216) fail('CONFIGURATION');
    }
  }
  async evaluate(request: JevRequest, options: EvaluateOptions = {}): Promise<JevResponse> {
    const started = performance.now();
    const requestedTimeout = options.timeoutMs ?? 900;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > 30_000) fail('CONFIGURATION');
    if (options.deadlineAtMs !== undefined && !Number.isFinite(options.deadlineAtMs)) fail('CONFIGURATION');
    const budget = Math.min(requestedTimeout, options.deadlineAtMs === undefined ? requestedTimeout : options.deadlineAtMs - Date.now());
    if (budget <= 0) fail('DEADLINE');
    if (options.signal?.aborted) fail('CANCELLED');
    const serialized = validateRequest(request);
    if (new TextEncoder().encode(serialized).byteLength > this.#maxRequestBytes) fail('REQUEST_TOO_LARGE');
    // Freeze the semantic request by taking a private JSON snapshot before awaiting I/O.
    const sentRequest = JSON.parse(serialized) as JevRequest;
    const remaining = budget - (performance.now() - started);
    if (remaining <= 0) fail('DEADLINE');
    const controller = new AbortController();
    let rejectAbort: (error: JevError) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancel = () => { rejectAbort(new JevError('CANCELLED')); controller.abort(); };
    const timer = setTimeout(() => { rejectAbort(new JevError('DEADLINE')); controller.abort(); }, remaining);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([this.#fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: serialized
      }), aborted]);
      if (!response.ok) throw new JevError('HTTP', response.status, response.status === 408 || response.status === 429 || response.status >= 500);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json' || response.body === null) fail('INVALID_RESPONSE');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const part = await Promise.race([reader.read(), aborted]);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > this.#maxResponseBytes) fail('RESPONSE_TOO_LARGE');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
      catch { fail('INVALID_RESPONSE'); }
      const result = validateResponse(sentRequest, parsed);
      if (options.signal?.aborted) fail('CANCELLED');
      if (performance.now() - started >= budget) fail('DEADLINE');
      return result;
    } catch (error: unknown) {
      if (error instanceof JevError) throw error;
      throw new JevError('NETWORK', undefined, true);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); }
    }
  }
}
