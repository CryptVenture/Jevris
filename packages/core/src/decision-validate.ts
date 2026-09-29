/**
 * §7.5 response validation for all three Jev primitives (PRV-01, PRV-02, QA-04).
 *
 * The response is hostile input even though the SDK is typed. Checked: bounded size, fatal
 * UTF-8, JSON without prototype keys, model identity against a configurable pin, exact question
 * ids, primitive per question, candidate membership, finite probabilities in [0, 1],
 * distributions summing to one within a documented tolerance, score range, score consistency
 * and legend, choice consistency with the distribution, and non-negative integer usage.
 *
 * Only explicitly allowlisted additive metadata is accepted. A tiny floating-point deviation
 * inside the tolerance is normalized and the original values are kept; anything else is a
 * failure. Nothing is repaired. A Noul answer carrying a confidence field is refused: Noul has
 * no separate confidence (§2.2), and requiring one would be a client bug.
 *
 * Failures are redacted: a failure kind and the (trusted, request-side) question id. The body is
 * never copied into the result.
 */
import {
  JEV_MODEL_PATTERN,
  JevRequestContract,
  MAX_QUESTIONS,
  PINNED_MODEL,
  PROBABILITY_SUM_TOLERANCE,
  parseJson,
  type Json,
  type JevQuestion,
  type JevQuestions,
  type JevUsage,
  type JevWireRequest,
} from '@jevris/contracts';

export const MAX_RESPONSE_BYTES_DEFAULT = 1_048_576;

export const SCHEMA_FAILURE_KINDS = [
  'too-large',
  'not-utf8',
  'not-json',
  'forbidden-key',
  'not-object',
  'missing-field',
  'unexpected-field',
  'model-mismatch',
  'question-set-mismatch',
  'wrong-primitive',
  'unknown-candidate',
  'non-finite-probability',
  'probability-range',
  'non-normalized-distribution',
  'choice-not-maximum',
  'tie',
  'score-range',
  'score-inconsistent',
  'legend-mismatch',
  'noul-confidence',
  'confidence-invalid',
  'usage-invalid',
] as const;
export type SchemaFailureKind = (typeof SCHEMA_FAILURE_KINDS)[number];

export type TiePolicy = 'flag' | 'reject';

export interface ValidationPolicy {
  /** The evaluated model pin (§2.1). Configurable; default `jev-1.13.0`. Aliases are never a pin. */
  readonly pinnedModel: string;
  /** Floating-point tolerance for a distribution that is otherwise exact. */
  readonly tolerance: number;
  /**
   * The precision the provider reports probabilities at. Measured live on 2026-09-25: jev-1.13.0
   * rounds every probability, confidence and score to 0.01, so a sum can be off by up to half a unit
   * per entry, and a score is the rounded expectation over unrounded probabilities.
   */
  readonly reportedPrecision: number;
  /** `flag`: a tied Choice is valid but marked, and the engine abstains. `reject`: a tie is a failure. */
  readonly tiePolicy: TiePolicy;
  /** Top-level additive response keys that are explicitly handled (ignored and listed). */
  readonly allowedMetadata: readonly string[];
  /** Additive keys allowed inside `usage`. */
  readonly allowedUsageMetadata: readonly string[];
  readonly maxResponseBytes: number;
}

export const DEFAULT_VALIDATION_POLICY: ValidationPolicy = Object.freeze({
  pinnedModel: PINNED_MODEL,
  tolerance: PROBABILITY_SUM_TOLERANCE,
  reportedPrecision: 0.01,
  tiePolicy: 'flag',
  allowedMetadata: Object.freeze([]) as readonly string[],
  allowedUsageMetadata: Object.freeze([]) as readonly string[],
  maxResponseBytes: MAX_RESPONSE_BYTES_DEFAULT,
});

const ALIASES = new Set(['jev-latest', 'jev-preview']);

/** Builds a policy, refusing an alias or a malformed pin. */
export function validationPolicy(overrides: Partial<ValidationPolicy> = {}): ValidationPolicy {
  const policy: ValidationPolicy = { ...DEFAULT_VALIDATION_POLICY, ...overrides };
  if (ALIASES.has(policy.pinnedModel) || !new RegExp(JEV_MODEL_PATTERN).test(policy.pinnedModel)) {
    throw new Error('VALIDATION_POLICY_PIN');
  }
  if (!(policy.tolerance > 0 && policy.tolerance <= 1e-3)) throw new Error('VALIDATION_POLICY_TOLERANCE');
  if (!(policy.reportedPrecision >= 0 && policy.reportedPrecision <= 0.05)) throw new Error('VALIDATION_POLICY_PRECISION');
  if (!Number.isSafeInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 256) throw new Error('VALIDATION_POLICY_SIZE');
  for (const key of [...policy.allowedMetadata, ...policy.allowedUsageMetadata]) {
    if (['model', 'answers', 'usage', 'input_tokens', 'output_tokens', '__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('VALIDATION_POLICY_METADATA');
    }
  }
  return Object.freeze(policy);
}

export interface ValidatedChoice {
  readonly type: 'choice';
  readonly choice: string;
  /** Normalized distribution (equal to `original` unless it was rescaled inside the tolerance). */
  readonly probabilities: Readonly<Record<string, number>>;
  readonly original: Readonly<Record<string, number>>;
  readonly normalized: boolean;
  /** Distribution-derived provider confidence. Never task success (§2.2). */
  readonly providerConfidence: number;
  readonly tie: boolean;
}

export interface ValidatedScore {
  readonly type: 'score';
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly original: Readonly<Record<string, number>>;
  readonly normalized: boolean;
  readonly legend: Readonly<Record<string, string>>;
  readonly providerConfidence: number;
}

export interface ValidatedNoul {
  readonly type: 'noul';
  /** Probability of yes. Not a severity, and there is no confidence (§2.2). */
  readonly noul: number;
}

export type ValidatedAnswer = ValidatedChoice | ValidatedScore | ValidatedNoul;

export type ResponseValidation =
  | {
      readonly ok: true;
      readonly model: string;
      readonly answers: Readonly<Record<string, ValidatedAnswer>>;
      readonly usage: JevUsage;
      /** Allowlisted additive keys that were present and ignored. */
      readonly ignoredMetadata: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: SchemaFailureKind;
      /** The request-side question id where validation failed, or null for the envelope. */
      readonly questionId: string | null;
      /** The resolved model when it could be read safely (a model mismatch is still recorded). */
      readonly model: string | null;
      /** Usage when it was valid even though an answer was not (a failed answer may still be billed). */
      readonly usage: JevUsage | null;
    };

type Failure = Extract<ResponseValidation, { ok: false }>;

class Refused extends Error {
  constructor(readonly failure: SchemaFailureKind, readonly questionId: string | null) {
    super(failure);
  }
}

function refuse(failure: SchemaFailureKind, questionId: string | null = null): never {
  throw new Refused(failure, questionId);
}

function isRecord(value: unknown): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: { readonly [key: string]: unknown }, required: readonly string[], optional: readonly string[], questionId: string | null): void {
  for (const key of required) if (!Object.hasOwn(value, key)) refuse('missing-field', questionId);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) refuse('unexpected-field', questionId);
  }
}

function probability(value: unknown, questionId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse('non-finite-probability', questionId);
  if (value < 0 || value > 1) refuse('probability-range', questionId);
  return value;
}

/** Half a reporting unit per entry, plus the floating-point tolerance. */
export function sumTolerance(policy: ValidationPolicy, entries: number): number {
  return policy.tolerance + (policy.reportedPrecision / 2) * entries;
}

function distribution(
  value: unknown,
  keys: readonly string[],
  policy: ValidationPolicy,
  questionId: string,
): { probabilities: Record<string, number>; original: Record<string, number>; normalized: boolean } {
  if (!isRecord(value)) refuse('missing-field', questionId);
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse('unknown-candidate', questionId);
  const original: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) refuse('missing-field', questionId);
    const p = probability(value[key], questionId);
    original[key] = p;
    sum += p;
  }
  const deviation = Math.abs(sum - 1);
  if (deviation > sumTolerance(policy, keys.length)) refuse('non-normalized-distribution', questionId);
  if (deviation === 0) return { probabilities: { ...original }, original, normalized: false };
  const probabilities: Record<string, number> = {};
  for (const key of keys) probabilities[key] = (original[key] ?? 0) / sum;
  return { probabilities, original, normalized: true };
}

function validateChoice(answer: { readonly [key: string]: Json }, question: Extract<JevQuestion, { type: 'choice' }>, questionId: string, policy: ValidationPolicy): ValidatedChoice {
  exactKeys(answer, ['type', 'choice', 'probabilities', 'confidence'], [], questionId);
  const options = Object.keys(question.criteria);
  const choice = answer['choice'];
  if (typeof choice !== 'string' || !options.includes(choice)) refuse('unknown-candidate', questionId);
  const dist = distribution(answer['probabilities'], options, policy, questionId);
  const confidence = answer['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) refuse('confidence-invalid', questionId);
  const chosen = dist.original[choice] ?? 0;
  let max = 0;
  for (const p of Object.values(dist.original)) if (p > max) max = p;
  const slack = policy.tolerance + policy.reportedPrecision / 2;
  if (chosen + slack < max) refuse('choice-not-maximum', questionId);
  let atMax = 0;
  for (const p of Object.values(dist.original)) if (p + policy.tolerance >= max) atMax += 1;
  const tie = atMax > 1;
  if (tie && policy.tiePolicy === 'reject') refuse('tie', questionId);
  return {
    type: 'choice',
    choice,
    probabilities: Object.freeze(dist.probabilities),
    original: Object.freeze(dist.original),
    normalized: dist.normalized,
    providerConfidence: confidence,
    tie,
  };
}

function validateScore(answer: { readonly [key: string]: Json }, question: Extract<JevQuestion, { type: 'score' }>, questionId: string, policy: ValidationPolicy): ValidatedScore {
  exactKeys(answer, ['type', 'score', 'probabilities', 'legend', 'confidence'], [], questionId);
  const levels = question.criteria.map((_, index) => String(index));
  const dist = distribution(answer['probabilities'], levels, policy, questionId);
  const rawLegend = answer['legend'];
  if (!isRecord(rawLegend)) refuse('legend-mismatch', questionId);
  const legend: Record<string, string> = {};
  if (Object.keys(rawLegend).length !== levels.length) refuse('legend-mismatch', questionId);
  question.criteria.forEach((criterion, index) => {
    const key = String(index);
    if (rawLegend[key] !== criterion) refuse('legend-mismatch', questionId);
    legend[key] = criterion;
  });
  const score = answer['score'];
  if (typeof score !== 'number' || !Number.isFinite(score)) refuse('score-range', questionId);
  if (score < 0 || score > levels.length - 1) refuse('score-range', questionId);
  let expected = 0;
  levels.forEach((key, index) => {
    expected += index * (dist.original[key] ?? 0);
  });
  // The expected score over the reported distribution. Each reported probability may be off by half a
  // unit, which moves the expectation by at most half a unit times the sum of level indices, and the
  // score itself is rounded once more.
  const indexSum = (levels.length * (levels.length - 1)) / 2;
  const scoreSlack = policy.tolerance * levels.length * 10 + (policy.reportedPrecision / 2) * (indexSum + 1);
  if (Math.abs(score - expected) > scoreSlack) refuse('score-inconsistent', questionId);
  const confidence = answer['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) refuse('confidence-invalid', questionId);
  return {
    type: 'score',
    score,
    probabilities: Object.freeze(dist.probabilities),
    original: Object.freeze(dist.original),
    normalized: dist.normalized,
    legend: Object.freeze(legend),
    providerConfidence: confidence,
  };
}

function validateNoul(answer: { readonly [key: string]: Json }, questionId: string): ValidatedNoul {
  if (Object.hasOwn(answer, 'confidence')) refuse('noul-confidence', questionId);
  exactKeys(answer, ['type', 'noul'], [], questionId);
  return { type: 'noul', noul: probability(answer['noul'], questionId) };
}

function readUsage(value: unknown, policy: ValidationPolicy): JevUsage {
  if (!isRecord(value)) refuse('usage-invalid');
  exactKeys(value, ['input_tokens', 'output_tokens'], policy.allowedUsageMetadata, null);
  const input = value['input_tokens'];
  const output = value['output_tokens'];
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) refuse('usage-invalid');
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) refuse('usage-invalid');
  return { inputTokens: input, outputTokens: output };
}

function safeModel(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

/**
 * Validates a raw response body against the request that produced it. The request is trusted
 * (built by the engine), so its question ids and criteria define what is acceptable.
 */
export function validateJevResponse(
  body: Uint8Array | string,
  questions: JevQuestions,
  policy: ValidationPolicy = DEFAULT_VALIDATION_POLICY,
): ResponseValidation {
  const parsed = parseJson(body, policy.maxResponseBytes);
  if (!parsed.ok) {
    const code = parsed.issues[0]?.code;
    const failure: SchemaFailureKind =
      code === 'TOO_LARGE' ? 'too-large' : code === 'INVALID_UTF8' ? 'not-utf8' : code === 'JSON_FORBIDDEN_KEY' ? 'forbidden-key' : 'not-json';
    return { ok: false, failure, questionId: null, model: null, usage: null };
  }
  const value = parsed.value;
  let model: string | null = null;
  let usage: JevUsage | null = null;
  try {
    if (!isRecord(value)) refuse('not-object');
    model = safeModel(value['model']);
    if (Object.hasOwn(value, 'usage')) {
      try {
        usage = readUsage(value['usage'], policy);
      } catch {
        usage = null;
      }
    }
    exactKeys(value, ['model', 'answers', 'usage'], policy.allowedMetadata, null);
    if (value['model'] !== policy.pinnedModel) refuse('model-mismatch');
    const answers = value['answers'];
    if (!isRecord(answers)) refuse('missing-field');
    const expectedIds = Object.keys(questions);
    const answerIds = Object.keys(answers);
    if (answerIds.length !== expectedIds.length || answerIds.some((id) => !expectedIds.includes(id))) refuse('question-set-mismatch');
    const out: Record<string, ValidatedAnswer> = {};
    for (const id of expectedIds) {
      const question = questions[id] as JevQuestion;
      const answer = answers[id];
      if (!isRecord(answer)) refuse('missing-field', id);
      if (answer['type'] !== question.type) refuse('wrong-primitive', id);
      if (question.type === 'choice') out[id] = validateChoice(answer, question, id, policy);
      else if (question.type === 'score') out[id] = validateScore(answer, question, id, policy);
      else out[id] = validateNoul(answer, id);
    }
    const finalUsage = readUsage(value['usage'], policy);
    const ignoredMetadata = Object.keys(value).filter((key) => policy.allowedMetadata.includes(key));
    return { ok: true, model: policy.pinnedModel, answers: Object.freeze(out), usage: finalUsage, ignoredMetadata };
  } catch (error) {
    if (error instanceof Refused) {
      const failed: Failure = { ok: false, failure: error.failure, questionId: error.questionId, model, usage };
      return failed;
    }
    return { ok: false, failure: 'not-json', questionId: null, model, usage };
  }
}

export type RequestCheck =
  | { readonly ok: true; readonly request: JevWireRequest }
  | { readonly ok: false; readonly reasonCode: 'INVALID_REQUEST'; readonly path: string };

/** Validates an outgoing request against the JevRequest contract (≤12 questions, bounded text, no secret). */
export function validateJevRequest(request: unknown): RequestCheck {
  const checked = JevRequestContract.validate(request);
  if (!checked.ok) return { ok: false, reasonCode: 'INVALID_REQUEST', path: checked.issues[0]?.path ?? '' };
  if (Object.keys(checked.value.questions).length > MAX_QUESTIONS) return { ok: false, reasonCode: 'INVALID_REQUEST', path: '/questions' };
  return { ok: true, request: checked.value as JevWireRequest };
}
