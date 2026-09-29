/**
 * Evidence from real use (owner direction 2026-09-26). Each hook delivery the harness makes
 * is conforming or malformed for one certified feature at one harness version.
 *
 * - A conforming delivery adds to the count for that feature and version.
 * - A malformed one demotes that feature to observe-only at once, and asks for a background
 *   re-check (reverify.ts).
 * - A record certified after the demotion lifts it.
 *
 * The log is append-only JSON lines, one small write per event, so concurrent hook processes
 * never lose each other's lines. It is owner-only, holds names and counts only (never event
 * content), and is compacted once it passes 1 MiB, keeping every demotion.
 */
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CERTIFICATION_FEATURES, compareSemver, type CertificationFeature, type CertificationRecord } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';

/** The harnesses (as in global-harness.ts; not imported, so the sidecar bundle stays small). */
type GlobalHarness = 'claude' | 'kilocode' | 'codex' | 'opencode' | 'antigravity';
const GLOBAL_HARNESSES: readonly GlobalHarness[] = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'];

export const LIVE_EVIDENCE_DIR = 'live-evidence';
export const LIVE_EVIDENCE_FILE = 'events.jsonl';
export const LIVE_EVIDENCE_CAP = 1_048_576;

export interface LiveEvent {
  readonly harness: GlobalHarness;
  readonly version: string;
  readonly featureId: CertificationFeature;
  readonly conforming: boolean;
  /** Why a malformed event was malformed (a reason code, never event content). */
  readonly reasonCode?: string;
  readonly atMs?: number;
}

export interface Demotion {
  readonly harness: GlobalHarness;
  readonly version: string;
  readonly featureId: CertificationFeature;
  readonly atMs: number;
  readonly reasonCode: string;
}

export interface FeatureEvidence {
  readonly conforming: number;
  readonly malformed: number;
}

export interface LiveEvidence {
  /** harness -> version -> feature -> counts */
  readonly counts: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, FeatureEvidence>>>>>>;
  readonly demotions: readonly Demotion[];
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

function evidenceDir(home: string): string {
  return join(jevrisPaths({ home }).data, LIVE_EVIDENCE_DIR);
}

function valid(event: LiveEvent): boolean {
  return (
    (GLOBAL_HARNESSES as readonly string[]).includes(event.harness) &&
    VERSION.test(event.version) &&
    (CERTIFICATION_FEATURES as readonly string[]).includes(event.featureId) &&
    typeof event.conforming === 'boolean'
  );
}

/** Appends one delivery. Never throws: evidence is a hint, and a failed write loses only it. */
export async function recordLiveEvent(home: string, event: LiveEvent): Promise<boolean> {
  if (!valid(event)) return false;
  const line = {
    h: event.harness,
    v: event.version,
    f: event.featureId,
    ok: event.conforming,
    ...(event.conforming ? {} : { r: event.reasonCode !== undefined && REASON.test(event.reasonCode) ? event.reasonCode : 'MALFORMED_EVENT' }),
    t: event.atMs ?? Date.now(),
  };
  try {
    const dir = evidenceDir(home);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, LIVE_EVIDENCE_FILE);
    await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    const size = (await stat(file)).size;
    if (size > LIVE_EVIDENCE_CAP) await compact(home);
    return true;
  } catch {
    return false;
  }
}

interface Line {
  readonly h: string;
  readonly v: string;
  readonly f: string;
  readonly ok: boolean;
  readonly r?: string;
  readonly t: number;
  /** Compacted counts (only in a compacted file). */
  readonly c?: number;
}

function parse(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length === 0 || raw.length > 512) continue;
    try {
      const line = JSON.parse(raw) as Line;
      if (typeof line.h === 'string' && typeof line.v === 'string' && typeof line.f === 'string' && typeof line.ok === 'boolean' && typeof line.t === 'number') out.push(line);
    } catch {
      // a torn line from a crash: skipped
    }
  }
  return out;
}

function aggregate(lines: readonly Line[]): LiveEvidence {
  const counts: Record<string, Record<string, Record<string, { conforming: number; malformed: number }>>> = {};
  const demotions: Demotion[] = [];
  for (const line of lines) {
    const byVersion = (counts[line.h] ??= {});
    const byFeature = (byVersion[line.v] ??= {});
    const entry = (byFeature[line.f] ??= { conforming: 0, malformed: 0 });
    const n = typeof line.c === 'number' && line.c > 0 ? line.c : 1;
    if (line.ok) entry.conforming += n;
    else {
      entry.malformed += n;
      demotions.push({ harness: line.h as GlobalHarness, version: line.v, featureId: line.f as CertificationFeature, atMs: line.t, reasonCode: line.r ?? 'MALFORMED_EVENT' });
    }
  }
  return { counts, demotions };
}

/** The counts per harness, version and feature, and every demotion. Empty when there is no log. */
export async function readLiveEvidence(home: string): Promise<LiveEvidence> {
  try {
    return aggregate(parse(await readFile(join(evidenceDir(home), LIVE_EVIDENCE_FILE), 'utf8')));
  } catch {
    return { counts: {}, demotions: [] };
  }
}

/** Rewrites the log as one count line per harness, version and feature, keeping each demotion. */
async function compact(home: string): Promise<void> {
  const dir = evidenceDir(home);
  const lock = join(dir, 'compact.lock');
  try {
    await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    return; // another process compacts
  }
  try {
    const file = join(dir, LIVE_EVIDENCE_FILE);
    const evidence = await readLiveEvidence(home);
    const lines: string[] = [];
    const now = Date.now();
    for (const [h, versions] of Object.entries(evidence.counts)) {
      for (const [v, features] of Object.entries(versions)) {
        for (const [f, entry] of Object.entries(features)) {
          if (entry.conforming > 0) lines.push(JSON.stringify({ h, v, f, ok: true, t: now, c: entry.conforming }));
        }
      }
    }
    for (const d of evidence.demotions) lines.push(JSON.stringify({ h: d.harness, v: d.version, f: d.featureId, ok: false, r: d.reasonCode, t: d.atMs }));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Retention (B's LIVE_EVIDENCE_RETENTION): drops conforming lines, single or compacted, older
 * than `olderThanMs`, and keeps every demotion. Under the compaction lock, so it never races a
 * compaction; an append that lands during the rewrite may be lost, as a failed append is (a
 * hint). `dryRun` counts and changes nothing. Never throws.
 */
export async function pruneLiveEvidence(home: string, input: { readonly olderThanMs: number; readonly dryRun?: boolean }): Promise<{ readonly removed: number; readonly kept: number }> {
  const dir = evidenceDir(home);
  const file = join(dir, LIVE_EVIDENCE_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { removed: 0, kept: 0 };
  }
  const expired = (line: Line): boolean => line.ok && line.t < input.olderThanMs;
  const counted = parse(text);
  const removed = counted.filter(expired).length;
  if (input.dryRun === true || removed === 0) return { removed, kept: counted.length - removed };
  const lock = join(dir, 'compact.lock');
  try {
    await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    return { removed: 0, kept: counted.length }; // a compaction runs; the next sweep prunes
  }
  try {
    const lines = parse(await readFile(file, 'utf8'));
    const kept = lines.filter((line) => !expired(line));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, kept.length === 0 ? '' : `${kept.map((line) => JSON.stringify(line)).join('\n')}\n`, { mode: 0o600 });
    await rename(tmp, file);
    return { removed: lines.length - kept.length, kept: kept.length };
  } catch {
    return { removed: 0, kept: counted.length };
  } finally {
    await rm(lock, { force: true });
  }
}

function covers(record: CertificationRecord, version: string): boolean {
  const lower = compareSemver(version, record.harnessVersionRange.minimum);
  const upper = compareSemver(version, record.harnessVersionRange.maximumExclusive);
  return lower !== null && upper !== null && lower >= 0 && upper < 0;
}

/**
 * The demotions that apply to a record: same harness, a version the record covers, and later
 * than the record's certification (a record certified after the demotion lifts it).
 */
export function demotionsFor(record: CertificationRecord, demotions: readonly Demotion[]): Demotion[] {
  const certifiedMs = Date.parse(record.certifiedAt);
  return demotions.filter((item) => item.harness === record.harness && item.atMs > certifiedMs && covers(record, item.version));
}

/** The record with each demoted feature marked unsupported (reason LIVE_EVENT_MALFORMED). */
export function applyDemotions(record: CertificationRecord, demotions: readonly Demotion[]): CertificationRecord {
  const demoted = new Set<string>(demotionsFor(record, demotions).map((item) => item.featureId));
  if (demoted.size === 0) return record;
  return {
    ...record,
    features: record.features.map((item) => (demoted.has(item.featureId) && item.status === 'certified' ? { ...item, status: 'unsupported' as const, reasonCode: 'LIVE_EVENT_MALFORMED' } : item)),
  };
}
