/**
 * Serving hosts R48 (design 6.3; owner decisions c8e933d, OQ-4): the tariff a model is billed at
 * through a serving host, and how well it is known.
 *
 * - Through the maker's own API: the entry's tariff, basis `host`.
 * - Through a pinned host with a snapshot tariff (`tariffBasis: 'host'`): that tariff, basis `host`.
 * - Anything else (a host with an unknown or free-tier price, or no serving): the maker's list
 *   price as an estimate, basis `maker-price-estimate`. Arithmetic stays the same; only the label
 *   changes, and no actuator acts on an estimate (HOST_TARIFF_UNKNOWN).
 */
import { servingHostOf, type ModelRegistry, type Tariff } from '@jevris/contracts';
import { registryModel } from './model-registry.js';

export const SERVING_TARIFF_BASES = ['host', 'maker-price-estimate'] as const;
export type ServingTariffBasis = (typeof SERVING_TARIFF_BASES)[number];

/** An actuator's abstention when the target's tariff on the route's host is not known (design 6.3). */
export const HOST_TARIFF_UNKNOWN = 'HOST_TARIFF_UNKNOWN';

export interface ServingTariff {
  readonly tariff: Tariff;
  readonly basis: ServingTariffBasis;
}

/** The tariff for `modelId` through `servingHost`; null when the registry has no such entry. */
export function servingTariff(registry: Pick<ModelRegistry, 'entries' | 'servings'>, servingHost: string, provider: string, modelId: string): ServingTariff | null {
  const entry = registryModel(registry as ModelRegistry, modelId, provider);
  if (entry === null) return null;
  if (servingHost === provider) return { tariff: entry.tariff, basis: 'host' };
  const matches = (registry.servings ?? []).filter((s) => s.host === servingHost && s.provider === provider && s.modelId === modelId && s.tariffBasis === 'host' && s.tariff !== null);
  // Two host tariffs for one model on one host (two host model ids) are not one known price.
  if (matches.length === 1 && matches[0]?.tariff !== null && matches[0]?.tariff !== undefined) return { tariff: matches[0].tariff, basis: 'host' };
  return { tariff: entry.tariff, basis: 'maker-price-estimate' };
}

/** Whether an actuator may act on this model through this host: its tariff there is known (OQ-4). */
export function servingTariffKnown(registry: Pick<ModelRegistry, 'entries' | 'servings'>, servingHost: string, provider: string, modelId: string): boolean {
  return servingTariff(registry, servingHost, provider, modelId)?.basis === 'host';
}

/** One side of a route for the tariff guard: a model and the host its request goes to. */
export interface PricedLeg {
  /** The route's serving host: a pinned host prices the model there; a maker id, null or absent, its own maker. */
  readonly servingHost?: string | null;
  readonly provider?: string;
  /** Null or absent: no model on this side (nothing to check). */
  readonly modelId?: string | null;
}

/**
 * Serving hosts R50 (design 6.3, OQ-4; B's condition): the one guard every actuator calls before it
 * acts (route.turn, the subagent route, an owned worker's launch). It refuses with
 * HOST_TARIFF_UNKNOWN when any side (the choice or the baseline it is weighed against) is priced
 * only by the maker's list price as an estimate: named in the router's `costEstimates`, or with no
 * known tariff on its host. Per side (B's LOW 33, fail closed):
 * - no host, or a maker id (the model's own, or another maker's API, which the router reads as the
 *   model's own maker): the entry's own tariff;
 * - a pinned serving host: its snapshot tariff for the model, which must be known;
 * - any other host string: refused, never priced as if direct;
 * - a pinned host with a model the registry does not list: refused.
 * A model the registry does not list, with no host, is left to the caller's own checks.
 * Advice may still name the route, labelled `maker-price-estimate`; only acting on it is refused.
 */
export function hostTariffGuard(registry: Pick<ModelRegistry, 'entries' | 'servings'>, legs: readonly PricedLeg[], costEstimates: readonly string[] = []): typeof HOST_TARIFF_UNKNOWN | null {
  const makers = new Set(registry.entries.map((e) => e.provider));
  for (const leg of legs) {
    const modelId = leg.modelId ?? null;
    if (modelId === null) continue;
    if (costEstimates.includes(modelId)) return HOST_TARIFF_UNKNOWN;
    const host = leg.servingHost ?? null;
    const pinned = host !== null && servingHostOf(host) !== undefined;
    if (host !== null && !pinned && !makers.has(host)) return HOST_TARIFF_UNKNOWN;
    const entry = registryModel(registry as ModelRegistry, modelId, leg.provider);
    if (entry === null) {
      if (pinned) return HOST_TARIFF_UNKNOWN;
      continue;
    }
    if (!servingTariffKnown(registry, pinned ? (host as string) : entry.provider, entry.provider, entry.modelId)) return HOST_TARIFF_UNKNOWN;
  }
  return null;
}
