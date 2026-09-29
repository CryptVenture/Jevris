/**
 * Doctor's access-limit lines (access limits design 6.3 and 11; coordinator's gap 5 from D's
 * trace): the machine's pauses in force, each with its class, scope, when it lifts or how it
 * clears, and whether it is weekly, in the words of `jevris route limits` (core's
 * accessLimitLines). Fixed text only: no fingerprint, no remote text.
 *
 * - The record is read with core's readAccessLimits, read-only, as `jevris route limits` and
 *   status read it (B: one path; the record is written atomically under its own lock). Doctor never
 *   writes or prunes it, and needs no sidecar.
 * - Severity (doctor-severity.ts): nothing in force is ok; a timed pause lifts by itself (info);
 *   an untimed one or an unreadable record needs the person (action). Never broken.
 */
import { accessLimitLines, accessLimitsSetAside, accessUsageLines, readAccessLimits, readAccessUsageReadings, type AccessLimitEntry, type AccessLimitsUnreadable, type AccessUsageReading } from '@jevris/core';

/** The lines for a record already read (tests pass one in). */
const CLEAR_ALL = 'jevris route limits clear --all, at an interactive terminal';

/** Why the record could not be read (B's MEDIUM 41, C2's core): fixed text per kind. */
function unreadableLine(kind: AccessLimitsUnreadable | null | undefined): string {
  if (kind === 'newer') return `accessLimits: the record was written by a newer Jevris (ACCESS_LIMITS_UNREADABLE); it is left untouched, it pauses nothing here, and nothing new is recorded until Jevris is upgraded or ${CLEAR_ALL}, rewrites it empty`;
  if (kind === 'transient') return 'accessLimits: the record could not be read this time (ACCESS_LIMITS_UNREADABLE); nothing was changed, and it pauses nothing until it reads again';
  return `accessLimits: the record could not be read (ACCESS_LIMITS_UNREADABLE), so it pauses nothing; the next pause recorded sets it aside, or ${CLEAR_ALL}, rewrites it empty`;
}

/** Damaged records set aside (B's MEDIUM 41): pauses recorded before one may be missing. */
function setAsideLine(setAside: { readonly count: number; readonly latestMs: number | null }): string[] {
  if (setAside.count <= 0) return [];
  const latest = setAside.latestMs === null ? '' : ` (latest ${new Date(setAside.latestMs).toISOString().slice(0, 16)}Z)`;
  const what = setAside.count === 1 ? 'a damaged access-limit record was' : `${String(setAside.count)} damaged access-limit records were`;
  return [`accessLimits set aside: ${what} set aside${latest}; pauses recorded before it may be missing; ${CLEAR_ALL}, or jevris route learning reset --machine removes them`];
}

export function accessLimitsDoctorLinesFrom(
  record: { readonly entries: readonly AccessLimitEntry[]; readonly readable: boolean; readonly unreadable?: AccessLimitsUnreadable | null; readonly full: boolean },
  nowMs: number,
  setAside: { readonly count: number; readonly latestMs: number | null } = { count: 0, latestMs: null },
): string[] {
  if (!record.readable) return [unreadableLine(record.unreadable), ...setAsideLine(setAside)];
  const lines = accessLimitLines(record.entries, nowMs);
  // An untimed pause (credit, account) never lifts by itself (core's untimedClearText): say how many.
  const untimed = record.entries.filter((e) => e.untilMs === null).length;
  const count = `${String(lines.length)} in force${untimed === 0 ? '' : `, ${String(untimed)} untimed`}`;
  const out = [lines.length === 0 ? 'accessLimits: none in force' : `accessLimits: ${count} (jevris route limits lists them; clear one there at an interactive terminal)`];
  for (const line of lines) out.push(`accessLimit ${line}`);
  if (record.full) out.push('accessLimits full: the record is full (ACCESS_LIMITS_FULL); a new pause replaces the oldest expired or timed one, and is not recorded while every one is untimed');
  out.push(...setAsideLine(setAside));
  return out;
}

/** Reads the machine record and gives doctor's lines; a read that throws reads as unreadable. */
export async function accessLimitsDoctorLines(home: string, nowMs: number): Promise<string[]> {
  let record: Awaited<ReturnType<typeof readAccessLimits>>;
  try {
    record = await readAccessLimits(home);
  } catch {
    record = { entries: [], readable: false, unreadable: 'transient', full: false };
  }
  let setAside: { readonly count: number; readonly latestMs: number | null };
  try {
    setAside = await accessLimitsSetAside(home);
  } catch {
    setAside = { count: 0, latestMs: null };
  }
  return accessLimitsDoctorLinesFrom(record, nowMs, setAside);
}

/**
 * OP-6: the last Codex usage reading per sign-in, read-only from core's kept readings (none older
 * than 7 days), one `accessUsage <harness> <sign-in>: …` line each in core's words; nothing when
 * there is none. A used-up window or usage not allowed is action; otherwise info.
 */
export function accessUsageDoctorLinesFrom(read: { readonly readings: readonly AccessUsageReading[]; readonly readable: boolean }): string[] {
  const out = accessUsageLines(read.readings).map((line) => `accessUsage ${line}`);
  if (!read.readable) out.push('accessUsage: the readings file could not be read (ACCESS_USAGE_UNREADABLE), so it pauses and lifts nothing');
  return out;
}

/** Reads the kept usage readings and gives doctor's lines; a read that throws reads as unreadable. */
export async function accessUsageDoctorLines(home: string, nowMs: number): Promise<string[]> {
  let read: Awaited<ReturnType<typeof readAccessUsageReadings>>;
  try {
    read = await readAccessUsageReadings(home, nowMs);
  } catch {
    read = { readings: [], readable: false };
  }
  return accessUsageDoctorLinesFrom(read);
}
