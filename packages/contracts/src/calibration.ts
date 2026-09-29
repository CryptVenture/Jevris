/**
 * CalibrationArtifact (§18.3, CTR-05): the shipped artifact names its dataset and version, the
 * question, model and encoder hashes, the decision threshold, the permitted slices, the
 * uncertainty interval, the reviewer and the expiry conditions, and it is signed.
 * A threshold change is a policy release, so any change breaks the signature.
 */
import { defineContract, timestampMs } from './contract.js';
import { Hash, Id, ModelId, SECRET_PATTERNS, NonNegativeInteger, PositiveInteger, Probability, SignatureSchema, Timestamp } from './primitives.js';
import * as S from './schema.js';

export const THRESHOLD_METRICS = ['choice-probability', 'noul-probability', 'score'] as const;
export const INTERVAL_METHODS = ['wilson', 'clopper-pearson', 'bootstrap', 'beta-posterior'] as const;
export const EXPIRY_CONDITIONS = [
  'model-revision-changed',
  'encoder-changed',
  'question-changed',
  'drift-detected',
  'policy-changed',
] as const;
export const CALIBRATION_RELEASE_STATES = ['draft', 'released'] as const;
/** The effort levels a model quality can be measured at (the vendor's effort page). */
export const QUALITY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * A worker model's verified-success interval on one permitted slice, measured on the holdout
 * (RTE-03, C09). The router's quality floor comes from `threshold`; these are the qualities it
 * compares against that floor. Signed with the rest of the release.
 */
export const ModelQualitySchema = S.object({
  modelId: ModelId,
  sliceId: Id,
  lower: Probability,
  point: Probability,
  upper: Probability,
  sampleSize: PositiveInteger,
}, {
  /**
   * C16 effort arms: the effort level the quality was measured at. Absent means the model's
   * default effort. A model may appear once per effort on a slice.
   */
  effort: S.enumOf(QUALITY_EFFORT_LEVELS),
  /** The measured API-equivalent cost per task at this model and effort (the seed run), micro-USD. */
  meanCostMicroUsd: NonNegativeInteger,
  /** The measured tokens per task at this model and effort (the seed run). */
  meanTokens: NonNegativeInteger,
});
export type ModelQuality = S.Static<typeof ModelQualitySchema>;

export const BASELINE_SOURCE_KINDS = ['published', 'seed'] as const;
const CalendarDate = S.string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

/**
 * One result a signed baseline release was built from (§18.3 as amended at 6d7222a: "its holdout
 * report is the list of the benchmark results and seed runs it was built from, with their sample
 * sizes and dates"). A published benchmark row, or one arm of the owner's seed run, which also
 * names the seed's task selection and its run records by hash.
 */
export const BaselineSourceSchema = S.object({
  kind: S.enumOf(BASELINE_SOURCE_KINDS),
  /** The source's id, for example `AA-CAI` or `seed:swe-bench-live@2026-09`. */
  sourceId: S.string({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$', notPatterns: SECRET_PATTERNS }),
  /** The benchmark slice the result was measured on (for example `issue-fix`). */
  priorSliceId: Id,
  /** The permitted slice of this release it feeds. */
  sliceId: Id,
  modelId: ModelId,
  effort: S.enumOf(QUALITY_EFFORT_LEVELS),
  successes: NonNegativeInteger,
  trials: PositiveInteger,
  benchmark: S.string({ minLength: 1, maxLength: 200, notPatterns: SECRET_PATTERNS }),
  url: S.string({ pattern: '^https://[^\\s]{1,500}$' }),
  publishedOn: CalendarDate,
  fetchedOn: CalendarDate,
}, {
  /** A seed source: the hash of the task selection, recorded before any run. */
  selectionHash: Hash,
  /** A seed source: the content hash of the run records (runs.jsonl). */
  runsHash: Hash,
});
export type BaselineSource = S.Static<typeof BaselineSourceSchema>;

export const CalibrationArtifactSchema = S.object({
  id: Id,
  schemaVersion: S.literal('1.0'),
  releaseState: S.enumOf(CALIBRATION_RELEASE_STATES),
  decisionSpecId: Id,
  decisionSpecVersion: Id,
  dataset: S.object({ id: Id, version: Id, contentHash: Hash }),
  questionHash: Hash,
  model: S.object({ modelId: ModelId, revisionHash: Hash }),
  encoderHash: Hash,
  threshold: S.object({
    metric: S.enumOf(THRESHOLD_METRICS),
    value: S.number({ minimum: 0, maximum: 9 }),
    errorBudget: Probability,
  }),
  permittedSlices: S.array(
    S.object({ sliceId: Id, calibrationSampleSize: PositiveInteger, holdoutSampleSize: PositiveInteger }),
    { minItems: 1, maxItems: 256 },
  ),
  uncertaintyInterval: S.object({
    lower: Probability,
    upper: Probability,
    confidenceLevel: S.number({ exclusiveMinimum: 0, maximum: 0.9999 }),
    method: S.enumOf(INTERVAL_METHODS),
  }),
  reviewer: S.object({ id: Id, reviewedAt: Timestamp }),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  expiryConditions: S.array(S.enumOf(EXPIRY_CONDITIONS), { maxItems: EXPIRY_CONDITIONS.length, uniqueItems: true }),
  signature: SignatureSchema,
}, {
  /** Per-model quality intervals on the permitted slices; absent in a threshold-only release. */
  modelQualities: S.array(ModelQualitySchema, { maxItems: 1024 }),
  /** The holdout report of a `beta-posterior` baseline release: the results it was built from. */
  baselineSources: S.array(BaselineSourceSchema, { minItems: 1, maxItems: 1024 }),
});
export type CalibrationArtifact = S.Static<typeof CalibrationArtifactSchema>;

export const CalibrationArtifactContract = defineContract<CalibrationArtifact>({
  name: 'CalibrationArtifact',
  description: 'A signed, expiring calibration release for one decision (§18.3). Shared by the routing loader, release pipeline, doctor and portability gate.',
  schema: CalibrationArtifactSchema,
  refine: (value, issue) => {
    if (value.uncertaintyInterval.lower > value.uncertaintyInterval.upper) issue('/uncertaintyInterval', 'INTERVAL_ORDER');
    if (value.threshold.metric !== 'score' && value.threshold.value > 1) issue('/threshold/value', 'PROBABILITY_RANGE');
    if (timestampMs(value.expiresAt) <= timestampMs(value.issuedAt)) issue('/expiresAt', 'EXPIRY_NOT_AFTER_ISSUE');
    if (timestampMs(value.reviewer.reviewedAt) > timestampMs(value.issuedAt)) issue('/reviewer/reviewedAt', 'REVIEW_AFTER_ISSUE');
    const seen = new Set<string>();
    value.permittedSlices.forEach((slice, index) => {
      if (seen.has(slice.sliceId)) issue(`/permittedSlices/${index}/sliceId`, 'DUPLICATE_SLICE');
      seen.add(slice.sliceId);
    });
    const pairs = new Set<string>();
    (value.modelQualities ?? []).forEach((quality, index) => {
      if (!seen.has(quality.sliceId)) issue(`/modelQualities/${index}/sliceId`, 'SLICE_NOT_PERMITTED');
      if (!(quality.lower <= quality.point && quality.point <= quality.upper)) issue(`/modelQualities/${index}/point`, 'POINT_OUTSIDE_INTERVAL');
      const pair = `${quality.modelId}\u0000${quality.sliceId}\u0000${quality.effort ?? ''}`;
      if (pairs.has(pair)) issue(`/modelQualities/${index}`, 'DUPLICATE_MODEL_QUALITY');
      pairs.add(pair);
    });
    const baseline = value.uncertaintyInterval.method === 'beta-posterior';
    const sources = value.baselineSources ?? [];
    if (baseline && sources.length === 0) issue('/baselineSources', 'BASELINE_SOURCES_REQUIRED');
    if (!baseline && value.baselineSources !== undefined) issue('/baselineSources', 'BASELINE_SOURCES_METHOD');
    sources.forEach((source, index) => {
      if (source.successes > source.trials) issue(`/baselineSources/${index}/successes`, 'SUCCESSES_ABOVE_TRIALS');
      if (!seen.has(source.sliceId)) issue(`/baselineSources/${index}/sliceId`, 'SLICE_NOT_PERMITTED');
      if (source.kind === 'seed' && (source.selectionHash === undefined || source.runsHash === undefined)) issue(`/baselineSources/${index}`, 'SEED_HASHES_REQUIRED');
    });
    if (baseline) {
      (value.modelQualities ?? []).forEach((quality, index) => {
        if (quality.effort === undefined) {
          issue(`/modelQualities/${index}/effort`, 'QUALITY_EFFORT_REQUIRED');
          return;
        }
        if (sources.length === 0) return;
        const trials = sources
          .filter((s) => s.sliceId === quality.sliceId && s.modelId === quality.modelId && s.effort === quality.effort)
          .reduce((sum, s) => sum + s.trials, 0);
        if (trials !== quality.sampleSize) issue(`/modelQualities/${index}/sampleSize`, 'QUALITY_NOT_BACKED');
      });
    }
  },
});

export interface CalibrationContext {
  readonly nowMs: number;
  readonly decisionSpecId: string;
  readonly decisionSpecVersion: string;
  readonly questionHash: string;
  readonly modelId: string;
  readonly modelRevisionHash: string;
  readonly encoderHash: string;
  readonly sliceId: string;
  /** Slices with fewer samples than this stay advisory (§18.3). */
  readonly minimumSliceSamples: number;
}

export type CalibrationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'DRAFT'
        | 'NOT_YET_VALID'
        | 'EXPIRED'
        | 'SPEC_MISMATCH'
        | 'QUESTION_MISMATCH'
        | 'MODEL_MISMATCH'
        | 'ENCODER_MISMATCH'
        | 'SLICE_NOT_PERMITTED'
        | 'SLICE_TOO_SMALL';
    };

/**
 * Whether a validated, signature-checked artifact applies to this decision now. Any mismatch in
 * spec, question, model or encoder, a draft, an expired artifact or a small slice disables
 * automation. This does not verify the signature; call verifyRecordSignature first.
 */
export function calibrationApplies(artifact: CalibrationArtifact, context: CalibrationContext): CalibrationCheck {
  const refuse = (reasonCode: Exclude<CalibrationCheck, { ok: true }>['reasonCode']): CalibrationCheck => ({ ok: false, reasonCode });
  if (artifact.releaseState !== 'released') return refuse('DRAFT');
  if (!Number.isFinite(context.nowMs) || context.nowMs < timestampMs(artifact.issuedAt)) return refuse('NOT_YET_VALID');
  if (context.nowMs >= timestampMs(artifact.expiresAt)) return refuse('EXPIRED');
  if (artifact.decisionSpecId !== context.decisionSpecId || artifact.decisionSpecVersion !== context.decisionSpecVersion) {
    return refuse('SPEC_MISMATCH');
  }
  if (artifact.questionHash !== context.questionHash) return refuse('QUESTION_MISMATCH');
  if (artifact.model.modelId !== context.modelId || artifact.model.revisionHash !== context.modelRevisionHash) {
    return refuse('MODEL_MISMATCH');
  }
  if (artifact.encoderHash !== context.encoderHash) return refuse('ENCODER_MISMATCH');
  const slice = artifact.permittedSlices.find((candidate) => candidate.sliceId === context.sliceId);
  if (slice === undefined) return refuse('SLICE_NOT_PERMITTED');
  // A beta-posterior baseline is a prior that counts for its real sample (capped by route
  // learning), and it acts only through the §18.5 gate: a small slice weighs little, it is not refused.
  const prior = artifact.uncertaintyInterval.method === 'beta-posterior';
  if (!prior && Math.min(slice.calibrationSampleSize, slice.holdoutSampleSize) < context.minimumSliceSamples) return refuse('SLICE_TOO_SMALL');
  return { ok: true };
}
