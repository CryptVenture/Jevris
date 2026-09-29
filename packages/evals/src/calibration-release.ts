/**
 * The calibration release pipeline (RTE-13, §18.3, C16, E24).
 *
 * 1. Threshold selection on the calibration split under a declared error budget: the lowest
 *    threshold whose one-sided upper confidence bound on the false-accept rate (accepted cases
 *    whose outcome failed) stays within the budget. The upper bound, not the point estimate, is
 *    what must fit.
 * 2. The holdout is only reported on, never used to pick the threshold.
 * 3. Slices below the minimum size stay advisory: they are left out of `permittedSlices`.
 * 4. The output is a draft proposal. Nothing is published automatically: `releaseProposal`
 *    needs a named reviewer and the release signing key, and produces the signed artifact the
 *    RTE-04 loader accepts.
 */
import { CalibrationArtifactContract, signRecord, type CalibrationArtifact, type ModelQuality } from '@jevris/contracts';
import { clopperPearsonInterval, wilsonInterval } from './metrics.js';

export interface CalibrationCase {
  readonly sliceId: string;
  /** The calibrated provider probability (for example Jev Noul readiness). */
  readonly probability: number;
  /** Whether the task actually succeeded when accepted. */
  readonly outcome: boolean;
  /** The worker model that ran the task, when recorded; holdout cases with it give model qualities. */
  readonly modelId?: string;
}

/**
 * RTE-03, C09: each worker model's verified-success interval (Wilson, 95%) on each permitted
 * slice, from the holdout cases that name their model. A pair below the minimum sample size is
 * left out, so the router treats that model as unknown quality there (shadow only).
 */
export function modelQualities(holdout: readonly CalibrationCase[], permitted: readonly string[], minimumSamples: number): ModelQuality[] {
  const groups = new Map<string, { modelId: string; sliceId: string; n: number; ok: number }>();
  for (const c of holdout) {
    if (typeof c.modelId !== 'string' || c.modelId.length === 0 || !permitted.includes(c.sliceId)) continue;
    const key = `${c.modelId}\u0000${c.sliceId}`;
    const group = groups.get(key) ?? { modelId: c.modelId, sliceId: c.sliceId, n: 0, ok: 0 };
    group.n += 1;
    if (c.outcome) group.ok += 1;
    groups.set(key, group);
  }
  const round = (x: number): number => Math.round(x * 10000) / 10000;
  return [...groups.values()]
    .filter((g) => g.n >= minimumSamples)
    .sort((a, b) => (a.sliceId === b.sliceId ? (a.modelId < b.modelId ? -1 : 1) : a.sliceId < b.sliceId ? -1 : 1))
    .map((g) => {
      const interval = wilsonInterval(g.ok, g.n);
      const point = round(g.ok / g.n);
      return { modelId: g.modelId, sliceId: g.sliceId, lower: Math.min(round(interval.lower), point), point, upper: Math.max(round(interval.upper), point), sampleSize: g.n };
    });
}

export interface ThresholdChoice {
  readonly threshold: number;
  readonly accepted: number;
  readonly falseAccepts: number;
  readonly falseAcceptUpper: number;
  readonly coverage: number;
}

/** Lowest threshold whose false-accept upper bound is within the budget, or null. */
export function selectThreshold(cases: readonly CalibrationCase[], errorBudget: number, confidence = 0.95, minAccepted = 10): ThresholdChoice | null {
  const candidates = [...new Set(cases.map((c) => Math.round(c.probability * 100) / 100))].sort((a, b) => a - b);
  for (const threshold of candidates) {
    const accepted = cases.filter((c) => c.probability >= threshold);
    if (accepted.length < minAccepted) break;
    const falseAccepts = accepted.filter((c) => !c.outcome).length;
    const upper = clopperPearsonInterval(falseAccepts, accepted.length, confidence, 1).upper;
    if (upper <= errorBudget) return { threshold, accepted: accepted.length, falseAccepts, falseAcceptUpper: upper, coverage: accepted.length / cases.length };
  }
  return null;
}

export interface HoldoutReport {
  readonly sliceId: string;
  readonly accepted: number;
  readonly successRate: { readonly point: number; readonly lower: number; readonly upper: number } | null;
  readonly coverage: number;
}

export function holdoutReport(cases: readonly CalibrationCase[], threshold: number, sliceId: string): HoldoutReport {
  const slice = cases.filter((c) => c.sliceId === sliceId);
  const accepted = slice.filter((c) => c.probability >= threshold);
  const successes = accepted.filter((c) => c.outcome).length;
  const interval = accepted.length === 0 ? null : wilsonInterval(successes, accepted.length);
  return { sliceId, accepted: accepted.length, successRate: interval === null ? null : { point: interval.point, lower: interval.lower, upper: interval.upper }, coverage: slice.length === 0 ? 0 : accepted.length / slice.length };
}

export interface ProposalInput {
  readonly id: string;
  readonly decisionSpecId: string;
  readonly decisionSpecVersion: string;
  readonly dataset: CalibrationArtifact['dataset'];
  readonly questionHash: string;
  readonly model: CalibrationArtifact['model'];
  readonly encoderHash: string;
  readonly errorBudget: number;
  readonly calibration: readonly CalibrationCase[];
  readonly holdout: readonly CalibrationCase[];
  readonly minimumSliceSamples: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type ProposalResult =
  | {
      readonly ok: true;
      /** Unsigned, `releaseState: 'draft'`, with no reviewer yet. Never loaded as a release. */
      readonly proposal: Omit<CalibrationArtifact, 'signature' | 'reviewer'>;
      readonly threshold: ThresholdChoice;
      readonly holdout: readonly HoldoutReport[];
      readonly advisorySlices: readonly string[];
    }
  | { readonly ok: false; readonly reasonCode: 'NO_THRESHOLD_WITHIN_BUDGET' | 'NO_SLICE_LARGE_ENOUGH' };

/** Builds a draft calibration proposal. It is never published by this function. */
export function proposeCalibration(input: ProposalInput): ProposalResult {
  const slices = [...new Set([...input.calibration, ...input.holdout].map((c) => c.sliceId))].sort();
  const permitted: { sliceId: string; calibrationSampleSize: number; holdoutSampleSize: number }[] = [];
  const advisory: string[] = [];
  for (const sliceId of slices) {
    const cal = input.calibration.filter((c) => c.sliceId === sliceId).length;
    const hold = input.holdout.filter((c) => c.sliceId === sliceId).length;
    if (Math.min(cal, hold) < input.minimumSliceSamples) advisory.push(sliceId);
    else permitted.push({ sliceId, calibrationSampleSize: cal, holdoutSampleSize: hold });
  }
  if (permitted.length === 0) return { ok: false, reasonCode: 'NO_SLICE_LARGE_ENOUGH' };
  const eligible = input.calibration.filter((c) => permitted.some((s) => s.sliceId === c.sliceId));
  const threshold = selectThreshold(eligible, input.errorBudget);
  if (threshold === null) return { ok: false, reasonCode: 'NO_THRESHOLD_WITHIN_BUDGET' };
  const reports = permitted.map((s) => holdoutReport(input.holdout, threshold.threshold, s.sliceId));
  const pooled = input.holdout.filter((c) => permitted.some((s) => s.sliceId === c.sliceId) && c.probability >= threshold.threshold);
  const interval = pooled.length === 0 ? { lower: 0, upper: 1 } : wilsonInterval(pooled.filter((c) => c.outcome).length, pooled.length);
  const qualities = modelQualities(input.holdout, permitted.map((p) => p.sliceId), input.minimumSliceSamples);
  return {
    ok: true,
    proposal: {
      id: input.id,
      schemaVersion: '1.0',
      releaseState: 'draft',
      decisionSpecId: input.decisionSpecId,
      decisionSpecVersion: input.decisionSpecVersion,
      dataset: input.dataset,
      questionHash: input.questionHash,
      model: input.model,
      encoderHash: input.encoderHash,
      threshold: { metric: 'noul-probability', value: threshold.threshold, errorBudget: input.errorBudget },
      permittedSlices: permitted,
      uncertaintyInterval: { lower: Math.round(interval.lower * 10000) / 10000, upper: Math.round(interval.upper * 10000) / 10000, confidenceLevel: 0.95, method: 'wilson' },
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      expiryConditions: ['model-revision-changed', 'encoder-changed', 'question-changed', 'drift-detected'],
      ...(qualities.length === 0 ? {} : { modelQualities: qualities }),
    },
    threshold,
    holdout: reports,
    advisorySlices: advisory,
  };
}

export type ReleaseResult = { readonly ok: true; readonly artifact: CalibrationArtifact } | { readonly ok: false; readonly reasonCode: string };

/** A reviewer releases a proposal: the only path to a signed, released artifact. */
export function releaseProposal(proposal: Omit<CalibrationArtifact, 'signature' | 'reviewer'>, review: { readonly reviewerId: string; readonly reviewedAt: string; readonly approved: boolean }, key: { readonly privateKeyPem: string; readonly keyId: string }): ReleaseResult {
  if (!review.approved) return { ok: false, reasonCode: 'NOT_APPROVED' };
  // The release is issued when it is reviewed: a review never postdates the issue time.
  const issuedAt = Date.parse(review.reviewedAt) > Date.parse(proposal.issuedAt) ? review.reviewedAt : proposal.issuedAt;
  const unsigned = { ...proposal, issuedAt, releaseState: 'released' as const, reviewer: { id: review.reviewerId, reviewedAt: review.reviewedAt } };
  const signed = signRecord(unsigned as unknown as { readonly [key: string]: unknown }, key.privateKeyPem, key.keyId) as unknown as CalibrationArtifact;
  const checked = CalibrationArtifactContract.validate(signed);
  if (!checked.ok) return { ok: false, reasonCode: `INVALID_ARTIFACT:${checked.issues[0]?.path ?? ''}:${checked.issues[0]?.code ?? ''}` };
  return { ok: true, artifact: checked.value };
}
