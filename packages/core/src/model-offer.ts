/**
 * Account eligibility from local evidence (owner decision 2026-09-27, DOMAINS 3f090fa).
 *
 * The router drops every model the account is not eligible for (SPEC §8.3). The bundled registry
 * carries no account checks, so without this every model is dropped on a default install. A
 * model is eligible for a harness and sign-in (auth mode) on this machine once there is
 * deterministic local proof:
 *
 * - it ran there: an owned run whose harness reported that model id back (D, `recordModelRun`);
 * - the harness lists it: the harness's own model listing (F lists, B schedules the refresh,
 *   `recordModelListing`), for a provider the registry's harness-to-model map gives that harness.
 *
 * A model found gone (any harness) or not accessible on that harness and sign-in is never
 * eligible. An administrator's registry with account checks (a policy account id) wins: local
 * evidence is then not consulted. With no evidence, nothing is eligible (fail-closed).
 *
 * Record: `<data>/route-learning/model-offer.json`, one per machine, mode 0600, written
 * atomically under an exclusive lock. It holds harness ids, auth modes, model ids, times, a
 * harness version and a reason code: never a listing's text, a path, a workspace or an account.
 *
 * v2 (serving hosts R41, owner decisions 8c1f85d): each run and each listed line also keeps the
 * raw harness spelling and the serving host it resolved to, so a route can keep the host the
 * harness was seen using. A v1 file reads with no spelling and no host: it still proves the model,
 * never a host. Every write is v2. A clean run that only requested its model (no report) counts
 * only through the maker's own host, never a gateway, which may fall back to another model.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_IDS, HARNESS_MODEL_ID_PATTERN, MODEL_ID_PATTERN, PROVIDER_IDS, type ModelRegistry } from '@jevris/contracts';
import { durableWrite, jevrisPaths } from '@jevris/platform';
import type { AvailabilityAuthMode, ModelUnavailableReason } from './model-availability.js';
import { withFileLock } from './route-file-lock.js';
import { CLAUDE_CODE_SUBAGENT_ALIASES, aliasMeansModel, lifecycleCheck } from './model-registry.js';

export const MODEL_OFFER_SCHEMA = 'jevris-model-offer-2' as const;
/** The previous schema, still read (runs and listings then carry no spelling and no host). */
export const MODEL_OFFER_SCHEMA_V1 = 'jevris-model-offer-1' as const;
/** Where a run can come from: a harness, or the Claude API directly (D's Agent SDK worker). */
export const MODEL_RUN_PORTS = [...HARNESS_IDS, 'claude-api'] as const;
export type ModelRunPort = (typeof MODEL_RUN_PORTS)[number];

/** One listed line the resolver mapped: the raw spelling, its registry model and its serving host. */
export interface ModelSpelling {
  readonly raw: string;
  readonly modelId: string;
  readonly servingHost: string;
}

export interface ModelListing {
  readonly harness: string;
  readonly authMode: AvailabilityAuthMode;
  /** The models the harness last listed successfully (at most 256). */
  readonly models: readonly string[];
  /** v2: the listed lines the resolver mapped, with their hosts (at most 256; empty from a v1 file). */
  readonly spellings: readonly ModelSpelling[];
  /** When the harness last listed successfully; null when it never has. */
  readonly observedAt: string | null;
  /** When a listing was last attempted, successful or not (the refresh schedule reads it). */
  readonly attemptedAt: string;
  readonly harnessVersion: string | null;
  /** Why the last attempt failed (F's LISTING_* codes); null after a success. */
  readonly reasonCode: string | null;
}

/** How a run's model is known: the harness reported it, or a clean run started with it explicitly. */
export const MODEL_RUN_SOURCES = ['reported', 'requested-clean-run'] as const;
export type ModelRunSource = (typeof MODEL_RUN_SOURCES)[number];

export interface ModelRun {
  readonly harness: string;
  readonly authMode: AvailabilityAuthMode;
  readonly modelId: string;
  readonly firstAt: string;
  readonly lastAt: string;
  /** v2: the harness's own spelling of the model; null from a v1 file or when none was reported. */
  readonly raw: string | null;
  /** v2: the serving host the spelling resolved to; null when unknown (a v1 file). */
  readonly servingHost: string | null;
  readonly source: ModelRunSource;
}

export interface ModelOffer {
  readonly listings: readonly ModelListing[];
  readonly runs: readonly ModelRun[];
}

const MAX_MODELS = 256;
const MAX_LISTINGS = 64;
const MAX_RUNS = 512;
const MAX_BYTES = 262_144;
const MODEL_ID = new RegExp(MODEL_ID_PATTERN);
const RAW = new RegExp(HARNESS_MODEL_ID_PATTERN);
/** A party id (a maker or a serving host), as the consent store keys it. */
const HOST = /^[a-z][a-z0-9-]{0,31}$/;
const MAKERS: readonly string[] = PROVIDER_IDS;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const AUTH: readonly string[] = ['api-key', 'subscription', 'unknown'];
const LISTING_HARNESSES: readonly string[] = HARNESS_IDS;
const RUN_PORTS: readonly string[] = MODEL_RUN_PORTS;

/** `<data>/route-learning/model-offer.json`. */
export function modelOfferFile(home: string): string {
  return join(jevrisPaths({ home }).data, 'route-learning', 'model-offer.json');
}

const isIso = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));

function validListing(v: unknown): ModelListing | null {
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e['harness'] !== 'string' || !LISTING_HARNESSES.includes(e['harness'])) return null;
  if (typeof e['authMode'] !== 'string' || !AUTH.includes(e['authMode'])) return null;
  if (!Array.isArray(e['models']) || e['models'].length > MAX_MODELS || !e['models'].every((m) => typeof m === 'string' && MODEL_ID.test(m))) return null;
  if (e['observedAt'] !== null && !isIso(e['observedAt'])) return null;
  if (!isIso(e['attemptedAt'])) return null;
  if (e['harnessVersion'] !== null && (typeof e['harnessVersion'] !== 'string' || !VERSION.test(e['harnessVersion']))) return null;
  if (e['reasonCode'] !== null && (typeof e['reasonCode'] !== 'string' || !CODE.test(e['reasonCode']))) return null;
  const models = [...new Set(e['models'] as string[])];
  return {
    harness: e['harness'],
    authMode: e['authMode'] as AvailabilityAuthMode,
    models,
    spellings: validSpellings(e['spellings'], models),
    observedAt: e['observedAt'] as string | null,
    attemptedAt: e['attemptedAt'],
    harnessVersion: e['harnessVersion'] as string | null,
    reasonCode: e['reasonCode'] as string | null,
  };
}

/** The valid listed spellings of listed models (duplicates by raw dropped, at most 256); [] when absent. */
function validSpellings(value: unknown, models: readonly string[]): readonly ModelSpelling[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, ModelSpelling>();
  for (const item of value.slice(0, MAX_MODELS)) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const raw = e['raw'];
    const modelId = e['modelId'];
    const servingHost = e['servingHost'];
    if (typeof raw !== 'string' || !RAW.test(raw) || typeof modelId !== 'string' || !models.includes(modelId) || typeof servingHost !== 'string' || !HOST.test(servingHost)) continue;
    if (!out.has(raw)) out.set(raw, { raw, modelId, servingHost });
  }
  return [...out.values()];
}

/**
 * Whether a run's spelling and host fit together: both null (unknown), or both set. A clean run that
 * only requested its model counts only through a maker's own host (never a gateway or other host).
 */
function runHostOk(raw: string | null, servingHost: string | null, source: ModelRunSource): boolean {
  if ((raw === null) !== (servingHost === null)) return false;
  if (raw !== null && !RAW.test(raw)) return false;
  if (servingHost !== null && !HOST.test(servingHost)) return false;
  return source === 'reported' || (servingHost !== null && MAKERS.includes(servingHost));
}

function validRun(v: unknown, v1: boolean): ModelRun | null {
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e['harness'] !== 'string' || !RUN_PORTS.includes(e['harness'])) return null;
  if (typeof e['authMode'] !== 'string' || !AUTH.includes(e['authMode'])) return null;
  if (typeof e['modelId'] !== 'string' || !MODEL_ID.test(e['modelId'])) return null;
  if (!isIso(e['firstAt']) || !isIso(e['lastAt'])) return null;
  const base = { harness: e['harness'], authMode: e['authMode'] as AvailabilityAuthMode, modelId: e['modelId'], firstAt: e['firstAt'], lastAt: e['lastAt'] };
  // A v1 run proves the model, not a host: the endpoint it ran through was not kept.
  if (v1) return { ...base, raw: null, servingHost: null, source: 'reported' };
  const raw = e['raw'] === null || e['raw'] === undefined ? null : e['raw'];
  const servingHost = e['servingHost'] === null || e['servingHost'] === undefined ? null : e['servingHost'];
  const source = e['source'];
  if ((raw !== null && typeof raw !== 'string') || (servingHost !== null && typeof servingHost !== 'string')) return null;
  if (typeof source !== 'string' || !(MODEL_RUN_SOURCES as readonly string[]).includes(source)) return null;
  if (!runHostOk(raw, servingHost, source as ModelRunSource)) return null;
  return { ...base, raw, servingHost, source: source as ModelRunSource };
}

/** The record on disk; null when it is missing, oversized or not this schema. Invalid rows are dropped. */
export async function readModelOffer(home: string): Promise<ModelOffer | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(modelOfferFile(home));
  } catch {
    return null;
  }
  if (bytes.byteLength > MAX_BYTES) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { schema?: unknown; listings?: unknown; runs?: unknown };
    const v1 = value.schema === MODEL_OFFER_SCHEMA_V1;
    if ((value.schema !== MODEL_OFFER_SCHEMA && !v1) || !Array.isArray(value.listings) || !Array.isArray(value.runs)) return null;
    return {
      listings: value.listings.slice(0, MAX_LISTINGS).map(validListing).filter((e): e is ModelListing => e !== null),
      runs: value.runs.slice(0, MAX_RUNS).map((run) => validRun(run, v1)).filter((e): e is ModelRun => e !== null),
    };
  } catch {
    return null;
  }
}

async function write(home: string, offer: ModelOffer): Promise<boolean> {
  await mkdir(join(jevrisPaths({ home }).data, 'route-learning'), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify({ schema: MODEL_OFFER_SCHEMA, listings: offer.listings, runs: offer.runs })}\n`;
  // A record past the read cap would read back as nothing: refuse it and keep the previous one.
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return false;
  const result = await durableWrite(modelOfferFile(home), text, { mode: 0o600 });
  return result.ok;
}

/** Reads, changes and writes the record under its lock. Never throws. */
async function update(home: string, change: (current: ModelOffer) => ModelOffer | null): Promise<boolean> {
  try {
    const outcome = await withFileLock(modelOfferFile(home), async () => {
      const current = (await readModelOffer(home)) ?? { listings: [], runs: [] };
      const next = change(current);
      return next === null ? false : write(home, next);
    });
    return outcome === true;
  } catch {
    return false;
  }
}

const validNow = (nowMs: number): boolean => Number.isFinite(nowMs) && Math.abs(nowMs) <= 8.64e15;

/** What F's `listOfferedModels` resolves to. v2: `spellings` are the lines the resolver mapped (optional). */
export type ModelListingResult =
  | { readonly ok: true; readonly version: string | null; readonly models: readonly string[]; readonly spellings?: readonly ModelSpelling[] }
  | { readonly ok: false; readonly reasonCode: string };

/**
 * Records one harness's listing for one sign-in (B's refresh). A success replaces the models; a
 * failure keeps the previous models and records the reason. Ids that are not model ids are
 * dropped; more than 256 are cut. Resolves false on invalid input or a failed write; never throws.
 */
export async function recordModelListing(home: string, input: { readonly harness: string; readonly authMode: string; readonly result: ModelListingResult; readonly nowMs: number }): Promise<boolean> {
  if (!validNow(input.nowMs) || !LISTING_HARNESSES.includes(input.harness) || !AUTH.includes(input.authMode)) return false;
  const at = new Date(input.nowMs).toISOString();
  const result = input.result as Partial<{ ok: boolean; version: unknown; models: unknown; spellings: unknown; reasonCode: unknown }>;
  if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') return false;
  return update(home, (current) => {
    const same = (l: ModelListing): boolean => l.harness === input.harness && l.authMode === input.authMode;
    const prior = current.listings.find(same) ?? null;
    let listing: ModelListing;
    if (result.ok) {
      const models = Array.isArray(result.models) ? [...new Set(result.models.filter((m): m is string => typeof m === 'string' && MODEL_ID.test(m)))].slice(0, MAX_MODELS) : [];
      const version = typeof result.version === 'string' && VERSION.test(result.version) ? result.version : null;
      listing = { harness: input.harness, authMode: input.authMode as AvailabilityAuthMode, models, spellings: validSpellings(result.spellings, models), observedAt: at, attemptedAt: at, harnessVersion: version, reasonCode: null };
    } else {
      const reasonCode = typeof result.reasonCode === 'string' && CODE.test(result.reasonCode) ? result.reasonCode : 'LISTING_FAILED';
      listing = { harness: input.harness, authMode: input.authMode as AvailabilityAuthMode, models: prior?.models ?? [], spellings: prior?.spellings ?? [], observedAt: prior?.observedAt ?? null, attemptedAt: at, harnessVersion: prior?.harnessVersion ?? null, reasonCode };
    }
    return { listings: [...current.listings.filter((l) => !same(l)), listing].slice(-MAX_LISTINGS), runs: current.runs };
  });
}

/**
 * Records that a harness ran a model and reported it back (D, at the end of every owned run with
 * an actual model). The oldest rows go past 512. Resolves false on invalid input; never throws.
 *
 * v2: `raw` is the harness's own spelling and `servingHost` the host it resolved to (both or
 * neither); `source` defaults to `reported`. One row per (harness, sign-in, model, spelling), so a
 * model run through two hosts keeps both. A `requested-clean-run` is refused unless its host is a
 * maker's own (C's clean-run rule: a gateway can fall back to another model).
 */
export async function recordModelRun(
  home: string,
  input: { readonly harness: string; readonly authMode: string; readonly modelId: string; readonly nowMs: number; readonly raw?: string | null; readonly servingHost?: string | null; readonly source?: ModelRunSource },
): Promise<boolean> {
  if (!validNow(input.nowMs) || !RUN_PORTS.includes(input.harness) || !AUTH.includes(input.authMode) || typeof input.modelId !== 'string' || !MODEL_ID.test(input.modelId)) return false;
  const raw = input.raw ?? null;
  const servingHost = input.servingHost ?? null;
  const source = input.source ?? 'reported';
  if (!(MODEL_RUN_SOURCES as readonly string[]).includes(source) || (raw !== null && typeof raw !== 'string') || (servingHost !== null && typeof servingHost !== 'string') || !runHostOk(raw, servingHost, source)) return false;
  const at = new Date(input.nowMs).toISOString();
  return update(home, (current) => {
    const same = (r: ModelRun): boolean => r.harness === input.harness && r.authMode === input.authMode && r.modelId === input.modelId && r.raw === raw;
    const prior = current.runs.find(same);
    // A reported run outranks a clean run of the same spelling.
    const kept: ModelRunSource = prior?.source === 'reported' || source === 'reported' ? 'reported' : source;
    const run: ModelRun = { harness: input.harness, authMode: input.authMode as AvailabilityAuthMode, modelId: input.modelId, firstAt: prior?.firstAt ?? at, lastAt: prior === undefined || at > prior.lastAt ? at : prior.lastAt, raw, servingHost, source: kept };
    const runs = [...current.runs.filter((r) => !same(r)), run].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0)).slice(0, MAX_RUNS);
    return { listings: current.listings, runs };
  });
}

/** A spelling a harness was seen using for a model on this machine, with the host it resolved to. */
export interface SeenSpelling {
  readonly raw: string;
  readonly servingHost: string;
}

/**
 * The spellings `harness` was seen using for `modelId` on this machine (serving hosts R41, R44):
 * the lines its listings mapped and the runs that kept a spelling, on any sign-in unless `authMode`
 * is given. A v1 row names no spelling, so it is not here. Unique by spelling, sorted.
 */
export function seenSpellings(offer: ModelOffer | null, scope: { readonly harness: string; readonly authMode?: string | null }, modelId: string): readonly SeenSpelling[] {
  if (offer === null) return [];
  const inScope = (e: { readonly harness: string; readonly authMode: string }): boolean => e.harness === scope.harness && (scope.authMode === undefined || scope.authMode === null || e.authMode === scope.authMode);
  const out = new Map<string, string>();
  for (const listing of offer.listings.filter(inScope)) for (const s of listing.spellings) if (s.modelId === modelId) out.set(s.raw, s.servingHost);
  for (const run of offer.runs.filter(inScope)) if (run.modelId === modelId && run.raw !== null && run.servingHost !== null) out.set(run.raw, run.servingHost);
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([raw, servingHost]) => ({ raw, servingHost }));
}

/** Deletes the record under its lock (`jevris route learning reset --machine`). A missing file is already removed. */
export async function removeModelOffer(home: string): Promise<{ readonly ok: boolean }> {
  const outcome = await withFileLock(modelOfferFile(home), async () => {
    try {
      await rm(modelOfferFile(home));
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'ENOENT') return false;
    }
    return true;
  }).catch(() => false);
  return { ok: outcome === true };
}

export const ELIGIBILITY_BASES = ['account-check', 'ran-here', 'harness-listing', 'harness-alias'] as const;
export type EligibilityBasis = (typeof ELIGIBILITY_BASES)[number];

/** Why one registry model is or is not eligible for a route. */
export interface ModelEligibility {
  readonly modelId: string;
  readonly eligible: boolean;
  readonly basis: EligibilityBasis | null;
  /**
   * ACCOUNT_ELIGIBLE, ACCOUNT_NOT_ELIGIBLE, ACCOUNT_NOT_CHECKED (an administrator's account check
   * decides); RAN_HERE, LISTED_BY_HARNESS (local evidence); HARNESS_ALIAS (Claude Code's own family
   * alias resolves to it, owner decision 2026-10-08); MODEL_GONE, MODEL_NOT_ACCESSIBLE (found
   * gone); NOT_ON_HARNESS (the harness-to-model map gives this harness no access to the provider);
   * NO_LOCAL_EVIDENCE.
   */
  readonly reasonCode: string;
}

export interface EligibilityScope {
  /** The route's harness (a run port); null when the route does not know it (main-session advice): evidence from any harness counts. */
  readonly harness: string | null;
  /** The route's sign-in; null when unknown: evidence under any sign-in counts, with the harness. */
  readonly authMode: string | null;
}

/**
 * Owner decision 2026-10-08 (amends DOMAINS 3f090fa for Claude Code only): the proof that Claude
 * Code's own family alias resolves to a model. It is asked for only by the subagent route, which
 * sets that alias on one Agent call; `certified` is the sidecar's answer to "is hooks.route
 * certified for the installed Claude Code", and `nowMs` dates the registry's lifecycle.
 */
export interface HarnessAliasProof {
  readonly certified: boolean;
  readonly nowMs: number;
}

/**
 * Whether Claude Code's family alias (haiku, sonnet, opus, fable) currently means `model`: harness
 * `claude`, provider `anthropic`, the model is the newest usable release of an alias family, the
 * model itself is usable, and the installed Claude Code is certified for hooks.route. Every refusal
 * in `modelEligibility` (gone, not accessible, an account check) is decided before this is asked.
 */
export function harnessAliasHolds(registry: Pick<ModelRegistry, 'entries'>, model: ModelRegistry['entries'][number], scope: EligibilityScope, proof: HarnessAliasProof | undefined): boolean {
  if (proof === undefined || !proof.certified) return false;
  if (scope.harness !== 'claude' || model.provider !== 'anthropic') return false;
  if (!(CLAUDE_CODE_SUBAGENT_ALIASES as readonly string[]).includes(model.family)) return false;
  if (!lifecycleCheck(model, proof.nowMs).usable) return false;
  return aliasMeansModel(registry as ModelRegistry, model, proof.nowMs);
}

/**
 * Every registry model's eligibility for a route. With an account id (an administrator's registry
 * with account checks) only that check decides. Otherwise, a model found gone is never eligible;
 * a model that ran on this harness and sign-in is; a model the harness lists is, when the map gives
 * the harness its provider; anything else is not.
 */
export function modelEligibility(input: {
  readonly registry: Pick<ModelRegistry, 'entries' | 'harnessAccess'>;
  readonly accountId: string | null;
  readonly offer: ModelOffer | null;
  readonly unavailable?: Readonly<Record<string, ModelUnavailableReason>>;
  readonly scope: EligibilityScope;
  /** Claude Code's alias proof (HARNESS_ALIAS); absent: not asked, so only runs and listings count. */
  readonly harnessAlias?: HarnessAliasProof;
}): readonly ModelEligibility[] {
  const { harness, authMode } = input.scope;
  const inScope = (e: { readonly harness: string; readonly authMode: string }): boolean => (harness === null || e.harness === harness) && (harness === null || authMode === null || e.authMode === authMode);
  const runs = (input.offer?.runs ?? []).filter(inScope);
  const listings = (input.offer?.listings ?? []).filter(inScope);
  const access = input.registry.harnessAccess;
  const mapped = (h: string, provider: string): boolean => access === undefined || access.some((row) => row.harness === h && row.provider === provider);
  return input.registry.entries.map((model): ModelEligibility => {
    const id = model.modelId;
    if (input.accountId !== null) {
      const check = model.accountEligibility.find((c) => c.accountId === input.accountId);
      if (check === undefined) return { modelId: id, eligible: false, basis: 'account-check', reasonCode: 'ACCOUNT_NOT_CHECKED' };
      return { modelId: id, eligible: check.eligible, basis: 'account-check', reasonCode: check.eligible ? 'ACCOUNT_ELIGIBLE' : 'ACCOUNT_NOT_ELIGIBLE' };
    }
    const gone = input.unavailable?.[id];
    if (gone !== undefined) return { modelId: id, eligible: false, basis: null, reasonCode: gone };
    if (runs.some((r) => r.modelId === id)) return { modelId: id, eligible: true, basis: 'ran-here', reasonCode: 'RAN_HERE' };
    const listedOn = listings.filter((l) => l.models.includes(id)).map((l) => l.harness);
    if (listedOn.some((h) => mapped(h, model.provider))) return { modelId: id, eligible: true, basis: 'harness-listing', reasonCode: 'LISTED_BY_HARNESS' };
    if (harness !== null && !mapped(harness, model.provider)) return { modelId: id, eligible: false, basis: null, reasonCode: 'NOT_ON_HARNESS' };
    if (harnessAliasHolds(input.registry, model, input.scope, input.harnessAlias)) return { modelId: id, eligible: true, basis: 'harness-alias', reasonCode: 'HARNESS_ALIAS' };
    return { modelId: id, eligible: false, basis: null, reasonCode: 'NO_LOCAL_EVIDENCE' };
  });
}

/** The ids of the eligible models, for the router's account gate (`RoutingPolicy.locallyEligible`). */
/**
 * Owner decision c065d52 (OD-4's signed-in default): the providers a harness on this machine has
 * run a model of (RAN_HERE, the evidence eligibility uses), on any harness and any sign-in, sorted.
 * A run whose model the registry does not list names no provider, and neither does a run through a
 * gateway or other pinned host.
 */
export function ranHereProviders(registry: ModelRegistry, offer: ModelOffer | null): readonly string[] {
  if (offer === null) return [];
  const out = new Set<string>();
  for (const run of offer.runs) {
    const matches = registry.entries.filter((e) => e.modelId === run.modelId);
    // A run through a pinned serving host (R42 records it) signs in that host, not the maker behind
    // it (design 4.4; `ranHereParties`). A v1 run has no host and was a direct spelling.
    if (matches.length === 1 && matches[0] !== undefined && ((run.servingHost ?? null) === null || run.servingHost === matches[0].provider)) out.add(matches[0].provider);
  }
  return [...out].sort();
}

export function locallyEligibleModels(eligibility: readonly ModelEligibility[]): readonly string[] {
  return eligibility.filter((e) => e.eligible && e.basis !== 'account-check').map((e) => e.modelId);
}

/** Plain-text lines for explain, status and doctor: why each model is or is not eligible. */
export function modelEligibilityLines(eligibility: readonly ModelEligibility[], scope: EligibilityScope): string[] {
  const where = scope.harness === null ? 'on this machine' : `on ${scope.harness}${scope.authMode === null ? '' : ` with ${scope.authMode} sign-in`}`;
  const why: Readonly<Record<string, string>> = {
    ACCOUNT_ELIGIBLE: "eligible: the administrator's registry records an account check",
    ACCOUNT_NOT_ELIGIBLE: "not eligible: the administrator's registry records the account as not eligible",
    ACCOUNT_NOT_CHECKED: "not eligible: the administrator's registry has no account check for it",
    RAN_HERE: `eligible: it has run ${where}`,
    LISTED_BY_HARNESS: `eligible: the harness lists it ${where}`,
    HARNESS_ALIAS: `eligible for a subagent route: Claude Code's own family alias resolves to it ${where}, and hooks.route is certified for the installed version`,
    MODEL_GONE: 'not eligible: found gone on this machine',
    MODEL_NOT_ACCESSIBLE: `not eligible: not accessible ${where}`,
    NOT_ON_HARNESS: `not eligible: the registry's harness map gives ${scope.harness ?? 'this harness'} no access to its provider, and it has not run there`,
    NO_LOCAL_EVIDENCE: `not eligible: it has not run ${where} and no harness listing names it`,
  };
  return eligibility.map((e) => `${e.modelId} is ${why[e.reasonCode] ?? `${e.eligible ? 'eligible' : 'not eligible'} (${e.reasonCode})`} (${e.reasonCode}).`);
}
