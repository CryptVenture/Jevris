/**
 * Acceptance fixture: a sandbox whose sidecar evaluates real route decisions. The evidence the
 * router needs is external (EVL-12, EVL-13, RLS-11), so it is synthetic here and trusted the way
 * the product allows only in a test home:
 * - a released calibration with per-model qualities for the slice, signed by a key made here
 *   (C's calibrationSigner), in the home's calibration file;
 * - that key named by JEVRIS_TEST_CALIBRATION_KEYS, which counts only with JEVRIS_TEST=1 and the
 *   test-home marker (<state>/test-home.json, mode 0600);
 * - a model registry whose entries carry an account eligibility check, without which no model is
 *   eligible.
 * Call it before the sidecar starts: the sidecar reads its environment once.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from './lib.mjs';
import { SLICE, calibrationSigner, registry } from './router-fixture.mjs';

/** Holdout qualities where Sonnet 5 meets the floor on the slice and costs less than Opus 5. */
export const QUALITIES = [
  { modelId: 'claude-opus-5', sliceId: SLICE, lower: 0.9, point: 0.94, upper: 0.97, sampleSize: 60 },
  { modelId: 'claude-sonnet-5', sliceId: SLICE, lower: 0.86, point: 0.9, upper: 0.94, sampleSize: 60 },
];

export { SLICE };

export async function calibratedRoute(box, { qualities = QUALITIES } = {}) {
  const core = await load('core');
  const { jevrisPaths } = await load('platform');
  const { TEST_CALIBRATION_KEYS_ENV } = await load('provider-typesafe');
  const paths = jevrisPaths({ home: box.home });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const marker = join(paths.state, 'test-home.json');
  writeFileSync(marker, `${JSON.stringify({ schemaVersion: 'jevris-test-home-1' })}\n`, { mode: 0o600 });
  chmodSync(marker, 0o600);
  const signer = await calibrationSigner();
  const keys = join(box.dir, 'calibration-keys.json');
  writeFileSync(keys, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: signer.keyId, role: 'calibration', publicKeyPem: signer.publicKeyPem }] }));
  box.env.JEVRIS_TEST = '1';
  box.env[TEST_CALIBRATION_KEYS_ENV] = keys;
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(join(paths.config, 'model-registry.json'), JSON.stringify(await registry()));
  const release = signer.release({ modelQualities: qualities });
  const file = core.calibrationFileFor(box.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(release));
  return release;
}
