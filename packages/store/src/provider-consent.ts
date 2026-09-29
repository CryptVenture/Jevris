/**
 * Per-provider egress consent (owner decisions DOMAINS 7be3c43 and OD-4 in 38be7b5). A model from a
 * provider is routed, suggested or launched only when this machine's user consented to that
 * provider, or (for a provider that passed the SPEC 8.1 review) is signed in to it on an installed
 * harness. C derives that signed-in default and it is never stored. Moonshot (Kimi) and DeepSeek
 * always need a grant.
 *
 * - One row per provider (any registry provider id), machine-wide: the consent text version the
 *   person saw, when it was given, and when and how it was revoked. No email, account id or free
 *   text.
 * - Grants come only from `jevris consent provider <id> --grant` at an interactive terminal (E's
 *   CLI, the sidecar's admin op with the terminal channel). A repository file, a config file, an
 *   MCP call, a hook or a model summary never reaches this table.
 * - A grant counts only for the text version it names. When the consent text changes, the stored
 *   grant reads as stale and the person is asked again.
 * - Every grant and revoke writes its audit row in the same transaction.
 * - A revoke is stored even for a provider never granted, so a provider allowed by the signed-in
 *   default can be refused, and it blocks that provider even while the person is signed in.
 * - A party is a maker or a pinned serving host (owner decisions c8e933d, R46): the same table and
 *   id pattern hold both, with no migration. Each audit row says which kind it touched (`party` on
 *   a grant, `parties` beside `providers` on a revoke), from the caller's pinned host list.
 * - Retention: neither a grant nor a revoke ages out (a swept revoke would re-allow a signed-in
 *   provider). The ledger scope of `jevris data delete` removes the store with them, and consent
 *   must then be given again.
 */
import { field, isMs, nullableNum, nullableStr, num, read, refuse, str, write } from './access.js';
import { AUDIT_CHANNELS, appendAuditRow, type AuditChannel } from './governance.js';
import type { OpenStoreResult, StoreRefusal } from './open.js';

/** v9: per-provider consent. */
export const PROVIDER_CONSENT_SQL = `
CREATE TABLE IF NOT EXISTS provider_consent (
  provider TEXT PRIMARY KEY CHECK (length(provider) BETWEEN 1 AND 32),
  state TEXT NOT NULL CHECK (state IN ('granted', 'revoked')),
  text_version TEXT NOT NULL CHECK (length(text_version) BETWEEN 1 AND 64),
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= 0),
  revoked_by TEXT CHECK (revoked_by IS NULL OR revoked_by IN ('user')),
  CHECK ((state = 'granted' AND revoked_at_ms IS NULL AND revoked_by IS NULL) OR (state = 'revoked' AND revoked_at_ms IS NOT NULL AND revoked_by IS NOT NULL))
) WITHOUT ROWID;
`;

/** A registry provider id: `openai`, `google`, `moonshot`, `deepseek` and so on. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** A consent text version, as contracts' PROVIDER_CONSENT_TEXT names it. */
export const CONSENT_TEXT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export type ProviderConsentState = 'granted' | 'revoked';
export type ProviderConsentRevokedBy = 'user';

export interface ProviderConsentRow {
  readonly provider: string;
  readonly state: ProviderConsentState;
  readonly textVersion: string;
  readonly grantedAtMs: number;
  readonly revokedAtMs: number | null;
  readonly revokedBy: ProviderConsentRevokedBy | null;
}

export type ProviderConsentReason = 'PROVIDER_CONSENT_MISSING' | 'PROVIDER_CONSENT_REVOKED' | 'PROVIDER_CONSENT_STALE';

export type ReadProviderConsentResult =
  | { readonly granted: true; readonly provider: string; readonly textVersion: string; readonly grantedAtMs: number }
  | { readonly granted: false; readonly provider: string; readonly reasonCode: ProviderConsentReason };

/** Which kind of consent party an id is (serving-hosts design 5.1). */
export type ConsentParty = 'maker' | 'host';

export interface ProviderConsentChange {
  /** The audit actor (the CLI's user label, never an email or account id). */
  readonly actor: string;
  readonly channel: AuditChannel;
  readonly atMs: number;
}

/** A provider id; `all` is reserved for revoking every grant. */
export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value) && value !== 'all';
}

function rowOf(value: unknown): ProviderConsentRow | undefined {
  const provider = str(field(value, 'provider'));
  const state = str(field(value, 'state'));
  const textVersion = str(field(value, 'text_version'));
  const grantedAtMs = num(field(value, 'granted_at_ms'));
  const revokedBy = nullableStr(field(value, 'revoked_by'));
  if (provider === undefined || (state !== 'granted' && state !== 'revoked') || textVersion === undefined || grantedAtMs === undefined) return undefined;
  return {
    provider,
    state,
    textVersion,
    grantedAtMs,
    revokedAtMs: nullableNum(field(value, 'revoked_at_ms')),
    revokedBy: revokedBy === 'user' ? 'user' : null,
  };
}

const SELECT = 'SELECT provider, state, text_version, granted_at_ms, revoked_at_ms, revoked_by FROM provider_consent';

/**
 * Whether a provider is consented for the current consent text. C's route elimination calls it
 * (through the sidecar's engine option) with the version of today's text; a grant for any other
 * version is stale. A store that cannot be read refuses, and the caller treats that as no consent.
 */
export function readProviderConsent(store: OpenStoreResult, input: { readonly provider: string; readonly currentTextVersion: string }): ReadProviderConsentResult | StoreRefusal {
  if (!isProviderId(input.provider) || typeof input.currentTextVersion !== 'string' || !CONSENT_TEXT_VERSION_PATTERN.test(input.currentTextVersion)) return refuse('invalid-input');
  return read(store, ({ driver }) => {
    const row = rowOf(driver.prepare(`${SELECT} WHERE provider = ?`).get(input.provider));
    if (row === undefined) return { granted: false as const, provider: input.provider, reasonCode: 'PROVIDER_CONSENT_MISSING' as const };
    if (row.state === 'revoked') return { granted: false as const, provider: input.provider, reasonCode: 'PROVIDER_CONSENT_REVOKED' as const };
    if (row.textVersion !== input.currentTextVersion) return { granted: false as const, provider: input.provider, reasonCode: 'PROVIDER_CONSENT_STALE' as const };
    return { granted: true as const, provider: row.provider, textVersion: row.textVersion, grantedAtMs: row.grantedAtMs };
  });
}

/** Every stored consent row, by provider: status, doctor and explain. */
export function listProviderConsent(store: OpenStoreResult): readonly ProviderConsentRow[] | StoreRefusal {
  return read(store, ({ driver }) => {
    const out: ProviderConsentRow[] = [];
    for (const raw of driver.prepare(`${SELECT} ORDER BY provider`).all() as readonly unknown[]) {
      const row = rowOf(raw);
      if (row !== undefined) out.push(row);
    }
    return out;
  });
}

/** An audit actor label; no `@`, so an email address can never be recorded as one. */
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function checkChange(change: ProviderConsentChange): boolean {
  return typeof change.actor === 'string' && ACTOR.test(change.actor) && (AUDIT_CHANNELS as readonly string[]).includes(change.channel) && isMs(change.atMs);
}

/**
 * Records a person's grant for `provider` on consent text `textVersion`. The caller (the sidecar's
 * admin op) has already checked that the request came from an interactive terminal and that the
 * version is today's text. Granting the same version again changes nothing.
 */
export function grantProviderConsent(
  store: OpenStoreResult,
  input: { readonly provider: string; readonly textVersion: string; readonly party?: ConsentParty } & ProviderConsentChange,
): { readonly ok: true; readonly result: 'granted' | 'already-granted'; readonly textVersion: string; readonly auditSeq: number | null } | StoreRefusal {
  if (!isProviderId(input.provider) || !CONSENT_TEXT_VERSION_PATTERN.test(input.textVersion) || !checkChange(input)) return refuse('invalid-input');
  if (input.party !== undefined && input.party !== 'maker' && input.party !== 'host') return refuse('invalid-input');
  return write(store, ({ driver }) => {
    const before = rowOf(driver.prepare(`${SELECT} WHERE provider = ?`).get(input.provider));
    if (before !== undefined && before.state === 'granted' && before.textVersion === input.textVersion) {
      return { ok: true as const, result: 'already-granted' as const, textVersion: before.textVersion, auditSeq: null };
    }
    driver
      .prepare(
        `INSERT INTO provider_consent (provider, state, text_version, granted_at_ms, revoked_at_ms, revoked_by) VALUES (?, 'granted', ?, ?, NULL, NULL)
         ON CONFLICT (provider) DO UPDATE SET state = 'granted', text_version = excluded.text_version, granted_at_ms = excluded.granted_at_ms, revoked_at_ms = NULL, revoked_by = NULL`,
      )
      .run(input.provider, input.textVersion, input.atMs);
    const audit = appendAuditRow(
      driver,
      { kind: 'provider-consent.grant', actor: input.actor, channel: input.channel, atMs: input.atMs },
      { provider: input.provider, party: input.party ?? 'maker', textVersion: input.textVersion, replaced: before === undefined ? 'none' : before.state === 'granted' ? 'older-text' : 'revoked' },
    );
    return { ok: true as const, result: 'granted' as const, textVersion: input.textVersion, auditSeq: audit.seq };
  });
}

function changed(result: unknown): boolean {
  const changes: unknown = result !== null && typeof result === 'object' ? Reflect.get(result, 'changes') : undefined;
  return (typeof changes === 'number' && changes > 0) || (typeof changes === 'bigint' && changes > 0n);
}

/** The text version and grant time of a revoke stored without an earlier grant. */
export const NEVER_GRANTED_TEXT_VERSION = 'none';

/**
 * Revokes one provider's consent, or every one with `provider: 'all'`. Only tightens.
 *
 * A revoke is stored even when the provider was never granted (text version `none`, grant time 0),
 * because a provider allowed only by the signed-in default must also be refusable, and the stored
 * revoke is what blocks it (B's routing review). With `all`, every granted row is revoked, and so is
 * each id in `knownProviders` (the caller passes the registry's providers and the pinned serving
 * hosts). A provider already revoked is left as it is. `hosts` (the pinned serving hosts) only
 * labels the audit row's `parties`.
 */
export function revokeProviderConsent(
  store: OpenStoreResult,
  input: { readonly provider: string; readonly knownProviders?: readonly string[]; readonly hosts?: readonly string[] } & ProviderConsentChange,
): { readonly ok: true; readonly result: 'revoked' | 'not-granted'; readonly providers: readonly string[]; readonly auditSeq: number | null } | StoreRefusal {
  const all = input.provider === 'all';
  if ((!all && !isProviderId(input.provider)) || !checkChange(input)) return refuse('invalid-input');
  const known = all && Array.isArray(input.knownProviders) ? input.knownProviders.filter(isProviderId).slice(0, 256) : [];
  const hosts = new Set(Array.isArray(input.hosts) ? input.hosts.filter(isProviderId).slice(0, 256) : []);
  // Revocation must work even while owned automation is stopped: it only narrows what may leave.
  return write(
    store,
    ({ driver }) => {
      const current = new Map((driver.prepare(`${SELECT} ORDER BY provider`).all() as readonly unknown[]).map(rowOf).filter((row): row is ProviderConsentRow => row !== undefined).map((row) => [row.provider, row] as const));
      const targets = all ? [...new Set([...[...current.values()].filter((row) => row.state === 'granted').map((row) => row.provider), ...known])].sort() : [input.provider];
      // One upsert per target: a granted row turns revoked, a missing row is stored revoked, and a
      // row already revoked (or one this reader cannot parse but is not granted) is left alone.
      const upsert = driver.prepare(
        `INSERT INTO provider_consent (provider, state, text_version, granted_at_ms, revoked_at_ms, revoked_by) VALUES (?, 'revoked', '${NEVER_GRANTED_TEXT_VERSION}', 0, ?, 'user')
         ON CONFLICT(provider) DO UPDATE SET state = 'revoked', revoked_at_ms = excluded.revoked_at_ms, revoked_by = 'user' WHERE provider_consent.state = 'granted'`,
      );
      const providers = targets.filter((provider) => current.get(provider)?.state !== 'revoked' && changed(upsert.run(provider, input.atMs)));
      if (providers.length === 0) return { ok: true as const, result: 'not-granted' as const, providers, auditSeq: null };
      const audit = appendAuditRow(driver, { kind: 'provider-consent.revoke', actor: input.actor, channel: input.channel, atMs: input.atMs }, { providers: providers.slice(0, 64), parties: providers.slice(0, 64).map((provider) => (hosts.has(provider) ? 'host' : 'maker')) });
      return { ok: true as const, result: 'revoked' as const, providers, auditSeq: audit.seq };
    },
    { ignoreAutomationRefusal: true },
  );
}
