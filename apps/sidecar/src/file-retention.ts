import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '@jevris/orchestrator';
import { CALIBRATION_CASES_RETENTION, DAY_MS, LIVE_EVIDENCE_RETENTION, ORCHESTRATION_RETENTION, type RetentionPolicy } from '@jevris/store';

/**
 * Retention for the Jevris data that lives in files beside the store (DATA-11): the
 * orchestration ledger's history and worker runs, and the live certification evidence. The
 * classes are B's (packages/store retention.ts); D owns the ledger and F the evidence format.
 * Route learning (`<data>/route-learning/`, the machine-wide prior included) is its own class
 * and is never touched here, except C's local calibration cases (`calibration-cases/*.json`),
 * which follow the decision window of the store rows they are built from.
 */

export interface FileSweepResult {
  readonly orchestration: { readonly [collection: string]: number };
  readonly liveEvidence: number;
  /** Calibration-case files removed (CALIBRATION_CASES_RETENTION). */
  readonly calibrationCases: number;
}

export interface FileSweepPorts {
  /** F's pruneLiveEvidence (default: `@jevris/cli/live-evidence`). */
  readonly pruneLiveEvidence?: (home: string, input: { readonly olderThanMs: number; readonly dryRun?: boolean }) => Promise<{ readonly removed: number }>;
}

function isDir(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
}

/** The ledger roots: `<data>/orchestration/host` and each `<data>/orchestration/<ws>/state`. */
export function orchestrationLedgerRoots(dataDir: string): readonly string[] {
  const base = join(dataDir, ORCHESTRATION_RETENTION.directory);
  if (!isDir(base)) return [];
  const roots: string[] = [];
  let names: readonly string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  for (const name of [...names].sort()) {
    const root = name === 'host' ? join(base, name) : join(base, name, 'state');
    if (isDir(root)) roots.push(root);
  }
  return roots;
}

function recordFile(root: string, collection: string, id: string): string {
  return join(root, collection, `${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 40)}.json`);
}

function readRecord(path: string): { readonly id: string; readonly v: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const id = Reflect.get(parsed, 'id');
    return typeof id === 'string' ? { id, v: Reflect.get(parsed, 'v') } : undefined;
  } catch {
    return undefined;
  }
}

function mtimeOf(path: string): number | undefined {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st !== undefined && st.isFile() ? st.mtimeMs : undefined;
}

/** A worker run past the window whose owned effect is not held for reconciliation. */
function expiredRun(value: unknown, cutoffMs: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  const ended = Reflect.get(value, 'endedAtMs');
  return typeof ended === 'number' && ended < cutoffMs && Reflect.get(value, 'effectState') !== 'held';
}

function expired(root: string, collection: string, id: string, value: unknown, cutoffMs: number): boolean {
  if (collection === ORCHESTRATION_RETENTION.workerRunsCollection) return expiredRun(value, cutoffMs);
  const mtime = mtimeOf(recordFile(root, collection, id));
  return mtime !== undefined && mtime < cutoffMs;
}

/** Candidate ids per collection in one ledger root, read without the lock. */
function candidates(root: string, cutoffMs: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const collection of [...ORCHESTRATION_RETENTION.historyCollections, ORCHESTRATION_RETENTION.workerRunsCollection]) {
    const dir = join(root, collection);
    if (!isDir(dir)) continue;
    let names: readonly string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = readRecord(join(dir, name));
      if (record === undefined || !expired(root, collection, record.id, record.v, cutoffMs)) continue;
      const list = out.get(collection) ?? [];
      list.push(record.id);
      out.set(collection, list);
    }
  }
  return out;
}

/**
 * Sweeps the orchestration ledger's history collections and worker runs older than the redacted
 * window. Each ledger root is changed in one transaction under D's lock, and every candidate is
 * checked again inside it, so a record rewritten meanwhile is kept.
 */
export async function sweepOrchestrationLedgers(dataDir: string, cutoffMs: number, dryRun: boolean): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const root of orchestrationLedgerRoots(dataDir)) {
    const found = candidates(root, cutoffMs);
    if (found.size === 0) continue;
    if (dryRun) {
      for (const [collection, ids] of found) removed[collection] = (removed[collection] ?? 0) + ids.length;
      continue;
    }
    const ledger = openLedger(root);
    await ledger.transact((tx) => {
      for (const [collection, ids] of found) {
        for (const id of ids) {
          const value = tx.get<unknown>(collection, id);
          if (value === undefined || !expired(root, collection, id, value, cutoffMs)) continue;
          tx.delete(collection, id);
          removed[collection] = (removed[collection] ?? 0) + 1;
        }
      }
    });
  }
  return removed;
}

/**
 * C's calibration-case files whose last export is older than the cutoff. Only regular `*.json`
 * files directly in the folder are candidates; a symlink or a folder is left alone. A file
 * re-exported between the listing and the removal is kept (its time is checked again).
 */
export function sweepCalibrationCases(dataDir: string, cutoffMs: number, dryRun: boolean): number {
  const dir = join(dataDir, CALIBRATION_CASES_RETENTION.directory);
  if (!isDir(dir)) return 0;
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of [...names].sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const mtime = mtimeOf(path);
    if (mtime === undefined || mtime >= cutoffMs) continue;
    if (dryRun) {
      removed += 1;
      continue;
    }
    const again = mtimeOf(path);
    if (again === undefined || again >= cutoffMs) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      // Gone already or not removable: the next sweep tries again.
    }
  }
  return removed;
}

async function defaultPrune(home: string, input: { readonly olderThanMs: number; readonly dryRun?: boolean }): Promise<{ readonly removed: number }> {
  const module = await import('@jevris/cli/live-evidence');
  return module.pruneLiveEvidence(home, input);
}

/** Applies the file retention classes now; `dryRun` counts and changes nothing. */
export async function sweepFileRetention(input: {
  readonly home: string;
  readonly dataDir: string;
  readonly policy: RetentionPolicy;
  readonly nowMs: number;
  readonly dryRun?: boolean;
  readonly ports?: FileSweepPorts;
}): Promise<FileSweepResult> {
  const dryRun = input.dryRun === true;
  // Every class here follows the redacted window (LIVE_EVIDENCE_RETENTION.window, ORCHESTRATION_RETENTION.window,
  // CALIBRATION_CASES_RETENTION.window).
  const cutoffMs = input.nowMs - input.policy.decisionRetentionDays * DAY_MS;
  let orchestration: Record<string, number> = {};
  try {
    orchestration = await sweepOrchestrationLedgers(input.dataDir, cutoffMs, dryRun);
  } catch {
    orchestration = {};
  }
  let liveEvidence = 0;
  if (isDir(join(input.dataDir, LIVE_EVIDENCE_RETENTION.directory))) {
    try {
      liveEvidence = (await (input.ports?.pruneLiveEvidence ?? defaultPrune)(input.home, { olderThanMs: cutoffMs, dryRun })).removed;
    } catch {
      liveEvidence = 0;
    }
  }
  let calibrationCases = 0;
  try {
    calibrationCases = sweepCalibrationCases(input.dataDir, cutoffMs, dryRun);
  } catch {
    calibrationCases = 0;
  }
  return { orchestration, liveEvidence, calibrationCases };
}
