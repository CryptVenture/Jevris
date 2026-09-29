/**
 * Governance records in the store.
 *
 * - GOV-10: an append-only, hash-chained audit log. Each row's hash covers the previous
 *   hash and the row, so an edit or a removed row breaks `verifyAuditChain`. Triggers refuse
 *   UPDATE and DELETE. Details are content-free: ids, codes, counts and short labels only.
 * - GOV-09: authorization receipts (principal, action class, scope, expiry, channel). Only
 *   the `terminal` channel can mint one (the CLI checks for an interactive terminal first);
 *   each carries a MAC under a per-store key file, is single-use and expires.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { StoreStop, field, isId, isMs, num, read, refuse, str, write } from './access.js';
import type { SqlDriver } from './schema.js';

export const AUDIT_KINDS = [
  'policy.load',
  'policy.change',
  'kill-switch.activate',
  'kill-switch.clear',
  'kill-switch.drill',
  'egress.decision',
  // `jevris egress approve|revoke`: the user approved scoped source egress in host.json, or took it back.
  'egress.enable',
  'egress.revoke',
  'credential.set',
  'credential.remove',
  'credential.read',
  'data.delete',
  'data.purge',
  'retention.sweep',
  'authorization.mint',
  'authorization.consume',
  'store.backup',
  'store.restore',
  'store.migrate',
  // DATA-10: `jevris store adopt` re-stamped a same-user, same-home store with this machine's scope.
  'store.adopt',
  'owned-effect.reconcile',
  // OBS-02: the time-limited diagnostic mode turned on or off.
  'diagnostic.change',
  // Per-provider egress consent (owner 7be3c43, OD-4): a person granted or revoked a provider.
  'provider-consent.grant',
  'provider-consent.revoke',
  // Session-to-task links (owner 29423b6): a person or the sidecar linked a harness session to a task, or it was unlinked.
  'session.link',
  'session.unlink',
  // Access limits R78: a person cleared access-limit entries (`jevris route limits clear`); count and classes only.
  'access-limit.clear',
  // A person re-enabled Jev after a billing (402) or account (403) disable (`jevris credential reenable`); count and reason class only.
  'credential.reenable',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AUDIT_CHANNELS = ['terminal', 'cli', 'sidecar', 'mcp', 'hook', 'system', 'managed-policy'] as const;
export type AuditChannel = (typeof AUDIT_CHANNELS)[number];

export type AuditDetail = { readonly [key: string]: string | number | boolean | null | readonly string[] };

export interface AuditRow {
  readonly seq: number;
  readonly atMs: number;
  readonly kind: AuditKind;
  readonly actor: string;
  readonly channel: AuditChannel;
  readonly detail: AuditDetail;
  readonly prevHash: string;
  readonly hash: string;
}

export const AUDIT_GENESIS = '0'.repeat(64);
const DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const DETAIL_VALUE = /^[A-Za-z0-9 _.:/@+,=-]{0,160}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

/** Accepts only short, content-free detail values (ids, codes, counts, labels). */
export function cleanDetail(detail: unknown): AuditDetail | undefined {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const out: Record<string, string | number | boolean | null | readonly string[]> = {};
  const keys = Object.keys(detail).sort();
  if (keys.length > 24) return undefined;
  for (const key of keys) {
    if (!DETAIL_KEY.test(key)) return undefined;
    const value: unknown = (detail as Record<string, unknown>)[key];
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && DETAIL_VALUE.test(value)) out[key] = value;
    else if (Array.isArray(value) && value.length <= 64 && value.every((v) => typeof v === 'string' && DETAIL_VALUE.test(v))) out[key] = [...(value as string[])];
    else return undefined;
  }
  return out;
}

function rowHash(prevHash: string, seq: number, atMs: number, kind: string, actor: string, channel: string, detailText: string): string {
  return createHash('sha256').update(`${prevHash}\n${String(seq)}\n${String(atMs)}\n${kind}\n${actor}\n${channel}\n${detailText}`).digest('hex');
}

export interface AuditInput {
  readonly kind: AuditKind;
  readonly actor: string;
  readonly channel: AuditChannel;
  readonly detail?: AuditDetail;
  readonly atMs: number;
}

/** Appends inside an existing transaction (used by other store writes). */
export function appendAuditRow(driver: SqlDriver, input: AuditInput, detail: AuditDetail): { readonly seq: number; readonly hash: string } {
  const last = driver.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get();
  const seq = (num(field(last, 'seq')) ?? 0) + 1;
  const prevHash = str(field(last, 'hash')) ?? AUDIT_GENESIS;
  const detailText = JSON.stringify(detail);
  const hash = rowHash(prevHash, seq, input.atMs, input.kind, input.actor, input.channel, detailText);
  driver
    .prepare('INSERT INTO audit_log (seq, at_ms, kind, actor, channel, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(seq, input.atMs, input.kind, input.actor, input.channel, detailText, prevHash, hash);
  return { seq, hash };
}

export function appendAudit(store: OpenStoreResult, input: AuditInput): { readonly ok: true; readonly seq: number; readonly hash: string } | StoreRefusal {
  const detail = cleanDetail(input.detail ?? {});
  if (!(AUDIT_KINDS as readonly string[]).includes(input.kind) || !(AUDIT_CHANNELS as readonly string[]).includes(input.channel)) return refuse('invalid-input');
  if (typeof input.actor !== 'string' || !ACTOR.test(input.actor) || detail === undefined || !isMs(input.atMs)) return refuse('invalid-input');
  // The audit log keeps working when owned automation is stopped: it records the stop.
  return write(store, ({ driver }) => ({ ok: true as const, ...appendAuditRow(driver, input, detail) }), { ignoreAutomationRefusal: true });
}

function auditRow(row: unknown): AuditRow | undefined {
  const seq = num(field(row, 'seq'));
  const detailText = str(field(row, 'detail'));
  if (seq === undefined || detailText === undefined) return undefined;
  let detail: AuditDetail = {};
  try {
    detail = JSON.parse(detailText) as AuditDetail;
  } catch {
    detail = {};
  }
  return {
    seq,
    atMs: num(field(row, 'at_ms')) ?? 0,
    kind: (str(field(row, 'kind')) ?? '') as AuditKind,
    actor: str(field(row, 'actor')) ?? '',
    channel: (str(field(row, 'channel')) ?? '') as AuditChannel,
    detail,
    prevHash: str(field(row, 'prev_hash')) ?? '',
    hash: str(field(row, 'hash')) ?? '',
  };
}

export function readAudit(store: OpenStoreResult, filter: { readonly sinceSeq?: number; readonly kinds?: readonly AuditKind[] } = {}): readonly AuditRow[] {
  const result = read(store, ({ driver }) =>
    driver
      .prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq')
      .all(filter.sinceSeq ?? 0)
      .map(auditRow)
      .filter((r): r is AuditRow => r !== undefined && (filter.kinds === undefined || filter.kinds.includes(r.kind))),
  );
  return Array.isArray(result) ? result : [];
}

/** Recomputes the chain. Any edited, reordered or missing row breaks it. */
export function verifyAuditChain(store: OpenStoreResult): { readonly ok: true; readonly count: number; readonly head: string } | { readonly ok: false; readonly brokenAt: number } | StoreRefusal {
  return read(store, ({ driver }) => {
    let prev = AUDIT_GENESIS;
    let expected = 1;
    let count = 0;
    for (const raw of driver.prepare('SELECT * FROM audit_log ORDER BY seq').all()) {
      const seq = num(field(raw, 'seq')) ?? -1;
      const detailText = str(field(raw, 'detail')) ?? '';
      const hash = rowHash(prev, seq, num(field(raw, 'at_ms')) ?? 0, str(field(raw, 'kind')) ?? '', str(field(raw, 'actor')) ?? '', str(field(raw, 'channel')) ?? '', detailText);
      if (seq !== expected || field(raw, 'prev_hash') !== prev || field(raw, 'hash') !== hash) return { ok: false as const, brokenAt: seq };
      prev = hash;
      expected += 1;
      count += 1;
    }
    return { ok: true as const, count, head: prev };
  });
}

/** JSONL export of the audit log with its hashes (`jevris audit export`). */
export function exportAuditJsonl(store: OpenStoreResult): string {
  return readAudit(store)
    .map((r) => `${JSON.stringify({ seq: r.seq, atMs: r.atMs, kind: r.kind, actor: r.actor, channel: r.channel, detail: r.detail, prevHash: r.prevHash, hash: r.hash })}\n`)
    .join('');
}

// ---------------------------------------------------------------- authorization receipts

export const AUTHORIZATION_ACTIONS = ['task.exception', 'kill-switch.clear', 'data.delete', 'policy.change', 'credential.set', 'budget.increase'] as const;
export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];
export const AUTHORIZATION_MAX_TTL_MS = 15 * 60_000;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.:*-]{0,191}$/;

function keyPath(dbPath: string): string {
  return `${dbPath}.authz-key`;
}

const keys = new Map<string, Uint8Array>();

/** The per-store MAC key (32 random bytes, owner-only file next to the db). */
export function authorizationKey(store: OpenStoreResult): Uint8Array | undefined {
  if (!store.ok) return undefined;
  const cached = keys.get(store.resolvedPath);
  if (cached !== undefined) return cached;
  const path = keyPath(store.resolvedPath);
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined) {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeSync(fd, randomBytes(32).toString('hex'));
      } finally {
        closeSync(fd);
      }
    } else if (!st.isFile() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) {
      if (!st.isFile()) return undefined;
      chmodSync(path, 0o600);
    }
    const text = readFileSync(path, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(text)) return undefined;
    const key = new TextEncoder().encode(text);
    keys.set(store.resolvedPath, key);
    return key;
  } catch {
    return undefined;
  }
}

function authorizationMac(key: Uint8Array, id: string, principal: string, action: string, scope: string, channel: string, issued: number, expires: number): string {
  return createHmac('sha256', key).update(`jevris-authorization-1\n${id}\n${principal}\n${action}\n${scope}\n${channel}\n${String(issued)}\n${String(expires)}`).digest('hex');
}

export interface MintInput {
  readonly principal: string;
  readonly actionClass: AuthorizationAction;
  readonly scope: string;
  readonly ttlMs: number;
  /** Only `terminal` mints: a frame, MCP call or hook cannot create a receipt. */
  readonly channel: string;
  readonly nowMs: number;
}

export function mintAuthorization(store: OpenStoreResult, input: MintInput): { readonly ok: true; readonly authorizationId: string; readonly expiresAtMs: number } | StoreRefusal {
  if (input.channel !== 'terminal') return refuse('production-writer-closed');
  if (!isId(input.principal) || !(AUTHORIZATION_ACTIONS as readonly string[]).includes(input.actionClass) || !SCOPE.test(input.scope) || !isMs(input.nowMs)) return refuse('invalid-input');
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > AUTHORIZATION_MAX_TTL_MS) return refuse('invalid-input');
  const key = authorizationKey(store);
  if (key === undefined) return refuse('store-unavailable');
  const authorizationId = `a${randomBytes(12).toString('hex')}`;
  const expiresAtMs = input.nowMs + input.ttlMs;
  return write(
    store,
    ({ driver }) => {
      const mac = authorizationMac(key, authorizationId, input.principal, input.actionClass, input.scope, 'terminal', input.nowMs, expiresAtMs);
      driver
        .prepare('INSERT INTO authorization_receipt (authorization_id, principal, action_class, scope, channel, issued_at_ms, expires_at_ms, mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(authorizationId, input.principal, input.actionClass, input.scope, 'terminal', input.nowMs, expiresAtMs, mac);
      appendAuditRow(driver, { kind: 'authorization.mint', actor: input.principal, channel: 'terminal', atMs: input.nowMs }, { action: input.actionClass, scope: input.scope, authorizationId, expiresAtMs });
      return { ok: true as const, authorizationId, expiresAtMs };
    },
    { ignoreAutomationRefusal: true },
  );
}

export interface ConsumeInput {
  readonly authorizationId: string;
  readonly principal: string;
  readonly actionClass: AuthorizationAction;
  readonly scope: string;
  readonly nowMs: number;
}

/**
 * Consumes a receipt inside the caller's transaction. True only for an unexpired, unused
 * receipt minted on the terminal channel for exactly this principal, action and scope, with
 * a valid MAC. Returns false otherwise (and writes nothing).
 */
export function consumeAuthorization(driver: SqlDriver, input: ConsumeInput, key: Uint8Array | undefined): boolean {
  if (key === undefined) return false;
  const row = driver.prepare('SELECT * FROM authorization_receipt WHERE authorization_id = ?').get(input.authorizationId);
  if (row === undefined) return false;
  const principal = str(field(row, 'principal')) ?? '';
  const action = str(field(row, 'action_class')) ?? '';
  const scope = str(field(row, 'scope')) ?? '';
  const channel = str(field(row, 'channel')) ?? '';
  const issued = num(field(row, 'issued_at_ms')) ?? 0;
  const expires = num(field(row, 'expires_at_ms')) ?? 0;
  const mac = str(field(row, 'mac')) ?? '';
  if (principal !== input.principal || action !== input.actionClass || scope !== input.scope || channel !== 'terminal') return false;
  if (field(row, 'consumed_at_ms') !== null || input.nowMs >= expires || input.nowMs < issued) return false;
  const expected = authorizationMac(key, input.authorizationId, principal, action, scope, channel, issued, expires);
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  driver.prepare('UPDATE authorization_receipt SET consumed_at_ms = ? WHERE authorization_id = ? AND consumed_at_ms IS NULL').run(input.nowMs, input.authorizationId);
  appendAuditRow(driver, { kind: 'authorization.consume', actor: principal, channel: 'sidecar', atMs: input.nowMs }, { action, scope, authorizationId: input.authorizationId });
  return true;
}

/** Standalone consume (its own transaction), for commands that act outside the task model. */
export function useAuthorization(store: OpenStoreResult, input: ConsumeInput): { readonly ok: true } | StoreRefusal {
  if (!isId(input.authorizationId) || !isId(input.principal) || !isMs(input.nowMs)) return refuse('invalid-input');
  const key = authorizationKey(store);
  return write(
    store,
    ({ driver }) => {
      if (!consumeAuthorization(driver, input, key)) throw new StoreStop('production-writer-closed');
      return { ok: true as const };
    },
    { ignoreAutomationRefusal: true },
  );
}
