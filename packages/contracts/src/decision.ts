/** Chapter 6.2 decision contracts: DecisionSpec, DecisionResult and the typed Jev answers. */
import { defineContract } from './contract.js';
import { contentHash } from './hash.js';
import {
  Hash,
  Id,
  IdList,
  ModelId,
  NonNegativeInteger,
  Probability,
  ReasonCode,
  SECRET_PATTERNS,
  Timestamp,
} from './primitives.js';
import * as S from './schema.js';

/** Tolerance for probability sums. It is not certified provider precision. */
export const PROBABILITY_SUM_TOLERANCE = 1e-6;
export const MAX_QUESTIONS = 12;
/** Question ids and Choice option keys, as in the reference native client (§2.5). */
export const QUESTION_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const OPTION_KEY_PATTERN = QUESTION_ID_PATTERN;

/**
 * Question text: non-blank and bounded as in the reference client, and additionally never a
 * credential, because question text is sent to the provider.
 */
const QuestionText = (maxLength: number) =>
  S.string({ minLength: 1, maxLength, pattern: '\\S', notPatterns: SECRET_PATTERNS });
const Instructions = QuestionText(8192);
const CriterionText = QuestionText(2048);

export const ChoiceQuestionSchema = S.object({
  type: S.literal('choice'),
  instructions: Instructions,
  criteria: S.record(CriterionText, { keyPattern: OPTION_KEY_PATTERN, minProperties: 2, maxProperties: 255 }),
});
export const ScoreQuestionSchema = S.object({
  type: S.literal('score'),
  instructions: Instructions,
  criteria: S.array(CriterionText, { minItems: 2, maxItems: 10 }),
});
export const NoulQuestionSchema = S.object(
  { type: S.literal('noul'), instructions: Instructions },
  { criteria: S.object({ true: CriterionText, false: CriterionText }) },
);
export const JevQuestionSchema = S.discriminatedUnion('type', [ChoiceQuestionSchema, ScoreQuestionSchema, NoulQuestionSchema]);
export type JevQuestion = S.Static<typeof JevQuestionSchema>;

export const JevQuestionsSchema = S.record(JevQuestionSchema, {
  keyPattern: QUESTION_ID_PATTERN,
  minProperties: 1,
  maxProperties: MAX_QUESTIONS,
});
export type JevQuestions = S.Static<typeof JevQuestionsSchema>;

/**
 * The hash of a question set over canonical JSON. Any change to a question's type, instructions
 * or criteria text changes it, so a changed criterion creates a new decision version (§6.2).
 * Object keys are canonicalized, so reordering question ids or Choice criteria does NOT change
 * it; where wire order matters (the decision cache key, §7.2) use `questionOrderHash` from
 * `@jevris/core`. Score criteria are an array, so their order is part of this hash.
 */
export function questionHash(questions: JevQuestions): string {
  return contentHash(questions);
}

export const DECISION_FALLBACKS = ['rules-only', 'advice', 'abstain'] as const;

export const DecisionSpecSchema = S.object({
  id: Id,
  version: Id,
  questionHash: Hash,
  evidenceRequirements: IdList({ maxItems: 64 }),
  deadlineMs: S.integer({ minimum: 1, maximum: 600_000 }),
  fallback: S.enumOf(DECISION_FALLBACKS),
  calibrationId: S.nullable(Id),
});
export type DecisionSpec = S.Static<typeof DecisionSpecSchema>;

export const DecisionSpecContract = defineContract<DecisionSpec>({
  name: 'DecisionSpec',
  description: 'A versioned decision: question hash, evidence requirements, deadline, fallback, calibration (§6.2).',
  schema: DecisionSpecSchema,
});

/** True when the spec was built from exactly these questions (same criteria, same order). */
export function decisionSpecMatches(spec: DecisionSpec, questions: JevQuestions): boolean {
  return spec.questionHash === questionHash(questions);
}

const Distribution = S.record(Probability, { keyPattern: OPTION_KEY_PATTERN, minProperties: 1, maxProperties: 255 });

export const ChoiceAnswerSchema = S.object({
  type: S.literal('choice'),
  choice: S.string({ pattern: OPTION_KEY_PATTERN }),
  probabilities: Distribution,
  confidence: Probability,
});
export const ScoreAnswerSchema = S.object({
  type: S.literal('score'),
  score: S.number({ minimum: 0, maximum: 9 }),
  probabilities: S.record(Probability, { keyPattern: '^[0-9]$', minProperties: 2, maxProperties: 10 }),
  legend: S.record(CriterionText, { keyPattern: '^[0-9]$', minProperties: 2, maxProperties: 10 }),
  confidence: Probability,
});
export const NoulAnswerSchema = S.object({ type: S.literal('noul'), noul: Probability });
export const JevAnswerSchema = S.discriminatedUnion('type', [ChoiceAnswerSchema, ScoreAnswerSchema, NoulAnswerSchema]);
export type JevAnswer = S.Static<typeof JevAnswerSchema>;

export const DecisionResultSchema = S.object({
  id: Id,
  specId: Id,
  resolvedModelId: ModelId,
  answers: S.record(JevAnswerSchema, { keyPattern: QUESTION_ID_PATTERN, maxProperties: MAX_QUESTIONS }),
  inputTokens: NonNegativeInteger,
  outputTokens: NonNegativeInteger,
  elapsedMs: NonNegativeInteger,
  providerConfidence: S.nullable(Probability),
  empiricalSuccessEstimate: S.nullable(S.object({ value: Probability, calibrationId: Id })),
  evidenceIds: IdList(),
  actionableUntil: Timestamp,
  error: S.nullable(S.object({ reasonCode: ReasonCode })),
});
export type DecisionResult = S.Static<typeof DecisionResultSchema>;

function sumsToOne(distribution: { readonly [key: string]: number }): boolean {
  let total = 0;
  for (const value of Object.values(distribution)) total += value;
  return Math.abs(total - 1) <= PROBABILITY_SUM_TOLERANCE;
}

export const DecisionResultContract = defineContract<DecisionResult>({
  name: 'DecisionResult',
  description: 'Typed answers, resolved model, usage, duration and error. No action is embedded (§6.2).',
  schema: DecisionResultSchema,
  refine: (value, issue) => {
    if (value.error !== null && Object.keys(value.answers).length > 0) issue('/answers', 'ANSWERS_WITH_ERROR');
    for (const [questionId, answer] of Object.entries(value.answers)) {
      const base = `/answers/${questionId}`;
      if (answer.type === 'choice') {
        if (!sumsToOne(answer.probabilities)) issue(`${base}/probabilities`, 'PROBABILITY_SUM');
        const chosen = answer.probabilities[answer.choice];
        if (chosen === undefined) issue(`${base}/choice`, 'CHOICE_NOT_IN_DISTRIBUTION');
        else if (Object.values(answer.probabilities).some((p) => p > chosen + PROBABILITY_SUM_TOLERANCE)) {
          issue(`${base}/choice`, 'CHOICE_NOT_MAXIMUM');
        }
      } else if (answer.type === 'score') {
        if (!sumsToOne(answer.probabilities)) issue(`${base}/probabilities`, 'PROBABILITY_SUM');
        const levels = Object.keys(answer.probabilities).sort();
        const legend = Object.keys(answer.legend).sort();
        if (levels.join(',') !== legend.join(',')) issue(`${base}/legend`, 'LEGEND_MISMATCH');
        if (answer.score > levels.length - 1) issue(`${base}/score`, 'SCORE_OUT_OF_RANGE');
      }
    }
  },
});
