/**
 * Managed-worker routing, end to end (RTE-12, US06, US34, US40, W01).
 *
 *   calibration loader -> router -> generation reservation -> owned-launch port -> receipt
 *
 * The kill switch is read before every selection: once stopped, the next selection abstains
 * without loading, reserving or launching. The launch port is the owned SDK session
 * (`runOwnedWorker` from `@jevris/adapter-claude-sdk` in production, a fake in tests); its
 * outcome is the receipt. The requested and observed model are kept apart (RTE-11), and the
 * reservation settles from reported usage or is held when usage is unknown.
 *
 * Route learning (C16, `route-learning.ts`), only when the caller passes the workspace's learning
 * state (the caller has already reconciled the slice against its posterior):
 * - an active slice (`auto`, from the signed baseline on day 1 or from the posterior later) routes
 *   between its active candidate and the baseline model at their posterior means, even without a
 *   threshold release;
 * - a slice held at the baseline after a demotion does not switch, whatever the release floor
 *   says; exploration still gathers evidence there;
 * - a slice pinned to a model runs that model when the router's gates allow it; a slice pinned to
 *   advice only never launches, and neither does anything with learning off;
 * - a low-risk bounded-auto route may explore another eligible model at the capped rate, weighted
 *   by its posterior. The result carries the choice and its propensity so the outcome can be
 *   logged against it;
 * - a model whose scope is paused by an access limit (the router policy's `pausedModels`, R72), or
 *   that has an unexpired legacy model-only usage-limit hit (R61), is never launched, explored or
 *   retried into (ACCESS_LIMITED, with the reset time; a legacy hit keeps its old code
 *   MODEL_USAGE_LIMITED until the legacy reader goes);
 * - on a subscription harness there is no per-token charge, so an active slice uses its candidate
 *   directly (the activation already weighed usage and latency); on an API key the router still
 *   weighs dollars between the candidate and the baseline;
 * - first-try routing (owner decision 2026-09-30, `first-try.ts`): when the slice has no learned or
 *   pinned model, a low-risk route starts on the baseline vendor's cheaper first-try model and is
 *   handed once to a stronger one if its check fails; a randomized control share runs the baseline
 *   first so the two can be compared. The launch reserves the first attempt AND the hand-off;
 * - arms are (model, effort): an active or pinned arm, and an explored one, launch with their
 *   effort (the launch port's `effort`; absent is the model's default). An active effort arm of
 *   the baseline model runs that model at that effort whenever the router's gates allow the model:
 *   the two arms share a model, so there is no model comparison and no cache transition. A
 *   demotion returns to the baseline model with no effort set (its default).
 */
import { PINNED_MODEL, contentHash, questionHash, servingHostOf, type Action, type FirstTrySetting, type JevQuestions, type ModelRegistry } from '@jevris/contracts';
import type { DecisionBudget } from './decision-budget.js';
import { ENCODER_ID } from './decision-tokens.js';
import type { CalibrationDecision } from './calibration-loader.js';
import { decideFirstTry, firstTryNote, type FirstTryHistory, type FirstTryNote } from './first-try.js';
import { generationCostMicroUsd, registryModel } from './model-registry.js';
import { nativeHarnessOf, qualifiedPublicPriors } from './public-priors.js';
import { filterCandidates, observeModel, routeTask, type ModelObservation, type QualityEstimate, type RouteInput, type RouteSelection } from './router.js';
import { hostTariffGuard } from './serving-tariff.js';
import { routeConsentGate, type ProviderConsentReader } from './provider-consent-gate.js';
import { ROUTE_HOST_NOT_CERTIFIED } from './route-turn.js';
import { activeVersion, armKey, armPosterior, defaultEffortOf, explorationChoice, slicePolicy, usageLimitStatus, EFFORT_LEVELS, type AuthMode, type EffortLevel, type ExplorationChoice, type LearningState, type RouteRisk } from './route-learning.js';

export interface LaunchUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** What the owned launch port reports back (the shape of `WorkerOutcome`). */
export interface LaunchReceipt {
  readonly status: string;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly usage: LaunchUsage | null;
  readonly costUsd: number | null;
  /**
   * `false` only when the port refused before any child process started (for example no login for
   * the host, or a consent refusal): nothing ran, so nothing can have been spent. The reservation is
   * then released, not held as unknown usage, and the route reports LAUNCH_NOT_STARTED. Absent is
   * a started run, settled from its usage as before. A port must never set it after a child starts.
   */
  readonly spawned?: false;
}

/** The launch port refused before any child process started (`LaunchReceipt.spawned: false`). */
export const LAUNCH_NOT_STARTED = 'LAUNCH_NOT_STARTED';

/**
 * The owned launch. `effort`, when present, is the effort level the worker runs at (Claude Code
 * `--effort`, Codex `model_reasoning_effort`); absent, the model's default.
 */
export type OwnedLaunchPort = (input: { readonly model: string; readonly maxBudgetUsd: number; readonly reservationId: string; readonly effort?: string }) => Promise<LaunchReceipt>;

export interface ManagedWorkerInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly killSwitchStopped: () => boolean | Promise<boolean>;
  readonly loadCalibration: () => Promise<CalibrationDecision>;
  readonly route: Omit<RouteInput, 'qualityFloor' | 'sliceId'>;
  /** The generation envelope (§19.4), separate from the decision-call budget. */
  readonly budget: DecisionBudget;
  readonly launch: OwnedLaunchPort;
  readonly now?: () => number;
  /**
   * The product mode (US03). In `observe` the selection is only recorded as a counterfactual:
   * nothing is reserved or launched and the worker keeps its approved model. Default
   * `bounded-auto` (the caller only runs this for owned workers in that mode).
   */
  readonly mode?: 'observe' | 'advise' | 'bounded-auto';
  /** Records the selection as an advisory decision (the engine's `recordAdvice`); returns its id. */
  readonly record?: (input: { readonly action: Action; readonly reasonCodes: readonly string[]; readonly mode: 'observe' | 'advise' | 'bounded-auto' }) => Promise<string | null>;
  /** The profile id recorded with a route-worker action. */
  readonly profileId?: string;
  /** The workspace's route-learning state (C16); absent, routing is exactly as without learning. */
  readonly learning?: WorkerLearning;
  /**
   * Serving hosts (R50 on owned workers): a worker whose policy names a pinned gateway or host
   * (`route.policy.servingHost`) launches only when D's route.host certification for its harness
   * holds (`certified`, from the certify record, never a plugin's claim) and the pair's consent
   * passes (`read`, B's stored consent; the worker's session runs through that host, so it is
   * signed in there, OQ-3). Absent: a pinned host never launches (ROUTE_HOST_NOT_CERTIFIED).
   */
  readonly hostRoute?: { readonly certified: boolean; readonly read?: ProviderConsentReader };
}

export interface WorkerLearning {
  readonly state: LearningState;
  readonly sliceId: string;
  readonly risk: RouteRisk;
  readonly random: () => number;
  /** How the worker's harness is billed (F detects it). Default `unknown`. */
  readonly authMode?: AuthMode;
  /** Models whose scope hit an access limit within `nearLimitHours` (`accessLimitNear`): never explored (R72). */
  readonly nearLimitModelIds?: readonly string[];
  /**
   * Sonnet-first routing (owner decision 2026-09-30): the `routing.firstTry` setting and this
   * workspace's measured first-try history for a candidate. Absent, no route is first-try.
   */
  readonly firstTry?: { readonly setting: FirstTrySetting; readonly history: (query: { readonly baselineModelId: string; readonly firstTryModelId: string }) => FirstTryHistory };
}

/** What the caller logs with the route's outcome (`recordRouteOutcome`). */
export interface WorkerLearningNote {
  readonly policyVersion: number;
  readonly sliceMode: 'advise' | 'auto' | 'pinned';
  readonly exploration: ExplorationChoice | null;
  readonly authMode: AuthMode;
  /**
   * Set when the chosen model is inside an access limit or a legacy usage limit: the caller must
   * not launch it before `resetAt` (null: no expiry, or not reported). `class` is the access-limit
   * class, absent for a legacy hit.
   */
  readonly usageLimit: { readonly modelId: string; readonly resetAt: string | null; readonly class?: string } | null;
  /** The effort the route launched (or would launch) with; null is the model's default. Log it with the outcome. */
  readonly effort: string | null;
  /** The baseline the slice was reconciled against: pass it to `learnFromOutcome` with the outcome. */
  readonly baselineModelId: string;
  /** The models the router's gates left eligible for this route: pass them to `learnFromOutcome`. */
  readonly eligibleModelIds: readonly string[];
  /**
   * The rules-only choice for the same route, with learning ignored: the calibrated selection (a
   * pin, the baseline kept, or the cheaper model within the floor), else the baseline that runs
   * without learning. Log it on every outcome (arm C, `rulesAttribution`). Null only when the
   * rules name no valid model id.
   */
  readonly rulesModelId: string | null;
  /**
   * Sonnet-first routing: the arm this route was assigned (first-try or control) with its propensity,
   * the first-try model, the hand-off order and the break-even, for the ledger. Absent when the route
   * stayed on the baseline for another reason.
   */
  readonly firstTry?: FirstTryNote;
}

export type ManagedWorkerResult =
  | {
      readonly launched: true;
      readonly selection: RouteSelection;
      /** The effort the worker was launched with; null is the model's default. */
      readonly effort: string | null;
      readonly reservationId: string;
      readonly reservedMicroUsd: number;
      readonly receipt: LaunchReceipt;
      readonly observation: ModelObservation;
      readonly settledMicroUsd: number | null;
    }
  | { readonly launched: false; readonly reasonCode: string; readonly selection: RouteSelection | null; readonly decisionId?: string | null };

type Launched = Extract<ManagedWorkerResult, { readonly launched: true }>;

/** Reserves the worst case, launches the owned worker (at `effort`, when set) and settles from reported usage. */
async function launchAndSettle(input: ManagedWorkerInput, selection: RouteSelection, reserve: number, effort: string | null = null): Promise<ManagedWorkerResult> {
  const model = registryModel(input.route.registry, selection.modelId);
  if (model === null) return { launched: false, reasonCode: 'SELECTION_NOT_IN_REGISTRY', selection };
  // Never launch a model found gone on this machine (or not accessible on this harness and sign-in).
  const unavailable = input.route.policy.unavailableModels?.[selection.modelId];
  if (unavailable !== undefined) return { launched: false, reasonCode: unavailable, selection };
  // Never launch into a scope an access limit pauses (R72): a kept baseline can be one.
  const paused = input.route.policy.pausedModels;
  if (paused !== undefined && Object.hasOwn(paused, selection.modelId)) return { launched: false, reasonCode: 'ACCESS_LIMITED', selection };
  // Serving hosts R50 (B's condition): never launch on a price only estimated through the route's
  // host, for the model launched or the baseline it was weighed against (a pinned host with no
  // known tariff there). Without a host in the policy every side is at its maker's tariff.
  const host = input.route.policy.servingHost ?? null;
  const tariff = hostTariffGuard(input.route.registry, [{ servingHost: host, modelId: selection.modelId }, { servingHost: host, modelId: selection.baselineModelId }], selection.costEstimates);
  if (tariff !== null) return { launched: false, reasonCode: tariff, selection };
  // A pinned gateway or host (not the maker's own API): route.host certified, and consent for the
  // pair (the host, what it forwards to, and the maker behind it). No host or a maker id: as before.
  if (host !== null && host !== model.provider && servingHostOf(host) !== undefined) {
    if (input.hostRoute?.certified !== true) return { launched: false, reasonCode: ROUTE_HOST_NOT_CERTIFIED, selection };
    const read: ProviderConsentReader = input.hostRoute.read ?? (() => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }));
    const pair = routeConsentGate(input.route.registry, [host], read, { provider: model.provider, servingHost: host, via: 'host' });
    if (!pair.allowed) return { launched: false, reasonCode: pair.reasonCode, selection };
  }
  const reserved = await input.budget.reserve({ decisionId: `gen-${input.taskId}`, workspaceId: input.workspaceId, microUsd: reserve });
  if (!reserved.ok) return { launched: false, reasonCode: reserved.reasonCode, selection };
  const reservationId = reserved.reservation.id;
  if (await input.killSwitchStopped()) {
    await input.budget.release(reservationId);
    return { launched: false, reasonCode: 'KILL_SWITCH', selection };
  }
  let receipt: LaunchReceipt;
  try {
    receipt = await input.launch({ model: selection.modelId, maxBudgetUsd: reserve / 1_000_000, reservationId, ...(effort === null ? {} : { effort }) });
  } catch {
    await input.budget.hold(reservationId);
    return { launched: false, reasonCode: 'LAUNCH_FAILED', selection };
  }
  // Known zero effect: the port refused before a child started, so the reservation is released
  // (nothing is held for reconciliation) and no outcome is recorded for a run that never ran.
  if (receipt.spawned === false) {
    await input.budget.release(reservationId);
    return { launched: false, reasonCode: LAUNCH_NOT_STARTED, selection };
  }
  const observation = observeModel({ requestedModelId: selection.modelId, sdkModelId: receipt.actualModel, usageReported: receipt.usage !== null });
  let settled: number | null = null;
  if (receipt.usage !== null) {
    const priced = registryModel(input.route.registry, observation.observedModelId) ?? model;
    settled = generationCostMicroUsd(priced.tariff, {
      inputTokens: receipt.usage.inputTokens,
      outputTokens: receipt.usage.outputTokens,
      cacheReadTokens: receipt.usage.cacheReadInputTokens,
      cacheWriteTokens: receipt.usage.cacheCreationInputTokens,
    });
    await input.budget.commit(reservationId, { usage: { inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens }, actualMicroUsd: settled });
  } else {
    await input.budget.hold(reservationId);
  }
  return { launched: true, selection, effort, reservationId, reservedMicroUsd: reserve, receipt, observation, settledMicroUsd: settled } satisfies Launched;
}

/**
 * The router inputs for an active slice: the active candidate against its baseline model, at their
 * current posterior means (the posterior test ran when the slice was activated, and every outcome
 * since re-ran it).
 */
function learnedRoute(learning: WorkerLearning, registry: ModelRegistry): { readonly qualities: QualityEstimate[]; readonly qualityFloor: number; readonly allow: readonly string[]; readonly effort: string | null; readonly sameModel: boolean } | null {
  const policy = slicePolicy(learning.state, learning.sliceId);
  if (policy.mode !== 'auto' || policy.modelId === null || policy.baselineModelId === null) return null;
  const effort = policy.effort ?? null;
  const candidate = armPosterior(learning.state, learning.sliceId, armKey(policy.modelId, effort, registry)).mean;
  const baseline = armPosterior(learning.state, learning.sliceId, policy.baselineModelId).mean;
  const sourceId = `local-learning:v${String(activeVersion(learning.state).version)}`;
  const at = (modelId: string, p: number): QualityEstimate => ({ modelId, sliceId: learning.sliceId, lower: p, point: p, upper: p, sourceId });
  return {
    qualities: [at(policy.modelId, candidate), at(policy.baselineModelId, baseline)],
    qualityFloor: Math.max(0, Math.min(candidate, baseline - learning.state.settings.nonInferiorityMargin)),
    allow: [policy.modelId, policy.baselineModelId],
    effort,
    sameModel: policy.modelId === policy.baselineModelId,
  };
}

/**
 * Reservation headroom for an effort above the model's default: twice the default-effort
 * estimate (a higher level spends more tokens; the arm's own measured cost replaces this once it
 * has one). A reservation is a budget bound, never a price claim.
 */
function effortHeadroom(learning: WorkerLearning | null, modelId: string, effort: string | null, registry: ModelRegistry): number {
  if (effort === null) return 1;
  const base = defaultEffortOf(modelId, registry);
  const above = base !== null && EFFORT_LEVELS.indexOf(effort as EffortLevel) > EFFORT_LEVELS.indexOf(base as EffortLevel);
  if (!above) return 1;
  const measured = learning === null ? null : (learning.state.arms[learning.sliceId]?.[armKey(modelId, effort, registry)] ?? null);
  return measured !== null && measured.costCount > 0 ? 1 : 2;
}

/** The reservation for an arm: the default estimate with effort headroom, or the arm's measured mean with retries when larger. */
function armReserve(learning: WorkerLearning | null, modelId: string, effort: string | null, estimate: number, retriesPerFailure: number, registry: ModelRegistry): number {
  if (effort === null) return Math.max(1, estimate);
  const arm = learning === null ? null : (learning.state.arms[learning.sliceId]?.[armKey(modelId, effort, registry)] ?? null);
  const measured = arm === null || arm.costCount === 0 ? 0 : Math.ceil((arm.costSumMicroUsd / arm.costCount) * (1 + retriesPerFailure));
  return Math.max(1, estimate * effortHeadroom(learning, modelId, effort, registry), measured);
}

/** Attaches the learning note to a result for the caller's outcome log. */
function noted<T extends ManagedWorkerResult>(result: T, note: WorkerLearningNote | null): T & { readonly learning?: WorkerLearningNote } {
  return note === null ? result : { ...result, learning: note };
}

/** Selects, reserves, launches and settles one managed worker. */
/** The id shape a route-outcome event accepts for `rulesModelId`. */
const RULES_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function runManagedWorker(input: ManagedWorkerInput): Promise<ManagedWorkerResult & { readonly learning?: WorkerLearningNote }> {
  if (await input.killSwitchStopped()) return { launched: false, reasonCode: 'KILL_SWITCH', selection: null };
  const calibration = await input.loadCalibration();
  const learning = input.learning ?? null;
  const sliceMode = learning === null ? null : slicePolicy(learning.state, learning.sliceId).mode;
  // Only a low-risk route follows an active slice's candidate; any other keeps the baseline model.
  const learned = learning === null || learning.risk !== 'low' ? null : learnedRoute(learning, input.route.registry);
  const authMode = learning?.authMode ?? 'unknown';
  // The effort the selected arm runs at (null: the model's default); an explored arm carries its own.
  let selectedEffort: string | null = null;
  const baselineOf = input.route.baselineModelId ?? input.route.registry.baselineModelId;
  let rules: { readonly rulesModelId: string | null; readonly eligibleModelIds: readonly string[] } | null = null;
  /** The rules-only counterfactual, computed once and only when a note is written. */
  const rulesOnly = (): { readonly rulesModelId: string | null; readonly eligibleModelIds: readonly string[] } => {
    if (rules !== null) return rules;
    const eligibleModelIds = filterCandidates(input.route.registry, input.route.policy).eligible.map((m) => m.modelId);
    const chosen = calibration.eligible ? routeTask({ ...input.route, sliceId: calibration.sliceId, qualityFloor: calibration.qualityFloor }).modelId : baselineOf;
    rules = { rulesModelId: RULES_ID.test(chosen) ? chosen : null, eligibleModelIds };
    return rules;
  };
  let firstTryAssigned: FirstTryNote | null = null;
  const note = (exploration: ExplorationChoice | null, usageLimit: WorkerLearningNote['usageLimit'] = null, effort: string | null = selectedEffort): WorkerLearningNote | null =>
    learning === null || sliceMode === null ? null : { policyVersion: activeVersion(learning.state).version, sliceMode, exploration, authMode, usageLimit, effort, baselineModelId: baselineOf, ...rulesOnly(), ...(firstTryAssigned === null ? {} : { firstTry: firstTryAssigned }) };
  const nowMs = input.route.policy.nowMs ?? (input.now ?? Date.now)();
  const limitCode = (limit: NonNullable<WorkerLearningNote['usageLimit']>): string => (limit.class === undefined ? 'MODEL_USAGE_LIMITED' : 'ACCESS_LIMITED');
  /** Never launch or retry into an access limit (R72) or a legacy usage limit (R61). */
  const limited = (modelId: string): WorkerLearningNote['usageLimit'] => {
    const paused = input.route.policy.pausedModels;
    if (paused !== undefined && Object.hasOwn(paused, modelId)) {
      const pause = paused[modelId] as NonNullable<typeof paused[string]>;
      return { modelId, resetAt: pause.untilMs === null ? null : new Date(pause.untilMs).toISOString(), class: pause.class };
    }
    if (learning === null) return null;
    const status = usageLimitStatus(learning.state, modelId, nowMs, authMode);
    return status.limited ? { modelId, resetAt: status.resetAt } : null;
  };
  let mode = input.mode ?? 'bounded-auto';
  // A slice pinned to advice only never launches automatically, and neither does anything with learning off.
  if (learning !== null && sliceMode === 'pinned' && slicePolicy(learning.state, learning.sliceId).modelId === null && mode === 'bounded-auto') mode = 'advise';
  if (learning !== null && !learning.state.settings.enabled && mode === 'bounded-auto') mode = 'advise';
  const pinnedModel = learning !== null && sliceMode === 'pinned' ? slicePolicy(learning.state, learning.sliceId).modelId : null;
  const pinnedEffort = learning !== null && sliceMode === 'pinned' ? (slicePolicy(learning.state, learning.sliceId).effort ?? null) : null;
  // After a demotion (an explicit advise) the baseline model stands: the release's floor does not re-select the candidate.
  const heldAtBaseline = learning !== null && ((sliceMode === 'advise' && activeVersion(learning.state).slices[learning.sliceId] !== undefined) || (sliceMode === 'auto' && learned === null));
  let selection: RouteSelection | null = null;
  if (pinnedModel !== null && filterCandidates(input.route.registry, input.route.policy).eligible.some((m) => m.modelId === pinnedModel)) {
    // A person pinned the slice to this model: it runs whenever the router's gates allow it.
    const baselineModelId = input.route.baselineModelId ?? input.route.registry.baselineModelId;
    selection = { outcome: 'select', modelId: pinnedModel, baselineModelId, reasonCode: 'PINNED_BY_USER', sliceId: (learning as WorkerLearning).sliceId, scored: [], eliminated: [], shadow: [], saving: null, registrySnapshotId: input.route.registry.snapshotId };
    selectedEffort = pinnedEffort;
  } else if (learned !== null && learning !== null) {
    const allowlist = input.route.policy.managedAllowlist === null ? [...learned.allow] : input.route.policy.managedAllowlist.filter((id) => learned.allow.includes(id));
    const promoted = learned.allow[0] as string;
    const promotedEligible = filterCandidates(input.route.registry, { ...input.route.policy, managedAllowlist: allowlist }).eligible.some((m) => m.modelId === promoted);
    if (learned.sameModel) {
      // An effort arm of the baseline model: the same model at another effort, so no model comparison and no cache transition.
      if (promotedEligible) {
        const baselineModelId = input.route.baselineModelId ?? input.route.registry.baselineModelId;
        selection = { outcome: 'select', modelId: promoted, baselineModelId, reasonCode: 'LEARNED_EFFORT', sliceId: learning.sliceId, scored: [], eliminated: [], shadow: [], saving: null, registrySnapshotId: input.route.registry.snapshotId };
        selectedEffort = learned.effort;
      }
    } else {
      selection = routeTask({ ...input.route, policy: { ...input.route.policy, managedAllowlist: allowlist }, qualities: learned.qualities, sliceId: learning.sliceId, qualityFloor: learned.qualityFloor });
      if (authMode === 'subscription' && selection.outcome !== 'select' && promotedEligible) {
        // No per-token charge: the dollar comparison does not apply, and the activation already weighed usage and latency.
        selection = { ...selection, outcome: 'select', modelId: promoted, reasonCode: 'LEARNED_POLICY_SUBSCRIPTION', saving: null };
      }
      if (selection.outcome === 'select' && selection.modelId === promoted) selectedEffort = learned.effort;
    }
  } else if (heldAtBaseline) {
    selection = null;
  } else if (calibration.eligible) {
    selection = routeTask({ ...input.route, sliceId: calibration.sliceId, qualityFloor: calibration.qualityFloor });
  } else if (learning === null || mode !== 'bounded-auto') {
    return noted({ launched: false, reasonCode: `CALIBRATION_${calibration.reasonCode}`, selection: null }, note(null));
  }
  if (mode !== 'bounded-auto') {
    if (selection === null) return noted({ launched: false, reasonCode: `CALIBRATION_${calibration.eligible ? 'NONE' : calibration.reasonCode}`, selection: null }, note(null));
    // US03: observe and advise never change the worker. The selection (or the baseline it kept)
    // is recorded as a counterfactual with the policy version; nothing is reserved or launched.
    const modelId = selection.modelId;
    const action: Action =
      selection.outcome === 'select' && modelId !== null
        ? { kind: 'route-worker', taskId: input.taskId, modelId, profileId: input.profileId ?? 'managed-worker' }
        : { kind: 'abstain', reasonCode: selection.reasonCode };
    const decisionId = input.record === undefined ? null : await input.record({ action, reasonCodes: [mode === 'observe' ? 'OBSERVE_MODE' : 'ADVISE_MODE', 'COUNTERFACTUAL', selection.reasonCode], mode });
    return noted({ launched: false, reasonCode: mode === 'observe' ? 'OBSERVE_MODE' : 'ADVISE_MODE', selection, decisionId }, note(null));
  }
  if (learning !== null) {
    // C16: narrow exploration among the models the router's gates leave eligible.
    const defaultModelId = selection?.modelId ?? input.route.policy.pins.modelPin ?? input.route.baselineModelId ?? input.route.registry.baselineModelId;
    const eligible = filterCandidates(input.route.registry, input.route.policy).eligible.map((m) => m.modelId);
    // SPEC §8.3, OD-14: a qualified board prior lets a model with no release prior be explored.
    // It is passed to exploration only; promotion still needs local randomized outcomes.
    const baselineModelId = input.route.baselineModelId ?? input.route.registry.baselineModelId;
    const releasePriors = learning.state.baseline[learning.sliceId]?.priors ?? [];
    const priors = [
      ...releasePriors,
      ...qualifiedPublicPriors({ state: learning.state, sliceId: learning.sliceId, modelIds: eligible, baselineModelId, harnessOf: (m) => nativeHarnessOf(input.route.registry, m), nowMs, registry: input.route.registry }),
    ];
    const choice = explorationChoice({
      state: learning.state,
      sliceId: learning.sliceId,
      mode,
      risk: learning.risk,
      defaultModelId,
      defaultEffort: selection === null ? null : selectedEffort,
      baselineModelId,
      eligibleModelIds: eligible,
      random: learning.random,
      ...(input.route.policy.nowMs === undefined ? {} : { nowMs: input.route.policy.nowMs }),
      registry: input.route.registry,
      priors,
      authMode,
      pausedModelIds: Object.keys(input.route.policy.pausedModels ?? {}),
      ...(learning.nearLimitModelIds === undefined ? {} : { nearLimitModelIds: learning.nearLimitModelIds }),
    });
    if (choice.explored) {
      const blocked = limited(choice.modelId);
      if (blocked !== null) return noted({ launched: false, reasonCode: limitCode(blocked), selection }, note(choice, blocked, choice.effort));
      const model = registryModel(input.route.registry, choice.modelId);
      if (model === null) return noted({ launched: false, reasonCode: 'SELECTION_NOT_IN_REGISTRY', selection }, note(choice, null, choice.effort));
      const generation = generationCostMicroUsd(model.tariff, input.route.volume);
      const retries = input.route.assumptions.retriesPerFailure ?? 1;
      const reserve = armReserve(learning, choice.modelId, choice.effort, Math.max(1, generation * (1 + retries)), retries, input.route.registry);
      const explored: RouteSelection = {
        outcome: 'select',
        modelId: choice.modelId,
        baselineModelId: defaultModelId,
        reasonCode: 'EXPLORED',
        sliceId: learning.sliceId,
        scored: [],
        eliminated: selection?.eliminated ?? [],
        shadow: [],
        saving: null,
        registrySnapshotId: input.route.registry.snapshotId,
      };
      return noted(await launchAndSettle(input, explored, reserve, choice.effort), note(choice, null, choice.effort));
    }
    // Sonnet-first routing (owner decision 2026-09-30): only where nothing learned or pinned applies to the
    // slice, on a low-risk route. The first-try model starts the task and a stronger one takes it once if its
    // check fails; a randomized control share runs the baseline first so the two can be compared.
    const firstTry = learning.firstTry;
    if (firstTry !== undefined && !choice.explored && pinnedModel === null && sliceMode !== 'pinned' && !heldAtBaseline && (selection === null || selection.outcome === 'keep-baseline')) {
      const decision = decideFirstTry({
        setting: firstTry.setting,
        risk: learning.risk,
        automated: mode === 'bounded-auto',
        learningEnabled: learning.state.settings.enabled,
        eligible: filterCandidates(input.route.registry, input.route.policy).eligible,
        baselineModelId,
        volume: input.route.volume,
        overhead: { verificationMicroUsd: input.route.assumptions.verificationMicroUsd, ...(input.route.assumptions.cacheTransitionMicroUsd === undefined ? {} : { cacheTransitionMicroUsd: input.route.assumptions.cacheTransitionMicroUsd }) },
        history: (firstTryModelId) => firstTry.history({ baselineModelId, firstTryModelId }),
        settings: learning.state.settings,
        random: learning.random,
      });
      firstTryAssigned = firstTryNote(decision);
      if (decision.route === 'first-try') {
        const first = registryModel(input.route.registry, decision.candidate.modelId);
        if (first !== null && limited(first.modelId) === null) {
          // The reservation covers the first attempt and the one hand-off, never less than before.
          const retries = input.route.assumptions.retriesPerFailure ?? 1;
          const first1 = decision.candidate.firstTryAttemptMicroUsd;
          const reserve = Math.max(1, first1 * (1 + retries), first1 + decision.candidate.stepUpAttemptMicroUsd);
          const routed: RouteSelection = { outcome: 'select', modelId: first.modelId, baselineModelId, reasonCode: decision.reasonCode, sliceId: learning.sliceId, scored: [], eliminated: [], shadow: [], saving: null, registrySnapshotId: input.route.registry.snapshotId };
          return noted(await launchAndSettle(input, routed, reserve, null), note(choice));
        }
        firstTryAssigned = null;
      }
    }
    if (selection === null) return noted({ launched: false, reasonCode: heldAtBaseline ? 'LEARNING_ADVISE' : `CALIBRATION_${calibration.eligible ? 'NONE' : calibration.reasonCode}`, selection: null }, note(choice));
    if (selection.outcome !== 'select') return noted({ launched: false, reasonCode: selection.reasonCode, selection }, note(choice, limited(selection.modelId)));
    const blocked = limited(selection.modelId);
    if (blocked !== null) return noted({ launched: false, reasonCode: limitCode(blocked), selection }, note(choice, blocked));
    const chosenId = selection.modelId;
    const scored = selection.scored.find((candidate) => candidate.modelId === chosenId);
    const model = registryModel(input.route.registry, chosenId);
    if (model === null) return noted({ launched: false, reasonCode: 'SELECTION_NOT_IN_REGISTRY', selection }, note(choice));
    // The reservation is the API-equivalent worst case; on a subscription it is an estimate, not a charge.
    const retries = input.route.assumptions.retriesPerFailure ?? 1;
    const estimate =
      scored === undefined
        ? Math.max(1, generationCostMicroUsd(model.tariff, input.route.volume) * (1 + retries))
        : Math.max(1, scored.breakdown.generation + scored.breakdown.expectedRetry, Math.ceil(scored.cost.upper - scored.breakdown.verification - scored.breakdown.routingOverhead));
    const reserve = armReserve(learning, chosenId, selectedEffort, estimate, retries, input.route.registry);
    return noted(await launchAndSettle(input, selection, reserve, selectedEffort), note(choice));
  }
  if (selection === null) return { launched: false, reasonCode: 'CALIBRATION_NONE', selection: null };
  if (selection.outcome !== 'select') return { launched: false, reasonCode: selection.reasonCode, selection };
  const chosen = selection;
  const scored = chosen.scored.find((candidate) => candidate.modelId === chosen.modelId);
  if (registryModel(input.route.registry, chosen.modelId) === null || scored === undefined) return { launched: false, reasonCode: 'SELECTION_NOT_IN_REGISTRY', selection };
  // Reserve the worst-case generation, including an expected retry.
  const reserve = Math.max(1, scored.breakdown.generation + scored.breakdown.expectedRetry, Math.ceil(scored.cost.upper - scored.breakdown.verification - scored.breakdown.routingOverhead));
  return launchAndSettle(input, selection, reserve);
}

/** The worker-readiness decision a routing calibration is released for (RTE-04, RTE-13). */
export const WORKER_READINESS_SPEC = Object.freeze({ id: 'worker-readiness', version: 'v1' });

/**
 * The question, as fixed text (no user text, only a description of the facts it is shown). The facts are
 * counts and categories: the files a task may change and the kind of each, its acceptance checks, any protected
 * path class and the kind of work. The anchors say what a bounded task looks like in those terms, so a small
 * task with a check reads as ready and an open-ended or security-sensitive one does not. A change to this
 * text changes its hash, and a signed calibration release is bound to that hash (US34): a release made for
 * an older text is refused until a new one is signed for this one.
 */
export const WORKER_READINESS_QUESTIONS: JevQuestions = Object.freeze({
  workerReady: {
    type: 'noul',
    instructions:
      'The facts describe a coding task by counts and categories only: how many files it may change and what kind each is, how many acceptance checks it has, any protected path class, and the kind of work. Using only those facts, is this a bounded task that a worker model can finish and pass its acceptance checks without escalating to a stronger model?',
    criteria: {
      true: 'The task is bounded: it changes a small, known set of files, none in a protected path class, and it has at least one acceptance check, so a worker can finish it and show that it is done.',
      false: 'The task is not bounded: it names no files or very many, it has no acceptance check, or it touches a protected path class such as security, secrets, CI or a data migration.',
    },
  },
}) as JevQuestions;

/** The calibration context for worker routing on one slice. */
export function workerCalibrationContext(input: { readonly sliceId: string; readonly nowMs: number; readonly modelId?: string }) {
  const modelId = input.modelId ?? PINNED_MODEL;
  return {
    nowMs: input.nowMs,
    decisionSpecId: WORKER_READINESS_SPEC.id,
    decisionSpecVersion: WORKER_READINESS_SPEC.version,
    questionHash: questionHash(WORKER_READINESS_QUESTIONS),
    modelId,
    modelRevisionHash: contentHash({ provider: 'typesafe', modelId }),
    encoderHash: contentHash({ encoderId: ENCODER_ID }),
    sliceId: input.sliceId,
  };
}
