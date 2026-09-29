/**
 * OP-6 (owner decision 2026-09-28, DOMAINS 9deb30c8): a structured, read-only usage reading of a
 * harness's own account windows. F's reader reads Codex's `account/rateLimits/read` locally, only in
 * the app-server session the model listing already opens, and passes numbers only: each window's
 * used percentage, length and reset. Core keeps a band, a weekly flag and a reset validated to be
 * in the future and at most 8 days ahead, never the raw percentage or the payload.
 *
 * - Set. An exhausted window (100 % or more used) records a timed usage-window on the harness's
 *   scope (sign-in and serving host, not a model), rows `codex.usage-read.window` and
 *   `codex.usage-read.weekly`, until the reported reset or by the rule. An uncertified reading may
 *   set one: it fails toward pausing and a pause is never a safety control.
 * - Allowed. Codex's own `ordinaryUsageAllowed` (F): false with no window exhausted also sets the
 *   timed usage-window (until the latest window reset, else by the rule); null ("unavailable":
 *   clients must not infer recovery) never lifts.
 * - Lift. Only a certified reading that says usage is allowed and has no exhausted window lifts that exact sign-in's usage-window
 *   entries whose row is a usage window (never credit, blocked, a rate limit, an OP-4 held text, or
 *   an unknown sign-in's entry), and only those last seen at least 2 minutes before the reading (the
 *   reading may come from an older snapshot). Trace cause USAGE_READ.
 * - Sign-in. The reading's sign-in is the one Jevris launched the app-server with (the owned
 *   worker's resolved mode), never a value from the payload.
 * - Kept. The last reading per harness and sign-in, in `<data>/route-learning/usage-readings.json`
 *   (schema `jevris-access-usage-1`, at most 4 readings and 4,096 bytes, 0600, under the file lock),
 *   for status and doctor. Missing, oversized or malformed reads as empty (fail-open).
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCESS_AUTH_MODES, ACCESS_USAGE_BANDS, type AccessAuthMode, type AccessUsageBand } from '@jevris/contracts';
import { durableWrite, jevrisPaths } from '@jevris/platform';
import {
  ACCESS_HARNESS_HOST,
  ACCESS_TIMING,
  accessUntilMs,
  issueUsageWindowClassification,
  liftUsageWindows,
  recordAccessLimit,
  type AccessLimitEntry,
  type AccessQuery,
  type ClearedAccessLimit,
} from './access-limits.js';
import { withFileLock } from './route-file-lock.js';

export const ACCESS_USAGE_SCHEMA = 'jevris-access-usage-1' as const;

/** The harnesses a usage reading exists for (OP-6: Codex only). */
export const ACCESS_USAGE_HARNESSES = Object.freeze(['codex'] as const);
export type AccessUsageHarness = (typeof ACCESS_USAGE_HARNESSES)[number];

export const ACCESS_USAGE_CAPS = Object.freeze({ maxWindows: 2, maxReadings: 4, maxBytes: 4096 });

/** A window at least this long is the weekly one. */
const WEEKLY_WINDOW_MINUTES = 6 * 24 * 60;

/** One window as F's reader passes it: numbers only, never the payload. */
export interface AccessUsageWindowInput {
  /** `used_percent`, 0-100 (more than 100 reads as exhausted). */
  readonly usedPercent: number;
  /** `window_minutes`, or null when the payload gave none. */
  readonly windowMinutes: number | null;
  /** `resets_at` in ms, or null. */
  readonly resetsAtMs: number | null;
}

export interface AccessUsageReadingInput {
  readonly harness: AccessUsageHarness;
  /**
   * The sign-in Jevris itself launched the Codex app-server with (the owned worker's resolved
   * mode), never one read from the Codex payload (B).
   */
  readonly authMode: AccessAuthMode;
  /** At most 2 (primary, secondary). */
  readonly windows: readonly AccessUsageWindowInput[];
  /** Codex's `ordinaryUsageAllowed`: null (or absent) when the reading does not say. */
  readonly ordinaryUsageAllowed?: boolean | null;
  /** Whether F's certify case proves the read's fields for the installed version. */
  readonly certified: boolean;
}

/** One window as kept. */
export interface AccessUsageWindow {
  readonly weekly: boolean;
  readonly band: AccessUsageBand;
  /** A reset in the future and at most 8 days ahead, else null. */
  readonly resetAtMs: number | null;
}

export interface AccessUsageReading {
  readonly harness: AccessUsageHarness;
  readonly authMode: AccessAuthMode;
  readonly readAtMs: number;
  /** Whether the reading said ordinary usage is allowed; null when it did not say. */
  readonly allowed: boolean | null;
  readonly windows: readonly AccessUsageWindow[];
}

/** The band of a used percentage; null for a value that is not a finite number of at least 0. */
export function accessUsageBand(usedPercent: number): AccessUsageBand | null {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return null;
  if (usedPercent >= 100) return 'exhausted';
  if (usedPercent >= 80) return '80-100';
  if (usedPercent >= 50) return '50-80';
  return 'under-50';
}

const intMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;

function futureReset(ms: number | null, nowMs: number): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const at = Math.round(ms);
  return at > nowMs && at - nowMs <= ACCESS_TIMING.maxReportedAheadMs ? at : null;
}

/**
 * What is kept of a reading (pure): each window's band, weekly flag and validated reset. Null when
 * the reading is malformed or has no valid window: then nothing is recorded, lifted or kept.
 */
export function reduceAccessUsage(reading: AccessUsageReadingInput, nowMs: number): AccessUsageReading | null {
  if (reading === null || typeof reading !== 'object' || !intMs(nowMs)) return null;
  if (!(ACCESS_USAGE_HARNESSES as readonly string[]).includes(reading.harness)) return null;
  if (!(ACCESS_AUTH_MODES as readonly string[]).includes(reading.authMode)) return null;
  if (!Array.isArray(reading.windows) || reading.windows.length === 0 || reading.windows.length > ACCESS_USAGE_CAPS.maxWindows) return null;
  const windows: AccessUsageWindow[] = [];
  for (const w of reading.windows as readonly AccessUsageWindowInput[]) {
    if (w === null || typeof w !== 'object') return null;
    const band = accessUsageBand(w.usedPercent);
    if (band === null) return null;
    const minutes = typeof w.windowMinutes === 'number' && Number.isFinite(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null;
    windows.push({ weekly: minutes !== null && minutes >= WEEKLY_WINDOW_MINUTES, band, resetAtMs: futureReset(w.resetsAtMs, nowMs) });
  }
  const said = reading.ordinaryUsageAllowed;
  return { harness: reading.harness, authMode: reading.authMode, readAtMs: nowMs, allowed: said === true ? true : said === false ? false : null, windows };
}

/** `<data>/route-learning/usage-readings.json`. */
export function accessUsagePath(home: string): string {
  return join(jevrisPaths({ home }).data, 'route-learning', 'usage-readings.json');
}

function validReading(v: unknown): AccessUsageReading | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['harness', 'authMode', 'readAtMs', 'allowed', 'windows'].includes(k))) return null;
  const allowed = r['allowed'] ?? null;
  if (allowed !== null && typeof allowed !== 'boolean') return null;
  if (typeof r['harness'] !== 'string' || !(ACCESS_USAGE_HARNESSES as readonly string[]).includes(r['harness'])) return null;
  if (typeof r['authMode'] !== 'string' || !(ACCESS_AUTH_MODES as readonly string[]).includes(r['authMode'])) return null;
  if (!intMs(r['readAtMs']) || !Array.isArray(r['windows']) || r['windows'].length === 0 || r['windows'].length > ACCESS_USAGE_CAPS.maxWindows) return null;
  const windows: AccessUsageWindow[] = [];
  for (const raw of r['windows'] as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const w = raw as Record<string, unknown>;
    if (Object.keys(w).some((k) => !['weekly', 'band', 'resetAtMs'].includes(k))) return null;
    if (typeof w['weekly'] !== 'boolean' || typeof w['band'] !== 'string' || !(ACCESS_USAGE_BANDS as readonly string[]).includes(w['band'])) return null;
    if (w['resetAtMs'] !== null && !intMs(w['resetAtMs'])) return null;
    windows.push({ weekly: w['weekly'], band: w['band'] as AccessUsageBand, resetAtMs: w['resetAtMs'] as number | null });
  }
  return { harness: r['harness'] as AccessUsageHarness, authMode: r['authMode'] as AccessAuthMode, readAtMs: r['readAtMs'], allowed, windows };
}

async function readReadings(home: string): Promise<{ readonly readings: AccessUsageReading[]; readonly readable: boolean; readonly transient: boolean }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(accessUsagePath(home));
  } catch (error) {
    const missing = (error as { readonly code?: string }).code === 'ENOENT';
    return { readings: [], readable: missing, transient: !missing };
  }
  const bad = { readings: [], readable: false, transient: false };
  if (bytes.byteLength > ACCESS_USAGE_CAPS.maxBytes) return bad;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { schemaVersion?: unknown; readings?: unknown };
    if (value === null || typeof value !== 'object' || value.schemaVersion !== ACCESS_USAGE_SCHEMA || !Array.isArray(value.readings)) {
      // A newer file (a rollback after an upgrade) is never downgraded.
      const newer = value !== null && typeof value === 'object' && typeof value.schemaVersion === 'string' && value.schemaVersion !== ACCESS_USAGE_SCHEMA;
      return { readings: [], readable: false, transient: newer };
    }
    const seen = new Set<string>();
    const out: AccessUsageReading[] = [];
    for (const raw of value.readings.slice(0, ACCESS_USAGE_CAPS.maxReadings)) {
      const r = validReading(raw);
      if (r === null || seen.has(`${r.harness}|${r.authMode}`)) continue;
      seen.add(`${r.harness}|${r.authMode}`);
      out.push(r);
    }
    return { readings: out, readable: true, transient: false };
  } catch {
    return bad;
  }
}

/**
 * The last reading per harness and sign-in, newest first, with whether the file could be read.
 * A reading older than 7 days is dropped.
 */
export async function readAccessUsageReadings(home: string, nowMs: number): Promise<{ readonly readings: readonly AccessUsageReading[]; readonly readable: boolean }> {
  // (`transient` stays inside this module: a caller sees readable false either way.)
  const read = await readReadings(home);
  const fresh = read.readings.filter((r) => r.readAtMs <= nowMs && nowMs - r.readAtMs <= ACCESS_TIMING.pruneAfterMs);
  return { readings: fresh.sort((a, b) => b.readAtMs - a.readAtMs), readable: read.readable };
}

async function keepReading(home: string, reading: AccessUsageReading): Promise<boolean> {
  const outcome = await withFileLock(accessUsagePath(home), async () => {
    const read = await readReadings(home);
    // MEDIUM 41's rule: a transient read error or a newer file is never written over. A damaged
    // file is replaced, not set aside: it holds only status bands, and no pause is read back from it.
    if (read.transient) return false;
    const others = read.readings.filter((r) => !(r.harness === reading.harness && r.authMode === reading.authMode));
    const next = [reading, ...others.sort((a, b) => b.readAtMs - a.readAtMs)].slice(0, ACCESS_USAGE_CAPS.maxReadings);
    await mkdir(join(jevrisPaths({ home }).data, 'route-learning'), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ schemaVersion: ACCESS_USAGE_SCHEMA, readings: next })}\n`;
    if (new TextEncoder().encode(body).byteLength > ACCESS_USAGE_CAPS.maxBytes) return false;
    return (await durableWrite(accessUsagePath(home), body, { mode: 0o600 })).ok;
  });
  return outcome === true;
}

export type RecordAccessUsageResult =
  | {
      readonly ok: true;
      readonly reading: AccessUsageReading;
      /** The pause the reading set or kept (an exhausted window), else null. */
      readonly recorded: AccessLimitEntry | null;
      /** Entries a certified reading with no exhausted window lifted (trace ACCESS_LIMIT_CLEARED USAGE_READ). */
      readonly lifted: readonly ClearedAccessLimit[];
      /** False when the reading could not be kept for status (the pause and lift still happened). */
      readonly kept: boolean;
    }
  | { readonly ok: false; readonly reasonCode: 'INVALID_INPUT' | 'LOCK_BUSY' | 'WRITE_FAILED' | 'ACCESS_LIMITS_FULL' | 'ACCESS_LIMITS_UNREADABLE' | 'ACCESS_SCOPE_UNKNOWN' | 'NOT_A_PAUSE' };

/**
 * Applies one usage reading (OP-6): keeps its bands, records a pause for an exhausted window (the
 * one that ends last, since both windows share the scope's one usage-window entry), and lifts the
 * sign-in's usage windows on a certified reading with none exhausted. Never throws.
 */
export async function recordAccessUsageReading(input: {
  readonly home: string;
  readonly reading: AccessUsageReadingInput;
  readonly nowMs: number;
  /** The learning setting `limitCooldownHours` (OP-11). */
  readonly baseHours?: number;
}): Promise<RecordAccessUsageResult> {
  try {
    const reading = reduceAccessUsage(input.reading, input.nowMs);
    if (reading === null || typeof input.home !== 'string') return { ok: false, reasonCode: 'INVALID_INPUT' };
    const host = ACCESS_HARNESS_HOST[reading.harness] as string;
    const scope: AccessQuery = { harness: reading.harness, authMode: reading.authMode, servingHost: host, modelId: null, family: null };
    const base = input.baseHours === undefined ? {} : { baseHours: input.baseHours };
    const kept = await keepReading(input.home, reading);
    const exhausted = reading.windows.filter((w) => w.band === 'exhausted');
    // Usage refused with no window exhausted (F): the window that resets last, else the rule.
    const refused = exhausted.length === 0 && reading.allowed === false ? [reading.windows.filter((w) => w.resetAtMs !== null).sort((a, b) => (b.resetAtMs as number) - (a.resetAtMs as number))[0] ?? { weekly: false, band: 'exhausted' as const, resetAtMs: null }] : [];
    const pausing = exhausted.length > 0 ? exhausted : refused;
    if (pausing.length > 0) {
      const endOf = (w: AccessUsageWindow): number => accessUntilMs({ class: 'usage-window', nowMs: input.nowMs, step: 0, weekly: w.weekly, reportedResetMs: w.resetAtMs, ...base }) as number;
      const last = pausing.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
      const classification = issueUsageWindowClassification({ harness: reading.harness, weekly: last.weekly, resetAtMs: last.resetAtMs, nowMs: input.nowMs, ...base });
      const result = await recordAccessLimit({ home: input.home, scope, classification, source: 'usage-read', nowMs: input.nowMs, ...base });
      if (!result.ok) return { ok: false, reasonCode: result.reasonCode };
      return { ok: true, reading, recorded: result.entry, lifted: [], kept };
    }
    const certified = input.reading.certified === true;
    // Null means unavailable: Codex says clients must not infer recovery from it.
    if (!certified || reading.allowed !== true || reading.authMode === 'unknown') return { ok: true, reading, recorded: null, lifted: [], kept };
    const lift = await liftUsageWindows(input.home, scope, reading.readAtMs);
    if (!lift.ok) return { ok: false, reasonCode: lift.reasonCode ?? 'WRITE_FAILED' };
    return { ok: true, reading, recorded: null, lifted: lift.cleared, kept };
  } catch {
    return { ok: false, reasonCode: 'WRITE_FAILED' };
  }
}

/** Deletes the file under its lock (`jevris route learning reset --machine`). A missing file is already removed. */
export async function removeAccessUsageReadings(home: string): Promise<{ readonly ok: boolean }> {
  const outcome = await withFileLock(accessUsagePath(home), async () => {
    try {
      await rm(accessUsagePath(home));
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'ENOENT') return false;
    }
    return true;
  });
  return { ok: outcome === true };
}

const minuteIso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

const BAND_TEXT: { readonly [band in AccessUsageBand]: string } = Object.freeze({
  'under-50': 'under 50% used',
  '50-80': '50-80% used',
  '80-100': '80-100% used',
  exhausted: 'used up',
});

/**
 * One fixed line per reading (status, doctor): `codex subscription: short window 80-100% used
 * (resets 2026-09-28T17:00Z); weekly window under 50% used (read 2026-09-28T12:00Z)`, with
 * `usage not allowed; ` after the colon when the reading said so.
 */
export function accessUsageLines(readings: readonly AccessUsageReading[]): string[] {
  return readings.map((r) => {
    const windows = r.windows.map((w) => `${w.weekly ? 'weekly' : 'short'} window ${BAND_TEXT[w.band]}${w.resetAtMs === null ? '' : ` (resets ${minuteIso(w.resetAtMs)})`}`);
    return `${r.harness} ${r.authMode}: ${r.allowed === false ? 'usage not allowed; ' : ''}${windows.join('; ')} (read ${minuteIso(r.readAtMs)})`;
  });
}
