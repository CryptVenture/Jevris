import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/route-gate.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('the legacy loader never selects, and the test-only selector and model deny list are gone (source)', () => {
  const src = readFileSync(new URL('../src/route-gate.ts', import.meta.url), 'utf8');
  assert.equal(src.includes('fixtures/gates'), false);
  assert.equal(src.includes('writeFile'), false);
  assert.equal(src.includes('mkdir'), false);
  assert.equal(src.includes('function loadReleasedCalibration'), true);
  assert.equal(src.includes('selectManagedWorker'), false);
  assert.equal(src.includes('forbiddenWorker'), false);
  const router = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8');
  assert.equal(router.includes('forbiddenWorker'), false);
});

test('the calibration loader validates, then checks the signature, then applies (source)', () => {
  const src = readFileSync(new URL('../src/calibration-loader.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function checkCalibration'));
  const validate = body.indexOf('CalibrationArtifactContract.validate');
  const signature = body.indexOf('verifyRecordSignature');
  const applies = body.indexOf('calibrationApplies(');
  assert.equal(validate >= 0 && signature > validate && applies > signature, true);
});

test('the bundled tariff has no unsourced row (source)', () => {
  const tariffText = readFileSync(new URL('../../contracts/src/tariff-snapshot.ts', import.meta.url), 'utf8');
  assert.equal(tariffText.includes('Opus 5.5'), false);
  const registry = readFileSync(new URL('../src/model-registry.ts', import.meta.url), 'utf8');
  assert.equal(/claude\('claude-opus-5-5'/.test(registry), false);
});

test('dated tariff keeps unevaluated and disallowed candidates out of scoring (source)', () => {
  const tariffText = readFileSync(new URL('../../contracts/src/tariff-snapshot.ts', import.meta.url), 'utf8');
  assert.equal(tariffText.includes('tokensPerSecond'), false);
  assert.equal(tariffText.includes('requestsPerMinute'), false);
  assert.equal(tariffText.includes('accountQuota: null'), true);
});
