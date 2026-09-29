/**
 * Harness parity audit G20: a model id as a harness reports it, resolved against the registry.
 *
 * - Claude Code reports `claude-opus-5-5` or `claude-opus-5-5[1m]` (the 1M-context variant of the
 *   same model, one registry entry).
 * - Kilo and OpenCode report `providerID/modelID`, and a gateway's modelID can itself carry a
 *   provider (`openrouter/anthropic/claude-opus-5-5`), so up to two prefix segments are read.
 * - The segment nearest the model names its provider for the registry lookup. A harness's own
 *   provider segment (`moonshotai`, `google-vertex`) maps to the registry provider through the
 *   access rows' `providerIds` (R2).
 * - `harnessModelId`, `registryModelOf` and `harnessEffortToken` map a registry model to a harness's
 *   own spelling and back (routing design R6, R13; agreed with F): a model's `harnessModels` row for
 *   the harness wins, else the access row's `idTemplate` derives it.
 * - One resolver (owner decisions 8c1f85d, a model served by several hosts): `harnessModelRef`
 *   resolves through `registryModelOf` on a known harness (plus the registry's own `id` and
 *   `provider/id`, which name the maker), and through the union of every harness's spellings
 *   otherwise, so the two never disagree on a harness spelling. A gateway or third-party id
 *   (`openrouter/moonshotai/kimi-k3`, `nvidia/kimi-k3`, `kilo/...`) is unregistered on every path
 *   until host support lands: it is never read as the maker's model.
 * - `hostKeptModelId` spells a route target through the host the session already uses (a route
 *   keeps the session's host), never the first provider spelling regardless.
 *
 * Ids only: nothing here reads text or a file.
 */
import type { HarnessAccess, HarnessId, HarnessModel, ModelRegistry, RoutingModel } from '@jevris/contracts';
import { HARNESS_IDS, HARNESS_MODEL_ID_PATTERN } from '@jevris/contracts';
import { providerIdMapsTo, registryModel } from './model-registry.js';

/**
 * A harness model id: up to two lowercase `provider/` segments, a model id, an optional `[1m]`.
 * E's contracts pattern (G20), so core and the wire accept the same ids.
 */
export const HARNESS_MODEL_ID = new RegExp(HARNESS_MODEL_ID_PATTERN);

export interface HarnessModelRef {
  /** The id exactly as the harness reported it. */
  readonly raw: string;
  /** The provider segment nearest the model, or null when there is none. */
  readonly provider: string | null;
  /**
   * The registry model id when the id resolves (`registered`); otherwise the bare model segment,
   * without prefix or `[1m]`, for display only. An unregistered id's bare segment may equal a
   * registry id (a gateway's `openrouter/moonshotai/kimi-k3`): read `registered` before using it
   * as a registry model.
   */
  readonly modelId: string;
  readonly registered: boolean;
}

/**
 * Parses and resolves a harness model id; null when it is not one. On a known harness it resolves
 * exactly as `registryModelOf` does; with no harness, through any harness's spelling (and the
 * registry's own `id` or `provider/id`), when those name exactly one model. A gateway or
 * third-party prefix never resolves.
 */
export function harnessModelRef(registry: ModelRegistry | null, raw: string, harness?: string | null): HarnessModelRef | null {
  if (!HARNESS_MODEL_ID.test(raw)) return null;
  const segments = raw.replace(/\[1m\]$/, '').split('/');
  const bare = segments[segments.length - 1] as string;
  const provider = segments.length > 1 ? (segments[segments.length - 2] as string) : null;
  const model = registry === null ? null : resolveHarnessModel(registry, raw, harness ?? null);
  return { raw, provider, modelId: model === null ? bare : model.modelId, registered: model !== null };
}

function isHarnessId(value: string | null): value is HarnessId {
  return value !== null && (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * The registry's own spellings of a model, its bare `modelId` and `provider/modelId`: they name the
 * maker and never a host other than the maker's, so a gateway id is never one. On a harness they
 * count only where the harness runs that provider (an access row for it).
 */
function registryOwnSpelling(registry: ModelRegistry, raw: string, harness: HarnessId | null): { readonly provider: string; readonly modelId: string } | null {
  const id = raw.replace(/\[1m\]$/, '');
  const matches = registry.entries.filter((e) => (id === e.modelId || id === `${e.provider}/${e.modelId}`) && (harness === null || accessRow(registry, harness, e.provider) !== null)); // path-hygiene: allow a model id (provider/model), not a path
  return matches.length === 1 ? { provider: (matches[0] as RoutingModel).provider, modelId: (matches[0] as RoutingModel).modelId } : null;
}

/**
 * The one resolver (8c1f85d). On a known harness: the harness's own spelling (`registryModelOf`),
 * else the registry's own spelling where the harness runs that provider. With no harness: the one
 * model that any harness's spelling or the registry's own spelling names. Null when none or more
 * than one model matches. A gateway or third-party id is none of these, on every path.
 */
export function resolveHarnessModel(registry: ModelRegistry, raw: string, harness: string | null): { readonly provider: string; readonly modelId: string } | null {
  if (!HARNESS_MODEL_ID.test(raw)) return null;
  if (isHarnessId(harness)) return registryModelOf(registry, harness, raw) ?? registryOwnSpelling(registry, raw, harness);
  const found = new Map<string, { readonly provider: string; readonly modelId: string }>();
  for (const model of [...HARNESS_IDS.map((h) => registryModelOf(registry, h, raw)), registryOwnSpelling(registry, raw, null)]) {
    if (model !== null) found.set(`${model.provider}\u0000${model.modelId}`, model);
  }
  return found.size === 1 ? ([...found.values()][0] ?? null) : null;
}

/** The registry provider a harness's provider segment names: itself, or the provider whose access rows list it. */
export function providerOfSegment(registry: ModelRegistry, segment: string): string {
  if (registry.entries.some((e) => e.provider === segment)) return segment;
  const row = (registry.harnessAccess ?? []).find((r) => (r.providerIds ?? []).includes(segment));
  return row === undefined ? segment : row.provider;
}

function accessRow(registry: ModelRegistry, harness: HarnessId, provider: string): HarnessAccess | null {
  return (registry.harnessAccess ?? []).find((r) => r.harness === harness && r.provider === provider) ?? null;
}

function harnessRow(model: RoutingModel, harness: HarnessId): HarnessModel | null {
  return (model.harnessModels ?? []).find((r) => r.harness === harness) ?? null;
}

/**
 * How `harness` spells the registry model, or null when nothing names it there: the model's own
 * `harnessModels` row wins; else the access row's template, `{id}` or `{provider}/{id}` with the
 * row's first provider segment (else the registry provider).
 */
export function harnessModelId(registry: ModelRegistry, harness: HarnessId, modelId: string, provider?: string): string | null {
  const model = registryModel(registry, modelId, provider);
  if (model === null) return null;
  const own = harnessRow(model, harness);
  if (own !== null) return own.id;
  const row = accessRow(registry, harness, model.provider);
  if (row === null || row.idTemplate === undefined) return null;
  return row.idTemplate === '{id}' ? model.modelId : `${row.providerIds?.[0] ?? model.provider}/${model.modelId}`; // path-hygiene: allow a harness model id (provider/model), not a path
}

/**
 * The registry model a harness's own id names, or null: an exact `harnessModels` id (or one of its
 * effort tokens, which name the same model), else the id with a leading provider segment that the
 * access row accepts (one of its `providerIds`, or the provider), matching exactly one entry.
 * These are the harness's own spellings (what it writes and reports), so an owned run's `--model`
 * is taken from them. A second prefix segment (a gateway) never matches.
 */
export function registryModelOf(registry: ModelRegistry, harness: HarnessId, harnessId: string): { readonly provider: string; readonly modelId: string } | null {
  const exact = registry.entries.filter((e) => {
    const own = harnessRow(e, harness);
    return own !== null && (own.id === harnessId || Object.values(own.efforts ?? {}).includes(harnessId));
  });
  if (exact.length === 1) return { provider: (exact[0] as RoutingModel).provider, modelId: (exact[0] as RoutingModel).modelId };
  if (exact.length > 1) return null;
  const bareId = harnessId.replace(/\[1m\]$/, '');
  const slash = bareId.indexOf('/');
  const candidates = registry.entries.filter((e) => {
    const row = accessRow(registry, harness, e.provider);
    if (row === null || row.idTemplate === undefined) return false;
    if (row.idTemplate === '{id}') return slash < 0 && e.modelId === bareId;
    if (slash < 0) return false;
    const segment = bareId.slice(0, slash);
    const rest = bareId.slice(slash + 1);
    return rest === e.modelId && (segment === e.provider || (row.providerIds ?? []).includes(segment));
  });
  return candidates.length === 1 ? { provider: (candidates[0] as RoutingModel).provider, modelId: (candidates[0] as RoutingModel).modelId } : null;
}

/**
 * The token `harness` takes for effort `level` on the model, or null when it takes none there
 * (effortVia `none`, or the level is not one the harness lists for it). The model's own row wins
 * over the access row; without an explicit token the level is its own token.
 */
export function harnessEffortToken(registry: ModelRegistry, harness: HarnessId, modelId: string, level: string, provider?: string): string | null {
  const model = registryModel(registry, modelId, provider);
  if (model === null) return null;
  const own = harnessRow(model, harness);
  const row = accessRow(registry, harness, model.provider);
  const via = own?.effortVia ?? row?.effortVia;
  if (via === undefined || via === 'none') return null;
  const levels = own?.effortLevels ?? row?.effortLevels ?? model.effortLevels;
  if (!levels.includes(level) || !model.effortLevels.includes(level)) return null;
  const tokens = own?.efforts as Readonly<Record<string, string | undefined>> | undefined;
  return tokens?.[level] ?? level;
}

/**
 * The provider segments `harness` may name `provider` by: the provider itself and its access row's
 * `providerIds`, plus the segment of the model's own `harnessModels` id there. More than one is
 * more than one host (Google's AI Studio and Vertex, Moonshot's international and China APIs).
 */
export function hostSpellings(registry: ModelRegistry, harness: HarnessId, provider: string, modelId?: string): readonly string[] {
  const out = new Set<string>([provider, ...(accessRow(registry, harness, provider)?.providerIds ?? [])]);
  const model = modelId === undefined ? null : registryModel(registry, modelId, provider);
  const own = model === null ? null : harnessRow(model, harness);
  const cut = own === null ? -1 : own.id.lastIndexOf('/');
  if (own !== null && cut > 0) for (const segment of own.id.slice(0, cut).split('/')) out.add(segment);
  return [...out].sort();
}

export type HostKeptModelId =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reasonCode: 'NOT_ON_HARNESS' | 'HOST_UNKNOWN' };

/**
 * Owner decisions 8c1f85d (a route keeps the session's host): how a route writes the registry
 * model on `harness`.
 * - An id with no provider segment (Claude Code, Codex, Antigravity) names no host: as spelled.
 * - The same provider as the session's model: through the session's own provider segment (a
 *   `moonshotai-cn` session stays on `moonshotai-cn`).
 * - Another provider: only when the harness has one spelling for it and the model was seen on this
 *   harness (`seenHere`: listed or ran here); otherwise the host is unknown (HOST_UNKNOWN), and the
 *   route abstains rather than write the first spelling.
 * `sessionModel` is the session's model exactly as the harness spells it. A gateway or third-party
 * session id resolves to nothing, so every provider-segment route from it abstains (HOST_UNKNOWN).
 */
export function hostKeptModelId(
  registry: ModelRegistry,
  harness: HarnessId,
  target: { readonly modelId: string; readonly provider: string },
  sessionModel: string | null,
  seenHere: boolean,
): HostKeptModelId {
  const spelled = harnessModelId(registry, harness, target.modelId, target.provider);
  if (spelled === null) return { ok: false, reasonCode: 'NOT_ON_HARNESS' };
  const cut = spelled.lastIndexOf('/');
  if (cut < 0) return { ok: true, id: spelled };
  const modelPart = spelled.slice(cut + 1);
  const session = sessionModel === null ? null : registryModelOf(registry, harness, sessionModel);
  const raw = sessionModel === null ? '' : sessionModel.replace(/\[1m\]$/, '');
  const sessionCut = raw.lastIndexOf('/');
  const sessionSegment = sessionCut > 0 && raw.indexOf('/') === sessionCut ? raw.slice(0, sessionCut) : null;
  // A session on a gateway or third-party host (a provider segment that resolves to nothing) gets
  // no route until host support lands: fail closed.
  if (session === null && raw.includes('/')) return { ok: false, reasonCode: 'HOST_UNKNOWN' };
  if (session !== null && session.provider === target.provider && sessionSegment !== null && providerIdMapsTo(sessionSegment, target.provider)) {
    return { ok: true, id: `${sessionSegment}/${modelPart}` }; // path-hygiene: allow a harness model id (provider/model), not a path
  }
  const hosts = hostSpellings(registry, harness, target.provider, target.modelId);
  if (hosts.length !== 1 || !seenHere) return { ok: false, reasonCode: 'HOST_UNKNOWN' };
  return { ok: true, id: `${hosts[0] as string}/${modelPart}` }; // path-hygiene: allow a harness model id (provider/model), not a path
}

// ---------------------------------------------------------------------------------------------
// Serving hosts, phase 2 (R39; design 3.4; owner decisions 8c1f85d and c8e933d): one resolver from
// a harness spelling to (model, serving host), and back.

/** A harness spelling resolved to its registry model and the host that receives the request. */
export interface ResolvedSpelling {
  /** The spelling exactly as given. */
  readonly raw: string;
  /** The registry maker. */
  readonly provider: string;
  readonly modelId: string;
  /** The serving host: the maker's own id for a maker endpoint, else a pinned host (`openrouter`). */
  readonly servingHost: string;
  /** `maker`: the maker's own API (any of its endpoint segments); `host`: a pinned serving host. */
  readonly via: 'maker' | 'host';
}

function hostRow(registry: ModelRegistry, harness: HarnessId, segment: string): { readonly host: string } | null {
  return (registry.harnessHosts ?? []).find((row) => row.harness === harness && row.segment === segment) ?? null;
}

function servingApplies(serving: { readonly harnesses?: readonly string[] }, harness: HarnessId): boolean {
  return serving.harnesses === undefined || serving.harnesses.includes(harness);
}

/**
 * The one resolver (design 3.4). A harness spelling (the pattern, split at the first `/` as the
 * harnesses split it) names:
 * 1. the maker's own API when `registryModelOf` resolves it (a maker endpoint segment, the model's own
 *    row, or the `{id}` template): `via: 'maker'`, the host is the maker;
 * 2. else a pinned serving host when the segment is this harness's `harnessHosts` row and exactly one
 *    serving of that host applies here with `hostModelId` equal to the rest, exact case and with no
 *    `[1m]`: `via: 'host'`;
 * 3. else nothing. An unpinned host, a moving alias or a free or routing suffix stays unregistered.
 * Host segments are pinned disjoint from maker ids and their aliases (B's LOW 17), so step 1 can
 * never read a host route as direct.
 */
export function resolveSpelling(registry: ModelRegistry, harness: HarnessId, raw: string): ResolvedSpelling | null {
  if (!HARNESS_MODEL_ID.test(raw)) return null;
  const direct = registryModelOf(registry, harness, raw);
  if (direct !== null) return { raw, provider: direct.provider, modelId: direct.modelId, servingHost: direct.provider, via: 'maker' };
  // A host never spells `[1m]` and a host model id cannot carry it: refused, not stripped (B's nit).
  if (raw.endsWith('[1m]')) return null;
  const id = raw;
  const cut = id.indexOf('/');
  if (cut <= 0) return null;
  const row = hostRow(registry, harness, id.slice(0, cut));
  if (row === null) return null;
  const rest = id.slice(cut + 1);
  const matches = (registry.servings ?? []).filter((s) => s.host === row.host && s.hostModelId === rest && servingApplies(s, harness));
  if (matches.length !== 1) return null;
  const serving = matches[0] as { readonly provider: string; readonly modelId: string; readonly host: string };
  // The serving must still name a registry entry (the registry check refuses one that does not).
  if (registryModel(registry, serving.modelId, serving.provider) === null) return null;
  return { raw, provider: serving.provider, modelId: serving.modelId, servingHost: serving.host, via: 'host' };
}

/**
 * Every spelling `harness` may write for the model through `servingHost`, sorted: for the maker's
 * own API, the model's own row and each of the maker's endpoint segments (`moonshotai/kimi-k3`,
 * `moonshotai-cn/kimi-k3`); for a pinned host, its segment and the serving's host model id. Each
 * resolves back to the same (model, host). Empty when the harness cannot reach the model there.
 */
export function spellingsOnHost(registry: ModelRegistry, harness: HarnessId, servingHost: string, provider: string, modelId: string): readonly string[] {
  const model = registryModel(registry, modelId, provider);
  if (model === null) return [];
  const out = new Set<string>();
  if (servingHost === provider) {
    const own = harnessRow(model, harness);
    if (own !== null) out.add(own.id);
    const row = accessRow(registry, harness, provider);
    if (row !== null && row.idTemplate === '{id}') out.add(model.modelId);
    if (row !== null && row.idTemplate === '{provider}/{id}') for (const segment of row.providerIds ?? [provider]) out.add(`${segment}/${model.modelId}`); // path-hygiene: allow a harness model id (provider/model), not a path
  } else {
    const row = (registry.harnessHosts ?? []).find((r) => r.harness === harness && r.host === servingHost);
    if (row !== undefined) {
      for (const s of registry.servings ?? []) {
        if (s.host === servingHost && s.provider === provider && s.modelId === modelId && servingApplies(s, harness)) out.add(`${row.segment}/${s.hostModelId}`); // path-hygiene: allow a harness model id (host/model), not a path
      }
    }
  }
  const resolvesBack = (spelling: string): boolean => {
    const back = resolveSpelling(registry, harness, spelling);
    return back !== null && back.provider === provider && back.modelId === modelId && back.servingHost === servingHost;
  };
  return [...out].filter(resolvesBack).sort();
}

/** The one spelling for the model through `servingHost` on `harness`, or null when there is none or more than one. */
export function spellOnHost(registry: ModelRegistry, harness: HarnessId, servingHost: string, provider: string, modelId: string): string | null {
  const all = spellingsOnHost(registry, harness, servingHost, provider, modelId);
  return all.length === 1 ? (all[0] as string) : null;
}
