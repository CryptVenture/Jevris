/**
 * Switch guard and main-session route advice (RTE-05, RTE-06, §8.4, C10, C14, US04, US10).
 *
 * Switching models mid-task loses the warm cache: each model has its own cache, so a model
 * switch is always cold. The transition cost is what the warm prefix costs to re-establish on
 * the target (its cache-write price for the session's TTL, 5-minute by default or 1-hour for a
 * Claude Code subscription main conversation; its input price when that is unknown) minus what
 * staying would cost (reading the prefix from the current model's cache, or re-encoding it when
 * the cache is cold). Returning to the previous model within its TTL could hit its old cache;
 * that is not credited, so the cost is an upper bound.
 *
 * An effort change on the same model is different. Where the model supports per-message effort
 * (Opus 5.5, Fable 5.1, Opus 5 on the Anthropic-operated platforms) the cache is kept and the
 * change costs nothing to move; elsewhere a new effort level restarts the cache and costs the
 * prefix rewrite on the same model (`effortTransitionCostMicroUsd`). A switch needs the worst-case saving minus that
 * transition cost to reach the minimum benefit, a dwell interval in completed work units since
 * the last switch, and fewer than the maximum switches per task. The explanation names the
 * transition cost.
 *
 * Main-session advice is a template naming the model, the reason, the cost basis and the pin
 * state. The user's pin is carried from the hook and never overridden: a pinned session gets
 * `keep` with `pinned-kept`. Each advice key prompts once per sidecar lifetime.
 */
import {
  RouteAdviceContract,
  contentHash,
  type SessionSnapshot,
  type ModelRegistry,
  type RouteAdvice,
  type RoutePins,
  type RoutingModel,
} from '@jevris/contracts';
import { cacheWritePrice, effortSwitchKeepsCache, microPerMillion, registryModel, type CacheTtl } from './model-registry.js';
import type { Interval, RouteSelection } from './router.js';

export interface TransitionInput {
  readonly from: RoutingModel | null;
  readonly to: RoutingModel;
  /** Tokens of warm prefix (system prompt, tools, conversation) that would move. */
  readonly warmPrefixTokens: number;
  /** Whether the current model's cache holds the prefix now. */
  readonly cacheWarm: boolean;
  /** The cache TTL the target write uses. Default `5m`. */
  readonly cacheTtl?: CacheTtl;
}

/** Transition cost in micro-USD (never negative). */
export function transitionCostMicroUsd(input: TransitionInput): number {
  const tokens = Number.isFinite(input.warmPrefixTokens) && input.warmPrefixTokens > 0 ? input.warmPrefixTokens : 0;
  if (tokens === 0 || (input.from !== null && input.from.modelId === input.to.modelId)) return 0;
  const moveRate = microPerMillion(cacheWritePrice(input.to.tariff, input.cacheTtl ?? '5m'));
  let stayRate = 0;
  if (input.from !== null) stayRate = stayRateOf(input.from, input.cacheWarm);
  return Math.max(0, Math.ceil((tokens * (moveRate - stayRate)) / 1_000_000));
}

function stayRateOf(model: RoutingModel, cacheWarm: boolean): number {
  const current = model.tariff;
  return cacheWarm && current.cacheReadPerMillion !== null ? microPerMillion(current.cacheReadPerMillion) : microPerMillion(current.inputPerMillion);
}

export interface EffortTransitionInput {
  readonly model: RoutingModel;
  readonly warmPrefixTokens: number;
  readonly cacheWarm: boolean;
  readonly cacheTtl?: CacheTtl;
  /** Where the session runs (`claude-api` for the Anthropic-operated platforms). Required: no Claude default. */
  readonly platform: string;
}

/**
 * The cost of changing effort on the same model, micro-USD. Zero when the model keeps the cache
 * across a per-message effort change on this platform; otherwise the prefix is rewritten on the
 * same model, exactly like a switch.
 */
export function effortTransitionCostMicroUsd(input: EffortTransitionInput): number {
  const tokens = Number.isFinite(input.warmPrefixTokens) && input.warmPrefixTokens > 0 ? input.warmPrefixTokens : 0;
  if (tokens === 0 || effortSwitchKeepsCache(input.model, input.platform)) return 0;
  const moveRate = microPerMillion(cacheWritePrice(input.model.tariff, input.cacheTtl ?? '5m'));
  return Math.max(0, Math.ceil((tokens * (moveRate - stayRateOf(input.model, input.cacheWarm))) / 1_000_000));
}

export interface SwitchPolicy {
  readonly minimumBenefitMicroUsd: number;
  /** Completed work units required since the last switch. */
  readonly dwellUnits: number;
  readonly maxSwitchesPerTask: number;
}

export const DEFAULT_SWITCH_POLICY: SwitchPolicy = Object.freeze({ minimumBenefitMicroUsd: 10_000, dwellUnits: 2, maxSwitchesPerTask: 2 });

export interface SwitchInput {
  readonly transitionCostMicroUsd: number;
  /** Expected saving of the target over the current model, as an interval. */
  readonly saving: Interval;
  /** Completed work units since the last switch (or since the task started). */
  readonly unitsSinceLastSwitch: number;
  readonly switchesThisTask: number;
  /** A task boundary, a new worker or a compact handoff. */
  readonly atBoundary: boolean;
  readonly policy?: SwitchPolicy;
  /**
   * How the session's harness is billed. An API key pays the dollars; a subscription has no
   * per-token charge, so the dollars are an API-equivalent estimate of usage-limit consumption.
   * Default `unknown`, labelled an estimate.
   */
  readonly authMode?: 'api-key' | 'subscription' | 'unknown';
}

export interface SwitchDecision {
  readonly allowed: boolean;
  readonly reasonCode: 'SWITCH_ALLOWED' | 'NOT_AT_BOUNDARY' | 'MAX_SWITCHES' | 'DWELL' | 'BELOW_MINIMUM_BENEFIT' | 'TRANSITION_COST_UNKNOWN';
  readonly transitionCostMicroUsd: number;
  /** Worst-case saving minus transition cost, micro-USD. */
  readonly netBenefitMicroUsd: number;
  readonly explanation: string;
}

function usd(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  return `${sign}$${(Math.abs(micro) / 1_000_000).toFixed(4)}`;
}

/** RTE-05: whether a model switch is worth its transition cost now. */
export function switchGuard(input: SwitchInput): SwitchDecision {
  const policy = input.policy ?? DEFAULT_SWITCH_POLICY;
  const transition = Math.max(0, Math.round(input.transitionCostMicroUsd));
  const net = Math.round(input.saving.lower) - transition;
  const basis =
    input.authMode === 'api-key'
      ? 'billed at API list price'
      : input.authMode === 'subscription'
        ? 'an API-equivalent estimate (a subscription has no per-token charge; the real cost is usage-limit consumption)'
        : 'an API-equivalent estimate (the harness billing mode is not known)';
  const decide = (reasonCode: SwitchDecision['reasonCode'], why: string): SwitchDecision => ({
    allowed: reasonCode === 'SWITCH_ALLOWED',
    reasonCode,
    transitionCostMicroUsd: transition,
    netBenefitMicroUsd: net,
    explanation: `${why} Transition cost ${usd(transition)} (warm prefix moved to the new model), ${basis}; worst-case saving ${usd(Math.round(input.saving.lower))}, net ${usd(net)}.`,
  });
  if (!input.atBoundary) return decide('NOT_AT_BOUNDARY', 'No switch mid-step: wait for a task boundary, a new worker or a handoff.');
  if (input.switchesThisTask >= policy.maxSwitchesPerTask) return decide('MAX_SWITCHES', `This task already switched ${input.switchesThisTask} times.`);
  if (input.unitsSinceLastSwitch < policy.dwellUnits) return decide('DWELL', `Only ${input.unitsSinceLastSwitch} work units since the last switch.`);
  if (net < policy.minimumBenefitMicroUsd) return decide('BELOW_MINIMUM_BENEFIT', `The benefit does not reach the minimum ${usd(policy.minimumBenefitMicroUsd)}.`);
  return decide('SWITCH_ALLOWED', 'The switch clears the minimum benefit after its transition cost.');
}

/** A bounded, validated pin pair from an untrusted hook body. Unknown shapes mean no pin. */
export function readPins(value: unknown): RoutePins {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,127}$/;
  const plain = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const model = plain['modelPin'];
  const effort = plain['effortPin'];
  return {
    modelPin: typeof model === 'string' && pattern.test(model) ? model : null,
    effortPin: typeof effort === 'string' && pattern.test(effort) ? effort : null,
  };
}

/** Remembers which advice keys were shown, so each prompts once. */
export class AdviceOnce {
  readonly #seen = new Set<string>();
  readonly #max: number;
  constructor(max = 4096) {
    this.#max = Math.max(16, max);
  }
  /** True when the key was already shown (read only; nothing is marked). */
  seen(key: string): boolean {
    return this.#seen.has(key);
  }
  /** True the first time a key is offered, and marks it shown. */
  first(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > this.#max) {
      const oldest = this.#seen.values().next();
      if (oldest.done !== true) this.#seen.delete(oldest.value);
    }
    return true;
  }
}

export type CostBasis = RouteAdvice['costBasis'];

export interface MainRouteInput {
  readonly registry: ModelRegistry;
  readonly pins: RoutePins;
  /** Session or task identity the advice key is scoped to. */
  readonly scopeId: string;
  readonly requestedModelId: string | null;
  readonly observedModelId: string | null;
  readonly selection: RouteSelection | null;
  readonly switchDecision: SwitchDecision | null;
  readonly costBasis: CostBasis;
  readonly once?: AdviceOnce;
}

export type MainRouteResult = { readonly shown: true; readonly advice: RouteAdvice } | { readonly shown: false; readonly reasonCode: 'ALREADY_PROMPTED' | 'INVALID_ADVICE'; readonly advice: RouteAdvice | null };

function nameOf(registry: ModelRegistry, modelId: string): string {
  const entry = registryModel(registry, modelId);
  return entry?.displayName ?? modelId;
}

function basisText(basis: CostBasis): string {
  if (basis === 'api-list-price') return 'API list prices from the registry snapshot';
  if (basis === 'subscription-quota') return 'subscription quota (an API-equivalent estimate, not money saved from a fixed plan)';
  // Serving hosts R48: the route's host has no known tariff for a side, so the maker's price stands in.
  if (basis === 'maker-price-estimate') return "the maker's list price as an estimate; the serving host's tariff is not known";
  return 'unknown billing, so no saving is estimated';
}

/** RTE-06: templated main-session advice. Never changes the model itself. */
export function renderRouteAdvice(input: MainRouteInput): MainRouteResult {
  const pinned = input.pins.modelPin !== null;
  const selection = input.selection;
  const current = input.observedModelId ?? input.requestedModelId;
  let outcome: RouteAdvice['outcome'];
  let recommended: string | null = null;
  let reasonCode: string;
  let text: string;
  let estimate: RouteAdvice['estimate'] = null;
  if (pinned) {
    outcome = 'keep';
    reasonCode = 'MODEL_PINNED';
    text = `Your model pin ${nameOf(input.registry, input.pins.modelPin as string)} is kept. Jevris does not change a pinned model.`;
  } else if (selection === null || selection.outcome !== 'select') {
    outcome = selection === null ? 'abstain' : 'keep';
    reasonCode = selection?.reasonCode ?? 'NO_ROUTE_DECISION';
    text = `Jevris has no evaluated reason to change the model (${reasonCode}). Keep ${current === null ? 'the current model' : nameOf(input.registry, current)}.`;
  } else if (input.switchDecision !== null && !input.switchDecision.allowed) {
    outcome = 'keep';
    reasonCode = input.switchDecision.reasonCode;
    text = `Keep ${current === null ? 'the current model' : nameOf(input.registry, current)}. ${input.switchDecision.explanation}`;
  } else {
    outcome = 'recommend';
    recommended = selection.modelId;
    reasonCode = selection.reasonCode;
    const saving = selection.saving;
    const transition = input.switchDecision?.transitionCostMicroUsd ?? 0;
    if (saving !== null && input.costBasis !== 'unknown') {
      estimate = {
        expectedSavingMicroUsd: Math.round(saving.point) - transition,
        lowerMicroUsd: Math.round(saving.lower) - transition,
        upperMicroUsd: Math.round(saving.upper) - transition,
        transitionCostMicroUsd: transition,
      };
    }
    const range = estimate === null ? 'No saving is estimated' : `Estimated saving ${usd(estimate.lowerMicroUsd)} to ${usd(estimate.upperMicroUsd)} per task after a ${usd(transition)} switch cost; an estimate, not a measured saving`;
    text = `Jevris suggests ${nameOf(input.registry, selection.modelId)} for this ${selection.sliceId} task: its evaluated quality meets the floor at lower expected cost. Cost basis: ${basisText(input.costBasis)}. ${range}. Change the model yourself if you agree; no pin is set.`;
  }
  const adviceKey = contentHash({
    scope: input.scopeId,
    outcome,
    recommended,
    reasonCode,
    pinned: input.pins.modelPin,
    snapshot: input.registry.snapshotId,
  });
  const candidate = {
    schemaVersion: '1.0',
    outcome,
    requestedModelId: input.requestedModelId,
    observedModelId: input.observedModelId,
    recommendedModelId: recommended,
    reasonCode,
    costBasis: input.costBasis,
    estimate,
    pinState: pinned ? 'pinned-kept' : 'unpinned',
    registrySnapshotId: input.registry.snapshotId,
    adviceKey,
    text: text.slice(0, 600),
  };
  const checked = RouteAdviceContract.validate(candidate);
  if (!checked.ok) return { shown: false, reasonCode: 'INVALID_ADVICE', advice: null };
  if (input.once !== undefined && !input.once.first(adviceKey)) return { shown: false, reasonCode: 'ALREADY_PROMPTED', advice: checked.value };
  return { shown: true, advice: checked.value };
}

export interface AdviseMainRouteOptions {
  readonly selection?: RouteSelection | null;
  readonly switchDecision?: SwitchDecision | null;
  readonly costBasis?: CostBasis;
  readonly once?: AdviceOnce;
}

/**
 * The surface port (`jevris route`, `jevris_plan_route`): advice for one session snapshot.
 * Without an evaluated route selection it keeps the current model and says why. A pin is
 * always kept. Returns the RouteAdvice even when the key was already prompted.
 */
export function adviseMainRoute(snapshot: SessionSnapshot, registry: ModelRegistry, pins: RoutePins, options: AdviseMainRouteOptions = {}): RouteAdvice {
  const result = renderRouteAdvice({
    registry,
    pins: readPins(pins),
    scopeId: [snapshot.workspaceId, snapshot.sessionId].join(':'),
    requestedModelId: snapshot.requestedModelId,
    observedModelId: snapshot.actualModelId,
    selection: options.selection ?? null,
    switchDecision: options.switchDecision ?? null,
    costBasis: options.costBasis ?? 'unknown',
    ...(options.once === undefined ? {} : { once: options.once }),
  });
  if (result.advice !== null) return result.advice;
  // The template always validates; this is a defensive, contract-shaped abstain.
  return {
    schemaVersion: '1.0',
    outcome: 'abstain',
    requestedModelId: snapshot.requestedModelId,
    observedModelId: snapshot.actualModelId,
    recommendedModelId: null,
    reasonCode: 'INVALID_ADVICE',
    costBasis: 'unknown',
    estimate: null,
    pinState: pins.modelPin === null ? 'unpinned' : 'pinned-kept',
    registrySnapshotId: registry.snapshotId,
    adviceKey: contentHash({ scope: snapshot.sessionId, reasonCode: 'INVALID_ADVICE' }),
    text: 'Jevris could not form route advice; keep the current model.',
  };
}
