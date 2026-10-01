/**
 * Route learning in use (C16, C52, RTE-12, SSOT §18.5): routing starts on day 1 from a signed
 * baseline and keeps learning, per workspace, from deterministic outcomes Jevris already records.
 *
 * - Baseline. The day-1 baseline (published independent results plus the owner's seed run) ships
 *   as a signed calibration release whose interval method is `beta-posterior`. Each of its model
 *   qualities is a prior: the success rate as `point` and its strength as `sampleSize`
 *   pseudo-outcomes (at most `priorWeight`). The signed release is what authorizes day-1 routing,
 *   the SSOT's existing signed-calibration path; nothing local is needed first.
 * - Posterior. Every deterministic outcome updates a per-workspace Beta posterior per slice and
 *   model, seeded from the baseline prior (Beta(½ + rate·n, ½ + (1 − rate)·n) with n the prior's
 *   pseudo-outcomes). A weak prior (the 12-task seed) is overturned by a few local outcomes;
 *   with no baseline the prior is Beta(½, ½).
 * - Labels. An outcome is recorded only with a deterministic label source: a verification
 *   receipt, a revert, a retry, a stale result, a cancellation or a harness usage limit. A
 *   model's own judgement is never a label (LABEL_NOT_DETERMINISTIC). A revert or retry turns an
 *   earlier pass of the same route into a failure. Stale, cancelled and usage-limited routes are
 *   counted, never labelled a success or a failure.
 * - Activation. A low-risk slice routes a managed worker to a cheaper candidate when the posterior
 *   probability that the candidate is worse than the baseline model by more than the margin is
 *   below `activateBelow` (P(q_c < q_b − margin) < 0.10), and the candidate uses less of what the
 *   harness pays with (dollars on an API key, usage-limit consumption on a subscription). It can
 *   happen from the baseline alone on day 1, or as soon as local outcomes move the posterior.
 *   After any change of the slice, `flapFloor` new labelled outcomes on it are needed before it
 *   activates again. There is no minimum per arm and no route count.
 * - Demotion is fast and always automatic: the slice returns to the baseline model at once when
 *   the candidate's harm probability rises above `deactivateAbove`, when the recent window shows
 *   it confidently below the baseline by more than the margin, or when the candidate stops being
 *   eligible.
 * - Exploration. Only on a low-risk bounded-auto route, never on a pinned slice or with learning
 *   off, at a rate capped at 10% (default 5%), among the router's eligible models, weighted by
 *   each one's posterior probability of being within the margin (a model almost surely worse is
 *   never explored). The propensity is exact and logged with the outcome.
 * - Human control wins: a pin (to a model, or to advice only) is never changed by learning;
 *   `off` stops every switch in the workspace; every change is a new policy version with its
 *   reason and evidence, explainable (`explainSliceLearning`) and reversible (`resetLearning`,
 *   `pinSlice`, `unpinSlice`, `rollbackLearning`). Main-session routing stays advisory: only
 *   managed workers are switched.
 * - Storage. The learned state is a compact aggregate: policy versions and per-slice, per-model
 *   outcome counts and resource sums, plus a window of at most 30 days of outcome ids for
 *   reconciling reverts, retries, duplicates, the demotion window and usage-limit cooldowns. It
 *   holds ids, counts, costs and times, never workspace text. It is its own retention class
 *   (`route-learning`, B's ROUTE_LEARNING_RETENTION): the 7- and 30-day sweeps never touch it,
 *   and outcomes older than the window stay counted. Only `jevris data delete` and
 *   `jevris route learning reset --clear-evidence` remove it. Nothing leaves the machine.
 * - Arms are (model, effort) pairs (owner decision 2026-09-26: effort routing from day 1). An arm
 *   key is the model id for the model's default effort, and `model@effort` for any other level
 *   (`armKey`). The baseline arm is the baseline model at its default effort. Everything above
 *   (the Beta posterior, the margin, the thresholds, the flap floor, fast demotion, pins) applies
 *   per arm. An effort change on a model that keeps its cache across effort changes carries no
 *   cache-transition cost (`armTransitionCostMicroUsd`); a model change still does. A demotion
 *   returns the slice to the baseline model at its default effort.
 * - Upgrades. A costlier arm of the baseline model (a higher effort) is activated only when no
 *   cheaper arm is supported and the posterior probability that it is NOT better than the baseline
 *   is below `activateBelow`; it is demoted when that probability rises above `deactivateAbove`.
 *   Cheaper arms need only the non-inferiority test above.
 * - Resources by effort. With too few local observations, an arm's spend is priced from the
 *   signed baseline release's measured per-arm cost and tokens when it carries them (the seed),
 *   else from the documented order of effort levels (a lower level spends fewer tokens on the
 *   same model), else from the registry list price at a standard task.
 */
import { mkdir, open, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { contentHash, servingHostOf, type CalibrationArtifact, type ModelRegistry } from '@jevris/contracts';
import { durableWrite, jevrisPaths } from '@jevris/platform';
import { removeModelAvailability } from './model-availability.js';
import { removeAccessLimits } from './access-limits.js';
import { removeAccessUsageReadings } from './access-usage.js';
import { removeModelOffer } from './model-offer.js';
import { BUNDLED_MODEL_REGISTRY, effortSwitchKeepsCache, generationCostMicroUsd, lifecycleCheck, registryModel, routeBaseline, type CacheTtl, type TokenVolume } from './model-registry.js';
import type { QualityEstimate } from './router.js';
import { servingTariff } from './serving-tariff.js';
import { effortTransitionCostMicroUsd, transitionCostMicroUsd } from './route-switch.js';

export const ROUTE_LEARNING_SCHEMA = 'jevris-route-learning-2' as const;
const ROUTE_LEARNING_SCHEMA_V1 = 'jevris-route-learning-1';

/** Hard limits the settings can never exceed. */
export const LEARNING_LIMITS = Object.freeze({
  /** Exploration is never above 10% of eligible routes. */
  explorationCap: 0.1,
  /** The margin can never be looser than 10 percentage points. */
  marginCap: 0.1,
  /** Activation never accepts more than a 25% posterior probability of harm. */
  activateBelowCap: 0.25,
  /** A baseline prior never counts for more than 100 pseudo-outcomes. */
  priorWeightCap: 100,
  /** The raw reconciliation window: at most 30 days and at most this many events. */
  windowDays: 30,
  maxEvents: 5000,
  maxVersions: 200,
  maxProposals: 50,
});

export interface LearningSettings {
  /** `false` (`jevris route learning off`): no managed-worker switch and no exploration in this workspace. Default true. */
  readonly enabled: boolean;
  /** Share of eligible low-risk bounded-auto routes that explore once a slice has switched. Default 0.05, capped at 0.10. */
  readonly explorationRate: number;
  /**
   * Share that explores while a slice is advise-only (never switched, or demoted). Default 0.10,
   * the cap (owner 2026-09-26, DOMAINS 223a21f). 0 when `explorationRate` is 0 (exploration off).
   */
  readonly adviseExplorationRate: number;
  /**
   * The pre-registered minimum of this workspace's own randomized, labelled outcomes on BOTH the
   * candidate arm and the default arm before a slice may switch (§18.5's number per arm; owner
   * 2026-09-26, DOMAINS 223a21f). Neither a baseline nor the machine prior switches a slice alone.
   * It can be raised, never lowered below the locked value.
   */
  readonly minLocalPerArm: number;
  /** Non-inferiority margin on the verified-success rate. Default 0.075 (owner 2026-09-26). */
  readonly nonInferiorityMargin: number;
  /** A slice activates a candidate when P(candidate worse by more than the margin) is below this. Default 0.10. */
  readonly activateBelow: number;
  /** An active candidate is demoted when that probability rises above this. Default 0.40. */
  readonly deactivateAbove: number;
  /** Labelled local outcomes on a slice, after any change of it, before it activates again. Default 5. */
  readonly flapFloor: number;
  /** Recent labelled outcomes of an active candidate checked for regression. Default 20 (at least 10). */
  readonly demotionWindow: number;
  /** `automatic` (default): the posterior activates a slice at once; `review`: a proposal the user accepts. */
  readonly promotionMode: 'review' | 'automatic';
  /** The most pseudo-outcomes one baseline prior counts for. Default 30. */
  readonly priorWeight: number;
  /** Local slice id to a bundled public prior's slice (`terminal`, `issue-fix`), for advice estimates. */
  readonly priorSlices: { readonly [sliceId: string]: string };
  /** Subscription scarcity per model (default 1): how much one token of its usage limit is worth. */
  readonly quotaWeights: { readonly [modelId: string]: number };
  /** How long a usage-limit hit without a reported reset time blocks the model. Default 5 hours. */
  readonly limitCooldownHours: number;
  /** A model with a usage-limit hit this recent is near its limit and never explored. Default 24 hours. */
  readonly nearLimitHours: number;
  /**
   * The effort levels explored on the baseline model besides its default (owner 2026-09-26:
   * `low` and `high` beside Opus 5.5's `medium`). Other models are explored at their default.
   */
  readonly effortArms: readonly EffortLevel[];
}

/** The locked minimum of local randomized, labelled outcomes per arm before a switch (see `LearningSettings.minLocalPerArm`). */
export const MIN_LOCAL_PER_ARM = 12;

/**
 * The most pseudo-outcomes the machine-wide prior (the other workspaces on this machine) counts
 * for per arm, however much history they hold (owner decision 2026-09-27, DOMAINS 43990b1: equal
 * to `MIN_LOCAL_PER_ARM`). Locked: no setting changes it; only a release raises or lowers it. A
 * signed baseline's prior keeps its own cap, `priorWeight` (30).
 */
export const MACHINE_PRIOR_WEIGHT = 12;

/** The effort levels, lowest first (the vendor's effort page; a lower level spends fewer tokens). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_LEARNING_SETTINGS: LearningSettings = Object.freeze({
  enabled: true,
  explorationRate: 0.05,
  adviseExplorationRate: 0.1,
  minLocalPerArm: MIN_LOCAL_PER_ARM,
  nonInferiorityMargin: 0.075,
  activateBelow: 0.1,
  deactivateAbove: 0.4,
  flapFloor: 5,
  demotionWindow: 20,
  promotionMode: 'automatic' as const,
  priorWeight: 30,
  priorSlices: Object.freeze({}),
  quotaWeights: Object.freeze({}),
  limitCooldownHours: 5,
  nearLimitHours: 24,
  effortArms: Object.freeze(['low', 'high'] as const),
});

/** One published result used for advice estimates. Rates are per trial on the named benchmark. */
export interface PublicPrior {
  readonly priorSliceId: string;
  readonly modelId: string;
  readonly effort: string;
  readonly successRate: number;
  readonly trials: number;
  readonly benchmark: string;
  readonly harness: string;
  readonly sourceId: string;
  readonly url: string;
  readonly publishedOn: string;
  readonly fetchedOn: string;
  /**
   * The board operator published it with its trial count (not a vendor-reported result). Only
   * such a row may qualify a candidate for exploration (public-priors.ts, SPEC §8.3).
   */
  readonly independent?: boolean;
}

/**
 * Published independent results, fetched 2026-09-26. No public SWE-bench-Live row exists yet for
 * Opus 5.5, Opus 5, Sonnet 5 or Fable 5.1, and no public Opus 5.5 row at medium effort: those are
 * what the owner's seed run measures. The signed baseline release is built from these and the seed.
 */
export const BUNDLED_PUBLIC_PRIORS: readonly PublicPrior[] = Object.freeze([
  { priorSliceId: 'terminal', modelId: 'claude-opus-5-5', effort: 'max', successRate: 0.6313, trials: 198, benchmark: 'terminal-bench@4.0 (AA index component)', harness: 'claude-code', sourceId: 'AA-CAI', url: 'https://artificialanalysis.ai/agents/coding-agents', publishedOn: '2026-09-26', fetchedOn: '2026-09-26', independent: true },
  { priorSliceId: 'issue-fix', modelId: 'claude-opus-5-5', effort: 'max', successRate: 0.6844, trials: 339, benchmark: 'deep-swe@1.1 (AA index component)', harness: 'claude-code', sourceId: 'AA-CAI', url: 'https://artificialanalysis.ai/agents/coding-agents', publishedOn: '2026-09-26', fetchedOn: '2026-09-26', independent: true },
  { priorSliceId: 'terminal', modelId: 'claude-opus-5', effort: 'medium', successRate: 0.4485, trials: 330, benchmark: 'terminal-bench@4.0', harness: 'claude-code', sourceId: 'TB4-LB', url: 'https://www.tbench.ai/leaderboard', publishedOn: '2026-07-24', fetchedOn: '2026-09-26', independent: true },
  { priorSliceId: 'issue-fix', modelId: 'claude-opus-5', effort: 'max', successRate: 0.6254, trials: 339, benchmark: 'deep-swe@1.1 (AA index component)', harness: 'claude-code', sourceId: 'AA-CAI', url: 'https://artificialanalysis.ai/agents/coding-agents', publishedOn: '2026-09-26', fetchedOn: '2026-09-26', independent: true },
  { priorSliceId: 'terminal', modelId: 'claude-fable-5-1', effort: 'medium', successRate: 0.5394, trials: 330, benchmark: 'terminal-bench@4.0', harness: 'claude-code', sourceId: 'TB4-LB', url: 'https://www.tbench.ai/leaderboard', publishedOn: '2026-09-01', fetchedOn: '2026-09-26', independent: true },
  { priorSliceId: 'issue-fix', modelId: 'claude-fable-5-1', effort: 'max', successRate: 0.6431, trials: 339, benchmark: 'deep-swe@1.1 (AA index component)', harness: 'claude-code', sourceId: 'AA-CAI', url: 'https://artificialanalysis.ai/agents/coding-agents', publishedOn: '2026-09-26', fetchedOn: '2026-09-26', independent: true },
  { priorSliceId: 'terminal', modelId: 'claude-sonnet-5', effort: 'max', successRate: 0.1242, trials: 330, benchmark: 'terminal-bench@4.0', harness: 'claude-code', sourceId: 'TB4-LB', url: 'https://www.tbench.ai/leaderboard', publishedOn: '2026-06-30', fetchedOn: '2026-09-26', independent: true },
]);

/** Where shipped core data names a model (the release gate's rule (a), DOMAINS 9d1e7eb). */
export interface ShippedModelReference {
  readonly modelId: string;
  /** `baseline`: the bundled registry's approved default and baseline; `priors`: BUNDLED_PUBLIC_PRIORS (with its effort arm). */
  readonly where: 'baseline' | 'priors';
  readonly effort: string | null;
  readonly detail: string;
}

/**
 * Every model id that shipped core data names, for the release gate. The seed run's arms live in
 * @jevris/evals (seed-run.ts) and the signed baseline release in assets/calibration; their owners
 * read those.
 */
export function shippedModelReferences(registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): readonly ShippedModelReference[] {
  return [
    { modelId: registry.baselineModelId, where: 'baseline', effort: null, detail: `model registry ${registry.snapshotId} baselineModelId` },
    ...(registry.harnessDefaults ?? []).filter((d) => d.baselineModelId !== registry.baselineModelId).map((d) => ({ modelId: d.baselineModelId, where: 'baseline' as const, effort: null, detail: `model registry ${registry.snapshotId} harnessDefaults ${d.harness}` })),
    ...BUNDLED_PUBLIC_PRIORS.map((p) => ({ modelId: p.modelId, where: 'priors' as const, effort: p.effort, detail: `BUNDLED_PUBLIC_PRIORS ${p.priorSliceId} (${p.sourceId})` })),
  ];
}

/**
 * The deterministic outcomes of a route (SPEC §18.5, amended 2026-09-27). `run-incomplete` is an
 * owned run that ended with no verification receipt (failed, timed out, hit its turn or budget
 * limit, was refused, or broke a path rule): a failure. A usage limit, a cancel or a kill switch is
 * not one.
 */
export const OUTCOME_KINDS = ['verified-pass', 'verified-fail', 'reverted', 'retried', 'stale', 'cancelled', 'usage-limited', 'run-incomplete'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
export const LABEL_SOURCES = ['verification-receipt', 'revert', 'retry', 'stale-result', 'cancellation', 'harness-limit', 'run-incomplete'] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];
/** The one deterministic label source of each outcome kind; an event whose source differs is refused. */
export const LABEL_SOURCE_OF: { readonly [K in OutcomeKind]: LabelSource } = Object.freeze({
  'verified-pass': 'verification-receipt',
  'verified-fail': 'verification-receipt',
  reverted: 'revert',
  retried: 'retry',
  stale: 'stale-result',
  cancelled: 'cancellation',
  'usage-limited': 'harness-limit',
  'run-incomplete': 'run-incomplete',
});

/** How the harness that ran the route is billed (F detects it, D records it per worker run). */
export const AUTH_MODES = ['api-key', 'subscription', 'unknown'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type RouteRisk = 'low' | 'medium' | 'high' | 'unknown';

/** One deterministic outcome of one route. Ids, counts and times only; never workspace text. */
export interface RouteOutcomeEvent {
  readonly eventId: string;
  readonly routeId: string;
  readonly sliceId: string;
  /** The model that actually ran (the observed model, RTE-11). */
  readonly modelId: string;
  /** What the rules-only policy chose for the same route (arm C), or null when it abstained. */
  readonly rulesModelId: string | null;
  readonly policyVersion: number;
  readonly kind: OutcomeKind;
  readonly labelSource: LabelSource;
  /** The verification receipt id; required for a verified outcome. */
  readonly receiptId: string | null;
  /** True when the model was chosen by exploration. */
  readonly explored: boolean;
  /** Probability the logged policy gave this model; null when the route was not in the randomized pool. */
  readonly propensity: number | null;
  readonly risk: RouteRisk;
  readonly costMicroUsd: number | null;
  readonly latencyMs: number | null;
  readonly at: string;
  /** API key (real dollars) or subscription (usage-limit consumption). Default `unknown`. */
  readonly authMode?: AuthMode;
  /** Total tokens the route used (input, output and cache), for usage-limit consumption. */
  readonly tokens?: number | null;
  /** For `usage-limited`: when the harness says the limit resets, if it said. Kept for the record; never read for a pause once `accessLimited`. */
  readonly limitResetAt?: string | null;
  /**
   * For `usage-limited`: true when the caller recorded the limit in the machine's access-limits
   * record (access-limits.ts, R70). Such a hit is only the neutral learning outcome: the legacy
   * model-only reader (`usageLimitStatus`) and the machine contribution's `limits` skip it (R61).
   */
  readonly accessLimited?: boolean;
  /** The effort the worker was launched with; null or absent is the model's default. */
  readonly effort?: string | null;
  /**
   * The route's usage priced at the registry's list tariff (`apiEquivalentCostMicroUsd`): what it
   * would have cost on an API key. D sets it on a subscription, where `costMicroUsd` is null; on a
   * key the billed cost stands for it. Null or absent: unknown.
   */
  readonly apiEquivalentMicroUsd?: number | null;
  /**
   * Serving hosts R49 (design 6.4): the serving host the route ran through (a maker id, or a
   * pinned gateway or host), from the resolver. Absent in older records: read as no host. The arm
   * key stays per model (OQ-5); the host only prices the list-price comparison.
   */
  readonly servingHost?: string;
}

/**
 * - `advise`: managed workers keep the baseline model (explicit after a demotion or a pinned
 *   advice; implicit for a slice never set).
 * - `auto`: managed workers route to `modelId` (the active candidate) under the router's gates.
 * - `pinned`: a person fixed the slice; learning never changes it.
 */
export type SliceMode = 'advise' | 'auto' | 'pinned';

export interface SlicePolicy {
  readonly mode: SliceMode;
  /** The active or pinned model; null in advise (the baseline stands) or a pin to advice only. */
  readonly modelId: string | null;
  /** The active or pinned effort; absent or null is the model's default effort. */
  readonly effort?: string | null;
  /** `upgrade`: a costlier arm activated because it is probably better. Absent: a cheaper arm. */
  readonly direction?: 'saving' | 'upgrade';
  /** The baseline model the candidate was measured against. */
  readonly baselineModelId: string | null;
  /** The baseline's posterior mean success when activated, for explanations. */
  readonly baselineRate: number | null;
}

export const POLICY_CHANGE_REASONS = ['bundled-default', 'baseline', 'promotion', 'accepted-proposal', 'demotion', 'reset', 'pin', 'unpin', 'rollback'] as const;
export type PolicyChangeReason = (typeof POLICY_CHANGE_REASONS)[number];

export interface PolicyVersion {
  readonly version: number;
  readonly parentVersion: number | null;
  readonly createdAt: string;
  readonly reason: PolicyChangeReason;
  readonly reasonCode: string;
  readonly sliceId: string | null;
  readonly slices: { readonly [sliceId: string]: SlicePolicy };
  readonly evidence: PromotionEvidence | null;
}

/** The compact, text-free per-slice, per-model aggregate. It outlives the raw window. */
export interface ArmAggregate {
  readonly successes: number;
  readonly failures: number;
  readonly staleOrCancelled: number;
  readonly usageLimited: number;
  readonly routes: number;
  readonly costSumMicroUsd: number;
  readonly costCount: number;
  readonly tokensSum: number;
  readonly tokensCount: number;
  readonly latencySumMs: number;
  readonly latencyCount: number;
  /**
   * Billed dollars where known, else the API-equivalent estimate (the economics on a subscription).
   * A state written before these existed reads them as the billed cost.
   */
  readonly equivalentSumMicroUsd: number;
  readonly equivalentCount: number;
  /** Labelled routes whose model was drawn by the logged randomized policy (low risk, with a propensity): the guard's count. */
  readonly randomizedLabelled: number;
  readonly firstAt: string;
  readonly lastAt: string;
}

export interface ArmStats {
  /** The arm key (`armKey`): the model id, or `model@effort` away from its default effort. */
  readonly armId: string;
  readonly modelId: string;
  /** Null: the model's default effort. */
  readonly effort: string | null;
  readonly labelled: number;
  readonly successes: number;
  readonly rate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly staleOrCancelled: number;
  readonly meanCostMicroUsd: number | null;
  /** Median latency over the recent window; null when the window has none. */
  readonly medianLatencyMs: number | null;
  readonly meanLatencyMs?: number | null;
  readonly usageLimited: number;
  readonly meanTokens: number | null;
  /** Mean tokens times the model's quota weight: subscription usage-limit consumption per route. */
  readonly meanWeightedUsage: number | null;
  /** Routes counted on this arm (labelled or not): the spend behind each verified task. */
  readonly routes?: number;
  /**
   * The economics per verified task (§22.2 in use): the arm's spend over every route it ran, retries
   * and failures included, divided by its verified successes. Null with no verified success or no
   * observation of that resource. Billed dollars (API key); dollars with the API-equivalent
   * estimate standing in for unbilled routes (subscription); tokens; quota-weighted tokens; wall time.
   */
  readonly costPerVerifiedMicroUsd?: number | null;
  readonly apiEquivalentPerVerifiedMicroUsd?: number | null;
  readonly tokensPerVerified?: number | null;
  readonly usagePerVerified?: number | null;
  readonly wallMsPerVerified?: number | null;
}

export interface PromotionEvidence {
  readonly sliceId: string;
  readonly candidate: ArmStats;
  readonly baseline: ArmStats;
  /** About the one-sided 90% lower bound of candidate minus baseline success, from the posterior. */
  readonly differenceLower: number | null;
  readonly margin: number;
  /** The flap floor in force (version 1 evidence carried the minimum per arm here). */
  readonly minPerArm: number;
  readonly eventCount: number;
  /** What the resource check compared: dollars (`api-key`), usage-limit consumption (`subscription`) or both (`unknown`). */
  readonly objective?: AuthMode;
  /** P(candidate worse than the baseline by more than the margin) under the posterior. */
  readonly harmProbability?: number;
  readonly candidatePosterior?: ArmPosterior;
  readonly baselinePosterior?: ArmPosterior;
  /** `upgrade`: the candidate costs more and was weighed on P(not better than the baseline). */
  readonly direction?: 'saving' | 'upgrade';
  /** For an upgrade: P(the candidate is not better than the baseline) under the posterior. */
  readonly notBetterProbability?: number;
  /** Where the resource comparison came from: local observations, the release's measured arms, the effort order, or list prices. */
  readonly resourceBasis?: 'local' | 'machine' | 'measured' | 'effort-order' | 'list-price';
  /**
   * R9 (OD-5): the candidate and the baseline come from different vendors, so their subscription
   * usage sits in different pools and is not compared; `objective` is `api-key` and the dollars
   * are API-equivalent, an estimate, not what either subscription bills.
   */
  readonly crossVendor?: true;
}

export interface LearningProposal {
  readonly proposalId: string;
  readonly sliceId: string;
  readonly modelId: string;
  /** The proposed effort; absent or null is the model's default. */
  readonly effort?: string | null;
  readonly direction?: 'saving' | 'upgrade';
  readonly baselineModelId: string;
  readonly createdAt: string;
  readonly basedOnVersion: number;
  readonly evidence: PromotionEvidence;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded';
}

/** One model's baseline prior on one slice, from the signed baseline release. */
export interface BaselinePrior {
  readonly sliceId: string;
  readonly modelId: string;
  /** The effort the prior was measured at; absent or null is the model's default. */
  readonly effort?: string | null;
  /** Measured API-equivalent cost per task at this arm (the seed), when the release carries it. */
  readonly meanCostMicroUsd?: number | null;
  /** Measured tokens per task at this arm (the seed), when the release carries it. */
  readonly meanTokens?: number | null;
  readonly rate: number;
  /** Pseudo-outcomes the prior counts for (the real sample size, at most `priorWeight`). */
  readonly pseudoCount: number;
  /** The real sample size behind the prior. */
  readonly sampleSize: number;
  readonly sourceId: string;
}

/** The baseline a slice was last routed with: the signed release's id and its priors. */
export interface SliceBaseline {
  readonly releaseId: string;
  readonly priors: readonly BaselinePrior[];
}

export interface LearningState {
  readonly schemaVersion: typeof ROUTE_LEARNING_SCHEMA;
  readonly workspaceId: string;
  readonly settings: LearningSettings;
  readonly versions: readonly PolicyVersion[];
  /** Per slice, per model: the compact aggregate. */
  readonly arms: { readonly [sliceId: string]: { readonly [modelId: string]: ArmAggregate } };
  /** Per slice: the baseline priors in use, snapshotted from the signed release at route time. */
  readonly baseline: { readonly [sliceId: string]: SliceBaseline };
  /** The raw reconciliation window: at most 30 days and `maxEvents` events. */
  readonly events: readonly RouteOutcomeEvent[];
  readonly proposals: readonly LearningProposal[];
  /**
   * What this workspace has contributed to the machine-wide layer (§18.5 as amended, 5c29643):
   * text-free sums per shared slice and arm, and its usage-limit hits per model. Written to
   * `machine/<token>.json`; the token is random, never derived from the workspace.
   */
  readonly machine?: MachineContribution;
  /**
   * In memory only (never saved): the other workspaces' contributions on this machine, summed.
   * Attached by `loadLearningState`, `learnFromOutcome` and `reconcileLearning`.
   */
  readonly machinePrior?: MachinePrior;
}

/** Text-free sums for one shared slice and arm: the counts and resource sums of `ArmAggregate`, no times. */
export type MachineArm = Omit<ArmAggregate, 'firstAt' | 'lastAt' | 'randomizedLabelled'>;

/** A model's usage-limit state as a workspace saw it: the latest reset and the latest hit. */
export interface MachineLimit {
  readonly resetAt: string;
  readonly lastHitAt: string;
}

export interface MachineContribution {
  readonly token: string;
  readonly generation: string;
  readonly arms: { readonly [sharedSliceId: string]: { readonly [armId: string]: MachineArm } };
  readonly limits: { readonly [modelId: string]: MachineLimit };
}

/** The machine-wide prior a workspace sees: every other workspace's contribution of the current generation, summed. */
export interface MachinePrior {
  readonly generation: string;
  readonly contributors: number;
  readonly arms: { readonly [sharedSliceId: string]: { readonly [armId: string]: MachineArm } };
  readonly limits: { readonly [modelId: string]: MachineLimit };
}

/**
 * The general task slices whose learning is shared across the workspaces on this machine. A
 * slice outside this list is shared only when `priorSlices` maps it to one of these; otherwise
 * its learning stays in its workspace, so no project word ever reaches the shared layer.
 */
export const SHARED_SLICE_IDS = Object.freeze(['bounded-edit', 'issue-fix', 'terminal', 'test-fix', 'refactor', 'feature', 'docs', 'review', 'research', 'debug', 'migration'] as const);
const SHARED_SLICES: ReadonlySet<string> = new Set(SHARED_SLICE_IDS);

/** The shared slice a local slice pools under, or null when it stays in its workspace. A learning key pools as its slice. */
export function sharedSliceOf(settings: Pick<LearningSettings, 'priorSlices'>, sliceId: string): string | null {
  const base = baseSliceOf(sliceId);
  const mapped = settings.priorSlices[base];
  if (mapped !== undefined) return SHARED_SLICES.has(mapped) ? mapped : null;
  return SHARED_SLICES.has(base) ? base : null;
}

/** Separates a slice from its baseline in a learning key (R17). */
export const LEARNING_KEY_SEPARATOR = '::';

/**
 * R17 (owner decision OD-3): the key a slice learns under. Each route baseline learns apart, so a
 * slice routed from Claude Code (Opus 5.5), Codex (GPT-6.1 Sol) and Antigravity (Gemini 3.8 Flash),
 * or for tasks with different approved models, never demotes on BASELINE_CHANGED: every arm is
 * compared with its own route's default. The registry's own baseline keeps the bare slice id, so
 * existing learning state stays where it is; any other baseline is `<slice>::<baseline model>`.
 * A key already qualified, or one that would not be a valid id, is returned as given.
 */
export function learningSliceKey(sliceId: string, baselineModelId: string, registry: Pick<ModelRegistry, 'baselineModelId'> = BUNDLED_MODEL_REGISTRY): string {
  if (sliceId.includes(LEARNING_KEY_SEPARATOR) || baselineModelId === registry.baselineModelId) return sliceId;
  const key = `${sliceId}${LEARNING_KEY_SEPARATOR}${baselineModelId}`;
  return ID.test(key) ? key : sliceId;
}

/** The task slice of a learning key (the key itself when it names no baseline). */
export function baseSliceOf(key: string): string {
  const at = key.indexOf(LEARNING_KEY_SEPARATOR);
  return at < 0 ? key : key.slice(0, at);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** An arm key: a model id, or `model@effort`. */
const ARM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(@(low|medium|high|xhigh|max))?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DAY_MS = 86_400_000;
/** The task size list prices are compared at when local resource data is short (a bounded edit). */
const STANDARD_TASK = Object.freeze({ inputTokens: 400_000, outputTokens: 40_000 });

/**
 * Randomized outcomes per arm for a frequentist non-inferiority test at `margin` (one-sided 95%,
 * power about 50%) when both arms succeed at `rate`: 2·z²·p(1−p)/m². Kept for comparison: the
 * posterior design needs no fixed count.
 */
export function requiredPerArm(margin: number, rate = 0.75, z = 1.644854): number {
  if (!(margin > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil((2 * z * z * rate * (1 - rate)) / (margin * margin));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Settings with every hard limit applied. Unknown or invalid values take the default. */
export function learningSettings(input: Partial<LearningSettings> = {}): LearningSettings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const d = DEFAULT_LEARNING_SETTINGS;
  const priorSlices: { [sliceId: string]: string } = {};
  for (const [k, v] of Object.entries(input.priorSlices ?? {})) if (ID.test(k) && typeof v === 'string' && ID.test(v)) priorSlices[k] = v;
  const quotaWeights: { [modelId: string]: number } = {};
  for (const [k, v] of Object.entries(input.quotaWeights ?? {})) if (ID.test(k) && typeof v === 'number' && v > 0 && v <= 100) quotaWeights[k] = v;
  const activateBelow = clamp(num(input.activateBelow, d.activateBelow), 0.01, LEARNING_LIMITS.activateBelowCap);
  const flapFloor = clamp(Math.floor(num(input.flapFloor, d.flapFloor)), 1, 50);
  return {
    enabled: input.enabled !== false,
    explorationRate: clamp(num(input.explorationRate, d.explorationRate), 0, LEARNING_LIMITS.explorationCap),
    adviseExplorationRate: clamp(num(input.adviseExplorationRate, d.adviseExplorationRate), 0, LEARNING_LIMITS.explorationCap),
    minLocalPerArm: clamp(Math.floor(num(input.minLocalPerArm, d.minLocalPerArm)), MIN_LOCAL_PER_ARM, 200),
    nonInferiorityMargin: clamp(num(input.nonInferiorityMargin, d.nonInferiorityMargin), 0, LEARNING_LIMITS.marginCap),
    activateBelow,
    deactivateAbove: clamp(num(input.deactivateAbove, d.deactivateAbove), activateBelow, 0.5),
    flapFloor,
    demotionWindow: clamp(Math.floor(num(input.demotionWindow, d.demotionWindow)), 10, 200),
    promotionMode: input.promotionMode === 'review' ? 'review' : 'automatic',
    priorWeight: clamp(num(input.priorWeight, d.priorWeight), 0, LEARNING_LIMITS.priorWeightCap),
    priorSlices,
    quotaWeights,
    limitCooldownHours: clamp(num(input.limitCooldownHours, d.limitCooldownHours), 0.25, 24 * 7),
    nearLimitHours: clamp(num(input.nearLimitHours, d.nearLimitHours), 0, 24 * 7),
    effortArms: Array.isArray(input.effortArms) ? EFFORT_LEVELS.filter((e) => (input.effortArms as readonly unknown[]).includes(e)) : d.effortArms,
  };
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

/** True for a known effort level. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_SET.has(value);
}

/** The model's default effort in the registry (the bundled one by default); null when unknown or none. */
export function defaultEffortOf(modelId: string, registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): string | null {
  return registryModel(registry, modelId)?.defaultEffort ?? null;
}

/**
 * The arm key for a model at an effort: the model id at its default effort (or with no effort
 * given), `model@effort` at any other level. So an arm at the default effort and the bare model
 * are one arm, and state written before effort arms keeps its meaning.
 */
export function armKey(modelId: string, effort: string | null | undefined, registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): string {
  if (effort === null || effort === undefined || effort === defaultEffortOf(modelId, registry)) return modelId;
  return `${modelId}@${effort}`;
}

/** The model and effort of an arm key; effort null is the model's default. */
export function parseArmKey(key: string): { readonly modelId: string; readonly effort: EffortLevel | null } {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { modelId: key, effort: null };
  const effort = key.slice(at + 1);
  return isEffortLevel(effort) ? { modelId: key.slice(0, at), effort } : { modelId: key, effort: null };
}

/** An effort's rank (0 lowest); the model's default when null. Null when neither is known. */
function effortRank(modelId: string, effort: string | null, registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): number | null {
  const level = effort ?? defaultEffortOf(modelId, registry);
  const rank = level === null ? -1 : EFFORT_LEVELS.indexOf(level as EffortLevel);
  return rank < 0 ? null : rank;
}

/** True when the registry lists the effort for the model (or the effort is the default, or no registry is given). */
function effortSupported(modelId: string, effort: string | null, registry: ModelRegistry | undefined): boolean {
  if (effort === null || registry === undefined) return true;
  const model = registryModel(registry, modelId);
  return model === null ? false : (model.effortLevels ?? []).includes(effort);
}

/** True only when the registry (the bundled one by default) lists the effort for the model. */
function effortListed(modelId: string, effort: string, registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): boolean {
  return (registryModel(registry, modelId)?.effortLevels ?? []).includes(effort);
}

/**
 * The cache-transition cost of moving a warm prefix from one arm to another, micro-USD. The same
 * arm costs nothing. An effort change on the same model costs nothing when the model keeps its
 * cache across effort changes on this platform (per-message effort: Opus 5.5, Opus 5, Fable 5.1
 * on the Claude API), and is otherwise a rewrite of the prefix on that model. A model change is
 * `transitionCostMicroUsd` (a model's cache is its own).
 */
export function armTransitionCostMicroUsd(input: {
  readonly registry: ModelRegistry;
  readonly from: { readonly modelId: string; readonly effort: string | null };
  readonly to: { readonly modelId: string; readonly effort: string | null };
  readonly warmPrefixTokens: number;
  readonly cacheWarm: boolean;
  readonly cacheTtl?: CacheTtl;
  /** Where the session runs (`claude-api` for the Anthropic-operated platforms). Required: no Claude default. */
  readonly platform: string;
}): number | null {
  const from = registryModel(input.registry, input.from.modelId);
  const to = registryModel(input.registry, input.to.modelId);
  if (from === null || to === null) return null;
  if (input.from.modelId === input.to.modelId) {
    if (armKey(input.from.modelId, input.from.effort, input.registry) === armKey(input.to.modelId, input.to.effort, input.registry)) return 0;
    return effortTransitionCostMicroUsd({ model: to, warmPrefixTokens: input.warmPrefixTokens, cacheWarm: input.cacheWarm, ...(input.cacheTtl === undefined ? {} : { cacheTtl: input.cacheTtl }), platform: input.platform });
  }
  return transitionCostMicroUsd({ from, to, warmPrefixTokens: input.warmPrefixTokens, cacheWarm: input.cacheWarm, ...(input.cacheTtl === undefined ? {} : { cacheTtl: input.cacheTtl }) });
}

/** True when an effort change on this model keeps its cache (no transition cost). */
export function effortChangeKeepsCache(modelId: string, registry: ModelRegistry, platform: string): boolean {
  const model = registryModel(registry, modelId);
  return model !== null && effortSwitchKeepsCache(model, platform);
}

/** A new workspace state: version 0 is the bundled default (the signed baseline decides each slice). */
export function emptyLearningState(input: { readonly workspaceId: string; readonly now: string; readonly settings?: Partial<LearningSettings> }): LearningState {
  if (!ID.test(input.workspaceId)) throw new Error('workspaceId is not a valid id');
  return {
    schemaVersion: ROUTE_LEARNING_SCHEMA,
    workspaceId: input.workspaceId,
    settings: learningSettings(input.settings),
    versions: [{ version: 0, parentVersion: null, createdAt: input.now, reason: 'bundled-default', reasonCode: 'ADVISE_ONLY_DEFAULT', sliceId: null, slices: {}, evidence: null }],
    arms: {},
    baseline: {},
    events: [],
    proposals: [],
  };
}

export function activeVersion(state: LearningState): PolicyVersion {
  return state.versions[state.versions.length - 1] as PolicyVersion;
}

const IMPLICIT_ADVISE: SlicePolicy = Object.freeze({ mode: 'advise', modelId: null, baselineModelId: null, baselineRate: null });

/** The slice's current policy; a slice never set is advise until the baseline or the posterior activates it. */
export function slicePolicy(state: LearningState, sliceId: string): SlicePolicy {
  const slices = activeVersion(state).slices;
  const own = slices[sliceId];
  if (own !== undefined) return own;
  // A person's pin on the slice holds for every baseline it learns under (R17).
  const base = baseSliceOf(sliceId);
  const pinned = base === sliceId ? undefined : slices[base];
  return pinned?.mode === 'pinned' ? pinned : IMPLICIT_ADVISE;
}

/** True when the slice's policy was set explicitly (a demotion, a pin, an activation). */
function sliceSet(state: LearningState, sliceId: string): boolean {
  return activeVersion(state).slices[sliceId] !== undefined;
}

function withVersion(state: LearningState, change: Omit<PolicyVersion, 'version' | 'parentVersion'>): LearningState {
  const parent = activeVersion(state);
  const next: PolicyVersion = { ...change, version: parent.version + 1, parentVersion: parent.version };
  const versions = [...state.versions, next];
  // Keep version 0 (the bundled default) and the most recent history.
  const trimmed = versions.length > LEARNING_LIMITS.maxVersions ? [versions[0] as PolicyVersion, ...versions.slice(versions.length - LEARNING_LIMITS.maxVersions + 1)] : versions;
  return { ...state, versions: trimmed };
}

/** `null` removes the slice's entry (back to the baseline's say); an explicit advise is kept. */
function setSlice(slices: { readonly [sliceId: string]: SlicePolicy }, sliceId: string, policy: SlicePolicy | null): { readonly [sliceId: string]: SlicePolicy } {
  const out: { [sliceId: string]: SlicePolicy } = { ...slices };
  if (policy === null) delete out[sliceId];
  else out[sliceId] = policy;
  return out;
}

export type RecordRefusal = { readonly ok: false; readonly reasonCode: 'INVALID_EVENT' | 'LABEL_NOT_DETERMINISTIC' | 'RECEIPT_MISSING' | 'DUPLICATE_EVENT' | 'EVENT_EXPIRED' | 'ROUTE_UNKNOWN'; readonly detail?: string };

/** Validates one event and returns the clean copy (only the known fields). */
function cleanEvent(event: RouteOutcomeEvent): { readonly ok: true; readonly event: RouteOutcomeEvent } | RecordRefusal {
  const e = event as Partial<RouteOutcomeEvent> & { readonly [key: string]: unknown };
  if (typeof event !== 'object' || event === null) return { ok: false, reasonCode: 'INVALID_EVENT' };
  if (!(LABEL_SOURCES as readonly unknown[]).includes(e.labelSource)) return { ok: false, reasonCode: 'LABEL_NOT_DETERMINISTIC', detail: String(e.labelSource).slice(0, 40) };
  if (!(OUTCOME_KINDS as readonly unknown[]).includes(e.kind)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'kind' };
  const kind = e.kind as OutcomeKind;
  if (LABEL_SOURCE_OF[kind] !== e.labelSource) return { ok: false, reasonCode: 'LABEL_NOT_DETERMINISTIC', detail: 'source-kind-mismatch' };
  for (const key of ['eventId', 'routeId', 'sliceId', 'modelId'] as const) if (typeof e[key] !== 'string' || !ID.test(e[key] as string)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: key };
  if (e.rulesModelId !== null && (typeof e.rulesModelId !== 'string' || !ID.test(e.rulesModelId))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'rulesModelId' };
  if (kind === 'verified-pass' || kind === 'verified-fail') {
    if (typeof e.receiptId !== 'string' || !ID.test(e.receiptId)) return { ok: false, reasonCode: 'RECEIPT_MISSING' };
  } else if (e.receiptId !== null && (typeof e.receiptId !== 'string' || !ID.test(e.receiptId))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'receiptId' };
  if (typeof e.explored !== 'boolean') return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'explored' };
  if (e.propensity !== null && (typeof e.propensity !== 'number' || !(e.propensity > 0 && e.propensity <= 1))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'propensity' };
  if (e.explored && e.propensity === null) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'explored-without-propensity' };
  if (!['low', 'medium', 'high', 'unknown'].includes(String(e.risk))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'risk' };
  for (const key of ['costMicroUsd', 'latencyMs'] as const) if (e[key] !== null && (typeof e[key] !== 'number' || !Number.isFinite(e[key]) || (e[key] as number) < 0)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: key };
  if (e.apiEquivalentMicroUsd !== undefined && e.apiEquivalentMicroUsd !== null && (typeof e.apiEquivalentMicroUsd !== 'number' || !Number.isFinite(e.apiEquivalentMicroUsd) || e.apiEquivalentMicroUsd < 0)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'apiEquivalentMicroUsd' };
  if (typeof e.policyVersion !== 'number' || !Number.isInteger(e.policyVersion) || e.policyVersion < 0) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'policyVersion' };
  if (typeof e.at !== 'string' || !ISO.test(e.at)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'at' };
  if (e.authMode !== undefined && !(AUTH_MODES as readonly unknown[]).includes(e.authMode)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'authMode' };
  if (e.tokens !== undefined && e.tokens !== null && (typeof e.tokens !== 'number' || !Number.isFinite(e.tokens) || e.tokens < 0)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'tokens' };
  if (e.limitResetAt !== undefined && e.limitResetAt !== null && (kind !== 'usage-limited' || typeof e.limitResetAt !== 'string' || !ISO.test(e.limitResetAt))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'limitResetAt' };
  if (e.effort !== undefined && e.effort !== null && !isEffortLevel(e.effort)) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'effort' };
  if (e.accessLimited !== undefined && (typeof e.accessLimited !== 'boolean' || (e.accessLimited && kind !== 'usage-limited'))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'accessLimited' };
  if (e.servingHost !== undefined && (typeof e.servingHost !== 'string' || !ID.test(e.servingHost))) return { ok: false, reasonCode: 'INVALID_EVENT', detail: 'servingHost' };
  return {
    ok: true,
    event: {
      eventId: event.eventId,
      routeId: event.routeId,
      sliceId: event.sliceId,
      modelId: event.modelId,
      rulesModelId: event.rulesModelId,
      policyVersion: event.policyVersion,
      kind,
      labelSource: event.labelSource,
      receiptId: event.receiptId,
      explored: event.explored,
      propensity: event.propensity,
      risk: event.risk,
      costMicroUsd: event.costMicroUsd,
      latencyMs: event.latencyMs,
      at: event.at,
      authMode: event.authMode ?? 'unknown',
      tokens: event.tokens ?? null,
      limitResetAt: event.limitResetAt ?? null,
      ...(event.effort === undefined || event.effort === null ? {} : { effort: event.effort }),
      ...(event.apiEquivalentMicroUsd === undefined || event.apiEquivalentMicroUsd === null ? {} : { apiEquivalentMicroUsd: event.apiEquivalentMicroUsd }),
      ...(event.accessLimited === true ? { accessLimited: true } : {}),
      ...(event.servingHost === undefined ? {} : { servingHost: event.servingHost }),
    },
  };
}

/** One labelled route: the final label after reverts and retries, with its first event's facts. */
export interface RouteLabel {
  readonly routeId: string;
  readonly sliceId: string;
  readonly modelId: string;
  /** The arm the route ran on (`armKey` of its model and effort). */
  readonly armId: string;
  readonly effort: string | null;
  readonly rulesModelId: string | null;
  readonly label: 'success' | 'failure' | 'unlabelled';
  readonly randomized: boolean;
  readonly explored: boolean;
  readonly costMicroUsd: number | null;
  /** Billed dollars where known, else the API-equivalent estimate, summed over the route's events. */
  readonly equivalentMicroUsd: number | null;
  readonly latencyMs: number | null;
  readonly staleOrCancelled: boolean;
  /** The harness reported a usage limit on this route. Not a quality label. */
  readonly usageLimited: boolean;
  readonly tokens: number | null;
  readonly authMode: AuthMode;
  readonly at: string;
}

/** The arm key of an event's model and effort. */
function armOfEvent(e: RouteOutcomeEvent): string {
  return e.effort === undefined || e.effort === null ? e.modelId : armKey(e.modelId, e.effort);
}

function labelOf(routeId: string, list: readonly RouteOutcomeEvent[]): RouteLabel {
  const first = list[0] as RouteOutcomeEvent;
  const kinds = new Set(list.map((e) => e.kind));
  const failed = kinds.has('verified-fail') || kinds.has('reverted') || kinds.has('retried') || kinds.has('run-incomplete');
  const label = failed ? 'failure' : kinds.has('verified-pass') ? 'success' : 'unlabelled';
  const costs = list.map((e) => e.costMicroUsd).filter((c): c is number => c !== null);
  const equivalents = list.map((e) => e.costMicroUsd ?? e.apiEquivalentMicroUsd ?? null).filter((c): c is number => c !== null);
  const latencies = list.map((e) => e.latencyMs).filter((c): c is number => c !== null);
  const tokens = list.map((e) => e.tokens ?? null).filter((c): c is number => c !== null);
  const mode = list.map((e) => e.authMode ?? 'unknown').find((m) => m !== 'unknown') ?? 'unknown';
  return {
    routeId,
    sliceId: first.sliceId,
    modelId: first.modelId,
    armId: armOfEvent(first),
    effort: first.effort ?? null,
    rulesModelId: first.rulesModelId,
    label,
    randomized: first.propensity !== null && first.risk === 'low',
    explored: first.explored,
    costMicroUsd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0),
    equivalentMicroUsd: equivalents.length === 0 ? null : equivalents.reduce((s, c) => s + c, 0),
    latencyMs: latencies.length === 0 ? null : Math.max(...latencies),
    staleOrCancelled: kinds.has('stale') || kinds.has('cancelled'),
    usageLimited: kinds.has('usage-limited'),
    tokens: tokens.length === 0 ? null : tokens.reduce((s, c) => s + c, 0),
    authMode: mode,
    at: first.at,
  };
}

/**
 * Folds events into one label per route. Any revert, retry, failed check or run that ended
 * without a receipt makes the route a failure. A usage-limit hit is capacity, not quality: it is counted and never labelled.
 */
export function routeLabels(events: readonly RouteOutcomeEvent[]): RouteLabel[] {
  const byRoute = new Map<string, RouteOutcomeEvent[]>();
  for (const e of events) byRoute.set(e.routeId, [...(byRoute.get(e.routeId) ?? []), e]);
  const out: RouteLabel[] = [];
  for (const [routeId, list] of byRoute) out.push(labelOf(routeId, list));
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.routeId < b.routeId ? -1 : 1));
}

/** Route labels of one slice (and one arm), filtering the raw events first. */
function labelsFor(events: readonly RouteOutcomeEvent[], sliceId: string, armId?: string): RouteLabel[] {
  return routeLabels(events.filter((e) => e.sliceId === sliceId && (armId === undefined || armOfEvent(e) === armId)));
}

function emptyArm(at: string): ArmAggregate {
  return { successes: 0, failures: 0, staleOrCancelled: 0, usageLimited: 0, routes: 0, costSumMicroUsd: 0, costCount: 0, tokensSum: 0, tokensCount: 0, latencySumMs: 0, latencyCount: 0, equivalentSumMicroUsd: 0, equivalentCount: 0, randomizedLabelled: 0, firstAt: at, lastAt: at };
}

/** Adds (sign 1) or removes (sign −1) one route's label from the aggregate. */
function applyLabel(arms: LearningState['arms'], l: RouteLabel, sign: 1 | -1): LearningState['arms'] {
  const slice = arms[l.sliceId] ?? {};
  const a = slice[l.armId] ?? emptyArm(l.at);
  const next: ArmAggregate = {
    successes: a.successes + sign * (l.label === 'success' ? 1 : 0),
    failures: a.failures + sign * (l.label === 'failure' ? 1 : 0),
    staleOrCancelled: a.staleOrCancelled + sign * (l.staleOrCancelled ? 1 : 0),
    usageLimited: a.usageLimited + sign * (l.usageLimited ? 1 : 0),
    routes: a.routes + sign,
    costSumMicroUsd: a.costSumMicroUsd + sign * (l.costMicroUsd ?? 0),
    costCount: a.costCount + sign * (l.costMicroUsd === null ? 0 : 1),
    tokensSum: a.tokensSum + sign * (l.tokens ?? 0),
    tokensCount: a.tokensCount + sign * (l.tokens === null ? 0 : 1),
    latencySumMs: a.latencySumMs + sign * (l.latencyMs ?? 0),
    latencyCount: a.latencyCount + sign * (l.latencyMs === null ? 0 : 1),
    equivalentSumMicroUsd: a.equivalentSumMicroUsd + sign * (l.equivalentMicroUsd ?? 0),
    equivalentCount: a.equivalentCount + sign * (l.equivalentMicroUsd === null ? 0 : 1),
    randomizedLabelled: a.randomizedLabelled + sign * (l.randomized && l.label !== 'unlabelled' ? 1 : 0),
    firstAt: sign === 1 && l.at < a.firstAt ? l.at : a.firstAt,
    lastAt: sign === 1 && l.at > a.lastAt ? l.at : a.lastAt,
  };
  return { ...arms, [l.sliceId]: { ...slice, [l.armId]: next } };
}

/** Drops whole routes whose latest event is older than the window, then the oldest routes over the cap. */
function pruneWindow(events: readonly RouteOutcomeEvent[]): readonly RouteOutcomeEvent[] {
  if (events.length === 0) return events;
  let newest = Number.NEGATIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (t > newest) newest = t;
    if (t < oldest) oldest = t;
  }
  if (events.length <= LEARNING_LIMITS.maxEvents && oldest >= newest - LEARNING_LIMITS.windowDays * DAY_MS) return events;
  const latest = new Map<string, number>();
  for (const e of events) latest.set(e.routeId, Math.max(latest.get(e.routeId) ?? 0, Date.parse(e.at)));
  const horizon = newest - LEARNING_LIMITS.windowDays * DAY_MS;
  let kept = events.filter((e) => (latest.get(e.routeId) ?? 0) >= horizon);
  if (kept.length > LEARNING_LIMITS.maxEvents) {
    const order = [...new Set(kept.map((e) => e.routeId))].sort((a, b) => (latest.get(a) ?? 0) - (latest.get(b) ?? 0));
    const drop = new Set<string>();
    let count = kept.length;
    for (const routeId of order) {
      if (count <= LEARNING_LIMITS.maxEvents) break;
      drop.add(routeId);
      count -= kept.filter((e) => e.routeId === routeId).length;
    }
    kept = kept.filter((e) => !drop.has(e.routeId));
  }
  return kept;
}

const MACHINE_NUMBERS = ['successes', 'failures', 'staleOrCancelled', 'usageLimited', 'routes', 'costSumMicroUsd', 'costCount', 'tokensSum', 'tokensCount', 'latencySumMs', 'latencyCount', 'equivalentSumMicroUsd', 'equivalentCount'] as const;

function emptyMachineArm(): MachineArm {
  return { successes: 0, failures: 0, staleOrCancelled: 0, usageLimited: 0, routes: 0, costSumMicroUsd: 0, costCount: 0, tokensSum: 0, tokensCount: 0, latencySumMs: 0, latencyCount: 0, equivalentSumMicroUsd: 0, equivalentCount: 0 };
}

/** Adds (sign 1) or removes (sign −1) one route's label from a contribution, under its shared slice. Never below zero. */
function applyMachineLabel(arms: MachineContribution['arms'], shared: string, l: RouteLabel, sign: 1 | -1): MachineContribution['arms'] {
  const slice = arms[shared] ?? {};
  const a = slice[l.armId] ?? emptyMachineArm();
  const add = (x: number, d: number) => Math.max(0, x + sign * d);
  const next: MachineArm = {
    successes: add(a.successes, l.label === 'success' ? 1 : 0),
    failures: add(a.failures, l.label === 'failure' ? 1 : 0),
    staleOrCancelled: add(a.staleOrCancelled, l.staleOrCancelled ? 1 : 0),
    usageLimited: add(a.usageLimited, l.usageLimited ? 1 : 0),
    routes: add(a.routes, 1),
    costSumMicroUsd: add(a.costSumMicroUsd, l.costMicroUsd ?? 0),
    costCount: add(a.costCount, l.costMicroUsd === null ? 0 : 1),
    tokensSum: add(a.tokensSum, l.tokens ?? 0),
    tokensCount: add(a.tokensCount, l.tokens === null ? 0 : 1),
    latencySumMs: add(a.latencySumMs, l.latencyMs ?? 0),
    latencyCount: add(a.latencyCount, l.latencyMs === null ? 0 : 1),
    equivalentSumMicroUsd: add(a.equivalentSumMicroUsd, l.equivalentMicroUsd ?? 0),
    equivalentCount: add(a.equivalentCount, l.equivalentMicroUsd === null ? 0 : 1),
  };
  return { ...arms, [shared]: { ...slice, [l.armId]: next } };
}

/**
 * The workspace's contribution after one outcome: the same label change as the aggregate, under
 * the slice's shared id, and a usage-limit hit per model. Unchanged when the workspace has no
 * contribution yet, learning is off, or the slice is not shared.
 */
function contributeOutcome(state: LearningState, clean: RouteOutcomeEvent, earlier: readonly RouteOutcomeEvent[]): MachineContribution | undefined {
  const machine = state.machine;
  if (machine === undefined || !state.settings.enabled) return machine;
  let arms = machine.arms;
  const shared = sharedSliceOf(state.settings, clean.sliceId);
  if (shared !== null) {
    if (earlier.length > 0) arms = applyMachineLabel(arms, shared, labelOf(clean.routeId, earlier), -1);
    arms = applyMachineLabel(arms, shared, labelOf(clean.routeId, [...earlier, clean]), 1);
  }
  let limits = machine.limits;
  // R61: a hit recorded in the access-limits record is not a model-wide machine limit.
  if (clean.kind === 'usage-limited' && clean.accessLimited !== true) {
    const resetAt = clean.limitResetAt ?? new Date(Date.parse(clean.at) + state.settings.limitCooldownHours * 3_600_000).toISOString();
    const seen = limits[clean.modelId];
    limits = {
      ...limits,
      [clean.modelId]: {
        resetAt: seen !== undefined && Date.parse(seen.resetAt) > Date.parse(resetAt) ? seen.resetAt : new Date(Date.parse(resetAt)).toISOString(),
        lastHitAt: seen !== undefined && Date.parse(seen.lastHitAt) > Date.parse(clean.at) ? seen.lastHitAt : new Date(Date.parse(clean.at)).toISOString(),
      },
    };
  }
  return { ...machine, arms, limits };
}

/**
 * Records one outcome into the aggregate. Refuses a label that is not deterministic, a verified
 * outcome without its receipt, a source that does not match the kind, a duplicate event id, and
 * an event older than the reconciliation window. A revert or retry within 30 days of the route's
 * verified-pass label (of its first event when it has none) replaces that route's earlier label
 * in the counts; a later one is refused
 * (EVENT_EXPIRED, relabel-window), and a revert or retry of a route this state does not hold is
 * refused (ROUTE_UNKNOWN).
 */
export function recordRouteOutcome(state: LearningState, event: RouteOutcomeEvent): { readonly ok: true; readonly state: LearningState } | RecordRefusal {
  const checked = cleanEvent(event);
  if (!checked.ok) return checked;
  const clean = checked.event;
  if (state.events.some((x) => x.eventId === clean.eventId)) return { ok: false, reasonCode: 'DUPLICATE_EVENT' };
  if (state.events.length > 0) {
    const newest = Math.max(...state.events.map((e) => Date.parse(e.at)));
    if (Date.parse(clean.at) < newest - LEARNING_LIMITS.windowDays * DAY_MS) return { ok: false, reasonCode: 'EVENT_EXPIRED' };
  }
  const earlier = state.events.filter((e) => e.routeId === clean.routeId);
  if (clean.kind === 'reverted' || clean.kind === 'retried') {
    // SPEC §18.5 (amended 2026-09-27): a revert or retry within 30 days of a verified-pass label
    // overturns it (of the route's first event when it has no pass); after that the label stands.
    // A revert or retry needs a route this state still holds: one of a pruned route would add a
    // failure while its success stayed counted. A failed run is labelled run-incomplete first (D 5dd03d0).
    if (earlier.length === 0) return { ok: false, reasonCode: 'ROUTE_UNKNOWN' };
    const passes = earlier.filter((e) => e.kind === 'verified-pass');
    const from = Math.min(...(passes.length > 0 ? passes : earlier).map((e) => Date.parse(e.at)));
    if (earlier.length > 0 && Date.parse(clean.at) > from + LEARNING_LIMITS.windowDays * DAY_MS) return { ok: false, reasonCode: 'EVENT_EXPIRED', detail: 'relabel-window' };
  }
  let arms = state.arms;
  if (earlier.length > 0) arms = applyLabel(arms, labelOf(clean.routeId, earlier), -1);
  arms = applyLabel(arms, labelOf(clean.routeId, [...earlier, clean]), 1);
  const machine = contributeOutcome(state, clean, earlier);
  return { ok: true, state: { ...state, arms, events: pruneWindow([...state.events, clean]), ...(machine === undefined ? {} : { machine }) } };
}

/** Wilson score interval; z 1.645 is one-sided 95%. */
export function wilsonInterval(successes: number, n: number, z = 1.959964): { readonly lower: number; readonly upper: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lower: clamp(centre - half, 0, 1), upper: clamp(centre + half, 0, 1) };
}

/** Newcombe hybrid score interval for p1 - p2 (method 10). */
export function newcombeDifference(s1: number, n1: number, s2: number, n2: number, z = 1.644854): { readonly lower: number; readonly upper: number } | null {
  const a = wilsonInterval(s1, n1, z);
  const b = wilsonInterval(s2, n2, z);
  if (a === null || b === null) return null;
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const d = p1 - p2;
  return { lower: d - Math.sqrt((p1 - a.lower) ** 2 + (b.upper - p2) ** 2), upper: d + Math.sqrt((a.upper - p1) ** 2 + (p2 - b.lower) ** 2) };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** A mean over the observed routes, scaled to every route the arm ran, per verified success. */
function perVerified(sum: number, count: number, routes: number, successes: number, weight = 1): number | null {
  if (successes <= 0 || count <= 0) return null;
  return Math.round((weight * sum * routes) / (count * successes));
}

function statsOf(state: LearningState, sliceId: string, armId: string): ArmStats {
  const a = state.arms[sliceId]?.[armId] ?? emptyArm('1970-01-01T00:00:00Z');
  const labelled = a.successes + a.failures;
  const ci = wilsonInterval(a.successes, labelled);
  const { modelId, effort } = parseArmKey(armId);
  const weight = state.settings.quotaWeights[modelId] ?? 1;
  const recent = labelsFor(state.events, sliceId, armId);
  return {
    armId,
    modelId,
    effort,
    labelled,
    successes: a.successes,
    rate: labelled === 0 ? null : round(a.successes / labelled),
    lower: ci === null ? null : round(ci.lower),
    upper: ci === null ? null : round(ci.upper),
    staleOrCancelled: a.staleOrCancelled,
    meanCostMicroUsd: a.costCount === 0 ? null : Math.round(a.costSumMicroUsd / a.costCount),
    medianLatencyMs: median(recent.map((l) => l.latencyMs).filter((c): c is number => c !== null)),
    meanLatencyMs: a.latencyCount === 0 ? null : Math.round(a.latencySumMs / a.latencyCount),
    usageLimited: a.usageLimited,
    meanTokens: a.tokensCount === 0 ? null : Math.round(a.tokensSum / a.tokensCount),
    meanWeightedUsage: a.tokensCount === 0 ? null : Math.round((weight * a.tokensSum) / a.tokensCount),
    routes: a.routes,
    costPerVerifiedMicroUsd: perVerified(a.costSumMicroUsd, a.costCount, a.routes, a.successes),
    apiEquivalentPerVerifiedMicroUsd: perVerified(a.equivalentSumMicroUsd, a.equivalentCount, a.routes, a.successes),
    tokensPerVerified: perVerified(a.tokensSum, a.tokensCount, a.routes, a.successes),
    usagePerVerified: perVerified(a.tokensSum, a.tokensCount, a.routes, a.successes, weight),
    wallMsPerVerified: perVerified(a.latencySumMs, a.latencyCount, a.routes, a.successes),
  };
}

/** The other workspaces' economics for one arm (per verified task), or null with no machine data for it. */
function machineStats(state: LearningState, sliceId: string, armId: string): ArmStats | null {
  const a = machineArm(state, sliceId, armId);
  if (a === null) return null;
  const { modelId, effort } = parseArmKey(armId);
  const weight = state.settings.quotaWeights[modelId] ?? 1;
  const labelled = a.successes + a.failures;
  return {
    armId,
    modelId,
    effort,
    labelled,
    successes: a.successes,
    rate: labelled === 0 ? null : round(a.successes / labelled),
    lower: null,
    upper: null,
    staleOrCancelled: a.staleOrCancelled,
    meanCostMicroUsd: a.costCount === 0 ? null : Math.round(a.costSumMicroUsd / a.costCount),
    medianLatencyMs: null,
    usageLimited: a.usageLimited,
    meanTokens: a.tokensCount === 0 ? null : Math.round(a.tokensSum / a.tokensCount),
    meanWeightedUsage: a.tokensCount === 0 ? null : Math.round((weight * a.tokensSum) / a.tokensCount),
    routes: a.routes,
    costPerVerifiedMicroUsd: perVerified(a.costSumMicroUsd, a.costCount, a.routes, a.successes),
    apiEquivalentPerVerifiedMicroUsd: perVerified(a.equivalentSumMicroUsd, a.equivalentCount, a.routes, a.successes),
    tokensPerVerified: perVerified(a.tokensSum, a.tokensCount, a.routes, a.successes),
    usagePerVerified: perVerified(a.tokensSum, a.tokensCount, a.routes, a.successes, weight),
    wallMsPerVerified: perVerified(a.latencySumMs, a.latencyCount, a.routes, a.successes),
  };
}

/** Per-arm local evidence on one slice, from the aggregate (every outcome ever counted). */
export function sliceEvidence(state: LearningState, sliceId: string): readonly ArmStats[] {
  return Object.keys(state.arms[sliceId] ?? {})
    .sort()
    .map((m) => statsOf(state, sliceId, m));
}

/** The bundled public priors that apply to a local slice through the settings' mapping (advice only). */
export function priorsFor(state: LearningState, sliceId: string, priors: readonly PublicPrior[] = BUNDLED_PUBLIC_PRIORS): readonly PublicPrior[] {
  const mapped = state.settings.priorSlices[baseSliceOf(sliceId)];
  if (mapped === undefined) return [];
  return priors.filter((p) => p.priorSliceId === mapped);
}

/**
 * Advice estimates for the router: local labelled outcomes plus the bundled public prior as at
 * most `priorWeight` pseudo-trials (halved when the prior's effort differs from the model's
 * default). The source id names the policy version, so an explanation can cite it.
 */
export function learnedQualities(state: LearningState, sliceId: string, registry: ModelRegistry | null = null, priors: readonly PublicPrior[] = BUNDLED_PUBLIC_PRIORS): QualityEstimate[] {
  // Advice estimates are per model at its default effort; effort arms are the posterior's business.
  const local = new Map(sliceEvidence(state, sliceId).filter((a) => a.effort === null).map((a) => [a.modelId, a]));
  const prior = new Map<string, { readonly rate: number; readonly weight: number; readonly trials: number }>();
  for (const p of priorsFor(state, sliceId, priors)) {
    const model = registry === null ? null : registryModel(registry, p.modelId);
    const effortMatches = model === null || model.defaultEffort === undefined || model.defaultEffort === p.effort;
    const weight = Math.min(state.settings.priorWeight, p.trials) * (effortMatches ? 1 : 0.5);
    const seen = prior.get(p.modelId);
    if (seen === undefined || weight > seen.weight || (weight === seen.weight && p.trials > seen.trials)) prior.set(p.modelId, { rate: p.successRate, weight, trials: p.trials });
  }
  const version = activeVersion(state).version;
  const out: QualityEstimate[] = [];
  for (const modelId of [...new Set([...local.keys(), ...prior.keys()])].sort()) {
    const arm = local.get(modelId);
    const pr = prior.get(modelId);
    const n = (arm?.labelled ?? 0) + (pr?.weight ?? 0);
    if (n <= 0) continue;
    const s = (arm?.successes ?? 0) + (pr === undefined ? 0 : pr.weight * pr.rate);
    const ci = wilsonInterval(s, n) as { readonly lower: number; readonly upper: number };
    out.push({ modelId, sliceId, lower: round(ci.lower), point: round(s / n), upper: round(ci.upper), sourceId: `local-learning:v${String(version)}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The Beta posterior.

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0] as number;
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += (c[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b): the Beta(a, b) CDF at x. */
export function betaCdf(x: number, a: number, b: number, logNorm = logGamma(a + b) - logGamma(a) - logGamma(b)): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = logNorm + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** The Beta(a, b) quantile, by bisection. */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** One model's posterior on one slice: the baseline prior plus the local outcomes. */
export interface ArmPosterior {
  /** The arm key (`armKey`). */
  readonly armId: string;
  readonly modelId: string;
  /** Null: the model's default effort. */
  readonly effort: string | null;
  readonly alpha: number;
  readonly beta: number;
  readonly mean: number;
  readonly prior: { readonly rate: number | null; readonly pseudoCount: number; readonly sourceId: string | null };
  readonly local: { readonly successes: number; readonly failures: number };
  /**
   * The machine-wide prior's part (other workspaces on this machine), when it has outcomes for
   * this arm: their counts, the rate and the pseudo-count it adds (at most `MACHINE_PRIOR_WEIGHT`).
   */
  readonly machine?: { readonly successes: number; readonly failures: number; readonly rate: number; readonly pseudoCount: number; readonly contributors: number };
}

/** The other workspaces' sums for this slice and arm, when the slice is shared and learning is on. */
function machineArm(state: LearningState, sliceId: string, armId: string): MachineArm | null {
  if (state.machinePrior === undefined || !state.settings.enabled) return null;
  const shared = sharedSliceOf(state.settings, sliceId);
  return shared === null ? null : (state.machinePrior.arms[shared]?.[armId] ?? null);
}

/**
 * P(q_c < q_b − margin) for independent Beta posteriors: the posterior probability that the
 * candidate is worse than the baseline by more than the margin. Numerical integration over the
 * baseline's density.
 */
export function harmProbability(candidate: Pick<ArmPosterior, 'alpha' | 'beta'>, baseline: Pick<ArmPosterior, 'alpha' | 'beta'>, margin: number): number {
  const { alpha: a, beta: b } = baseline;
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  const lo = Math.max(margin, mean - 10 * sd);
  const hi = Math.min(1, mean + 10 * sd);
  if (hi <= lo) return 0;
  const steps = 400;
  const h = (hi - lo) / steps;
  const logNorm = logGamma(a + b) - logGamma(a) - logGamma(b);
  const candidateNorm = logGamma(candidate.alpha + candidate.beta) - logGamma(candidate.alpha) - logGamma(candidate.beta);
  let sum = 0;
  for (let i = 0; i < steps; i += 1) {
    const x = lo + (i + 0.5) * h;
    const density = Math.exp(logNorm + (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x));
    sum += density * betaCdf(x - margin, candidate.alpha, candidate.beta, candidateNorm);
  }
  return clamp(sum * h, 0, 1);
}

/**
 * The baseline priors a signed `beta-posterior` release carries for a slice; none from any other
 * release. A quality measured at an effort carries it (the model's default effort is dropped, so
 * it names the same arm as the bare model), with the measured cost and tokens when present.
 */
export function baselinePriorsFromRelease(artifact: CalibrationArtifact, sliceId: string, settings: Pick<LearningSettings, 'priorWeight'> = DEFAULT_LEARNING_SETTINGS, registry?: ModelRegistry): readonly BaselinePrior[] {
  if (artifact.uncertaintyInterval.method !== 'beta-posterior') return [];
  return (artifact.modelQualities ?? [])
    .filter((q) => q.sliceId === sliceId)
    .map((q) => {
      const effort = q.effort === undefined || armKey(q.modelId, q.effort, registry) === q.modelId ? null : q.effort;
      return {
        sliceId,
        modelId: q.modelId,
        ...(effort === null ? {} : { effort }),
        rate: q.point,
        sampleSize: q.sampleSize,
        pseudoCount: Math.min(q.sampleSize, settings.priorWeight),
        sourceId: artifact.id,
        ...(q.meanCostMicroUsd === undefined ? {} : { meanCostMicroUsd: q.meanCostMicroUsd }),
        ...(q.meanTokens === undefined ? {} : { meanTokens: q.meanTokens }),
      };
    });
}

/** The arm key of a baseline prior. */
function armOfPrior(p: BaselinePrior): string {
  return p.effort === undefined || p.effort === null ? p.modelId : armKey(p.modelId, p.effort);
}

/**
 * The posterior of one arm on one slice, from the state's baseline snapshot (or `priors`) and the
 * aggregate. `armId` is an arm key: a model id is that model at its default effort.
 */
export function armPosterior(state: LearningState, sliceId: string, armId: string, priors: readonly BaselinePrior[] = state.baseline[sliceId]?.priors ?? []): ArmPosterior {
  const p = priors.find((x) => x.sliceId === sliceId && armOfPrior(x) === armId) ?? null;
  const n = p === null ? 0 : Math.min(p.pseudoCount, state.settings.priorWeight);
  const a = state.arms[sliceId]?.[armId];
  const successes = a?.successes ?? 0;
  const failures = a?.failures ?? 0;
  // The machine prior: the other workspaces' outcomes as at most `MACHINE_PRIOR_WEIGHT` pseudo-outcomes.
  const m = machineArm(state, sliceId, armId);
  const mTrials = m === null ? 0 : m.successes + m.failures;
  const mRate = m === null || mTrials === 0 ? 0 : m.successes / mTrials;
  const mn = Math.min(mTrials, MACHINE_PRIOR_WEIGHT);
  const alpha = 0.5 + (p === null ? 0 : p.rate * n) + mRate * mn + successes;
  const beta = 0.5 + (p === null ? 0 : (1 - p.rate) * n) + (1 - mRate) * mn + failures;
  const { modelId, effort } = parseArmKey(armId);
  const machine = m === null || mTrials === 0 ? {} : { machine: { successes: m.successes, failures: m.failures, rate: round(mRate), pseudoCount: mn, contributors: state.machinePrior?.contributors ?? 0 } };
  return { armId, modelId, effort, alpha: round(alpha), beta: round(beta), mean: round(alpha / (alpha + beta)), prior: { rate: p?.rate ?? null, pseudoCount: n, sourceId: p?.sourceId ?? null }, local: { successes, failures }, ...machine };
}

export interface UsageLimitStatus {
  /** A usage-limit hit whose reset has not passed: never launch or retry into it. */
  readonly limited: boolean;
  /** A hit within `nearLimitHours`: the model is near its limit and is never explored. */
  readonly near: boolean;
  readonly resetAt: string | null;
  readonly recentHits: number;
}

/**
 * The legacy model-only usage-limit reader (R61, access-limits design 4.5), kept for one release so
 * a hit recorded before the access-limits record still blocks its model until it expires: every
 * such hit expires within 7 days (`limitCooldownHours` is clamped at 168 h), and the next release
 * deletes this reader. A hit the caller also put in the access-limits record (`accessLimited`) is
 * skipped: that record, keyed by harness, sign-in and serving host, decides it. A hit counts for
 * `authMode` only when its own sign-in matches (`unknown` on either side matches both). A hit
 * without a reset time blocks for `limitCooldownHours`.
 */
export function usageLimitStatus(state: LearningState, modelId: string, nowMs: number, authMode: AuthMode = 'unknown'): UsageLimitStatus {
  const modes = (hit: AuthMode | undefined): boolean => authMode === 'unknown' || hit === undefined || hit === 'unknown' || hit === authMode;
  const hits = state.events.filter((e) => e.kind === 'usage-limited' && e.modelId === modelId && e.accessLimited !== true && modes(e.authMode));
  let resetMs = 0;
  for (const h of hits) {
    const reset = h.limitResetAt !== undefined && h.limitResetAt !== null ? Date.parse(h.limitResetAt) : Date.parse(h.at) + state.settings.limitCooldownHours * 3_600_000;
    if (reset > nowMs && reset > resetMs) resetMs = reset;
  }
  let recent = hits.filter((h) => nowMs - Date.parse(h.at) <= state.settings.nearLimitHours * 3_600_000 && Date.parse(h.at) <= nowMs).length;
  // A limit is the account's, not the workspace's: another workspace's hit on this machine counts too.
  const shared = state.machinePrior?.limits[modelId];
  if (shared !== undefined) {
    const reset = Date.parse(shared.resetAt);
    const hit = Date.parse(shared.lastHitAt);
    if (reset > nowMs && reset > resetMs) resetMs = reset;
    if (hit <= nowMs && nowMs - hit <= state.settings.nearLimitHours * 3_600_000) recent += 1;
  }
  return { limited: resetMs > 0, near: recent > 0, resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null, recentHits: recent };
}

export interface ExplorationChoice {
  readonly modelId: string;
  /** The effort to launch with; null is the model's default. */
  readonly effort: string | null;
  readonly explored: boolean;
  /** The probability of the chosen model under the logging policy; null outside the randomized pool. */
  readonly propensity: number | null;
  readonly reasonCode: 'EXPLORED' | 'DEFAULT' | 'NOT_AUTOMATED' | 'RISK_NOT_LOW' | 'SLICE_PINNED' | 'EXPLORATION_OFF' | 'LEARNING_OFF' | 'NO_ELIGIBLE_ALTERNATIVE';
}

/** A model almost surely worse than the default by more than the margin is never explored. */
export const FUTILE_HARM = 0.95;

/**
 * Whether this route explores. The caller passes the models the router left eligible (managed
 * allowlist, providers, regions, ZDR, lifecycle); retired or deprecated ones are dropped again
 * here when a registry is given. The alternatives are arms: every eligible model at its default
 * effort, and the baseline model at each of `effortArms` it supports. Each is weighted by its
 * posterior probability of being within the margin of the default arm (a probability-matching
 * share, so the propensity is exact); a futile one, or one at or near a usage limit, is left out.
 */
export function explorationChoice(input: {
  readonly state: LearningState;
  readonly sliceId: string;
  readonly mode: 'observe' | 'advise' | 'bounded-auto';
  readonly risk: RouteRisk;
  readonly defaultModelId: string;
  /** The default arm's effort (null: the model's default). */
  readonly defaultEffort?: string | null;
  /** The baseline model, whose effort arms are explored. Default: the default model. */
  readonly baselineModelId?: string;
  readonly eligibleModelIds: readonly string[];
  readonly random: () => number;
  readonly registry?: ModelRegistry;
  readonly nowMs?: number;
  readonly priors?: readonly BaselinePrior[];
  /** The route's sign-in, for the legacy usage-limit reader. Default `unknown` (matches every hit). */
  readonly authMode?: AuthMode;
  /** Models whose scope is paused in the access-limits record (`pausedModels`, R72): never explored. */
  readonly pausedModelIds?: readonly string[];
  /** Models whose scope hit an access limit within `nearLimitHours` (`accessLimitNear`, R72): never explored. */
  readonly nearLimitModelIds?: readonly string[];
}): ExplorationChoice {
  const defaultEffort = input.defaultEffort ?? null;
  const keep = (reasonCode: ExplorationChoice['reasonCode'], propensity: number | null = null): ExplorationChoice => ({ modelId: input.defaultModelId, effort: defaultEffort, explored: false, propensity, reasonCode });
  if (input.mode !== 'bounded-auto') return keep('NOT_AUTOMATED');
  if (!input.state.settings.enabled) return keep('LEARNING_OFF');
  if (input.risk !== 'low') return keep('RISK_NOT_LOW');
  if (slicePolicy(input.state, input.sliceId).mode === 'pinned') return keep('SLICE_PINNED');
  // Advise-only (never switched, or demoted): the faster rate, so the local evidence the guard needs comes sooner.
  const settings = input.state.settings;
  const advising = slicePolicy(input.state, input.sliceId).mode !== 'auto';
  const rate = settings.explorationRate === 0 ? 0 : clamp(advising ? settings.adviseExplorationRate : settings.explorationRate, 0, LEARNING_LIMITS.explorationCap);
  if (rate === 0) return keep('EXPLORATION_OFF');
  const nowMs = input.nowMs ?? Date.now();
  const margin = input.state.settings.nonInferiorityMargin;
  const defaultArm = armKey(input.defaultModelId, defaultEffort, input.registry);
  const reference = armPosterior(input.state, input.sliceId, defaultArm, input.priors);
  const baselineModelId = input.baselineModelId ?? input.defaultModelId;
  const models = [...new Set(input.eligibleModelIds)]
    .filter((m) => ID.test(m))
    .filter((m) => {
      if (input.registry === undefined) return true;
      const model = registryModel(input.registry, m);
      // A preview model is advice and shadow only (SPEC §8.1): never explored.
      return model !== null && lifecycleCheck(model, nowMs).usable && model.lifecycle?.status !== 'preview';
    })
    // Never explore into, or toward, an access limit: a scope paused or hit within nearLimitHours
    // (the access-limits record, R72), or a legacy model-only hit (R61).
    .filter((m) => !(input.pausedModelIds ?? []).includes(m) && !(input.nearLimitModelIds ?? []).includes(m))
    .filter((m) => {
      const limit = usageLimitStatus(input.state, m, nowMs, input.authMode ?? 'unknown');
      return !limit.limited && !limit.near;
    });
  // SPEC §8.3, OD-14: a model of another vendor than the baseline's is explored only with
  // evidence for this slice: a release or qualified board prior, or outcomes here or on this
  // machine. Unknown quality stays out of an automated route.
  const baselineProvider = input.registry === undefined ? null : (registryModel(input.registry, baselineModelId)?.provider ?? null);
  const evidenced = (m: string): boolean => {
    if (input.registry === undefined || baselineProvider === null) return true;
    if (registryModel(input.registry, m)?.provider === baselineProvider) return true;
    const post = armPosterior(input.state, input.sliceId, armKey(m, null, input.registry), input.priors);
    return post.prior.pseudoCount > 0 || post.local.successes + post.local.failures > 0 || post.machine !== undefined;
  };
  const arms = new Set<string>();
  for (const m of models) {
    if (!evidenced(m)) continue;
    arms.add(m);
    if (m === baselineModelId) for (const e of input.state.settings.effortArms) if (effortListed(m, e, input.registry)) arms.add(armKey(m, e, input.registry));
  }
  arms.delete(defaultArm);
  const weighted = [...arms]
    .sort()
    .map((arm) => ({ arm, weight: 1 - harmProbability(armPosterior(input.state, input.sliceId, arm, input.priors), reference, margin) }))
    .filter((w) => w.weight > 1 - FUTILE_HARM);
  if (weighted.length === 0) return keep('NO_ELIGIBLE_ALTERNATIVE');
  if (input.random() < rate) {
    const total = weighted.reduce((s, w) => s + w.weight, 0);
    let r = input.random() * total;
    let pick = weighted[weighted.length - 1] as { readonly arm: string; readonly weight: number };
    for (const w of weighted) {
      if (r < w.weight) {
        pick = w;
        break;
      }
      r -= w.weight;
    }
    const chosen = parseArmKey(pick.arm);
    return { modelId: chosen.modelId, effort: chosen.effort, explored: true, propensity: round((rate * pick.weight) / total), reasonCode: 'EXPLORED' };
  }
  return keep('DEFAULT', round(1 - rate));
}

/** A cryptographic uniform random in [0, 1) for production exploration. */
export function secureRandom(): number {
  const b = randomBytes(6);
  let x = 0;
  for (const byte of b) x = x * 256 + byte;
  return x / 2 ** 48;
}

/** The owner-locked thresholds the posterior routing runs on. */
export interface LockedLearningThresholds {
  readonly explorationRate: number;
  readonly adviseExplorationRate: number;
  readonly minLocalPerArm: number;
  readonly nonInferiorityMargin: number;
  readonly activateBelow: number;
  readonly deactivateAbove: number;
  readonly flapFloor: number;
  readonly priorWeight: number;
  readonly machinePriorWeight: number;
  readonly demotionWindow: number;
  readonly lockedOn: string;
  readonly decisionRef: string;
}

/**
 * The thresholds for posterior routing. Margin 0.075, exploration 5% (cap 10%) and the demotion
 * window 20 are the owner's (2026-09-26, DOMAINS 64d36df); the posterior thresholds, the flap
 * floor and the prior cap replace the minimum per arm (owner direction 2026-09-26: work from day
 * 1 on the baseline and learn in use). They change only in a reviewed commit, never at run time.
 */
export const OWNER_LOCKED_LEARNING_THRESHOLDS: LockedLearningThresholds | null = Object.freeze({
  explorationRate: 0.05,
  adviseExplorationRate: 0.1,
  minLocalPerArm: MIN_LOCAL_PER_ARM,
  nonInferiorityMargin: 0.075,
  activateBelow: 0.1,
  deactivateAbove: 0.4,
  flapFloor: 5,
  priorWeight: 30,
  machinePriorWeight: MACHINE_PRIOR_WEIGHT,
  demotionWindow: 20,
  lockedOn: '2026-09-26',
  decisionRef: 'owner decisions 2026-09-26 (DOMAINS 64d36df), the baseline-first direction of 2026-09-26, the local-evidence guard (DOMAINS 223a21f) and the machine prior cap of 2026-09-27 (DOMAINS 43990b1)',
});

/** Whether automatic activation may run: only with owner-locked thresholds. */
export function automaticPromotionReady(): { readonly ready: false; readonly reasonCode: 'NOT_YET_CALIBRATED' } | { readonly ready: true; readonly thresholds: LockedLearningThresholds } {
  const locked = OWNER_LOCKED_LEARNING_THRESHOLDS as LockedLearningThresholds | null;
  return locked === null ? { ready: false, reasonCode: 'NOT_YET_CALIBRATED' } : { ready: true, thresholds: locked };
}

/** When the slice last changed (any version naming it, or a workspace-wide reset or rollback). */
function lastChangeAt(state: LearningState, sliceId: string): number | null {
  const last = [...state.versions].reverse().find((v) => v.version > 0 && (v.sliceId === sliceId || v.sliceId === null));
  return last === undefined ? null : Date.parse(last.createdAt);
}

/** Labelled outcomes on the slice since its last change; a change older than the window has long passed the floor. */
function labelledSinceChange(state: LearningState, sliceId: string): number {
  const since = lastChangeAt(state, sliceId);
  if (since === null) return Number.POSITIVE_INFINITY;
  const newest = state.events.length === 0 ? since : Math.max(...state.events.map((e) => Date.parse(e.at)));
  if (since < newest - LEARNING_LIMITS.windowDays * DAY_MS) return Number.POSITIVE_INFINITY;
  return labelsFor(state.events, sliceId).filter((l) => l.label !== 'unlabelled' && Date.parse(l.at) > since).length;
}

/** Verified tasks each arm needs locally before its realized economics per verified task decide. */
export const ECONOMICS_MIN_VERIFIED = 5;

/**
 * The realized economics of a cheaper arm against the default, per verified task (§22.2 in use):
 * each arm's spend over every route it ran, retries and failures included, over its verified
 * successes. Dollars are billed dollars with the API-equivalent estimate standing in where a route
 * was not billed. Null until both arms have `ECONOMICS_MIN_VERIFIED` verified tasks and the
 * resource the objective weighs is observed on both:
 * - `api-key`: the candidate must cost fewer dollars per verified task;
 * - `subscription`: it must use less quota-weighted usage per verified task, or be at least 10%
 *   faster per verified task at no more than 10% more usage;
 * - `unknown`: fewer dollars, and no more usage where usage is observed on both.
 */
export function realizedEconomics(c: ArmStats, b: ArmStats, objective: AuthMode): { readonly reason: 'NOT_CHEAPER_PER_VERIFIED' | 'MORE_USAGE_PER_VERIFIED' | null } | null {
  if (c.successes < ECONOMICS_MIN_VERIFIED || b.successes < ECONOMICS_MIN_VERIFIED) return null;
  const dollars = (a: ArmStats) => a.apiEquivalentPerVerifiedMicroUsd ?? null;
  const usage = (a: ArmStats) => a.usagePerVerified ?? null;
  const wall = (a: ArmStats) => a.wallMsPerVerified ?? null;
  const cd = dollars(c);
  const bd = dollars(b);
  const cu = usage(c);
  const bu = usage(b);
  if (objective === 'subscription') {
    if (cu === null || bu === null) return null;
    if (cu < bu) return { reason: null };
    const cw = wall(c);
    const bw = wall(b);
    const faster = cw !== null && bw !== null && cw <= 0.9 * bw;
    return { reason: faster && cu <= 1.1 * bu ? null : 'MORE_USAGE_PER_VERIFIED' };
  }
  if (cd === null || bd === null) return null;
  if (cd >= bd) return { reason: 'NOT_CHEAPER_PER_VERIFIED' };
  if (objective === 'unknown' && cu !== null && bu !== null && cu > bu) return { reason: 'MORE_USAGE_PER_VERIFIED' };
  return { reason: null };
}

/**
 * The resource side of an activation, by how the harness is billed:
 * - `api-key`: real dollars, so the candidate must cost less;
 * - `subscription`: the candidate must use less of the usage limit (quota-weighted tokens), or be
 *   at least 10% faster at no more than 10% more usage, and must not hit the limit more often by
 *   more than the margin;
 * - `unknown`: both.
 * With fewer than 3 local resource observations on either arm, the other workspaces on this
 * machine decide when both arms have `ECONOMICS_MIN_VERIFIED` verified tasks there; then the signed release's measured
 * per-arm cost and tokens decide when it carries them for both (the seed); then, for two efforts
 * of one model, the documented order of effort levels (a lower level spends fewer tokens); then
 * the registry's list prices at a standard task (a cheaper tariff uses less of a subscription too,
 * and a cheaper model is taken only at or below its default effort); with none of these, no.
 */
function resourceCheck(c: ArmStats, b: ArmStats, objective: AuthMode, margin: number, registry: ModelRegistry | undefined, priors: readonly BaselinePrior[], quotaWeights: LearningSettings['quotaWeights'], machine: { readonly c: ArmStats | null; readonly b: ArmStats | null } = { c: null, b: null }, servingHost: string | null = null): { readonly reason: string | null; readonly basis: NonNullable<PromotionEvidence['resourceBasis']> | null } {
  const limitShare = (a: ArmStats) => a.usageLimited / Math.max(1, a.labelled + a.usageLimited);
  if (objective === 'subscription' && limitShare(c) > limitShare(b) + margin) return { reason: 'MORE_USAGE_LIMITED', basis: 'local' };
  // With enough verified tasks on both arms, what a verified task really cost decides.
  const realized = realizedEconomics(c, b, objective);
  if (realized !== null) return { reason: realized.reason, basis: 'local' };
  const localCost = c.meanCostMicroUsd !== null && b.meanCostMicroUsd !== null;
  const localUsage = c.meanWeightedUsage !== null && b.meanWeightedUsage !== null;
  const enough = (a: ArmStats) => a.labelled + a.staleOrCancelled >= 3;
  const cheaperLocal = localCost && (c.meanCostMicroUsd as number) < (b.meanCostMicroUsd as number);
  const lessUsageLocal = localUsage && (c.meanWeightedUsage as number) < (b.meanWeightedUsage as number);
  if (enough(c) && enough(b) && (localCost || localUsage)) {
    const local = (reason: string | null) => ({ reason, basis: 'local' as const });
    if (objective === 'api-key') return local(cheaperLocal ? null : 'NOT_CHEAPER');
    if (objective === 'subscription') {
      if (lessUsageLocal) return local(null);
      const lat = (a: ArmStats) => a.meanLatencyMs ?? a.medianLatencyMs ?? null;
      const faster = lat(c) !== null && lat(b) !== null && (lat(c) as number) <= 0.9 * (lat(b) as number);
      const notMuchMore = localUsage && (c.meanWeightedUsage as number) <= 1.1 * (b.meanWeightedUsage as number);
      return local(faster && notMuchMore ? null : 'NO_USAGE_OR_LATENCY_GAIN');
    }
    if (!cheaperLocal) return local('NOT_CHEAPER');
    return local(localUsage && !lessUsageLocal ? 'MORE_USAGE' : null);
  }
  // Next, what a verified task cost in the other workspaces on this machine.
  if (machine.c !== null && machine.b !== null) {
    const shared = realizedEconomics(machine.c, machine.b, objective);
    if (shared !== null) return { reason: shared.reason, basis: 'machine' };
  }
  const pc = priors.find((p) => armOfPrior(p) === c.armId);
  const pb = priors.find((p) => armOfPrior(p) === b.armId);
  const measuredCost = typeof pc?.meanCostMicroUsd === 'number' && typeof pb?.meanCostMicroUsd === 'number';
  const measuredTokens = typeof pc?.meanTokens === 'number' && typeof pb?.meanTokens === 'number';
  const measured = (reason: string | null) => ({ reason, basis: 'measured' as const });
  if (objective === 'api-key' && measuredCost) return measured((pc?.meanCostMicroUsd as number) < (pb?.meanCostMicroUsd as number) ? null : 'NOT_CHEAPER_MEASURED');
  if (objective === 'subscription' && measuredTokens) {
    const weight = (modelId: string) => quotaWeights[modelId] ?? 1;
    return measured((pc?.meanTokens as number) * weight(c.modelId) < (pb?.meanTokens as number) * weight(b.modelId) ? null : 'MORE_USAGE_MEASURED');
  }
  if (objective === 'unknown' && measuredCost && measuredTokens) {
    if ((pc?.meanCostMicroUsd as number) >= (pb?.meanCostMicroUsd as number)) return measured('NOT_CHEAPER_MEASURED');
    return measured((pc?.meanTokens as number) > (pb?.meanTokens as number) ? 'MORE_USAGE_MEASURED' : null);
  }
  if (c.modelId === b.modelId) {
    const rc = effortRank(c.modelId, c.effort, registry);
    const rb = effortRank(b.modelId, b.effort, registry);
    if (rc === null || rb === null) return { reason: 'RESOURCE_UNKNOWN', basis: null };
    return { reason: rc < rb ? null : 'MORE_EFFORT', basis: 'effort-order' };
  }
  if (registry === undefined) return { reason: 'RESOURCE_UNKNOWN', basis: null };
  const cm = registryModel(registry, c.modelId);
  const bm = registryModel(registry, b.modelId);
  if (cm === null || bm === null) return { reason: 'RESOURCE_UNKNOWN', basis: null };
  // R49 (design 6.4, OQ-4): both sides at their tariff on the session's serving host; a side
  // priced only by the maker's list price as an estimate never promotes on price.
  const cp = hostTariff(registry, servingHost, cm);
  const bp = hostTariff(registry, servingHost, bm);
  if (cp === null || bp === null) return { reason: 'RESOURCE_UNKNOWN', basis: null };
  if (generationCostMicroUsd(cp, STANDARD_TASK) >= generationCostMicroUsd(bp, STANDARD_TASK)) return { reason: 'NOT_CHEAPER_LIST_PRICE', basis: 'list-price' };
  // A cheaper tariff says nothing about a level above the model's default, or a baseline below its own.
  const above = (a: ArmStats) => a.effort !== null && (effortRank(a.modelId, a.effort, registry) ?? 0) > (effortRank(a.modelId, null, registry) ?? 0);
  const below = b.effort !== null && (effortRank(b.modelId, b.effort, registry) ?? 0) < (effortRank(b.modelId, null, registry) ?? 0);
  return above(c) || below ? { reason: 'RESOURCE_UNKNOWN', basis: null } : { reason: null, basis: 'list-price' };
}

/**
 * R49: a model's tariff through the session's serving host, known only. A pinned gateway or host
 * gives its snapshot tariff; a maker id, null or anything else is the model's own maker. Null when
 * the tariff there is only the maker's price as an estimate.
 */
function hostTariff(registry: ModelRegistry, servingHost: string | null, model: { readonly provider: string; readonly modelId: string }): RoutingModelTariff | null {
  const host = servingHost !== null && servingHostOf(servingHost) !== undefined ? servingHost : model.provider;
  const priced = servingTariff(registry, host, model.provider, model.modelId);
  return priced === null || priced.basis !== 'host' ? null : priced.tariff;
}
type RoutingModelTariff = NonNullable<ReturnType<typeof servingTariff>>['tariff'];

/** A costlier arm of the baseline model is weighed as an upgrade on these resource answers. */
const COSTLIER = new Set(['MORE_EFFORT', 'NOT_CHEAPER', 'NOT_CHEAPER_MEASURED', 'MORE_USAGE', 'MORE_USAGE_MEASURED', 'NO_USAGE_OR_LATENCY_GAIN', 'NOT_CHEAPER_PER_VERIFIED', 'MORE_USAGE_PER_VERIFIED']);

/** One arm's progress toward the local-evidence guard. */
export interface GuardArm {
  readonly armId: string;
  /** This workspace's randomized, labelled outcomes on the arm. */
  readonly local: number;
  /** How many more it needs before the slice may switch to or from it. */
  readonly remaining: number;
}

/** Local randomized, labelled outcomes on an arm (the guard counts only this workspace's own). */
function localRandomized(state: LearningState, sliceId: string, armId: string): number {
  return state.arms[sliceId]?.[armId]?.randomizedLabelled ?? 0;
}

/**
 * The local-evidence guard (§18.5's pre-registered number per arm; DOMAINS 223a21f): a switch to
 * `armId` needs `minLocalPerArm` of this workspace's own randomized, labelled outcomes on it and on
 * the default. Returns the arms still short (empty when the switch may go ahead).
 */
export function localEvidenceShortfall(state: LearningState, sliceId: string, armId: string, defaultArmId: string): readonly GuardArm[] {
  const n = state.settings.minLocalPerArm;
  return [defaultArmId, armId]
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => ({ armId: id, local: localRandomized(state, sliceId, id), remaining: Math.max(0, n - localRandomized(state, sliceId, id)) }))
    .filter((g) => g.remaining > 0);
}

export type ReconcileResult =
  | { readonly outcome: 'no-change'; readonly reasonCode: string; readonly evidence: PromotionEvidence | null; readonly state: LearningState; readonly waitingFor?: readonly GuardArm[] }
  | { readonly outcome: 'proposed'; readonly proposal: LearningProposal; readonly state: LearningState }
  | { readonly outcome: 'activated'; readonly version: PolicyVersion; readonly state: LearningState }
  | { readonly outcome: 'demoted'; readonly reasonCode: 'POSTERIOR_REGRESSION' | 'WINDOW_REGRESSION' | 'MODEL_INELIGIBLE' | 'BASELINE_CHANGED' | 'NOT_CHEAPER_PER_VERIFIED' | 'MORE_USAGE_PER_VERIFIED'; readonly version: PolicyVersion; readonly state: LearningState };

/**
 * R9 (owner decision OD-5): which resource an arm is weighed on. Subscription usage is compared
 * only within one vendor's pool (a Codex allowance and a Claude allowance are not one currency).
 * When the candidate and the baseline are registered under different providers and the auth mode
 * is not already an API key, the comparison is in API-equivalent dollars, labelled an estimate.
 * An unregistered model keeps the auth mode's objective (the resource check then says unknown).
 */
export function resourceObjective(objective: AuthMode, candidateModelId: string, baselineModelId: string, registry: ModelRegistry | undefined): { readonly objective: AuthMode; readonly crossVendor: boolean } {
  if (objective === 'api-key' || registry === undefined) return { objective, crossVendor: false };
  const c = registryModel(registry, candidateModelId);
  const b = registryModel(registry, baselineModelId);
  if (c === null || b === null || c.provider === b.provider) return { objective, crossVendor: false };
  return { objective: 'api-key', crossVendor: true };
}

function evidenceOf(state: LearningState, sliceId: string, c: ArmPosterior, b: ArmPosterior, harm: number, objective: AuthMode, extra: Pick<PromotionEvidence, 'direction' | 'notBetterProbability' | 'resourceBasis' | 'crossVendor'> = {}): PromotionEvidence {
  const sd = Math.sqrt((c.alpha * c.beta) / ((c.alpha + c.beta) ** 2 * (c.alpha + c.beta + 1)) + (b.alpha * b.beta) / ((b.alpha + b.beta) ** 2 * (b.alpha + b.beta + 1)));
  const candidate = statsOf(state, sliceId, c.armId);
  const baseline = statsOf(state, sliceId, b.armId);
  return {
    sliceId,
    candidate,
    baseline,
    differenceLower: round(c.mean - b.mean - 1.281552 * sd),
    margin: state.settings.nonInferiorityMargin,
    minPerArm: state.settings.flapFloor,
    eventCount: candidate.labelled + baseline.labelled,
    objective,
    harmProbability: round(harm),
    candidatePosterior: c,
    baselinePosterior: b,
    ...(extra.direction === undefined ? {} : { direction: extra.direction }),
    ...(extra.notBetterProbability === undefined ? {} : { notBetterProbability: round(extra.notBetterProbability) }),
    ...(extra.resourceBasis === undefined ? {} : { resourceBasis: extra.resourceBasis }),
    ...(extra.crossVendor === true ? { crossVendor: true as const } : {}),
  };
}

/** P(the candidate is not better than the baseline): 1 − P(q_b < q_c). */
function notBetterProbability(c: ArmPosterior, b: ArmPosterior): number {
  return clamp(1 - harmProbability(b, c, 0), 0, 1);
}

/** The slice policy for an active arm (effort and direction only when they are not the defaults). */
function activePolicy(evidence: PromotionEvidence, baselineModelId: string, baselineRate: number): SlicePolicy {
  return {
    mode: 'auto',
    modelId: evidence.candidate.modelId,
    ...(evidence.candidate.effort === null ? {} : { effort: evidence.candidate.effort }),
    ...(evidence.direction === 'upgrade' ? { direction: 'upgrade' as const } : {}),
    baselineModelId,
    baselineRate,
  };
}

/**
 * Brings one slice's policy in line with its posterior. Pinned slices and a workspace with
 * learning off never change. An active arm is demoted at once (to the baseline model at its
 * default effort) when it stops being eligible (its model, or its effort on that model), when the
 * baseline model changed, when its harm probability rises above `deactivateAbove` (for an upgrade,
 * also when P(not better) does), when the recent window shows it confidently below the
 * baseline by more than the margin, or, for a cheaper arm, when its realized cost per verified
 * task is not below the default's (`realizedEconomics`). Otherwise the cheapest eligible arm whose harm probability is
 * below `activateBelow` is activated (or proposed in review mode), once the local-evidence guard
 * (`minLocalPerArm` of this workspace's randomized outcomes on both arms) and the flap floor are met;
 * with no cheaper arm supported, a costlier effort of the baseline model that is probably better
 * (P(not better) below `activateBelow`) is. `priors` refreshes the slice's baseline snapshot.
 */
export function reconcileSlice(input: {
  readonly state: LearningState;
  readonly sliceId: string;
  readonly baselineModelId: string;
  readonly eligibleModelIds: readonly string[];
  readonly now: string;
  readonly authMode?: AuthMode;
  readonly priors?: SliceBaseline | null;
  readonly registry?: ModelRegistry;
  /**
   * R49: the serving host the slice's routes run through (the session's host). A gateway prices the
   * list-price comparison at its tariffs; absent or null, each model at its own maker's.
   */
  readonly servingHost?: string | null;
  /** Tests only: overrides the owner-locked readiness for automatic activation. */
  readonly automaticAllowed?: boolean;
}): ReconcileResult {
  const { sliceId, baselineModelId } = input;
  let state = input.state;
  if (input.priors !== undefined && input.priors !== null && JSON.stringify(state.baseline[sliceId]) !== JSON.stringify(input.priors)) {
    state = { ...state, baseline: { ...state.baseline, [sliceId]: input.priors } };
  }
  const objective = input.authMode ?? 'unknown';
  const policy = slicePolicy(state, sliceId);
  if (policy.mode === 'pinned') return { outcome: 'no-change', reasonCode: 'SLICE_PINNED', evidence: null, state };
  if (!state.settings.enabled) return { outcome: 'no-change', reasonCode: 'LEARNING_OFF', evidence: null, state };
  const margin = state.settings.nonInferiorityMargin;
  const priors = state.baseline[sliceId]?.priors ?? [];
  const b = armPosterior(state, sliceId, baselineModelId);
  const eligible = new Set(input.eligibleModelIds);
  const armEligible = (modelId: string, effort: string | null) => eligible.has(modelId) && effortSupported(modelId, effort, input.registry);
  const demote = (reasonCode: Extract<ReconcileResult, { outcome: 'demoted' }>['reasonCode'], evidence: PromotionEvidence | null): ReconcileResult => {
    // Back to the baseline model at its default effort.
    const next = withVersion(state, { createdAt: input.now, reason: 'demotion', reasonCode, sliceId, slices: setSlice(activeVersion(state).slices, sliceId, { mode: 'advise', modelId: null, baselineModelId, baselineRate: b.mean }), evidence });
    return { outcome: 'demoted', reasonCode, version: activeVersion(next), state: next };
  };
  if (policy.mode === 'auto' && policy.modelId !== null) {
    const effort = policy.effort ?? null;
    if (!armEligible(policy.modelId, effort)) return demote('MODEL_INELIGIBLE', null);
    if (policy.baselineModelId !== null && policy.baselineModelId !== baselineModelId) return demote('BASELINE_CHANGED', null);
    const arm = armKey(policy.modelId, effort, input.registry);
    const c = armPosterior(state, sliceId, arm);
    const harm = harmProbability(c, b, margin);
    const upgrade = policy.direction === 'upgrade';
    const notBetter = upgrade ? notBetterProbability(c, b) : undefined;
    const weighed = resourceObjective(objective, policy.modelId, baselineModelId, input.registry);
    const vendor = weighed.crossVendor ? { crossVendor: true as const } : {};
    const evidence = evidenceOf(state, sliceId, c, b, harm, weighed.objective, upgrade ? { direction: 'upgrade', notBetterProbability: notBetter as number, ...vendor } : vendor);
    if (harm > state.settings.deactivateAbove) return demote('POSTERIOR_REGRESSION', evidence);
    if (upgrade && (notBetter as number) > state.settings.deactivateAbove) return demote('POSTERIOR_REGRESSION', evidence);
    const since = lastChangeAt(state, sliceId);
    const recent = labelsFor(state.events, sliceId, arm)
      .filter((l) => l.label !== 'unlabelled' && (since === null || Date.parse(l.at) >= since))
      .slice(-state.settings.demotionWindow);
    if (recent.length >= Math.min(10, state.settings.demotionWindow)) {
      // One-sided 99.9%: the window is re-checked after every outcome, so a looser bound would demote sound candidates by chance.
      const ci = wilsonInterval(recent.filter((l) => l.label === 'success').length, recent.length, 3.090232) as { readonly lower: number; readonly upper: number };
      if (ci.upper < b.mean - margin) return demote('WINDOW_REGRESSION', evidence);
    }
    // A cheaper arm that is not cheaper per verified task in practice (retries and failures
    // included) returns to the default. An upgrade costs more by design and stays on the rules above.
    if (!upgrade) {
      const realized = realizedEconomics(evidence.candidate, evidence.baseline, weighed.objective);
      if (realized !== null && realized.reason !== null) return demote(realized.reason, { ...evidence, resourceBasis: 'local' });
    }
    return { outcome: 'no-change', reasonCode: 'WITHIN_MARGIN', evidence, state };
  }
  // Advise (implicit or after a demotion): the cheapest arm the posterior supports, else a probable upgrade.
  const candidates: { readonly evidence: PromotionEvidence; readonly spend: number; readonly rank: number }[] = [];
  const upgrades: { readonly evidence: PromotionEvidence; readonly mean: number }[] = [];
  let first: { readonly reasonCode: string; readonly evidence: PromotionEvidence } | null = null;
  const note = (reasonCode: string, evidence: PromotionEvidence) => {
    if (first === null || (first.reasonCode === 'CANDIDATE_NOT_ELIGIBLE' && reasonCode !== 'CANDIDATE_NOT_ELIGIBLE')) first = { reasonCode, evidence };
  };
  const shared = sharedSliceOf(state.settings, sliceId);
  const machineArms = shared === null || state.machinePrior === undefined ? [] : Object.keys(state.machinePrior.arms[shared] ?? {});
  const arms = new Set([...Object.keys(state.arms[sliceId] ?? {}), ...priors.map(armOfPrior), ...machineArms]);
  for (const arm of [...arms].sort()) {
    if (arm === baselineModelId) continue;
    const { modelId, effort } = parseArmKey(arm);
    const c = armPosterior(state, sliceId, arm);
    const harm = harmProbability(c, b, margin);
    // R9 (OD-5): across vendors, API-equivalent dollars, not either vendor's usage pool.
    const weighed = resourceObjective(objective, modelId, baselineModelId, input.registry);
    const base = evidenceOf(state, sliceId, c, b, harm, weighed.objective, weighed.crossVendor ? { crossVendor: true } : {});
    if (!armEligible(modelId, effort)) {
      note('CANDIDATE_NOT_ELIGIBLE', base);
      continue;
    }
    if (harm >= state.settings.activateBelow) {
      note('NOT_SUPPORTED', base);
      continue;
    }
    const machine = { c: machineStats(state, sliceId, arm), b: machineStats(state, sliceId, baselineModelId) };
    const resource = resourceCheck(base.candidate, base.baseline, weighed.objective, margin, input.registry, priors, state.settings.quotaWeights, machine, input.servingHost ?? null);
    const evidence = resource.basis === null ? base : { ...base, resourceBasis: resource.basis };
    if (resource.reason === null) {
      const model = input.registry === undefined ? null : registryModel(input.registry, modelId);
      // R49: ranked at the tariff on the session's host where known, else the maker's list price.
      const listed = model === null || input.registry === undefined ? 0 : generationCostMicroUsd(hostTariff(input.registry, input.servingHost ?? null, model) ?? model.tariff, STANDARD_TASK);
      const prior = priors.find((p) => armOfPrior(p) === arm);
      const measured = weighed.objective === 'subscription' ? (prior?.meanTokens ?? null) : (prior?.meanCostMicroUsd ?? null);
      const localSpend = weighed.objective === 'subscription' ? evidence.candidate.meanWeightedUsage : evidence.candidate.meanCostMicroUsd;
      const machineSpend = machine.c === null ? null : ((weighed.objective === 'subscription' ? machine.c.usagePerVerified : machine.c.apiEquivalentPerVerifiedMicroUsd) ?? null);
      candidates.push({ evidence, spend: localSpend ?? machineSpend ?? measured ?? listed, rank: effortRank(modelId, effort, input.registry) ?? 0 });
    } else if (modelId === baselineModelId && COSTLIER.has(resource.reason)) {
      const notBetter = notBetterProbability(c, b);
      const upgrade = { ...evidence, direction: 'upgrade' as const, notBetterProbability: round(notBetter) };
      if (notBetter < state.settings.activateBelow) upgrades.push({ evidence: upgrade, mean: c.mean });
      else note('NOT_BETTER', upgrade);
    } else note(resource.reason, evidence);
  }
  const saving = candidates.sort((x, y) => x.spend - y.spend || x.rank - y.rank || (x.evidence.candidate.armId < y.evidence.candidate.armId ? -1 : 1))[0]?.evidence;
  const best = saving ?? upgrades.sort((x, y) => y.mean - x.mean || (x.evidence.candidate.armId < y.evidence.candidate.armId ? -1 : 1))[0]?.evidence;
  const firstSeen = first as { readonly reasonCode: string; readonly evidence: PromotionEvidence } | null;
  if (best === undefined) return { outcome: 'no-change', reasonCode: firstSeen?.reasonCode ?? 'NO_CANDIDATE', evidence: firstSeen?.evidence ?? null, state };
  // No switch without this workspace's own outcomes on both arms: a baseline or the machine prior
  // shapes the posterior, but never switches a slice alone.
  const short = localEvidenceShortfall(state, sliceId, best.candidate.armId, baselineModelId);
  if (short.length > 0) return { outcome: 'no-change', reasonCode: 'LOCAL_EVIDENCE_SHORT', evidence: best, state, waitingFor: short };
  if (sliceSet(state, sliceId) && labelledSinceChange(state, sliceId) < state.settings.flapFloor) return { outcome: 'no-change', reasonCode: 'FLAP_FLOOR', evidence: best, state };
  const next = activePolicy(best, baselineModelId, b.mean);
  const automatic = state.settings.promotionMode === 'automatic' && (input.automaticAllowed ?? automaticPromotionReady().ready);
  if (automatic) {
    const fromBaselineOnly = best.candidate.labelled === 0 && best.baseline.labelled === 0;
    const changed = withVersion(state, {
      createdAt: input.now,
      reason: fromBaselineOnly ? 'baseline' : 'promotion',
      reasonCode: fromBaselineOnly ? 'BASELINE_SUPPORTED' : best.direction === 'upgrade' ? 'POSTERIOR_BETTER' : 'POSTERIOR_NON_INFERIOR',
      sliceId,
      slices: setSlice(activeVersion(state).slices, sliceId, next),
      evidence: best,
    });
    return { outcome: 'activated', version: activeVersion(changed), state: changed };
  }
  const effort = best.candidate.effort;
  const pending = state.proposals.find((p) => p.status === 'pending' && p.sliceId === sliceId && p.modelId === best.candidate.modelId && (p.effort ?? null) === effort);
  if (pending !== undefined) return { outcome: 'proposed', proposal: pending, state };
  const basedOnVersion = activeVersion(state).version;
  const body = {
    sliceId,
    modelId: best.candidate.modelId,
    ...(effort === null ? {} : { effort }),
    ...(best.direction === 'upgrade' ? { direction: 'upgrade' as const } : {}),
    baselineModelId,
    createdAt: input.now,
    basedOnVersion,
    evidence: best,
  };
  const proposal: LearningProposal = { ...body, proposalId: `lp-${contentHash(body).slice(7, 23)}`, status: 'pending' };
  const proposals = [...state.proposals.map((p) => (p.status === 'pending' && p.sliceId === sliceId ? { ...p, status: 'superseded' as const } : p)), proposal].slice(-LEARNING_LIMITS.maxProposals);
  return { outcome: 'proposed', proposal, state: { ...state, proposals } };
}

/** The user accepts a pending proposal (review mode): the slice turns automatic in a new version. */
export function acceptProposal(state: LearningState, proposalId: string, now: string): { readonly ok: true; readonly state: LearningState; readonly version: PolicyVersion } | { readonly ok: false; readonly reasonCode: 'PROPOSAL_UNKNOWN' | 'PROPOSAL_NOT_PENDING' | 'SLICE_PINNED' } {
  const proposal = state.proposals.find((p) => p.proposalId === proposalId);
  if (proposal === undefined) return { ok: false, reasonCode: 'PROPOSAL_UNKNOWN' };
  if (proposal.status !== 'pending') return { ok: false, reasonCode: 'PROPOSAL_NOT_PENDING' };
  if (slicePolicy(state, proposal.sliceId).mode === 'pinned') return { ok: false, reasonCode: 'SLICE_PINNED' };
  const policy: SlicePolicy = {
    mode: 'auto',
    modelId: proposal.modelId,
    ...(proposal.effort === undefined || proposal.effort === null ? {} : { effort: proposal.effort }),
    ...(proposal.direction === 'upgrade' ? { direction: 'upgrade' as const } : {}),
    baselineModelId: proposal.baselineModelId,
    baselineRate: proposal.evidence.baseline.rate,
  };
  const next = withVersion(
    { ...state, proposals: state.proposals.map((p) => (p.proposalId === proposalId ? { ...p, status: 'accepted' as const } : p)) },
    { createdAt: now, reason: 'accepted-proposal', reasonCode: 'USER_ACCEPTED', sliceId: proposal.sliceId, slices: setSlice(activeVersion(state).slices, proposal.sliceId, policy), evidence: proposal.evidence },
  );
  return { ok: true, state: next, version: activeVersion(next) };
}

/** The user rejects a pending proposal; nothing changes in the policy. */
export function rejectProposal(state: LearningState, proposalId: string): LearningState {
  return { ...state, proposals: state.proposals.map((p) => (p.proposalId === proposalId && p.status === 'pending' ? { ...p, status: 'rejected' as const } : p)) };
}

/**
 * Pins a slice to a model and effort (or to advice only with a null model): learning never changes
 * a pinned slice. A null effort, or the model's default, pins the model at its default effort.
 */
export function pinSlice(state: LearningState, sliceId: string, modelId: string | null, now: string, effort: string | null = null, registry?: ModelRegistry): LearningState {
  if (!ID.test(sliceId) || (modelId !== null && !ID.test(modelId))) throw new Error('invalid slice or model id');
  if (effort !== null && (!isEffortLevel(effort) || modelId === null)) throw new Error('invalid effort');
  const pinnedEffort = modelId === null || effort === null || armKey(modelId, effort, registry) === modelId ? null : effort;
  const policy: SlicePolicy = { mode: 'pinned', modelId, ...(pinnedEffort === null ? {} : { effort: pinnedEffort }), baselineModelId: null, baselineRate: null };
  return withVersion(state, { createdAt: now, reason: 'pin', reasonCode: modelId === null ? 'PINNED_ADVISE' : 'PINNED_MODEL', sliceId, slices: setSlice(activeVersion(state).slices, sliceId, policy), evidence: null });
}

/** Removes a pin: the slice returns to what the baseline and the posterior say. */
export function unpinSlice(state: LearningState, sliceId: string, now: string): LearningState {
  if (slicePolicy(state, sliceId).mode !== 'pinned') return state;
  return withVersion(state, { createdAt: now, reason: 'unpin', reasonCode: 'UNPINNED', sliceId, slices: setSlice(activeVersion(state).slices, sliceId, null), evidence: null });
}

/**
 * Resets every slice to the day-1 baseline (the signed release decides again). The local outcomes
 * are kept unless `clearEvidence`, which also empties the aggregate and the window.
 */
export function resetLearning(state: LearningState, now: string, options: { readonly clearEvidence?: boolean } = {}): LearningState {
  const next = withVersion(state, { createdAt: now, reason: 'reset', reasonCode: options.clearEvidence === true ? 'RESET_AND_CLEARED' : 'RESET', sliceId: null, slices: {}, evidence: null });
  // Clearing the evidence also empties this workspace's machine contribution (`withdrawMachineContribution` removes its file).
  const machine = next.machine === undefined ? {} : { machine: { ...next.machine, arms: {}, limits: {} } };
  return options.clearEvidence === true ? { ...next, arms: {}, events: [], proposals: [], ...machine } : { ...next, proposals: next.proposals.map((p) => (p.status === 'pending' ? { ...p, status: 'superseded' as const } : p)) };
}

/** Restores an earlier version's policy as a new version (history is never rewritten). */
export function rollbackLearning(state: LearningState, version: number, now: string): { readonly ok: true; readonly state: LearningState } | { readonly ok: false; readonly reasonCode: 'VERSION_UNKNOWN' } {
  const target = state.versions.find((v) => v.version === version);
  if (target === undefined) return { ok: false, reasonCode: 'VERSION_UNKNOWN' };
  return { ok: true, state: withVersion(state, { createdAt: now, reason: 'rollback', reasonCode: `ROLLBACK_TO_V${String(version)}`, sliceId: null, slices: target.slices, evidence: null }) };
}

export interface SliceAttribution {
  readonly sliceId: string;
  readonly routes: number;
  readonly agreedWithRules: number;
  readonly differedFromRules: number;
  readonly agreedSuccessRate: number | null;
  readonly differedSuccessRate: number | null;
  /** The rules-only counterfactual outcome is not observed where the choices differ. */
  readonly savingClaim: null;
}

/** Arm C over the recent window: how often the chosen model matched the rules-only choice, and outcomes each way. */
export function rulesAttribution(state: LearningState): readonly SliceAttribution[] {
  const labels = routeLabels(state.events);
  const rate = (ls: readonly RouteLabel[]) => {
    const l = ls.filter((x) => x.label !== 'unlabelled');
    return l.length === 0 ? null : round(l.filter((x) => x.label === 'success').length / l.length);
  };
  return [...new Set(labels.map((l) => l.sliceId))].sort().map((sliceId) => {
    const mine = labels.filter((l) => l.sliceId === sliceId && l.rulesModelId !== null);
    const agreed = mine.filter((l) => l.rulesModelId === l.modelId);
    const differed = mine.filter((l) => l.rulesModelId !== l.modelId);
    return { sliceId, routes: mine.length, agreedWithRules: agreed.length, differedFromRules: differed.length, agreedSuccessRate: rate(agreed), differedSuccessRate: rate(differed), savingClaim: null };
  });
}

/**
 * A route's usage priced at the registry's list tariff: its API-equivalent cost, for a
 * subscription route that has no billed dollars. Null when the registry does not know the model.
 */
export function apiEquivalentCostMicroUsd(registry: ModelRegistry, modelId: string, volume: TokenVolume, servingHost: string | null = null): number | null {
  const model = registryModel(registry, modelId);
  if (model === null) return null;
  // R49: through a pinned gateway or host, its snapshot tariff; where that is not known, the
  // maker's list price stands in (an estimate, as the economics lines say).
  const host = servingHost !== null && servingHostOf(servingHost) !== undefined ? servingHost : model.provider;
  return generationCostMicroUsd(servingTariff(registry, host, model.provider, model.modelId)?.tariff ?? model.tariff, volume);
}

/** One arm's economics per verified task, against the approved default arm. */
export interface ArmEconomics {
  readonly armId: string;
  readonly modelId: string;
  readonly effort: string | null;
  readonly isDefault: boolean;
  readonly routes: number;
  readonly verified: number;
  /** Billed dollars per verified task (API key); null when no route of the arm was billed. */
  readonly costPerVerifiedMicroUsd: number | null;
  /** Billed dollars, with the API-equivalent estimate for unbilled (subscription) routes. */
  readonly apiEquivalentPerVerifiedMicroUsd: number | null;
  readonly tokensPerVerified: number | null;
  /** Quota-weighted tokens per verified task: the usage-limit consumption on a subscription. */
  readonly usagePerVerified: number | null;
  readonly wallMsPerVerified: number | null;
  /** This arm's figure over the default's (below 1 is better); null when either is unknown. */
  readonly costRatioVsDefault: number | null;
  readonly usageRatioVsDefault: number | null;
  readonly wallRatioVsDefault: number | null;
}

/** A slice's economics per verified task (§22.2 in use), every arm against the approved default. */
export interface SliceEconomics {
  readonly defaultArmId: string;
  /** Verified tasks each arm needs before its realized economics can revert a cheaper arm. */
  readonly minVerified: number;
  readonly arms: readonly ArmEconomics[];
}

function ratio(x: number | null | undefined, y: number | null | undefined): number | null {
  return x === null || x === undefined || y === null || y === undefined || y <= 0 ? null : round(x / y, 4);
}

/**
 * Cost and wall time per verified task for every arm the slice has run, the default arm included
 * (listed first), each against the default. `defaultArmId` is the approved default (the registry's
 * baseline model at its default effort unless the slice names another baseline).
 */
export function sliceEconomics(state: LearningState, sliceId: string, defaultArmId: string): SliceEconomics {
  const ids = [...new Set([defaultArmId, ...Object.keys(state.arms[sliceId] ?? {})])];
  const stats = ids.map((id) => statsOf(state, sliceId, id));
  const d = stats[0] as ArmStats;
  const arms = stats.map((a): ArmEconomics => ({
    armId: a.armId,
    modelId: a.modelId,
    effort: a.effort,
    isDefault: a.armId === defaultArmId,
    routes: a.routes ?? 0,
    verified: a.successes,
    costPerVerifiedMicroUsd: a.costPerVerifiedMicroUsd ?? null,
    apiEquivalentPerVerifiedMicroUsd: a.apiEquivalentPerVerifiedMicroUsd ?? null,
    tokensPerVerified: a.tokensPerVerified ?? null,
    usagePerVerified: a.usagePerVerified ?? null,
    wallMsPerVerified: a.wallMsPerVerified ?? null,
    costRatioVsDefault: ratio(a.apiEquivalentPerVerifiedMicroUsd, d.apiEquivalentPerVerifiedMicroUsd),
    usageRatioVsDefault: ratio(a.usagePerVerified, d.usagePerVerified),
    wallRatioVsDefault: ratio(a.wallMsPerVerified, d.wallMsPerVerified),
  }));
  return { defaultArmId, minVerified: ECONOMICS_MIN_VERIFIED, arms };
}

function dollars(micro: number | null): string {
  return micro === null ? 'n/a' : `$${(micro / 1e6).toFixed(4)}`;
}

function minutes(ms: number | null): string {
  return ms === null ? 'n/a' : `${(ms / 60_000).toFixed(1)} min`;
}

function economicsLine(a: ArmEconomics, defaultLabel: string): string {
  const cost = a.costPerVerifiedMicroUsd !== null && a.costPerVerifiedMicroUsd === a.apiEquivalentPerVerifiedMicroUsd ? `${dollars(a.costPerVerifiedMicroUsd)} billed` : a.costPerVerifiedMicroUsd === null ? `${dollars(a.apiEquivalentPerVerifiedMicroUsd)} API-equivalent` : `${dollars(a.costPerVerifiedMicroUsd)} billed, ${dollars(a.apiEquivalentPerVerifiedMicroUsd)} with the API-equivalent estimate`;
  const usage = a.tokensPerVerified === null ? '' : `, ${String(a.tokensPerVerified)} tokens`;
  const vs = a.isDefault ? ' (the default)' : ` (vs ${defaultLabel}: cost ${a.costRatioVsDefault === null ? 'n/a' : `${a.costRatioVsDefault.toFixed(2)}x`}, usage ${a.usageRatioVsDefault === null ? 'n/a' : `${a.usageRatioVsDefault.toFixed(2)}x`}, time ${a.wallRatioVsDefault === null ? 'n/a' : `${a.wallRatioVsDefault.toFixed(2)}x`})`;
  if (a.verified === 0) return `Per verified task ${armLabelOf(a.armId)}: no verified task yet over ${String(a.routes)} routes${a.isDefault ? ' (the default)' : ''}.`;
  return `Per verified task ${armLabelOf(a.armId)}: ${cost}${usage}, ${minutes(a.wallMsPerVerified)} wall time, ${String(a.verified)} verified over ${String(a.routes)} routes${vs}.`;
}

export interface SliceExplanation {
  readonly sliceId: string;
  readonly policy: SlicePolicy;
  readonly version: number;
  readonly changedBy: { readonly version: number; readonly reason: PolicyChangeReason; readonly reasonCode: string; readonly createdAt: string } | null;
  readonly local: readonly ArmStats[];
  /** The baseline priors in use (the signed release), separate from the local evidence. */
  readonly baseline: SliceBaseline | null;
  /** Per model: prior, local counts and the posterior, with the harm probability against the baseline model. */
  readonly posteriors: readonly (ArmPosterior & { readonly harmVsBaseline: number | null })[];
  readonly priors: readonly PublicPrior[];
  readonly pendingProposal: LearningProposal | null;
  /** Cost and wall time per verified task, per arm, against the approved default. */
  readonly economics: SliceEconomics;
  /**
   * The local-evidence guard while the slice is advise-only: the locked minimum per arm and each
   * arm still short of it (the default included). Null when the slice is active, pinned or off.
   */
  readonly guard: { readonly minLocalPerArm: number; readonly waiting: readonly GuardArm[] } | null;
  readonly settings: Pick<LearningSettings, 'enabled' | 'explorationRate' | 'nonInferiorityMargin' | 'activateBelow' | 'deactivateAbove' | 'flapFloor' | 'promotionMode'>;
  readonly lines: readonly string[];
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

/** An arm for people: the model, with its effort when it is not the model's default. */
export function armLabel(modelId: string, effort: string | null | undefined, registry?: ModelRegistry): string {
  return effort === null || effort === undefined || armKey(modelId, effort, registry) === modelId ? modelId : `${modelId} at ${effort} effort`;
}

function armLabelOf(armId: string, registry?: ModelRegistry): string {
  const { modelId, effort } = parseArmKey(armId);
  return armLabel(modelId, effort, registry);
}

const RESOURCE_WORDS: { readonly [K in AuthMode]: string } = {
  'api-key': 'dollars (API key)',
  subscription: 'usage-limit consumption (subscription)',
  unknown: 'dollars and usage (auth mode unknown)',
};
/** R9 (OD-5): what a cross-vendor comparison weighed. */
const CROSS_VENDOR_WORDS = "API-equivalent dollars, an estimate (the models are from different vendors, so neither subscription's usage limit is compared)";

/**
 * What `jevris explain` shows for a slice: the policy and the version that set it, the baseline
 * prior and the local evidence separately, the posterior, and the bundled public priors.
 */
export function explainSliceLearning(state: LearningState, requestedSliceId: string, priors: readonly PublicPrior[] = BUNDLED_PUBLIC_PRIORS, options: { readonly defaultArmId?: string; readonly registry?: ModelRegistry; readonly harness?: string | null } = {}): SliceExplanation {
  // R17: with a harness, the slice as that harness's baseline learns it.
  const explainRegistry = options.registry ?? BUNDLED_MODEL_REGISTRY;
  const sliceId = options.harness === undefined || options.harness === null ? requestedSliceId : learningSliceKey(requestedSliceId, routeBaseline(explainRegistry, options.harness), explainRegistry);
  const policy = slicePolicy(state, sliceId);
  const active = activeVersion(state);
  const changed = [...state.versions].reverse().find((v) => v.sliceId === sliceId || v.sliceId === null) ?? null;
  const local = sliceEvidence(state, sliceId);
  const applied = priorsFor(state, sliceId, priors);
  const baseline = state.baseline[sliceId] ?? null;
  const pending = state.proposals.find((p) => p.sliceId === sliceId && p.status === 'pending') ?? null;
  const margin = state.settings.nonInferiorityMargin;
  const baselineModelId = policy.baselineModelId;
  const sharedSlice = sharedSliceOf(state.settings, sliceId);
  const machineArmIds = sharedSlice === null || state.machinePrior === undefined || !state.settings.enabled ? [] : Object.keys(state.machinePrior.arms[sharedSlice] ?? {});
  const arms = [...new Set([...local.map((a) => a.armId), ...(baseline?.priors ?? []).map(armOfPrior), ...machineArmIds])].sort();
  const reference = baselineModelId === null ? null : armPosterior(state, sliceId, baselineModelId);
  const posteriors = arms.map((arm) => {
    const p = armPosterior(state, sliceId, arm);
    return { ...p, harmVsBaseline: reference === null || arm === baselineModelId ? null : round(harmProbability(p, reference, margin)) };
  });
  const lines: string[] = [];
  lines.push(
    !state.settings.enabled
      ? `Slice ${sliceId}: route learning is off in this workspace; managed workers keep their model, policy v${String(active.version)}.`
      : policy.mode === 'auto'
        ? `Slice ${sliceId}: active, ${policy.modelId === null ? 'none' : armLabel(policy.modelId, policy.effort, options.registry)}${policy.direction === 'upgrade' ? ' (an upgrade: probably better, costs more)' : ''} (baseline ${policy.baselineModelId ?? 'none'} at ${pct(policy.baselineRate)}), policy v${String(active.version)}.`
        : policy.mode === 'pinned'
          ? `Slice ${sliceId}: pinned to ${policy.modelId === null ? 'advice only' : armLabel(policy.modelId, policy.effort, options.registry)}, policy v${String(active.version)}; learning does not change it.`
          : `Slice ${sliceId}: advice only (managed workers keep the baseline model at its default effort until the posterior supports another arm), policy v${String(active.version)}.`,
  );
  if (changed !== null) lines.push(`Set by v${String(changed.version)} (${changed.reason}, ${changed.reasonCode}) at ${changed.createdAt}.`);
  if (baseline !== null) {
    for (const p of baseline.priors) lines.push(`Baseline ${armLabel(p.modelId, p.effort, options.registry)}: ${pct(p.rate)} from ${String(p.sampleSize)} outcomes, counted as ${String(Math.min(p.pseudoCount, state.settings.priorWeight))}, signed release ${p.sourceId}.`);
  } else lines.push('Baseline: no signed baseline release for this slice.');
  for (const a of local) {
    const usage = a.meanTokens === null ? '' : `, mean ${String(a.meanTokens)} tokens`;
    const limits = a.usageLimited === 0 ? '' : `, ${String(a.usageLimited)} usage-limit hits`;
    lines.push(`Local ${armLabel(a.modelId, a.effort, options.registry)}: ${String(a.successes)}/${String(a.labelled)} verified (${pct(a.rate)}, 95% ${pct(a.lower)}-${pct(a.upper)}), ${String(a.staleOrCancelled)} stale or cancelled${limits}${usage}, API-equivalent estimate ${a.meanCostMicroUsd === null ? 'n/a' : `$${(a.meanCostMicroUsd / 1e6).toFixed(4)}`} per route.`); // path-hygiene: allow a successes/labelled count, not a path
  }
  if (local.length === 0) lines.push('No local outcomes yet.');
  // OD-3: the slice's reconciled baseline, else the harness's default, else the registry's.
  const defaultArmId = options.defaultArmId ?? baselineModelId ?? routeBaseline(options.registry ?? BUNDLED_MODEL_REGISTRY, options.harness ?? null);
  const economics = sliceEconomics(state, sliceId, defaultArmId);
  if (local.length > 0) for (const a of economics.arms) lines.push(economicsLine(a, armLabelOf(defaultArmId, options.registry)));
  let guard: SliceExplanation['guard'] = null;
  if (state.settings.enabled && policy.mode === 'advise') {
    const n = state.settings.minLocalPerArm;
    const waiting = [...new Set([defaultArmId, ...arms])]
      .map((id) => ({ armId: id, local: localRandomized(state, sliceId, id), remaining: Math.max(0, n - localRandomized(state, sliceId, id)) }))
      .filter((g) => g.remaining > 0);
    guard = { minLocalPerArm: n, waiting };
    for (const g of waiting) lines.push(g.armId === defaultArmId
      ? `Waiting for ${String(g.remaining)} more local outcomes on ${armLabelOf(g.armId, options.registry)} (the default) before any switch.`
      : `Waiting for ${String(g.remaining)} more local outcomes on ${armLabelOf(g.armId, options.registry)} before a switch to it.`);
  }
  for (const p of posteriors) if (p.machine !== undefined) lines.push(`Machine prior ${armLabelOf(p.armId, options.registry)}: ${pct(p.machine.rate)} from ${String(p.machine.successes + p.machine.failures)} outcomes in ${String(p.machine.contributors)} other workspaces on this machine, counted as ${String(p.machine.pseudoCount)}.`);
  for (const p of posteriors) lines.push(`Posterior ${armLabelOf(p.armId, options.registry)}: mean ${pct(p.mean)} (prior ${String(p.prior.pseudoCount)}${p.machine === undefined ? '' : ` + machine ${String(p.machine.pseudoCount)}`} + local ${String(p.local.successes + p.local.failures)})${p.harmVsBaseline === null ? '' : `, P(worse than the baseline by more than ${pct(margin)}) ${pct(p.harmVsBaseline)}`}.`);
  for (const p of applied) lines.push(`Prior ${p.modelId} (${p.effort}): ${pct(p.successRate)} over ${String(p.trials)} trials on ${p.benchmark}, ${p.sourceId} ${p.url}, published ${p.publishedOn}, fetched ${p.fetchedOn}.`);
  const decided = changed?.evidence ?? null;
  if (decided !== null && decided.objective !== undefined) {
    const basis = decided.resourceBasis === undefined ? '' : `, from ${decided.resourceBasis === 'local' ? 'local observations' : decided.resourceBasis === 'machine' ? 'other workspaces on this machine' : decided.resourceBasis === 'measured' ? "the release's measured arms" : decided.resourceBasis === 'effort-order' ? 'the order of effort levels' : 'list prices'}`;
    const words = decided.crossVendor === true ? CROSS_VENDOR_WORDS : RESOURCE_WORDS[decided.objective];
    lines.push(`Resource check for v${String(changed?.version ?? active.version)}: ${words}${basis}; an effort change on one model keeps its cache (no transition cost), a model change does not.`);
  }
  if (pending !== null && pending.direction === 'upgrade') lines.push(`Pending proposal ${pending.proposalId}: ${armLabel(pending.modelId, pending.effort, options.registry)} is probably better than ${pending.baselineModelId} (P(not better) ${pct(pending.evidence.notBetterProbability ?? null)}) and costs more; accept to turn the slice automatic.`);
  else if (pending !== null) lines.push(`Pending proposal ${pending.proposalId}: ${armLabel(pending.modelId, pending.effort, options.registry)} is non-inferior to ${pending.baselineModelId} (difference lower bound ${pct(pending.evidence.differenceLower)} > -${pct(pending.evidence.margin)}) and ${pending.evidence.objective === 'subscription' ? 'uses less of the usage limit or is faster' : pending.evidence.crossVendor === true ? 'costs less in API-equivalent dollars (an estimate; the models are from different vendors)' : 'costs less'}; accept to turn the slice automatic.`);
  lines.push(
    `Active when P(worse by more than ${pct(margin)}) < ${pct(state.settings.activateBelow)} and each arm has ${String(state.settings.minLocalPerArm)} local randomized outcomes, demoted above ${pct(state.settings.deactivateAbove)}; exploration ${pct(state.settings.adviseExplorationRate)} of low-risk routes while advise-only, ${pct(state.settings.explorationRate)} once switched; ${String(state.settings.flapFloor)} outcomes after a change before reactivation; effort arms ${state.settings.effortArms.length === 0 ? 'none' : state.settings.effortArms.join(', ')} on the baseline model; ${state.settings.promotionMode}.`,
  );
  return {
    sliceId,
    policy,
    version: active.version,
    changedBy: changed === null ? null : { version: changed.version, reason: changed.reason, reasonCode: changed.reasonCode, createdAt: changed.createdAt },
    local,
    baseline,
    posteriors,
    priors: applied,
    pendingProposal: pending,
    economics,
    guard,
    settings: {
      enabled: state.settings.enabled,
      explorationRate: state.settings.explorationRate,
      nonInferiorityMargin: state.settings.nonInferiorityMargin,
      activateBelow: state.settings.activateBelow,
      deactivateAbove: state.settings.deactivateAbove,
      flapFloor: state.settings.flapFloor,
      promotionMode: state.settings.promotionMode,
    },
    lines,
  };
}

/** Where a workspace's learning state lives: `<data>/route-learning/<workspaceId>.json` (retention class `route-learning`). */
export function learningStateFile(home: string, workspaceId: string): string {
  if (!ID.test(workspaceId)) throw new Error('workspaceId is not a valid id');
  return join(jevrisPaths({ home }).data, 'route-learning', `${workspaceId}.json`);
}

const ARM_NUMBERS = ['successes', 'failures', 'staleOrCancelled', 'usageLimited', 'routes', 'costSumMicroUsd', 'costCount', 'tokensSum', 'tokensCount', 'latencySumMs', 'latencyCount'] as const;
const EQUIVALENT_NUMBERS = ['equivalentSumMicroUsd', 'equivalentCount'] as const;

function parseVersions(value: unknown): readonly PolicyVersion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const ver of value as readonly Partial<PolicyVersion>[]) {
    if (typeof ver !== 'object' || ver === null || !Number.isInteger(ver.version) || !(POLICY_CHANGE_REASONS as readonly unknown[]).includes(ver.reason) || typeof ver.slices !== 'object' || ver.slices === null) return null;
    for (const [sliceId, p] of Object.entries(ver.slices)) {
      if (!ID.test(sliceId) || typeof p !== 'object' || p === null || !['auto', 'pinned', 'advise'].includes(p.mode) || (p.modelId !== null && (typeof p.modelId !== 'string' || !ID.test(p.modelId)))) return null;
      if (p.effort !== undefined && p.effort !== null && !isEffortLevel(p.effort)) return null;
      if (p.direction !== undefined && p.direction !== 'saving' && p.direction !== 'upgrade') return null;
    }
  }
  return value as readonly PolicyVersion[];
}

/** Validates a parsed state (version 2, or version 1 migrated by replaying its events). Anything malformed is refused. */
export function parseLearningState(value: unknown): LearningState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<Omit<LearningState, 'schemaVersion'>> & { readonly schemaVersion?: unknown };
  if (typeof v.workspaceId !== 'string' || !ID.test(v.workspaceId)) return null;
  const versions = parseVersions(v.versions);
  if (versions === null || !Array.isArray(v.events) || !Array.isArray(v.proposals)) return null;
  const settings = learningSettings(v.settings ?? {});
  if (v.schemaVersion === ROUTE_LEARNING_SCHEMA_V1) {
    let state: LearningState = { schemaVersion: ROUTE_LEARNING_SCHEMA, workspaceId: v.workspaceId, settings, versions, arms: {}, baseline: {}, events: [], proposals: v.proposals };
    for (const e of v.events) {
      const r = recordRouteOutcome(state, e as RouteOutcomeEvent);
      if (!r.ok) return null;
      state = r.state;
    }
    return state;
  }
  if (v.schemaVersion !== ROUTE_LEARNING_SCHEMA || typeof v.arms !== 'object' || v.arms === null || typeof v.baseline !== 'object' || v.baseline === null) return null;
  for (const [sliceId, arms] of Object.entries(v.arms)) {
    if (!ID.test(sliceId) || typeof arms !== 'object' || arms === null) return null;
    for (const [armId, a] of Object.entries(arms)) {
      if (!ID.test(parseArmKey(armId).modelId) || !ARM_ID.test(armId) || typeof a !== 'object' || a === null) return null;
      for (const key of ARM_NUMBERS) if (typeof a[key] !== 'number' || !Number.isFinite(a[key]) || a[key] < 0) return null;
      for (const key of EQUIVALENT_NUMBERS) if (a[key] !== undefined && (typeof a[key] !== 'number' || !Number.isFinite(a[key]) || a[key] < 0)) return null;
      if (typeof a.firstAt !== 'string' || !ISO.test(a.firstAt) || typeof a.lastAt !== 'string' || !ISO.test(a.lastAt)) return null;
    }
  }
  for (const [sliceId, b] of Object.entries(v.baseline)) {
    if (!ID.test(sliceId) || typeof b !== 'object' || b === null || typeof b.releaseId !== 'string' || !Array.isArray(b.priors)) return null;
    for (const p of b.priors as readonly Partial<BaselinePrior>[]) {
      if (typeof p !== 'object' || p === null || typeof p.modelId !== 'string' || !ID.test(p.modelId) || typeof p.rate !== 'number' || !(p.rate >= 0 && p.rate <= 1) || typeof p.pseudoCount !== 'number' || !(p.pseudoCount >= 0) || typeof p.sampleSize !== 'number' || !(p.sampleSize >= 0)) return null;
      if (p.effort !== undefined && p.effort !== null && !isEffortLevel(p.effort)) return null;
    }
  }
  const events: RouteOutcomeEvent[] = [];
  for (const e of v.events) {
    const r = cleanEvent(e as RouteOutcomeEvent);
    if (!r.ok) return null;
    events.push(r.event);
  }
  // A state written before the API-equivalent sums existed had only billed costs: those stand for them.
  const arms: { [sliceId: string]: { [armId: string]: ArmAggregate } } = {};
  for (const [sliceId, list] of Object.entries(v.arms)) {
    arms[sliceId] = {};
    for (const [armId, a] of Object.entries(list)) {
      const known = a.equivalentSumMicroUsd !== undefined && a.equivalentCount !== undefined;
      const withEquivalent = known ? a : { ...a, equivalentSumMicroUsd: a.costSumMicroUsd, equivalentCount: a.costCount };
      // A state written before the guard's count existed: counted again from the raw window it kept.
      const randomizedLabelled = typeof a.randomizedLabelled === 'number' && Number.isFinite(a.randomizedLabelled) && a.randomizedLabelled >= 0
        ? a.randomizedLabelled
        : routeLabels(events.filter((e) => e.sliceId === sliceId && armOfEvent(e) === armId)).filter((l) => l.randomized && l.label !== 'unlabelled').length;
      (arms[sliceId] as { [armId: string]: ArmAggregate })[armId] = { ...withEquivalent, randomizedLabelled };
    }
  }
  let machine: MachineContribution | undefined;
  if (v.machine !== undefined) {
    const m = v.machine as Partial<MachineContribution>;
    const machineArms = parseMachineArms(m.arms);
    const limits = parseMachineLimits(m.limits);
    if (typeof m !== 'object' || m === null || typeof m.token !== 'string' || !MACHINE_TOKEN.test(m.token) || typeof m.generation !== 'string' || !GENERATION.test(m.generation) || machineArms === null || limits === null) return null;
    machine = { token: m.token, generation: m.generation, arms: machineArms, limits };
  }
  return { schemaVersion: ROUTE_LEARNING_SCHEMA, workspaceId: v.workspaceId, settings, versions, arms, baseline: v.baseline, events, proposals: v.proposals, ...(machine === undefined ? {} : { machine }) };
}

/**
 * The workspace's learning state with the machine-wide prior attached (the other workspaces on
 * this machine; never its own contribution). Null when there is none or it is malformed.
 */
export async function loadLearningState(input: { readonly home: string; readonly workspaceId: string }): Promise<LearningState | null> {
  const state = await readLearningState(input);
  return state === null ? null : attachMachinePrior(input.home, state);
}

async function readLearningState(input: { readonly home: string; readonly workspaceId: string }): Promise<LearningState | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(learningStateFile(input.home, input.workspaceId));
  } catch {
    return null;
  }
  try {
    const state = parseLearningState(JSON.parse(new TextDecoder().decode(bytes)));
    return state !== null && state.workspaceId === input.workspaceId ? state : null;
  } catch {
    return null;
  }
}

export async function saveLearningState(home: string, state: LearningState): Promise<{ readonly ok: boolean }> {
  const file = learningStateFile(home, state.workspaceId);
  await mkdir(join(jevrisPaths({ home }).data, 'route-learning'), { recursive: true, mode: 0o700 });
  // The machine prior is the other workspaces' and is read afresh each time; it is never saved here.
  const { machinePrior: _prior, ...persisted } = state;
  const result = await durableWrite(file, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  return { ok: result.ok };
}

// ---------------------------------------------------------------------------------------------
// The machine-wide layer (§18.5 as amended, 5c29643): general route learning shared by the
// workspaces on this machine. Each workspace writes only its own contribution file, atomically
// (temporary file, fsync, rename), so concurrent workspaces never lose each other's updates; a
// workspace reads every contribution but its own, so it never counts its outcomes twice. A
// contribution holds text-free sums per shared slice and arm and usage-limit times per model:
// no workspace id, path, slice name outside `SHARED_SLICE_IDS`, or text.

export const MACHINE_LEARNING_SCHEMA = 'jevris-route-learning-machine-1' as const;
const MACHINE_TOKEN = /^mc-[0-9a-f]{16}$/;
const MACHINE_FILE = /^mc-[0-9a-f]{16}\.json$/;
const GENERATION = /^gen-[0-9a-f]{16}$/;
/** At most this many contribution files are read, and each at most this many bytes. */
const MACHINE_FILES_CAP = 1024;
const MACHINE_BYTES_CAP = 262_144;

/** `<data>/route-learning/machine`: the machine-wide layer (retention class `route-learning`). */
export function machineLearningDir(home: string): string {
  return join(jevrisPaths({ home }).data, 'route-learning', 'machine');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseMachineArms(value: unknown): MachineContribution['arms'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: { [slice: string]: { [arm: string]: MachineArm } } = {};
  for (const [slice, arms] of Object.entries(value as object)) {
    if (!SHARED_SLICES.has(slice) || typeof arms !== 'object' || arms === null || Array.isArray(arms)) return null;
    const list: { [arm: string]: MachineArm } = {};
    for (const [armId, a] of Object.entries(arms as object)) {
      if (!ARM_ID.test(armId) || typeof a !== 'object' || a === null) return null;
      const arm = a as { readonly [key: string]: unknown };
      const clean = emptyMachineArm() as { -readonly [K in keyof MachineArm]: number };
      for (const key of MACHINE_NUMBERS) {
        const n = arm[key];
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
        clean[key] = n;
      }
      list[armId] = clean;
    }
    out[slice] = list;
  }
  return out;
}

function parseMachineLimits(value: unknown): MachineContribution['limits'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: { [modelId: string]: MachineLimit } = {};
  for (const [modelId, l] of Object.entries(value as object)) {
    const limit = l as Partial<MachineLimit> | null;
    if (!ID.test(modelId) || typeof limit !== 'object' || limit === null || typeof limit.resetAt !== 'string' || !ISO.test(limit.resetAt) || typeof limit.lastHitAt !== 'string' || !ISO.test(limit.lastHitAt)) return null;
    out[modelId] = { resetAt: limit.resetAt, lastHitAt: limit.lastHitAt };
  }
  return out;
}

async function readGeneration(dir: string): Promise<string | null> {
  try {
    const text = new TextDecoder().decode(await readFile(join(dir, 'generation'))).trim();
    return GENERATION.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** The current generation of the machine layer; with `create`, starts one when there is none (exclusive create, so two workspaces agree). */
async function machineGeneration(home: string, create: boolean): Promise<string | null> {
  const dir = machineLearningDir(home);
  const seen = await readGeneration(dir);
  if (seen !== null || !create) return seen;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(join(dir, 'generation'), 'wx', 0o600);
    const generation = `gen-${hex(randomBytes(8))}`;
    try {
      await handle.writeFile(new TextEncoder().encode(`${generation}\n`), { flush: true });
    } finally {
      await handle.close();
    }
    return generation;
  } catch {
    // Another workspace created it first (or the folder cannot be written): use theirs.
    return readGeneration(dir);
  }
}

function addMachineArms(into: { [slice: string]: { [arm: string]: MachineArm } }, arms: MachineContribution['arms']): void {
  for (const [slice, list] of Object.entries(arms)) {
    const target = (into[slice] ??= {});
    for (const [armId, a] of Object.entries(list)) {
      const sum = { ...(target[armId] ?? emptyMachineArm()) } as { -readonly [K in keyof MachineArm]: number };
      for (const key of MACHINE_NUMBERS) sum[key] += a[key];
      target[armId] = sum;
    }
  }
}

function addMachineLimits(into: { [modelId: string]: MachineLimit }, limits: MachineContribution['limits']): void {
  for (const [modelId, l] of Object.entries(limits)) {
    const seen = into[modelId];
    into[modelId] = seen === undefined ? l : { resetAt: seen.resetAt > l.resetAt ? seen.resetAt : l.resetAt, lastHitAt: seen.lastHitAt > l.lastHitAt ? seen.lastHitAt : l.lastHitAt };
  }
}

/**
 * The machine-wide prior for a workspace: every contribution of the current generation except
 * `ownToken`'s, summed. Null when the layer has no generation yet. Malformed or foreign files are
 * skipped.
 */
export async function loadMachinePrior(home: string, ownToken: string | null): Promise<MachinePrior | null> {
  const dir = machineLearningDir(home);
  const generation = await readGeneration(dir);
  if (generation === null) return null;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => MACHINE_FILE.test(n)).sort().slice(0, MACHINE_FILES_CAP);
  } catch {
    return null;
  }
  const arms: { [slice: string]: { [arm: string]: MachineArm } } = {};
  const limits: { [modelId: string]: MachineLimit } = {};
  let contributors = 0;
  for (const name of names) {
    if (ownToken !== null && name === `${ownToken}.json`) continue;
    try {
      const bytes = await readFile(join(dir, name));
      if (bytes.length > MACHINE_BYTES_CAP) continue;
      const v = JSON.parse(new TextDecoder().decode(bytes)) as { readonly schemaVersion?: unknown; readonly generation?: unknown; readonly arms?: unknown; readonly limits?: unknown };
      if (v.schemaVersion !== MACHINE_LEARNING_SCHEMA || v.generation !== generation) continue;
      const a = parseMachineArms(v.arms);
      const l = parseMachineLimits(v.limits);
      if (a === null || l === null) continue;
      addMachineArms(arms, a);
      addMachineLimits(limits, l);
      contributors += 1;
    } catch {
      // unreadable or not JSON: skipped
    }
  }
  return { generation, contributors, arms, limits };
}

async function attachMachinePrior(home: string, state: LearningState): Promise<LearningState> {
  const prior = await loadMachinePrior(home, state.machine?.token ?? null).catch(() => null);
  if (prior === null) {
    if (state.machinePrior === undefined) return state;
    const { machinePrior: _dropped, ...rest } = state;
    return rest;
  }
  return { ...state, machinePrior: prior };
}

/**
 * Makes sure the workspace has a contribution of the current generation before an outcome is
 * recorded. A first contribution starts from the workspace's existing shared-slice aggregate; a
 * contribution of an older generation (after `learning reset --machine`) starts again from zero.
 * Nothing with learning off.
 */
async function ensureContribution(home: string, state: LearningState): Promise<LearningState> {
  if (!state.settings.enabled) return state;
  const generation = await machineGeneration(home, true);
  if (generation === null || state.machine?.generation === generation) return state;
  if (state.machine !== undefined) return { ...state, machine: { token: state.machine.token, generation, arms: {}, limits: {} } };
  const arms: { [slice: string]: { [arm: string]: MachineArm } } = {};
  for (const [sliceId, list] of Object.entries(state.arms)) {
    const shared = sharedSliceOf(state.settings, sliceId);
    if (shared === null) continue;
    const stripped: { [arm: string]: MachineArm } = {};
    for (const [armId, a] of Object.entries(list)) {
      const { firstAt: _f, lastAt: _l, randomizedLabelled: _r, ...counts } = a;
      stripped[armId] = counts;
    }
    addMachineArms(arms, { [shared]: stripped });
  }
  return { ...state, machine: { token: `mc-${hex(randomBytes(8))}`, generation, arms, limits: {} } };
}

/** Writes the workspace's own contribution file, only while its generation is current and learning is on. */
async function writeContribution(home: string, state: LearningState): Promise<boolean> {
  const machine = state.machine;
  if (machine === undefined || !state.settings.enabled) return false;
  const dir = machineLearningDir(home);
  if ((await readGeneration(dir)) !== machine.generation) return false;
  const body = { schemaVersion: MACHINE_LEARNING_SCHEMA, generation: machine.generation, arms: machine.arms, limits: machine.limits };
  const result = await durableWrite(join(dir, `${machine.token}.json`), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  return result.ok;
}

/**
 * `jevris route learning reset --machine`: clears the machine-wide layer. Every contribution
 * file goes, and a new generation starts, so a workspace's older history is never re-added: its
 * contribution restarts from zero with its next outcome. Workspace states are untouched. The
 * machine's found-gone record (`model-availability.json`) is removed too: it is machine-wide
 * route learning, and a model found gone again is recorded again. So is the access-limit record
 * (`access-limits.json`, access limits R62): every pause goes, and a limit hit again is recorded again,
 * and the last usage readings (`usage-readings.json`, OP-6).
 */
export async function resetMachineLearning(home: string): Promise<{ readonly ok: boolean; readonly removed: number }> {
  const dir = machineLearningDir(home);
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  let ok = true;
  for (const name of names) {
    try {
      await unlink(join(dir, name));
      if (MACHINE_FILE.test(name)) removed += 1;
    } catch {
      ok = false;
    }
  }
  try {
    if (names.length > 0) await rmdir(dir);
  } catch {
    // a file appeared meanwhile: the new generation below still retires it
  }
  const availability = await removeModelAvailability(home);
  // The eligibility evidence goes too: routing is fail-closed until models run or are listed again.
  const offer = await removeModelOffer(home);
  const limits = await removeAccessLimits(home);
  const usage = await removeAccessUsageReadings(home);
  return { ok: ok && availability.ok && offer.ok && limits.ok && usage.ok && (await machineGeneration(home, true)) !== null, removed };
}

/**
 * Withdraws this workspace's contribution from the machine layer (with `learning reset
 * --clear-evidence`): deletes its file and empties the contribution it keeps. Returns the state
 * to save.
 */
export async function withdrawMachineContribution(home: string, state: LearningState): Promise<LearningState> {
  if (state.machine === undefined) return state;
  try {
    await unlink(join(machineLearningDir(home), `${state.machine.token}.json`));
  } catch {
    // already gone
  }
  return { ...state, machine: { ...state.machine, arms: {}, limits: {} } };
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task for the same file in this process. */
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export interface LearnFromOutcomeResult {
  readonly recorded: boolean;
  readonly reasonCode: string | null;
  /** `demoted` when this outcome rolled the slice back to the baseline model. */
  readonly regression: 'demoted' | 'no-change' | null;
  /** `promoted` when it activated a candidate, `proposed` in review mode. */
  readonly promotion: 'promoted' | 'proposed' | 'no-change' | null;
  readonly proposalId: string | null;
  readonly version: number;
  readonly saved: boolean;
}

function summary(result: ReconcileResult, recorded: boolean, saved: boolean): LearnFromOutcomeResult {
  return {
    recorded,
    reasonCode: result.outcome === 'no-change' ? result.reasonCode : result.outcome === 'demoted' ? result.reasonCode : null,
    regression: result.outcome === 'demoted' ? 'demoted' : 'no-change',
    promotion: result.outcome === 'activated' ? 'promoted' : result.outcome === 'proposed' ? 'proposed' : 'no-change',
    proposalId: result.outcome === 'proposed' ? result.proposal.proposalId : null,
    version: activeVersion(result.state).version,
    saved,
  };
}

/**
 * The loop's write side, called when a deterministic outcome lands: folds it into the aggregate,
 * reconciles the slice against its posterior (a regression demotes at once) and saves. Creates the
 * workspace state on the first outcome. `eligibleModelIds` are the router's eligible models now.
 */
export async function learnFromOutcome(input: {
  readonly home: string;
  readonly workspaceId: string;
  readonly event: RouteOutcomeEvent;
  readonly baselineModelId: string;
  readonly eligibleModelIds: readonly string[];
  readonly now: string;
  readonly settings?: Partial<LearningSettings>;
  readonly registry?: ModelRegistry;
}): Promise<LearnFromOutcomeResult> {
  const file = learningStateFile(input.home, input.workspaceId);
  return serialized(file, async () => {
    const read = (await readLearningState({ home: input.home, workspaceId: input.workspaceId })) ?? emptyLearningState({ workspaceId: input.workspaceId, now: input.now, ...(input.settings === undefined ? {} : { settings: input.settings }) });
    const state = await ensureContribution(input.home, read).catch(() => read);
    // The loaded registry names the model's default effort (DOMAINS 9d6a66d): an outcome at that
    // effort is recorded as the bare model, so its arm is the model's default arm even for a model
    // the bundled registry does not hold.
    const effortless = input.registry !== undefined && input.event.effort !== undefined && input.event.effort !== null && input.event.effort === defaultEffortOf(input.event.modelId, input.registry) ? { ...input.event, effort: null } : input.event;
    // R17: the outcome lands under its route's baseline, the key the route learned under.
    const event = { ...effortless, sliceId: learningSliceKey(input.event.sliceId, input.baselineModelId, input.registry ?? BUNDLED_MODEL_REGISTRY) };
    const recorded = recordRouteOutcome(state, event);
    if (!recorded.ok) return { recorded: false, reasonCode: recorded.reasonCode, regression: null, promotion: null, proposalId: null, version: activeVersion(state).version, saved: false };
    const withPrior = await attachMachinePrior(input.home, recorded.state);
    const result = reconcileSlice({ state: withPrior, sliceId: event.sliceId, baselineModelId: input.baselineModelId, eligibleModelIds: input.eligibleModelIds, now: input.now, authMode: input.event.authMode ?? 'unknown', ...(input.registry === undefined ? {} : { registry: input.registry }), ...(input.event.servingHost === undefined ? {} : { servingHost: input.event.servingHost }) });
    const saved = await saveLearningState(input.home, result.state);
    // Shared only once the workspace's own state is saved, so a crash never shares an outcome it lost.
    if (saved.ok) await writeContribution(input.home, result.state).catch(() => false);
    return summary(result, true, saved.ok);
  });
}

/**
 * The route side: before a managed worker is routed, refreshes the slice's baseline snapshot from
 * the signed release and reconciles the slice (so day 1 activates from the baseline alone). Saves
 * only when something changed. Returns the state to route with.
 */
export async function reconcileLearning(input: {
  readonly home: string;
  readonly workspaceId: string;
  readonly sliceId: string;
  readonly baselineModelId: string;
  readonly eligibleModelIds: readonly string[];
  readonly now: string;
  readonly priors: SliceBaseline | null;
  readonly authMode?: AuthMode;
  readonly registry?: ModelRegistry;
}): Promise<{ readonly state: LearningState; readonly result: ReconcileResult; readonly saved: boolean }> {
  const file = learningStateFile(input.home, input.workspaceId);
  return serialized(file, async () => {
    const loaded = await loadLearningState({ home: input.home, workspaceId: input.workspaceId });
    const state = loaded ?? (await attachMachinePrior(input.home, emptyLearningState({ workspaceId: input.workspaceId, now: input.now })));
    const result = reconcileSlice({
      state,
      sliceId: input.sliceId,
      baselineModelId: input.baselineModelId,
      eligibleModelIds: input.eligibleModelIds,
      now: input.now,
      priors: input.priors,
      ...(input.authMode === undefined ? {} : { authMode: input.authMode }),
      ...(input.registry === undefined ? {} : { registry: input.registry }),
    });
    const changed = result.state !== state;
    const saved = changed ? (await saveLearningState(input.home, result.state)).ok : false;
    return { state: result.state, result, saved };
  });
}
