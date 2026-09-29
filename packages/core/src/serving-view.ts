/**
 * Serving hosts R55 (design 8; E's RouteServingSchema, 53b2ec5f): the serving view that route and
 * explain show. Which host the session's model goes through, the target the route wrote or
 * recommends and its host, whether the route kept the host, where the target has been seen, what
 * its price rests on and each party's consent state.
 *
 * Pure: the caller passes the registry, the harness spellings and the consent reader. Every
 * spelling is read through the one resolver; nothing is taken from a plugin's claim. A session
 * spelling the resolver cannot read gives no view (null): the surfaces then show no host lines.
 */
import { ACCESS_SERVING_HOSTS, SERVING_HOST_CONSENT_TEXT, PROVIDER_CONSENT_TEXT, servingHostOf, type HarnessId, type ModelRegistry, type ProviderConsentState, type RouteServing } from '@jevris/contracts';
import { resolveSpelling, type ResolvedSpelling } from './harness-model-id.js';
import { BUNDLED_REGISTRY_SOURCES } from './model-registry.js';
import { blockedDownstream, hostConsent, providerConsentGate, routeConsentGate, type ProviderConsentReader } from './provider-consent-gate.js';
import type { SeenSpelling } from './model-offer.js';
import { hostTariffGuard, servingTariff } from './serving-tariff.js';
import { spellTarget } from './session-host.js';

export interface ServingViewInput {
  readonly registry: ModelRegistry;
  readonly harness: HarnessId;
  /** The session's model exactly as the harness spells it. */
  readonly sessionSpelling: string;
  /** The spelling the route wrote or recommends; null when it wrote none. */
  readonly targetSpelling?: string | null;
  /** The target model when the route named one but wrote no spelling (refused); ignored with a spelling. */
  readonly target?: { readonly provider: string; readonly modelId: string } | null;
  /** Whether the route kept the host; null when no route was asked. */
  readonly hostDecision?: RouteServing['hostDecision'];
  readonly hostReasonCode?: string | null;
  /** The spellings of the target seen on this harness (`seenSpellings`). */
  readonly seen?: readonly SeenSpelling[];
  /** B's stored-consent reader; absent: every party reads as having no stored grant. */
  readonly read?: ProviderConsentReader;
  /** The parties the session is signed in to (`sessionSignedInParties`). */
  readonly signedIn: readonly string[];
}

const PARTIES: ReadonlySet<string> = new Set(ACCESS_SERVING_HOSTS);
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const NO_ROW = (): { readonly granted: false; readonly reasonCode: string } => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' });

/** A stored read as a state: a grant, a revoke, or another read that blocks (stale, unreadable). */
function storedState(read: ProviderConsentReader, party: string): 'granted' | 'revoked' | 'blocked' | null {
  let got: unknown;
  try {
    got = read(party);
  } catch {
    return 'blocked';
  }
  if (got === null || typeof got !== 'object') return 'blocked';
  if (Reflect.get(got, 'granted') === true) return 'granted';
  const code: unknown = Reflect.get(got, 'reasonCode');
  if (Reflect.get(got, 'granted') !== false || typeof code !== 'string') return 'blocked';
  if (code === 'PROVIDER_CONSENT_MISSING') return null;
  return code === 'PROVIDER_CONSENT_REVOKED' ? 'revoked' : 'blocked';
}

/**
 * The maker's state, read from the same gate as routing (`providerConsentGate`; B's LOW 35), so the
 * view never says a maker is blocked that routing uses: let through is `granted` (a stored grant) or
 * `signed-in-default`; a stored revoke is `revoked` and another blocking read `blocked`; a maker the
 * gate otherwise blocks is `no-text` without consent text, else `required`.
 */
function makerState(registry: ModelRegistry, provider: string, signedIn: readonly string[], read: ProviderConsentReader): ProviderConsentState {
  const stored = storedState(read, provider);
  const gate = providerConsentGate(registry, signedIn, read);
  if (gate.consentedProviders.includes(provider)) return stored === 'granted' ? 'granted' : 'signed-in-default';
  // A maker the registry does not list is not in the gate: only its stored row can speak for it.
  if (stored === 'revoked' || stored === 'blocked') return stored;
  if (stored === 'granted' && !registry.entries.some((e) => e.provider === provider)) return 'granted';
  return Object.hasOwn(PROVIDER_CONSENT_TEXT, provider) ? 'required' : 'no-text';
}

/** A pinned host's state, with `hostConsent`'s order, and `blocked` when a host it forwards to blocks. */
function hostState(host: string, signedIn: readonly string[], read: ProviderConsentReader): ProviderConsentState {
  const text = Object.hasOwn(SERVING_HOST_CONSENT_TEXT, host) && !Object.hasOwn(PROVIDER_CONSENT_TEXT, host) ? SERVING_HOST_CONSENT_TEXT[host] : undefined;
  const stored = storedState(read, host);
  if (stored === 'revoked' || stored === 'blocked') return stored;
  if (text === undefined) return 'no-text';
  if (blockedDownstream(host, read) !== null) return 'blocked';
  if (stored === 'granted') return 'granted';
  if (text.alwaysRequired) return 'required';
  return signedIn.includes(host) ? 'signed-in-default' : 'required';
}

/** The price basis for a model through a host, with the snapshot source for a pinned host's tariff. */
function priceOf(registry: ModelRegistry, host: string, provider: string, modelId: string): Pick<RouteServing, 'tariffBasis' | 'tariffSource'> {
  const priced = servingTariff(registry, host, provider, modelId);
  if (priced === null || priced.basis !== 'host') return { tariffBasis: 'maker-price-estimate', tariffSource: null };
  if (host === provider) return { tariffBasis: 'host', tariffSource: null };
  const sourceId = priced.tariff.sourceId ?? null;
  const fetchedOn = sourceId === null ? null : (BUNDLED_REGISTRY_SOURCES[sourceId]?.fetchedOn ?? priced.tariff.effectiveAt.slice(0, 10));
  return { tariffBasis: 'host', tariffSource: sourceId === null || fetchedOn === null || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fetchedOn) ? null : { sourceId, fetchedOn } };
}

export function servingView(input: ServingViewInput): RouteServing | null {
  const { registry, harness } = input;
  const session = resolveSpelling(registry, harness, input.sessionSpelling);
  if (session === null || !PARTIES.has(session.servingHost)) return null;
  const read = input.read ?? NO_ROW;
  const spelled: ResolvedSpelling | null = input.targetSpelling === undefined || input.targetSpelling === null ? null : resolveSpelling(registry, harness, input.targetSpelling);
  const target = spelled ?? (input.target === undefined || input.target === null ? null : input.target);
  // Price and consent describe the target when there is one, else the session's model. A target
  // with no spelling is priced through the session's gateway or host (the one the route would have
  // kept); from a session direct at a maker, at the target's own maker.
  const priced = target ?? session;
  const pricedHost = spelled?.servingHost ?? (session.via === 'maker' ? priced.provider : session.servingHost);
  const viaHost = spelled?.via ?? (target === null ? session.via : pricedHost === priced.provider ? 'maker' : 'host');
  const seenHosts = target === null
    ? []
    : [...new Set((input.seen ?? []).map((s) => resolveSpelling(registry, harness, s.raw)).filter((r): r is ResolvedSpelling => r !== null && r.provider === target.provider && r.modelId === target.modelId).map((r) => r.servingHost))]
        .filter((h) => PARTIES.has(h))
        .sort()
        .slice(0, 16);
  const reason = input.hostReasonCode ?? null;
  return {
    spelling: session.raw,
    provider: session.provider,
    modelId: session.modelId,
    servingHost: session.servingHost as RouteServing['servingHost'],
    via: session.via,
    targetSpelling: spelled === null ? null : spelled.raw,
    targetProvider: target === null ? null : target.provider,
    targetModelId: target === null ? null : target.modelId,
    targetServingHost: spelled === null || !PARTIES.has(spelled.servingHost) ? null : (spelled.servingHost as RouteServing['servingHost']),
    targetVia: spelled === null ? null : spelled.via,
    hostDecision: input.hostDecision ?? null,
    hostReasonCode: reason !== null && CODE.test(reason) ? reason : null,
    seenHosts: seenHosts as RouteServing['seenHosts'],
    ...priceOf(registry, pricedHost, priced.provider, priced.modelId),
    consent: {
      host: viaHost === 'host' && servingHostOf(pricedHost) !== undefined ? hostState(pricedHost, input.signedIn, read) : null,
      maker: makerState(registry, priced.provider, input.signedIn, read),
    },
  };
}

/**
 * The view for advice that names a target model (the main-session route): the target is spelled
 * on the session's host by `spellTarget`'s rules with host routes answered and host consent from
 * the reader, so the view says whether the host would be kept, changed or not switched, and why.
 * A spelling that is written but priced by estimate carries HOST_TARIFF_UNKNOWN as its reason.
 */
export function routeServingOf(input: {
  readonly registry: ModelRegistry;
  readonly harness: HarnessId;
  readonly sessionSpelling: string;
  readonly target: { readonly provider: string; readonly modelId: string } | null;
  readonly seen: readonly SeenSpelling[];
  readonly eligibleHere?: boolean;
  readonly read?: ProviderConsentReader;
  readonly signedIn: readonly string[];
}): RouteServing | null {
  const base = { registry: input.registry, harness: input.harness, sessionSpelling: input.sessionSpelling, seen: input.seen, signedIn: input.signedIn, ...(input.read === undefined ? {} : { read: input.read }) };
  const target = input.target;
  if (target === null) return servingView(base);
  const read = input.read ?? NO_ROW;
  const kept = spellTarget({
    registry: input.registry,
    harness: input.harness,
    target: target,
    sessionModel: input.sessionSpelling,
    seen: input.seen,
    eligibleHere: input.eligibleHere === true,
    hostRoutes: true,
    hostAllowed: (host) => hostConsent(host, input.signedIn, read).allowed && blockedDownstream(host, read) === null,
  });
  const pairGate = (servingHost: string, via: 'maker' | 'host') => routeConsentGate(input.registry, input.signedIn, read, { provider: target.provider, servingHost, via });
  if (!kept.ok) {
    // As route.turn: when every host the target was seen through is one consent blocks, the reason
    // is that consent (a person can fix it), not that the host is not the session's.
    const refusals = kept.reasonCode === 'NOT_ON_SESSION_HOST' ? kept.seenHosts.map((host) => (host === target.provider ? { allowed: true as const } : pairGate(host, 'host'))) : [];
    const first = refusals[0];
    const reason = first !== undefined && !first.allowed && refusals.every((r) => !r.allowed) ? first.reasonCode : kept.reasonCode;
    return servingView({ ...base, target: target, hostDecision: 'not-switched', hostReasonCode: reason });
  }
  // The route's pair (the maker and the host it goes through, and what that forwards to).
  const pair = pairGate(kept.servingHost, kept.via);
  if (!pair.allowed) return servingView({ ...base, targetSpelling: kept.id, hostDecision: 'not-switched', hostReasonCode: pair.reasonCode });
  const session = resolveSpelling(input.registry, input.harness, input.sessionSpelling);
  const tariff = hostTariffGuard(input.registry, [
    { servingHost: kept.servingHost, provider: target.provider, modelId: target.modelId },
    ...(session === null ? [] : [{ servingHost: session.servingHost, provider: session.provider, modelId: session.modelId }]),
  ]);
  return servingView({ ...base, targetSpelling: kept.id, hostDecision: kept.hostChanged ? 'changed' : 'kept', hostReasonCode: tariff });
}
