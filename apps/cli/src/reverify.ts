/**
 * Automatic re-verification (owner direction 2026-09-26): the owner does not re-certify every
 * harness release by hand. Each record covers a version range (harness.json `compatibility`).
 *
 * - An installed version outside every record's range is re-checked in the background, and so
 *   is a feature a malformed live event demoted (live-evidence.ts), and a record that predates a
 *   feature this Jevris certifies (worker.route, models.list), so an upgrade never needs a certify
 *   by hand.
 * - The check is `jevris certify` itself: a throwaway profile and no model call.
 * - It runs at most once per version, or per demotion. An exclusive marker file decides this,
 *   so doctor, sidecar start and SessionStart can all ask at once.
 * - It never runs in a test run without JEVRIS_LIVE_HARNESS=1, nor under a HOME (or Jevris
 *   home) that is not the account's, where a harness could reach for a keychain that is not
 *   there.
 * - A pass writes a record covering the new version. A fail writes one that lists the failing
 *   features as unsupported, so only those are demoted. Doctor names them either way.
 * - Until the check passes, observation and advice go on; only actuation of the uncovered
 *   features waits.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { CERTIFICATION_FEATURES, coveringCertification, loadCertifications, type CertificationFeature, type CertificationLoad } from './certification-store.js';
import { LAUNCHER, type GlobalHarness } from './global-harness.js';
import { foreignHomeRefusal, liveHarnessAllowed, spawnDetachedNode } from './live-harness.js';
import type { Demotion } from './live-evidence.js';

type Env = { readonly [key: string]: string | undefined };

export const REVERIFY_DIR = 'reverify';
/** A check still marked running after this long died without writing its result. */
export const REVERIFY_STALE_MS = 30 * 60 * 1000;

export type ReverifyReason = 'out-of-range' | 'demoted' | 'new-feature';

/**
 * Features added after the first records: a covering record without them is re-checked once.
 * models.list (owner decision DOMAINS d7856f5) runs the harness's own model listing in the
 * throwaway profile, with no model call; a listing with side effects fails and stays off, and the
 * rest of the record is unaffected.
 */
export const NEWER_FEATURES: readonly CertificationFeature[] = ['worker.route', 'models.list'];

/**
 * The newer features a record for this harness should carry. Every harness has a listing now,
 * Claude Code's included (G13), so every record is re-checked for both.
 */
export function newerFeaturesFor(_harness: GlobalHarness): readonly CertificationFeature[] {
  return NEWER_FEATURES;
}

export interface ReverifyJob {
  readonly harness: GlobalHarness;
  readonly version: string;
  readonly reason: ReverifyReason;
  /** The marker file the check writes its result into. */
  readonly marker: string;
  readonly home: string;
  readonly root: string;
}

export interface ReverifyState {
  readonly harness: GlobalHarness;
  readonly version: string;
  readonly reason: ReverifyReason;
  /** started: this call started it; running: an earlier call did; refused: not allowed here. */
  readonly state: 'started' | 'running' | 'passed' | 'failed' | 'refused';
  readonly detail: string;
  readonly failed: readonly { readonly featureId: string; readonly reasonCode: string }[];
}

export interface ReverifyOptions {
  readonly home: string;
  readonly root: string;
  readonly installed: readonly GlobalHarness[];
  readonly versions: Partial<Record<GlobalHarness, string>>;
  readonly platform?: string;
  readonly nowMs?: number;
  readonly env?: Env;
  readonly load?: CertificationLoad;
  /** Starts the check in the background; default a detached `jevris certify --reverify`. */
  readonly start?: (job: ReverifyJob) => boolean | Promise<boolean>;
  /** Why a harness may not be started here, or null (default: test run, foreign HOME). */
  readonly guard?: (env: Env, home: string) => string | null;
}

interface Marker {
  readonly status: 'running' | 'passed' | 'failed';
  readonly reason: ReverifyReason;
  readonly version: string;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number;
  readonly failed?: readonly { readonly featureId: string; readonly reasonCode: string }[];
}

export function reverifyDir(home: string): string {
  return join(jevrisPaths({ home }).data, REVERIFY_DIR);
}

const MARKER_NAME = /^(claude|kilocode|codex|opencode|antigravity)-(darwin|linux|win32)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?)(?:-d(\d{1,16})|(-f))?\.json$/;

function markerName(harness: GlobalHarness, os: string, version: string, demotedAtMs: number | null, newFeature = false): string {
  return `${harness}-${os}-${version}${demotedAtMs === null ? (newFeature ? '-f' : '') : `-d${demotedAtMs}`}.json`;
}

/** True when `path` is a marker file directly inside this home's reverify folder. */
export function isReverifyMarker(home: string, path: string): boolean {
  const full = resolve(path);
  return dirname(full) === resolve(reverifyDir(home)) && MARKER_NAME.test(basename(full));
}

async function readMarker(path: string): Promise<Marker | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Marker;
    return parsed !== null && typeof parsed === 'object' && typeof parsed.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Written by `jevris certify --reverify <marker>` when the check ends. */
export async function finishReverify(home: string, marker: string, ok: boolean, failed: readonly { readonly featureId: string; readonly reasonCode: string }[]): Promise<boolean> {
  if (!isReverifyMarker(home, marker)) return false;
  const before = await readMarker(marker);
  const match = MARKER_NAME.exec(basename(marker));
  const body: Marker = {
    status: ok ? 'passed' : 'failed',
    reason: before?.reason ?? (match?.[4] !== undefined ? 'demoted' : match?.[5] !== undefined ? 'new-feature' : 'out-of-range'),
    version: before?.version ?? match?.[3] ?? '',
    startedAtMs: before?.startedAtMs ?? Date.now(),
    finishedAtMs: Date.now(),
    failed: [...failed],
  };
  await writeFile(marker, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  return true;
}

function defaultGuard(env: Env, home: string): string | null {
  if (!liveHarnessAllowed(env)) return 'not re-checked: test run';
  const foreign = foreignHomeRefusal(env, home);
  return foreign === null ? null : foreign.replace('not probed', 'not re-checked');
}

/** Default start: a detached `jevris certify --harness <h> --home <home> --reverify <marker>`. */
function spawnCertify(job: ReverifyJob): boolean {
  return spawnDetachedNode([join(job.root, 'bin', 'jevris.mjs'), 'certify', '--harness', LAUNCHER[job.harness], '--home', job.home, '--reverify', job.marker, '--json']);
}

/** The latest live demotion applied to one of this harness's records (loadCertifications). */
function latestDemotion(load: CertificationLoad, harness: GlobalHarness): Demotion | null {
  const applied = load.records.filter((item) => item.record.harness === harness).flatMap((item) => item.demoted ?? []);
  return applied.length === 0 ? null : applied.reduce((a, b) => (b.atMs > a.atMs ? b : a));
}

/**
 * For each installed harness with a known version: nothing when a record covers it; otherwise,
 * when an earlier record exists (the version moved out of its range) or a live event demoted a
 * feature, the background check, started at most once. Never throws.
 */
export async function maybeReverify(options: ReverifyOptions): Promise<ReverifyState[]> {
  const platform = options.platform ?? process.platform;
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const load = options.load ?? (await loadCertifications(options.home, { root: options.root }));
  const out: ReverifyState[] = [];
  for (const harness of options.installed) {
    const version = options.versions[harness];
    if (version === undefined) continue;
    const own = load.records.filter((item) => item.record.harness === harness);
    if (own.length === 0) continue; // never certified here: the owner runs jevris certify
    const covering = CERTIFICATION_FEATURES.map((featureId: CertificationFeature) => coveringCertification(load, { harness, harnessVersion: version, operatingSystem: platform, nowMs, featureId }).covered).find((item) => item !== null) ?? null;
    const covered = covering !== null;
    const demotion = covered ? latestDemotion(load, harness) : null;
    // A covering record written before a feature existed: re-checked once, so the upgrade certifies it.
    const lacking = covering !== null && demotion === null && newerFeaturesFor(harness).some((featureId) => !covering.record.features.some((item) => item.featureId === featureId));
    if (covered && demotion === null && !lacking) continue;
    const reason: ReverifyReason = !covered ? 'out-of-range' : demotion !== null ? 'demoted' : 'new-feature';
    const dir = reverifyDir(options.home);
    const marker = join(dir, markerName(harness, platform, version, demotion === null ? null : demotion.atMs, reason === 'new-feature'));
    const existing = await readMarker(marker);
    if (existing !== null) {
      const stale = existing.status === 'running' && nowMs - existing.startedAtMs > REVERIFY_STALE_MS;
      out.push({
        harness,
        version,
        reason,
        state: stale ? 'failed' : existing.status,
        detail: stale ? 'the background re-check did not finish' : existing.status === 'running' ? 'the background re-check is running' : `the background re-check ${existing.status}`,
        failed: stale ? [] : (existing.failed ?? []),
      });
      continue;
    }
    const refusal = (options.guard ?? defaultGuard)(env, options.home);
    if (refusal !== null) {
      out.push({ harness, version, reason, state: 'refused', detail: refusal, failed: [] });
      continue;
    }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const body: Marker = { status: 'running', reason, version, startedAtMs: nowMs };
      // Exclusive create: of several callers at once, exactly one starts the check.
      await writeFile(marker, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      out.push({ harness, version, reason, state: 'running', detail: 'the background re-check is running', failed: [] });
      continue;
    }
    const started = await (options.start ?? spawnCertify)({ harness, version, reason, marker, home: options.home, root: options.root });
    out.push({ harness, version, reason, state: started ? 'started' : 'failed', detail: started ? 'the background re-check started' : 'the background re-check could not start', failed: [] });
  }
  return out;
}
