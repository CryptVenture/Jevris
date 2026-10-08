/**
 * First-try routing: Sonnet-first, with one bounded hand-off (owner decision 2026-09-30,
 * `.planning/research/v1.2-DOMAINS.md`, "Sonnet-first routing").
 *
 * An owned worker on a low-risk task starts on a cheaper model of the baseline's own vendor (the
 * first try). When that attempt fails its acceptance check, the task is handed once to a stronger
 * model. Completion is still only ever an independent passing check. This module is pure: it
 * derives the ladder from the registry, does the expected-cost arithmetic, and turns a workspace's
 * own verified outcomes into a per-slice verdict with the locked learning thresholds. It calls no
 * provider and reads no file.
 *
 * Expected cost of one task, with cS the first-try attempt, cO the step-up attempt, v one
 * verification and c the cache cost of changing model:
 *
 *   baseline-first  cO + v
 *   first-try       cS + v + (1 - p) (cO + v + c)
 *
 * The first try wins when p (the chance its attempt is verified) is above
 *
 *   p* = (cS + h) / (cO + h)        with h = v + c
 *
 * which is cS / cO when the overhead is zero. Overhead only makes the rule stricter.
 *
 * Nothing here invents a quality number. A model with no evaluation data is `unknown`: its prior is
 * uniform Beta(1, 1), and day 1 rests on the cost arithmetic and the bound on the loss, not on a
 * claim that the model is good.
 */
import type { FirstTrySetting, HarnessId, ModelRegistry, RoutingModel } from '@jevris/contracts';
import { generationCostMicroUsd, lifecycleCheck, routeBaseline, type TokenVolume } from './model-registry.js';
import { betaCdf, harmProbability, type LearningSettings } from './route-learning.js';

/**
 * A candidate whose break-even is above this is never a first try: the saving could not cover the
 * hand-off overhead. A design constant of this feature, not one of the owner's locked thresholds.
 */
export const FIRST_TRY_MAX_BREAK_EVEN = 0.75;

/**
 * Model families that are the vendor's smallest tier (owner decision 2026-10-08, when Claude Haiku
 * 5.5 was added: the first try stays Sonnet-first). Such a rung is a first try only when no cheaper
 * rung of another family exists, so a newer Haiku does not displace the Sonnet rung.
 */
export const FIRST_TRY_SMALLEST_TIER_FAMILIES: readonly string[] = Object.freeze(['haiku']);

/** The two arms of the comparison: the cheaper first try, and the baseline run first (control). */
export type FirstTryArm = 'first-try' | 'control';

export interface LadderRung {
  readonly modelId: string;
  readonly provider: string;
  readonly family: string;
  /** Micro-USD for one attempt at the slice's task volume, at the route's tariff. */
  readonly attemptMicroUsd: number;
  readonly releasedOn: string | null;
  readonly status: string | null;
}

/**
 * The eligible models ordered cheap to strong by the cost of one attempt at `volume`. Price is the
 * strength proxy the escalation gate already uses; learning, not this order, says whether a rung
 * is good enough. Ties: newer release first, then id.
 */
export function ladderOf(eligible: readonly RoutingModel[], volume: TokenVolume): readonly LadderRung[] {
  return eligible
    .map((model) => ({
      modelId: model.modelId,
      provider: model.provider,
      family: model.family,
      attemptMicroUsd: generationCostMicroUsd(model.tariff, volume),
      releasedOn: model.lifecycle?.releasedOn ?? null,
      status: model.lifecycle?.status ?? null,
    }))
    .sort((a, b) => a.attemptMicroUsd - b.attemptMicroUsd || (b.releasedOn ?? '').localeCompare(a.releasedOn ?? '') || (a.modelId < b.modelId ? -1 : 1));
}

/** The break-even first-try success rate p* = (cS + h) / (cO + h); 1 when the step up is not dearer. */
export function breakEven(input: { readonly firstTryAttemptMicroUsd: number; readonly stepUpAttemptMicroUsd: number; readonly overheadMicroUsd: number }): number {
  const h = Math.max(0, input.overheadMicroUsd);
  const denominator = Math.max(0, input.stepUpAttemptMicroUsd) + h;
  if (denominator <= 0) return 1;
  return Math.min(1, Math.max(0, (Math.max(0, input.firstTryAttemptMicroUsd) + h) / denominator));
}

/** The overhead of one more attempt: its verification plus the cache cost of the model change. */
export interface HandoffOverhead {
  readonly verificationMicroUsd: number;
  readonly cacheTransitionMicroUsd?: Readonly<Record<string, number>>;
}

export interface FirstTryCandidate {
  readonly modelId: string;
  /** The baseline the route is reconciled against. */
  readonly baselineModelId: string;
  /** Models to hand off to, in order: the baseline first, then the dearer rungs of the same vendor above it (used only when the baseline cannot run). */
  readonly stepUpModelIds: readonly string[];
  readonly breakEven: number;
  readonly firstTryAttemptMicroUsd: number;
  readonly stepUpAttemptMicroUsd: number;
  readonly overheadMicroUsd: number;
  readonly ladder: readonly LadderRung[];
  /** `family`: a rung of the baseline's own family; `newest`: the most recent release among cheaper rungs. */
  readonly chosenBy: 'family' | 'newest';
}

export type FirstTryNone = { readonly none: true; readonly reasonCode: 'BASELINE_NOT_ELIGIBLE' | 'NO_CHEAPER_RUNG' | 'BREAK_EVEN_TOO_HIGH' };

/**
 * The first-try model for a baseline, derived from the registry's eligible models: the baseline's
 * own vendor, `active` lifecycle (no preview, legacy or deprecated model), cheaper per attempt,
 * with a break-even that a real hand-off could pay back. A rung of the baseline's own family wins,
 * else the newest release; then the dearer (more capable) one. A smallest-tier family (Haiku) is
 * passed over while any other family is cheaper than the baseline.
 */
export function firstTryCandidate(input: {
  readonly eligible: readonly RoutingModel[];
  readonly baselineModelId: string;
  readonly volume: TokenVolume;
  readonly overhead: HandoffOverhead;
  readonly maxBreakEven?: number;
}): FirstTryCandidate | FirstTryNone {
  const ladder = ladderOf(input.eligible, input.volume);
  const baseline = ladder.find((rung) => rung.modelId === input.baselineModelId);
  if (baseline === undefined) return { none: true, reasonCode: 'BASELINE_NOT_ELIGIBLE' };
  const overheadFor = (toModelId: string): number => Math.max(0, input.overhead.verificationMicroUsd) + Math.max(0, Math.round(input.overhead.cacheTransitionMicroUsd?.[toModelId] ?? 0));
  const cheaper = ladder.filter((rung) => rung.provider === baseline.provider && rung.modelId !== baseline.modelId && rung.status === 'active' && rung.attemptMicroUsd < baseline.attemptMicroUsd);
  if (cheaper.length === 0) return { none: true, reasonCode: 'NO_CHEAPER_RUNG' };
  const sameFamily = cheaper.filter((rung) => rung.family === baseline.family);
  const notSmallest = cheaper.filter((rung) => !FIRST_TRY_SMALLEST_TIER_FAMILIES.includes(rung.family));
  const pool = sameFamily.length > 0 ? sameFamily : notSmallest.length > 0 ? notSmallest : cheaper;
  const ordered = [...pool].sort((a, b) => (b.releasedOn ?? '').localeCompare(a.releasedOn ?? '') || b.attemptMicroUsd - a.attemptMicroUsd || (a.modelId < b.modelId ? -1 : 1));
  const max = input.maxBreakEven ?? FIRST_TRY_MAX_BREAK_EVEN;
  for (const pick of ordered) {
    const overheadMicroUsd = overheadFor(baseline.modelId);
    const pStar = breakEven({ firstTryAttemptMicroUsd: pick.attemptMicroUsd, stepUpAttemptMicroUsd: baseline.attemptMicroUsd, overheadMicroUsd });
    if (pStar > max) continue;
    const above = ladder.filter((rung) => rung.provider === baseline.provider && rung.modelId !== baseline.modelId && rung.status === 'active' && rung.attemptMicroUsd > baseline.attemptMicroUsd);
    return {
      modelId: pick.modelId,
      baselineModelId: baseline.modelId,
      stepUpModelIds: [baseline.modelId, ...above.map((rung) => rung.modelId)],
      breakEven: pStar,
      firstTryAttemptMicroUsd: pick.attemptMicroUsd,
      stepUpAttemptMicroUsd: baseline.attemptMicroUsd,
      overheadMicroUsd,
      ladder,
      chosenBy: sameFamily.length > 0 ? 'family' : 'newest',
    };
  }
  return { none: true, reasonCode: 'BREAK_EVEN_TOO_HIGH' };
}

// ------------------------------------------------------------------------------ measured history

/** What a workspace has measured for one arm of one slice (finished tasks only). */
export interface FirstTryStats {
  /** Tasks that finished: verified, or ended without a verified result after every allowed attempt. */
  readonly tasks: number;
  /** Tasks whose first attempt was verified-successful. */
  readonly firstAttemptPass: number;
  /** Tasks whose first attempt failed (a failed check or a run with no receipt). */
  readonly firstAttemptFail: number;
  /** Tasks handed off to the step-up model. */
  readonly escalated: number;
  /** Tasks that ended verified, on either attempt. */
  readonly verified: number;
  /** Sum of every attempt's cost over the finished tasks, micro-USD (billed, else API-equivalent). */
  readonly costMicroUsd: number;
  /** Finished tasks whose every attempt had a cost; the cost figures are only used when this is all of them. */
  readonly costKnownTasks: number;
  /** True when any counted cost is an API-equivalent estimate (a subscription run), not a billed figure. */
  readonly estimate: boolean;
  /** Sum of wall time over finished tasks, ms. */
  readonly wallMs: number;
  readonly wallKnownTasks: number;
  /** Mean cost of the first attempt and of the hand-off attempt, micro-USD, with their sample counts. */
  readonly firstAttemptCost: { readonly sumMicroUsd: number; readonly n: number };
  readonly stepUpAttemptCost: { readonly sumMicroUsd: number; readonly n: number };
}

export const EMPTY_FIRST_TRY_STATS: FirstTryStats = Object.freeze({
  tasks: 0,
  firstAttemptPass: 0,
  firstAttemptFail: 0,
  escalated: 0,
  verified: 0,
  costMicroUsd: 0,
  costKnownTasks: 0,
  estimate: false,
  wallMs: 0,
  wallKnownTasks: 0,
  firstAttemptCost: Object.freeze({ sumMicroUsd: 0, n: 0 }),
  stepUpAttemptCost: Object.freeze({ sumMicroUsd: 0, n: 0 }),
});

/** The persisted verdict state for a slice: what the last verdict chose, and when. */
export interface FirstTryState {
  readonly mode: 'first-try' | 'baseline';
  /** The number of finished first-try tasks when `mode` last changed (the anti-flap floor counts from it). */
  readonly changedAtFinished: number;
}

export interface FirstTryHistory {
  readonly firstTry: FirstTryStats;
  readonly control: FirstTryStats;
  /** Null until a verdict has changed the slice; then the day-1 prior rule applies. */
  readonly state: FirstTryState | null;
}

export const EMPTY_FIRST_TRY_HISTORY: FirstTryHistory = Object.freeze({ firstTry: EMPTY_FIRST_TRY_STATS, control: EMPTY_FIRST_TRY_STATS, state: null });

/** Cost per verified task: every attempt's spend over the verified tasks; null when unknown or none verified. */
export function costPerVerified(stats: FirstTryStats): number | null {
  if (stats.verified === 0 || stats.tasks === 0 || stats.costKnownTasks !== stats.tasks) return null;
  return stats.costMicroUsd / stats.verified;
}

/** Wall time per verified task, ms; null when unknown or none verified. */
export function wallPerVerified(stats: FirstTryStats): number | null {
  if (stats.verified === 0 || stats.tasks === 0 || stats.wallKnownTasks !== stats.tasks) return null;
  return stats.wallMs / stats.verified;
}

/**
 * The break-even with the workspace's measured attempt costs once each has `flapFloor` samples,
 * else the registry's price estimate. Measured costs are what really happened; the estimate is
 * the tariff at the assumed task size.
 */
export function measuredBreakEven(candidate: Pick<FirstTryCandidate, 'breakEven' | 'overheadMicroUsd'>, history: FirstTryHistory, minSamples: number): { readonly breakEven: number; readonly basis: 'measured' | 'estimated' } {
  const first = history.firstTry.firstAttemptCost;
  const step = history.firstTry.stepUpAttemptCost;
  if (first.n >= minSamples && step.n >= minSamples) {
    return {
      breakEven: breakEven({ firstTryAttemptMicroUsd: first.sumMicroUsd / first.n, stepUpAttemptMicroUsd: step.sumMicroUsd / step.n, overheadMicroUsd: candidate.overheadMicroUsd }),
      basis: 'measured',
    };
  }
  return { breakEven: candidate.breakEven, basis: 'estimated' };
}

export const FIRST_TRY_REASONS = [
  'DAY_1_PRIOR',
  'FIRST_TRY_WORTH_IT',
  'ANTI_FLAP',
  'FIRST_TRY_BELOW_BREAK_EVEN',
  'NOT_CHEAPER_PER_VERIFIED',
  'WORSE_THAN_BASELINE',
  'BASELINE_FIRST_NOT_PROVEN',
] as const;
export type FirstTryReason = (typeof FIRST_TRY_REASONS)[number];

export interface FirstTryVerdict {
  readonly mode: 'first-try' | 'baseline';
  readonly reasonCode: FirstTryReason;
  /** True when this verdict differs from the state it was given: the caller persists it. */
  readonly changed: boolean;
  readonly breakEven: number;
  readonly breakEvenBasis: 'measured' | 'estimated';
  /** P(first-try success rate < break-even) under the Beta(1 + pass, 1 + fail) posterior; null under the day-1 prior rule. */
  readonly pBelowBreakEven: number | null;
  /** P(task-level success worse than the control's by more than the margin); null when the control is too small. */
  readonly pWorseThanBaseline: number | null;
  /** Cost per verified task, first try against control, micro-USD; null when unknown. */
  readonly costPerVerifiedFirstTry: number | null;
  readonly costPerVerifiedControl: number | null;
}

type VerdictSettings = Pick<LearningSettings, 'nonInferiorityMargin' | 'activateBelow' | 'deactivateAbove' | 'flapFloor' | 'minLocalPerArm'>;

/**
 * Whether a slice runs first-try or baseline-first, from its own finished tasks and the owner-locked
 * thresholds (margin 0.075, demote above 0.40, come back below 0.10 after 12 tasks, anti-flap floor 5):
 *
 * - under `flapFloor` finished first-try tasks: stay on the day-1 prior rule (first-try);
 * - after a change, `flapFloor` more finished tasks before the next change;
 * - on first-try: demote when P(p < break-even) is above `deactivateAbove`, or the measured cost per
 *   verified task is not below the control's (both with `flapFloor` verified tasks), or the task-level
 *   success is worse than the control's by more than the margin with probability above `deactivateAbove`;
 * - on baseline: come back only with `minLocalPerArm` finished tasks, P(p < break-even) below
 *   `activateBelow`, no cost or success objection.
 */
export function firstTryVerdict(input: { readonly history: FirstTryHistory; readonly candidate: Pick<FirstTryCandidate, 'breakEven' | 'overheadMicroUsd'>; readonly settings: VerdictSettings }): FirstTryVerdict {
  const { history, candidate, settings } = input;
  const ft = history.firstTry;
  const ctl = history.control;
  const previous: FirstTryState['mode'] = history.state?.mode ?? 'first-try';
  const measured = measuredBreakEven(candidate, history, settings.flapFloor);
  const labelled = ft.firstAttemptPass + ft.firstAttemptFail;
  const pBelow = labelled === 0 ? null : betaCdf(measured.breakEven, 1 + ft.firstAttemptPass, 1 + ft.firstAttemptFail);
  const costFt = costPerVerified(ft);
  const costCtl = costPerVerified(ctl);
  const harm =
    ft.tasks >= settings.flapFloor && ctl.tasks >= settings.flapFloor
      ? harmProbability({ alpha: 1 + ft.verified, beta: 1 + (ft.tasks - ft.verified) }, { alpha: 1 + ctl.verified, beta: 1 + (ctl.tasks - ctl.verified) }, settings.nonInferiorityMargin)
      : null;
  const notCheaper = costFt !== null && costCtl !== null && ft.verified >= settings.flapFloor && ctl.verified >= settings.flapFloor && costFt >= costCtl;
  const base = { breakEven: measured.breakEven, breakEvenBasis: measured.basis, pBelowBreakEven: pBelow, pWorseThanBaseline: harm, costPerVerifiedFirstTry: costFt, costPerVerifiedControl: costCtl };
  const stay = (mode: FirstTryState['mode'], reasonCode: FirstTryReason): FirstTryVerdict => ({ ...base, mode, reasonCode, changed: history.state !== null ? mode !== history.state.mode : mode !== 'first-try' });
  if (labelled < settings.flapFloor) return stay(previous, history.state === null ? 'DAY_1_PRIOR' : previous === 'first-try' ? 'DAY_1_PRIOR' : 'BASELINE_FIRST_NOT_PROVEN');
  if (history.state !== null && ft.tasks - history.state.changedAtFinished < settings.flapFloor) return stay(previous, 'ANTI_FLAP');
  if (previous === 'first-try') {
    if (pBelow !== null && pBelow > settings.deactivateAbove) return stay('baseline', 'FIRST_TRY_BELOW_BREAK_EVEN');
    if (notCheaper) return stay('baseline', 'NOT_CHEAPER_PER_VERIFIED');
    if (harm !== null && harm > settings.deactivateAbove) return stay('baseline', 'WORSE_THAN_BASELINE');
    return stay('first-try', 'FIRST_TRY_WORTH_IT');
  }
  const worth = labelled >= settings.minLocalPerArm && pBelow !== null && pBelow < settings.activateBelow && !notCheaper && (harm === null || harm <= settings.deactivateAbove);
  return worth ? stay('first-try', 'FIRST_TRY_WORTH_IT') : stay('baseline', 'BASELINE_FIRST_NOT_PROVEN');
}

// ------------------------------------------------------------------------------------ the route

export const FIRST_TRY_ROUTE_REASONS = ['FIRST_TRY', 'FIRST_TRY_EXPLORED', 'FIRST_TRY_CONTROL'] as const;

/** Why a route did not go first-try (the baseline runs, exactly as before). */
export type FirstTrySkip =
  | 'FIRST_TRY_OFF'
  | 'RISK_NOT_LOW'
  | 'NOT_AUTOMATED'
  | 'LEARNING_OFF'
  | 'NO_FIRST_TRY_CANDIDATE'
  | 'BASELINE_NOT_ELIGIBLE'
  | 'NO_CHEAPER_RUNG'
  | 'BREAK_EVEN_TOO_HIGH'
  | 'NO_STEP_UP_MODEL';

export type FirstTryDecision =
  | {
      readonly route: 'first-try' | 'control';
      readonly arm: FirstTryArm;
      /** The probability of the assigned arm under the logging policy (a randomized assignment). */
      readonly propensity: number;
      readonly reasonCode: (typeof FIRST_TRY_ROUTE_REASONS)[number];
      readonly candidate: FirstTryCandidate;
      readonly verdict: FirstTryVerdict;
    }
  | { readonly route: 'baseline'; readonly reasonCode: FirstTrySkip; readonly candidate?: FirstTryCandidate; readonly verdict?: FirstTryVerdict };

/**
 * The locked exploration shares of the randomized assignment, never above the 10% cap: `cap` is the
 * share of the arm that is not the slice's current one while the slice is on baseline-first (the
 * first try is explored at it) and while the control has fewer than `flapFloor` finished tasks;
 * `control` is the share of the control (baseline first) while the slice is on first-try.
 */
export function firstTryShares(settings: Pick<LearningSettings, 'explorationRate' | 'adviseExplorationRate' | 'flapFloor'>, history: Pick<FirstTryHistory, 'control'>): { readonly cap: number; readonly control: number } {
  const cap = Math.min(0.1, Math.max(0, settings.adviseExplorationRate));
  const established = Math.min(cap, Math.max(0, settings.explorationRate));
  return { cap, control: history.control.tasks < settings.flapFloor ? cap : established };
}

/**
 * What the route does with a slice now, from its verdict: `learning` while fewer than `flapFloor`
 * first attempts have a label (the verdict's day-1 prior rule, `DAY_1_PRIOR`), else the verdict's
 * mode, `first-try` or `baseline-first`.
 */
export function firstTryPhase(verdict: Pick<FirstTryVerdict, 'mode' | 'reasonCode'>): 'first-try' | 'baseline-first' | 'learning' {
  if (verdict.reasonCode === 'DAY_1_PRIOR') return 'learning';
  return verdict.mode === 'first-try' ? 'first-try' : 'baseline-first';
}

/** The share of the minority arm for the next task of a slice with this verdict, and which arm it is. */
export function nextTaskShare(verdict: Pick<FirstTryVerdict, 'mode'>, shares: { readonly cap: number; readonly control: number }): { readonly arm: FirstTryArm; readonly share: number } {
  return verdict.mode === 'first-try' ? { arm: 'control', share: shares.control } : { arm: 'first-try', share: shares.cap };
}

/**
 * One route's first-try assignment. Only a low-risk, automated route with learning on and a real
 * candidate is ever assigned; every other route runs the baseline exactly as before. The assignment
 * is randomized so the two arms can be compared: on first-try the control (baseline first) takes
 * the locked exploration share (10% until it has `flapFloor` tasks, 5% after); on baseline the first
 * try is explored at the 10% cap. The caller logs `arm` and `propensity` with the task.
 */
export function decideFirstTry(input: {
  readonly setting: FirstTrySetting;
  readonly risk: string;
  readonly automated: boolean;
  readonly learningEnabled: boolean;
  readonly eligible: readonly RoutingModel[];
  readonly baselineModelId: string;
  readonly volume: TokenVolume;
  readonly overhead: HandoffOverhead;
  /** The workspace's measured history for the candidate; a function because the candidate is derived here. */
  readonly history: FirstTryHistory | ((candidateModelId: string) => FirstTryHistory);
  readonly settings: VerdictSettings & Pick<LearningSettings, 'explorationRate' | 'adviseExplorationRate'>;
  readonly random: () => number;
}): FirstTryDecision {
  if (input.setting !== 'auto') return { route: 'baseline', reasonCode: 'FIRST_TRY_OFF' };
  if (input.risk !== 'low') return { route: 'baseline', reasonCode: 'RISK_NOT_LOW' };
  if (!input.automated) return { route: 'baseline', reasonCode: 'NOT_AUTOMATED' };
  if (!input.learningEnabled) return { route: 'baseline', reasonCode: 'LEARNING_OFF' };
  const candidate = firstTryCandidate({ eligible: input.eligible, baselineModelId: input.baselineModelId, volume: input.volume, overhead: input.overhead });
  if ('none' in candidate) return { route: 'baseline', reasonCode: candidate.reasonCode };
  if (candidate.stepUpModelIds.length === 0) return { route: 'baseline', reasonCode: 'NO_STEP_UP_MODEL', candidate };
  const history = typeof input.history === 'function' ? input.history(candidate.modelId) : input.history;
  const verdict = firstTryVerdict({ history, candidate, settings: input.settings });
  const { cap, control } = firstTryShares(input.settings, history);
  const draw = input.random();
  if (verdict.mode === 'first-try') {
    return draw < control
      ? { route: 'control', arm: 'control', propensity: control, reasonCode: 'FIRST_TRY_CONTROL', candidate, verdict }
      : { route: 'first-try', arm: 'first-try', propensity: 1 - control, reasonCode: 'FIRST_TRY', candidate, verdict };
  }
  return draw < cap
    ? { route: 'first-try', arm: 'first-try', propensity: cap, reasonCode: 'FIRST_TRY_EXPLORED', candidate, verdict }
    : { route: 'control', arm: 'control', propensity: 1 - cap, reasonCode: 'FIRST_TRY_CONTROL', candidate, verdict };
}

/** The next model to hand off to: the first step-up model that `blocked` does not name. Null when none is left. */
export function stepUpTarget(stepUpModelIds: readonly string[], blocked: ReadonlySet<string>): string | null {
  return stepUpModelIds.find((id) => !blocked.has(id)) ?? null;
}

/** What the route carries to the ledger with its learning note (ids and numbers only). */
export interface FirstTryNote {
  readonly arm: FirstTryArm;
  readonly reasonCode: (typeof FIRST_TRY_ROUTE_REASONS)[number];
  readonly propensity: number;
  readonly firstTryModelId: string;
  readonly baselineModelId: string;
  readonly stepUpModelIds: readonly string[];
  readonly breakEven: number;
  readonly breakEvenBasis: 'measured' | 'estimated';
  /** One attempt's verification plus the cache cost of the model change, micro-USD (the break-even's overhead). */
  readonly overheadMicroUsd: number;
  readonly verdictReason: FirstTryReason;
}

/** The note for a decision that assigned an arm; null for a route that stayed on the baseline. */
export function firstTryNote(decision: FirstTryDecision): FirstTryNote | null {
  if (decision.route === 'baseline') return null;
  return {
    arm: decision.arm,
    reasonCode: decision.reasonCode,
    propensity: decision.propensity,
    firstTryModelId: decision.candidate.modelId,
    baselineModelId: decision.candidate.baselineModelId,
    stepUpModelIds: decision.candidate.stepUpModelIds.slice(0, 8),
    breakEven: decision.verdict.breakEven,
    breakEvenBasis: decision.verdict.breakEvenBasis,
    overheadMicroUsd: decision.candidate.overheadMicroUsd,
    verdictReason: decision.verdict.reasonCode,
  };
}

// ------------------------------------------------------------------------------- per harness view

/** What `jevris status` shows for one harness: its baseline and whether it has a first-try step. */
export type HarnessFirstTry =
  | { readonly harness: HarnessId; readonly baselineModelId: string; readonly on: true; readonly candidate: FirstTryCandidate }
  | {
      readonly harness: HarnessId;
      readonly baselineModelId: string;
      readonly on: false;
      readonly reasonCode: FirstTryNone['reasonCode'];
      /** True when a stronger model of the baseline's vendor exists but is a preview, which is never started automatically. */
      readonly strongerIsPreview: boolean;
    };

/**
 * The first-try step of a harness from the registry alone: the harness's baseline (`routeBaseline`,
 * its registry default) and `firstTryCandidate` over the models of the vendors the harness reaches
 * that the lifecycle gate leaves usable. It is the registry's ladder, not a decision: a route still
 * passes every gate (consent, account evidence, residency, health, pauses) before it uses a rung.
 */
export function harnessFirstTry(input: {
  readonly registry: Pick<ModelRegistry, 'entries' | 'harnessAccess' | 'harnessDefaults' | 'baselineModelId'>;
  readonly harness: HarnessId;
  readonly volume: TokenVolume;
  readonly overhead: HandoffOverhead;
  readonly nowMs: number;
}): HarnessFirstTry {
  const baselineModelId = routeBaseline(input.registry as ModelRegistry, input.harness);
  const reached = new Set((input.registry.harnessAccess ?? []).filter((row) => row.harness === input.harness).map((row) => row.provider));
  const eligible = input.registry.entries.filter((model) => reached.has(model.provider) && model.health !== 'unavailable' && lifecycleCheck(model, input.nowMs).usable);
  const candidate = firstTryCandidate({ eligible, baselineModelId, volume: input.volume, overhead: input.overhead });
  if (!('none' in candidate)) return { harness: input.harness, baselineModelId, on: true, candidate };
  const ladder = ladderOf(eligible, input.volume);
  const baseline = ladder.find((rung) => rung.modelId === baselineModelId);
  const strongerIsPreview = baseline !== undefined && ladder.some((rung) => rung.provider === baseline.provider && rung.attemptMicroUsd > baseline.attemptMicroUsd && rung.status === 'preview');
  return { harness: input.harness, baselineModelId, on: false, reasonCode: candidate.reasonCode, strongerIsPreview };
}
