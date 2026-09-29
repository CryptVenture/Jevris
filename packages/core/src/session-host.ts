/**
 * Serving hosts R44 (design 4.3 and 4.4; owner decisions 8c1f85d and c8e933d, OQ-1): the session's
 * host and the spelling a route writes for its target.
 *
 * Let H be the session's host (the resolver's `servingHost` for the session's own spelling) and T
 * the target model.
 * 1. H serves T and a spelling of T on H is seen on this harness: write it. A same-maker route keeps
 *    the session's own maker endpoint segment (phase 1) without new evidence, and an effort-only
 *    change keeps the session's exact spelling.
 * 2. Otherwise exactly one host H' has been seen serving T on this harness, H' is allowed and its
 *    tariff for T is known: write the one spelling seen there (OQ-1: the host changes, and explain
 *    says so).
 * 3. Otherwise abstain: NOT_ON_SESSION_HOST. Choosing among hosts is advice only.
 * A session spelling the resolver cannot read gives no host, and every route from it abstains
 * (HOST_UNKNOWN), as in phase 1.
 *
 * `hostRoutes` switches on routes that involve a pinned serving host (a gateway or inference host) on
 * either side. It stays off until the per-pair consent gate (R45) and the `route.host` feature gate
 * are in place, so until then the answers are phase 1's, maker hosts only.
 */
import type { HarnessId, ModelRegistry } from '@jevris/contracts';
import { harnessModelId, resolveSpelling, spellingsOnHost, type ResolvedSpelling } from './harness-model-id.js';
import { servingTariffKnown } from './serving-tariff.js';
import type { ModelOffer, SeenSpelling } from './model-offer.js';

// R48: the serving tariff lives in serving-tariff.ts and is exported through this module.
export { HOST_TARIFF_UNKNOWN, SERVING_TARIFF_BASES, hostTariffGuard, servingTariff, servingTariffKnown, type PricedLeg, type ServingTariff, type ServingTariffBasis } from './serving-tariff.js';

export interface SpellTargetInput {
  readonly registry: ModelRegistry;
  readonly harness: HarnessId;
  readonly target: { readonly provider: string; readonly modelId: string };
  /** The session's model exactly as the harness spells it; null when unknown (an owned worker with no link). */
  readonly sessionModel: string | null;
  /** The spellings of T seen on this harness (`seenSpellings`): listed, or a run's reported spelling. */
  readonly seen: readonly SeenSpelling[];
  /**
   * T is locally eligible here (listed or ran here). Used only when no spelling of T was recorded at
   * all, which is what a v1 model offer gives: its runs and listings named direct spellings only
   * (design 4.1). A recorded spelling that no longer resolves never falls back (B's LOW 20).
   */
  readonly eligibleHere: boolean;
  /** Routes that involve a pinned serving host on either side. Default false (phase 1 answers). */
  readonly hostRoutes?: boolean;
  /** Whether a pinned serving host passes consent (R45). Consulted only with `hostRoutes`; default: none does. */
  readonly hostAllowed?: (servingHost: string) => boolean;
}

export type TargetSpelling =
  | {
      readonly ok: true;
      /** The harness spelling to write. */
      readonly id: string;
      readonly servingHost: string;
      readonly via: 'maker' | 'host';
      /** Which rule wrote it: 1 keeps the session's host, 2 is OQ-1's one other host seen. */
      readonly rule: 1 | 2;
      /** The written host is not the session's host. */
      readonly hostChanged: boolean;
      /** A pinned serving host is on either side: gated by `route.host`, not only `session.route`. */
      readonly hostRoute: boolean;
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'NOT_ON_HARNESS' | 'HOST_UNKNOWN' | 'NOT_ON_SESSION_HOST';
      /** Where T has been seen on this harness, for advice ("seen through openrouter"). */
      readonly seenHosts: readonly string[];
    };

/** The session's host: the resolver's answer for its own spelling, or null when it cannot be read. */
export function sessionHost(registry: ModelRegistry, harness: HarnessId, sessionModel: string | null): ResolvedSpelling | null {
  return sessionModel === null ? null : resolveSpelling(registry, harness, sessionModel);
}


function endpointSegment(raw: string): string | null {
  const id = raw.endsWith('[1m]') ? raw.slice(0, -'[1m]'.length) : raw;
  const cut = id.indexOf('/');
  return cut > 0 && id.lastIndexOf('/') === cut ? id.slice(0, cut) : null;
}

export function spellTarget(input: SpellTargetInput): TargetSpelling {
  const { registry, harness, target } = input;
  const hostRoutes = input.hostRoutes === true;
  const allowed = (host: string): boolean => host === target.provider || (hostRoutes && (input.hostAllowed?.(host) ?? false));
  // Seen spellings are re-read through today's registry: a stored host is evidence, not authority.
  const seen = input.seen
    .map((s) => resolveSpelling(registry, harness, s.raw))
    .filter((r): r is ResolvedSpelling => r !== null && r.provider === target.provider && r.modelId === target.modelId);
  const seenHosts = [...new Set(seen.map((r) => r.servingHost))].sort();
  const refuse = (reasonCode: 'NOT_ON_HARNESS' | 'HOST_UNKNOWN' | 'NOT_ON_SESSION_HOST'): TargetSpelling => ({ ok: false, reasonCode, seenHosts });

  const direct = harnessModelId(registry, harness, target.modelId, target.provider);
  const reachable = direct !== null || (hostRoutes && (registry.servings ?? []).some((s) => s.provider === target.provider && s.modelId === target.modelId && spellingsOnHost(registry, harness, s.host, s.provider, s.modelId).length > 0));
  if (!reachable) return refuse('NOT_ON_HARNESS');
  // A harness that names models with no provider segment (Claude Code, Codex, Antigravity) names no host.
  if (direct !== null && !direct.includes('/')) return { ok: true, id: direct, servingHost: target.provider, via: 'maker', rule: 1, hostChanged: false, hostRoute: false };

  const session = sessionHost(registry, harness, input.sessionModel);
  // An unreadable session spelling (a gateway or host Jevris does not know) gives no host: fail closed.
  if (input.sessionModel !== null && session === null) return refuse('HOST_UNKNOWN');
  if (session !== null && session.via === 'host' && !hostRoutes) return refuse('HOST_UNKNOWN');
  const write = (id: string, servingHost: string, via: 'maker' | 'host', rule: 1 | 2): TargetSpelling => ({
    ok: true,
    id,
    servingHost,
    via,
    rule,
    hostChanged: session !== null && servingHost !== session.servingHost,
    hostRoute: via === 'host' || session?.via === 'host',
  });

  if (session !== null) {
    // An effort-only change: the exact spelling the session runs.
    if (session.provider === target.provider && session.modelId === target.modelId) return write(session.raw, session.servingHost, session.via, 1);
    const onSession = spellingsOnHost(registry, harness, session.servingHost, target.provider, target.modelId);
    if (onSession.length > 0 && allowed(session.servingHost)) {
      // Phase 1 (8c1f85d): the same maker through the session's own endpoint segment.
      const segment = session.via === 'maker' ? endpointSegment(session.raw) : null;
      const kept = segment === null ? null : onSession.find((s) => endpointSegment(s) === segment);
      if (kept !== undefined && kept !== null) return write(kept, session.servingHost, session.via, 1);
      const seenThere = onSession.filter((s) => seen.some((r) => r.raw === s));
      if (seenThere.length === 1) return write(seenThere[0] as string, session.servingHost, session.via, 1);
    }
  }

  // Rule 2 (OQ-1): exactly one host seen serving T here, allowed, with a known tariff.
  if (seenHosts.length === 1) {
    const other = seenHosts[0] as string;
    if (other !== session?.servingHost && allowed(other) && servingTariffKnown(registry, other, target.provider, target.modelId)) {
      const there = [...new Set(seen.filter((r) => r.servingHost === other).map((r) => r.raw))];
      if (there.length === 1) {
        const via = other === target.provider ? 'maker' : 'host';
        return write(there[0] as string, other, via, 2);
      }
    }
    return refuse('NOT_ON_SESSION_HOST');
  }
  // A v1 model offer names no spelling: the maker's one spelling, when T is eligible here (phase 1).
  // Only when nothing was recorded: a v2 spelling that no longer resolves is not a v1 offer (B's LOW 20).
  if (input.seen.length === 0 && input.eligibleHere) {
    const maker = spellingsOnHost(registry, harness, target.provider, target.provider, target.modelId);
    if (maker.length === 1 && servingTariffKnown(registry, target.provider, target.provider, target.modelId)) return write(maker[0] as string, target.provider, 'maker', 2);
  }
  return refuse('NOT_ON_SESSION_HOST');
}

/**
 * Design 4.4: the parties a harness session is signed in to, for OD-4's default: the harness's
 * native maker, the session spelling's serving host and, for a direct spelling, its maker. A gateway
 * session signs in the gateway, never the maker behind it.
 */
export function sessionSignedInParties(registry: ModelRegistry, harness: HarnessId | null, sessionModel: string | null, nativeMaker: string | null): readonly string[] {
  const out = new Set<string>();
  if (nativeMaker !== null) out.add(nativeMaker);
  const session = harness === null ? null : sessionHost(registry, harness, sessionModel);
  if (session !== null) out.add(session.servingHost);
  return [...out].sort();
}

/**
 * Design 4.4 (c065d52 extended): the parties a harness on this machine has run a model through
 * (RAN_HERE). A v2 run's spelling is re-read through today's registry, as `spellTarget` reads seen
 * spellings, and names its serving host: a run through a pinned host names that host, never the
 * maker behind it, and a spelling that no longer resolves names nothing. A v1 run (no spelling
 * recorded) was a direct spelling (design 4.1), so it names the maker. A run whose model the
 * registry does not list names nothing.
 */
export function ranHereParties(registry: ModelRegistry, offer: ModelOffer | null): readonly string[] {
  if (offer === null) return [];
  const out = new Set<string>();
  for (const run of offer.runs) {
    const matches = registry.entries.filter((e) => e.modelId === run.modelId);
    if (matches.length !== 1 || matches[0] === undefined) continue;
    const maker = matches[0].provider;
    if ((run.raw ?? null) === null) {
      out.add(maker);
      continue;
    }
    const back = resolveSpelling(registry, run.harness as HarnessId, run.raw as string);
    if (back !== null && back.provider === maker && back.modelId === run.modelId) out.add(back.servingHost);
  }
  return [...out].sort();
}
