/**
 * Policy-evaluation laboratory (C71, RSH-10, SSOT §12.9, §18.2).
 *
 * Runs offline experiments: each routing-policy variant (a quality floor and an allowed model
 * set) is fitted on the frozen, sanitized train tasks and scored on the test tasks, and the lab
 * returns a reviewable report. It never changes a live policy.
 *
 * Contamination checks are mandatory and run before any variant is scored. A failed check
 * refuses the experiment with the failing check named:
 * - no task id in both splits;
 * - no repository in both splits (the §18.2 repository split);
 * - every test task later than every train task (the time split);
 * - no near-duplicate task summaries across the splits (word-shingle Jaccard ≥ 0.8);
 * - no task from the frozen calibration holdout (EVL-13) in either split.
 *
 * The evaluation budget caps variants × test tasks. An experiment over budget is refused, never
 * truncated.
 */
import { contentHash } from '@jevris/contracts';
import { policyMetrics, sliceRouterTable, type PolicyMetrics, type RouterExample } from './learned-router.js';

export const POLICY_LAB_REPORT_SCHEMA = 'jevris-policy-lab-report-1' as const;

/** A frozen, sanitized task: the router example plus its split provenance. */
export interface LabTask extends RouterExample {
  readonly repository: string;
  readonly createdAt: string;
  /** A short sanitized summary, used only for the near-duplicate check. */
  readonly summary: string;
}

export interface PolicyVariant {
  readonly id: string;
  readonly qualityFloor: number;
  /** Models the variant may route to; all when absent. */
  readonly allowedModels?: readonly string[];
}

export interface LabExperiment {
  readonly train: readonly LabTask[];
  readonly test: readonly LabTask[];
  readonly variants: readonly PolicyVariant[];
  readonly baselineModelId: string;
  /** Task ids of the frozen calibration holdout; none may appear here. */
  readonly frozenHoldoutIds: readonly string[];
  /** Maximum variant × test-task evaluations. */
  readonly evaluationBudget: number;
}

export interface ContaminationReport {
  readonly passed: boolean;
  readonly checks: readonly { readonly id: 'task-overlap' | 'repository-overlap' | 'time-order' | 'near-duplicate' | 'frozen-holdout'; readonly passed: boolean; readonly findings: number }[];
}

export interface PolicyLabReport {
  readonly schemaVersion: typeof POLICY_LAB_REPORT_SCHEMA;
  readonly experimentId: string;
  readonly inputsHash: string;
  readonly contamination: ContaminationReport;
  readonly baseline: PolicyMetrics;
  readonly variants: readonly { readonly id: string; readonly qualityFloor: number; readonly allowedModels: readonly string[] | null; readonly table: { readonly [sliceId: string]: string }; readonly metrics: PolicyMetrics }[];
  readonly evaluations: number;
  /** Offline evidence only; adopting a variant is a reviewed policy release. */
  readonly applied: false;
  readonly reviewRequired: true;
}

export type PolicyLabResult = { readonly ok: true; readonly report: PolicyLabReport } | { readonly ok: false; readonly reasonCode: 'NO_TASKS' | 'NO_VARIANTS' | 'OVER_BUDGET' | 'CONTAMINATED' | 'INVALID_VARIANT'; readonly contamination?: ContaminationReport };

function shingles(text: string, size = 3): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  if (out.size === 0 && words.length > 0) out.add(words.join(' '));
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** The mandatory contamination checks (never skipped). */
export function contaminationChecks(train: readonly LabTask[], test: readonly LabTask[], frozenHoldoutIds: readonly string[], threshold = 0.8): ContaminationReport {
  const trainIds = new Set(train.map((t) => t.taskId));
  const taskOverlap = test.filter((t) => trainIds.has(t.taskId)).length;
  const trainRepos = new Set(train.map((t) => t.repository.toLowerCase()));
  const repoOverlap = test.filter((t) => trainRepos.has(t.repository.toLowerCase())).length;
  const lastTrain = Math.max(...train.map((t) => Date.parse(t.createdAt)).filter(Number.isFinite), -Infinity);
  const timeViolations = test.filter((t) => !(Date.parse(t.createdAt) > lastTrain)).length;
  const trainShingles = train.map((t) => shingles(t.summary));
  const nearDuplicates = test.filter((t) => {
    const s = shingles(t.summary);
    return trainShingles.some((u) => jaccard(s, u) >= threshold);
  }).length;
  const frozen = new Set(frozenHoldoutIds);
  const frozenHits = [...train, ...test].filter((t) => frozen.has(t.taskId)).length;
  const checks = [
    { id: 'task-overlap' as const, passed: taskOverlap === 0, findings: taskOverlap },
    { id: 'repository-overlap' as const, passed: repoOverlap === 0, findings: repoOverlap },
    { id: 'time-order' as const, passed: timeViolations === 0, findings: timeViolations },
    { id: 'near-duplicate' as const, passed: nearDuplicates === 0, findings: nearDuplicates },
    { id: 'frozen-holdout' as const, passed: frozenHits === 0, findings: frozenHits },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

/** Runs one offline experiment and returns its reviewable report. */
export function runPolicyExperiment(experiment: LabExperiment): PolicyLabResult {
  if (experiment.train.length === 0 || experiment.test.length === 0) return { ok: false, reasonCode: 'NO_TASKS' };
  if (experiment.variants.length === 0) return { ok: false, reasonCode: 'NO_VARIANTS' };
  if (experiment.variants.some((v) => !(v.qualityFloor >= 0 && v.qualityFloor <= 1) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.id))) return { ok: false, reasonCode: 'INVALID_VARIANT' };
  const evaluations = experiment.variants.length * experiment.test.length;
  if (!(evaluations <= experiment.evaluationBudget)) return { ok: false, reasonCode: 'OVER_BUDGET' };
  const contamination = contaminationChecks(experiment.train, experiment.test, experiment.frozenHoldoutIds);
  if (!contamination.passed) return { ok: false, reasonCode: 'CONTAMINATED', contamination };
  const baseline = policyMetrics(experiment.test, () => experiment.baselineModelId);
  const variants = experiment.variants.map((v) => {
    const table = sliceRouterTable(experiment.train, v.qualityFloor, experiment.baselineModelId, v.allowedModels);
    return { id: v.id, qualityFloor: v.qualityFloor, allowedModels: v.allowedModels === undefined ? null : [...v.allowedModels], table, metrics: policyMetrics(experiment.test, (t) => table[t.sliceId] ?? experiment.baselineModelId) };
  });
  const inputsHash = contentHash({
    train: experiment.train.map((t) => t.taskId).sort(),
    test: experiment.test.map((t) => t.taskId).sort(),
    variants: experiment.variants.map((v) => ({ id: v.id, qualityFloor: v.qualityFloor, allowedModels: v.allowedModels ?? null })),
    baseline: experiment.baselineModelId,
  });
  return {
    ok: true,
    report: { schemaVersion: POLICY_LAB_REPORT_SCHEMA, experimentId: `lab-${inputsHash.slice(7, 31)}`, inputsHash, contamination, baseline, variants, evaluations, applied: false, reviewRequired: true },
  };
}
