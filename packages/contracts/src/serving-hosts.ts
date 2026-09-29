/**
 * The serving hosts Jevris recognises (serving-hosts design 3.2, R35; owner decisions 8c1f85d and
 * c8e933d). A serving host is the service that receives a request for a model: the maker's own API,
 * a gateway that forwards to a downstream provider it chooses, or an inference host that runs the
 * weights itself. In code it is always a `servingHost`: "host" alone already means a machine.
 *
 * - Pinned in code, as the provider id aliases are (security review HIGH 5). A placed registry may
 *   name these hosts in `servings` and `harnessHosts`, never add one.
 * - Maker hosts are not listed: each maker id (`PROVIDER_IDS`) is its own host. Every id here is a
 *   gateway or an inference host, and none is a maker id (a test pins the two lists disjoint), so a
 *   consent row keyed by a host id can never be read as a maker's.
 * - Recognised but not pinned (OpenCode Zen, Vercel, Together, Fireworks, DeepInfra, Bedrock,
 *   Baseten, ZenMux) stay unregistered and fail closed until each has its own review and text
 *   (OQ-7).
 * - A host here is not a consent: a route through one still needs the host's and the maker's
 *   consent, and a host with no consent text (NVIDIA, OQ-2) is never routed to.
 */
import type { HarnessId } from './primitives.js';

/** A serving host's kind: the maker's own API, a forwarding gateway, or a host that runs the weights. */
export const SERVING_HOST_KINDS = ['maker', 'gateway', 'inference-host'] as const;
export type ServingHostKind = (typeof SERVING_HOST_KINDS)[number];

/** The pinned non-maker hosts, in the order the design lists them. */
export const SERVING_HOST_IDS = ['openrouter', 'kilo', 'nvidia'] as const;
export type ServingHostId = (typeof SERVING_HOST_IDS)[number];

export interface ServingHost {
  readonly id: ServingHostId;
  /** Never `maker`: a maker is its own host and is not listed. */
  readonly kind: Exclude<ServingHostKind, 'maker'>;
  /** The first segment of a harness spelling that reaches this host, per harness that has one. */
  readonly segments: Readonly<Partial<Record<HarnessId, string>>>;
  /**
   * The other pinned hosts this host passes what you send to (B's MEDIUM 19; T-R3 as amended covers
   * a gateway's downstream provider). A route through this host is blocked whenever any host here
   * is blocked (revoked, stale or unreadable); no grant is needed for them, because this host's
   * consent text discloses the forwarding. Empty when it forwards to no pinned host.
   */
  readonly forwardsTo: readonly ServingHostId[];
}

/**
 * Frozen, and so is every entry and its segments. From Kilo's and OpenCode's own provider lists
 * (serving-hosts design 3.2): OpenRouter on both, the Kilo Gateway on Kilo only, NVIDIA on both.
 */
export const SERVING_HOSTS: readonly ServingHost[] = Object.freeze([
  Object.freeze({ id: 'openrouter', kind: 'gateway', segments: Object.freeze({ kilocode: 'openrouter', opencode: 'openrouter' }), forwardsTo: Object.freeze([]) }),
  // The Kilo Gateway "forwards each request to OpenRouter" (its consent text, R40).
  Object.freeze({ id: 'kilo', kind: 'gateway', segments: Object.freeze({ kilocode: 'kilo' }), forwardsTo: Object.freeze(['openrouter'] as const) }),
  Object.freeze({ id: 'nvidia', kind: 'inference-host', segments: Object.freeze({ kilocode: 'nvidia', opencode: 'nvidia' }), forwardsTo: Object.freeze([]) }),
]);

/** The pinned host with this id; undefined for a maker id or any unpinned host. */
export function servingHostOf(id: string): ServingHost | undefined {
  return SERVING_HOSTS.find((host) => host.id === id);
}

/**
 * A gateway's or inference host's maker slug (the first segment of its model id, as in
 * `openrouter/moonshotai/kimi-k3`) mapped to the registry maker. Pinned, so a registry override
 * cannot relabel one maker's model as another's; the registry check refuses a serving whose slug
 * maps to a different maker than its entry. `deepseek-ai` is NVIDIA's form of DeepSeek.
 */
export const HOST_MAKER_SEGMENTS: { readonly [slug: string]: string } = Object.freeze({
  moonshotai: 'moonshot',
  'z-ai': 'zai',
  'x-ai': 'xai',
  deepseek: 'deepseek',
  'deepseek-ai': 'deepseek',
  google: 'google',
  openai: 'openai',
  anthropic: 'anthropic',
});

/** The registry maker a host's maker slug names; null when the slug is not pinned. */
export function hostMakerOf(slug: string): string | null {
  return Object.hasOwn(HOST_MAKER_SEGMENTS, slug) ? (HOST_MAKER_SEGMENTS[slug] as string) : null;
}
