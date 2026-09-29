/**
 * Owned workers through a pinned serving host (serving hosts R52; design
 * `.planning/research/serving-hosts.md` 3.4, 4.3, 5.1).
 *
 * - A host spelling from the resolver (`openrouter/moonshotai/kimi-k3`) names the maker behind it,
 *   so the dispatching port (`workers.ts`) knows whose model runs and whose consent it needs.
 * - The dispatching port runs a host route as the registry model plus `servingHost`. F's OpenCode and
 *   Kilo ports spell it on the host (`harnessModelChoice`) and refuse WORKER_HOST_UNSPELLED rather
 *   than fall back to the maker's spelling. A host route runs only on a harness with a
 *   `harnessHosts` row for the host and a spelling of the model there.
 * - Consent is per (host, maker) pair (core `routeConsentGate`): the maker, the host, and no block on
 *   a host it forwards to. A gateway sign-in signs in the gateway, never the maker behind it.
 * - The sign-in comes from the harness's row's `signIns`. OpenRouter is an API key, which the run
 *   reads only from the environment (F's port hides the harness's stored logins from an api-key run);
 *   the Kilo Gateway is Kilo's own sign-in, a stored login line under `kilo`.
 * - `ownedWorkerSpelling` picks the host by design 4.3: the linked session's host, else the one host
 *   this harness was seen using for the model, else advice only (core `spellTarget`).
 *
 * Nothing here runs until a caller passes a host: task-ops passing the route's `servingHost` is held
 * for the owner (D STATUS, "held for the owner"), so C's `hostTariffGuard` stays dormant too.
 */
import { servingHostOf, type HarnessId, type ModelRegistry } from '@jevris/contracts';
import { resolveSpelling, seenSpellings, spellOnHost, spellTarget, type ModelOffer, type TargetSpelling } from '@jevris/core';
import { getSession, listSessionLinks, type OpenStoreResult } from '@jevris/store';
import type { StoredCredential, WorkerAuthMode, WorkerAuthSetting, WorkerAuthSource, WorkerHarness } from './worker-auth.js';

/** A route through a pinned host with nothing that signs the harness in to the host. */
export const HOST_NO_LOGIN = 'HOST_NO_LOGIN';
/** A route through a host that this harness does not reach, or not with the declared sign-in. */
export const HOST_NOT_ON_HARNESS = 'HOST_NOT_ON_HARNESS';
/** A host route named with a host Jevris does not pin, or a model the registry does not list. */
export const HOST_ROUTE_UNKNOWN = 'HOST_ROUTE_UNKNOWN';

/**
 * The key variable a harness reads for a pinned host (models.dev's provider entries, which OpenCode
 * and Kilo load). The Kilo Gateway is a login, not a key. NVIDIA has no sourced variable and no
 * consent text, so it is never routed.
 */
export const HOST_KEY_VARS: { readonly [host: string]: readonly string[] } = Object.freeze({ openrouter: Object.freeze(['OPENROUTER_API_KEY']) });

/** The harness id core's resolver takes, for the two harnesses that reach a pinned host. */
export function hostHarnessId(harness: WorkerHarness): HarnessId | null {
  return harness === 'opencode' ? 'opencode' : harness === 'kilo' ? 'kilocode' : null;
}

/** A run through a pinned serving host: the maker's registry model and the host. */
export interface HostRoute {
  readonly provider: string;
  readonly modelId: string;
  readonly servingHost: string;
}

/**
 * The host route a spelling names on a harness that reaches pinned hosts (OpenCode first, then
 * Kilo), or null: a maker spelling, a registry id, or a spelling no pinned host resolves.
 */
export function hostRouteOfSpelling(registry: ModelRegistry, model: string): HostRoute | null {
  if (!model.includes('/')) return null;
  for (const harness of ['opencode', 'kilocode'] as const) {
    const r = resolveSpelling(registry, harness, model);
    if (r !== null && r.via === 'host') return { provider: r.provider, modelId: r.modelId, servingHost: r.servingHost };
  }
  return null;
}

/**
 * A run's host route from its input: the registry model plus `servingHost` (what task-ops will pass),
 * else a host spelling in `model`. Null for a maker route. HOST_ROUTE_UNKNOWN when `servingHost`
 * names no pinned host or the model is not exactly one registry entry.
 */
export function hostRouteOfRun(registry: ModelRegistry, model: string, servingHost: string | undefined): HostRoute | null | typeof HOST_ROUTE_UNKNOWN {
  if (servingHost === undefined) return hostRouteOfSpelling(registry, model);
  if (servingHostOf(servingHost) === undefined) return HOST_ROUTE_UNKNOWN;
  // The model is the registry id, optionally with its maker prefix (`moonshot/kimi-k3`).
  const cut = model.indexOf('/');
  const prefix = cut > 0 ? model.slice(0, cut) : undefined;
  const bare = cut > 0 ? model.slice(cut + 1) : model;
  const listed = registry.entries.filter((e) => e.modelId === bare && (prefix === undefined || e.provider === prefix));
  if (listed.length !== 1 || listed[0] === undefined) return HOST_ROUTE_UNKNOWN;
  return { provider: listed[0].provider, modelId: listed[0].modelId, servingHost };
}

/** Whether `harness` can run the model through the host: its row for the host and a spelling there. */
export function hostReachable(registry: ModelRegistry, harness: WorkerHarness, route: HostRoute): boolean {
  const id = hostHarnessId(harness);
  if (id === null || servingHostOf(route.servingHost) === undefined) return false;
  return spellOnHost(registry, id, route.servingHost, route.provider, route.modelId) !== null;
}

/** The sign-ins through which `harness` reaches the host (its `harnessHosts` row); empty when none. */
export function hostSignIns(registry: ModelRegistry, harness: WorkerHarness, servingHost: string): readonly string[] {
  const id = hostHarnessId(harness);
  if (id === null) return [];
  return (registry.harnessHosts ?? []).find((row) => row.harness === id && row.host === servingHost)?.signIns ?? [];
}

/** A stored credential line that is the host's own (`kilo`, `Kilo Gateway`, `openrouter`). */
function isHostCredential(credential: StoredCredential, servingHost: string): boolean {
  const name = credential.provider.trim().toLowerCase();
  return name === servingHost || name.startsWith(`${servingHost} `) || name.startsWith(`${servingHost}-`);
}

export type ResolvedHostAuth =
  | { readonly ok: true; readonly mode: WorkerAuthMode; readonly source: WorkerAuthSource }
  | { readonly ok: false; readonly mode: WorkerAuthMode; readonly source: WorkerAuthSource; readonly reasonCode: string; readonly reason: string };

/**
 * The sign-in of a run through a pinned host, from the harness's row for it (never the maker's
 * rule: the host, not the maker, receives the request). `stored` is the harness's credential list
 * (null: unreadable).
 * - A declared mode must be one the row allows (HOST_NOT_ON_HARNESS otherwise).
 * - api-key (OpenRouter): the host's key variable in the environment (`environment`, or `declared`
 *   when declared). A key stored in the harness does not count: F's port hides stored logins from an
 *   api-key run.
 * - subscription (the Kilo Gateway): a stored login line for the host (`stored-login`, or `declared`
 *   when declared); an unreadable list is an assumed login (`undetected`), as for makers.
 * - Nothing held: refused before launch (HOST_NO_LOGIN).
 */
export function resolveHostAuth(
  registry: ModelRegistry,
  harness: WorkerHarness,
  servingHost: string,
  setting: WorkerAuthSetting | undefined,
  env: { readonly [key: string]: string | undefined },
  stored: readonly StoredCredential[] | null,
): ResolvedHostAuth {
  const signIns = hostSignIns(registry, harness, servingHost);
  const declared = setting === 'api-key' || setting === 'subscription';
  const vars = HOST_KEY_VARS[servingHost] ?? [];
  const refuse = (reasonCode: string, reason: string, mode: WorkerAuthMode, source: WorkerAuthSource): ResolvedHostAuth => ({ ok: false, mode, source, reasonCode, reason });
  const noLogin = (mode: WorkerAuthMode): ResolvedHostAuth => {
    const how = mode === 'subscription' ? `sign in to ${servingHost} in ${harness}` : vars.length > 0 ? `set ${vars.join(' or ')}` : `${servingHost} has no key variable Jevris knows`;
    return refuse(HOST_NO_LOGIN, `${HOST_NO_LOGIN}: ${harness} holds no ${servingHost} ${mode === 'subscription' ? 'sign-in' : 'API key'}; ${how}`, mode, declared ? 'declared' : 'nothing-stored');
  };
  if (signIns.length === 0) return refuse(HOST_NOT_ON_HARNESS, `${HOST_NOT_ON_HARNESS}: ${harness} does not reach ${servingHost}`, declared ? setting : 'api-key', declared ? 'declared' : 'nothing-stored');
  if (declared && !signIns.includes(setting)) {
    return refuse(HOST_NOT_ON_HARNESS, `${HOST_NOT_ON_HARNESS}: ${harness} reaches ${servingHost} only with ${signIns.join(' or ')}, not the declared ${setting}`, setting, 'declared');
  }
  const keyHeld = vars.some((name) => (env[name] ?? '') !== '');
  const mine = stored === null ? null : stored.filter((c) => isHostCredential(c, servingHost));
  if (setting === 'api-key') return keyHeld ? { ok: true, mode: 'api-key', source: 'declared' } : noLogin('api-key');
  if (setting === 'subscription') return mine === null || mine.some((c) => c.type === 'oauth') ? { ok: true, mode: 'subscription', source: 'declared' } : noLogin('subscription');
  if (signIns.includes('api-key') && keyHeld) return { ok: true, mode: 'api-key', source: 'environment' };
  if (signIns.includes('subscription')) {
    if (mine === null) return { ok: true, mode: 'subscription', source: 'undetected' };
    if (mine.some((c) => c.type === 'oauth')) return { ok: true, mode: 'subscription', source: 'stored-login' };
  }
  return noLogin(signIns.includes('api-key') ? 'api-key' : 'subscription');
}

/**
 * The environment of a run through a pinned host (B's LOW 36): only the host receives the request,
 * so the only provider key the child may see is the host's own, in api-key mode. Every provider key
 * variable Jevris knows (`providerKeyVars`: the maker's and every other maker's) and every other
 * host's key is dropped, so the harness cannot fall back to another configured provider and the
 * worker's tools never see a key the run does not need. A subscription run (the Kilo Gateway's own
 * sign-in) gets no provider or host key at all.
 */
export function hostEnv(route: HostRoute, mode: WorkerAuthMode, providerKeyVars: readonly string[], env: { readonly [key: string]: string | undefined }): { [key: string]: string | undefined } {
  const out: { [key: string]: string | undefined } = { ...env };
  const keep = mode === 'api-key' ? (HOST_KEY_VARS[route.servingHost] ?? []) : [];
  for (const name of [...providerKeyVars, ...Object.values(HOST_KEY_VARS).flat()]) if (!keep.includes(name)) delete out[name];
  return out;
}

/**
 * Design 4.3's linked session for an owned worker: the model of the newest live session linked to
 * the task on the same harness, as that harness spelled it; null when there is none, the store
 * cannot be read, or the session has reported no model. A session on another harness spells for
 * that harness, so it names no host here.
 */
export function linkedSessionModel(store: OpenStoreResult | undefined, taskId: string, harness: WorkerHarness): string | null {
  const read = linkedSessionRead(store, taskId, harness);
  return read.ok ? read.model : null;
}

/**
 * `linkedSessionModel`, telling a read that failed apart from no link (B's LOW 44): a route that
 * would go through the linked session's host must fail closed when the link cannot be read, never
 * run direct at the maker. No store (rules-only) is no link.
 */
export function linkedSessionRead(store: OpenStoreResult | undefined, taskId: string, harness: WorkerHarness): { readonly ok: true; readonly model: string | null } | { readonly ok: false } {
  if (store === undefined) return { ok: true, model: null };
  const want = harness === 'kilo' ? new Set(['kilo', 'kilocode']) : new Set<string>([harness]);
  try {
    const links = listSessionLinks(store);
    if (!Array.isArray(links)) return { ok: false };
    for (const link of links) {
      if (link.taskId !== taskId || !want.has(link.harness)) continue;
      const model = getSession(store, link.sessionId)?.actualModel ?? null;
      if (model !== null) return { ok: true, model };
    }
    return { ok: true, model: null };
  } catch {
    return { ok: false };
  }
}

export interface OwnedWorkerSpellingInput {
  readonly registry: ModelRegistry;
  readonly harness: WorkerHarness;
  readonly target: { readonly provider: string; readonly modelId: string };
  /** The linked session's model exactly as its harness spelled it (`linkedSessionModel`); null with no link. */
  readonly sessionModel: string | null;
  /** The machine's model offer (C's `readModelOffer`); null when unreadable. */
  readonly offer: ModelOffer | null;
  /** Whether a pinned host passes consent for this pair (R45); default: none does. */
  readonly hostAllowed?: (servingHost: string) => boolean;
  /** Whether the target is eligible here (listed or ran here), for a v1 offer with no spellings. */
  readonly eligibleHere?: boolean;
}

/**
 * Design 4.3 for an owned worker (core `spellTarget` with host routes on): the linked session's
 * host when it serves the model; else the one host this harness was seen using for it, when that
 * host is allowed and priced; else a refusal that is advice only (NOT_ON_SESSION_HOST, with the
 * hosts seen). On a harness that names no host segments the maker's spelling stands.
 */
export function ownedWorkerSpelling(input: OwnedWorkerSpellingInput): TargetSpelling {
  const id: HarnessId = input.harness === 'kilo' ? 'kilocode' : input.harness;
  return spellTarget({
    registry: input.registry,
    harness: id,
    target: input.target,
    sessionModel: input.sessionModel,
    seen: seenSpellings(input.offer, { harness: id }, input.target.modelId),
    eligibleHere: input.eligibleHere ?? false,
    hostRoutes: true,
    ...(input.hostAllowed === undefined ? {} : { hostAllowed: input.hostAllowed }),
  });
}
