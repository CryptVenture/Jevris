/**
 * The router (RTE-02, RTE-03, §8.3, C09, US03, US06, US07, §19.3).
 *
 * 1. Hard filters built from policy facts remove candidates before any scoring: managed
 *    allowlist, provider allowlist, lifecycle (a retired or deprecated model, or one past its
 *    retirement date, is never recommended), data retention (a zero-data-retention workspace
 *    only gets models the registry marks ZDR eligible), residency (the workspace data scope's
 *    regions), context capacity, tools, the explicit model pin, the task risk floor, account
 *    eligibility and health. The first failing gate is recorded per candidate.
 *    Prices are the ones in force at the routing time (an announced scheduled price applies
 *    from its date).
 * 2. The quality floor comes from a released calibration (RTE-04). Without one nothing is
 *    routed automatically. A candidate whose quality is unknown for the slice is evaluated in
 *    shadow only; one whose lower quality bound is under the floor is eliminated.
 * 3. For each remaining model the expected total cost and utility are computed with an interval:
 *
 *      expected_total_cost = generation + cache_transition + expected_retry + verification
 *                          + expected_rework + routing_overhead
 *      utility = expected_total_cost + latency_weight * wall_time + failure_weight * failure_loss
 *
 *    Retry, rework and failure loss scale with the failure probability, so the cost interval
 *    comes from the quality interval (the lower quality bound gives the upper cost).
 * 4. The lowest-utility candidate is selected only when the saving against the approved
 *    baseline is positive across the whole interval and at least the minimum benefit. A saving
 *    inside the interval keeps the baseline. No candidate keeps the baseline. A pin is never
 *    overridden.
 *
 * Serving hosts (R48, design 6.3): each candidate is priced through the route's serving host
 * (`servingTariff`): the maker's own tariff directly, a host's snapshot tariff through a gateway, and
 * the maker's list price as an estimate where the host's tariff is not known. The estimate is named
 * (`costEstimates`); the arithmetic is the same.
 *
 * All money is integer micro-USD. Nothing here calls a provider.
 */
import { servingHostOf, type ModelRegistry, type RoutePins, type RoutingModel } from '@jevris/contracts';
import type { AccessPauseNote } from './access-limits.js';
import { servingTariff } from './serving-tariff.js';
import type { ModelUnavailableReason } from './model-availability.js';
import { generationCostMicroUsd, lifecycleCheck, registryModel, tariffAt, zdrEligible, type LifecycleWarning, type TokenVolume } from './model-registry.js';
import { signedInDefaultAllowed } from './provider-consent-gate.js';

export const FILTER_GATES = [
  'managed-allowlist',
  'provider',
  'no-harness',
  'lifecycle',
  'data-retention',
  'residency',
  'context',
  'tools',
  'explicit-pin',
  'risk-floor',
  'account-eligibility',
  'health',
  'provider-consent',
  'preview',
  'access-limit',
] as const;
export type FilterGate = (typeof FILTER_GATES)[number];

export interface RoutingPolicy {
  /** Model ids the organization allows; null when no managed list applies. */
  readonly managedAllowlist: readonly string[] | null;
  /** Providers allowed for this workspace; null for any registered provider. */
  readonly allowedProviders?: readonly string[] | null;
  /** Regions the workspace data scope permits. A model must serve at least one. */
  readonly allowedRegions: readonly string[];
  /** Context the task needs (prompt plus expected growth), tokens. */
  readonly requiredContextTokens: number;
  /** Capabilities or tools the task needs. */
  readonly requiredCapabilities: readonly string[];
  readonly pins: RoutePins;
  /** Model families the task's risk permits; null when the risk sets no floor. */
  readonly riskFloorFamilies: readonly string[] | null;
  /**
   * The billing account whose eligibility is checked (an administrator's registry with account
   * checks). Null when there is none: then only `locallyEligible` models pass.
   */
  readonly accountId: string | null;
  /**
   * The models eligible from local evidence on this route's harness and sign-in (model-offer.ts
   * `locallyEligibleModels`, owner decision DOMAINS 3f090fa). Consulted only when `accountId` is
   * null; absent or empty, nothing passes the account gate (fail-closed).
   */
  readonly locallyEligible?: readonly string[] | null;
  /** True for a zero-data-retention workspace: only ZDR-eligible models pass. */
  readonly zeroDataRetention?: boolean;
  /** The routing time for lifecycle dates and scheduled prices; now when absent. */
  readonly nowMs?: number;
  /**
   * Models found gone on this machine, or not accessible from this route's harness and auth mode
   * (model-availability.ts `unavailableModels`). They fail the lifecycle gate, like a retired model.
   */
  readonly unavailableModels?: Readonly<Record<string, ModelUnavailableReason>>;
  /**
   * SPEC §8.1 (amended 2026-09-27), owner OD-4: the providers whose egress the user allowed, from
   * `providerConsentGate` (stored consent plus the signed-in default). When given, a model passes
   * only when its provider is listed. Absent, only a model whose entry `requiresProviderConsent`
   * fails (fail-closed: PROVIDER_CONSENT_REQUIRED).
   */
  readonly consentedProviders?: readonly string[] | null;
  /**
   * True for a route that runs a model without a person choosing it (an owned worker, exploration,
   * a switched turn). A `preview` model is advice and shadow only, so it fails here.
   */
  readonly automated?: boolean;
  /**
   * R11: models no installed harness reaches for this route (D's candidateScopes, a null scope).
   * They fail the `no-harness` gate (NO_HARNESS_FOR_PROVIDER).
   */
  readonly unreachableModels?: readonly string[];
  /**
   * Access limits (R72, coordinator decision 1e88b2b): models whose scope (the harness, sign-in and
   * serving host that would run them) is paused in the machine's access-limits record
   * (access-limits.ts `pausedModels`). They fail the last gate, `access-limit` (ACCESS_LIMITED):
   * after every policy gate, since a pause only narrows and never grants.
   */
  readonly pausedModels?: Readonly<Record<string, AccessPauseNote>>;
  /**
   * Serving hosts (R48, design 6.3): the route's serving host, from the session's spelling (4.3).
   * A pinned gateway or host prices each candidate at its snapshot tariff there, or at the maker's
   * list price as an estimate. Absent, null or a maker id: each candidate goes to its own maker.
   */
  readonly servingHost?: string | null;
}

/** The host a candidate is priced through: a pinned host the route runs on, else the candidate's own maker. */
function candidateHost(policy: Pick<RoutingPolicy, 'servingHost'>, provider: string): string {
  const host = policy.servingHost ?? null;
  return host !== null && servingHostOf(host) !== undefined ? host : provider;
}

/** The candidate's tariff through the route's host, and whether that is the maker's price as an estimate. */
function pricedThrough(registry: ModelRegistry, policy: Pick<RoutingPolicy, 'servingHost'>, model: RoutingModel): { readonly tariff: RoutingModel['tariff']; readonly estimate: boolean } {
  const priced = servingTariff(registry, candidateHost(policy, model.provider), model.provider, model.modelId);
  return priced === null ? { tariff: model.tariff, estimate: true } : { tariff: priced.tariff, estimate: priced.basis !== 'host' };
}

function pausedIn(policy: Pick<RoutingPolicy, 'pausedModels'>, modelId: string): boolean {
  return policy.pausedModels !== undefined && Object.hasOwn(policy.pausedModels, modelId);
}

export interface Elimination {
  readonly modelId: string;
  readonly gate: FilterGate | 'unknown-quality' | 'below-quality-floor';
  /**
   * Why the orchestrator left the model out of a no-model task's candidate set before routing
   * (D f17a3bc: NO_HARNESS, EXPLORATION_NEEDS_API_KEY or a PROVIDER_CONSENT_* code), when it did.
   */
  readonly reasonCode?: string;
}

export interface FilterResult {
  readonly eligible: readonly RoutingModel[];
  readonly eliminated: readonly Elimination[];
  /** Eligible models priced at the maker's list price as an estimate (R48); absent when none. */
  readonly costEstimates?: readonly string[];
}

function firstFailingGate(model: RoutingModel, policy: RoutingPolicy): FilterGate | null {
  if (policy.managedAllowlist !== null && !policy.managedAllowlist.includes(model.modelId)) return 'managed-allowlist';
  if (policy.allowedProviders !== undefined && policy.allowedProviders !== null && !policy.allowedProviders.includes(model.provider)) return 'provider';
  if (policy.unreachableModels?.includes(model.modelId) === true) return 'no-harness';
  if (!lifecycleCheck(model, policy.nowMs ?? Date.now()).usable) return 'lifecycle';
  if (policy.unavailableModels?.[model.modelId] !== undefined) return 'lifecycle';
  if (policy.zeroDataRetention === true && !zdrEligible(model)) return 'data-retention';
  if (!model.regions.some((region) => policy.allowedRegions.includes(region))) return 'residency';
  if (model.contextTokens < policy.requiredContextTokens) return 'context';
  if (!policy.requiredCapabilities.every((capability) => model.capabilities.includes(capability))) return 'tools';
  if (policy.pins.modelPin !== null && policy.pins.modelPin !== model.modelId) return 'explicit-pin';
  if (policy.riskFloorFamilies !== null && !policy.riskFloorFamilies.includes(model.family)) return 'risk-floor';
  if (policy.accountId !== null) {
    // An administrator's account check wins: local evidence is not consulted.
    const account = model.accountEligibility.find((entry) => entry.accountId === policy.accountId);
    if (account === undefined || !account.eligible) return 'account-eligibility';
  } else if (!(policy.locallyEligible ?? []).includes(model.modelId)) return 'account-eligibility';
  if (model.health === 'unavailable') return 'health';
  if (policy.consentedProviders !== undefined && policy.consentedProviders !== null) {
    if (!policy.consentedProviders.includes(model.provider)) return 'provider-consent';
  } else if (model.requiresProviderConsent === true || !signedInDefaultAllowed(model.provider)) return 'provider-consent';
  if (policy.automated === true && model.lifecycle?.status === 'preview') return 'preview';
  if (pausedIn(policy, model.modelId)) return 'access-limit';
  return null;
}

/** RTE-02: removes every candidate that violates a policy fact, before scoring. */
export function filterCandidates(registry: ModelRegistry, policy: RoutingPolicy): FilterResult {
  const eligible: RoutingModel[] = [];
  const eliminated: Elimination[] = [];
  const estimates: string[] = [];
  const nowMs = policy.nowMs ?? Date.now();
  for (const model of registry.entries) {
    const gate = firstFailingGate(model, { ...policy, nowMs });
    if (gate === null) {
      const priced = pricedThrough(registry, policy, model);
      if (priced.estimate) estimates.push(model.modelId);
      eligible.push({ ...model, tariff: tariffAt(priced.tariff, nowMs) });
    } else eliminated.push(gate === 'access-limit' ? { modelId: model.modelId, gate, reasonCode: 'ACCESS_LIMITED' } : { modelId: model.modelId, gate });
  }
  return { eligible, eliminated, ...(estimates.length === 0 ? {} : { costEstimates: estimates }) };
}

/** A success-rate interval for one model on one task slice, from held-out outcomes. */
export interface QualityEstimate {
  readonly modelId: string;
  readonly sliceId: string;
  readonly lower: number;
  readonly point: number;
  readonly upper: number;
  /** The evaluation or calibration release the estimate comes from. */
  readonly sourceId: string;
}

export interface CostAssumptions {
  /** Verification cost per attempt (tests, review), micro-USD. */
  readonly verificationMicroUsd: number;
  /** Rework cost when an attempt fails verification, micro-USD. */
  readonly reworkMicroUsd: number;
  /** Decision and routing overhead (for example the Jev calls), micro-USD. */
  readonly routingOverheadMicroUsd: number;
  /** Cache transition cost per model id (RTE-05 `transitionCostMicroUsd`), micro-USD. */
  readonly cacheTransitionMicroUsd?: Readonly<Record<string, number>>;
  /** Retries per failed attempt, each costing one generation. Default 1. */
  readonly retriesPerFailure?: number;
  /** Micro-USD per second of expected wall time. Default 0. */
  readonly latencyWeightMicroUsdPerSecond?: number;
  /** Expected wall time per model id, seconds. */
  readonly wallTimeSeconds?: Readonly<Record<string, number>>;
  /** Weight on the failure loss. Default 0 (high-consequence failures are floors, not prices). */
  readonly failureWeight?: number;
  readonly failureLossMicroUsd?: number;
}

export interface Interval {
  readonly lower: number;
  readonly point: number;
  readonly upper: number;
}

export interface CostBreakdown {
  readonly generation: number;
  readonly cacheTransition: number;
  readonly expectedRetry: number;
  readonly verification: number;
  readonly expectedRework: number;
  readonly routingOverhead: number;
}

/** Sum of the §8.3 cost terms. */
export function expectedTotalCost(parts: CostBreakdown): number {
  return parts.generation + parts.cacheTransition + parts.expectedRetry + parts.verification + parts.expectedRework + parts.routingOverhead;
}

function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The cost breakdown for one model at a given success probability. */
export function costAt(model: RoutingModel, volume: TokenVolume, assumptions: CostAssumptions, successProbability: number | null): CostBreakdown {
  const generation = generationCostMicroUsd(model.tariff, volume);
  const failure = successProbability === null ? 0 : 1 - clampProbability(successProbability);
  const retries = assumptions.retriesPerFailure ?? 1;
  return {
    generation,
    cacheTransition: Math.max(0, Math.round(assumptions.cacheTransitionMicroUsd?.[model.modelId] ?? 0)),
    expectedRetry: Math.round(failure * retries * generation),
    verification: Math.round(assumptions.verificationMicroUsd * (1 + failure * retries)),
    expectedRework: Math.round(failure * assumptions.reworkMicroUsd),
    routingOverhead: Math.round(assumptions.routingOverheadMicroUsd),
  };
}

function utilityOf(model: RoutingModel, cost: number, assumptions: CostAssumptions, successProbability: number | null): number {
  const latency = (assumptions.latencyWeightMicroUsdPerSecond ?? 0) * (assumptions.wallTimeSeconds?.[model.modelId] ?? 0);
  const failure = successProbability === null ? 0 : 1 - clampProbability(successProbability);
  const loss = (assumptions.failureWeight ?? 0) * failure * (assumptions.failureLossMicroUsd ?? 0);
  return Math.round(cost + latency + loss);
}

export interface ScoredCandidate {
  readonly modelId: string;
  readonly quality: QualityEstimate | null;
  readonly breakdown: CostBreakdown;
  /** Expected total cost interval, micro-USD (upper uses the lower quality bound). */
  readonly cost: Interval;
  readonly utility: Interval;
}

/** Scores one model against its quality interval. */
export function scoreCandidate(model: RoutingModel, quality: QualityEstimate | null, volume: TokenVolume, assumptions: CostAssumptions): ScoredCandidate {
  const at = (p: number | null): { breakdown: CostBreakdown; cost: number; utility: number } => {
    const breakdown = costAt(model, volume, assumptions, p);
    const cost = expectedTotalCost(breakdown);
    return { breakdown, cost, utility: utilityOf(model, cost, assumptions, p) };
  };
  const point = at(quality?.point ?? null);
  const best = at(quality?.upper ?? null);
  const worst = at(quality?.lower ?? null);
  return {
    modelId: model.modelId,
    quality,
    breakdown: point.breakdown,
    cost: { lower: best.cost, point: point.cost, upper: worst.cost },
    utility: { lower: best.utility, point: point.utility, upper: worst.utility },
  };
}

export const ROUTE_OUTCOMES = ['select', 'keep-baseline', 'pinned'] as const;
export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];

export interface RouteInput {
  readonly registry: ModelRegistry;
  readonly policy: RoutingPolicy;
  readonly sliceId: string;
  readonly volume: TokenVolume;
  readonly assumptions: CostAssumptions;
  readonly qualities: readonly QualityEstimate[];
  /** Minimum success lower bound from a released calibration; null when none applies. */
  readonly qualityFloor: number | null;
  /** The approved baseline; defaults to the registry baseline. */
  readonly baselineModelId?: string;
  /** A saving must exceed this across its whole interval, micro-USD. Default 0. */
  readonly minimumBenefitMicroUsd?: number;
}

export interface RouteSelection {
  readonly outcome: RouteOutcome;
  readonly modelId: string;
  readonly baselineModelId: string;
  readonly reasonCode: string;
  readonly sliceId: string;
  readonly scored: readonly ScoredCandidate[];
  readonly eliminated: readonly Elimination[];
  /** Models with unknown quality for the slice: evaluated in shadow, never routed. */
  readonly shadow: readonly string[];
  /** Baseline cost minus selected cost, as an interval (lower = worst case), micro-USD. */
  readonly saving: Interval | null;
  readonly registrySnapshotId: string;
  /**
   * Registry models still recommended with a lifecycle warning at the routing time: deprecated,
   * or past the vendor's "not sooner than" date (MODEL_RETIREMENT_DUE). Absent when none.
   */
  readonly lifecycleWarnings?: readonly LifecycleNote[];
  /** Registry models not recommended because they were found gone (or not accessible here). Absent when none. */
  readonly unavailable?: readonly { readonly modelId: string; readonly reasonCode: ModelUnavailableReason }[];
  /** Registry models not routed because their scope is paused by an access limit (R72). Absent when none. */
  readonly accessLimited?: readonly { readonly modelId: string; readonly class: AccessPauseNote['class']; readonly untilMs: number | null }[];
  /**
   * R48: the selected model or the baseline, whichever was priced at the maker's list price as an
   * estimate because the route's serving host has no known tariff for it. An actuator never acts
   * on an estimate (HOST_TARIFF_UNKNOWN). Absent when both prices are known.
   */
  readonly costEstimates?: readonly string[];
}

/** A usable model's lifecycle warning, for explain and the release gate. */
export interface LifecycleNote {
  readonly modelId: string;
  readonly warning: LifecycleWarning;
}

/** The lifecycle warnings of a registry's models at `nowMs` (usable models only). */
export function lifecycleWarnings(registry: ModelRegistry, nowMs: number): readonly LifecycleNote[] {
  const out: LifecycleNote[] = [];
  for (const model of registry.entries) {
    const check = lifecycleCheck(model, nowMs);
    if (check.usable && check.warning !== undefined) out.push({ modelId: model.modelId, warning: check.warning });
  }
  return out;
}

function qualityFor(qualities: readonly QualityEstimate[], modelId: string, sliceId: string): QualityEstimate | null {
  const found = qualities.find((q) => q.modelId === modelId && q.sliceId === sliceId);
  if (found === undefined) return null;
  const ordered = Number.isFinite(found.lower) && Number.isFinite(found.upper) && found.lower <= found.point && found.point <= found.upper;
  return ordered && found.lower >= 0 && found.upper <= 1 ? found : null;
}

/** RTE-03: selects a worker model, or keeps the approved baseline, with the reason. */
export function routeTask(input: RouteInput): RouteSelection {
  const baselineModelId = input.policy.pins.modelPin ?? input.baselineModelId ?? input.registry.baselineModelId;
  const warnings = lifecycleWarnings(input.registry, input.policy.nowMs ?? Date.now());
  const gone = input.registry.entries.flatMap((m) => {
    const reasonCode = input.policy.unavailableModels?.[m.modelId];
    return reasonCode === undefined ? [] : [{ modelId: m.modelId, reasonCode }];
  });
  const paused = input.registry.entries.flatMap((m) => {
    if (!pausedIn(input.policy, m.modelId)) return [];
    const note = (input.policy.pausedModels as Readonly<Record<string, AccessPauseNote>>)[m.modelId] as AccessPauseNote;
    return [{ modelId: m.modelId, class: note.class, untilMs: note.untilMs }];
  });
  const base = {
    baselineModelId,
    sliceId: input.sliceId,
    registrySnapshotId: input.registry.snapshotId,
    ...(warnings.length === 0 ? {} : { lifecycleWarnings: warnings }),
    ...(gone.length === 0 ? {} : { unavailable: gone }),
    ...(paused.length === 0 ? {} : { accessLimited: paused }),
  };
  if (input.policy.pins.modelPin !== null) {
    const filtered = filterCandidates(input.registry, input.policy);
    const pinned = filtered.eligible.some((model) => model.modelId === input.policy.pins.modelPin);
    return {
      ...base,
      outcome: 'pinned',
      modelId: input.policy.pins.modelPin,
      reasonCode: pinned ? 'MODEL_PINNED' : 'PIN_CONFLICT',
      scored: [],
      eliminated: filtered.eliminated,
      shadow: [],
      saving: null,
    };
  }
  const filtered = filterCandidates(input.registry, input.policy);
  const eliminated: Elimination[] = [...filtered.eliminated];
  const shadow: string[] = [];
  const scored: ScoredCandidate[] = [];
  for (const model of filtered.eligible) {
    const quality = qualityFor(input.qualities, model.modelId, input.sliceId);
    if (quality === null || input.qualityFloor === null) {
      shadow.push(model.modelId);
      if (quality === null) eliminated.push({ modelId: model.modelId, gate: 'unknown-quality' });
      continue;
    }
    if (quality.lower < input.qualityFloor) {
      eliminated.push({ modelId: model.modelId, gate: 'below-quality-floor' });
      continue;
    }
    scored.push(scoreCandidate(model, quality, input.volume, input.assumptions));
  }
  const keep = (reasonCode: string, saving: Interval | null = null): RouteSelection => ({
    ...base,
    outcome: 'keep-baseline',
    modelId: baselineModelId,
    reasonCode,
    scored,
    eliminated,
    shadow,
    saving,
  });
  if (input.qualityFloor === null) return keep('NO_CALIBRATION');
  if (scored.length === 0) return keep('NO_QUALIFIED_CANDIDATE');
  const best = [...scored].sort((a, b) => a.utility.point - b.utility.point || (a.modelId < b.modelId ? -1 : 1))[0] as ScoredCandidate;
  if (best.modelId === baselineModelId) return keep('BASELINE_IS_BEST');
  const registered = registryModel(input.registry, baselineModelId);
  if (registered === null) return keep('BASELINE_NOT_IN_REGISTRY');
  const nowMs = input.policy.nowMs ?? Date.now();
  const baselinePriced = pricedThrough(input.registry, input.policy, registered);
  const baselineModel = { ...registered, tariff: tariffAt(baselinePriced.tariff, nowMs) };
  const estimated = [...new Set([...(filtered.costEstimates ?? []).filter((id) => id === best.modelId), ...(baselinePriced.estimate ? [baselineModelId] : [])])].sort();
  const est = estimated.length === 0 ? {} : { costEstimates: estimated };
  const baselineScore =
    scored.find((candidate) => candidate.modelId === baselineModelId) ??
    scoreCandidate(baselineModel, qualityFor(input.qualities, baselineModelId, input.sliceId), input.volume, input.assumptions);
  const saving: Interval = {
    lower: baselineScore.cost.lower - best.cost.upper,
    point: baselineScore.cost.point - best.cost.point,
    upper: baselineScore.cost.upper - best.cost.lower,
  };
  // A baseline past its retirement date is not kept for a saving argument: the best qualified
  // candidate replaces it.
  if (!lifecycleCheck(registered, nowMs).usable) return { ...base, ...est, outcome: 'select', modelId: best.modelId, reasonCode: 'BASELINE_RETIRING', scored, eliminated, shadow, saving };
  // A baseline found gone (or not accessible here) is replaced the same way.
  if (input.policy.unavailableModels?.[baselineModelId] !== undefined) return { ...base, ...est, outcome: 'select', modelId: best.modelId, reasonCode: 'BASELINE_UNAVAILABLE', scored, eliminated, shadow, saving };
  // A baseline whose scope is paused by an access limit is replaced the same way while it lasts (R72).
  if (pausedIn(input.policy, baselineModelId)) return { ...base, ...est, outcome: 'select', modelId: best.modelId, reasonCode: 'BASELINE_ACCESS_LIMITED', scored, eliminated, shadow, saving };
  if (saving.lower <= (input.minimumBenefitMicroUsd ?? 0)) return { ...keep('SAVING_WITHIN_UNCERTAINTY', saving), ...est };
  return { ...base, ...est, outcome: 'select', modelId: best.modelId, reasonCode: 'LOWEST_UTILITY_WITHIN_FLOOR', scored, eliminated, shadow, saving };
}

/** RTE-10: which task slices have evaluated quality, which are unevaluated, which are unknown. */
export interface SliceCoverage {
  readonly evaluated: readonly string[];
  readonly unevaluated: readonly string[];
  /** Slices seen in traffic that the taxonomy does not name. */
  readonly unknown: readonly string[];
}

export function sliceCoverage(input: {
  readonly taxonomy: readonly string[];
  readonly qualities: readonly QualityEstimate[];
  readonly observedSlices?: readonly string[];
  /** Slices a released calibration permits; a slice outside it is not evaluated for routing. */
  readonly permittedSlices?: readonly string[] | null;
}): SliceCoverage {
  const taxonomy = [...new Set(input.taxonomy)].sort();
  const withQuality = new Set(input.qualities.map((q) => q.sliceId));
  const permitted = input.permittedSlices === undefined || input.permittedSlices === null ? null : new Set(input.permittedSlices);
  const evaluated = taxonomy.filter((slice) => withQuality.has(slice) && (permitted === null || permitted.has(slice)));
  const unevaluated = taxonomy.filter((slice) => !evaluated.includes(slice));
  const unknown = [...new Set((input.observedSlices ?? []).filter((slice) => !taxonomy.includes(slice)))].sort();
  return { evaluated, unevaluated, unknown };
}

export const COST_PRECISIONS = ['provider-reported', 'estimate', 'unknown'] as const;
export type CostPrecision = (typeof COST_PRECISIONS)[number];

export interface ModelObservation {
  readonly requestedModelId: string | null;
  /** The model that actually ran, or `unknown` when nothing observed it. */
  readonly observedModelId: string;
  readonly observedFrom: 'sdk' | 'harness' | null;
  /** True when the observed model differs from the requested one; null when unobserved. */
  readonly substituted: boolean | null;
  readonly costPrecision: CostPrecision;
}

/**
 * RTE-11: requested and observed model, kept apart. The SDK's report wins over the harness
 * event; a missing observation is `unknown`, never the requested id.
 */
export function observeModel(input: {
  readonly requestedModelId: string | null;
  readonly sdkModelId?: string | null;
  readonly harnessModelId?: string | null;
  readonly usageReported: boolean;
  readonly costEstimated?: boolean;
}): ModelObservation {
  const sdk = typeof input.sdkModelId === 'string' && input.sdkModelId.length > 0 ? input.sdkModelId : null;
  const harness = typeof input.harnessModelId === 'string' && input.harnessModelId.length > 0 ? input.harnessModelId : null;
  const observed = sdk ?? harness;
  return {
    requestedModelId: input.requestedModelId,
    observedModelId: observed ?? 'unknown',
    observedFrom: sdk !== null ? 'sdk' : harness !== null ? 'harness' : null,
    substituted: observed === null || input.requestedModelId === null ? null : observed !== input.requestedModelId,
    costPrecision: input.usageReported ? 'provider-reported' : input.costEstimated === true ? 'estimate' : 'unknown',
  };
}
