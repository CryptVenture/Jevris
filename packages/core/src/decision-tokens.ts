/**
 * Conservative token estimation and the request gate (PRV-01, PRV-03, §2.1).
 *
 * Jev's tokenizer is not published, so the estimate is an upper bound built from pieces a
 * sub-word tokenizer cannot merge beyond: an ASCII word costs at least one token per three
 * letters, every digit, punctuation mark and whitespace run costs one, and every non-ASCII
 * UTF-8 byte costs one. A fixed request overhead and a per-question overhead cover the provider's
 * own prompt template. The live suite checks estimate >= provider-reported input tokens.
 *
 * The limits are separate (§2.1): serialized request bytes, estimated tokens for the whole
 * request (64k), estimated tokens for state plus the largest single question (32k), question
 * count (12) and criterion length. The byte cap protects memory and transport; it is not a
 * substitute for the token estimate.
 */
import { MAX_QUESTIONS, type JevQuestion, type JevQuestions, type JevWireRequest } from '@jevris/contracts';

export const REQUEST_TOKEN_LIMIT = 64_000;
export const STATE_PLUS_QUESTION_TOKEN_LIMIT = 32_000;
export const DEFAULT_REQUEST_BYTE_CAP = 131_072;
export const CRITERION_CHAR_CAP = 2048;
export const INSTRUCTIONS_CHAR_CAP = 8192;
/** Provider prompt-template overhead per request and per question, measured against live usage. */
export const REQUEST_OVERHEAD_TOKENS = 384;
export const QUESTION_OVERHEAD_TOKENS = 48;
export const CRITERION_OVERHEAD_TOKENS = 12;
/** Multiplicative safety margin on top of the piecewise upper bound. */
export const SAFETY_FACTOR = 1.1;
/** Tokenizer identity: part of the decision cache and calibration keys. */
export const ENCODER_ID = 'jevris-conservative-v1';

const PIECE = /[A-Za-z]+|[0-9]|\s+|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|[^\x00-\x7f]|[\x00-\x1f\x7f]/gu;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Upper-bound token count of one text. */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(PIECE)) {
    const piece = match[0];
    const first = piece.charCodeAt(0);
    if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += Math.ceil(piece.length / 3);
    else if (first > 0x7f) tokens += utf8Length(piece);
    else tokens += 1;
  }
  return tokens;
}

/** Upper-bound token count of a JSON value as it is serialized on the wire. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value) ?? '');
}

export function estimateQuestionTokens(question: JevQuestion): number {
  let tokens = QUESTION_OVERHEAD_TOKENS + estimateTextTokens(question.instructions);
  if (question.type === 'choice') {
    for (const [key, text] of Object.entries(question.criteria)) tokens += CRITERION_OVERHEAD_TOKENS + estimateTextTokens(key) + estimateTextTokens(text);
  } else if (question.type === 'score') {
    for (const text of question.criteria) tokens += CRITERION_OVERHEAD_TOKENS + estimateTextTokens(text);
  } else if (question.criteria !== undefined) {
    tokens += 2 * CRITERION_OVERHEAD_TOKENS + estimateTextTokens(question.criteria.true) + estimateTextTokens(question.criteria.false);
  }
  return tokens;
}

export interface RequestEstimate {
  readonly requestBytes: number;
  readonly stateTokens: number;
  readonly largestQuestionTokens: number;
  readonly totalTokens: number;
  readonly questionCount: number;
  readonly encoderId: typeof ENCODER_ID;
}

export function estimateRequest(request: JevWireRequest): RequestEstimate {
  const stateTokens = typeof request.state === 'string' ? estimateTextTokens(request.state) : estimateJsonTokens(request.state);
  let questionTokens = 0;
  let largest = 0;
  const questions: JevQuestions = request.questions;
  for (const [id, question] of Object.entries(questions)) {
    const tokens = estimateQuestionTokens(question) + estimateTextTokens(id);
    questionTokens += tokens;
    if (tokens > largest) largest = tokens;
  }
  const bound = (value: number): number => Math.ceil(value * SAFETY_FACTOR);
  return {
    requestBytes: utf8Length(JSON.stringify(request)),
    stateTokens: bound(stateTokens),
    largestQuestionTokens: bound(largest),
    totalTokens: bound(REQUEST_OVERHEAD_TOKENS + stateTokens + questionTokens),
    questionCount: Object.keys(questions).length,
    encoderId: ENCODER_ID,
  };
}

export interface RequestCaps {
  readonly maxRequestBytes: number;
  readonly maxQuestions: number;
  readonly requestTokenLimit: number;
  readonly statePlusQuestionTokenLimit: number;
}

export const DEFAULT_REQUEST_CAPS: RequestCaps = Object.freeze({
  maxRequestBytes: DEFAULT_REQUEST_BYTE_CAP,
  maxQuestions: MAX_QUESTIONS,
  requestTokenLimit: REQUEST_TOKEN_LIMIT,
  statePlusQuestionTokenLimit: STATE_PLUS_QUESTION_TOKEN_LIMIT,
});

export type GateResult =
  | { readonly ok: true; readonly estimate: RequestEstimate }
  | {
      readonly ok: false;
      readonly reasonCode: 'REQUEST_TOO_LARGE' | 'TOO_MANY_QUESTIONS';
      readonly limit: 'bytes' | 'tokens' | 'state-plus-question' | 'questions';
      readonly estimate: RequestEstimate;
      /** How many state tokens must go for the request to fit (0 when state is not the problem). */
      readonly stateTokensOver: number;
    };

/** The pre-send gate. It never trims: the caller repacks once or refuses (§7.3). */
export function gateRequest(request: JevWireRequest, caps: RequestCaps = DEFAULT_REQUEST_CAPS): GateResult {
  const estimate = estimateRequest(request);
  if (estimate.questionCount > caps.maxQuestions || estimate.questionCount < 1) {
    return { ok: false, reasonCode: 'TOO_MANY_QUESTIONS', limit: 'questions', estimate, stateTokensOver: 0 };
  }
  const pairOver = estimate.stateTokens + estimate.largestQuestionTokens - caps.statePlusQuestionTokenLimit;
  const totalOver = estimate.totalTokens - caps.requestTokenLimit;
  if (totalOver > 0) return { ok: false, reasonCode: 'REQUEST_TOO_LARGE', limit: 'tokens', estimate, stateTokensOver: Math.max(totalOver, pairOver, 0) };
  if (pairOver > 0) return { ok: false, reasonCode: 'REQUEST_TOO_LARGE', limit: 'state-plus-question', estimate, stateTokensOver: pairOver };
  if (estimate.requestBytes > caps.maxRequestBytes) {
    return { ok: false, reasonCode: 'REQUEST_TOO_LARGE', limit: 'bytes', estimate, stateTokensOver: Math.ceil((estimate.requestBytes - caps.maxRequestBytes) / 1) };
  }
  return { ok: true, estimate };
}
