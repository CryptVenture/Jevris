/**
 * Which providers a route may send content to (routing design R30; owner decisions DOMAINS 7be3c43
 * and OD-4). Pure: the caller passes the providers the session is signed in to and a point read of
 * the stored per-provider consent (B's `providerConsent(provider)`), and gets the providers the
 * router's `provider-consent` gate lets through, plus a reason code for each one it blocks.
 *
 * Precedence, first match wins, per provider:
 * 1. A current stored grant allows.
 * 2. A revoke or a stale grant (the consent text changed) blocks, even while signed in.
 * 3. A provider that always needs consent blocks without a current grant, even while signed in.
 *    That set is pinned in code, not taken from the registry alone (B's security review, HIGH 5):
 *    a provider whose consent text says `alwaysRequired` (Moonshot, DeepSeek), a provider with no
 *    consent text (other than Anthropic, the product's own default), and any provider the
 *    registry marks `requiresProviderConsent`. A placed registry can add a mark, never drop one.
 * 4. Otherwise a signed-in provider allows (the user already chose to send it content), and a
 *    provider the session is not signed in to blocks.
 *
 * A read that cannot be trusted (PROVIDER_CONSENT_UNREADABLE, for example no store open) blocks
 * like a revoke (HIGH 6): consent that cannot be read is not consent. Only PROVIDER_CONSENT_MISSING
 * reads as "no row"; any other reason code reads as unreadable (B's LOW 21).
 */
import { PROVIDER_CONSENT_TEXT, SERVING_HOST_CONSENT_TEXT, servingHostOf, type ModelRegistry } from '@jevris/contracts';
import { resolveHarnessModel } from './harness-model-id.js';

/** What the store's point read returns (B's engine option `providerConsent`). */
export type ProviderConsentRead =
  | { readonly granted: true }
  | { readonly granted: false; readonly reasonCode: string };

/** B's reader. Its answer is checked here: anything but `{granted: true}` or a reason code is UNREADABLE. */
export type ProviderConsentReader = (provider: string) => ProviderConsentRead | unknown;

export interface ProviderConsentGate {
  /** Providers the `provider-consent` gate lets through, sorted. */
  readonly consentedProviders: readonly string[];
  /** Providers it blocks, sorted by provider, each with why. */
  readonly blocked: readonly { readonly provider: string; readonly reasonCode: string }[];
}

/** A stored state that blocks whatever else holds. */
const BLOCKING_READS: ReadonlySet<string> = new Set(['PROVIDER_CONSENT_REVOKED', 'PROVIDER_CONSENT_STALE', 'PROVIDER_CONSENT_UNREADABLE']);

/**
 * Whether a signed-in session may send this provider content without a grant (OD-4's default).
 * Pinned in code: Anthropic, or a provider whose consent text passed the review
 * (`alwaysRequired: false`). A provider with no consent text never qualifies.
 */
export function signedInDefaultAllowed(provider: string): boolean {
  if (provider === 'anthropic') return true;
  return Object.hasOwn(PROVIDER_CONSENT_TEXT, provider) && PROVIDER_CONSENT_TEXT[provider]?.alwaysRequired === false;
}

/** The reason for a provider blocked without a stored revoke or stale grant. */
export const PROVIDER_CONSENT_REQUIRED = 'PROVIDER_CONSENT_REQUIRED';

function safeRead(read: ProviderConsentReader, provider: string): ProviderConsentRead {
  const unreadable: ProviderConsentRead = { granted: false, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' };
  try {
    const got: unknown = read(provider);
    if (got === null || typeof got !== 'object') return unreadable;
    const granted: unknown = Reflect.get(got, 'granted');
    if (granted === true) return { granted: true };
    const reasonCode: unknown = Reflect.get(got, 'reasonCode');
    if (granted !== false || typeof reasonCode !== 'string') return unreadable;
    // B's LOW 21: only "no row" is not a block. Any other code, including one added later on the
    // store's side, blocks as unreadable unless it is a known blocking read, so none fails open.
    return reasonCode === 'PROVIDER_CONSENT_MISSING' || BLOCKING_READS.has(reasonCode) ? { granted: false, reasonCode } : unreadable;
  } catch {
    return unreadable;
  }
}

/** The provider each harness runs natively (its own sign-in), pinned in code. */
const NATIVE_PROVIDER: Readonly<Record<string, string>> = Object.freeze({ claude: 'anthropic', codex: 'openai', antigravity: 'google' });

/**
 * The providers a harness session is signed in to, for OD-4's default: the harness's native
 * provider, plus the provider of the model the session is running when the registry resolves it
 * on that harness. Advice uses it so it passes the same consent gate as actuation (MEDIUM 9).
 */
export function sessionSignedInProviders(registry: ModelRegistry, harness: string | null, sessionModel: string | null): readonly string[] {
  const out = new Set<string>();
  if (harness !== null && Object.hasOwn(NATIVE_PROVIDER, harness)) out.add(NATIVE_PROVIDER[harness] as string);
  if (sessionModel !== null) {
    // The one resolver (8c1f85d): the harness's own spelling on a known harness, else any
    // harness's or the registry's own id. A gateway or third-party id signs in no provider.
    const model = resolveHarnessModel(registry, sessionModel, harness);
    if (model !== null) out.add(model.provider);
  }
  return [...out].sort();
}

/** No stored consent to read: every provider falls back to OD-4's signed-in default. */
export const NO_STORED_CONSENT: ProviderConsentReader = () => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' });

export function providerConsentGate(
  registry: Pick<ModelRegistry, 'entries'>,
  signedInProviders: readonly string[],
  read: ProviderConsentReader,
): ProviderConsentGate {
  const signedIn = new Set(signedInProviders);
  const marked = new Set(registry.entries.filter((e) => e.requiresProviderConsent === true || !signedInDefaultAllowed(e.provider)).map((e) => e.provider));
  const providers = [...new Set(registry.entries.map((e) => e.provider))].sort();
  const consentedProviders: string[] = [];
  const blocked: { provider: string; reasonCode: string }[] = [];
  for (const provider of providers) {
    const stored = safeRead(read, provider);
    if (stored.granted) {
      consentedProviders.push(provider);
    } else if (BLOCKING_READS.has(stored.reasonCode)) {
      blocked.push({ provider, reasonCode: stored.reasonCode });
    } else if (marked.has(provider)) {
      blocked.push({ provider, reasonCode: PROVIDER_CONSENT_REQUIRED });
    } else if (signedIn.has(provider)) {
      consentedProviders.push(provider);
    } else {
      blocked.push({ provider, reasonCode: PROVIDER_CONSENT_REQUIRED });
    }
  }
  return { consentedProviders, blocked };
}

// ---------------------------------------------------------------------------------------------
// Serving hosts R45 (design 5.1; owner decisions c8e933d, OQ-3; B's MEDIUM 19): consent per
// (host, maker) pair. A party is a maker or a pinned serving host; each has its own row in the same
// store, and the pair is evaluated here, never stored.

/** A route through a host whose own consent does not allow it (missing, not signed in, or no text). */
export const HOST_CONSENT_REQUIRED = 'HOST_CONSENT_REQUIRED';
/**
 * A route through a host whose consent, or a host it forwards to, reads as revoked, stale or
 * unreadable. A read that cannot be trusted is not consent.
 */
export const HOST_CONSENT_REVOKED = 'HOST_CONSENT_REVOKED';

export type PartyConsent = { readonly allowed: true } | { readonly allowed: false; readonly reasonCode: string };

/**
 * One pinned serving host's standing, with the maker precedence (design 5.1):
 * 1. a revoke, a stale grant or an unreadable read blocks (HOST_CONSENT_REVOKED);
 * 2. a host with no consent text (NVIDIA, OQ-2) is never allowed, even with a stored grant;
 * 3. a current grant allows;
 * 4. an always-required host blocks without a grant (none is, today: OQ-3);
 * 5. otherwise a signed-in host allows and any other blocks (HOST_CONSENT_REQUIRED).
 * An id that is not a pinned host is never allowed. A read is one answer (a grant or a reason), so
 * 1 and 3 cannot both hold; 2 comes before 3 so a grant can never outlive a withdrawn text.
 */
export function hostConsent(servingHost: string, signedInParties: readonly string[], read: ProviderConsentReader): PartyConsent {
  if (servingHostOf(servingHost) === undefined) return { allowed: false, reasonCode: HOST_CONSENT_REQUIRED };
  const stored = safeRead(read, servingHost);
  if (!stored.granted && BLOCKING_READS.has(stored.reasonCode)) return { allowed: false, reasonCode: HOST_CONSENT_REVOKED };
  const text = Object.hasOwn(SERVING_HOST_CONSENT_TEXT, servingHost) && !Object.hasOwn(PROVIDER_CONSENT_TEXT, servingHost) ? SERVING_HOST_CONSENT_TEXT[servingHost] : undefined;
  if (text === undefined) return { allowed: false, reasonCode: HOST_CONSENT_REQUIRED };
  if (stored.granted) return { allowed: true };
  if (text.alwaysRequired) return { allowed: false, reasonCode: HOST_CONSENT_REQUIRED };
  return signedInParties.includes(servingHost) ? { allowed: true } : { allowed: false, reasonCode: HOST_CONSENT_REQUIRED };
}

/**
 * B's MEDIUM 19: the pinned hosts a route through `servingHost` also reaches (its `forwardsTo`, and
 * theirs), each blocking when it reads as revoked, stale or unreadable. No grant is needed for them:
 * the host's own text discloses the forwarding. Returns the first blocked one, or null.
 */
export function blockedDownstream(servingHost: string, read: ProviderConsentReader): string | null {
  const seen = new Set<string>([servingHost]);
  const queue = [...(servingHostOf(servingHost)?.forwardsTo ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const stored = safeRead(read, next);
    if (!stored.granted && BLOCKING_READS.has(stored.reasonCode)) return next;
    queue.push(...(servingHostOf(next)?.forwardsTo ?? []));
  }
  return null;
}

/** A route's parties: the maker, and the host that receives the request (the maker itself when direct). */
export interface RouteParties {
  readonly provider: string;
  readonly servingHost: string;
  readonly via: 'maker' | 'host';
}

export type RouteConsent =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reasonCode: string;
      /** The party that blocks: the maker, the host, or a host it forwards to. */
      readonly party: string;
      /** The blocking party is a host this route's host forwards to (B's MEDIUM 19). */
      readonly downstream: boolean;
    };

/**
 * Design 5.1: a direct route needs the maker; a route through a host needs the maker, the host and
 * no block on any host it forwards to. The maker is judged by `providerConsentGate` (with the
 * registry's marks and the pinned always-required makers, unchanged whichever host serves it). The
 * first blocking party is named, in that order: maker, host, downstream.
 */
export function routeConsentGate(
  registry: Pick<ModelRegistry, 'entries'>,
  signedInParties: readonly string[],
  read: ProviderConsentReader,
  route: RouteParties,
): RouteConsent {
  const makers = providerConsentGate(registry, signedInParties, read);
  if (!makers.consentedProviders.includes(route.provider)) {
    const reasonCode = makers.blocked.find((b) => b.provider === route.provider)?.reasonCode ?? PROVIDER_CONSENT_REQUIRED;
    return { allowed: false, reasonCode, party: route.provider, downstream: false };
  }
  if (route.via === 'maker') {
    // A direct route's host is its maker; anything else is not a direct route.
    return route.servingHost === route.provider ? { allowed: true } : { allowed: false, reasonCode: HOST_CONSENT_REQUIRED, party: route.servingHost, downstream: false };
  }
  const host = hostConsent(route.servingHost, signedInParties, read);
  if (!host.allowed) return { allowed: false, reasonCode: host.reasonCode, party: route.servingHost, downstream: false };
  const downstream = blockedDownstream(route.servingHost, read);
  if (downstream !== null) return { allowed: false, reasonCode: HOST_CONSENT_REVOKED, party: downstream, downstream: true };
  return { allowed: true };
}
