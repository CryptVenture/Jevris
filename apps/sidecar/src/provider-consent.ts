/**
 * Per-provider egress consent in the sidecar (owner DOMAINS 7be3c43 and OD-4; B stores, E's CLI
 * asks, C eliminates). The sidecar is the single store writer, so grants and revokes are admin ops
 * (CLI key only), and C's engine reads consent through `providerConsentReader`.
 *
 * - `provider.consent.status`: every stored row, and whether each is current for today's text.
 * - `provider.consent.grant` { provider, textVersion, channel: 'terminal' }: only from an
 *   interactive terminal (the CLI checks and says so, as for `authorization.mint`), and only for
 *   the version of today's consent text, so a stale prompt cannot grant.
 * - `provider.consent.revoke` { provider } or { all: true }: only tightens, so any CLI channel. A
 *   revoke is stored even for a provider never granted, so one allowed by the signed-in default can
 *   be refused too; `all` refuses every provider the bundled and the loaded registry name, and every
 *   provider with consent text.
 *
 * Today's text version comes from contracts' `PROVIDER_CONSENT_TEXT[provider].version` (E owns
 * the text, with C's dated facts). While a provider has no text, nothing can be granted for it
 * and it reads as not consented.
 *
 * Serving hosts (owner decisions 8c1f85d and c8e933d; design serving-hosts.md 5.1, R46). A party is
 * a maker or a pinned serving host (contracts' `SERVING_HOSTS`, kind gateway or inference-host).
 * Each party has one row in the same table; the host-and-maker pair is evaluated by C's gate and
 * never stored. A host's text is `SERVING_HOST_CONSENT_TEXT[host]`. An id with text in both maps
 * reads as having none (the maps are pinned disjoint, so that is a defect, and it fails closed).
 * Every grant and revoke audit row says which kind of party it touched (`party`, `parties`).
 */
import * as contracts from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, loadModelRegistry } from '@jevris/core';
import type { SidecarOpContext, SidecarOpDefinition, SidecarOpOutcome } from '@jevris/contracts';
import type { OpenedStore } from '@jevris/store';
import { bodyRecord, ok, refuse } from './ops.js';

type StoreModule = typeof import('@jevris/store');

export const PROVIDER_CONSENT_OP_NAMES = ['provider.consent.status', 'provider.consent.grant', 'provider.consent.revoke'] as const;

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** A contracts map keyed by party id, or null while contracts do not export it. */
function contractMap(name: string): object | null {
  const map: unknown = Reflect.get(contracts, name);
  return map !== null && typeof map === 'object' ? map : null;
}

/** A text's version from one map, or undefined when the map has no entry for the id. */
function versionIn(map: object | null, id: string): string | undefined {
  if (map === null || !Object.hasOwn(map, id)) return undefined;
  const entry: unknown = Reflect.get(map, id);
  const version: unknown = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'version') : undefined;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Today's consent text version for a party (a maker or a pinned serving host), from contracts, or
 * undefined when there is none. An id with text in both maps has none: fail closed.
 */
export function currentConsentTextVersion(provider: string): string | undefined {
  const maker = contractMap('PROVIDER_CONSENT_TEXT');
  const host = contractMap('SERVING_HOST_CONSENT_TEXT');
  const inMaker = maker !== null && Object.hasOwn(maker, provider);
  const inHost = host !== null && Object.hasOwn(host, provider);
  if (inMaker && inHost) return undefined;
  return inHost ? versionIn(host, provider) : versionIn(maker, provider);
}

/**
 * The pinned serving hosts that are not makers (contracts' `SERVING_HOSTS`: a list of `{id, kind}`
 * or a map by id), plus every id with host text. Empty while contracts do not export them.
 */
export function servingHostIds(): readonly string[] {
  const ids = new Set<string>();
  const pinned: unknown = Reflect.get(contracts, 'SERVING_HOSTS');
  const add = (id: unknown, entry: unknown): void => {
    const kind: unknown = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'kind') : undefined;
    if (typeof id === 'string' && kind !== 'maker') ids.add(id);
  };
  if (Array.isArray(pinned)) for (const entry of pinned as readonly unknown[]) add(entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'id') : undefined, entry);
  else if (pinned !== null && typeof pinned === 'object') for (const id of Object.keys(pinned)) add(id, Reflect.get(pinned, id));
  const texts = contractMap('SERVING_HOST_CONSENT_TEXT');
  if (texts !== null) for (const id of Object.keys(texts)) ids.add(id);
  return [...ids].sort();
}

/** Which kind of party an id is, for the audit row: a pinned serving host, else a maker. */
export function partyOf(id: string, hosts: readonly string[] = servingHostIds()): 'maker' | 'host' {
  return hosts.includes(id) ? 'host' : 'maker';
}

export type ConsentText = (provider: string) => string | undefined;

export type ProviderConsentAnswer =
  | { readonly granted: true; readonly provider: string; readonly textVersion: string; readonly grantedAtMs: number }
  | { readonly granted: false; readonly provider: string; readonly reasonCode: 'PROVIDER_CONSENT_MISSING' | 'PROVIDER_CONSENT_REVOKED' | 'PROVIDER_CONSENT_STALE' | 'PROVIDER_CONSENT_UNREADABLE' };

/**
 * C's engine option: a synchronous point read per candidate provider. No store, no text or an
 * unreadable row all read as not consented.
 */
export function providerConsentReader(held: () => { readonly store: OpenedStore; readonly api: StoreModule } | undefined, text: ConsentText = currentConsentTextVersion): (provider: string) => ProviderConsentAnswer {
  return (provider: string): ProviderConsentAnswer => {
    const current = typeof provider === 'string' ? text(provider) : undefined;
    const now = held();
    if (current === undefined) return { granted: false, provider: String(provider), reasonCode: 'PROVIDER_CONSENT_MISSING' };
    if (now === undefined) return { granted: false, provider, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' };
    try {
      const result = now.api.readProviderConsent(now.store, { provider, currentTextVersion: current });
      if ('granted' in result) return result;
      return { granted: false, provider, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' };
    } catch {
      return { granted: false, provider, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' };
    }
  };
}

function stringField(ctx: SidecarOpContext, key: string): string | undefined {
  const value = bodyRecord(ctx)[key];
  return typeof value === 'string' ? value : undefined;
}

function actorOf(ctx: SidecarOpContext): string {
  const actor = stringField(ctx, 'actor');
  return actor !== undefined && ACTOR.test(actor) ? actor : 'cli';
}

export interface ProviderConsentOpsDeps {
  readonly store: () => { readonly store: OpenedStore; readonly api: StoreModule } | undefined;
  readonly text?: ConsentText;
  readonly nowMs?: () => number;
  /** Every provider id a revoke of all refuses (tests); default: knownProviders. */
  readonly knownProviders?: (home: string) => Promise<readonly string[]>;
  /** The pinned serving hosts (tests); default: servingHostIds. */
  readonly servingHosts?: () => readonly string[];
}

/**
 * The parties `revoke --all` refuses: the bundled registry's providers, an administrator
 * registry's when it loads, every provider with consent text, and every pinned serving host (R46),
 * with text or not. More is safer here, so a refused override still leaves the bundled list.
 */
export async function knownProviders(home: string, hosts: readonly string[] = servingHostIds()): Promise<readonly string[]> {
  const ids = new Set(BUNDLED_MODEL_REGISTRY.entries.map((entry) => entry.provider));
  try {
    for (const entry of (await loadModelRegistry({ home }))?.entries ?? []) ids.add(entry.provider);
  } catch {
    // the bundled list stands
  }
  const texts: unknown = Reflect.get(contracts, 'PROVIDER_CONSENT_TEXT');
  if (texts !== null && typeof texts === 'object') for (const id of Object.keys(texts)) ids.add(id);
  for (const id of hosts) ids.add(id);
  return [...ids].sort();
}

export function providerConsentOps(deps: ProviderConsentOpsDeps): readonly SidecarOpDefinition[] {
  const text = deps.text ?? currentConsentTextVersion;
  const nowMs = deps.nowMs ?? Date.now;
  const hosts = deps.servingHosts ?? servingHostIds;
  const withStore =
    (fn: (store: OpenedStore, api: StoreModule, ctx: SidecarOpContext) => SidecarOpOutcome) =>
    (ctx: SidecarOpContext): SidecarOpOutcome => {
      const held = deps.store();
      if (held === undefined) return refuse('STORE_UNAVAILABLE', 'The Jevris store is not open; run `jevris sidecar status` for the reason.');
      return fn(held.store, held.api, ctx);
    };
  const refusedBy = (reason: string): SidecarOpOutcome => refuse(reason === 'invalid-input' ? 'INVALID_REQUEST' : 'STORE_REFUSED', `The store refused the change (${reason}).`);
  return [
    {
      op: 'provider.consent.status',
      scope: 'admin',
      budget: 'background',
      workspace: 'optional',
      handle: withStore((store, api) => {
        const rows = api.listProviderConsent(store);
        if (!Array.isArray(rows)) return refusedBy((rows as { readonly reason: string }).reason);
        return ok({
          providers: rows.map((row) => {
            const current = text(row.provider);
            return {
              provider: row.provider,
              party: partyOf(row.provider, hosts()),
              state: row.state,
              textVersion: row.textVersion,
              grantedAtMs: row.grantedAtMs,
              revokedAtMs: row.revokedAtMs,
              revokedBy: row.revokedBy,
              current: row.state === 'granted' && current !== undefined && current === row.textVersion,
            };
          }),
        });
      }),
    },
    {
      op: 'provider.consent.grant',
      scope: 'admin',
      budget: 'hot',
      workspace: 'optional',
      handle: withStore((store, api, ctx) => {
        // A grant widens what may leave the machine: only a person at a terminal (the CLI checks
        // and says so), never MCP, a hook, a pipe or a test run.
        if (stringField(ctx, 'channel') !== 'terminal') return refuse('CHANNEL_REFUSED', 'Consent is given only by a person at an interactive terminal.');
        // GOV-02..04: a grant widens what may leave the machine; a stopped Jevris widens nothing until the person clears the kill switch.
        if (ctx.killSwitchStopped) return refuse('KILL_SWITCH', 'The kill switch is on, so consent is not granted. Clear the kill switch first (jevris kill-switch clear), then grant consent.');
        const provider = stringField(ctx, 'provider');
        const textVersion = stringField(ctx, 'textVersion');
        if (provider === undefined || !api.isProviderId(provider)) return refuse('UNKNOWN_PROVIDER');
        const current = text(provider);
        // A pinned host with no text (NVIDIA, OQ-2) can never be granted, so it is never routed.
        if (current === undefined && partyOf(provider, hosts()) === 'host') return refuse('CONSENT_TEXT_MISSING', 'Jevris has no consent text for this serving host, so it is never routed to.');
        if (current === undefined) return refuse('UNKNOWN_PROVIDER', 'Jevris has no consent text for this provider.');
        if (textVersion !== current) return refuse('PROVIDER_CONSENT_TEXT_MISMATCH', 'The consent text changed; show the current text and ask again.');
        const party = partyOf(provider, hosts());
        const result = api.grantProviderConsent(store, { provider, textVersion: current, party, actor: actorOf(ctx), channel: 'terminal', atMs: nowMs() });
        return result.ok ? ok({ result: result.result, provider, party, textVersion: result.textVersion }) : refusedBy(result.reason);
      }),
    },
    {
      op: 'provider.consent.revoke',
      scope: 'admin',
      budget: 'hot',
      workspace: 'optional',
      handle: async (ctx) => {
        const held = deps.store();
        if (held === undefined) return refuse('STORE_UNAVAILABLE', 'The Jevris store is not open; run `jevris sidecar status` for the reason.');
        const { store, api } = held;
        const all = bodyRecord(ctx)['all'] === true;
        const provider = all ? 'all' : stringField(ctx, 'provider');
        if (provider === undefined || (!all && !api.isProviderId(provider))) return refuse('UNKNOWN_PROVIDER');
        const channel = stringField(ctx, 'channel') === 'terminal' ? 'terminal' : 'cli';
        const hostIds = hosts();
        const known = all ? await (deps.knownProviders ?? ((home: string) => knownProviders(home, hostIds)))(ctx.home) : [];
        const result = api.revokeProviderConsent(store, { provider, ...(all ? { knownProviders: known } : {}), hosts: hostIds, actor: actorOf(ctx), channel, atMs: nowMs() });
        return result.ok ? ok({ result: result.result, providers: result.providers }) : refusedBy(result.reason);
      },
    },
  ];
}
