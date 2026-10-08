/**
 * Subagent routing, the decision side (owner decision 2026-09-27, DOMAINS 9ce2ba5: "build it,
 * abstain by default"; R20 extends it to Codex, Kilo and OpenCode through SUBAGENT_ROUTE_ACTUATORS).
 *
 * A PreToolUse(Agent/Task) event may get a proposed model for the subagent when there is evidence
 * for the subagent type: the route-learning slice for that type is active (`auto`), or a signed
 * calibration release for that slice selects a model. Everything else abstains with a reason code,
 * and the subagent keeps the model Claude Code would choose.
 *
 * Owner decision 2026-10-08 (reverses the abstain-only line of 9ce2ba5, Claude Code only): with no
 * learned or signed evidence, a launch judged low or medium risk (`subagent-risk.ts`: rules first; a
 * read-only built-in is low, a write-capable type is high unless a Jev answer at the floors lowers it) goes to the cheapest current model of the
 * `haiku` family (low) or the `sonnet` family (medium) for that one Agent call. The session's
 * model is never changed. High risk and unknown change nothing. The model must be eligible on
 * this harness (locallyEligible, which for Claude Code includes the HARNESS_ALIAS proof).
 *
 * Pure: no I/O, no clock read, and no prompt text. The inputs are the subagent type, whether the
 * tool input already names a model, the session's model, pins, the registry, the models found
 * gone for (claude, authMode), the workspace's learning state and a signed prior when one exists.
 *
 * Subagent routes do not feed learning outcomes: Claude Code's hooks report no subagent cost or
 * result. D records a subagent-routed outcome on SubagentStop later, under `subagentSliceId`.
 *
 * Serving hosts R51 (design 4.3; the R50 rules): on Kilo and OpenCode the child keeps the parent
 * session's host, including a pinned gateway. With the consent reader, a pinned host is used only
 * when its consent (and every host it forwards to) allows it, with the parent's host signed in. A
 * proposal that goes through a pinned host or changes the parent's host is applied only with
 * `route.host` certified, and any proposal only at known tariffs on both sides; otherwise it is
 * explain text (`blockedReason`).
 */
import type { HarnessId, ModelRegistry, RoutePins, RoutingModel } from '@jevris/contracts';
import { ROUTE_VARIANT_PATTERN } from '@jevris/contracts';
import { harnessEffortToken, harnessModelId } from './harness-model-id.js';
import { sessionHost, sessionSignedInParties, spellTarget } from './session-host.js';
import { hostTariffGuard } from './serving-tariff.js';
import { accessPauseForSpelling, type AccessLimitEntry } from './access-limits.js';
import type { SeenSpelling } from './model-offer.js';
import type { ModelUnavailableReason } from './model-availability.js';
import { CLAUDE_CODE_SUBAGENT_ALIASES, aliasMeansModel, lifecycleCheck, registryModel, routeBaseline, type ClaudeCodeSubagentAlias } from './model-registry.js';
import type { SubagentClass, SubagentRiskLevel, SubagentRiskSource } from './subagent-risk.js';
import { blockedDownstream, hostConsent, signedInDefaultAllowed, type ProviderConsentReader } from './provider-consent-gate.js';
import { defaultEffortOf, learningSliceKey, slicePolicy, type LearningState } from './route-learning.js';

/**
 * R20 (routing design; owner decisions OD-6, OD-7): how each harness applies a subagent route.
 * - `tool`: the native tool that starts the subagent.
 * - `carries`: what the route sets: Claude Code's family alias (`opus`, `sonnet`, `haiku`,
 *   `fable`), or the harness's own model id (`harnessModelId`: Codex's bare id, Kilo's and
 *   OpenCode's `provider/model`).
 * - `effort`: how an effort arm rides with it. `variant`: Kilo's variant, carried as the route's
 *   `variant` (E b250627). `explain`: Codex, whose route sets the model only by design (owner
 *   decision 43cb54c); the learned effort level is stated in the text and never applied. `none`:
 *   a learned arm at a non-default effort abstains (EFFORT_NOT_ROUTABLE).
 * - `authority`: Codex honours `updatedInput` only with `permissionDecision: "allow"` (OD-6).
 * Antigravity starts no subagent a hook can re-model (a vendor limit): null, so a proposal there
 * is explain text only.
 * Each actuator stays off until the harness's `hooks.route` certify case passes (the
 * subscriber's gate); uncertified, the proposal is shown as explain text.
 */
export interface SubagentActuator {
  readonly tool: string;
  readonly carries: 'alias' | 'harness-model-id';
  readonly effort: 'none' | 'explain' | 'variant';
  readonly authority: 'updated-input' | 'updated-input-with-allow' | 'awaited-rewrite';
  /**
   * Only a model with its own `harnessModels` row for this harness (Codex: spawn_agent refuses a
   * model outside its offline preset list, so an id derived from the access template is not enough).
   */
  readonly presetOnly: boolean;
}

const VARIANT = new RegExp(ROUTE_VARIANT_PATTERN);

export { CLAUDE_CODE_SUBAGENT_ALIASES, type ClaudeCodeSubagentAlias };

/**
 * Owner decision 2026-10-08: the model family a launch of each risk level goes to when nothing
 * learned says otherwise, resolved against the registry (the newest usable release of the family,
 * which is what Claude Code's alias of that name means), never a hard-coded model id.
 */
export const RISK_ROUTE_FAMILY: Readonly<Record<'low' | 'medium', ClaudeCodeSubagentAlias>> = Object.freeze({ low: 'haiku', medium: 'sonnet' });

export const SUBAGENT_ROUTE_ACTUATORS: Readonly<Record<HarnessId, SubagentActuator | null>> = Object.freeze({
  claude: { tool: 'Agent', carries: 'alias', effort: 'none', authority: 'updated-input', presetOnly: false },
  codex: { tool: 'spawn_agent', carries: 'harness-model-id', effort: 'explain', authority: 'updated-input-with-allow', presetOnly: true },
  kilocode: { tool: 'task', carries: 'harness-model-id', effort: 'variant', authority: 'awaited-rewrite', presetOnly: false },
  opencode: { tool: 'task', carries: 'harness-model-id', effort: 'none', authority: 'awaited-rewrite', presetOnly: false },
  antigravity: null,
});

/** The harnesses whose subagent model a route can set (a non-null actuator); D's recording uses the same list. */
export const SUBAGENT_ROUTE_HARNESSES: readonly HarnessId[] = Object.freeze(
  (Object.keys(SUBAGENT_ROUTE_ACTUATORS) as HarnessId[]).filter((h) => SUBAGENT_ROUTE_ACTUATORS[h] !== null),
);

export const SUBAGENT_ROUTE_ABSTAIN_REASONS = [
  'HARNESS_NOT_SUPPORTED',
  'NOT_ON_HARNESS',
  'NO_SUBAGENT_TYPE',
  'INVALID_SUBAGENT_TYPE',
  'EXPLICIT_MODEL',
  'PINNED',
  'NO_EVIDENCE',
  'NOT_IN_REGISTRY',
  'MODEL_RETIRED',
  'MODEL_UNAVAILABLE',
  'PROVIDER_NOT_CONSENTED',
  'NOT_ELIGIBLE_HERE',
  'HOST_UNKNOWN',
  'NOT_ON_SESSION_HOST',
  'NO_ALIAS',
  'ALIAS_NOT_NEWEST',
  'EFFORT_NOT_ROUTABLE',
  'SAME_AS_SESSION',
  'ACCESS_LIMITED',
  'RISK_HIGH',
  'NOT_CHEAPER',
] as const;
export type SubagentRouteAbstainReason = (typeof SUBAGENT_ROUTE_ABSTAIN_REASONS)[number];

const SUBAGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The adapters' stand-in for a Bedrock ARN model (F's 057e8553): an unknown model on an unknown host. */
export const BEDROCK_ARN_MODEL = 'bedrock-arn';

/**
 * The route-learning and calibration slice for a Claude Code subagent type: `subagent:<type>`.
 * Null when the type is not a safe slice key (the route then abstains). D keys SubagentStop
 * outcomes the same way.
 */
export function subagentSliceId(subagentType: string): string | null {
  return SUBAGENT_TYPE.test(subagentType) ? `subagent:${subagentType}` : null;
}

/**
 * R20 with R17: the learning key a subagent type's outcomes are recorded and read under on one
 * harness. Each harness learns under its own baseline (`routeBaseline(registry, harness, null)`),
 * so the key matches the one adviseSubagentRoute reads: the bare `subagent:<type>` where that
 * baseline is the registry's (Claude Code, Kilo, OpenCode today), else `subagent:<type>::<model>`
 * (Codex, Antigravity). Null when the type is not a safe slice key.
 */
export function subagentLearningKey(subagentType: string, harness: string, registry: ModelRegistry): string | null {
  const sliceId = subagentSliceId(subagentType);
  return sliceId === null ? null : learningSliceKey(sliceId, routeBaseline(registry, harness, null), registry);
}

/** A signed calibration release's selection for the subagent slice (the caller verified it). */
export interface SubagentSignedPrior {
  readonly modelId: string;
  readonly releaseId: string;
}

export interface SubagentRouteInput {
  readonly harness: string;
  /** tool_input.subagent_type as the adapter passes it (1 to 64 characters), or absent. */
  readonly subagentType?: string | null;
  /** True when tool_input already names a model: the user's choice stands. Only the fact is read. */
  readonly explicitModel: boolean;
  /** The session's current model (registry id or alias), or null when unknown. */
  readonly sessionModel: string | null;
  readonly pins: RoutePins;
  readonly registry: ModelRegistry;
  readonly nowMs: number;
  /** Found gone on this machine, or not accessible for (claude, authMode): `unavailableModels`. */
  readonly unavailableModels: Readonly<Record<string, ModelUnavailableReason>>;
  /** The workspace's route-learning state, or null. */
  readonly learning: LearningState | null;
  /** A signed prior for the subagent slice, or null. */
  readonly signedPrior?: SubagentSignedPrior | null;
  /**
   * OD-4 (B's security review, MEDIUM 4 and 9): the providers this session may send content to,
   * from `providerConsentGate`. Absent, only providers allowed by the pinned signed-in default
   * pass (`signedInDefaultAllowed`), and never one the registry marks.
   */
  readonly consentedProviders?: readonly string[] | null;
  /**
   * Owner decision 3f090fa: the models eligible on this harness and sign-in from local evidence
   * (`locallyEligibleFor`). Where the route names the harness's own id (Codex, Kilo, OpenCode), a
   * model outside it abstains (NOT_ELIGIBLE_HERE). Absent or null, not checked (an administrator's
   * account check decides, or the caller has none).
   */
  readonly locallyEligible?: readonly string[] | null;
  /** The spellings of a model seen on this harness (`seenSpellings` over the model offer); absent: none. */
  readonly seen?: (modelId: string) => readonly SeenSpelling[];
  /**
   * Access limits R73 (design E5): the machine's access-limit entries (`readAccessLimits`); absent:
   * none. A model whose scope on this harness, sign-in and host is paused abstains (ACCESS_LIMITED).
   */
  readonly accessLimits?: readonly AccessLimitEntry[];
  /** The session's sign-in (`api-key` or `subscription`); absent or null: unknown, which matches both. */
  readonly authMode?: string | null;
  /**
   * Serving hosts R51: B's stored-consent reader, for a pinned serving host's own consent and the
   * hosts it forwards to (makers are judged by `consentedProviders`). Absent: no pinned host is
   * used, and a gateway session reads as an unknown host (phase 1).
   */
  readonly providerConsent?: ProviderConsentReader;
  /**
   * Owner decision 2026-10-08: the content-free risk of this launch (`judgeSubagentRisk`), or absent.
   * Used only on Claude Code and only when no learned route or signed prior applies.
   */
  readonly risk?: SubagentRiskInput | null;
  /** Serving hosts R51: the harness's `route.host` certification for the session's version (the sidecar's, never the plugin's). Absent: false. */
  readonly hostRouteCertified?: boolean;
}

/** What the subagent-risk judge decided for one launch, as the route reads it. */
export interface SubagentRiskInput {
  readonly level: SubagentRiskLevel;
  readonly source: SubagentRiskSource;
  readonly subagentClass: SubagentClass;
}

/** Why a proposal is explain text only (serving hosts R51): its price is an estimate, or route.host is not certified. */
export type SubagentRouteBlock = 'HOST_TARIFF_UNKNOWN' | 'ROUTE_HOST_NOT_CERTIFIED';

export type SubagentRouteAdvice =
  | {
      readonly outcome: 'propose';
      readonly harness: HarnessId;
      readonly modelId: string;
      /** What the route sets on this harness: the alias on Claude Code, else the harness's model id. */
      readonly harnessModel: string;
      /** Claude Code only: the family alias (the same as `harnessModel` there). */
      readonly alias: ClaudeCodeSubagentAlias | null;
      /** How this harness applies the route; null: it cannot (Antigravity), so explain only. */
      readonly actuator: SubagentActuator | null;
      /** The harness's token for a learned non-default effort that the route carries (Kilo's variant); else null. */
      readonly variant: string | null;
      /**
       * Owner decision 43cb54c: the learned non-default effort that was worked out but is not
       * applied (Codex: the route sets the model only). Stated in `text`; null otherwise.
       */
      readonly effortNotApplied: string | null;
      readonly sliceId: string;
      readonly basis: 'learning' | 'signed-prior' | 'risk-rule' | 'risk-jev';
      readonly reasonCode: 'SUBAGENT_ROUTE_LEARNED' | 'SUBAGENT_ROUTE_PRIOR' | 'SUBAGENT_ROUTE_RISK_RULE' | 'SUBAGENT_ROUTE_RISK_JEV';
      /**
       * Serving hosts R51: set when the route must not be applied, only explained: a side priced by
       * estimate on its host (HOST_TARIFF_UNKNOWN), or a pinned host or a changed host without
       * `route.host` certified (ROUTE_HOST_NOT_CERTIFIED). Null: it may be applied (under the
       * harness's own hooks.route certification, the subscriber's gate).
       */
      readonly blockedReason: SubagentRouteBlock | null;
      /** Shown when the route is not certified (explain instead of route). */
      readonly text: string;
      /**
       * Claude Code only: one short sentence for the model when the route is applied (it names the alias
       * set on this call and says the session model is unchanged); null elsewhere.
       */
      readonly appliedContext: string | null;
      /**
       * Claude Code only: one short sentence for the model when the route is advised and not applied
       * (uncertified, or the mode does not actuate); null elsewhere.
       */
      readonly adviceContext: string | null;
    }
  | { readonly outcome: 'abstain'; readonly reasonCode: SubagentRouteAbstainReason; readonly sliceId: string | null };

function aliasOf(family: string): ClaudeCodeSubagentAlias | null {
  return (CLAUDE_CODE_SUBAGENT_ALIASES as readonly string[]).includes(family) ? (family as ClaudeCodeSubagentAlias) : null;
}

/** Advice for one subagent launch. Abstains unless evidence supports a different model. */
export function adviseSubagentRoute(input: SubagentRouteInput): SubagentRouteAdvice {
  const abstain = (reasonCode: SubagentRouteAbstainReason, sliceId: string | null = null): SubagentRouteAdvice => ({ outcome: 'abstain', reasonCode, sliceId });
  if (!Object.prototype.hasOwnProperty.call(SUBAGENT_ROUTE_ACTUATORS, input.harness)) return abstain('HARNESS_NOT_SUPPORTED');
  const harness = input.harness as HarnessId;
  const actuator = SUBAGENT_ROUTE_ACTUATORS[harness];
  const type = input.subagentType ?? null;
  if (type === null || type.length === 0) return abstain('NO_SUBAGENT_TYPE');
  const sliceId = subagentSliceId(type);
  if (sliceId === null) return abstain('INVALID_SUBAGENT_TYPE');
  if (input.explicitModel) return abstain('EXPLICIT_MODEL', sliceId);
  if (input.pins.modelPin !== null) return abstain('PINNED', sliceId);
  // F's 057e8553: a Bedrock ARN session model arrives as the literal `bedrock-arn` (no account id).
  // Jevris cannot read which model or host that is, so it never routes from it.
  if (input.sessionModel === BEDROCK_ARN_MODEL) return abstain('HOST_UNKNOWN', sliceId);

  // Evidence: an active learned route for this subagent type, else a signed prior.
  let modelId: string | null = null;
  let basis: 'learning' | 'signed-prior' | 'risk-rule' | 'risk-jev' | null = null;
  let effort: string | null = null;
  if (input.learning !== null) {
    // R17: the slice learns under the harness's baseline, so a route learned on Claude Code's
    // subagents (the bare key there) is never proposed for another harness's subagents.
    const policy = slicePolicy(input.learning, subagentLearningKey(type, harness, input.registry) ?? sliceId);
    if (policy.mode === 'auto' && policy.modelId !== null) {
      modelId = policy.modelId;
      basis = 'learning';
      effort = policy.effort ?? null;
    }
  }
  if (modelId === null && input.signedPrior !== undefined && input.signedPrior !== null) {
    modelId = input.signedPrior.modelId;
    basis = 'signed-prior';
  }
  // Owner decision 2026-10-08: no learned or signed evidence, so the launch's own risk decides, on
  // Claude Code (the alias actuator) only. Evidence above always wins over this default.
  if (modelId === null && actuator?.carries === 'alias' && input.risk !== undefined && input.risk !== null) {
    if (input.risk.level === 'high') return abstain('RISK_HIGH', sliceId);
    const target = newestUsableOfFamily(input.registry, RISK_ROUTE_FAMILY[input.risk.level], input.nowMs);
    if (target !== null) {
      modelId = target.modelId;
      basis = input.risk.source === 'jev' ? 'risk-jev' : 'risk-rule';
    }
  }
  if (modelId === null || basis === null) return abstain('NO_EVIDENCE', sliceId);

  const model = registryModel(input.registry, modelId);
  if (model === null) return abstain('NOT_IN_REGISTRY', sliceId);
  if (!lifecycleCheck(model, input.nowMs).usable) return abstain('MODEL_RETIRED', sliceId);
  if (input.unavailableModels[modelId] !== undefined) return abstain('MODEL_UNAVAILABLE', sliceId);
  const consented = input.consentedProviders ?? null;
  if (consented !== null ? !consented.includes(model.provider) : model.requiresProviderConsent === true || !signedInDefaultAllowed(model.provider)) return abstain('PROVIDER_NOT_CONSENTED', sliceId);
  let alias: ClaudeCodeSubagentAlias | null = null;
  let harnessModel: string;
  let blockedReason: SubagentRouteBlock | null = null;
  if (actuator?.carries === 'alias') {
    alias = aliasOf(model.family);
    if (alias === null) return abstain('NO_ALIAS', sliceId);
    if (!aliasMeansModel(input.registry, model, input.nowMs)) return abstain('ALIAS_NOT_NEWEST', sliceId);
    // Owner decision 2026-10-08 (amends DOMAINS 3f090fa): no path skips the eligibility rule. For
    // Claude Code the list carries the HARNESS_ALIAS proof; null (an administrator's account check
    // decides, or the caller has none) is not checked here, as on the other harnesses.
    const eligibleAlias = input.locallyEligible ?? null;
    if (eligibleAlias !== null && !eligibleAlias.includes(model.modelId)) return abstain('NOT_ELIGIBLE_HERE', sliceId);
    // A risk default only ever goes to a cheaper model than the session runs.
    if ((basis === 'risk-rule' || basis === 'risk-jev') && !cheaperThanSession(input.registry, model, input.sessionModel, input.nowMs)) return abstain('NOT_CHEAPER', sliceId);
    harnessModel = alias;
  } else {
    // Scoped to this harness: it must spell the model (its access row or the model's own row),
    // and on Codex the model's own row (an offline preset), not the access template.
    const spelled = harnessModelId(input.registry, harness, model.modelId, model.provider);
    if (spelled === null) return abstain('NOT_ON_HARNESS', sliceId);
    // A harness that spells a host (Kilo, OpenCode): with no parent model the parent's host is not
    // known, and a child route keeps that host, so it abstains (a model id that failed the
    // adapter's shape check arrives as none).
    if (spelled.includes('/') && input.sessionModel === null) return abstain('HOST_UNKNOWN', sliceId);
    if (actuator?.presetOnly === true && !(model.harnessModels ?? []).some((row) => row.harness === harness)) return abstain('NOT_ON_HARNESS', sliceId);
    const eligibleHere = input.locallyEligible ?? null;
    if (actuator !== null && eligibleHere !== null && !eligibleHere.includes(model.modelId)) return abstain('NOT_ELIGIBLE_HERE', sliceId);
    // 8c1f85d and R44: a route keeps the parent session's host (Kilo and OpenCode spell one);
    // another provider's model only through the one host seen serving it here. An unreadable
    // session host gives HOST_UNKNOWN; no host for the model gives NOT_ON_SESSION_HOST.
    // R51: with a consent reader, host routes are answered; a pinned host must be consented (the
    // parent's own host is signed in) with no block on a host it forwards to.
    const read = input.providerConsent;
    const signedIn = sessionSignedInParties(input.registry, harness, input.sessionModel, null);
    const kept = spellTarget({
      registry: input.registry,
      harness,
      target: model,
      sessionModel: input.sessionModel,
      seen: input.seen?.(model.modelId) ?? [],
      eligibleHere: eligibleHere !== null && eligibleHere.includes(model.modelId),
      hostRoutes: read !== undefined,
      hostAllowed: (host) => read !== undefined && hostConsent(host, signedIn, read).allowed && blockedDownstream(host, read) === null,
    });
    if (!kept.ok) return abstain(kept.reasonCode, sliceId);
    harnessModel = kept.id;
    // B's condition (R50): both sides at a known tariff on their host; then the route.host gate.
    const parent = sessionHost(input.registry, harness, input.sessionModel);
    const tariff = hostTariffGuard(input.registry, [
      { servingHost: kept.servingHost, provider: model.provider, modelId: model.modelId },
      ...(parent === null ? [] : [{ servingHost: parent.servingHost, provider: parent.provider, modelId: parent.modelId }]),
    ]);
    blockedReason = tariff ?? ((kept.hostRoute || kept.hostChanged) && input.hostRouteCertified !== true ? 'ROUTE_HOST_NOT_CERTIFIED' : null);
  }
  // Design E5: the scope the subagent would run in (this harness and sign-in, and on Kilo and
  // OpenCode the host the route keeps) must not be paused. Claude Code's alias is its maker's model.
  if (accessPauseForSpelling(input.accessLimits ?? [], input.registry, harness, alias === null ? harnessModel : model.modelId, input.authMode ?? null, input.nowMs) !== null) return abstain('ACCESS_LIMITED', sliceId);
  // A learned arm at a non-default effort rides as the route's variant where the actuator carries
  // one and the harness names that level; otherwise it cannot be applied as is.
  // On Codex (43cb54c) the model is routed and the effort is only stated.
  let variant: string | null = null;
  let effortNotApplied: string | null = null;
  if (effort !== null && effort !== defaultEffortOf(modelId, input.registry)) {
    if (actuator === null || actuator.effort === 'none') return abstain('EFFORT_NOT_ROUTABLE', sliceId);
    const token = harnessEffortToken(input.registry, harness, model.modelId, effort, model.provider);
    if (token === null || !VARIANT.test(token)) return abstain('EFFORT_NOT_ROUTABLE', sliceId);
    if (actuator.effort === 'explain') effortNotApplied = token;
    else variant = token;
  }
  // Nothing to change when the subagent would already run this model (by id or by alias).
  const session = input.sessionModel;
  if (session !== null && (session === modelId || session === harnessModel)) return abstain('SAME_AS_SESSION', sliceId);

  const sessionPhrase = 'The session model is unchanged.';
  const what = alias === null ? null : alias;
  const riskWhy = input.risk === undefined || input.risk === null ? '' : `${riskClassText(input.risk.subagentClass, type)}, ${input.risk.level} risk by ${input.risk.source === 'jev' ? 'Jev' : 'rules'}`;
  const why =
    basis === 'learning'
      ? `this workspace's route learning for ${type} subagents`
      : basis === 'signed-prior'
        ? `a signed calibration release for ${type} subagents`
        : riskWhy;
  const reasonCode = basis === 'learning' ? 'SUBAGENT_ROUTE_LEARNED' : basis === 'signed-prior' ? 'SUBAGENT_ROUTE_PRIOR' : basis === 'risk-rule' ? 'SUBAGENT_ROUTE_RISK_RULE' : 'SUBAGENT_ROUTE_RISK_JEV';
  return {
    outcome: 'propose',
    harness,
    modelId,
    harnessModel,
    alias,
    actuator,
    variant,
    effortNotApplied,
    sliceId,
    basis,
    reasonCode,
    blockedReason,
    text: `Jevris suggests ${model.displayName ?? modelId} (${harnessModel}${variant === null ? '' : `, ${variant}`}) for this ${type} subagent, from ${why}. The subagent keeps its model unless the route is applied.${effortNotApplied === null ? '' : ` The learned effort is ${effortNotApplied}; the route sets the model only, so the subagent runs at its own effort.`}${blockedReason === null ? '' : ` Not applied (${blockedReason}): ${blockedReason === 'HOST_TARIFF_UNKNOWN' ? "a price on this host is not known, only the maker's list price as an estimate" : 'routes through a gateway or onto another host need the route.host certification'}.`}`,
    appliedContext: what === null ? null : `Jevris set model ${what} on this one Agent call (${why}). ${sessionPhrase}`,
    adviceContext: what === null ? null : `Jevris advises model: ${what} for this ${type} subagent (${why}). This call already started; set model on the next Agent call to apply it. ${sessionPhrase}`,
  };
}

/** How a launch's type reads in the route text. */
function riskClassText(subagentClass: SubagentClass, type: string): string {
  return subagentClass === 'read-only' ? 'read-only type' : subagentClass === 'general-purpose' ? 'general-purpose type' : `custom type ${type}`;
}

/** The newest usable registry release of an Anthropic family: what Claude Code's alias of that name means. Null when there is none. */
function newestUsableOfFamily(registry: ModelRegistry, family: string, nowMs: number): RoutingModel | null {
  let best: RoutingModel | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const entry of registry.entries) {
    if (entry.provider !== 'anthropic' || entry.family !== family || !lifecycleCheck(entry, nowMs).usable) continue;
    const day = entry.lifecycle?.releasedOn ?? null;
    const at = day === null ? Number.NaN : Date.parse(day);
    if (!Number.isFinite(at)) continue;
    if (at > bestAt) {
      best = entry;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Whether `target` lists a lower input price than the session's model. A session model that is not
 * in the registry (or is a bare alias of an unknown family) is not compared: the default route is
 * a cheaper model by construction, and an unknown session is read as the registry's baseline.
 */
function cheaperThanSession(registry: ModelRegistry, target: RoutingModel, sessionModel: string | null, nowMs: number): boolean {
  if (sessionModel === null) return true;
  const alias = (CLAUDE_CODE_SUBAGENT_ALIASES as readonly string[]).includes(sessionModel) ? sessionModel : null;
  const session = alias === null ? registryModel(registry, sessionModel) : newestUsableOfFamily(registry, alias, nowMs);
  // The same model is SAME_AS_SESSION's to refuse, not this guard's.
  if (session === null || session.modelId === target.modelId) return true;
  return target.tariff.inputPerMillion < session.tariff.inputPerMillion;
}
