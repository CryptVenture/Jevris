/**
 * The §18.6 benchmark report (EVL-06, US35, C71).
 *
 * Every release report carries the same fields: dataset provenance, exclusions, model and harness
 * versions, question and policy hashes, billing assumptions, actual versus estimated cost, the test
 * environment, baselines, the task-success definition, confidence intervals, subgroup results,
 * latency tails, safety failures, ablation results and known limitations. Negative results are
 * listed, not hidden. A pack that costs more than rules-only without a demonstrated quality gain is
 * flagged for disable.
 */
import { compareArms, summarizeArm, ABLATION_ARMS, type ArmComparison, type ArmSummary, type TrialArm, type TrialResult } from './trial.js';

export const REPORT_FIELDS = [
  'datasetProvenance',
  'exclusions',
  'modelVersions',
  'harnessVersions',
  'questionPolicyHashes',
  'billingAssumptions',
  'actualVersusEstimatedCost',
  'testEnvironment',
  'baselines',
  'taskSuccessDefinition',
  'confidenceIntervals',
  'subgroupResults',
  'latencyTails',
  'safetyFailures',
  'ablationResults',
  'knownLimitations',
  'negativeResults',
  'packsToDisable',
] as const;

export interface ReportContext {
  readonly datasetProvenance: { readonly corpusId: string; readonly holdoutId: string; readonly holdoutHash: string; readonly consent: string };
  /** Exclusions made before assignment, with reasons. */
  readonly exclusions: readonly { readonly taskId: string; readonly reason: string }[];
  readonly modelVersions: Readonly<Record<string, string>>;
  readonly harnessVersions: Readonly<Record<string, string>>;
  readonly questionPolicyHashes: Readonly<Record<string, string>>;
  readonly billingAssumptions: string;
  readonly testEnvironment: { readonly os: string; readonly node: string; readonly sandbox: string };
  readonly taskSuccessDefinition: string;
  readonly knownLimitations: readonly string[];
  /** The treatment arm (normally `jev-routed`) and baselines to compare it against. */
  readonly treatment: TrialArm;
  readonly baselines: readonly TrialArm[];
  /** Packs and the ablation arm that isolates each one. */
  readonly packs: readonly { readonly packId: string; readonly arm: TrialArm }[];
  readonly seed?: number;
}

export interface NegativeResult {
  readonly comparison: string;
  readonly finding: string;
}

export interface BenchmarkReport {
  readonly schemaVersion: 'jevris-benchmark-report-1';
  readonly datasetProvenance: ReportContext['datasetProvenance'];
  readonly exclusions: ReportContext['exclusions'];
  readonly modelVersions: ReportContext['modelVersions'];
  readonly harnessVersions: ReportContext['harnessVersions'];
  readonly questionPolicyHashes: ReportContext['questionPolicyHashes'];
  readonly billingAssumptions: string;
  readonly actualVersusEstimatedCost: readonly { readonly arm: TrialArm; readonly actualMicroUsd: number; readonly estimatedMicroUsd: number }[];
  readonly testEnvironment: ReportContext['testEnvironment'];
  readonly baselines: readonly TrialArm[];
  readonly taskSuccessDefinition: string;
  readonly confidenceIntervals: readonly ArmComparison[];
  readonly subgroupResults: readonly { readonly sliceId: string; readonly arms: readonly ArmSummary[] }[];
  readonly latencyTails: readonly { readonly arm: TrialArm; readonly p50Ms: number; readonly p95Ms: number }[];
  readonly safetyFailures: readonly { readonly arm: TrialArm; readonly taskId: string; readonly failure: string }[];
  readonly ablationResults: readonly ArmComparison[];
  readonly knownLimitations: readonly string[];
  readonly negativeResults: readonly NegativeResult[];
  readonly packsToDisable: readonly { readonly packId: string; readonly reason: string }[];
  readonly arms: readonly ArmSummary[];
  readonly tasks: number;
  readonly intentToTreat: true;
}

function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

export function buildBenchmarkReport(trial: TrialResult, context: ReportContext): BenchmarkReport {
  const seed = context.seed ?? 11;
  const arms = trial.arms.map((arm) => summarizeArm(trial.rows, arm));
  const comparisons = context.baselines.map((baseline) => compareArms(trial.rows, context.treatment, baseline, { seed }));
  const ablations = ABLATION_ARMS.filter((arm) => trial.arms.includes(arm)).map((arm) => compareArms(trial.rows, arm, 'rules-only', { seed }));
  const negative: NegativeResult[] = [];
  for (const c of [...comparisons, ...ablations]) {
    const name = [c.treatment, c.baseline].join(' vs ');
    if (c.successDifference.upper < 0) negative.push({ comparison: name, finding: `verified success lower: difference ${fmt(c.successDifference.point)} [${fmt(c.successDifference.lower)}, ${fmt(c.successDifference.upper)}]` });
    else if (c.successDifference.lower <= 0 && c.successDifference.upper >= 0) negative.push({ comparison: name, finding: `no demonstrated quality difference: [${fmt(c.successDifference.lower)}, ${fmt(c.successDifference.upper)}]` });
    if (c.costPerVerifiedRatio === null) negative.push({ comparison: name, finding: 'cost per verified task not estimable (no verified tasks in an arm)' });
    else if (c.costPerVerifiedRatio.lower > 1) negative.push({ comparison: name, finding: `higher cost per verified task: ratio ${fmt(c.costPerVerifiedRatio.point)} [${fmt(c.costPerVerifiedRatio.lower)}, ${fmt(c.costPerVerifiedRatio.upper)}]` });
    else if (c.costPerVerifiedRatio.upper >= 1) negative.push({ comparison: name, finding: `no demonstrated cost reduction: ratio interval [${fmt(c.costPerVerifiedRatio.lower)}, ${fmt(c.costPerVerifiedRatio.upper)}]` });
  }
  const packsToDisable: { packId: string; reason: string }[] = [];
  for (const pack of context.packs) {
    if (!trial.arms.includes(pack.arm)) {
      packsToDisable.push({ packId: pack.packId, reason: `no ablation arm ${pack.arm} was run` });
      continue;
    }
    const c = compareArms(trial.rows, pack.arm, 'rules-only', { seed });
    const costsMore = c.costPerVerifiedRatio === null || c.costPerVerifiedRatio.point > 1;
    const qualityGain = c.successDifference.lower > 0;
    if (costsMore && !qualityGain) packsToDisable.push({ packId: pack.packId, reason: `costs more than rules-only (ratio ${c.costPerVerifiedRatio === null ? 'n/a' : fmt(c.costPerVerifiedRatio.point)}) without a quality gain (difference lower bound ${fmt(c.successDifference.lower)})` });
  }
  const slices = [...new Set(trial.rows.map((r) => r.sliceId))].sort();
  return {
    schemaVersion: 'jevris-benchmark-report-1',
    datasetProvenance: context.datasetProvenance,
    exclusions: context.exclusions,
    modelVersions: context.modelVersions,
    harnessVersions: context.harnessVersions,
    questionPolicyHashes: context.questionPolicyHashes,
    billingAssumptions: context.billingAssumptions,
    actualVersusEstimatedCost: arms.map((a) => ({ arm: a.arm, actualMicroUsd: a.totalCostMicroUsd, estimatedMicroUsd: a.estimatedCostMicroUsd })),
    testEnvironment: context.testEnvironment,
    baselines: context.baselines,
    taskSuccessDefinition: context.taskSuccessDefinition,
    confidenceIntervals: comparisons,
    subgroupResults: slices.map((sliceId) => ({ sliceId, arms: trial.arms.map((arm) => summarizeArm(trial.rows.filter((r) => r.sliceId === sliceId), arm)) })),
    latencyTails: arms.map((a) => ({ arm: a.arm, p50Ms: a.wallMsP50, p95Ms: a.wallMsP95 })),
    safetyFailures: trial.rows.flatMap((r) => r.safetyFailures.map((failure) => ({ arm: r.arm, taskId: r.taskId, failure }))),
    ablationResults: ablations,
    knownLimitations: context.knownLimitations,
    negativeResults: negative,
    packsToDisable,
    arms,
    tasks: trial.tasks,
    intentToTreat: true,
  };
}

/** Names any §18.6 field that is absent or empty-string in a report. */
export function missingReportFields(report: { readonly [key: string]: unknown }): readonly string[] {
  return REPORT_FIELDS.filter((field) => report[field] === undefined || report[field] === null || report[field] === '');
}
