/**
 * Drift monitor (EVL-04, §18.5, C52, US34).
 *
 * Compares live traffic with the calibration a decision was released on. Model drift (resolved
 * model differs), hash drift (question, encoder or policy hash differs) or task-mix drift (total
 * variation distance between slice mixes above a bound) disables automated use of that decision.
 * It never retunes a threshold: it emits a hypothesis record for the release pipeline, and a
 * human decides whether to recalibrate.
 */
import { contentHash } from '@jevris/contracts';

export interface DriftBaseline {
  readonly decisionSpecId: string;
  readonly calibrationId: string;
  readonly modelId: string;
  readonly questionHash: string;
  readonly encoderHash: string;
  readonly policyHash: string;
  /** Slice shares in the calibration data, summing to about 1. */
  readonly sliceMix: Readonly<Record<string, number>>;
  readonly threshold: number;
}

export interface DriftObservation {
  readonly modelId: string;
  readonly questionHash: string;
  readonly encoderHash: string;
  readonly policyHash: string;
  /** Slice counts in the recent window. */
  readonly sliceCounts: Readonly<Record<string, number>>;
  readonly observedAt: string;
}

export const DRIFT_KINDS = ['model-drift', 'question-hash-drift', 'encoder-hash-drift', 'policy-hash-drift', 'task-mix-drift'] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

export interface HypothesisRecord {
  readonly schemaVersion: 'jevris-hypothesis-1';
  readonly id: string;
  readonly decisionSpecId: string;
  readonly calibrationId: string;
  readonly kinds: readonly DriftKind[];
  readonly observedAt: string;
  readonly detail: Readonly<Record<string, number | string>>;
  /** What the monitor did: disable automation only. */
  readonly action: 'disable-automation';
  /** Always false: drift never changes a released threshold. */
  readonly thresholdChanged: false;
  readonly proposal: 'recalibrate-through-release-pipeline';
}

export interface DriftResult {
  readonly drifted: boolean;
  readonly kinds: readonly DriftKind[];
  readonly automationDisabled: boolean;
  /** The released threshold, unchanged. */
  readonly threshold: number;
  readonly taskMixDistance: number;
  readonly hypothesis: HypothesisRecord | null;
}

/** Total variation distance between two distributions over slice ids. */
export function totalVariation(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const key of keys) sum += Math.abs((a[key] ?? 0) - (b[key] ?? 0));
  return sum / 2;
}

function shares(counts: Readonly<Record<string, number>>): Record<string, number> {
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) out[key] = total === 0 ? 0 : count / total;
  return out;
}

export function detectDrift(baseline: DriftBaseline, observation: DriftObservation, options: { readonly maxTaskMixDistance?: number; readonly minWindow?: number } = {}): DriftResult {
  const kinds: DriftKind[] = [];
  if (observation.modelId !== baseline.modelId) kinds.push('model-drift');
  if (observation.questionHash !== baseline.questionHash) kinds.push('question-hash-drift');
  if (observation.encoderHash !== baseline.encoderHash) kinds.push('encoder-hash-drift');
  if (observation.policyHash !== baseline.policyHash) kinds.push('policy-hash-drift');
  const window = Object.values(observation.sliceCounts).reduce((s, c) => s + c, 0);
  const distance = totalVariation(baseline.sliceMix, shares(observation.sliceCounts));
  if (window >= (options.minWindow ?? 30) && distance > (options.maxTaskMixDistance ?? 0.25)) kinds.push('task-mix-drift');
  const drifted = kinds.length > 0;
  const hypothesis: HypothesisRecord | null = drifted
    ? {
        schemaVersion: 'jevris-hypothesis-1',
        id: `hyp-${contentHash({ baseline: baseline.calibrationId, kinds, at: observation.observedAt }).slice(7, 23)}`,
        decisionSpecId: baseline.decisionSpecId,
        calibrationId: baseline.calibrationId,
        kinds,
        observedAt: observation.observedAt,
        detail: { taskMixDistance: Math.round(distance * 1000) / 1000, window, observedModel: observation.modelId, releasedModel: baseline.modelId },
        action: 'disable-automation',
        thresholdChanged: false,
        proposal: 'recalibrate-through-release-pipeline',
      }
    : null;
  return { drifted, kinds, automationDisabled: drifted, threshold: baseline.threshold, taskMixDistance: distance, hypothesis };
}
