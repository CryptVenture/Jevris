/**
 * Access limits in every harness (coordinator decision 1e88b2b and its open points bdfb6e3a;
 * design `.planning/research/access-limits.md` sections 4, 5, 7 and 9; SPEC C53, §19.4 and the
 * §17.3 429/529 row). One machine record of what ran out, keyed by the scope that ran out, and the
 * one check every actuator and adviser makes before it routes or launches.
 *
 * - Classes. `rate-limit` (a short 429), `usage-window` (a subscription 5-hour or weekly allowance,
 *   or an API-key quota window), `credit-exhausted` and `account-blocked` pause. `overloaded` (529,
 *   5xx) never pauses: it is bounded retry and a circuit, never recorded here. Model gone and model
 *   not accessible stay in `model-availability.json`. None of these is a model-quality outcome.
 * - Scope. Harness + auth mode + serving host (the maker for a direct model, a pinned gateway
 *   otherwise), plus a model only for a `rate-limit` and a family only for a signal that names one
 *   (Claude's Opus or Sonnet weekly limit). An `unknown` auth mode on either side matches both, so
 *   it only ever pauses more. A scope Jevris cannot name (an unpinned host, a redirected endpoint)
 *   records nothing (ACCESS_SCOPE_UNKNOWN, OP-12).
 * - Detection. `ACCESS_SIGNALS` is the one table of rows per port; `classifyAccessSignal` maps a
 *   port's in-memory signal to a row. Structured fields decide first; a pinned text pattern (only its
 *   id and the booleans and times contracts' `matchAccessText` extracted) is consulted only when no
 *   structured row classified it. A text-only credit or blocked signal is held as a timed
 *   usage-window until a capture certifies that row (OP-4), so a reworded or forged message cannot
 *   pause a provider for ever. No message, body, header value or account detail is accepted here.
 * - Timing (integer ms). rate-limit: the reported reset, else 60 s doubling per re-hit to 1 h
 *   (OP-1); a reported reset more than 1 h away makes it a usage-window. usage-window: the reported
 *   reset if it is in the future and at most 8 days away, else `base x 2^step` capped at 7 days,
 *   with `base` = the learning setting `limitCooldownHours` (5 h by default, OP-11); a weekly signal
 *   uses 7 days. credit-exhausted and account-blocked: no expiry.
 * - Record. `<data>/route-learning/access-limits.json` (schema `jevris-access-limits-1`), one per
 *   machine, written with `durableWrite` at 0600 in a 0700 directory under the route-learning file
 *   lock (a lock older than 10 s is taken over). At most 128 entries and 65,536 bytes; a missing,
 *   oversized or malformed file reads as empty (fail-open on purpose: the vendor enforces its own
 *   limit, a pause only saves a rejected launch, and it is never a safety control).
 * - Clearing. A timed pause expires at read time. Untimed ones clear on a new credential fingerprint
 *   for the scope, and every class clears on an observed success on the exact scope (OP-2), or with
 *   `jevris route limits clear` (B's R78). Jevris never spends a probe to test a pause.
 * - Usage reading (OP-6). A harness's own structured account reading (Codex's
 *   account/rateLimits/read) sets a timed usage-window for an exhausted window and, when certified
 *   with none exhausted, lifts that sign-in's usage windows (access-usage.ts; only bands are kept).
 * - Fingerprint. `credentialFingerprint` is the Jev circuit's rule: the first 16 hex digits of a
 *   label-prefixed SHA-256 of a key the caller already holds in memory. It is never computed from a
 *   harness's credential file, keychain entry or OAuth token.
 */
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ACCESS_AUTH_MODES,
  ACCESS_LIMIT_SOURCES,
  ACCESS_PAUSE_CLASSES,
  ACCESS_SERVING_HOSTS,
  ACCESS_SIGNAL_PORTS,
  ACCESS_TEXT_PATTERN_IDS,
  HARNESS_IDS,
  MODEL_ID_PATTERN,
  resetFromHeaders,
  servingHostOf,
  sha256Hex,
  type AccessAuthMode,
  type AccessLimitClass,
  type AccessPauseClass,
  type AccessScope,
  type AccessSignal,
  type AccessSignalPort,
  type AccessTextMatch,
  type AccessTextPatternId,
  type HarnessId,
  type ModelRegistry,
} from '@jevris/contracts';
import { durableWrite, jevrisPaths, readFileNoFollow } from '@jevris/platform';
import { resolveSpelling } from './harness-model-id.js';
import { registryModel } from './model-registry.js';
import { withFileLock } from './route-file-lock.js';

export const ACCESS_LIMITS_SCHEMA = 'jevris-access-limits-1' as const;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The timing rules (design 4.2, OP-1, OP-11). Integer milliseconds. */
export const ACCESS_TIMING = Object.freeze({
  /** A rate limit with no reported reset: 60 s, doubling per re-hit after expiry (OP-1). */
  rateLimitBaseMs: MINUTE,
  /** ...up to 1 h. A reported reset further away than this makes the signal a usage-window. */
  rateLimitCapMs: HOUR,
  /** The usage-window base when the learning setting gives none (`limitCooldownHours`, OP-11). */
  defaultBaseHours: 5,
  /** The clamp of that base, as `learningSettings` clamps it. */
  minBaseHours: 0.25,
  maxBaseHours: 24 * 7,
  /** A usage-window by rule never runs longer than 7 days, and a weekly signal uses exactly that. */
  usageWindowCapMs: 7 * DAY,
  weeklyMs: 7 * DAY,
  /** A reported reset in the past or more than 8 days away is ignored, and the rule applies. */
  maxReportedAheadMs: 8 * DAY,
  /** A re-hit more than 7 days after the last expiry starts the doubling again. */
  stepResetAfterMs: 7 * DAY,
  /** An expired entry is dropped 7 days after it expired (it kept its step history for a week). */
  pruneAfterMs: 7 * DAY,
  maxStep: 6,
});

/** The record's caps (design 4.3). */
export const ACCESS_LIMITS_CAPS = Object.freeze({ maxEntries: 128, maxBytes: 65_536 });

// ---------------------------------------------------------------------------------------------
// The signal table (design 5.2).

export interface AccessSignalRow {
  readonly port: AccessSignalPort;
  /** The row id, recorded as the entry's `signal`: never the error text. */
  readonly signal: string;
  /** What the row means; null for a row that is recognised and deliberately not a pause. */
  readonly class: AccessLimitClass | null;
  /** True for a structured field (a status, an error type or code, an enum); false for a pinned text pattern. */
  readonly structured: boolean;
  /**
   * True where the port's channel is not proven for this harness version (Antigravity's text):
   * until a certify capture proves it, the text's own reset is not trusted (the rule applies).
   */
  readonly needsCertifiedBinary: boolean;
  /** What the port matches, for D and F. */
  readonly detects: string;
}

const CLAUDE_STREAM_PORTS = ['claude', 'claude-api'] as const;
const SESSION_API_PORTS = ['kilocode', 'opencode'] as const;

function claudeStreamRows(port: AccessSignalPort): AccessSignalRow[] {
  const s = (signal: string, cls: AccessLimitClass | null, detects: string): AccessSignalRow => ({ port, signal: `${port}.${signal}`, class: cls, structured: true, needsCertifiedBinary: false, detects });
  return [
    s('stream.rate-limit-event.five-hour', 'usage-window', 'rate_limit_event with rate_limit_info.status "rejected" and rateLimitType "five_hour"; reset from resetsAt'),
    s('stream.rate-limit-event.seven-day', 'usage-window', 'rate_limit_event "rejected" with rateLimitType "seven_day": weekly'),
    s('stream.rate-limit-event.seven-day-family', 'usage-window', 'rate_limit_event "rejected" with rateLimitType "seven_day_opus" or "seven_day_sonnet": weekly, for that family'),
    s('stream.rate-limit-event.other', 'usage-window', 'rate_limit_event "rejected" with rateLimitType "overage" or none; reset from resetsAt'),
    s('stream.error.billing', 'credit-exhausted', 'the last system/api_retry error or assistant error "billing_error", in a run with no successful result'),
    s('stream.error.auth', 'account-blocked', 'api_retry or assistant error "authentication_failed", "oauth_org_not_allowed" or "account_on_hold"'),
    s('stream.error.rate-limit', 'usage-window', 'api_retry or assistant error "rate_limit": a usage-window on a subscription, a rate-limit on an API key or unknown sign-in'),
    s('stream.error.overloaded', 'overloaded', 'api_retry or assistant error "overloaded" or "server_error"'),
    s('stream.error.none', null, 'api_retry or assistant error "model_not_found" (model-availability), "cloud_credential_error", "invalid_request", "max_output_tokens" or "unknown": not a pause'),
  ];
}

function textRows(port: AccessSignalPort, ids: readonly [AccessTextPatternId, AccessLimitClass][], certified: boolean, where: string): AccessSignalRow[] {
  return ids.map(([id, cls]) => ({ port, signal: `${port}.text.${id.toLowerCase()}`, class: cls, structured: false, needsCertifiedBinary: certified, detects: `pinned pattern ${id} on ${where}` }));
}

const C_PATTERNS: readonly [AccessTextPatternId, AccessLimitClass][] = [
  ['C1', 'usage-window'], ['C2', 'credit-exhausted'], ['C3', 'rate-limit'], ['C4', 'account-blocked'], ['C5', 'credit-exhausted'], ['C6', 'overloaded'],
];

function sessionApiRows(port: AccessSignalPort): AccessSignalRow[] {
  const s = (signal: string, cls: AccessLimitClass | null, detects: string): AccessSignalRow => ({ port, signal: `${port}.${signal}`, class: cls, structured: true, needsCertifiedBinary: false, detects });
  return [
    s('error.provider-auth', 'account-blocked', 'an error named "ProviderAuthError"'),
    s('api-error.402', 'credit-exhausted', 'an "APIError" with statusCode 402'),
    s('api-error.401', 'account-blocked', 'an "APIError" with statusCode 401'),
    s('api-error.body-code.credit', 'credit-exhausted', 'an "APIError" 429 or 403 whose bounded body parse gave a credit code (billing_error, enforced_spend_limit_reached, insufficient_quota and its spend codes, Z.ai 1113, Moonshot exceeded_current_quota_error)'),
    s('api-error.body-code.rate', 'rate-limit', 'an "APIError" 429 or 403 whose body code is slow_down, rate_limit_exceeded, Z.ai 1302 or Moonshot rate_limit_reached_error'),
    s('api-error.body-code.window', 'usage-window', 'an "APIError" 429 or 403 whose body code is Z.ai 1308 or 1316-1321'),
    s('api-error.body-code.weekly', 'usage-window', 'an "APIError" 429 or 403 whose body code is Z.ai 1310: weekly'),
    s('api-error.body-code.overloaded', 'overloaded', 'an "APIError" whose body code is Z.ai 1305'),
    s('api-error.429', 'rate-limit', 'an "APIError" 429 with no known body code; reset from responseHeaders'),
    s('api-error.5xx', 'overloaded', 'an "APIError" with statusCode 529 or 5xx'),
    ...textRows(port, [['X2', 'credit-exhausted'], ['X3', 'account-blocked'], ...C_PATTERNS], false, 'data.message, only when no structured row matched'),
  ];
}

/**
 * The one table (design 5.2). D and F detect in memory and pass an `AccessSignal`; only the row id,
 * the class and times are ever kept.
 */
export const ACCESS_SIGNALS: readonly AccessSignalRow[] = Object.freeze([
  ...CLAUDE_STREAM_PORTS.flatMap((port) => claudeStreamRows(port)),
  ...textRows('claude', C_PATTERNS, false, 'an is_error result\'s text'),
  { port: 'claude-api', signal: 'claude-api.http.402', class: 'credit-exhausted', structured: true, needsCertifiedBinary: false, detects: 'an APIError with status 402 (billing_error)' },
  { port: 'claude-api', signal: 'claude-api.http.429-spend-limit', class: 'credit-exhausted', structured: true, needsCertifiedBinary: false, detects: 'status 429 with details.error_code "enforced_spend_limit_reached" (a monthly spend cap)' },
  { port: 'claude-api', signal: 'claude-api.http.429', class: 'rate-limit', structured: true, needsCertifiedBinary: false, detects: 'status 429 rate_limit_error; reset from the headers' },
  { port: 'claude-api', signal: 'claude-api.http.400-credit-balance', class: 'credit-exhausted', structured: true, needsCertifiedBinary: false, detects: 'status 400 invalid_request_error whose message matches C5 ("credit balance is too low")' },
  { port: 'claude-api', signal: 'claude-api.http.401', class: 'account-blocked', structured: true, needsCertifiedBinary: false, detects: 'status 401 authentication_error' },
  { port: 'claude-api', signal: 'claude-api.http.overloaded', class: 'overloaded', structured: true, needsCertifiedBinary: false, detects: 'status 529 or 5xx' },
  ...textRows('codex', [['X1', 'usage-window'], ['X2', 'credit-exhausted'], ['X3', 'account-blocked'], ['X4', 'rate-limit'], ['X5', 'overloaded']], false, 'turn.failed.error.message, else error.message, else the last 4 KiB of stderr of a run that exited non-zero with no event'),
  ...SESSION_API_PORTS.flatMap((port) => sessionApiRows(port)),
  // G4-G8 (coordinator, D's access trace; G8 is E's 10c39931): the Gemini API's public error sentences (ai.google.dev
  // gemini-api/docs/api-errors and troubleshooting), text-only and uncertified, so a credit or
  // blocked match is held as a timed usage window (OP-4) and no stated reset is trusted.
  ...textRows('antigravity', [['G1', 'usage-window'], ['G2', 'usage-window'], ['G4', 'credit-exhausted'], ['G5', 'account-blocked'], ['G8', 'account-blocked'], ['G6', 'rate-limit'], ['G7', 'overloaded']], true, 'a non-SUCCESS result\'s error, else the last 4 KiB of stderr of a failed run'),
  // OP-6 (owner, DOMAINS 9deb30c8): Codex's own structured usage reading, read-only, in the
  // app-server session the model listing already opens (access-usage.ts). Only a band is kept.
  { port: 'codex', signal: 'codex.usage-read.window', class: 'usage-window', structured: true, needsCertifiedBinary: false, detects: 'account/rateLimits/read: a window at 100% used or more; reset from resets_at' },
  { port: 'codex', signal: 'codex.usage-read.weekly', class: 'usage-window', structured: true, needsCertifiedBinary: false, detects: 'account/rateLimits/read: a weekly window (6 days or longer) at 100% used or more; reset from resets_at' },
] satisfies readonly AccessSignalRow[]);

const ROW_BY_ID: ReadonlyMap<string, AccessSignalRow> = new Map(ACCESS_SIGNALS.map((r) => [r.signal, r]));

/** Body codes (design 5.2), read from a bounded parse by the port; the table is host-independent. */
const BODY_CODES: { readonly [code: string]: 'credit' | 'rate' | 'window' | 'weekly' | 'overloaded' } = Object.freeze({
  billing_error: 'credit',
  enforced_spend_limit_reached: 'credit',
  insufficient_quota: 'credit',
  credit_balance_exhausted: 'credit',
  organization_spend_limit_exceeded: 'credit',
  project_spend_limit_exceeded: 'credit',
  organization_usage_limit_exceeded: 'credit',
  exceeded_current_quota_error: 'credit',
  '1113': 'credit',
  slow_down: 'rate',
  rate_limit_exceeded: 'rate',
  rate_limit_reached_error: 'rate',
  '1302': 'rate',
  '1308': 'window',
  '1316': 'window',
  '1317': 'window',
  '1318': 'window',
  '1319': 'window',
  '1320': 'window',
  '1321': 'window',
  '1310': 'weekly',
  '1305': 'overloaded',
});

// ---------------------------------------------------------------------------------------------
// Reset headers: resetFromHeaders lives in contracts, so the hook reads a reset without core
// (coordinator's approval, access trace item 3); re-exported here for core's callers.

export { resetFromHeaders } from '@jevris/contracts';

// ---------------------------------------------------------------------------------------------
// The fingerprint (design 4.4; the Jev circuit's rule, formerly inline in sidecar-engine.ts).

/**
 * A non-secret label for a credential the caller already holds in memory: the first 16 hex digits
 * of SHA-256 over `jevris-credential\n` + the key. Null for an empty or non-string credential.
 * Never computed from a harness's credential file, keychain entry or OAuth token.
 */
export function credentialFingerprint(credential: string | null | undefined): string | null {
  if (typeof credential !== 'string' || credential.trim().length === 0) return null;
  return sha256Hex(`jevris-credential\n${credential}`).slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Classification (design 5.1-5.5).

export interface AccessClassification {
  readonly class: AccessLimitClass;
  /** The `ACCESS_SIGNALS` row id. */
  readonly signal: string;
  readonly structured: boolean;
  readonly weekly: boolean;
  /** True for a `rate-limit`: it pauses only the run's model. */
  readonly modelScoped: boolean;
  /** The family a signal names (Claude's Opus or Sonnet weekly limit), else null. */
  readonly family: string | null;
  /** A reported reset that is in the future and at most 8 days away (else null). */
  readonly reportedResetMs: number | null;
  /** The pause end at step 0 (null: no expiry). The record recomputes it with the scope's step. */
  readonly untilMs: number | null;
  readonly resetBasis: 'reported' | 'rule' | 'none';
  /** OP-4: a text-only credit or blocked signal from an uncertified row, held as a timed usage-window. */
  readonly heldAsTimed: boolean;
}

/**
 * Every classification `classifyAccessSignal` issued, and whether its signal was certified (B's
 * LOW 24). `recordAccessLimit` records only these, frozen as issued: a hand-built or copied
 * classification is refused, so no caller can record a text row as an untimed pause or carry a
 * reset the classifier did not trust. A signal that crossed a process boundary (a worker outcome,
 * a hook's turn.failed) is classified again, in the process that records it.
 */
const ISSUED = new WeakMap<object, { readonly certified: boolean }>();

const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const tok = (v: unknown): string | undefined => (typeof v === 'string' && TOKEN.test(v) ? v : undefined);

function textMatchOf(v: unknown): AccessTextMatch | null {
  if (v === null || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (typeof t['pattern'] !== 'string' || !(ACCESS_TEXT_PATTERN_IDS as readonly string[]).includes(t['pattern'])) return null;
  const family = t['family'] === 'opus' || t['family'] === 'sonnet' ? t['family'] : null;
  const reset = typeof t['resetAtMs'] === 'number' && Number.isFinite(t['resetAtMs']) ? Math.round(t['resetAtMs']) : null;
  const form = t['resetForm'] === 'epoch' || t['resetForm'] === 'relative' || t['resetForm'] === 'zoneless-date' ? t['resetForm'] : null;
  return { pattern: t['pattern'] as AccessTextPatternId, weekly: t['weekly'] === true, family, resetAtMs: reset === null || form === null ? null : reset, resetForm: reset === null ? null : form };
}

function clampBaseHours(hours: number | undefined): number {
  const h = typeof hours === 'number' && Number.isFinite(hours) ? hours : ACCESS_TIMING.defaultBaseHours;
  return Math.min(ACCESS_TIMING.maxBaseHours, Math.max(ACCESS_TIMING.minBaseHours, h));
}

/**
 * The pause end for a class at a step (design 4.2). `null` for the untimed classes. Pure.
 */
export function accessUntilMs(input: {
  readonly class: AccessLimitClass;
  readonly nowMs: number;
  readonly step: number;
  readonly weekly: boolean;
  readonly reportedResetMs: number | null;
  /** `limitCooldownHours` (OP-11); 5 h by default, clamped to 0.25-168 h. */
  readonly baseHours?: number;
}): number | null {
  const step = Math.max(0, Math.min(ACCESS_TIMING.maxStep, Math.floor(input.step)));
  switch (input.class) {
    case 'credit-exhausted':
    case 'account-blocked':
      return null;
    case 'overloaded':
      return null;
    case 'rate-limit':
      if (input.reportedResetMs !== null) return input.reportedResetMs;
      return input.nowMs + Math.min(ACCESS_TIMING.rateLimitCapMs, ACCESS_TIMING.rateLimitBaseMs * 2 ** step);
    case 'usage-window':
      if (input.reportedResetMs !== null) return input.reportedResetMs;
      if (input.weekly) return input.nowMs + ACCESS_TIMING.weeklyMs;
      return input.nowMs + Math.min(ACCESS_TIMING.usageWindowCapMs, Math.round(clampBaseHours(input.baseHours) * HOUR * 2 ** step));
  }
}

function validReset(ms: number | null | undefined, nowMs: number): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const at = Math.round(ms);
  return at > nowMs && at - nowMs <= ACCESS_TIMING.maxReportedAheadMs ? at : null;
}

interface RowHit {
  readonly row: AccessSignalRow;
  readonly weekly: boolean;
  readonly family: string | null;
  readonly resetMs: number | null;
}

function structuredHit(signal: AccessSignal, authMode: AccessAuthMode, nowMs: number): RowHit | 'none' | null {
  const row = (id: string): AccessSignalRow => ROW_BY_ID.get(`${signal.port}.${id}`) as AccessSignalRow;
  const status = typeof signal.status === 'number' && Number.isSafeInteger(signal.status) && signal.status >= 100 && signal.status <= 599 ? signal.status : undefined;
  const errorType = tok(signal.errorType);
  const errorCode = tok(signal.errorCode);
  const headerReset = signal.headers === undefined ? null : resetFromHeaders(signal.headers, nowMs);
  const reported = typeof signal.resetAtMs === 'number' && Number.isFinite(signal.resetAtMs) ? Math.round(signal.resetAtMs) : headerReset;
  const hit = (r: AccessSignalRow, extra: Partial<Omit<RowHit, 'row'>> = {}): RowHit => ({ row: r, weekly: extra.weekly ?? false, family: extra.family ?? null, resetMs: extra.resetMs === undefined ? reported : extra.resetMs });
  switch (signal.port) {
    case 'claude':
    case 'claude-api': {
      if (errorType === 'rate_limit_event' && status === undefined) {
        const kind = tok(signal.rateLimitType);
        if (kind === 'five_hour') return hit(row('stream.rate-limit-event.five-hour'));
        if (kind === 'seven_day') return hit(row('stream.rate-limit-event.seven-day'), { weekly: true });
        if (kind === 'seven_day_opus' || kind === 'seven_day_sonnet') return hit(row('stream.rate-limit-event.seven-day-family'), { weekly: true, family: kind === 'seven_day_opus' ? 'opus' : 'sonnet' });
        return hit(row('stream.rate-limit-event.other'));
      }
      if (signal.port === 'claude-api' && status !== undefined) {
        if (status === 402) return hit(row('http.402'), { resetMs: null });
        if (status === 429 && errorCode === 'enforced_spend_limit_reached') return hit(row('http.429-spend-limit'), { resetMs: null });
        if (status === 429) return hit(row('http.429'));
        if (status === 400 && textMatchOf(signal.text)?.pattern === 'C5') return hit(row('http.400-credit-balance'), { resetMs: null });
        if (status === 401) return hit(row('http.401'), { resetMs: null });
        if (status === 529 || status >= 500) return hit(row('http.overloaded'));
        return null;
      }
      if (errorType === undefined || status !== undefined) return null;
      if (errorType === 'billing_error') return hit(row('stream.error.billing'), { resetMs: null });
      if (errorType === 'authentication_failed' || errorType === 'oauth_org_not_allowed' || errorType === 'account_on_hold') return hit(row('stream.error.auth'), { resetMs: null });
      if (errorType === 'rate_limit') {
        const r = row('stream.error.rate-limit');
        // An assistant `rate_limit` is a usage window only on a subscription (design 2.2).
        return authMode === 'subscription' ? hit(r) : hit({ ...r, class: 'rate-limit' });
      }
      if (errorType === 'overloaded' || errorType === 'server_error') return hit(row('stream.error.overloaded'));
      if (errorType === 'model_not_found') return 'none';
      if (['cloud_credential_error', 'invalid_request', 'max_output_tokens', 'unknown'].includes(errorType)) return null;
      return null;
    }
    case 'kilocode':
    case 'opencode': {
      if (errorType === 'ProviderAuthError') return hit(row('error.provider-auth'), { resetMs: null });
      if (errorType !== 'APIError' || status === undefined) return null;
      if (status === 402) return hit(row('api-error.402'), { resetMs: null });
      if (status === 401) return hit(row('api-error.401'), { resetMs: null });
      const body = errorCode === undefined ? undefined : BODY_CODES[errorCode];
      if ((status === 429 || status === 403) && body !== undefined) {
        if (body === 'credit') return hit(row('api-error.body-code.credit'), { resetMs: null });
        if (body === 'rate') return hit(row('api-error.body-code.rate'));
        if (body === 'window') return hit(row('api-error.body-code.window'));
        if (body === 'weekly') return hit(row('api-error.body-code.weekly'), { weekly: true });
        return hit(row('api-error.body-code.overloaded'));
      }
      if (status === 429) return hit(row('api-error.429'));
      if (status === 529 || status >= 500) return hit(row('api-error.5xx'));
      return null;
    }
    default:
      return null;
  }
}

function textHit(signal: AccessSignal): RowHit | null {
  const match = textMatchOf(signal.text);
  if (match === null || match.pattern === 'G3') return null;
  const row = ROW_BY_ID.get(`${signal.port}.text.${match.pattern.toLowerCase()}`);
  if (row === undefined || row.class === null) return null;
  // A time written without a zone (Codex's "try again at ...") is trusted only from a certified
  // capture of that form; before that the rule applies (design 5.3). An uncertified row of a port
  // whose channel is unproven (Antigravity) never trusts the text's time either.
  const trusted = signal.certified || (match.resetForm !== 'zoneless-date' && !row.needsCertifiedBinary);
  return { row, weekly: match.weekly, family: match.family, resetMs: trusted ? match.resetAtMs : null };
}

/**
 * Classifies one signal (design 5.2 and 5.5), or null when no row gives it a class. Structured
 * fields decide first; a text pattern only when no structured row matched. Pure; nothing of the
 * signal is kept but the row id, the class and the times.
 */
export function classifyAccessSignal(signal: AccessSignal, authMode: AccessAuthMode, nowMs: number, options: { readonly baseHours?: number } = {}): AccessClassification | null {
  if (signal === null || typeof signal !== 'object' || !Number.isFinite(nowMs)) return null;
  if (!(ACCESS_SIGNAL_PORTS as readonly string[]).includes(signal.port)) return null;
  const mode: AccessAuthMode = (ACCESS_AUTH_MODES as readonly string[]).includes(authMode) ? authMode : 'unknown';
  const structured = structuredHit(signal, mode, nowMs);
  if (structured === 'none') return null;
  const hit = structured ?? textHit(signal);
  if (hit === null || hit.row.class === null) return null;
  let cls: AccessLimitClass = hit.row.class;
  let reported = validReset(hit.resetMs, nowMs);
  let weekly = hit.weekly;
  let family = hit.family;
  let heldAsTimed = false;
  // A structured limit with no reset (Claude Code's StopFailure names only `rate_limit`): the reset,
  // the weekly marker and the family that the bounded text match states are taken, never the text,
  // and the row stays the structured one. OP-1 below then makes a reset more than 1 h away a usage
  // window. A text that names a usage window (C1: "session limit", "usage limit reached") with no
  // usable reset is the subscription window on the rule (OP-11's base), not a 60 s rate limit.
  if (hit.row.structured && reported === null && (cls === 'rate-limit' || cls === 'usage-window')) {
    const told = textHit(signal);
    if (told !== null && (told.row.class === 'rate-limit' || told.row.class === 'usage-window')) {
      reported = validReset(told.resetMs, nowMs);
      if (told.weekly) {
        weekly = true;
        cls = 'usage-window';
        if (family === null) family = told.family;
      } else if (told.row.class === 'usage-window' && reported === null) {
        cls = 'usage-window';
      }
    }
  }
  // OP-4: a text-only untimed signal from an uncertified row is held as a timed usage-window.
  if (!hit.row.structured && !signal.certified && (cls === 'credit-exhausted' || cls === 'account-blocked')) {
    cls = 'usage-window';
    reported = null;
    heldAsTimed = true;
  }
  // OP-1: a reported reset more than 1 h away is a usage window, not a short rate limit.
  if (cls === 'rate-limit' && reported !== null && reported - nowMs > ACCESS_TIMING.rateLimitCapMs) cls = 'usage-window';
  const untimed = cls === 'credit-exhausted' || cls === 'account-blocked';
  const untilMs = cls === 'overloaded' ? null : accessUntilMs({ class: cls, nowMs, step: 0, weekly, reportedResetMs: reported, ...(options.baseHours === undefined ? {} : { baseHours: options.baseHours }) });
  const issued: AccessClassification = Object.freeze({
    class: cls,
    signal: hit.row.signal,
    structured: hit.row.structured,
    weekly: cls === 'usage-window' && weekly,
    modelScoped: cls === 'rate-limit',
    family: cls === 'usage-window' ? family : null,
    reportedResetMs: untimed ? null : reported,
    untilMs,
    resetBasis: untimed || cls === 'overloaded' ? 'none' : reported !== null ? 'reported' : 'rule',
    heldAsTimed,
  });
  ISSUED.set(issued, { certified: signal.certified === true });
  return issued;
}


const USAGE_READ_ROWS: ReadonlySet<string> = new Set(['codex.usage-read.window', 'codex.usage-read.weekly']);

/** A usage reading lifts only entries last seen at least this long before it (B's stale-snapshot guard). */
export const USAGE_LIFT_GRACE_MS = 2 * MINUTE;

/**
 * The classification of one exhausted window of a usage reading (OP-6; access-usage.ts calls it):
 * a timed usage-window on its structured row, until the reported reset (validated as for any
 * signal) or by the rule. Never untimed, so it can only pause, and only until a time.
 */
export function issueUsageWindowClassification(input: { readonly harness: 'codex'; readonly weekly: boolean; readonly resetAtMs: number | null; readonly nowMs: number; readonly baseHours?: number }): AccessClassification {
  const weekly = input.weekly === true;
  const reported = validReset(input.resetAtMs, input.nowMs);
  const row = ROW_BY_ID.get(`${input.harness}.usage-read.${weekly ? 'weekly' : 'window'}`) as AccessSignalRow;
  const issued: AccessClassification = Object.freeze({
    class: 'usage-window',
    signal: row.signal,
    structured: true,
    weekly,
    modelScoped: false,
    family: null,
    reportedResetMs: reported,
    untilMs: accessUntilMs({ class: 'usage-window', nowMs: input.nowMs, step: 0, weekly, reportedResetMs: reported, ...(input.baseHours === undefined ? {} : { baseHours: input.baseHours }) }),
    resetBasis: reported !== null ? 'reported' : 'rule',
    heldAsTimed: false,
  });
  ISSUED.set(issued, { certified: false });
  return issued;
}

// ---------------------------------------------------------------------------------------------
// Scopes (design 4.1).

/** The serving host of a harness that reaches exactly one party (design 4.1). */
export const ACCESS_HARNESS_HOST: { readonly [harness: string]: string } = Object.freeze({ claude: 'anthropic', codex: 'openai', antigravity: 'google' });

/** What a check asks about: a candidate's scope. `harness: null` is any harness (advice that names none). */
export interface AccessQuery {
  readonly harness: HarnessId | null;
  readonly authMode: AccessAuthMode;
  readonly servingHost: string;
  readonly modelId: string | null;
  readonly family: string | null;
}

const MODEL_ID = new RegExp(MODEL_ID_PATTERN);
const FAMILY = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const HOSTS: readonly string[] = ACCESS_SERVING_HOSTS;
const FINGERPRINT = /^[0-9a-f]{16}$/;

function authOf(v: unknown): AccessAuthMode {
  return typeof v === 'string' && (ACCESS_AUTH_MODES as readonly string[]).includes(v) ? (v as AccessAuthMode) : 'unknown';
}

/**
 * The scope of a run or candidate: the harness, its sign-in, the serving host and the registry model
 * with its family. `spelling` is a registry model id or the harness's own spelling (Kilo and
 * OpenCode resolve it through the one resolver, `resolveSpelling`). Null when Jevris cannot name
 * the party (an unpinned host or an unregistered spelling): record nothing (ACCESS_SCOPE_UNKNOWN).
 * A redirected endpoint (a project `baseURL`, `ANTHROPIC_BASE_URL`) is the caller's check (OP-12).
 */
export function accessScopeOf(registry: ModelRegistry, harness: string, spelling: string, authMode: string): AccessQuery | null {
  if (!(HARNESS_IDS as readonly string[]).includes(harness) || typeof spelling !== 'string') return null;
  const h = harness as HarnessId;
  const fixed = ACCESS_HARNESS_HOST[h];
  let modelId: string | null = null;
  let host: string | null = null;
  const direct = registryModel(registry, spelling);
  if (fixed !== undefined) {
    host = fixed;
    const resolved = direct ?? (() => {
      const r = resolveSpelling(registry, h, spelling);
      return r === null ? null : registryModel(registry, r.modelId, r.provider);
    })();
    modelId = resolved?.modelId ?? (MODEL_ID.test(spelling) ? spelling : null);
  } else if (direct !== null) {
    host = direct.provider;
    modelId = direct.modelId;
  } else {
    const r = resolveSpelling(registry, h, spelling);
    if (r === null) return null;
    host = r.servingHost;
    modelId = r.modelId;
  }
  if (host === null || !HOSTS.includes(host)) return null;
  const model = modelId === null ? null : registryModel(registry, modelId);
  const family = model !== null && FAMILY.test(model.family) ? model.family : null;
  return { harness: h, authMode: authOf(authMode), servingHost: host, modelId, family };
}

/**
 * The scope of a run through a pinned serving host (C's LOW B): the harness and sign-in, the host
 * that received the request, and the maker's model and family. A session records such a limit on
 * the host (`accessScopeOf` resolves the host spelling); an owned run through the host records and
 * checks the same scope, never the maker's. Null for a host Jevris does not pin or a model the
 * registry does not list (OP-12: record nothing).
 */
export function accessScopeOnHost(registry: ModelRegistry, harness: string, provider: string, modelId: string, servingHost: string, authMode: string): AccessQuery | null {
  if (!(HARNESS_IDS as readonly string[]).includes(harness) || typeof servingHost !== 'string' || !HOSTS.includes(servingHost)) return null;
  const model = registryModel(registry, modelId, provider);
  if (model === null) return null;
  return { harness: harness as HarnessId, authMode: authOf(authMode), servingHost, modelId: model.modelId, family: FAMILY.test(model.family) ? model.family : null };
}

/**
 * A route candidate's query (R72, R73): the harness and sign-in that would run the registry model,
 * its serving host and family. With no harness (advice that names none), any harness's pause on
 * the model's maker counts: advice fails toward pausing. Null when the model is not registered.
 */
export function accessQueryFor(registry: ModelRegistry, harness: string | null, modelId: string, authMode: string | null): AccessQuery | null {
  if (harness !== null) return accessScopeOf(registry, harness, modelId, authMode ?? 'unknown');
  const model = registryModel(registry, modelId);
  if (model === null || !HOSTS.includes(model.provider)) return null;
  return { harness: null, authMode: authOf(authMode), servingHost: model.provider, modelId: model.modelId, family: FAMILY.test(model.family) ? model.family : null };
}

// ---------------------------------------------------------------------------------------------
// The record (design 4.3).

export type AccessLimitSource = (typeof ACCESS_LIMIT_SOURCES)[number];

export interface AccessLimitEntry {
  /** A stable id for this entry (scope, class and first-seen time): what `clearAccessLimits` takes. */
  readonly key: string;
  readonly scope: AccessScope;
  readonly class: AccessPauseClass;
  /** The `ACCESS_SIGNALS` row that recorded it. */
  readonly signal: string;
  readonly source: AccessLimitSource;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  /** When it lifts (null: no expiry). */
  readonly untilMs: number | null;
  /** The doubling step for a rule-timed pause (0-6). */
  readonly step: number;
  readonly weekly: boolean;
  readonly resetBasis: 'reported' | 'rule' | 'none';
  readonly count: number;
  /** The non-secret credential fingerprint for an API-key run where Jevris holds the key, else null. */
  readonly fingerprint: string | null;
}

type StoredEntry = Omit<AccessLimitEntry, 'key'>;

/** `<data>/route-learning/access-limits.json`. */
export function accessLimitsPath(home: string): string {
  return join(jevrisPaths({ home }).data, 'route-learning', 'access-limits.json');
}

function scopeKey(scope: AccessScope): string {
  return [scope.harness, scope.authMode, scope.servingHost, scope.modelId ?? '-', scope.family ?? '-'].join('|');
}

function entryKey(e: StoredEntry): string {
  return sha256Hex(`jevris-access-limit\n${scopeKey(e.scope)}\n${e.class}\n${String(e.firstSeenMs)}`).slice(0, 16);
}

const intMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;

function validScope(v: unknown): AccessScope | null {
  if (v === null || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (Object.keys(s).some((k) => !['harness', 'authMode', 'servingHost', 'modelId', 'family'].includes(k))) return null;
  if (typeof s['harness'] !== 'string' || !(HARNESS_IDS as readonly string[]).includes(s['harness'])) return null;
  if (typeof s['authMode'] !== 'string' || !(ACCESS_AUTH_MODES as readonly string[]).includes(s['authMode'])) return null;
  if (typeof s['servingHost'] !== 'string' || !HOSTS.includes(s['servingHost'])) return null;
  const modelId = s['modelId'] ?? null;
  const family = s['family'] ?? null;
  if (modelId !== null && (typeof modelId !== 'string' || !MODEL_ID.test(modelId))) return null;
  if (family !== null && (typeof family !== 'string' || !FAMILY.test(family))) return null;
  if (modelId !== null && family !== null) return null;
  return { harness: s['harness'] as HarnessId, authMode: s['authMode'] as AccessAuthMode, servingHost: s['servingHost'] as AccessScope['servingHost'], modelId: modelId as string | null, family: family as string | null };
}

const ENTRY_KEYS = ['scope', 'class', 'signal', 'source', 'firstSeenMs', 'lastSeenMs', 'untilMs', 'step', 'weekly', 'resetBasis', 'count', 'fingerprint'];

function validEntry(v: unknown): StoredEntry | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  // No field outside the pinned list is accepted: no text can ride along.
  if (Object.keys(e).some((k) => !ENTRY_KEYS.includes(k))) return null;
  const scope = validScope(e['scope']);
  if (scope === null) return null;
  const cls = e['class'];
  if (typeof cls !== 'string' || !(ACCESS_PAUSE_CLASSES as readonly string[]).includes(cls)) return null;
  const row = typeof e['signal'] === 'string' ? ROW_BY_ID.get(e['signal']) : undefined;
  if (row === undefined) return null;
  if (typeof e['source'] !== 'string' || !(ACCESS_LIMIT_SOURCES as readonly string[]).includes(e['source'])) return null;
  if (!intMs(e['firstSeenMs']) || !intMs(e['lastSeenMs']) || e['lastSeenMs'] < e['firstSeenMs']) return null;
  const untimed = cls === 'credit-exhausted' || cls === 'account-blocked';
  if (untimed ? e['untilMs'] !== null : !intMs(e['untilMs'])) return null;
  if (typeof e['step'] !== 'number' || !Number.isSafeInteger(e['step']) || e['step'] < 0 || e['step'] > ACCESS_TIMING.maxStep) return null;
  if (typeof e['weekly'] !== 'boolean') return null;
  if (e['resetBasis'] !== 'reported' && e['resetBasis'] !== 'rule' && e['resetBasis'] !== 'none') return null;
  if (untimed !== (e['resetBasis'] === 'none')) return null;
  if (typeof e['count'] !== 'number' || !Number.isSafeInteger(e['count']) || e['count'] < 1) return null;
  const fp = e['fingerprint'];
  if (fp !== null && (typeof fp !== 'string' || !FINGERPRINT.test(fp))) return null;
  return {
    scope,
    class: cls as AccessPauseClass,
    signal: row.signal,
    source: e['source'] as AccessLimitSource,
    firstSeenMs: e['firstSeenMs'],
    lastSeenMs: e['lastSeenMs'],
    untilMs: e['untilMs'] as number | null,
    step: e['step'],
    weekly: e['weekly'],
    resetBasis: e['resetBasis'],
    count: Math.min(e['count'], 1_000_000),
    fingerprint: fp as string | null,
  };
}

function keyed(e: StoredEntry): AccessLimitEntry {
  return { key: entryKey(e), ...e };
}

/** Stable order: untimed first, then by `untilMs`, then by key (status and `route limits` number them 1..n). */
function ordered(entries: readonly AccessLimitEntry[]): AccessLimitEntry[] {
  return [...entries].sort((a, b) => {
    if (a.untilMs === null && b.untilMs !== null) return -1;
    if (a.untilMs !== null && b.untilMs === null) return 1;
    if (a.untilMs !== null && b.untilMs !== null && a.untilMs !== b.untilMs) return a.untilMs - b.untilMs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Why a record could not be read (B's MEDIUM 41; coordinator's rule per cause):
 * - `transient`: a read error other than ENOENT (EACCES, EMFILE, EIO, EBUSY): never written over;
 * - `newer`: another named schema (a rollback after an upgrade): never downgraded;
 * - `damaged`: oversized, not JSON, or no schema or entries list: set aside, then a new record is
 *   written, so Jevris keeps recording limits instead of launching into an exhausted account.
 */
export type AccessLimitsUnreadable = 'transient' | 'newer' | 'damaged';

interface FileRead {
  readonly entries: AccessLimitEntry[];
  readonly readable: boolean;
  readonly unreadable: AccessLimitsUnreadable | null;
}

/** A later record schema of the same family (`jevris-access-limits-<n>`, n above this one's). */
const SCHEMA_FAMILY = /^jevris-access-limits-([1-9][0-9]{0,5})$/;
const SCHEMA_NUMBER = Number(SCHEMA_FAMILY.exec(ACCESS_LIMITS_SCHEMA)?.[1] ?? '1');

async function readFileEntries(home: string): Promise<FileRead> {
  const bad = (unreadable: AccessLimitsUnreadable): FileRead => ({ entries: [], readable: false, unreadable });
  // SR-16: the record is read without following a link and never past its cap. A link is damage
  // (set aside; the rewrite puts a regular file in its place); a folder or another non-file is
  // left alone as a transient error, as any other read error is.
  const read = readFileNoFollow(accessLimitsPath(home), ACCESS_LIMITS_CAPS.maxBytes);
  if (read.kind === 'missing') return { entries: [], readable: true, unreadable: null };
  if (read.kind === 'unreadable' || read.kind === 'not-regular') return bad('transient');
  if (read.kind !== 'ok') return bad('damaged');
  const bytes = read.bytes;
  let value: { schemaVersion?: unknown; entries?: unknown };
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as { schemaVersion?: unknown; entries?: unknown };
  } catch {
    return bad('damaged');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('damaged');
  if (value.schemaVersion !== ACCESS_LIMITS_SCHEMA) {
    // Only a later schema of this family is newer than this Jevris (a rollback), never written
    // over; any other value is damage, so one crafted file cannot stop recording for good (SR-16).
    const later = typeof value.schemaVersion === 'string' ? SCHEMA_FAMILY.exec(value.schemaVersion) : null;
    return later !== null && Number(later[1]) > SCHEMA_NUMBER ? bad('newer') : bad('damaged');
  }
  if (!Array.isArray(value.entries)) return bad('damaged');
  const seen = new Set<string>();
  const out: AccessLimitEntry[] = [];
  for (const raw of value.entries.slice(0, ACCESS_LIMITS_CAPS.maxEntries)) {
    const e = validEntry(raw);
    if (e === null) continue;
    const id = `${scopeKey(e.scope)}#${e.class}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(keyed(e));
  }
  return { entries: out, readable: true, unreadable: null };
}

/** At most this many damaged records are kept set aside (the oldest goes first). */
export const ACCESS_LIMITS_SET_ASIDE_MAX = 3;
const SET_ASIDE = /^access-limits\.json\.damaged-(\d{1,16})$/;

/** The damaged records set aside, oldest first: `access-limits.json.damaged-<ms>` beside the record. */
async function setAsideFiles(home: string): Promise<{ readonly name: string; readonly atMs: number }[]> {
  let names: string[];
  try {
    names = await readdir(dirname(accessLimitsPath(home)));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const m = SET_ASIDE.exec(name);
    return m === null ? [] : [{ name, atMs: Number(m[1]) }];
  }).sort((a, b) => a.atMs - b.atMs || (a.name < b.name ? -1 : 1));
}

/**
 * Moves a damaged record aside (0600) so recording can go on, keeping at most 3; the caller holds
 * the lock. False when it could not be moved: then nothing is written over it.
 */
async function setAsideDamaged(home: string, nowMs: number): Promise<boolean> {
  const path = accessLimitsPath(home);
  let at = nowMs;
  const taken = new Set((await setAsideFiles(home)).map((f) => f.atMs));
  while (taken.has(at)) at += 1;
  // The record is written 0600, and a rename keeps its mode.
  const aside = join(dirname(path), `access-limits.json.damaged-${String(at)}`);
  try {
    await rename(path, aside);
  } catch {
    return false;
  }
  const files = await setAsideFiles(home);
  for (const f of files.slice(0, Math.max(0, files.length - ACCESS_LIMITS_SET_ASIDE_MAX))) {
    await removeQuietly(join(dirname(path), f.name));
  }
  return true;
}

/** The damaged records set aside (doctor: pauses may be missing), newest time or null. */
export async function accessLimitsSetAside(home: string): Promise<{ readonly count: number; readonly latestMs: number | null }> {
  const files = await setAsideFiles(home);
  return { count: files.length, latestMs: files.length === 0 ? null : (files[files.length - 1] as { readonly atMs: number }).atMs };
}

/** Removes a file; a missing one is already removed. */
async function removeQuietly(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    return (error as { readonly code?: string }).code === 'ENOENT';
  }
}

async function removeSetAside(home: string): Promise<boolean> {
  let ok = true;
  for (const f of await setAsideFiles(home)) {
    if (!(await removeQuietly(join(dirname(accessLimitsPath(home)), f.name)))) ok = false;
  }
  return ok;
}

function stored(e: AccessLimitEntry): StoredEntry {
  const { key: _key, ...rest } = e;
  return rest;
}

async function writeEntries(home: string, entries: readonly AccessLimitEntry[]): Promise<boolean> {
  await mkdir(join(jevrisPaths({ home }).data, 'route-learning'), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ schemaVersion: ACCESS_LIMITS_SCHEMA, entries: entries.map(stored) })}\n`;
  if (new TextEncoder().encode(body).byteLength > ACCESS_LIMITS_CAPS.maxBytes) return false;
  const result = await durableWrite(accessLimitsPath(home), body, { mode: 0o600 });
  return result.ok;
}

/**
 * Every entry on disk, in a stable order, with whether the file could be read (a missing file is
 * readable and empty; otherwise doctor warns ACCESS_LIMITS_UNREADABLE, and `unreadable` says why:
 * a transient read error, a newer record than this Jevris, or a damaged file) and whether it is
 * full (ACCESS_LIMITS_FULL). Expired entries are included: `accessPauseFor` decides what is in force.
 */
export async function readAccessLimits(home: string): Promise<{ readonly entries: readonly AccessLimitEntry[]; readonly readable: boolean; readonly unreadable?: AccessLimitsUnreadable | null; readonly full: boolean }> {
  const read = await readFileEntries(home);
  return { entries: ordered(read.entries), readable: read.readable, unreadable: read.unreadable, full: read.entries.length >= ACCESS_LIMITS_CAPS.maxEntries };
}

/** Drops entries expired more than 7 days ago (design 4.3). */
function pruned(entries: readonly AccessLimitEntry[], nowMs: number): AccessLimitEntry[] {
  return entries.filter((e) => e.untilMs === null || nowMs - e.untilMs <= ACCESS_TIMING.pruneAfterMs);
}

/** Makes room for one more: the oldest expired first, then the oldest timed; never an untimed one. */
function evictOne(entries: AccessLimitEntry[], nowMs: number): AccessLimitEntry[] | null {
  const expired = entries.filter((e) => e.untilMs !== null && e.untilMs <= nowMs).sort((a, b) => (a.untilMs as number) - (b.untilMs as number));
  const victim = expired[0] ?? entries.filter((e) => e.untilMs !== null).sort((a, b) => a.lastSeenMs - b.lastSeenMs)[0];
  if (victim === undefined) return null;
  return entries.filter((e) => e !== victim);
}

export interface RecordAccessLimitInput {
  readonly home: string;
  /** The run's or session's scope (`accessScopeOf`); the record narrows it per the class (design 4.1). */
  readonly scope: AccessQuery;
  readonly classification: AccessClassification;
  readonly source: AccessLimitSource;
  readonly nowMs: number;
  /** `credentialFingerprint` of the key an API-key owned run used; null or absent otherwise. */
  readonly fingerprint?: string | null;
  /** The learning setting `limitCooldownHours` (OP-11). */
  readonly baseHours?: number;
}

/**
 * Whether a recorded class can come from a row (design 4.2, 5.5): the row's own class; a
 * usage-window from a rate-limit row (a reset more than 1 h away) or from a text row (OP-4 holds
 * an uncertified credit or blocked text as one); Claude's `rate_limit` error is a rate-limit on
 * an API key. Anything else is refused. With the issued-classification check, no caller can turn
 * a text row into an untimed pause without a certified signal.
 */
function classFits(row: AccessSignalRow, cls: AccessPauseClass): boolean {
  if (!(ACCESS_PAUSE_CLASSES as readonly string[]).includes(cls)) return false;
  if (row.class === cls) return true;
  if (cls === 'usage-window' && (row.class === 'rate-limit' || !row.structured)) return true;
  return cls === 'rate-limit' && row.signal.endsWith('.stream.error.rate-limit');
}

export type RecordAccessLimitResult =
  | {
      readonly ok: true;
      readonly entry: AccessLimitEntry;
      readonly outcome: 'new' | 'seen' | 're-hit';
      /** True when a damaged record was set aside to write this one (doctor warns). */
      readonly setAside: boolean;
    }
  | { readonly ok: false; readonly reasonCode: 'INVALID_INPUT' | 'NOT_A_PAUSE' | 'ACCESS_SCOPE_UNKNOWN' | 'LOCK_BUSY' | 'WRITE_FAILED' | 'ACCESS_LIMITS_FULL' | 'ACCESS_LIMITS_UNREADABLE' };

/**
 * Records one access limit (design 4.2, 4.3). A hit while the scope's pause is in force changes only
 * `lastSeenMs` and `count`; a re-hit after it expired raises the doubling step (back to 0 when more
 * than 7 days have passed since the expiry). `overloaded` is never recorded (NOT_A_PAUSE).
 */
export async function recordAccessLimit(input: RecordAccessLimitInput): Promise<RecordAccessLimitResult> {
  const c = input.classification;
  if (!intMs(input.nowMs)) return { ok: false, reasonCode: 'INVALID_INPUT' };
  const issued = c !== null && typeof c === 'object' ? ISSUED.get(c) : undefined;
  if (issued === undefined) return { ok: false, reasonCode: 'INVALID_INPUT' };
  if (!(ACCESS_PAUSE_CLASSES as readonly string[]).includes(c.class)) return { ok: false, reasonCode: 'NOT_A_PAUSE' };
  const row = typeof c.signal === 'string' ? ROW_BY_ID.get(c.signal) : undefined;
  if (row === undefined || row.class === null || !classFits(row, c.class as AccessPauseClass)) return { ok: false, reasonCode: 'INVALID_INPUT' };
  // OP-4: a text row gives an untimed pause only from a certified signal.
  if (!row.structured && (c.class === 'credit-exhausted' || c.class === 'account-blocked') && !issued.certified) return { ok: false, reasonCode: 'INVALID_INPUT' };
  if (typeof input.source !== 'string' || !(ACCESS_LIMIT_SOURCES as readonly string[]).includes(input.source)) return { ok: false, reasonCode: 'INVALID_INPUT' };
  // A usage reading's rows come only from a usage reading, and a usage reading records only them.
  if ((input.source === 'usage-read') !== USAGE_READ_ROWS.has(row.signal)) return { ok: false, reasonCode: 'INVALID_INPUT' };
  const q = input.scope;
  if (q === null || typeof q !== 'object' || q.harness === null) return { ok: false, reasonCode: 'ACCESS_SCOPE_UNKNOWN' };
  const family = c.family !== null && FAMILY.test(c.family) ? c.family : null;
  const scope = validScope({
    harness: q.harness,
    authMode: q.authMode,
    servingHost: q.servingHost,
    modelId: c.class === 'rate-limit' && family === null ? (q.modelId ?? null) : null,
    family,
  });
  if (scope === null) return { ok: false, reasonCode: 'ACCESS_SCOPE_UNKNOWN' };
  const cls = c.class as AccessPauseClass;
  const untimed = cls === 'credit-exhausted' || cls === 'account-blocked';
  const reported = untimed ? null : validReset(c.reportedResetMs, input.nowMs);
  const fingerprint = scope.authMode === 'api-key' && typeof input.fingerprint === 'string' && FINGERPRINT.test(input.fingerprint) ? input.fingerprint : null;
  const nowMs = input.nowMs;
  const weekly = cls === 'usage-window' && c.weekly === true;
  const timing = (step: number): number | null => accessUntilMs({ class: cls, nowMs, step, weekly, reportedResetMs: reported, ...(input.baseHours === undefined ? {} : { baseHours: input.baseHours }) });
  const basis: AccessLimitEntry['resetBasis'] = untimed ? 'none' : reported !== null ? 'reported' : 'rule';
  const outcome = await withFileLock(accessLimitsPath(input.home), async () => {
    const read = await readFileEntries(input.home);
    // B's MEDIUM 41: never write over a record that could not be read. A transient error or a newer
    // record refuses this one (the next signal records again); a damaged file is set aside first.
    let setAside = false;
    if (read.unreadable === 'transient' || read.unreadable === 'newer') return 'unreadable' as const;
    if (read.unreadable === 'damaged') {
      if (!(await setAsideDamaged(input.home, nowMs))) return 'unreadable' as const;
      setAside = true;
    }
    let current = pruned(read.entries, nowMs);
    const id = `${scopeKey(scope)}#${cls}`;
    const prior = current.find((e) => `${scopeKey(e.scope)}#${e.class}` === id);
    let entry: AccessLimitEntry;
    let kind: 'new' | 'seen' | 're-hit';
    if (prior === undefined) {
      entry = keyed({ scope, class: cls, signal: row.signal, source: input.source, firstSeenMs: nowMs, lastSeenMs: nowMs, untilMs: timing(0), step: 0, weekly, resetBasis: basis, count: 1, fingerprint });
      kind = 'new';
    } else if (prior.untilMs === null || prior.untilMs > nowMs) {
      // In force: counted again. A reported reset later than its end extends it (OP-6: a reading's
      // reset beyond an earlier rule time); nothing ever shortens a pause in force. The signal and
      // source move only from a prior usage-window row: an OP-4 held credit or blocked text keeps
      // its own row, so a later usage reading can never lift it (B's LOW 37).
      const later = prior.untilMs !== null && reported !== null && reported > prior.untilMs;
      const moves = later && ROW_BY_ID.get(prior.signal)?.class === 'usage-window';
      entry = {
        ...prior,
        lastSeenMs: Math.max(prior.lastSeenMs, nowMs),
        count: Math.min(prior.count + 1, 1_000_000),
        ...(fingerprint === null ? {} : { fingerprint }),
        ...(later ? { untilMs: reported, resetBasis: 'reported' as const, weekly: prior.weekly || weekly } : {}),
        ...(moves ? { signal: row.signal, source: input.source } : {}),
      };
      kind = 'seen';
    } else {
      const step = nowMs - prior.untilMs > ACCESS_TIMING.stepResetAfterMs ? 0 : Math.min(ACCESS_TIMING.maxStep, prior.step + 1);
      entry = { ...prior, signal: row.signal, source: input.source, lastSeenMs: nowMs, untilMs: timing(step), step, weekly, resetBasis: basis, count: Math.min(prior.count + 1, 1_000_000), fingerprint: fingerprint ?? prior.fingerprint };
      kind = 're-hit';
    }
    current = current.filter((e) => e !== prior);
    while (current.length >= ACCESS_LIMITS_CAPS.maxEntries) {
      const next = evictOne(current, nowMs);
      if (next === null) return 'full' as const;
      current = next;
    }
    return (await writeEntries(input.home, [...current, entry])) ? { entry, kind, setAside } : ('write' as const);
  });
  if (outcome === null) return { ok: false, reasonCode: 'LOCK_BUSY' };
  if (outcome === 'unreadable') return { ok: false, reasonCode: 'ACCESS_LIMITS_UNREADABLE' };
  if (outcome === 'full') return { ok: false, reasonCode: 'ACCESS_LIMITS_FULL' };
  if (outcome === 'write') return { ok: false, reasonCode: 'WRITE_FAILED' };
  return { ok: true, entry: outcome.entry, outcome: outcome.kind, setAside: outcome.setAside };
}

function modesMatch(entry: AccessAuthMode, query: AccessAuthMode): boolean {
  return entry === 'unknown' || query === 'unknown' || entry === query;
}

function untimedClass(cls: AccessPauseClass): boolean {
  return cls === 'credit-exhausted' || cls === 'account-blocked';
}

/**
 * Whether an entry covers a query (design 4.1, OP-3): the same serving host; the same harness, or
 * (OP-3) an untimed API-key entry whose non-null fingerprint equals the query's; modes that match
 * (`unknown` on either side matches both); and an entry model or family that is null or equal.
 */
function covers(e: AccessLimitEntry, q: AccessQuery, fingerprint: string | null): boolean {
  if (e.scope.servingHost !== q.servingHost) return false;
  const sameHarness = q.harness === null || e.scope.harness === q.harness;
  const sameKey = untimedClass(e.class) && e.scope.authMode === 'api-key' && e.fingerprint !== null && fingerprint !== null && e.fingerprint === fingerprint;
  if (!sameHarness && !sameKey) return false;
  if (!sameKey && !modesMatch(e.scope.authMode, q.authMode)) return false;
  if (e.scope.modelId !== null && e.scope.modelId !== q.modelId) return false;
  if (e.scope.family !== null && e.scope.family !== q.family) return false;
  return true;
}

/** True when a new credential replaced the one an untimed entry was recorded with (design 9.1). */
function replacedCredential(e: AccessLimitEntry, q: AccessQuery, fingerprint: string | null): boolean {
  return untimedClass(e.class) && fingerprint !== null && e.fingerprint !== null && e.fingerprint !== fingerprint && (q.harness === null || e.scope.harness === q.harness);
}

export interface AccessPause {
  readonly class: AccessPauseClass;
  /** When it lifts; null for no expiry. */
  readonly untilMs: number | null;
  readonly entry: AccessLimitEntry;
}

/**
 * The only check (design 7.1): the pause in force for a candidate's scope, or null. Of several,
 * an untimed one wins, else the latest `untilMs`. `fingerprint` is the key the launch will use,
 * where Jevris holds it: an untimed entry recorded with another key does not pause it (the
 * caller clears it with `clearAccessLimitsForCredential`).
 */
export function accessPauseFor(entries: readonly AccessLimitEntry[], query: AccessQuery, nowMs: number, options: { readonly fingerprint?: string | null } = {}): AccessPause | null {
  const fingerprint = typeof options.fingerprint === 'string' && FINGERPRINT.test(options.fingerprint) ? options.fingerprint : null;
  let best: AccessLimitEntry | null = null;
  for (const e of entries) {
    if (e.untilMs !== null && e.untilMs <= nowMs) continue;
    if (!covers(e, query, fingerprint) || replacedCredential(e, query, fingerprint)) continue;
    if (best === null || (best.untilMs !== null && (e.untilMs === null || e.untilMs > best.untilMs))) best = e;
  }
  return best === null ? null : { class: best.class, untilMs: best.untilMs, entry: best };
}

/**
 * Near a limit (design 4.5, E2): an entry for the scope seen within `nearMs` (`nearLimitHours`),
 * in force or not. A near scope is never explored.
 */
export function accessLimitNear(entries: readonly AccessLimitEntry[], query: AccessQuery, nowMs: number, nearMs: number): boolean {
  return entries.some((e) => covers(e, query, null) && e.lastSeenMs <= nowMs && nowMs - e.lastSeenMs <= Math.max(0, nearMs));
}

export interface AccessPauseNote {
  readonly class: AccessPauseClass;
  readonly untilMs: number | null;
  /** The entry's scope, for explain (`kilocode api-key zai`). */
  readonly scope: AccessScope;
}

/**
 * Model id -> the pause in force for it (design 7.1), beside `unavailableModels`. `scopeOf` gives
 * each candidate's scope, or null when it has none (then it is not narrowed here: a scope Jevris
 * cannot name was never recorded).
 */
export function pausedModels(entries: readonly AccessLimitEntry[], modelIds: readonly string[], scopeOf: (modelId: string) => AccessQuery | null, nowMs: number, options: { readonly fingerprintOf?: (modelId: string) => string | null } = {}): Readonly<Record<string, AccessPauseNote>> {
  const out: Record<string, AccessPauseNote> = {};
  if (entries.length === 0) return out;
  for (const modelId of new Set(modelIds)) {
    const scope = scopeOf(modelId);
    if (scope === null) continue;
    const pause = accessPauseFor(entries, scope, nowMs, { fingerprint: options.fingerprintOf?.(modelId) ?? null });
    if (pause !== null) out[modelId] = { class: pause.class, untilMs: pause.untilMs, scope: pause.entry.scope };
  }
  return out;
}

/** Why a clear or lift wrote nothing (B's LOW 42: the real code, never folded into LOCK_BUSY). */
export type AccessRewriteFailure = 'LOCK_BUSY' | 'WRITE_FAILED' | 'ACCESS_LIMITS_UNREADABLE';

async function rewrite(home: string, pick: (entries: readonly AccessLimitEntry[]) => readonly AccessLimitEntry[], clearAll = false): Promise<{ readonly ok: boolean; readonly cleared: readonly AccessLimitEntry[]; readonly reasonCode?: AccessRewriteFailure }> {
  const outcome = await withFileLock(accessLimitsPath(home), async (): Promise<AccessLimitEntry[] | AccessRewriteFailure> => {
    const read = await readFileEntries(home);
    // An unreadable file clears only through `all` (a person's clear: it is rewritten empty, and the
    // damaged records set aside go too) or removeAccessLimits; every other path leaves it alone.
    if (!read.readable) {
      if (!clearAll) return 'ACCESS_LIMITS_UNREADABLE';
      return (await writeEntries(home, [])) && (await removeSetAside(home)) ? [] : 'WRITE_FAILED';
    }
    if (clearAll && !(await removeSetAside(home))) return 'WRITE_FAILED';
    const drop = new Set(pick(read.entries));
    if (drop.size === 0) return [];
    const keep = read.entries.filter((e) => !drop.has(e));
    return (await writeEntries(home, keep)) ? read.entries.filter((e) => drop.has(e)) : 'WRITE_FAILED';
  });
  if (outcome === null) return { ok: false, cleared: [], reasonCode: 'LOCK_BUSY' };
  if (typeof outcome === 'string') return { ok: false, cleared: [], reasonCode: outcome };
  return { ok: true, cleared: ordered(outcome) };
}

export interface ClearedAccessLimit {
  readonly key: string;
  readonly class: AccessPauseClass;
  readonly scope: AccessScope;
}

const brief = (e: AccessLimitEntry): ClearedAccessLimit => ({ key: e.key, class: e.class, scope: e.scope });

/**
 * `jevris route limits clear` (B's R78): removes the entries whose keys a person saw, or all, under
 * the lock. An unknown key clears nothing (never a position in a list that may have changed).
 */
export async function clearAccessLimits(home: string, input: { readonly entries: 'all' | readonly string[]; readonly nowMs: number }): Promise<{ readonly ok: boolean; readonly cleared: readonly ClearedAccessLimit[] }> {
  const keys = input.entries === 'all' ? null : new Set(input.entries.filter((k) => typeof k === 'string' && FINGERPRINT.test(k)));
  const result = await rewrite(home, (entries) => entries.filter((e) => keys === null || keys.has(e.key)), keys === null);
  return { ok: result.ok, cleared: result.cleared.map(brief) };
}

/**
 * An observed success on a scope (an owned run completed, a Kilo or OpenCode turn finished without
 * an error, a Claude `Stop`): clears every class for that scope (OP-2), the scope-wide entries and
 * those for its model or family, so the doubling starts again. An entry of another sign-in is kept,
 * except an `unknown` one.
 */
export async function recordAccessSuccess(home: string, scope: AccessQuery, nowMs: number): Promise<{ readonly ok: boolean; readonly cleared: readonly ClearedAccessLimit[] }> {
  if (scope === null || typeof scope !== 'object' || scope.harness === null || !intMs(nowMs)) return { ok: false, cleared: [] };
  const hit = (e: AccessLimitEntry): boolean =>
    e.scope.harness === scope.harness &&
    e.scope.servingHost === scope.servingHost &&
    (e.scope.authMode === 'unknown' || e.scope.authMode === scope.authMode) &&
    (e.scope.modelId === null || e.scope.modelId === scope.modelId) &&
    (e.scope.family === null || e.scope.family === scope.family);
  // Nothing to clear is the common case: read before taking the lock.
  const quick = await readFileEntries(home);
  if (!quick.entries.some(hit)) return { ok: true, cleared: [] };
  const result = await rewrite(home, (entries) => entries.filter(hit));
  return { ok: result.ok, cleared: result.cleared.map(brief) };
}

/**
 * A certified usage reading with no exhausted window (OP-6): lifts the scope's usage-window entries
 * of that exact sign-in whose row is a usage window (a usage reading, Codex's X1 text). Never an
 * entry of another or the unknown sign-in, never credit, blocked or a rate limit, and never an OP-4
 * held text (its row is a credit or blocked row), and never an entry last seen within
 * `USAGE_LIFT_GRACE_MS` before the reading. Trace cause USAGE_READ.
 */
export async function liftUsageWindows(home: string, scope: AccessQuery, readAtMs: number): Promise<{ readonly ok: boolean; readonly cleared: readonly ClearedAccessLimit[]; readonly reasonCode?: AccessRewriteFailure | 'INVALID_INPUT' }> {
  if (scope === null || typeof scope !== 'object' || scope.harness === null || scope.authMode === 'unknown' || !intMs(readAtMs)) return { ok: false, cleared: [], reasonCode: 'INVALID_INPUT' };
  // B: the reading carries no capture time of its own and may come from a snapshot taken before a
  // limit hit, so an entry last seen within the grace before the read is kept.
  const hit = (e: AccessLimitEntry): boolean =>
    e.lastSeenMs < readAtMs - USAGE_LIFT_GRACE_MS &&
    e.class === 'usage-window' &&
    ROW_BY_ID.get(e.signal)?.class === 'usage-window' &&
    e.scope.harness === scope.harness &&
    e.scope.servingHost === scope.servingHost &&
    e.scope.authMode === scope.authMode;
  const quick = await readFileEntries(home);
  if (!quick.readable) return { ok: false, cleared: [], reasonCode: 'ACCESS_LIMITS_UNREADABLE' };
  if (!quick.entries.some(hit)) return { ok: true, cleared: [] };
  const result = await rewrite(home, (entries) => entries.filter(hit));
  return { ok: result.ok, cleared: result.cleared.map(brief), ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }) };
}

/**
 * The key an owned API-key launch will use differs from the one an untimed entry of its scope was
 * recorded with: that entry clears (design 9.1, trace ACCESS_LIMIT_CLEARED FINGERPRINT).
 */
export async function clearAccessLimitsForCredential(home: string, scope: AccessQuery, fingerprint: string, nowMs: number): Promise<{ readonly ok: boolean; readonly cleared: readonly ClearedAccessLimit[] }> {
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint) || !intMs(nowMs)) return { ok: false, cleared: [] };
  const hit = (e: AccessLimitEntry): boolean => replacedCredential(e, scope, fingerprint) && covers(e, scope, null);
  const quick = await readFileEntries(home);
  if (!quick.entries.some(hit)) return { ok: true, cleared: [] };
  const result = await rewrite(home, (entries) => entries.filter(hit));
  return { ok: result.ok, cleared: result.cleared.map(brief) };
}

/**
 * Deletes the file under its lock (`jevris route learning reset --machine`, B's R62): every entry
 * goes, and so do the damaged records set aside. A missing file is already removed.
 */
export async function removeAccessLimits(home: string): Promise<{ readonly ok: boolean; readonly removed: number }> {
  const outcome = await withFileLock(accessLimitsPath(home), async () => {
    const count = (await readFileEntries(home)).entries.length;
    try {
      await rm(accessLimitsPath(home));
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'ENOENT') return null;
    }
    // The damaged records set aside go too (coordinator, MEDIUM 41).
    return (await removeSetAside(home)) ? count : null;
  });
  return outcome === null ? { ok: false, removed: 0 } : { ok: true, removed: outcome };
}

// ---------------------------------------------------------------------------------------------
// Fixed text (design 7.3, 9.2, 11): ids, classes and times only.

const minuteIso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

/** `codex subscription openai`, `kilocode api-key zai (glm-5.3)`, `claude subscription anthropic (opus)`. */
export function accessScopeText(scope: AccessScope): string {
  const narrow = scope.modelId ?? scope.family;
  return `${scope.harness} ${scope.authMode} ${scope.servingHost}${narrow === null ? '' : ` (${narrow})`}`;
}

/**
 * Whether a new key clears this untimed entry: only an API-key entry recorded with the fingerprint
 * of a key Jevris passes itself, since only there does a launch compare keys (status carries this
 * boolean, never the fingerprint). That is a Claude or Codex key; the key of a pinned host an owned
 * run went through, such as OPENROUTER_API_KEY (the coordinator's 1.2 decision after C's LOW B); or
 * the maker key Jevris passes to a direct OpenCode or Kilo run (G-9). Antigravity has none.
 */
export function accessNewKeyClears(entry: Pick<AccessLimitEntry, 'scope' | 'fingerprint'>): boolean {
  return entry.scope.authMode === 'api-key' && entry.fingerprint !== null && entry.scope.harness !== 'antigravity';
}

/**
 * Whose key a new-key clear means, as a prefix of "API key": the serving host where the harness is
 * multi-provider (OpenCode, Kilo) or the host is pinned; nothing for Claude or Codex, whose key is
 * the harness's own.
 */
function namedKey(scope: { readonly harness?: string; readonly servingHost?: string }): string {
  const host = scope.servingHost;
  if (typeof host !== 'string' || !/^[a-z0-9-]{1,40}$/.test(host)) return '';
  return servingHostOf(host) !== undefined || scope.harness === 'opencode' || scope.harness === 'kilocode' ? `${host} ` : '';
}

/**
 * How an untimed pause (exhausted credit, a blocked account) can clear, naming only the paths that
 * exist for it (fixed text; D's 5ddbd276, moved to core so every surface says the same):
 * - a new key: only where `newKeyClears` (`accessNewKeyClears`); on a pinned host, OpenCode or Kilo
 *   it names the serving host, whose key is the one that counts;
 * - a finished session turn: only an entry of the unknown sign-in, the one an interactive success
 *   clears (`recordAccessSuccess`);
 * - `jevris route limits clear`: always.
 * A successful owned run is not named: the paused scope launches nothing, so none can happen.
 */
export function untimedClearTextFor(scope: Pick<AccessScope, 'authMode'> & { readonly harness?: string; readonly servingHost?: string }, newKeyClears: boolean): string {
  if (newKeyClears) return `clears when the ${namedKey(scope)}API key Jevris passes changes, or with jevris route limits clear`;
  if (scope.authMode === 'unknown') return 'clears when a session turn on it finishes, or with jevris route limits clear';
  return 'clears with jevris route limits clear';
}

/** `untimedClearTextFor` for a stored entry. */
export function untimedClearText(entry: Pick<AccessLimitEntry, 'scope' | 'fingerprint'>): string {
  return untimedClearTextFor(entry.scope, accessNewKeyClears(entry));
}

/** The static help sentence for an untimed pause (`jevris route limits` help). */
export const ACCESS_UNTIMED_CLEAR_HELP = 'An untimed pause (exhausted credit, a blocked account) clears with jevris route limits clear; for some sign-ins also when the API key Jevris passes changes, or when a session turn on it finishes.';

/** One line per entry in force (status, doctor, `jevris route limits`). */
export function accessLimitLines(entries: readonly AccessLimitEntry[], nowMs: number): string[] {
  return ordered(entries.filter((e) => e.untilMs === null || e.untilMs > nowMs)).map((e) => {
    const cls = `${e.class}${e.weekly ? ' (weekly)' : ''}`;
    const when = e.untilMs === null ? `since ${minuteIso(e.firstSeenMs)}; ${untimedClearText(e)}` : `until ${minuteIso(e.untilMs)} (${e.resetBasis})`;
    return `${accessScopeText(e.scope)}: ${cls} ${when} (${e.source})`;
  });
}

/**
 * How a blocked task starts again (D's R76, 0b66509b): once, automatically, when its wait is over,
 * only while owned workers run automatically (bounded-auto, the kill switch clear) and its checks
 * are still approved; in advise or observe mode a person starts it. A limit again after that one
 * automatic resume waits for a person (OP-5).
 */
export const ACCESS_RESUME_TEXT = Object.freeze({
  timed: 'resumed once then if owned workers run automatically and its checks are still approved, else start it again then',
  cleared: 'once cleared it is resumed if owned workers run automatically and its checks are still approved',
  repeat: 'it was already resumed once, so a person starts it again',
});

/**
 * A blocked task's state reason (design 7.3). `autoResume` false: the task was already resumed
 * automatically once for this limit, so the text promises no second resume (OP-5).
 */
export function accessBlockedReason(pause: AccessPause, options: { readonly autoResume?: boolean } = {}): string {
  const e = pause.entry;
  const cls = `${e.class}${e.weekly ? ' (weekly)' : ''}`;
  const auto = options.autoResume !== false;
  if (pause.untilMs === null) return `ACCESS_LIMITED: ${cls} on ${accessScopeText(e.scope)} since ${minuteIso(e.firstSeenMs).slice(0, 10)}; ${untimedClearText(e)}; ${auto ? ACCESS_RESUME_TEXT.cleared : ACCESS_RESUME_TEXT.repeat}`;
  return `ACCESS_LIMITED: ${cls} on ${accessScopeText(e.scope)} paused until ${minuteIso(pause.untilMs)} (${e.resetBasis}); ${auto ? ACCESS_RESUME_TEXT.timed : `${ACCESS_RESUME_TEXT.repeat} after that`}`;
}

/** An explain note for a model a route left out (design 11). */
export function accessPauseNoteText(modelId: string, note: AccessPauseNote): string {
  return `${modelId}: ACCESS_LIMITED (${accessScopeText(note.scope)}, ${note.class}${note.untilMs === null ? ', no expiry' : ` until ${minuteIso(note.untilMs)}`})`;
}

/**
 * The access pauses for a route (R72, R73): one read of the record, then per registry model the pause
 * in force for the scope `scopeOf` gives it, and the models whose scope hit a limit within `nearMs`
 * (never explored). A missing or unreadable record gives none (fail-open, design 4.3).
 */
export async function routeAccessPauses(input: {
  readonly home: string;
  readonly registry: ModelRegistry;
  readonly nowMs: number;
  /** `nearLimitHours` in ms (default 24 h). */
  readonly nearMs?: number;
  /** The harness and sign-in that would run the model; null leaves it out (no harness reaches it). */
  readonly scopeOf: (modelId: string) => { readonly harness: string | null; readonly authMode: string | null } | null;
}): Promise<{ readonly paused: Readonly<Record<string, AccessPauseNote>>; readonly nearLimitModelIds: readonly string[] }> {
  const entries = (await readAccessLimits(input.home).catch(() => ({ entries: [] as readonly AccessLimitEntry[] }))).entries;
  if (entries.length === 0) return { paused: {}, nearLimitModelIds: [] };
  const ids = input.registry.entries.map((m) => m.modelId);
  const query = (modelId: string): AccessQuery | null => {
    const s = input.scopeOf(modelId);
    return s === null ? null : accessQueryFor(input.registry, s.harness, modelId, s.authMode);
  };
  const nearMs = input.nearMs ?? 24 * HOUR;
  const near = ids.filter((m) => {
    const q = query(m);
    return q !== null && accessLimitNear(entries, q, input.nowMs, nearMs);
  });
  return { paused: pausedModels(entries, ids, query, input.nowMs), nearLimitModelIds: [...new Set(near)].sort() };
}

/**
 * The pause in force for a harness spelling (R73: a route.turn target, a subagent's harness model):
 * the harness, the sign-in and the serving host the spelling resolves to. Null when none, or when
 * the spelling has no scope Jevris can name.
 */
export function accessPauseForSpelling(entries: readonly AccessLimitEntry[], registry: ModelRegistry, harness: string, spelling: string, authMode: string | null, nowMs: number): AccessPause | null {
  if (entries.length === 0) return null;
  const query = accessScopeOf(registry, harness, spelling, authMode ?? 'unknown');
  return query === null ? null : accessPauseFor(entries, query, nowMs);
}

/**
 * OP-10: a session whose own scope is paused gets advice only, never a switch. The fixed text names
 * the class and the reset, and one model this harness can run that is not paused (the first of
 * `candidates`, sorted, other than the current one), when there is one.
 */
export function sessionPauseAdvice(input: {
  readonly entries: readonly AccessLimitEntry[];
  readonly registry: ModelRegistry;
  readonly harness: string;
  readonly authMode: string | null;
  readonly pause: AccessPause;
  readonly currentModelId: string | null;
  readonly candidates: readonly string[];
  readonly nowMs: number;
}): { readonly reasonCode: 'ACCESS_LIMITED'; readonly eligibleModelId: string | null; readonly text: string } {
  const eligible =
    [...new Set(input.candidates)]
      .filter((m) => m !== input.currentModelId && registryModel(input.registry, m) !== null)
      .sort()
      .find((m) => {
        const q = accessQueryFor(input.registry, input.harness, m, input.authMode);
        return q !== null && accessPauseFor(input.entries, q, input.nowMs) === null;
      }) ?? null;
  const e = input.pause.entry;
  const when = input.pause.untilMs === null ? `with no expiry (it ${untimedClearText(e)})` : `until ${minuteIso(input.pause.untilMs)}`;
  const next = eligible === null ? 'no other model is known to be usable here' : `${eligible} runs here and is not paused`;
  return {
    reasonCode: 'ACCESS_LIMITED',
    eligibleModelId: eligible,
    text: `This session's ${accessScopeText(e.scope)} is paused: ${e.class}${e.weekly ? ' (weekly)' : ''} ${when}. Jevris does not switch a session for a limit; ${next}. Switching is yours.`,
  };
}
