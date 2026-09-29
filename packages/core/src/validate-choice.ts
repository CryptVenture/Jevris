import {
  PINNED_MODEL,
  PROBABILITY_EPSILON,
  type ChoiceSpec,
} from '@jevris/contracts';

const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const INSTRUCTIONS_MAX = 8192;
const CRITERION_MAX = 2048;

export type SpecResult =
  | { readonly ok: true; readonly spec: ChoiceSpec }
  | { readonly ok: false; readonly reasonCode: 'INVALID_REQUEST' };

export type ChoiceBodyResult =
  | {
      readonly ok: true;
      readonly classification: string;
      readonly resolvedModel: string;
      readonly providerConfidence: number;
    }
  | { readonly ok: false; readonly reasonCode: 'INVALID_RESPONSE' | 'MODEL_MISMATCH' };

interface Utf8Encoder {
  encode(input?: string): Uint8Array;
}

interface Utf8Decoder {
  decode(input?: Uint8Array): string;
}

function encodeUtf8(text: string): Uint8Array {
  const Ctor = (globalThis as unknown as { TextEncoder?: new () => Utf8Encoder }).TextEncoder;
  if (Ctor === undefined) throw new Error('INVALID_REQUEST');
  return new Ctor().encode(text);
}

function decodeUtf8Fatal(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => Utf8Decoder;
  }).TextDecoder;
  if (Ctor === undefined) throw new Error('INVALID_RESPONSE');
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export { encodeUtf8 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) return true;
  }
  return false;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (dangerous.has(key) || !expected.includes(key)) return false;
  }
  return true;
}

function questionKeyCount(value: Record<string, unknown>): number | undefined {
  const wrapped = value.questions;
  if (isPlainObject(wrapped)) {
    if (hasDangerousKey(wrapped)) return -1;
    return Object.keys(wrapped).length;
  }
  if (typeof value.id === 'string' && typeof value.instructions === 'string' && isPlainObject(value.criteria)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => isPlainObject(value[key]))) return keys.length;
  return undefined;
}

export function validateChoiceSpec(value: unknown): SpecResult {
  if (!isPlainObject(value) || hasDangerousKey(value)) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  const mapped = questionKeyCount(value);
  if (mapped !== undefined && mapped !== 1) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  if (!sameKeys(value, ['id', 'instructions', 'criteria'])) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  const id = value.id;
  const instructions = value.instructions;
  const criteriaRaw = value.criteria;
  if (typeof id !== 'string' || !idPattern.test(id) || dangerous.has(id)) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  if (typeof instructions !== 'string' || instructions.trim().length === 0 || instructions.length > INSTRUCTIONS_MAX) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  if (!isPlainObject(criteriaRaw) || hasDangerousKey(criteriaRaw)) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  const optionKeys = Object.keys(criteriaRaw);
  if (optionKeys.length < 2 || optionKeys.length > 255 || !optionKeys.includes('unknown')) {
    return { ok: false, reasonCode: 'INVALID_REQUEST' };
  }
  const criteria: Record<string, string> = {};
  for (const key of optionKeys) {
    if (!idPattern.test(key) || dangerous.has(key)) {
      return { ok: false, reasonCode: 'INVALID_REQUEST' };
    }
    const option = criteriaRaw[key];
    if (typeof option !== 'string' || option.length === 0 || option.trim().length === 0 || option.length > CRITERION_MAX) {
      return { ok: false, reasonCode: 'INVALID_REQUEST' };
    }
    criteria[key] = option;
  }
  return { ok: true, spec: { id, instructions, criteria } };
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTokenCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function distribution(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, keys)) return undefined;
  const result: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const raw = value[key];
    if (!isProbability(raw)) return undefined;
    result[key] = raw;
    sum += raw;
  }
  if (Math.abs(sum - 1) > PROBABILITY_EPSILON) return undefined;
  return result;
}

function uniqueMaximum(probabilities: Readonly<Record<string, number>>, choice: string): boolean {
  const chosen = probabilities[choice];
  if (chosen === undefined) return false;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of Object.values(probabilities)) {
    if (value > max) max = value;
  }
  if (chosen + PROBABILITY_EPSILON < max) return false;
  let nearMax = 0;
  for (const value of Object.values(probabilities)) {
    if (value + PROBABILITY_EPSILON >= max) nearMax += 1;
  }
  return nearMax === 1;
}

export function validateChoiceBody(bytes: Uint8Array, spec: ChoiceSpec): ChoiceBodyResult {
  const text = decodeUtf8Fatal(bytes);
  if (text === undefined) return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  if (!isPlainObject(parsed) || hasDangerousKey(parsed)) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  if (parsed.model !== PINNED_MODEL) {
    return { ok: false, reasonCode: 'MODEL_MISMATCH' };
  }
  if (!sameKeys(parsed, ['model', 'answers', 'usage'])) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  const answers = parsed.answers;
  if (!isPlainObject(answers) || hasDangerousKey(answers) || !sameKeys(answers, [spec.id])) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  const answer = answers[spec.id];
  if (!isPlainObject(answer) || hasDangerousKey(answer) || !sameKeys(answer, ['type', 'choice', 'probabilities', 'confidence'])) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  const optionKeys = Object.keys(spec.criteria);
  if (!optionKeys.includes(answer.choice)) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  const probabilities = distribution(answer.probabilities, optionKeys);
  if (probabilities === undefined || !uniqueMaximum(probabilities, answer.choice)) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  if (!isProbability(answer.confidence)) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  const usage = parsed.usage;
  if (!isPlainObject(usage) || hasDangerousKey(usage) || !sameKeys(usage, ['input_tokens', 'output_tokens'])) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  if (!isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) {
    return { ok: false, reasonCode: 'INVALID_RESPONSE' };
  }
  return {
    ok: true,
    classification: answer.choice,
    resolvedModel: PINNED_MODEL,
    providerConfidence: answer.confidence,
  };
}
