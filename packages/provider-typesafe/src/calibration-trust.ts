/**
 * Trusted calibration keys (RTE-04): role `calibration` in the shipped
 * `assets/trust/release-keys.json`. That file ships empty, so no release applies until the
 * repository owner adds a reviewed key.
 *
 * A test-only override lets the sandboxed acceptance suite trust a key it generated, so the
 * product's `route` op can be driven end to end with a synthetic signed release. It follows the
 * test-override rule (v1.2-DOMAINS): honoured only in a marked test sandbox, refused in an
 * installed runtime, nothing spawned, and a diagnostic line while it is set.
 * - the environment has JEVRIS_TEST=1;
 * - the Jevris home carries the test-home marker `<state>/test-home.json` (schemaVersion
 *   `jevris-test-home-1`, a regular file that is not group or world writable), the same marker
 *   D's test worker port requires;
 * - the process does not run from the user's installed runtime copy (`<data>/runtime`);
 * - JEVRIS_TEST_CALIBRATION_KEYS names an absolute path to a release-keys.json-shaped file; only
 *   its `calibration` keys are added, next to the shipped ones.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { bundledCalibrationFile, calibrationKeysFrom } from '@jevris/core';
import { findPackageRoot, jevrisPaths } from '@jevris/platform';

export const TEST_CALIBRATION_KEYS_ENV = 'JEVRIS_TEST_CALIBRATION_KEYS';
/** Test sandbox only: the file a test ships as the package's bundled baseline release. */
export const TEST_BUNDLED_CALIBRATION_ENV = 'JEVRIS_TEST_BUNDLED_CALIBRATION';
const TEST_HOME_MARKER_SCHEMA = 'jevris-test-home-1';
const CAP = 64 * 1024;

type EnvLike = { readonly [key: string]: string | undefined };

export type CalibrationKeysOverride =
  | { readonly active: false }
  | { readonly active: true; readonly ok: true; readonly path: string; readonly diagnostic: string }
  | { readonly active: true; readonly ok: false; readonly reasonCode: string; readonly diagnostic: string };

interface ProcessLike {
  readonly env?: EnvLike;
  readonly platform?: string;
  readonly argv?: readonly string[];
}

function ambientProcess(): ProcessLike {
  return (globalThis as { process?: ProcessLike }).process ?? {};
}

function ambientEnv(): EnvLike {
  return ambientProcess().env ?? {};
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function hasTestHomeMarker(home: string, platform: string): boolean {
  if (!isAbsolute(home)) return false;
  try {
    const file = join(jevrisPaths({ home, platform }).state, 'test-home.json');
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return false;
    if (platform !== 'win32' && (st.mode & 0o022) !== 0) return false;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { readonly schemaVersion?: unknown } | null;
    return raw !== null && typeof raw === 'object' && raw.schemaVersion === TEST_HOME_MARKER_SCHEMA;
  } catch {
    return false;
  }
}

function runsFromInstalledRuntime(env: EnvLike, platform: string, entry: string | undefined): boolean {
  if (typeof entry !== 'string' || entry === '') return false;
  const { JEVRIS_HOME: _ignored, ...userEnv } = env;
  const roots = [jevrisPaths({ platform, env: {} }).data, jevrisPaths({ platform, env: userEnv }).data].map((d) => realOrSelf(join(d, 'runtime')));
  const fold = (p: string): string => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const at = fold(realOrSelf(entry));
  return roots.some((root) => {
    const back = relative(fold(root), at);
    return back !== '' && !back.startsWith('..') && !isAbsolute(back);
  });
}

/** Whether the test calibration-key override applies for this home, with a diagnostic line. */
export function calibrationKeysOverride(home: string, env: EnvLike = ambientEnv(), options: { readonly platform?: string; readonly entry?: string } = {}): CalibrationKeysOverride {
  const named = env[TEST_CALIBRATION_KEYS_ENV];
  if (named === undefined || named === '') return { active: false };
  const platform = options.platform ?? ambientProcess().platform ?? 'linux';
  const refuse = (reasonCode: string): CalibrationKeysOverride => ({
    active: true,
    ok: false,
    reasonCode,
    diagnostic: `test calibration keys refused (${reasonCode}): only the shipped calibration keys are trusted`,
  });
  if (env['JEVRIS_TEST'] !== '1') return refuse('NOT_TEST_MODE');
  if (runsFromInstalledRuntime(env, platform, options.entry ?? ambientProcess().argv?.[1])) return refuse('INSTALLED_RUNTIME');
  if (!hasTestHomeMarker(home, platform)) return refuse('NO_TEST_HOME_MARKER');
  if (!isAbsolute(named)) return refuse('KEYS_NOT_ABSOLUTE');
  return { active: true, ok: true, path: named, diagnostic: `test calibration keys active: releases signed by keys in ${named} are trusted (test sandbox only)` };
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > CAP) return null;
    return new TextDecoder().decode(await readFile(path));
  } catch {
    return null;
  }
}

/** The calibration keys the sidecar trusts for this home. */
export async function trustedCalibrationKeys(home: string, env: EnvLike = ambientEnv()): Promise<ReadonlyMap<string, string>> {
  let root: string | null = null;
  try {
    root = findPackageRoot(import.meta.url);
  } catch {
    root = null;
  }
  const shipped = root === null ? new Map<string, string>() : new Map(calibrationKeysFrom(await readSmall(join(root, 'assets', 'trust', 'release-keys.json'))));
  const override = calibrationKeysOverride(home, env);
  if (!override.active || !override.ok) return shipped;
  for (const [keyId, pem] of calibrationKeysFrom(await readSmall(override.path))) if (!shipped.has(keyId)) shipped.set(keyId, pem);
  return shipped;
}

/**
 * The package's signed baseline release (C16 day 1): `assets/calibration/calibration-release.json`
 * in the installed package, read when the config folder has no release. The loader checks it like
 * any other release (validate, the shipped calibration keys, applies).
 *
 * Tests stay hermetic: with JEVRIS_TEST=1 the package's own file is never read. A test may name a
 * file in JEVRIS_TEST_BUNDLED_CALIBRATION instead, under the same rule as the key override (a
 * marked test home, an absolute path, not the installed runtime copy).
 */
export function bundledCalibrationPath(home: string, env: EnvLike = ambientEnv(), options: { readonly platform?: string; readonly entry?: string } = {}): string | null {
  if (env['JEVRIS_TEST'] === '1') {
    const named = env[TEST_BUNDLED_CALIBRATION_ENV];
    if (named === undefined || named === '' || !isAbsolute(named)) return null;
    const platform = options.platform ?? ambientProcess().platform ?? 'linux';
    if (runsFromInstalledRuntime(env, platform, options.entry ?? ambientProcess().argv?.[1])) return null;
    return hasTestHomeMarker(home, platform) ? named : null;
  }
  try {
    const root = findPackageRoot(import.meta.url);
    return root === null ? null : bundledCalibrationFile(root);
  } catch {
    return null;
  }
}
