/**
 * The evaluation data model (EVL-01, §18.2, §18.3, §22.2): protocol, holdout manifest, corpus
 * summary and quality measurement, plus the quality-gate evaluator.
 *
 * Every value is real data validated by schema; nothing here is a literal "not passed". The gate
 * passes only when every input is present and valid: a released, hash-committed holdout that
 * matches the protocol, a consented labelled corpus of at least 300 tasks with at least 30 per
 * automation-eligible slice, a declared non-inferiority margin, and a measured interval whose
 * lower bound clears it. A missing or invalid field is a named reason, never a pass.
 */
import { defineContract } from './contract.js';
import { INTERVAL_METHODS } from './calibration.js';
import { Hash, Id, NonNegativeInteger, Timestamp, text } from './primitives.js';
import * as S from './schema.js';

export const EVAL_MIN_TASKS = 300;
export const EVAL_MIN_PER_SLICE = 30;

export const EVALUATION_BASELINES = ['rules-only', 'native', 'static'] as const;
export const GOLD_LABEL_SOURCES = ['test', 'spec-check', 'adjudicated-review'] as const;

export const EvaluationProtocolSchema = S.object(
  {
    schemaVersion: S.literal('1.0'),
    kind: S.literal('evaluation-protocol'),
    frozenBaseline: S.array(S.enumOf(EVALUATION_BASELINES), { minItems: 1, maxItems: 3, uniqueItems: true }),
    splitPolicy: S.literal('repository-and-time'),
    annotationInstruction: text(2000),
    sourceCorpus: S.boolean(),
    trainer: S.boolean(),
    holdoutId: Id,
    labelledCorpus: S.boolean(),
  },
  {
    /** A declared status is informational only; the gate is always computed. */
    qualityGate: S.enumOf(['not-passed', 'passed'] as const),
    /** Maximum tolerated relative quality loss against the baseline, e.g. 0.02. */
    nonInferiorityMargin: S.number({ minimum: 0, maximum: 0.5 }),
    preRegistrationHash: Hash,
  },
);
export type EvaluationProtocol = S.Static<typeof EvaluationProtocolSchema>;
export const EvaluationProtocolContract = defineContract<EvaluationProtocol>({
  name: 'EvaluationProtocol',
  description: 'The frozen evaluation protocol: baselines, split policy, annotation rule, holdout id and margin (§18.2).',
  schema: EvaluationProtocolSchema,
});

export const HoldoutManifestSchema = S.object({
  schemaVersion: S.literal('1.0'),
  kind: S.literal('holdout-manifest'),
  holdoutId: Id,
  state: S.enumOf(['empty', 'released'] as const),
  size: NonNegativeInteger,
  /** Commitment over the access-controlled holdout, which lives outside the repository. */
  contentHash: Hash,
  goldLabelSources: S.array(S.enumOf(GOLD_LABEL_SOURCES), { maxItems: 3, uniqueItems: true }),
  sliceCounts: S.record(NonNegativeInteger, { keyPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', maxProperties: 256 }),
  releasedAt: S.nullable(Timestamp),
});
export type HoldoutManifest = S.Static<typeof HoldoutManifestSchema>;
export const HoldoutManifestContract = defineContract<HoldoutManifest>({
  name: 'HoldoutManifest',
  description: 'A hash-committed, access-controlled holdout: state, size, gold-label sources and slice counts (§18.2).',
  schema: HoldoutManifestSchema,
  refine: (value, issue) => {
    if (value.state === 'released' && value.releasedAt === null) issue('/releasedAt', 'RELEASED_WITHOUT_DATE');
    if (value.state === 'empty' && value.size !== 0) issue('/size', 'EMPTY_WITH_SIZE');
    let sum = 0;
    for (const count of Object.values(value.sliceCounts)) sum += count;
    if (Object.keys(value.sliceCounts).length > 0 && sum !== value.size) issue('/sliceCounts', 'SLICE_SUM_MISMATCH');
  },
});

export const CorpusSummarySchema = S.object({
  labelled: S.boolean(),
  consented: S.boolean(),
  tasks: NonNegativeInteger,
  /** Tasks per automation-eligible slice. */
  sliceCounts: S.record(NonNegativeInteger, { keyPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', maxProperties: 256 }),
});
export type CorpusSummary = S.Static<typeof CorpusSummarySchema>;
export const CorpusSummaryContract = defineContract<CorpusSummary>({
  name: 'CorpusSummary',
  description: 'Size, consent, labelling and slice counts of an evaluation corpus (§18.2).',
  schema: CorpusSummarySchema,
});

export const QualityMeasurementSchema = S.object({
  metric: S.literal('verified-success-ratio'),
  arm: Id,
  baseline: S.enumOf(EVALUATION_BASELINES),
  /** Ratio of the arm's verified success rate to the baseline's. */
  point: S.number({ minimum: 0, maximum: 100 }),
  lower: S.number({ minimum: 0, maximum: 100 }),
  upper: S.number({ minimum: 0, maximum: 100 }),
  interval: S.enumOf(INTERVAL_METHODS),
  confidence: S.number({ minimum: 0.5, maximum: 0.999 }),
  n: NonNegativeInteger,
  holdoutId: Id,
});
export type QualityMeasurement = S.Static<typeof QualityMeasurementSchema>;
export const QualityMeasurementContract = defineContract<QualityMeasurement>({
  name: 'QualityMeasurement',
  description: 'A measured quality ratio with its interval, method and sample size (§18.3).',
  schema: QualityMeasurementSchema,
  refine: (value, issue) => {
    if (!(value.lower <= value.point && value.point <= value.upper)) issue('/point', 'POINT_OUTSIDE_INTERVAL');
  },
});

export interface QualityGateInput {
  readonly protocol?: unknown;
  readonly holdout?: unknown;
  readonly corpus?: unknown;
  readonly measurement?: unknown;
}

export interface QualityGateResult {
  readonly verdict: 'passed' | 'not-passed';
  readonly reasons: readonly string[];
  readonly holdoutId: string | null;
}

/** Computes the quality gate from real inputs. Missing or invalid input is never a pass. */
export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const reasons: string[] = [];
  const protocol = input.protocol === undefined ? null : EvaluationProtocolContract.validate(input.protocol);
  if (protocol === null) reasons.push('PROTOCOL_MISSING');
  else if (!protocol.ok) reasons.push('PROTOCOL_INVALID');
  const p = protocol !== null && protocol.ok ? protocol.value : null;
  if (p !== null && p.nonInferiorityMargin === undefined) reasons.push('MARGIN_MISSING');
  if (p !== null && p.preRegistrationHash === undefined) reasons.push('PREREGISTRATION_MISSING');

  const holdout = input.holdout === undefined ? null : HoldoutManifestContract.validate(input.holdout);
  if (holdout === null) reasons.push('HOLDOUT_MISSING');
  else if (!holdout.ok) reasons.push('HOLDOUT_INVALID');
  const h = holdout !== null && holdout.ok ? holdout.value : null;
  if (h !== null) {
    if (h.state !== 'released') reasons.push('HOLDOUT_NOT_RELEASED');
    if (h.size === 0) reasons.push('HOLDOUT_EMPTY');
    if (h.goldLabelSources.length === 0) reasons.push('HOLDOUT_NO_GOLD_LABELS');
    if (p !== null && h.holdoutId !== p.holdoutId) reasons.push('HOLDOUT_ID_MISMATCH');
  }

  const corpus = input.corpus === undefined ? null : CorpusSummaryContract.validate(input.corpus);
  if (corpus === null) reasons.push('CORPUS_MISSING');
  else if (!corpus.ok) reasons.push('CORPUS_INVALID');
  const c = corpus !== null && corpus.ok ? corpus.value : null;
  if (c !== null) {
    if (!c.labelled) reasons.push('CORPUS_UNLABELLED');
    if (!c.consented) reasons.push('CORPUS_NOT_CONSENTED');
    if (c.tasks < EVAL_MIN_TASKS) reasons.push('CORPUS_TOO_SMALL');
    const slices = Object.values(c.sliceCounts);
    if (slices.length === 0 || slices.some((count) => count < EVAL_MIN_PER_SLICE)) reasons.push('SLICE_TOO_SMALL');
  }
  if (p !== null && !p.labelledCorpus) reasons.push('PROTOCOL_CORPUS_UNLABELLED');

  const measurement = input.measurement === undefined ? null : QualityMeasurementContract.validate(input.measurement);
  if (measurement === null) reasons.push('MEASUREMENT_MISSING');
  else if (!measurement.ok) reasons.push('MEASUREMENT_INVALID');
  const m = measurement !== null && measurement.ok ? measurement.value : null;
  if (m !== null) {
    if (p !== null && m.holdoutId !== p.holdoutId) reasons.push('MEASUREMENT_HOLDOUT_MISMATCH');
    if (p !== null && !p.frozenBaseline.includes(m.baseline)) reasons.push('MEASUREMENT_BASELINE_NOT_FROZEN');
    if (p?.nonInferiorityMargin !== undefined && m.lower < 1 - p.nonInferiorityMargin) reasons.push('NON_INFERIORITY_NOT_SHOWN');
    if (h !== null && m.n > h.size) reasons.push('MEASUREMENT_LARGER_THAN_HOLDOUT');
  }
  return { verdict: reasons.length === 0 ? 'passed' : 'not-passed', reasons, holdoutId: p?.holdoutId ?? h?.holdoutId ?? null };
}
