/**
 * Access limits (access-limits design, R59; coordinator decisions 1e88b2b and bdfb6e3a): credit,
 * quota windows, rate limits and blocked accounts, paused per harness, sign-in and serving host
 * in every harness and never counted as a model failure. Contracts holds the shared vocabulary,
 * the pinned text patterns and the one text matcher, so a hook-side adapter and a worker can
 * classify an error message without importing core and without passing the message on. Core
 * (C2, R60) owns the signal table, the classifier, the record and the timing rules.
 *
 * - Nothing here holds a message, body, header value, account name, key or path. A text match
 *   yields a pattern id, booleans and numbers only.
 * - The patterns are pinned and frozen: a repository file, a config or a model cannot add one.
 *   They run only on a harness's own error channel (design 5.5), never on tool output, assistant
 *   text or an MCP call; that guard is the caller's.
 */
import { AUTH_MODES, HARNESS_IDS, HarnessIdSchema, Id, ModelId, NonNegativeInteger, Timestamp, type AuthMode } from './primitives.js';
import { PROVIDER_IDS } from './routing.js';
import * as S from './schema.js';
import { SERVING_HOST_IDS } from './serving-hosts.js';

/**
 * How an account is limited (design 4.2). `overloaded` is the provider's own load and is never
 * recorded as a pause (design 7.4); the first four are.
 */
export const ACCESS_LIMIT_CLASSES = ['rate-limit', 'usage-window', 'credit-exhausted', 'account-blocked', 'overloaded'] as const;
export type AccessLimitClass = (typeof ACCESS_LIMIT_CLASSES)[number];
/** The classes that are recorded as a pause. */
export const ACCESS_PAUSE_CLASSES = ['rate-limit', 'usage-window', 'credit-exhausted', 'account-blocked'] as const satisfies readonly AccessLimitClass[];
export type AccessPauseClass = (typeof ACCESS_PAUSE_CLASSES)[number];

/** The sign-in an access limit belongs to: the same vocabulary as the harness auth view. */
export const ACCESS_AUTH_MODES = AUTH_MODES;
export type AccessAuthMode = AuthMode;

/** The parties a limit can be recorded against: a pinned maker or a pinned serving host. */
export const ACCESS_SERVING_HOSTS = [...PROVIDER_IDS, ...SERVING_HOST_IDS] as const;

/**
 * The account a limit belongs to (design 4.1). The Agent SDK counts as `claude`. `modelId` and
 * `family` are set only when the signal names one; otherwise the limit is scope-wide.
 */
export const AccessScopeSchema = S.object({
  harness: HarnessIdSchema,
  authMode: S.enumOf(ACCESS_AUTH_MODES),
  servingHost: S.enumOf(ACCESS_SERVING_HOSTS),
  modelId: S.nullable(ModelId),
  family: S.nullable(Id),
});
export type AccessScope = S.Static<typeof AccessScopeSchema>;

/** Where a signal comes from: a harness, or the Anthropic API under the Agent SDK. */
export const ACCESS_SIGNAL_PORTS = [...HARNESS_IDS, 'claude-api'] as const;
export type AccessSignalPort = (typeof ACCESS_SIGNAL_PORTS)[number];

/** In table order (the first match wins): Gemini's credit and account texts come before G1. */
export const ACCESS_TEXT_PATTERN_IDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'X1', 'X2', 'X3', 'X4', 'X5', 'G4', 'G5', 'G8', 'G1', 'G2', 'G6', 'G7', 'G3'] as const;
export type AccessTextPatternId = (typeof ACCESS_TEXT_PATTERN_IDS)[number];

export interface AccessTextPattern {
  readonly id: AccessTextPatternId;
  /** Case-insensitive; run on at most 4 KiB of error-channel text. */
  readonly pattern: RegExp;
  /** The class the text means; null for G3, which carries only a reset. */
  readonly class: AccessLimitClass | null;
  /** The ports whose error channel may carry this wording. */
  readonly ports: readonly AccessSignalPort[];
}

/** An apostrophe as the harnesses print it: straight or typographic. */
const AP = "(?:'|’)";
const CLAUDE_PORTS = Object.freeze(['claude', 'claude-api', 'kilocode', 'opencode'] as const);
const CODEX_ONLY = Object.freeze(['codex'] as const);
const CODEX_AND_GATEWAYS = Object.freeze(['codex', 'kilocode', 'opencode'] as const);
const ANTIGRAVITY_ONLY = Object.freeze(['antigravity'] as const);
const row = (id: AccessTextPatternId, source: string, cls: AccessLimitClass | null, ports: readonly AccessSignalPort[]): AccessTextPattern =>
  Object.freeze({ id, pattern: new RegExp(source, 'i'), class: cls, ports });

/**
 * The pinned text patterns (design 5.3), checked in this order; the first that matches wins,
 * except that X2 never wins where X1 matched (Codex's usage-limit text says "purchase more credits
 * or try again at"). Bare `quota`, `rate.?limit` and `resource.?exhausted` are not patterns.
 */
export const ACCESS_TEXT_PATTERNS: readonly AccessTextPattern[] = Object.freeze([
  row('C1', `you${AP}ve hit your (session|weekly|opus|sonnet) limit|usage limit reached(?:\\|(\\d{9,13}))?`, 'usage-window', CLAUDE_PORTS),
  row('C2', `you${AP}ve hit your (?:monthly|individual|org${AP}s monthly|channel${AP}s monthly) spend limit|team${AP}s shared budget|individual usage limit`, 'credit-exhausted', CLAUDE_PORTS),
  row('C3', 'server is temporarily limiting requests|request rejected \\(429\\)', 'rate-limit', CLAUDE_PORTS),
  row('C4', 'not logged in|login expired|invalid authentication credentials', 'account-blocked', CLAUDE_PORTS),
  row('C5', 'credit balance is too low', 'credit-exhausted', CLAUDE_PORTS),
  row('C6', 'repeated 529 overloaded|is experiencing high load', 'overloaded', CLAUDE_PORTS),
  row('X1', `you${AP}ve hit your usage limit`, 'usage-window', CODEX_ONLY),
  // Codex 0.157.1 prints its own sentence for a 429 whose body says insufficient_quota (and drops
  // the body): CodexErr::QuotaExceeded, "Quota exceeded. Check your plan and billing details."
  // (openai/codex rust-v0.157.1, protocol/src/error.rs and codex-api/src/api_bridge.rs; the owner's
  // certify run, K17 NO_ACCESS_SIGNAL). A rate-limit 429 prints "exceeded retry limit, last status:
  // 429 Too Many Requests", so the two stay apart.
  row('X2', 'exceeded your current quota|quota exceeded\\. check your plan and billing details|insufficient_quota|credit balance|insufficient (?:balance|credits)|credits (?:are )?depleted|out of credits', 'credit-exhausted', CODEX_AND_GATEWAYS),
  row('X3', 'account (?:has been |is )?(?:deactivated|suspended|disabled|on hold)|api key (?:has been )?revoked|invalid api key|incorrect api key|token (?:has )?expired|please (?:log|sign) ?in again', 'account-blocked', CODEX_AND_GATEWAYS),
  row('X4', '\\b429\\b|too many requests|rate limit (?:reached|exceeded)', 'rate-limit', CODEX_ONLY),
  row('X5', '\\b(?:503|529)\\b|overloaded|server_is_overloaded', 'overloaded', CODEX_ONLY),
  // Gemini's own error texts (https://ai.google.dev/gemini-api/docs/api-errors and
  // .../troubleshooting, re-read 2026-09-28), quoted exactly; credit and account come first.
  // 402: "Your Prepay credit balance is depleted."
  row('G4', 'credit balance is depleted', 'credit-exhausted', ANTIGRAVITY_ONLY),
  // Troubleshooting: "Your API key was reported as leaked. Please use another API key."
  row('G5', 'api key was reported as leaked', 'account-blocked', ANTIGRAVITY_ONLY),
  // 401 authentication (api-errors, re-read 2026-09-28, page updated 2026-09-20): "The API key is
  // missing, invalid, or expired." The whole sentence only; a bare 401, 403, 400 or
  // PERMISSION_DENIED is never a pattern, and 403's "does not have permission for this resource" is
  // a per-resource refusal, not a blocked key.
  row('G8', 'api key is missing, invalid,? or expired', 'account-blocked', ANTIGRAVITY_ONLY),
  // "disk quota exceeded" or a storage quota is not an account limit. 429 quota_exceeded: "You
  // have exceeded your daily quota." G1 stays ahead of G6 (F's held fixture).
  row('G1', '(?<!(?:disk|storage|file|inode) )(?:quota|usage limit) (?:limit )?(?:reached|exceeded)|reached the quota|exceeded your daily quota', 'usage-window', ANTIGRAVITY_ONLY),
  row('G2', 'weekly (?:limit|quota)', 'usage-window', ANTIGRAVITY_ONLY),
  // 429 rate_limit_exceeded: "You have exceeded the per-minute or per-second request or token limit."
  row('G6', 'exceeded the per-minute or per-second request or token limit', 'rate-limit', ANTIGRAVITY_ONLY),
  // 503: "The service is temporarily overloaded or down."
  row('G7', 'temporarily overloaded', 'overloaded', ANTIGRAVITY_ONLY),
  row('G3', 'resets? in (\\d+)h(?: ?(\\d+)m)?|resets? in (\\d+) (minutes?|hours?|days?)', null, ANTIGRAVITY_ONLY),
]);

/** What a text match says: ids, booleans and numbers only, never the text. */
export interface AccessTextMatch {
  readonly pattern: AccessTextPatternId;
  readonly weekly: boolean;
  readonly family: 'opus' | 'sonnet' | null;
  /** A reset the text states; core ignores one in the past or more than 8 days away. */
  readonly resetAtMs: number | null;
  /**
   * How the reset was written: an epoch, a relative time, or a date with no time zone (read as
   * this machine's local time). Core uses a zoneless date only when the signal is certified.
   */
  readonly resetForm: 'epoch' | 'relative' | 'zoneless-date' | null;
}

export const ACCESS_TEXT_MAX_CHARS = 4096;

const UNIT_MS: { readonly [unit: string]: number } = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function relative(amount: string | undefined, unit: string | undefined, nowMs: number): number | null {
  if (amount === undefined || unit === undefined) return null;
  const per = UNIT_MS[unit.toLowerCase().replace(/s$/, '')];
  const n = Number(amount);
  return per === undefined || !Number.isSafeInteger(n) ? null : nowMs + n * per;
}

/** Codex's "try again at Feb 23rd, 2026 9:01 PM": a date with no zone, read as local time. */
function zonelessDate(text: string): number | null {
  const m = /try again at ([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?:,? (\d{1,2}):(\d{2}) ?([ap]m)?)?/i.exec(text);
  if (m === null) return null;
  const month = MONTHS.indexOf((m[1] as string).toLowerCase());
  if (month < 0) return null;
  let hour = m[4] === undefined ? 0 : Number(m[4]);
  const meridiem = m[6]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const at = new Date(Number(m[3]), month, Number(m[2]), hour, m[5] === undefined ? 0 : Number(m[5])).getTime();
  return Number.isFinite(at) ? at : null;
}

function g3Reset(text: string, nowMs: number): number | null {
  const m = (ACCESS_TEXT_PATTERNS.find((r) => r.id === 'G3') as AccessTextPattern).pattern.exec(text);
  if (m === null) return null;
  if (m[1] !== undefined) return nowMs + Number(m[1]) * 3_600_000 + (m[2] === undefined ? 0 : Number(m[2]) * 60_000);
  return relative(m[3], m[4], nowMs);
}

/**
 * The one text matcher (design 5.3): the first pinned pattern for this port that matches the
 * last 4 KiB of an error-channel text, with its weekly flag, family and stated reset. Null when
 * none matches. The caller keeps the result and drops the text.
 */
export function matchAccessText(text: string, port: AccessSignalPort, nowMs: number): AccessTextMatch | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const tail = text.length > ACCESS_TEXT_MAX_CHARS ? text.slice(-ACCESS_TEXT_MAX_CHARS) : text;
  const rows = ACCESS_TEXT_PATTERNS.filter((r) => r.ports.includes(port));
  const x1 = rows.some((r) => r.id === 'X1' && r.pattern.test(tail));
  for (const r of rows) {
    if (r.class === null) continue;
    if (r.id === 'X2' && x1) continue;
    const m = r.pattern.exec(tail);
    if (m === null) continue;
    let weekly = false;
    let family: 'opus' | 'sonnet' | null = null;
    let resetAtMs: number | null = null;
    let resetForm: AccessTextMatch['resetForm'] = null;
    if (r.id === 'C1') {
      const which = m[1]?.toLowerCase();
      weekly = which === 'weekly' || which === 'opus' || which === 'sonnet';
      family = which === 'opus' || which === 'sonnet' ? which : null;
      if (m[2] !== undefined) {
        const n = Number(m[2]);
        resetAtMs = n < 1e12 ? n * 1000 : n;
        resetForm = 'epoch';
      }
    } else if (r.id === 'X1') {
      weekly = /\bweekly\b/i.test(tail);
      const inMatch = /\bin (\d+) (minutes?|hours?|days?)\b/i.exec(tail);
      const date = zonelessDate(tail);
      if (date !== null) {
        resetAtMs = date;
        resetForm = 'zoneless-date';
      } else if (inMatch !== null) {
        resetAtMs = relative(inMatch[1], inMatch[2], nowMs);
        resetForm = resetAtMs === null ? null : 'relative';
      }
    } else if (r.id === 'G1' || r.id === 'G2') {
      weekly = r.id === 'G2' || /\bweekly\b/i.test(tail);
      resetAtMs = g3Reset(tail, nowMs);
      resetForm = resetAtMs === null ? null : 'relative';
    }
    return Object.freeze({ pattern: r.id, weekly, family, resetAtMs, resetForm });
  }
  if (port === 'antigravity') {
    const reset = g3Reset(tail, nowMs);
    if (reset !== null) return Object.freeze({ pattern: 'G3', weekly: false, family: null, resetAtMs: reset, resetForm: 'relative' });
  }
  return null;
}

/** An enum-checked code a vendor sends (`billing_error`, `insufficient_quota`, `1113`): never text. */
const SignalCode = S.string({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._:-]{1,64}$' });

// Reset headers (design 5.1; moved from core so the hook can read one without core). Pure: the
// header values are read in memory and only the time is returned.

const HEADER_VALUE = /^[\x20-\x7e]{1,128}$/;

function goDurationMs(value: string): number | null {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value);
  if (m === null || value === '') return null;
  const [h, min, s, ms] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  const total = (h as number) * 3_600_000 + (min as number) * 60_000 + (s as number) * 1000 + (ms as number);
  return Number.isFinite(total) ? Math.round(total) : null;
}

function epochOrSeconds(value: string, nowMs: number): number | null {
  if (!/^\d{1,13}$/.test(value)) return null;
  const n = Number(value);
  if (n >= 1e12) return n;
  if (n >= 1e9) return n * 1000;
  return nowMs + n * 1000;
}

/**
 * When a limit lifts, from response headers (in memory; no value is kept), as epoch ms, or null.
 * Reads, in this order: `retry-after-ms`; `retry-after` (seconds or an HTTP date);
 * `anthropic-ratelimit-*-reset` (RFC 3339, the latest present); `x-ratelimit-reset-*` (Go-style
 * durations such as `1s` or `6m0s`, the latest); `x-ratelimit-reset` (an epoch in s or ms, or
 * seconds); `anthropic-ratelimit-unified-reset` (an epoch; unverified, kept as one more name).
 */
export function resetFromHeaders(headers: { readonly [name: string]: unknown } | null | undefined, nowMs: number): number | null {
  if (headers === null || headers === undefined || typeof headers !== 'object' || !Number.isFinite(nowMs)) return null;
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers).slice(0, 64)) {
    if (typeof v !== 'string') continue;
    const value = v.trim();
    if (HEADER_VALUE.test(value)) lower.set(k.toLowerCase(), value);
  }
  const retryMs = lower.get('retry-after-ms');
  if (retryMs !== undefined && /^\d{1,10}(?:\.\d+)?$/.test(retryMs)) return nowMs + Math.round(Number(retryMs));
  const retry = lower.get('retry-after');
  if (retry !== undefined) {
    if (/^\d{1,9}(?:\.\d+)?$/.test(retry)) return nowMs + Math.round(Number(retry) * 1000);
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return at;
  }
  const latest = (values: readonly (number | null)[]): number | null => values.reduce<number | null>((a, b) => (b === null ? a : a === null || b > a ? b : a), null);
  const rfc = latest([...lower].filter(([k]) => /^anthropic-ratelimit-[a-z-]+-reset$/.test(k) && k !== 'anthropic-ratelimit-unified-reset').map(([, v]) => (/^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)));
  if (rfc !== null) return rfc;
  const durations = latest([...lower].filter(([k]) => /^x-ratelimit-reset-[a-z-]+$/.test(k)).map(([, v]) => {
    const d = goDurationMs(v);
    return d === null ? null : nowMs + d;
  }));
  if (durations !== null) return durations;
  const plain = lower.get('x-ratelimit-reset');
  if (plain !== undefined) {
    const at = epochOrSeconds(plain, nowMs) ?? (goDurationMs(plain) === null ? null : nowMs + (goDurationMs(plain) as number));
    if (at !== null) return at;
  }
  const unified = lower.get('anthropic-ratelimit-unified-reset');
  if (unified !== undefined && /^\d{9,13}$/.test(unified)) return epochOrSeconds(unified, nowMs);
  return null;
}

export const AccessTextMatchSchema = S.object({
  pattern: S.enumOf(ACCESS_TEXT_PATTERN_IDS),
  weekly: S.boolean(),
  family: S.nullable(S.enumOf(['opus', 'sonnet'] as const)),
  resetAtMs: S.nullable(NonNegativeInteger),
  resetForm: S.nullable(S.enumOf(['epoch', 'relative', 'zoneless-date'] as const)),
});

/**
 * An access signal as it crosses a process boundary (a hook's `turn.failed`, a worker's outcome):
 * the port, the channel, enum-checked codes, a reported reset and a text match. No message,
 * body or header value can fit (design 12). Whether the channel is certified is never on the
 * wire (B's MEDIUM 22, OP-4): the sender cannot assert its own proof. The sidecar or core looks
 * it up from the signed certify record of that harness version and adds it in memory.
 */
export const AccessSignalWireSchema = S.object(
  {
    port: S.enumOf(ACCESS_SIGNAL_PORTS),
    channel: S.enumOf(['structured', 'error-text'] as const),
  },
  {
    status: S.integer({ minimum: 100, maximum: 599 }),
    errorType: SignalCode,
    errorCode: SignalCode,
    rateLimitType: SignalCode,
    resetAtMs: NonNegativeInteger,
    text: AccessTextMatchSchema,
  },
);
export type AccessSignalWire = S.Static<typeof AccessSignalWireSchema>;

/**
 * An access signal in memory (design 5.1), never parsed from a body: the wire fields, whether this
 * harness version's certify capture proved the channel (from the caller's own lookup of the signed
 * certify record, never from the sender), and the response headers, which only core's
 * `resetFromHeaders` reads and nothing stores.
 */
export interface AccessSignal extends AccessSignalWire {
  readonly certified: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** How a reset was set: reported by the vendor, from the timing rule, or none (an untimed class). */
export const ACCESS_RESET_BASES = ['reported', 'rule', 'none'] as const;

/**
 * What an owned worker found when its run hit an access limit (status `access-limit` or
 * `overloaded`): core's classification, so D records it without classifying again. `signal` is
 * the id of core's ACCESS_SIGNALS row.
 */
export const AccessLimitFindingSchema = S.object(
  {
    class: S.enumOf(ACCESS_LIMIT_CLASSES),
    signal: S.string({ pattern: '^[a-z][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9_-]*){1,4}$', maxLength: 96 }),
    weekly: S.boolean(),
    resetBasis: S.enumOf(ACCESS_RESET_BASES),
  },
  {
    resetAtMs: NonNegativeInteger,
    modelId: ModelId,
    family: Id,
  },
);
export type AccessLimitFinding = S.Static<typeof AccessLimitFindingSchema>;

/**
 * Where a recorded limit came from: an owned run, a main session's own signal, or a harness's own
 * structured usage reading (OP-6: Codex's account/rateLimits/read).
 */
export const ACCESS_LIMIT_SOURCES = ['owned-run', 'session', 'usage-read'] as const;

/**
 * How much of a usage window a reading says is used (OP-6): only this band is kept, never the
 * percentage or the payload. `exhausted` is 100 % or more.
 */
export const ACCESS_USAGE_BANDS = ['under-50', '50-80', '80-100', 'exhausted'] as const;
export type AccessUsageBand = (typeof ACCESS_USAGE_BANDS)[number];

/** At most this many pauses are listed in status; `active` counts them all. */
export const ACCESS_STATUS_MAX_ENTRIES = 16;

/**
 * One pause in force, as status shows it (R79): `until` null is untimed; `since` is when it was
 * first seen. Never the credential fingerprint, the hit count, the doubling step or any text.
 */
export const AccessLimitStatusEntrySchema = S.object({
  key: S.string({ pattern: '^[0-9a-f]{16}$' }),
  class: S.enumOf(ACCESS_PAUSE_CLASSES),
  weekly: S.boolean(),
  scope: AccessScopeSchema,
  until: S.nullable(Timestamp),
  resetBasis: S.enumOf(ACCESS_RESET_BASES),
  source: S.enumOf(ACCESS_LIMIT_SOURCES),
  since: Timestamp,
}, {
  // Whether a new API key clears this pause (core's accessNewKeyClears: an API-key sign-in whose
  // key Jevris passes itself). A boolean only: the record keeps a 16-hex key fingerprint for an
  // API-key entry, and status never carries it. Absent reads as false.
  newKeyClears: S.boolean(),
});
export type AccessLimitStatusEntry = S.Static<typeof AccessLimitStatusEntrySchema>;

/**
 * The machine's access pauses in force (R79, design 11), in the record's order (untimed first,
 * then the soonest to lift). `readable` false is ACCESS_LIMITS_UNREADABLE (it pauses nothing);
 * `full` is ACCESS_LIMITS_FULL.
 */
export const AccessLimitsStatusSchema = S.object({
  readable: S.boolean(),
  full: S.boolean(),
  active: NonNegativeInteger,
  entries: S.array(AccessLimitStatusEntrySchema, { maxItems: ACCESS_STATUS_MAX_ENTRIES }),
});
export type AccessLimitsStatus = S.Static<typeof AccessLimitsStatusSchema>;

/** The harnesses a usage reading exists for in status (OP-6: Codex only; core's ACCESS_USAGE_HARNESSES). */
export const ACCESS_USAGE_STATUS_HARNESSES = ['codex'] as const;
/** At most this many readings (one per harness and sign-in, core's cap) and windows per reading. */
export const ACCESS_USAGE_STATUS_MAX_READINGS = 4;
export const ACCESS_USAGE_STATUS_MAX_WINDOWS = 2;

/** One usage window as status shows it (OP-6): a band, never the percentage; the reset if valid. */
export const AccessUsageWindowStatusSchema = S.object({
  weekly: S.boolean(),
  band: S.enumOf(ACCESS_USAGE_BANDS),
  resetsAt: S.nullable(Timestamp),
});

/**
 * The last usage reading for one harness and sign-in (OP-6, owner decision 9deb30c8): when it was
 * read, whether it said ordinary usage is allowed (null: it did not say), and each window's band.
 * Never the raw percentage, the payload or any text. The sign-in is the one Jevris launched with.
 */
export const AccessUsageStatusEntrySchema = S.object({
  harness: S.enumOf(ACCESS_USAGE_STATUS_HARNESSES),
  authMode: S.enumOf(ACCESS_AUTH_MODES),
  readAt: Timestamp,
  allowed: S.nullable(S.boolean()),
  windows: S.array(AccessUsageWindowStatusSchema, { maxItems: ACCESS_USAGE_STATUS_MAX_WINDOWS }),
});
export type AccessUsageStatusEntry = S.Static<typeof AccessUsageStatusEntrySchema>;

/**
 * The kept usage readings, newest first (core's readAccessUsageReadings: none older than 7 days).
 * `readable` false is ACCESS_USAGE_UNREADABLE: the file reads as empty, so it pauses and lifts nothing.
 */
export const AccessUsageStatusSchema = S.object({
  readable: S.boolean(),
  readings: S.array(AccessUsageStatusEntrySchema, { maxItems: ACCESS_USAGE_STATUS_MAX_READINGS }),
});
export type AccessUsageStatus = S.Static<typeof AccessUsageStatusSchema>;

/** The reason codes access limits add (design 11). */
export const ACCESS_REASON_CODES = [
  'ACCESS_LIMITED',
  'ACCESS_LIMIT_RECORDED',
  'ACCESS_LIMIT_CLEARED',
  'ACCESS_LIMIT_RESET',
  'ACCESS_SCOPE_UNKNOWN',
  'ACCESS_LIMITS_UNREADABLE',
  'ACCESS_LIMITS_FULL',
  'ACCESS_USAGE_UNREADABLE',
  'PROVIDER_OVERLOADED',
  'PROVIDER_BILLING',
] as const;
export type AccessReasonCode = (typeof ACCESS_REASON_CODES)[number];

/** Why a pause was cleared, as a trace detail of ACCESS_LIMIT_CLEARED (USAGE_READ: a certified usage reading, OP-6). */
export const ACCESS_CLEAR_CAUSES = ['EXPIRED', 'FINGERPRINT', 'SUCCESS', 'MANUAL', 'USAGE_READ'] as const;
export type AccessClearCause = (typeof ACCESS_CLEAR_CAUSES)[number];

