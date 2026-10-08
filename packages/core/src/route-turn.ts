/**
 * OD-8 (owner decisions DOMAINS f294e43): the per-turn main-session route for Kilo and OpenCode.
 * Before a turn's `chat.message`, the plugin asks the sidecar's `route.turn`; this is the rule it
 * answers with. Pure: the caller passes the loaded registry, the workspace's learning state, the
 * approved scope (D's turn gate, merged by the sidecar) and the consent reader.
 *
 * It abstains by default. It names a model only when the slice's learning has promoted one
 * (`auto`, which already needed 12 local randomized outcomes per arm), under the key of the
 * session's own baseline (its current model, OD-3 and R17). It actuates only when, on top:
 * - the effective main-session mode is `plugin-bounded-auto`;
 * - D's gate says `bounded-auto` (Kilo or OpenCode, `session.route` certified, a low-risk task,
 *   the kill switch and the budget allow it) and the kill switch is not stopped now;
 * - no model pin holds;
 * - the model is usable, spelled on this harness, and its provider passes consent.
 * Access limits (R73): a session whose own harness, sign-in and host are paused gets advice only,
 * naming the reset and a model that is not paused (OP-10); a paused target is never switched to.
 * Otherwise a promoted model is advice (`outcome: 'switch'`, `actuate: false`) with the reason.
 *
 * A route keeps the session's host (owner decisions 8c1f85d; serving hosts R44, `spellTarget`): the
 * target is written through the provider segment the session uses when it is the same provider, and
 * an effort-only change keeps the session's spelling exactly. Another provider's model is written
 * only through the one host seen serving it on this harness (`seen`, or `locallyEligible` for a v1
 * model offer); otherwise the turn abstains (NOT_ON_SESSION_HOST).
 *
 * Serving hosts R50 (design 4.3 to 6.3; coordinator's gate rule): the session is read through the
 * one resolver, so a gateway session (`openrouter/moonshotai/kimi-k3`) is a registry model served by
 * that host. On top of the conditions above, a route
 * - passes consent for its pair (`routeConsentGate`: the maker, the host, and no block on a host it
 *   forwards to), with the session's host signed in (OQ-3);
 * - acts only when every side's tariff on its host is known (`hostTariffGuard`,
 *   HOST_TARIFF_UNKNOWN; B's condition);
 * - that goes through a pinned host on either side, or changes the session's host, acts only when
 *   the harness's `route.host` certification covers the session's version (ROUTE_HOST_NOT_CERTIFIED;
 *   from the sidecar, never the plugin). A same-maker route through the maker stays under
 *   `session.route` alone.
 * The last two leave the answer as advice, naming the model; a person can still switch.
 * The plugin rewrites only that turn's model; nothing in the user's configuration changes.
 */
import type { HarnessId, ModelRegistry, RouteTurnPayload } from '@jevris/contracts';
import { TURN_HARNESSES } from '@jevris/contracts';
import { harnessEffortToken, resolveSpelling } from './harness-model-id.js';
import { lifecycleCheck, registryModel, routeBaseline } from './model-registry.js';
import { blockedDownstream, hostConsent, providerConsentGate, routeConsentGate, type ProviderConsentReader } from './provider-consent-gate.js';
import type { SeenSpelling } from './model-offer.js';
import { learningSliceKey, slicePolicy, type LearningState } from './route-learning.js';
import { sessionSignedInParties, spellTarget } from './session-host.js';
import { hostTariffGuard } from './serving-tariff.js';
import { accessPauseForSpelling, accessPauseNoteText, sessionPauseAdvice, type AccessLimitEntry } from './access-limits.js';

export type TurnHarness = (typeof TURN_HARNESSES)[number];
export type MainSessionModeValue = RouteTurnPayload['mainSession']['mode'];

/** D's approved scope as the sidecar merges it (state.ts withApprovedScope); absent: advise. */
export interface TurnScope {
  readonly taskId?: string;
  readonly risk?: string;
  readonly sliceId?: string;
  readonly turnActuation: 'bounded-auto' | 'advise';
  readonly turnReasonCode: string | null;
}

export interface RouteTurnInput {
  readonly harness: TurnHarness;
  /** The turn's model as the harness names it: its providerID and modelID. */
  readonly current: { readonly providerID: string; readonly modelID: string; readonly variant?: string | null };
  readonly registry: ModelRegistry;
  /** The workspace's route learning; null when it has none (then nothing is promoted). */
  readonly learning: LearningState | null;
  /** The task slice; from the approved scope, else the request. Null: no slice, abstain. */
  readonly sliceId: string | null;
  readonly scope: TurnScope | null;
  /** The effective `routing.mainSession`; null when the sidecar could not read it (advice only). */
  readonly mainSession: MainSessionModeValue | null;
  readonly killSwitchStopped: boolean;
  readonly modelPin: string | null;
  readonly nowMs: number;
  readonly providerConsent?: ProviderConsentReader;
  /**
   * The models listed or run on this harness (`locallyEligibleFor`). Another provider's model is
   * written only when it is here, since that is how its host was seen. Absent or null: none seen.
   */
  readonly locallyEligible?: readonly string[] | null;
  /** The spellings of a model seen on this harness (`seenSpellings` over the model offer); absent: none. */
  readonly seen?: (modelId: string) => readonly SeenSpelling[];
  /**
   * Access limits R73 (design E4): the machine's access-limit entries (`readAccessLimits`); absent:
   * none. A paused current scope gets advice only (OP-10); a paused target is not switched to.
   */
  readonly accessLimits?: readonly AccessLimitEntry[];
  /** The session's sign-in (`api-key` or `subscription`); absent or null: unknown, which matches both. */
  readonly authMode?: string | null;
  /**
   * Serving hosts R50: the harness's `route.host` certification covers the session's version (the
   * sidecar's own answer, B's 76c5d764; never the plugin's). Absent: false, so a route through a
   * host or one that changes the session's host is advice only.
   */
  readonly hostRouteCertified?: boolean;
}

/** A route through a pinned host, or one that changes the session's host, without `route.host` certified. */
export const ROUTE_HOST_NOT_CERTIFIED = 'ROUTE_HOST_NOT_CERTIFIED';

const TEXT_MAX = 500;
const VARIANT = /^[a-z][a-z0-9-]{0,31}$/;

function clip(text: string): string {
  return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1)}…`;
}

/** Splits a harness `provider/model` id into the plugin's providerID and modelID. */
function splitTurnModel(id: string): { readonly providerID: string; readonly modelID: string } | null {
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) return null;
  return { providerID: id.slice(0, at), modelID: id.slice(at + 1) };
}

export function routeTurn(input: RouteTurnInput): RouteTurnPayload {
  const mode: MainSessionModeValue = input.mainSession ?? 'advice-only';
  const abstain = (reasonCode: string, text: string): RouteTurnPayload => ({
    harness: input.harness,
    mainSession: { mode, switched: false },
    outcome: 'abstain',
    actuate: false,
    reasonCode,
    text: clip(text),
  });
  if (!(TURN_HARNESSES as readonly string[]).includes(input.harness)) return abstain('HARNESS_ADVICE_ONLY', 'Only Kilo and OpenCode turns can be switched; the model stays as it is.');
  if (input.killSwitchStopped) return abstain('KILL_SWITCH', 'The kill switch is on; the model stays as it is.');
  if (input.modelPin !== null) return abstain('PIN_RESPECTED', `Keep ${input.modelPin}. It is pinned, and Jevris never changes a pinned model.`);
  const harness = input.harness as HarnessId;
  // R50: the one resolver, so a pinned gateway or host spelling reads as its model and that host.
  const current = resolveSpelling(input.registry, harness, `${input.current.providerID}/${input.current.modelID}`); // path-hygiene: allow a harness model id (provider/model), not a path
  if (current === null) return abstain('CURRENT_MODEL_UNREGISTERED', 'The current model is not in the model registry (or runs through a host Jevris does not know), so Jevris does not route this turn.');
  // OP-10: a session whose own scope is paused is never switched away; the advice names the reset
  // and one model this harness runs that is not paused.
  const accessLimits = input.accessLimits ?? [];
  const authMode = input.authMode ?? null;
  const sessionSpelling = `${input.current.providerID}/${input.current.modelID}`; // path-hygiene: allow a harness model id (provider/model), not a path
  const currentPause = accessPauseForSpelling(accessLimits, input.registry, harness, sessionSpelling, authMode, input.nowMs);
  if (currentPause !== null) {
    const advice = sessionPauseAdvice({ entries: accessLimits, registry: input.registry, harness, authMode, pause: currentPause, currentModelId: current.modelId, candidates: input.locallyEligible ?? [], nowMs: input.nowMs });
    return abstain(advice.reasonCode, advice.text);
  }
  if (input.sliceId === null) return abstain('UNKNOWN_SLICE', 'This turn has no task slice, so no learned route applies; the model stays as it is.');
  if (input.learning === null) return abstain('NO_PROMOTED_SLICE', 'No route learning in this workspace yet; the model stays as it is.');
  // OD-3 and R17: the session's current model is its baseline, and the slice learns under that key.
  const baseline = routeBaseline(input.registry, harness, current.modelId);
  const key = learningSliceKey(input.sliceId, baseline);
  const policy = slicePolicy(input.learning, key);
  if (policy.mode !== 'auto' || policy.modelId === null) {
    return abstain(policy.mode === 'pinned' ? 'SLICE_PINNED' : 'NO_PROMOTED_SLICE', `Slice ${input.sliceId} has no promoted model against ${current.modelId}; the model stays as it is.`);
  }
  const target = registryModel(input.registry, policy.modelId);
  if (target === null) return abstain('PROMOTED_MODEL_UNREGISTERED', `The promoted model ${policy.modelId} is not in the loaded registry; the model stays as it is.`);
  if (!lifecycleCheck(target, input.nowMs).usable) return abstain('PROMOTED_MODEL_UNUSABLE', `The promoted model ${policy.modelId} is retired or past its date; the model stays as it is.`);
  const effort = policy.effort ?? null;
  if (target.modelId === current.modelId && effort === null) return abstain('ALREADY_ON_MODEL', `This turn already runs ${current.modelId}.`);
  // OD-4 and design 4.4: the session is signed in to the host its spelling goes to (the maker for a
  // direct spelling, the gateway for a gateway one, never the maker behind a gateway).
  const signedIn = sessionSignedInParties(input.registry, harness, sessionSpelling, null);
  const read: ProviderConsentReader = input.providerConsent ?? (() => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }));
  // 8c1f85d: the session's host is kept. An effort-only change keeps the session's own spelling.
  // R50: host routes are answered; consent for a pinned host (and the hosts it forwards to) decides
  // which hosts a route may use, and certification and tariffs decide below whether it may act.
  const kept = spellTarget({
    registry: input.registry,
    harness,
    target,
    sessionModel: sessionSpelling,
    seen: input.seen?.(target.modelId) ?? [],
    eligibleHere: (input.locallyEligible ?? []).includes(target.modelId),
    hostRoutes: true,
    hostAllowed: (host) => hostConsent(host, signedIn, read).allowed && blockedDownstream(host, read) === null,
  });
  if (!kept.ok && kept.reasonCode === 'NOT_ON_HARNESS') return abstain('NOT_ON_HARNESS', `${input.harness} does not name ${target.modelId}; the model stays as it is.`);
  let variant: string | null = null;
  if (effort !== null) {
    const token = harnessEffortToken(input.registry, harness, target.modelId, effort, target.provider);
    if (token === null || !VARIANT.test(token)) return abstain('EFFORT_NOT_ON_HARNESS', `${input.harness} has no ${effort} variant for ${target.modelId}; the model stays as it is.`);
    variant = token;
  }
  // OD-4: a provider the session is not signed in to needs its consent.
  const consent = providerConsentGate(input.registry, signedIn, read);
  if (!consent.consentedProviders.includes(target.provider)) {
    const why = consent.blocked.find((b) => b.provider === target.provider)?.reasonCode ?? 'PROVIDER_CONSENT_REQUIRED';
    return abstain(why, `${target.modelId} needs consent for ${target.provider} (jevris consent provider); the model stays as it is.`);
  }
  // After consent (a person can grant consent; a host Jevris has not seen cannot be fixed that way).
  if (!kept.ok && kept.reasonCode === 'HOST_UNKNOWN') return abstain('HOST_UNKNOWN', `Jevris cannot read this session's host, so it does not route this turn; the model stays as it is.`);
  if (!kept.ok) {
    // Every host the target was seen through is a pinned host that consent blocks: name the first,
    // since a person can fix that.
    const refusals = kept.seenHosts.map((host) => (host === target.provider ? { allowed: true as const } : routeConsentGate(input.registry, signedIn, read, { provider: target.provider, servingHost: host, via: 'host' })));
    const first = refusals[0];
    if (first !== undefined && !first.allowed && refusals.every((r) => !r.allowed)) {
      return abstain(first.reasonCode, `${target.modelId} was seen here only through hosts Jevris may not use now; ${first.party} needs consent (jevris consent provider). The model stays as it is.`);
    }
    const where = kept.seenHosts.length === 0 ? `has not seen ${input.harness} run ${target.modelId} through it` : `has seen ${input.harness} run ${target.modelId} only through ${kept.seenHosts.join(' and ')}`;
    return abstain('NOT_ON_SESSION_HOST', `Jevris keeps this session's host and ${where}; the model stays as it is. Choosing another host is yours.`);
  }
  // Design 5.1 (R45): the route's pair, the maker and the host it goes through and what that forwards to.
  const pair = routeConsentGate(input.registry, signedIn, read, { provider: target.provider, servingHost: kept.servingHost, via: kept.via });
  if (!pair.allowed) {
    const whose = pair.downstream ? `${pair.party}, which ${kept.servingHost} forwards to,` : pair.party;
    return abstain(pair.reasonCode, `${target.modelId} through ${kept.servingHost} needs consent for ${whose} (jevris consent provider); the model stays as it is.`);
  }
  const model = splitTurnModel(kept.id);
  if (model === null) return abstain('NOT_ON_HARNESS', `${input.harness} does not name ${target.modelId}; the model stays as it is.`);
  // Design E4: the target's scope, through the host the route keeps, must not be paused.
  const targetPause = accessPauseForSpelling(accessLimits, input.registry, harness, kept.id, authMode, input.nowMs);
  if (targetPause !== null) {
    return abstain('ACCESS_LIMITED', `Not switched: ${accessPauseNoteText(target.modelId, { class: targetPause.class, untilMs: targetPause.untilMs, scope: targetPause.entry.scope })}. The model stays as it is.`);
  }
  // OQ-1: a route that changes the session's host says so.
  const hostNote = kept.hostChanged ? ` through ${kept.servingHost} (this session uses ${current.servingHost})` : '';
  const label = `${model.providerID}/${model.modelID}${variant === null ? '' : ` (${variant})`}${hostNote}`; // path-hygiene: allow a harness model id (provider/model), not a path
  // R50: B's condition, every side at a known tariff on its host; and the route.host gate for what
  // is new in phase 2 (a pinned host on either side, or a changed host).
  const tariff = hostTariffGuard(input.registry, [
    { servingHost: kept.servingHost, provider: target.provider, modelId: target.modelId },
    { servingHost: current.servingHost, provider: current.provider, modelId: current.modelId },
  ]);
  const hostGate = (kept.hostRoute || kept.hostChanged) && input.hostRouteCertified !== true ? ROUTE_HOST_NOT_CERTIFIED : null;
  // Every actuation condition, in the order a person would fix them.
  const blocked =
    mode !== 'plugin-bounded-auto'
      ? 'MAIN_SESSION_ADVICE_ONLY'
      : input.scope === null
        ? 'NO_APPROVED_SCOPE'
        : input.scope.turnActuation !== 'bounded-auto' || input.scope.turnReasonCode !== null
          ? (input.scope.turnReasonCode ?? 'TURN_GATE_ADVISE')
          : input.scope.risk !== 'low'
            ? 'RISK_NOT_LOW'
            : (tariff ?? hostGate);
  if (blocked !== null) {
    return {
      harness: input.harness,
      mainSession: { mode, switched: false },
      outcome: 'switch',
      actuate: false,
      reasonCode: blocked,
      text: clip(`Advice: slice ${input.sliceId} has promoted ${label} over ${current.modelId}. Not switched (${blocked}); switch it yourself if you like.`),
      model,
      variant,
    };
  }
  return {
    harness: input.harness,
    mainSession: { mode, switched: true },
    outcome: 'switch',
    actuate: true,
    reasonCode: policy.direction === 'upgrade' ? 'PROMOTED_UPGRADE' : 'PROMOTED_SAVING',
    text: clip(`Switched this turn to ${label}: slice ${input.sliceId} promoted it over ${current.modelId} on this workspace's own outcomes. Your configuration is unchanged.`),
    model,
    variant,
  };
}
