/**
 * The calibration loader (RTE-04, §18.3, E24, US34, C16).
 *
 * Three steps, in order, each with a named refusal:
 *   1. validate: bounded bytes, strict JSON with no prototype keys, the CalibrationArtifact
 *      contract (INVALID_ARTIFACT with the first issue);
 *   2. signature: Ed25519 over the canonical record against the trusted calibration keys
 *      (UNKNOWN_KEY, BAD_SIGNATURE, INVALID_KEY, MISSING_SIGNATURE);
 *   3. applies: kill switch, then `calibrationApplies` (DRAFT, NOT_YET_VALID, EXPIRED,
 *      SPEC_MISMATCH, QUESTION_MISMATCH, MODEL_MISMATCH, ENCODER_MISMATCH, SLICE_NOT_PERMITTED,
 *      SLICE_TOO_SMALL).
 * Only an artifact that passes all three is select-eligible; anything else abstains and the
 * router keeps the approved baseline. Trusted keys are role `calibration` in the shipped
 * `assets/trust/release-keys.json`.
 *
 * Two places hold a release, read in this order (C16 day 1):
 *   1. `<config>/calibration-release.json`, an admin's or user's override. When it exists it is
 *      the only one read, and a broken one abstains: it never falls back to the bundled release;
 *   2. the signed baseline release shipped in the package,
 *      `assets/calibration/calibration-release.json` (`BUNDLED_CALIBRATION_PARTS`). Until the
 *      owner signs one it is absent, and the loader abstains as NO_RELEASE.
 * Both go through the same three steps. The decision names the source and the file it read.
 * Identical on every OS: no path or line-ending dependence in the checks.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CalibrationArtifactContract,
  calibrationApplies,
  verifyRecordSignature,
  type CalibrationArtifact,
  type CalibrationContext,
} from '@jevris/contracts';
import { calibrationReleasePath, jevrisPaths } from '@jevris/platform';

/** Upper bound on a calibration release file. */
export const CALIBRATION_FILE_CAP = 256 * 1024;

/** Where the package ships its signed baseline release, relative to the package root. */
export const BUNDLED_CALIBRATION_PARTS: readonly string[] = Object.freeze(['assets', 'calibration', 'calibration-release.json']);

/** The bundled baseline release path for a package root. */
export function bundledCalibrationFile(packageRoot: string): string {
  return join(packageRoot, ...BUNDLED_CALIBRATION_PARTS);
}

/** Which release a decision read: the config-folder override or the package's bundled baseline. */
export type CalibrationSource = 'config' | 'bundled';

/** The explanation when neither place holds a release. */
export const NO_RELEASE_DETAIL = 'no signed baseline release in this package and no calibration release in the config folder';

/** Slices with fewer calibration or holdout samples stay advisory (§18.3). */
export const DEFAULT_MINIMUM_SLICE_SAMPLES = 30;

export type CalibrationStage = 'read' | 'validate' | 'signature' | 'kill-switch' | 'applies';

export type CalibrationDecision =
  | {
      readonly eligible: true;
      readonly artifact: CalibrationArtifact;
      readonly keyId: string;
      /** The success-probability floor the router applies (the released threshold). */
      readonly qualityFloor: number;
      readonly sliceId: string;
      /** Set by `loadCalibration`: where the release came from. */
      readonly source?: CalibrationSource;
      readonly path?: string;
    }
  | { readonly eligible: false; readonly stage: CalibrationStage; readonly reasonCode: string; readonly detail?: string; readonly source?: CalibrationSource; readonly path?: string };

export interface CalibrationCheckOptions {
  readonly trustedKeys: ReadonlyMap<string, string>;
  /** The decision the artifact must match; `minimumSliceSamples` defaults to 30. */
  readonly context: Omit<CalibrationContext, 'minimumSliceSamples'> & { readonly minimumSliceSamples?: number };
  readonly killSwitchStopped?: boolean;
}

function hasPrototypeKeys(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (hasPrototypeKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/** Parses bounded bytes or text into an untrusted value. */
export function parseCalibrationBytes(input: Uint8Array | string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reasonCode: 'TOO_LARGE' | 'NOT_JSON' | 'UNSAFE_KEYS' } {
  const size = typeof input === 'string' ? input.length : input.byteLength;
  if (size > CALIBRATION_FILE_CAP) return { ok: false, reasonCode: 'TOO_LARGE' };
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, reasonCode: 'NOT_JSON' };
  }
  if (hasPrototypeKeys(value)) return { ok: false, reasonCode: 'UNSAFE_KEYS' };
  return { ok: true, value };
}

/** Validate, then check the signature, then check that it applies. */
export function checkCalibration(value: unknown, options: CalibrationCheckOptions): CalibrationDecision {
  const checked = CalibrationArtifactContract.validate(value);
  if (!checked.ok) {
    const first = checked.issues[0];
    return { eligible: false, stage: 'validate', reasonCode: 'INVALID_ARTIFACT', ...(first === undefined ? {} : { detail: `${first.path}:${first.code}` }) };
  }
  const artifact = checked.value;
  const signature = verifyRecordSignature(artifact as unknown as { readonly [key: string]: unknown }, options.trustedKeys);
  if (!signature.ok) return { eligible: false, stage: 'signature', reasonCode: signature.reasonCode };
  if (options.killSwitchStopped === true) return { eligible: false, stage: 'kill-switch', reasonCode: 'KILL_SWITCH' };
  const applies = calibrationApplies(artifact, { ...options.context, minimumSliceSamples: options.context.minimumSliceSamples ?? DEFAULT_MINIMUM_SLICE_SAMPLES });
  if (!applies.ok) return { eligible: false, stage: 'applies', reasonCode: applies.reasonCode };
  return { eligible: true, artifact, keyId: signature.keyId, qualityFloor: artifact.threshold.value, sliceId: options.context.sliceId };
}

/** Trusted calibration keys from a release-keys.json text (role `calibration` only). */
export function calibrationKeysFrom(text: string | null): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  if (text === null) return keys;
  try {
    const parsed = JSON.parse(text) as { readonly keys?: unknown };
    if (!Array.isArray(parsed.keys)) return keys;
    for (const item of parsed.keys) {
      const key = item as { readonly keyId?: unknown; readonly role?: unknown; readonly publicKeyPem?: unknown };
      if (key.role === 'calibration' && typeof key.keyId === 'string' && typeof key.publicKeyPem === 'string') keys.set(key.keyId, key.publicKeyPem);
    }
  } catch {
    return keys;
  }
  return keys;
}

/** The release file for a Jevris home. */
export function calibrationFileFor(home: string): string {
  return calibrationReleasePath(jevrisPaths({ home }));
}

async function readRelease(path: string): Promise<{ readonly bytes: Uint8Array } | { readonly missing: true } | { readonly unreadable: string }> {
  try {
    return { bytes: await readFile(path) };
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { missing: true } : { unreadable: typeof code === 'string' ? code : 'READ_FAILED' };
  }
}

/**
 * Reads and checks the release for a home: the config-folder file when it exists, otherwise the
 * bundled baseline (`bundled`, the package's `assets/calibration/calibration-release.json`; null
 * or absent reads none). Neither present abstains as NO_RELEASE.
 */
export async function loadCalibration(input: CalibrationCheckOptions & { readonly home?: string; readonly path?: string; readonly bundled?: string | null }): Promise<CalibrationDecision> {
  const configPath = input.path ?? (input.home === undefined ? null : calibrationFileFor(input.home));
  const places: { readonly source: CalibrationSource; readonly path: string }[] = [];
  if (configPath !== null) places.push({ source: 'config', path: configPath });
  if (typeof input.bundled === 'string' && input.bundled !== '') places.push({ source: 'bundled', path: input.bundled });
  for (const place of places) {
    const read = await readRelease(place.path);
    if ('missing' in read) continue;
    const named = { source: place.source, path: place.path };
    if ('unreadable' in read) return { eligible: false, stage: 'read', reasonCode: 'UNREADABLE', detail: read.unreadable, ...named };
    const parsed = parseCalibrationBytes(read.bytes);
    if (!parsed.ok) return { eligible: false, stage: 'validate', reasonCode: parsed.reasonCode, ...named };
    return { ...checkCalibration(parsed.value, input), ...named };
  }
  return { eligible: false, stage: 'read', reasonCode: 'NO_RELEASE', detail: NO_RELEASE_DETAIL };
}
