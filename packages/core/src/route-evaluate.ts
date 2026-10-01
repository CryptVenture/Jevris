/**
 * Product route evaluation (RTE-02..06, C09, C10, C14, §8.3, §8.4, US03, US06, US07, US10, US11).
 *
 * The sidecar's `route` op and the model-switch hook ask the same question: given the task
 * slice, is there an evaluated reason to use another model? The evidence is:
 * - the signed calibration release for the slice, which gives the quality floor and the
 *   per-model quality intervals measured on the holdout (`modelQualities`);
 * - the model registry (`<config>/model-registry.json`, else the bundled snapshot), which gives
 *   tariffs, regions, capabilities, health and per-account eligibility;
 * - the administrator's routing policy (`<config>/routing-policy.json`), which gives the
 *   account, managed allowlist, providers, regions, capabilities, cost assumptions and whether
 *   the workspace is zero-data-retention (`zeroDataRetention: true` routes only to models the
 *   registry marks ZDR eligible, so never to a Covered Model such as Fable 5.1).
 * Without any of those the answer is a named abstention, never a guess.
 *
 * Two roles:
 * - `worker`: a new managed worker. There is no warm cache to move, so the router's choice
 *   stands.
 * - `main`: the running session. The baseline is the current model, and a different choice
 *   must also clear the switch guard with the warm-prefix transition cost. When the caller
 *   does not report the warm prefix, the switch cannot be priced and the current model is
 *   kept (TRANSITION_COST_UNKNOWN).
 * A pin is always kept (routeTask returns `pinned`), and nothing here changes a model.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { servingHostOf, type CalibrationArtifact, type ModelRegistry, type RoutePins } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { routeAccessPauses, type AccessPauseNote } from './access-limits.js';
import { loadCalibration, type CalibrationDecision } from './calibration-loader.js';
import { DecisionBudget } from './decision-budget.js';
import { loadModelAvailability, unavailableModels, type ModelUnavailableReason } from './model-availability.js';
import { loadModelRegistryChecked, registryModel, routeBaseline, type CacheTtl, type TokenVolume } from './model-registry.js';
import { NO_STORED_CONSENT, providerConsentGate, routeConsentGate, type ProviderConsentReader } from './provider-consent-gate.js';
import { locallyEligibleModels, modelEligibility, ranHereProviders, readModelOffer, type EligibilityScope, type ModelOffer } from './model-offer.js';
import { filterCandidates, routeTask, type CostAssumptions, type QualityEstimate, type RouteSelection, type RoutingPolicy } from './router.js';
import { DEFAULT_SWITCH_POLICY, switchGuard, transitionCostMicroUsd, type SwitchDecision } from './route-switch.js';
import { armKey, baselinePriorsFromRelease, learningSettings, learningSliceKey, loadLearningState, reconcileLearning, secureRandom, type AuthMode, type LearningState, type RouteRisk } from './route-learning.js';
import { sliceTaskVolume } from './task-volume.js';
import { runManagedWorker, workerCalibrationContext, type ManagedWorkerInput, type ManagedWorkerResult, type OwnedLaunchPort, type WorkerLearning, type WorkerLearningNote } from './route-worker.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,127}$/;
const POLICY_CAP = 64 * 1024;

/** Cost assumptions when the routing policy names none (per task attempt, micro-USD). */
export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = Object.freeze({ verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 });

/** The task size assumed when the caller reports none (a bounded edit). */
export const DEFAULT_TASK_VOLUME: TokenVolume = Object.freeze({ inputTokens: 400_000, outputTokens: 40_000 });

export interface RoutingPolicySettings {
  readonly accountId: string | null;
  readonly managedAllowlist: readonly string[] | null;
  readonly allowedProviders: readonly string[] | null;
  readonly allowedRegions: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly assumptions: CostAssumptions;
  readonly minimumBenefitMicroUsd: number;
  readonly defaultTaskVolume: TokenVolume;
  /** The owned-worker generation envelope per calendar month, micro-USD. */
  readonly generationBudgetMicroUsd: number;
  /** True for a zero-data-retention workspace: only ZDR-eligible models are routed. */
  readonly zeroDataRetention: boolean;
  /** Where the settings came from. */
  readonly source: 'file' | 'default';
}

export function routingPolicyFile(home: string): string {
  return join(jevrisPaths({ home }).config, 'routing-policy.json');
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ids(value: unknown, pattern: RegExp, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function micro(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : null;
}

/** The one account the local registry's eligibility check names, or null when none or several. */
export function registryAccount(registry: ModelRegistry): string | null {
  const accounts = new Set<string>();
  for (const entry of registry.entries) for (const check of entry.accountEligibility) accounts.add(check.accountId);
  return accounts.size === 1 ? ([...accounts][0] as string) : null;
}

const POLICY_KEYS = ['schemaVersion', 'accountId', 'managedAllowlist', 'allowedProviders', 'allowedRegions', 'requiredCapabilities', 'costAssumptions', 'minimumBenefitMicroUsd', 'defaultTaskTokens', 'generationBudgetMicroUsd', 'zeroDataRetention'];

/**
 * Parses a routing-policy document. Unknown keys, a wrong type or an out-of-range amount refuse
 * the whole file (the caller then abstains with ROUTING_POLICY_INVALID), never a partial read.
 */
export function parseRoutingPolicy(value: unknown, registry: ModelRegistry): RoutingPolicySettings | null {
  if (!plain(value) || value['schemaVersion'] !== '1.0' || Object.keys(value).some((key) => !POLICY_KEYS.includes(key))) return null;
  const optionalIds = (key: string, pattern: RegExp): string[] | null | undefined => {
    const raw = value[key];
    if (raw === undefined || raw === null) return null;
    return ids(raw, pattern, 256) ?? undefined;
  };
  const allowlist = optionalIds('managedAllowlist', MODEL_ID);
  const providers = optionalIds('allowedProviders', ID);
  const regions = value['allowedRegions'] === undefined ? ['global'] : ids(value['allowedRegions'], ID, 64);
  const capabilities = value['requiredCapabilities'] === undefined ? ['tools'] : ids(value['requiredCapabilities'], ID, 64);
  const account = value['accountId'];
  if (allowlist === undefined || providers === undefined || regions === null || regions.length === 0 || capabilities === null) return null;
  if (account !== undefined && account !== null && (typeof account !== 'string' || !ID.test(account))) return null;
  let assumptions = DEFAULT_COST_ASSUMPTIONS;
  if (value['costAssumptions'] !== undefined) {
    const raw = value['costAssumptions'];
    if (!plain(raw) || Object.keys(raw).some((key) => !['verificationMicroUsd', 'reworkMicroUsd', 'routingOverheadMicroUsd'].includes(key))) return null;
    const verification = micro(raw['verificationMicroUsd'] ?? DEFAULT_COST_ASSUMPTIONS.verificationMicroUsd);
    const rework = micro(raw['reworkMicroUsd'] ?? DEFAULT_COST_ASSUMPTIONS.reworkMicroUsd);
    const overhead = micro(raw['routingOverheadMicroUsd'] ?? DEFAULT_COST_ASSUMPTIONS.routingOverheadMicroUsd);
    if (verification === null || rework === null || overhead === null) return null;
    assumptions = { verificationMicroUsd: verification, reworkMicroUsd: rework, routingOverheadMicroUsd: overhead };
  }
  const benefit = value['minimumBenefitMicroUsd'] === undefined ? DEFAULT_SWITCH_POLICY.minimumBenefitMicroUsd : micro(value['minimumBenefitMicroUsd']);
  if (benefit === null) return null;
  const generation = value['generationBudgetMicroUsd'] === undefined ? DEFAULT_GENERATION_BUDGET_MICRO_USD : micro(value['generationBudgetMicroUsd']);
  if (generation === null) return null;
  const zdr = value['zeroDataRetention'] ?? false;
  if (typeof zdr !== 'boolean') return null;
  let volume = DEFAULT_TASK_VOLUME;
  if (value['defaultTaskTokens'] !== undefined) {
    const parsed = taskVolume(value['defaultTaskTokens']);
    if (parsed === null) return null;
    volume = parsed;
  }
  return {
    accountId: typeof account === 'string' ? account : registryAccount(registry),
    managedAllowlist: allowlist,
    allowedProviders: providers,
    allowedRegions: regions,
    requiredCapabilities: capabilities,
    assumptions,
    minimumBenefitMicroUsd: benefit,
    defaultTaskVolume: volume,
    generationBudgetMicroUsd: generation,
    zeroDataRetention: zdr,
    source: 'file',
  };
}

/** `{ inputTokens, outputTokens }`, each a non-negative integer up to 100M, or null. */
export function taskVolume(value: unknown): TokenVolume | null {
  if (!plain(value) || Object.keys(value).some((key) => key !== 'inputTokens' && key !== 'outputTokens')) return null;
  const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000 ? v : null);
  const input = count(value['inputTokens']);
  const output = count(value['outputTokens']);
  return input === null || output === null || input + output === 0 ? null : { inputTokens: input, outputTokens: output };
}

/**
 * The administrator's routing policy. A missing file gives the defaults (no managed allowlist,
 * the `global` region, tools required, the account from the registry's eligibility check). An
 * unreadable or invalid file is `null`: the caller abstains rather than route without it.
 */
export async function loadRoutingPolicy(input: { readonly home: string; readonly registry: ModelRegistry }): Promise<RoutingPolicySettings | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(routingPolicyFile(input.home));
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== 'ENOENT') return null;
    return {
      accountId: registryAccount(input.registry),
      managedAllowlist: null,
      allowedProviders: null,
      allowedRegions: ['global'],
      requiredCapabilities: ['tools'],
      assumptions: DEFAULT_COST_ASSUMPTIONS,
      minimumBenefitMicroUsd: DEFAULT_SWITCH_POLICY.minimumBenefitMicroUsd,
      defaultTaskVolume: DEFAULT_TASK_VOLUME,
      generationBudgetMicroUsd: DEFAULT_GENERATION_BUDGET_MICRO_USD,
      zeroDataRetention: false,
      source: 'default',
    };
  }
  if (bytes.byteLength > POLICY_CAP) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  return parseRoutingPolicy(value, input.registry);
}

/** The released per-model qualities for one slice, as router quality estimates. */
export function releasedQualities(artifact: CalibrationArtifact, sliceId: string, registry?: ModelRegistry): QualityEstimate[] {
  // The router compares models at their default effort; an effort arm's quality is route learning's (C16).
  return (artifact.modelQualities ?? [])
    .filter((quality) => quality.sliceId === sliceId && (quality.effort === undefined || armKey(quality.modelId, quality.effort, registry) === quality.modelId))
    .map((quality) => ({ modelId: quality.modelId, sliceId: quality.sliceId, lower: quality.lower, point: quality.point, upper: quality.upper, sourceId: artifact.id }));
}

/** What the caller knows about the running session, for the switch guard (main role only). */
export interface SwitchContext {
  /** Warm prefix tokens (system prompt, tools, conversation) that a switch would move. */
  readonly warmPrefixTokens: number;
  readonly cacheWarm: boolean;
  /** A task boundary, a new worker or a compact handoff. */
  readonly atBoundary: boolean;
  readonly unitsSinceLastSwitch: number;
  readonly switchesThisTask: number;
  /** The session's cache TTL: `1h` for a Claude Code subscription main conversation. Default `5m`. */
  readonly cacheTtl?: CacheTtl;
  /** How the session's harness is billed; labels the transition cost. Default `unknown`. */
  readonly authMode?: 'api-key' | 'subscription' | 'unknown';
}

export interface RouteEvaluationInput {
  readonly role: 'main' | 'worker';
  readonly home: string;
  readonly registry: ModelRegistry;
  readonly trustedKeys: ReadonlyMap<string, string>;
  /** The package's bundled baseline release file, read when the config folder has none. */
  readonly bundledCalibration?: string | null;
  readonly killSwitchStopped: boolean;
  readonly sliceId: string | null;
  readonly currentModel: string | null;
  readonly pins: RoutePins;
  /** The remaining work; the routing policy's default task size when absent. */
  readonly volume?: TokenVolume | null;
  /** Context the task needs, tokens (0 when unknown). */
  readonly requiredContextTokens?: number;
  readonly switchContext?: SwitchContext | null;
  readonly nowMs?: number;
  /**
   * The harness and sign-in the route is for, when known: they scope the local eligibility
   * evidence (model-offer.ts). Absent, evidence from any harness on this machine counts (advice).
   */
  readonly harness?: string | null;
  readonly authMode?: string | null;
  /**
   * R30, OD-4: the providers the route may send content to, from `providerConsentGate` (stored
   * consent plus the signed-in default). Absent, it is derived from `providerConsent` and
   * `signedInProviders` when a reader is given; else only a provider that always needs consent
   * (pinned in code) is left out.
   */
  readonly consentedProviders?: readonly string[] | null;
  /** B's stored-consent reader (MEDIUM 9: advice passes the same consent gate as actuation). */
  readonly providerConsent?: ProviderConsentReader;
  /** The providers the session is signed in to (`sessionSignedInProviders`). */
  readonly signedInProviders?: readonly string[];
}

/**
 * The models eligible from local evidence for a route (owner decision DOMAINS 3f090fa), or null
 * when an administrator's account check decides (`accountId` set). Never throws: an unreadable
 * record is no evidence.
 */
export async function locallyEligibleFor(input: {
  readonly home: string;
  readonly registry: ModelRegistry;
  readonly accountId: string | null;
  readonly unavailable: Readonly<Record<string, ModelUnavailableReason>>;
  readonly scope: EligibilityScope;
}): Promise<readonly string[] | null> {
  if (input.accountId !== null) return null;
  const offer = await readModelOffer(input.home).catch(() => null);
  return locallyEligibleModels(modelEligibility({ registry: input.registry, accountId: null, offer, unavailable: input.unavailable, scope: input.scope }));
}

export interface RouteEvaluation {
  /** The router's selection, or null when the evidence to run it is missing. */
  readonly selection: RouteSelection | null;
  /** Main role only: the switch guard when the selection differs from the current model. */
  readonly switchDecision: SwitchDecision | null;
  /** Why there is no selection (null when there is one). */
  readonly reasonCode: string | null;
  /** The calibration release the qualities and floor came from. */
  readonly calibrationId: string | null;
  /** That release's dataset version, for the decision record's calibration reference. */
  readonly calibrationVersion: string | null;
  /** True when the task size is the routing policy's default, not the caller's. */
  readonly assumedVolume: boolean;
}

function missing(reasonCode: string, calibration: CalibrationDecision | null = null): RouteEvaluation {
  return { selection: null, switchDecision: null, reasonCode, calibrationId: calibration?.eligible === true ? calibration.artifact.id : null, calibrationVersion: calibration?.eligible === true ? calibration.artifact.dataset.version : null, assumedVolume: false };
}

export async function evaluateRoute(input: RouteEvaluationInput): Promise<RouteEvaluation> {
  if (input.killSwitchStopped) return missing('KILL_SWITCH');
  if (input.sliceId === null) return missing('UNKNOWN_SLICE');
  const calibration = await loadCalibration({
    home: input.home,
    trustedKeys: input.trustedKeys,
    bundled: input.bundledCalibration ?? null,
    context: workerCalibrationContext({ sliceId: input.sliceId, nowMs: input.nowMs ?? Date.now() }),
  });
  if (!calibration.eligible) return missing(calibration.reasonCode === 'NO_RELEASE' ? 'NO_CALIBRATION' : `CALIBRATION_${calibration.reasonCode}`);
  const qualities = releasedQualities(calibration.artifact, input.sliceId, input.registry);
  if (qualities.length === 0) return missing('NO_EVALUATED_QUALITY', calibration);
  const settings = await loadRoutingPolicy({ home: input.home, registry: input.registry });
  if (settings === null) return missing('ROUTING_POLICY_INVALID', calibration);
  // Found gone on this machine: never recommended. A model not accessible from one harness and
  // sign-in is left out only when the caller names that harness and sign-in (scope (ii), DOMAINS).
  const gone = unavailableModels(await loadModelAvailability(input.home, input.registry), { harness: input.harness ?? null, authMode: input.authMode ?? null });
  const locallyEligible = await locallyEligibleFor({ home: input.home, registry: input.registry, accountId: settings.accountId, unavailable: gone, scope: { harness: input.harness ?? null, authMode: input.authMode ?? null } });
  // R73 (E6): a model whose scope an access limit pauses is never advised; with no harness named,
  // any harness's pause on its maker counts (advice fails toward pausing).
  const access = await routeAccessPauses({ home: input.home, registry: input.registry, nowMs: input.nowMs ?? Date.now(), scopeOf: () => ({ harness: input.harness ?? null, authMode: input.authMode ?? null }) });
  const policy: RoutingPolicy = {
    managedAllowlist: settings.managedAllowlist,
    allowedProviders: settings.allowedProviders,
    allowedRegions: settings.allowedRegions,
    requiredContextTokens: Math.max(0, Math.floor(input.requiredContextTokens ?? 0)),
    requiredCapabilities: settings.requiredCapabilities,
    pins: input.pins,
    riskFloorFamilies: null,
    accountId: settings.accountId,
    zeroDataRetention: settings.zeroDataRetention,
    nowMs: input.nowMs ?? Date.now(),
    unavailableModels: gone,
    locallyEligible,
    pausedModels: access.paused,
    ...(input.consentedProviders !== undefined
      ? { consentedProviders: input.consentedProviders }
      : input.providerConsent !== undefined
        ? { consentedProviders: providerConsentGate(input.registry, [...(input.signedInProviders ?? []), ...ranHereProviders(input.registry, await readModelOffer(input.home).catch(() => null))], input.providerConsent).consentedProviders }
        : {}),
  };
  const current = input.currentModel !== null && registryModel(input.registry, input.currentModel) !== null ? input.currentModel : null;
  const volume = input.volume ?? settings.defaultTaskVolume;
  const selection = routeTask({
    registry: input.registry,
    policy,
    sliceId: input.sliceId,
    volume,
    assumptions: settings.assumptions,
    qualities,
    qualityFloor: calibration.qualityFloor,
    // OD-3: the main session's current model is its approved model; otherwise the harness's default.
    baselineModelId: input.role === 'main' && current !== null ? current : routeBaseline(input.registry, input.harness ?? null),
  });
  let switchDecision: SwitchDecision | null = null;
  if (input.role === 'main' && selection.outcome === 'select' && current !== null && selection.modelId !== current && selection.saving !== null) {
    const from = registryModel(input.registry, current);
    const to = registryModel(input.registry, selection.modelId);
    const context = input.switchContext ?? null;
    if (context === null || from === null || to === null) {
      switchDecision = {
        allowed: false,
        reasonCode: 'TRANSITION_COST_UNKNOWN',
        transitionCostMicroUsd: 0,
        netBenefitMicroUsd: Math.round(selection.saving.lower),
        explanation: 'The warm-prefix size of this session was not reported, so the cost of moving it to another model cannot be priced; keep the current model. To price a switch, pass session.warmPrefixTokens (the cached prompt prefix, in tokens; jevris route --warm-prefix) with the request.',
      };
    } else {
      switchDecision = switchGuard({
        transitionCostMicroUsd: transitionCostMicroUsd({ from, to, warmPrefixTokens: context.warmPrefixTokens, cacheWarm: context.cacheWarm, ...(context.cacheTtl === undefined ? {} : { cacheTtl: context.cacheTtl }) }),
        saving: selection.saving,
        unitsSinceLastSwitch: context.unitsSinceLastSwitch,
        switchesThisTask: context.switchesThisTask,
        atBoundary: context.atBoundary,
        ...(context.authMode === undefined ? {} : { authMode: context.authMode }),
        policy: { ...DEFAULT_SWITCH_POLICY, minimumBenefitMicroUsd: settings.minimumBenefitMicroUsd },
      });
    }
  }
  return { selection, switchDecision, reasonCode: null, calibrationId: calibration.artifact.id, calibrationVersion: calibration.artifact.dataset.version, assumedVolume: input.volume === undefined || input.volume === null };
}

/** The generation envelope for owned workers when the routing policy names none: 50 USD a month. */
export const DEFAULT_GENERATION_BUDGET_MICRO_USD = 50_000_000;

export function generationBudgetFile(home: string): string {
  return join(jevrisPaths({ home }).data, 'generation-budget.json');
}

/** What D's owned-worker launch sends (`engine.routeManagedWorker`). */
export interface ManagedRouteRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sliceId: string | null;
  /** The task's own eligible models; the router never selects outside them. */
  readonly eligibleModels?: readonly string[];
  readonly mode: 'observe' | 'advise' | 'bounded-auto';
  readonly killSwitchStopped: () => boolean | Promise<boolean>;
  readonly launch: OwnedLaunchPort;
  /** The remaining work, tokens; the routing policy's default task size when absent. */
  readonly volume?: TokenVolume | null;
  /**
   * P11: D's measured per-field p90 of this workspace's finished runs of the slice (D's
   * `sliceVolume`, n >= 5). It only raises the volume assumed when `volume` is absent.
   */
  readonly taskVolume?: { readonly inputTokens: number; readonly outputTokens: number; readonly n: number } | null;
  readonly requiredContextTokens?: number;
  /** The route's risk class for C16 exploration; only `low` ever explores. Default `unknown`. */
  readonly risk?: RouteRisk;
  /** How the worker's harness is billed (F detects it): dollars on an API key, usage limits on a subscription. */
  readonly authMode?: AuthMode;
  /**
   * The harness the worker runs on (a HARNESS_IDS value). With `authMode` it scopes a
   * MODEL_NOT_ACCESSIBLE entry: that model is left out only on this harness and sign-in.
   */
  readonly harness?: string;
  /**
   * R30, OD-4: the providers the route may send content to, from `providerConsentGate` (stored
   * consent plus the signed-in default). Absent, only a consent-marked model is left out.
   */
  readonly consentedProviders?: readonly string[] | null;
  /**
   * OD-3: the task's approved model. When the registry lists it, it is the route's baseline;
   * otherwise the harness's default (`harnessDefaults`), else the registry's baseline.
   */
  readonly approvedModelId?: string | null;
  /**
   * R11 (D fills it): per model the route may pick, the installed harness and sign-in that reach
   * it, or null when none does. A null scope leaves the model out (NO_HARNESS_FOR_PROVIDER). The
   * providers reached with an API key or a subscription are the signed-in providers of OD-4's
   * default; with `consentedProviders` absent, core derives it from them and the stored consent.
   */
  readonly candidateScopes?: CandidateScopes;
  /**
   * D f17a3bc: for a task that names no models, why each registry model is out of its default
   * set (NO_HARNESS, EXPLORATION_NEEDS_API_KEY or a PROVIDER_CONSENT_* code). The selection's
   * eliminations carry it as `reasonCode`, so an explanation names the orchestrator's reason.
   */
  readonly candidateExclusions?: { readonly [modelId: string]: string };
  /**
   * Serving hosts R52 (D fills it): the pinned host the worker's harness session goes through
   * (`openrouter`, `kilo`), from the task's linked session; absent or null for a direct session.
   * Every candidate and the baseline are priced at that host, and a launch there needs route.host
   * certification and the pair's consent (`hostRoute`, route-worker.ts).
   */
  readonly servingHost?: string | null;
  /** Whether the worker's harness has route.host certified at its installed version (D reads the certify record). */
  readonly hostRouteCertified?: boolean;
  /**
   * Sonnet-first routing (owner decision 2026-09-30, D fills it): the `routing.firstTry` setting and this
   * workspace's measured first-try history for a candidate, read from D's ledger. Absent, no route is first-try.
   */
  readonly firstTry?: NonNullable<WorkerLearning['firstTry']>;
}

export type CandidateScopes = { readonly [modelId: string]: { readonly harness: string; readonly authMode: 'api-key' | 'subscription' | 'unknown' } | null };

/**
 * OD-4 (owner decision c065d52): the providers a route counts as signed in, sorted: those of the
 * models it reaches with a detected or declared API key or subscription (never `unknown` alone),
 * plus every provider a harness on this machine has run a model of (RAN_HERE, from `offer`).
 */
export function signedInProvidersOf(registry: ModelRegistry, scopes: CandidateScopes, offer: ModelOffer | null = null): readonly string[] {
  const out = new Set<string>(ranHereProviders(registry, offer));
  for (const [modelId, scope] of Object.entries(scopes)) {
    if (scope === null || (scope.authMode !== 'api-key' && scope.authMode !== 'subscription')) continue;
    const model = registryModel(registry, modelId);
    if (model !== null) out.add(model.provider);
  }
  return [...out].sort();
}

/** The maker consent and reach gates, before a pinned serving host is taken into account. */
function makerAccessGates(registry: ModelRegistry, request: Pick<ManagedRouteRequest, 'consentedProviders' | 'candidateScopes' | 'eligibleModels' | 'approvedModelId'>, read?: ProviderConsentReader, offer: ModelOffer | null = null): { readonly consentedProviders?: readonly string[] | null; readonly unreachableModels?: readonly string[] } {
  const scopes = request.candidateScopes;
  if (scopes === undefined) {
    if (request.consentedProviders !== undefined) return { consentedProviders: request.consentedProviders };
    // MEDIUM 9: a task that names its models has no candidate scopes. The providers of the models
    // the person named count as signed in; every other provider needs its stored consent. With no
    // named models either, the router's pinned fallback applies.
    const named = [...(request.eligibleModels ?? []), ...(request.approvedModelId === undefined || request.approvedModelId === null ? [] : [request.approvedModelId])];
    if (named.length === 0) return {};
    const signedIn = [...new Set([...named.map((id) => registryModel(registry, id)?.provider).filter((p): p is string => p !== undefined), ...ranHereProviders(registry, offer)])].sort();
    return { consentedProviders: providerConsentGate(registry, signedIn, read ?? NO_STORED_CONSENT).consentedProviders };
  }
  const unreachableModels = Object.entries(scopes).filter(([, scope]) => scope === null).map(([modelId]) => modelId).sort();
  const consentedProviders = request.consentedProviders !== undefined
    ? request.consentedProviders
    : providerConsentGate(registry, signedInProvidersOf(registry, scopes, offer), read ?? NO_STORED_CONSENT).consentedProviders;
  return { consentedProviders, unreachableModels };
}

/**
 * The consent and reach gates for one route: the router policy fields they set. Serving hosts
 * (R52, C's review LOW A): when the worker's session goes through a pinned gateway or host, that
 * session is signed in to the host only (OQ-3), so each maker is let through only when the pair
 * gate passes for it through that host (the host, what it forwards to, the maker's own grant).
 * The router then never picks a model whose launch the pair gate would refuse.
 */
export function routeAccessGates(registry: ModelRegistry, request: Pick<ManagedRouteRequest, 'consentedProviders' | 'candidateScopes' | 'eligibleModels' | 'approvedModelId' | 'servingHost'>, read?: ProviderConsentReader, offer: ModelOffer | null = null): ReturnType<typeof makerAccessGates> {
  const gates = makerAccessGates(registry, request, read, offer);
  const host = request.servingHost ?? null;
  if (host === null || servingHostOf(host) === undefined || gates.consentedProviders === undefined || gates.consentedProviders === null) return gates;
  const reader = read ?? NO_STORED_CONSENT;
  const consentedProviders = gates.consentedProviders.filter((provider) => routeConsentGate(registry, [host], reader, { provider, servingHost: host, via: 'host' }).allowed);
  return { ...gates, consentedProviders };
}

/**
 * RTE-12, C09: the product seam for an owned worker. Builds the route from the Jevris home (model
 * registry, routing policy, signed calibration release with its model qualities, the generation
 * envelope) and runs `runManagedWorker`. In observe and advise the selection is only recorded
 * (`record`); in bounded-auto the selected model is reserved, launched and settled. A task
 * without a slice cannot be routed (UNKNOWN_SLICE) and the caller keeps its approved model.
 * Route learning (C16, `<data>/route-learning/<workspace>.json`): when the signed release is a
 * `beta-posterior` baseline release, or the workspace already has a learning state, the slice is
 * first reconciled against its posterior (so day 1 activates from the signed baseline alone, and a
 * regression demotes before the route), then applied: an active slice routes to its candidate,
 * and a low-risk route may explore. The result's `learning` note is what the caller logs with the
 * outcome.
 */
/** Loads and reconciles the slice's learning state before routing; null when learning does not apply. */
async function routeLearningState(input: {
  readonly request: ManagedRouteRequest;
  readonly gates: ReturnType<typeof routeAccessGates>;
  readonly baselineModelId: string;
  /** R17: the key the slice learns under for this baseline (`learningSliceKey`). */
  readonly learningKey: string;
  readonly sliceId: string;
  readonly registry: ModelRegistry;
  readonly calibration: CalibrationDecision;
  readonly now: number;
  readonly home: string;
  readonly allowlist: readonly string[] | null;
  readonly settings: RoutingPolicySettings;
  readonly unavailable: Readonly<Record<string, ModelUnavailableReason>>;
  readonly locallyEligible: readonly string[] | null;
  readonly paused: Readonly<Record<string, AccessPauseNote>>;
}): Promise<LearningState | null> {
  const loaded = await loadLearningState({ home: input.home, workspaceId: input.request.workspaceId }).catch(() => null);
  // The release rates models on the task slice; under a baseline's own key they describe the same work.
  const priors = (input.calibration.eligible ? baselinePriorsFromRelease(input.calibration.artifact, input.sliceId, learningSettings(loaded?.settings ?? {}), input.registry) : []).map((p) => ({ ...p, sliceId: input.learningKey }));
  // With no signed baseline at all (release 1.2), a workspace still learns from its first route:
  // the default serves it, a low-risk route may explore, and the outcome is recorded. A release
  // that exists but is refused (invalid, expired, untrusted, not for this slice) keeps a new
  // workspace out of learning until it has state.
  const noRelease = !input.calibration.eligible && input.calibration.reasonCode === 'NO_RELEASE';
  if (loaded === null && priors.length === 0 && !noRelease) return null;
  const eligible = filterCandidates(input.registry, {
    managedAllowlist: input.allowlist,
    allowedProviders: input.settings.allowedProviders,
    allowedRegions: input.settings.allowedRegions,
    requiredContextTokens: Math.max(0, Math.floor(input.request.requiredContextTokens ?? 0)),
    requiredCapabilities: input.settings.requiredCapabilities,
    pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null,
    accountId: input.settings.accountId,
    zeroDataRetention: input.settings.zeroDataRetention,
    nowMs: input.now,
    unavailableModels: input.unavailable,
    locallyEligible: input.locallyEligible,
    pausedModels: input.paused,
    ...input.gates,
  }).eligible.map((m) => m.modelId);
  const reconciled = await reconcileLearning({
    home: input.home,
    workspaceId: input.request.workspaceId,
    sliceId: input.learningKey,
    baselineModelId: input.baselineModelId,
    eligibleModelIds: eligible,
    now: new Date(input.now).toISOString(),
    priors: priors.length === 0 || !input.calibration.eligible ? null : { releaseId: input.calibration.artifact.id, priors },
    ...(input.request.authMode === undefined ? {} : { authMode: input.request.authMode }),
    registry: input.registry,
  }).catch(() => null);
  return reconciled?.state ?? loaded;
}

/** P11: the larger of a volume and D's measured p90, per field; a malformed measure is ignored. */
export function raiseVolume(volume: TokenVolume, measured: { readonly inputTokens: number; readonly outputTokens: number; readonly n: number } | null): TokenVolume {
  if (measured === null || !Number.isSafeInteger(measured.n) || measured.n < 1) return volume;
  const ok = (x: number): boolean => Number.isSafeInteger(x) && x >= 0;
  if (!ok(measured.inputTokens) || !ok(measured.outputTokens)) return volume;
  return { inputTokens: Math.max(volume.inputTokens, measured.inputTokens), outputTokens: Math.max(volume.outputTokens, measured.outputTokens) };
}

export async function routeManagedWorker(
  request: ManagedRouteRequest,
  deps: {
    readonly home: string;
    readonly trustedKeys: ReadonlyMap<string, string>;
    /** The package's bundled baseline release file, read when the config folder has none. */
    readonly bundledCalibration?: string | null;
    readonly record?: ManagedWorkerInput['record'];
    readonly budget?: DecisionBudget;
    readonly nowMs?: () => number;
    /** Exploration's random source; a cryptographic one by default. */
    readonly random?: () => number;
    /** B's point read of stored per-provider consent (R30); absent, only the signed-in default applies. */
    readonly providerConsent?: ProviderConsentReader;
  },
): Promise<ManagedWorkerResult & { readonly learning?: WorkerLearningNote }> {
  if (await request.killSwitchStopped()) return { launched: false, reasonCode: 'KILL_SWITCH', selection: null };
  if (request.sliceId === null) return { launched: false, reasonCode: 'UNKNOWN_SLICE', selection: null };
  const loadedRegistry = await loadModelRegistryChecked({ home: deps.home });
  // A refused administrator registry names why (MODEL_REGISTRY_TOO_LARGE, _NOT_JSON, _INVALID, _UNREADABLE).
  if (loadedRegistry.registry === null) return { launched: false, reasonCode: loadedRegistry.reasonCode, selection: null };
  const registry = loadedRegistry.registry;
  const settings = await loadRoutingPolicy({ home: deps.home, registry });
  if (settings === null) return { launched: false, reasonCode: 'ROUTING_POLICY_INVALID', selection: null };
  const sliceId = request.sliceId;
  const now = deps.nowMs ?? (() => Date.now());
  const calibration = await loadCalibration({ home: deps.home, trustedKeys: deps.trustedKeys, bundled: deps.bundledCalibration ?? null, context: workerCalibrationContext({ sliceId, nowMs: now() }) });
  const eligible = request.eligibleModels === undefined ? null : [...request.eligibleModels];
  const allowlist = eligible === null ? settings.managedAllowlist : settings.managedAllowlist === null ? eligible : settings.managedAllowlist.filter((id) => eligible.includes(id));
  const budget = deps.budget ?? DecisionBudget.open(generationBudgetFile(deps.home), { limitMicroUsd: settings.generationBudgetMicroUsd, period: 'month', now });
  // Found gone (any harness) or not accessible on this worker's harness and sign-in: never routed,
  // explored or launched.
  const unavailable = unavailableModels(await loadModelAvailability(deps.home, registry), { harness: request.harness ?? null, authMode: request.authMode ?? null });
  // Account eligibility: an administrator's account check, else local evidence on this harness and sign-in.
  // A worker whose harness is not known has no local evidence (fail-closed).
  const locallyEligible = request.harness === undefined && settings.accountId === null ? [] : await locallyEligibleFor({ home: deps.home, registry, accountId: settings.accountId, unavailable, scope: { harness: request.harness ?? null, authMode: request.authMode ?? 'unknown' } });
  // OD-3: the task's approved model when registered, else the harness's default. Route, learning
  // and the outcome all use this one baseline (the learning note carries it).
  const baselineModelId = routeBaseline(registry, request.harness ?? null, request.approvedModelId ?? null);
  const gates = routeAccessGates(registry, request, deps.providerConsent, await readModelOffer(deps.home).catch(() => null));
  // R72 (E1, E2): each candidate is checked against the access-limits record under the harness and
  // sign-in that would run it (D's candidateScopes), else the worker's own. A candidate no harness
  // reaches is left out by the no-harness gate already.
  const scopes = request.candidateScopes;
  const accessScopeOf = (modelId: string): { readonly harness: string | null; readonly authMode: string | null } | null => {
    const scope = scopes !== undefined && Object.hasOwn(scopes, modelId) ? scopes[modelId] : undefined;
    return scope === undefined ? { harness: request.harness ?? null, authMode: request.authMode ?? null } : scope;
  };
  const access = await routeAccessPauses({ home: deps.home, registry, nowMs: now(), scopeOf: accessScopeOf });
  // R17: this baseline's own learning key, so routes from harnesses with other defaults never demote it.
  const learningKey = learningSliceKey(sliceId, baselineModelId, registry);
  const learningState = await routeLearningState({ request, gates, baselineModelId, learningKey, sliceId, registry, calibration, now: now(), home: deps.home, allowlist, settings, unavailable, locallyEligible, paused: access.paused });
  // Near a limit: hit within the workspace's nearLimitHours, in force or not; never explored.
  const nearLimitModelIds = learningState === null ? [] : (await routeAccessPauses({ home: deps.home, registry, nowMs: now(), nearMs: learningState.settings.nearLimitHours * 3_600_000, scopeOf: accessScopeOf })).nearLimitModelIds;
  const result = await runManagedWorker({
    taskId: request.taskId,
    workspaceId: request.workspaceId,
    mode: request.mode,
    killSwitchStopped: request.killSwitchStopped,
    loadCalibration: async () => calibration,
    route: {
      registry,
      policy: {
        // An owned worker runs a model no person chose for it: preview models are left out.
        automated: true,
        managedAllowlist: allowlist,
        allowedProviders: settings.allowedProviders,
        allowedRegions: settings.allowedRegions,
        requiredContextTokens: Math.max(0, Math.floor(request.requiredContextTokens ?? 0)),
        requiredCapabilities: settings.requiredCapabilities,
        pins: { modelPin: null, effortPin: null },
        riskFloorFamilies: null,
        accountId: settings.accountId,
        zeroDataRetention: settings.zeroDataRetention,
        nowMs: now(),
        unavailableModels: unavailable,
        locallyEligible,
        pausedModels: access.paused,
        ...(request.servingHost === undefined ? {} : { servingHost: request.servingHost }),
        ...gates,
      },
      baselineModelId,
      // P11: without a reported size, the larger of the default and this slice's measured p90 (never lower).
      volume: request.volume ?? raiseVolume(sliceTaskVolume(learningState, learningKey, settings.defaultTaskVolume).volume, request.taskVolume ?? null),
      assumptions: settings.assumptions,
      qualities: calibration.eligible ? releasedQualities(calibration.artifact, sliceId, registry) : [],
    },
    budget,
    launch: request.launch,
    hostRoute: { certified: request.hostRouteCertified === true, ...(deps.providerConsent === undefined ? {} : { read: deps.providerConsent }) },
    now,
    ...(deps.record === undefined ? {} : { record: deps.record }),
    ...(learningState === null ? {} : { learning: { state: learningState, sliceId: learningKey, risk: request.risk ?? 'unknown', random: deps.random ?? secureRandom, nearLimitModelIds, ...(request.authMode === undefined ? {} : { authMode: request.authMode }), ...(request.firstTry === undefined ? {} : { firstTry: request.firstTry }) } }),
  });
  return withExclusions(result, request.candidateExclusions);
}

const EXCLUSION_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * D f17a3bc: marks each model the orchestrator left out of the candidate set with its reason. A
 * model the router eliminated keeps its gate and gains the reason; one it never saw (outside the
 * allowlist) is listed at gate `managed-allowlist`. Codes that are not reason codes are dropped.
 */
export function withExclusions<T extends { readonly selection: RouteSelection | null }>(result: T, exclusions: ManagedRouteRequest['candidateExclusions']): T {
  const selection = result.selection;
  if (selection === null || exclusions === undefined) return result;
  const codes = Object.entries(exclusions).filter(([id, code]) => Object.hasOwn(exclusions, id) && typeof code === 'string' && EXCLUSION_CODE.test(code));
  if (codes.length === 0) return result;
  const byId = new Map(codes);
  const eliminated = selection.eliminated.map((e) => (byId.has(e.modelId) ? { ...e, reasonCode: byId.get(e.modelId) as string } : e));
  const seen = new Set(eliminated.map((e) => e.modelId));
  const scored = new Set(selection.scored.map((s) => s.modelId));
  for (const [modelId, reasonCode] of codes.sort(([a], [b]) => a.localeCompare(b))) {
    if (!seen.has(modelId) && !scored.has(modelId) && modelId !== selection.modelId) eliminated.push({ modelId, gate: 'managed-allowlist', reasonCode });
  }
  return { ...result, selection: { ...selection, eliminated } };
}
