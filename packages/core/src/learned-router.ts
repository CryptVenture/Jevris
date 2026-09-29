/**
 * Task-specific learned router (C66, RSH-05, SSOT §12.9, E36).
 *
 * An offline, downstream estimator: one L2-regularised logistic model per worker model predicts
 * verified success from observable, pre-outcome task features. It is not a fine-tune of Jev.
 *
 * - Training refuses rows without a consent id and features that name an outcome, a cost or a
 *   person (no identity-based profiling), so an outcome can never leak into a prediction.
 * - Evaluation is on a separate holdout: routing regret against the oracle, success and cost
 *   against the fixed strong-model baseline and against the existing per-slice router (the
 *   cheapest model whose training success rate meets the floor), plus Brier score and expected
 *   calibration error per model.
 * - The artifact starts as a `candidate`. It becomes deployable only with a review record signed
 *   by a trusted calibration key that approves this exact artifact, and only when the holdout
 *   shows an improvement over the existing router (E36 exit criterion). `learnedRouteAdvice`
 *   abstains otherwise. Even deployed it is advice: `applied` is always false.
 * - `syntheticRoutingExamples` makes a seeded synthetic dataset for demonstration and tests;
 *   real training needs the consented corpus (EVL-13).
 */
import { contentHash, verifyRecordSignature } from '@jevris/contracts';

export const LEARNED_ROUTER_SCHEMA = 'jevris-learned-router-1' as const;
export const ROUTER_REVIEW_SCHEMA = 'jevris-learned-router-review-1' as const;

/** Feature names that would leak an outcome or profile a person; refused at training. */
export const FORBIDDEN_FEATURE = /verif|outcome|success|pass(ed)?$|fail(ed)?$|cost|price|spend|author|user|email|person|developer|owner|identity|login|name|team/i;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FEATURE = /^[a-z][A-Za-z0-9_]{0,63}$/;

export interface ModelOutcome {
  readonly verified: boolean;
  readonly costMicroUsd: number;
}

/** One task with its pre-outcome features and the observed outcome of each model on it. */
export interface RouterExample {
  readonly taskId: string;
  readonly sliceId: string;
  readonly consentId: string;
  readonly datasetVersion: string;
  readonly features: { readonly [name: string]: number };
  readonly outcomes: { readonly [modelId: string]: ModelOutcome };
}

export interface ModelWeights {
  readonly modelId: string;
  readonly bias: number;
  readonly weights: readonly number[];
  readonly meanCostMicroUsd: number;
}

export interface PolicyMetrics {
  readonly successRate: number;
  readonly meanCostMicroUsd: number;
  /** Mean of (oracle verified success) minus (chosen model's verified success). */
  readonly regret: number;
}

export interface HoldoutEvaluation {
  readonly tasks: number;
  readonly learned: PolicyMetrics;
  readonly baseline: PolicyMetrics;
  readonly existingRouter: PolicyMetrics;
  readonly calibration: readonly { readonly modelId: string; readonly brier: number; readonly ece: number }[];
  /** Held-out improvement over the existing router: lower regret, or no less success at lower cost. */
  readonly improvesOnRouter: boolean;
}

export interface LearnedRouterArtifact {
  readonly schemaVersion: typeof LEARNED_ROUTER_SCHEMA;
  readonly id: string;
  readonly state: 'candidate';
  readonly trainedAt: string;
  readonly datasetVersions: readonly string[];
  readonly trainingTasks: number;
  readonly qualityFloor: number;
  readonly baselineModelId: string;
  readonly featureNames: readonly string[];
  readonly featureMeans: readonly number[];
  readonly featureScales: readonly number[];
  readonly models: readonly ModelWeights[];
  /** The existing router's per-slice choice from training rates (what the estimator must beat). */
  readonly routerTable: { readonly [sliceId: string]: string };
  readonly holdout: HoldoutEvaluation;
}

export type TrainRefusal = { readonly ok: false; readonly reasonCode: 'NO_EXAMPLES' | 'CONSENT_MISSING' | 'FORBIDDEN_FEATURE' | 'FEATURES_INCONSISTENT' | 'MODELS_INCONSISTENT' | 'BASELINE_UNKNOWN' | 'INVALID_EXAMPLE'; readonly detail?: string };

export interface TrainOptions {
  readonly qualityFloor: number;
  readonly baselineModelId: string;
  readonly trainedAt: string;
  readonly epochs?: number;
  readonly learningRate?: number;
  readonly l2?: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function check(examples: readonly RouterExample[], baselineModelId: string): TrainRefusal | { readonly ok: true; readonly featureNames: readonly string[]; readonly modelIds: readonly string[] } {
  const first = examples[0];
  if (first === undefined) return { ok: false, reasonCode: 'NO_EXAMPLES' };
  const featureNames = Object.keys(first.features).sort();
  const modelIds = Object.keys(first.outcomes).sort();
  for (const name of featureNames) {
    if (!FEATURE.test(name)) return { ok: false, reasonCode: 'INVALID_EXAMPLE', detail: 'feature-name' };
    if (FORBIDDEN_FEATURE.test(name)) return { ok: false, reasonCode: 'FORBIDDEN_FEATURE', detail: name };
  }
  if (!modelIds.includes(baselineModelId)) return { ok: false, reasonCode: 'BASELINE_UNKNOWN' };
  for (const e of examples) {
    if (typeof e.consentId !== 'string' || e.consentId.trim() === '') return { ok: false, reasonCode: 'CONSENT_MISSING', detail: e.taskId };
    if (!ID.test(e.taskId) || !ID.test(e.sliceId) || !ID.test(e.datasetVersion)) return { ok: false, reasonCode: 'INVALID_EXAMPLE', detail: 'id' };
    const names = Object.keys(e.features).sort();
    if (names.join(',') !== featureNames.join(',') || names.some((n) => !Number.isFinite(e.features[n]))) return { ok: false, reasonCode: 'FEATURES_INCONSISTENT', detail: e.taskId };
    const models = Object.keys(e.outcomes).sort();
    if (models.join(',') !== modelIds.join(',')) return { ok: false, reasonCode: 'MODELS_INCONSISTENT', detail: e.taskId };
    for (const m of models) {
      const o = e.outcomes[m];
      if (o === undefined || typeof o.verified !== 'boolean' || !Number.isFinite(o.costMicroUsd) || o.costMicroUsd < 0) return { ok: false, reasonCode: 'INVALID_EXAMPLE', detail: e.taskId };
    }
  }
  return { ok: true, featureNames, modelIds };
}

function vector(e: RouterExample, names: readonly string[], means: readonly number[], scales: readonly number[]): number[] {
  return names.map((n, i) => ((e.features[n] ?? 0) - (means[i] ?? 0)) / (scales[i] ?? 1));
}

function predictAll(artifact: Pick<LearnedRouterArtifact, 'featureNames' | 'featureMeans' | 'featureScales' | 'models'>, features: { readonly [name: string]: number }): Map<string, number> {
  const x = artifact.featureNames.map((n, i) => ((features[n] ?? 0) - (artifact.featureMeans[i] ?? 0)) / (artifact.featureScales[i] ?? 1));
  const out = new Map<string, number>();
  for (const m of artifact.models) out.set(m.modelId, sigmoid(m.bias + m.weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)));
  return out;
}

/** The learned policy: the cheapest model predicted to meet the floor, else the most likely to succeed. */
function choose(predicted: ReadonlyMap<string, number>, models: readonly ModelWeights[], floor: number): string {
  const ranked = [...models].sort((a, b) => a.meanCostMicroUsd - b.meanCostMicroUsd || (a.modelId < b.modelId ? -1 : 1));
  const meets = ranked.find((m) => (predicted.get(m.modelId) ?? 0) >= floor);
  if (meets !== undefined) return meets.modelId;
  return [...models].sort((a, b) => (predicted.get(b.modelId) ?? 0) - (predicted.get(a.modelId) ?? 0) || (a.modelId < b.modelId ? -1 : 1))[0]?.modelId ?? '';
}

/** Success, mean cost and oracle regret of a routing policy over tasks with per-model outcomes. */
export function policyMetrics(holdout: readonly RouterExample[], pick: (e: RouterExample) => string): PolicyMetrics {
  let success = 0;
  let cost = 0;
  let regret = 0;
  for (const e of holdout) {
    const chosen = e.outcomes[pick(e)];
    const oracle = Object.values(e.outcomes).some((o) => o.verified) ? 1 : 0;
    const got = chosen?.verified === true ? 1 : 0;
    success += got;
    cost += chosen?.costMicroUsd ?? 0;
    regret += oracle - got;
  }
  const n = Math.max(1, holdout.length);
  return { successRate: round(success / n), meanCostMicroUsd: Math.round(cost / n), regret: round(regret / n) };
}

/** Brier score and 10-bin expected calibration error of one model's predictions on the holdout. */
function calibrationOf(pairs: readonly (readonly [number, number])[]): { readonly brier: number; readonly ece: number } {
  if (pairs.length === 0) return { brier: 0, ece: 0 };
  const brier = pairs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / pairs.length;
  let ece = 0;
  for (let b = 0; b < 10; b += 1) {
    const bin = pairs.filter(([p]) => (b === 9 ? p >= b / 10 : p >= b / 10 && p < (b + 1) / 10));
    if (bin.length === 0) continue;
    const conf = bin.reduce((s, [p]) => s + p, 0) / bin.length;
    const acc = bin.reduce((s, [, y]) => s + y, 0) / bin.length;
    ece += (bin.length / pairs.length) * Math.abs(conf - acc);
  }
  return { brier: round(brier), ece: round(ece) };
}

/**
 * The existing router's rule as a table: per slice, the cheapest model (by mean training cost)
 * whose training success rate meets the floor, else the baseline. `allowed` restricts the models.
 */
export function sliceRouterTable(train: readonly RouterExample[], floor: number, baselineModelId: string, allowed?: readonly string[]): { readonly [sliceId: string]: string } {
  const table: { [sliceId: string]: string } = {};
  const models = [...new Set(train.flatMap((e) => Object.keys(e.outcomes)))].filter((m) => allowed === undefined || allowed.includes(m));
  const meanCost = (m: string) => train.reduce((s, e) => s + (e.outcomes[m]?.costMicroUsd ?? 0), 0) / Math.max(1, train.length);
  const byCost = models.sort((a, b) => meanCost(a) - meanCost(b) || (a < b ? -1 : 1));
  for (const slice of [...new Set(train.map((e) => e.sliceId))].sort()) {
    const rows = train.filter((e) => e.sliceId === slice);
    const fits = byCost.find((m) => rows.filter((e) => e.outcomes[m]?.verified === true).length / rows.length >= floor);
    table[slice] = fits ?? baselineModelId;
  }
  return table;
}

/** Trains the per-model estimators on `train` and evaluates them on the separate `holdout`. */
export function trainLearnedRouter(train: readonly RouterExample[], holdout: readonly RouterExample[], options: TrainOptions): { readonly ok: true; readonly artifact: LearnedRouterArtifact } | TrainRefusal {
  const checked = check(train, options.baselineModelId);
  if (!checked.ok) return checked;
  const heldChecked = check(holdout, options.baselineModelId);
  if (!heldChecked.ok) return heldChecked;
  if (heldChecked.featureNames.join(',') !== checked.featureNames.join(',') || heldChecked.modelIds.join(',') !== checked.modelIds.join(',')) return { ok: false, reasonCode: 'FEATURES_INCONSISTENT', detail: 'holdout' };
  const trainIds = new Set(train.map((e) => e.taskId));
  if (holdout.some((e) => trainIds.has(e.taskId))) return { ok: false, reasonCode: 'INVALID_EXAMPLE', detail: 'holdout-overlaps-training' };
  const floor = Math.max(0, Math.min(1, options.qualityFloor));
  const names = checked.featureNames;
  const means = names.map((n) => train.reduce((s, e) => s + (e.features[n] ?? 0), 0) / train.length);
  const scales = names.map((n, i) => {
    const v = train.reduce((s, e) => s + ((e.features[n] ?? 0) - (means[i] ?? 0)) ** 2, 0) / train.length;
    return v > 1e-12 ? Math.sqrt(v) : 1;
  });
  const xs = train.map((e) => vector(e, names, means, scales));
  const epochs = Math.max(1, Math.min(5000, options.epochs ?? 400));
  const lr = options.learningRate ?? 0.3;
  const l2 = options.l2 ?? 0.01;
  const models: ModelWeights[] = checked.modelIds.map((modelId) => {
    let bias = 0;
    const w = names.map(() => 0);
    const ys = train.map((e) => (e.outcomes[modelId]?.verified === true ? 1 : 0));
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      let gb = 0;
      const gw = names.map(() => 0);
      xs.forEach((x, r) => {
        const err = sigmoid(bias + w.reduce((s, wi, i) => s + wi * (x[i] ?? 0), 0)) - (ys[r] ?? 0);
        gb += err;
        x.forEach((xi, i) => {
          gw[i] = (gw[i] ?? 0) + err * xi;
        });
      });
      bias -= (lr * gb) / train.length;
      for (let i = 0; i < w.length; i += 1) w[i] = (w[i] ?? 0) - lr * ((gw[i] ?? 0) / train.length + l2 * (w[i] ?? 0));
    }
    const meanCost = train.reduce((s, e) => s + (e.outcomes[modelId]?.costMicroUsd ?? 0), 0) / train.length;
    return { modelId, bias: round(bias), weights: w.map((x) => round(x)), meanCostMicroUsd: Math.round(meanCost) };
  });
  const routerTable = sliceRouterTable(train, floor, options.baselineModelId);
  const core = { featureNames: names, featureMeans: means.map((x) => round(x)), featureScales: scales.map((x) => round(x)), models };
  const learned = policyMetrics(holdout, (e) => choose(predictAll(core, e.features), models, floor));
  const baseline = policyMetrics(holdout, () => options.baselineModelId);
  const existingRouter = policyMetrics(holdout, (e) => routerTable[e.sliceId] ?? options.baselineModelId);
  const calibration = models.map((m) => ({ modelId: m.modelId, ...calibrationOf(holdout.map((e) => [predictAll(core, e.features).get(m.modelId) ?? 0, e.outcomes[m.modelId]?.verified === true ? 1 : 0] as const)) }));
  const improvesOnRouter = learned.regret < existingRouter.regret - 1e-9 || (learned.successRate >= existingRouter.successRate && learned.meanCostMicroUsd < existingRouter.meanCostMicroUsd);
  const body = {
    schemaVersion: LEARNED_ROUTER_SCHEMA,
    state: 'candidate' as const,
    trainedAt: options.trainedAt,
    datasetVersions: [...new Set(train.map((e) => e.datasetVersion))].sort(),
    trainingTasks: train.length,
    qualityFloor: floor,
    baselineModelId: options.baselineModelId,
    ...core,
    routerTable,
    holdout: { tasks: holdout.length, learned, baseline, existingRouter, calibration, improvesOnRouter },
  };
  return { ok: true, artifact: { ...body, id: `lr-${contentHash(body).slice(7, 31)}` } };
}

/** The owner's review of one artifact. Signed with a trusted calibration key. */
export interface LearnedRouterReview {
  readonly schemaVersion: typeof ROUTER_REVIEW_SCHEMA;
  readonly artifactId: string;
  readonly decision: 'approve' | 'reject';
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly signature?: unknown;
}

export type DeploymentCheck = { readonly deployable: true; readonly keyId: string } | { readonly deployable: false; readonly reasonCode: 'NOT_REVIEWED' | 'REVIEW_INVALID' | 'REVIEW_FOR_OTHER_ARTIFACT' | 'REVIEW_REJECTED' | 'REVIEW_SIGNATURE' | 'NO_HOLDOUT_IMPROVEMENT' };

/** Whether an artifact may be used for advice: a trusted signed approval of this artifact and a held-out gain. */
export function learnedRouterDeployable(artifact: LearnedRouterArtifact, review: unknown, trustedKeys: ReadonlyMap<string, string>): DeploymentCheck {
  if (review === null || review === undefined) return { deployable: false, reasonCode: 'NOT_REVIEWED' };
  const r = review as Partial<LearnedRouterReview>;
  if (typeof review !== 'object' || r.schemaVersion !== ROUTER_REVIEW_SCHEMA || typeof r.reviewer !== 'string' || typeof r.reviewedAt !== 'string' || !['approve', 'reject'].includes(String(r.decision))) return { deployable: false, reasonCode: 'REVIEW_INVALID' };
  if (r.artifactId !== artifact.id) return { deployable: false, reasonCode: 'REVIEW_FOR_OTHER_ARTIFACT' };
  const signed = verifyRecordSignature(review as { readonly [key: string]: unknown }, trustedKeys);
  if (!signed.ok) return { deployable: false, reasonCode: 'REVIEW_SIGNATURE' };
  if (r.decision !== 'approve') return { deployable: false, reasonCode: 'REVIEW_REJECTED' };
  if (!artifact.holdout.improvesOnRouter) return { deployable: false, reasonCode: 'NO_HOLDOUT_IMPROVEMENT' };
  return { deployable: true, keyId: signed.keyId };
}

export type LearnedRouteAdvice =
  | { readonly outcome: 'abstain'; readonly reasonCode: string; readonly applied: false }
  | { readonly outcome: 'recommend'; readonly modelId: string; readonly ranked: readonly { readonly modelId: string; readonly predictedSuccess: number; readonly meanCostMicroUsd: number }[]; readonly reasonCode: 'LEARNED_ROUTER'; readonly applied: false };

/** Advice from a deployable artifact only; an unreviewed one never routes. */
export function learnedRouteAdvice(artifact: LearnedRouterArtifact, review: unknown, trustedKeys: ReadonlyMap<string, string>, features: { readonly [name: string]: number }): LearnedRouteAdvice {
  const gate = learnedRouterDeployable(artifact, review, trustedKeys);
  if (!gate.deployable) return { outcome: 'abstain', reasonCode: gate.reasonCode, applied: false };
  const missing = artifact.featureNames.filter((n) => !Number.isFinite(features[n]));
  if (missing.length > 0) return { outcome: 'abstain', reasonCode: 'FEATURES_MISSING', applied: false };
  const predicted = predictAll(artifact, features);
  const ranked = artifact.models.map((m) => ({ modelId: m.modelId, predictedSuccess: round(predicted.get(m.modelId) ?? 0, 4), meanCostMicroUsd: m.meanCostMicroUsd })).sort((a, b) => b.predictedSuccess - a.predictedSuccess || (a.modelId < b.modelId ? -1 : 1));
  return { outcome: 'recommend', modelId: choose(predicted, artifact.models, artifact.qualityFloor), ranked, reasonCode: 'LEARNED_ROUTER', applied: false };
}

/** A seeded pseudo-random generator (mulberry32) for the synthetic dataset. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic routing dataset for demonstration: difficulty grows with context size, files
 * touched and failing tests; a stronger model succeeds on harder tasks and costs more. Labelled
 * `synthetic` in its consent id and dataset version so it is never mistaken for real outcomes.
 */
export function syntheticRoutingExamples(seed: number, count: number, models: readonly { readonly modelId: string; readonly skill: number; readonly costMicroUsd: number }[]): readonly RouterExample[] {
  const random = mulberry(seed);
  const out: RouterExample[] = [];
  for (let i = 0; i < Math.max(0, Math.min(100_000, count)); i += 1) {
    const contextK = Math.round(5 + random() * 195);
    const filesTouched = 1 + Math.floor(random() * 12);
    const failingTests = Math.floor(random() * 6);
    const python = random() < 0.6 ? 1 : 0;
    const difficulty = -5 + contextK / 50 + filesTouched / 3 + failingTests / 3 - python * 0.3 + (random() - 0.5) * 0.5;
    const outcomes: { [modelId: string]: ModelOutcome } = {};
    for (const m of models) outcomes[m.modelId] = { verified: random() < sigmoid(m.skill - difficulty), costMicroUsd: Math.round(m.costMicroUsd * (0.5 + contextK / 100)) };
    out.push({
      taskId: `syn-${String(seed)}-${String(i)}`,
      sliceId: python === 1 ? 'issue-fix:python' : 'issue-fix:other',
      consentId: 'synthetic',
      datasetVersion: `synthetic-${String(seed)}`,
      features: { contextK, filesTouched, failingTests, python },
      outcomes,
    });
  }
  return out;
}
