/**
 * Pre-registration (EVL-12) and release-evidence emission (EVL-05, EVL-06, §22.2).
 *
 * - `definePreRegistration` fixes the non-inferiority margin, statistical test, alpha, power,
 *   primary quality and cost metrics and the latency-tail objective, and derives the minimum task
 *   count from a power calculation. The owner signs the record; the quality gate then requires the
 *   trial to start after `lockedAt`.
 * - `qualityTrialRecord` and `economicsRecord` turn a trial into the `quality-trial` and
 *   `economics-report` evidence the release gates read. The trial's evaluation protocol names the
 *   pre-registration's payload hash, so the gate can bind the two (`quality.evaluator-bound`).
 *
 * These functions produce records; they do not decide a release. Synthetic records made in tests
 * are labelled by their producer tool and are never written over real evidence.
 */
import { EVAL_MIN_TASKS, releaseEvidence, signRecord, type EvaluationProtocol, type HoldoutManifest, type CorpusSummary, type ReleaseEvidence, ECONOMICS_COMPONENTS } from '@jevris/contracts';
import { bootstrapInterval, normalQuantile } from './metrics.js';
import type { ArmComparison, TrialArm, TrialResult, TrialRow } from './trial.js';

export interface PreRegistrationInput {
  readonly primaryMetric: string;
  readonly primaryCostMetric: string;
  readonly statisticalTest: string;
  /** Non-inferiority margin on the verified-success difference, e.g. 0.05. */
  readonly margin: number;
  /** One-sided significance level. */
  readonly alpha: number;
  readonly power: number;
  /** Expected verified-success rate in both arms, for the power calculation. */
  readonly expectedSuccessRate: number;
  readonly latencyTail: { readonly percentile: number; readonly maxMs: number };
  readonly holdoutHash: string;
  readonly lockedAt: string;
}

export interface PowerCalculation {
  readonly formula: 'two-proportion-non-inferiority';
  readonly zAlpha: number;
  readonly zBeta: number;
  readonly expectedSuccessRate: number;
  readonly requiredTasks: number;
  readonly minTasks: number;
}

/** n = (z_{1-a} + z_{power})^2 * 2p(1-p) / margin^2, at least the corpus floor. */
export function powerCalculation(input: Pick<PreRegistrationInput, 'margin' | 'alpha' | 'power' | 'expectedSuccessRate'>): PowerCalculation {
  if (!(input.margin > 0 && input.margin < 1) || !(input.alpha > 0 && input.alpha < 0.5) || !(input.power > 0 && input.power < 1) || !(input.expectedSuccessRate > 0 && input.expectedSuccessRate < 1)) throw new Error('POWER_INPUT');
  const zAlpha = normalQuantile(1 - input.alpha);
  const zBeta = normalQuantile(input.power);
  const p = input.expectedSuccessRate;
  const required = Math.ceil(((zAlpha + zBeta) ** 2 * 2 * p * (1 - p)) / input.margin ** 2);
  return { formula: 'two-proportion-non-inferiority', zAlpha, zBeta, expectedSuccessRate: p, requiredTasks: required, minTasks: Math.max(EVAL_MIN_TASKS, required) };
}

export interface EvidenceMeta {
  readonly id: string;
  readonly producedAt: string;
  readonly version: string;
  readonly commit?: string | null;
  readonly tool: string;
  readonly run?: string | null;
}

/** The owner-signed pre-registration record. */
export function preRegistrationRecord(input: PreRegistrationInput, meta: EvidenceMeta, owner: { readonly privateKeyPem: string; readonly keyId: string }): { readonly record: ReleaseEvidence; readonly power: PowerCalculation } {
  const power = powerCalculation(input);
  const payload = {
    primaryMetric: input.primaryMetric,
    primaryCostMetric: input.primaryCostMetric,
    statisticalTest: input.statisticalTest,
    margin: input.margin,
    alpha: input.alpha,
    power: input.power,
    minTasks: power.minTasks,
    latencyTail: { percentile: input.latencyTail.percentile, maxMs: input.latencyTail.maxMs },
    holdoutHash: input.holdoutHash,
    lockedAt: input.lockedAt,
  };
  const record = releaseEvidence({ kind: 'pre-registration', ...meta, payload });
  return { record: signRecord(record as unknown as { readonly [key: string]: unknown }, owner.privateKeyPem, owner.keyId) as unknown as ReleaseEvidence, power };
}

/** Whether a trial started strictly after the pre-registration was locked. */
export function lockedBeforeTrial(preRegistration: ReleaseEvidence, trialStartedAt: string): boolean {
  const locked = Date.parse(String(preRegistration.payload['lockedAt']));
  return Number.isFinite(locked) && locked < Date.parse(trialStartedAt);
}

/** The `quality-trial` record, bound to the pre-registration by its payload hash. */
export function qualityTrialRecord(input: {
  readonly trial: TrialResult;
  readonly comparison: ArmComparison;
  readonly preRegistration: ReleaseEvidence;
  readonly protocol: Omit<EvaluationProtocol, 'preRegistrationHash'>;
  readonly holdout: HoldoutManifest;
  readonly corpus: CorpusSummary;
  readonly mandatoryChecksChanged: boolean;
  readonly meta: EvidenceMeta;
}): ReleaseEvidence {
  const ratio = input.comparison.successRatio ?? { point: 0, lower: 0, upper: 0 };
  const payload = {
    preRegistrationHash: input.preRegistration.payloadHash,
    holdoutHash: input.holdout.contentHash,
    tasks: input.comparison.tasks,
    arms: [...input.trial.arms],
    comparison: {
      treatment: input.comparison.treatment,
      baseline: input.comparison.baseline,
      difference: input.comparison.successDifference.point,
      lowerBound: input.comparison.successDifference.lower,
      upperBound: input.comparison.successDifference.upper,
    },
    mandatoryChecksChanged: input.mandatoryChecksChanged,
    startedAt: input.trial.startedAt,
    finishedAt: input.trial.finishedAt,
    evaluation: {
      protocol: { ...input.protocol, preRegistrationHash: input.preRegistration.payloadHash },
      holdout: input.holdout,
      corpus: input.corpus,
      measurement: {
        metric: 'verified-success-ratio',
        arm: input.comparison.treatment,
        baseline: input.comparison.baseline,
        point: ratio.point,
        lower: ratio.lower,
        upper: ratio.upper,
        interval: 'bootstrap',
        confidence: input.comparison.confidence,
        n: input.comparison.tasks,
        holdoutId: input.holdout.holdoutId,
      },
    },
  };
  return releaseEvidence({ kind: 'quality-trial', ...input.meta, payload });
}

function armCostInterval(rows: readonly TrialRow[], arm: TrialArm, seed: number): { readonly point: number; readonly lower: number; readonly upper: number } {
  const own = rows.filter((r) => r.arm === arm);
  const statistic = (sample: readonly TrialRow[]) => {
    const ok = sample.filter((r) => r.verified).length;
    return ok === 0 ? Number.POSITIVE_INFINITY : sample.reduce((s, r) => s + r.costMicroUsd, 0) / ok;
  };
  const value = own.length === 0 ? { point: Number.NaN, lower: Number.NaN, upper: Number.NaN } : bootstrapInterval(own, statistic, { seed, resamples: 1000 });
  const round = (x: number) => (Number.isFinite(x) ? Math.round(x) : -1);
  return { point: round(value.point), lower: round(value.lower), upper: round(value.upper) };
}

/** The `economics-report` record: full cost per verified task with intervals, and pack disable drills. */
export function economicsRecord(input: {
  readonly trial: TrialResult;
  readonly comparison: ArmComparison;
  readonly packDisableDrills: readonly { readonly packId: string; readonly disabled: boolean; readonly independent: boolean; readonly passed: boolean }[];
  readonly meta: EvidenceMeta;
  readonly seed?: number;
}): ReleaseEvidence | { readonly ok: false; readonly reasonCode: 'NO_COST_INTERVAL' | 'NO_TIME_INTERVAL' } {
  if (input.comparison.costPerVerifiedRatio === null) return { ok: false, reasonCode: 'NO_COST_INTERVAL' };
  if (input.comparison.timePerVerifiedRatio === null) return { ok: false, reasonCode: 'NO_TIME_INTERVAL' };
  const rows = input.trial.rows;
  const completed = rows.filter((r) => r.errorCode === null);
  const verifiedTasks = new Set(rows.filter((r) => r.arm === input.comparison.treatment && r.verified).map((r) => r.taskId)).size;
  const payload = {
    tasks: verifiedTasks,
    costPerVerifiedTask: {
      treatment: armCostInterval(rows, input.comparison.treatment, input.seed ?? 5),
      baseline: armCostInterval(rows, input.comparison.baseline, input.seed ?? 5),
      ratio: input.comparison.costPerVerifiedRatio,
    },
    timePerVerifiedTask: { ratio: input.comparison.timePerVerifiedRatio },
    // A component counts as included only when every completed run measured it; failed runs
    // (intent-to-treat) carry what they spent.
    includes: ECONOMICS_COMPONENTS.filter((c) => completed.length > 0 && completed.every((r) => r.measuredComponents.includes(c))),
    packDisableDrills: input.packDisableDrills.map((d) => ({ packId: d.packId, disabled: d.disabled, independent: d.independent, passed: d.passed })),
  };
  return releaseEvidence({ kind: 'economics-report', ...input.meta, payload });
}
