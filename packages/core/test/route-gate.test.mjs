import test from 'node:test';
import assert from 'node:assert/strict';
import { jevrisPaths } from '../../platform/dist/index.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';


const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';
const SECTION_8 = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const DISPLAY_NAMES = ['Fable 5.1', 'Opus 5', 'Sonnet 5', 'Haiku 4.5'];

function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gateHashes() {
  const root = repoRoot();
  const names = ['api', 'harness', 'security', 'quality', 'economics', 'operations', 'portability'];
  const hashes = { release: hashFile(join(root, 'fixtures/gates/release.txt')) };
  for (const name of names) hashes[name] = hashFile(join(root, 'fixtures/gates', `${name}.json`));
  return hashes;
}

function assertNoGrant(result) {
  assert.equal(result.routeClaimed, false);
  assert.equal(result.pinHeld, true);
  assert.equal(result.published, false);
  assert.equal(result.mainSessionSwitched, false);
  assert.equal(result.fileWritten, false);
  assert.equal(result.toolPermission, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);
  assert.equal(JSON.stringify(result).includes('\u001b'), false);
}

test('production loader abstains and does not create a release', async () => {
  const { loadReleasedCalibration } = await import('../dist/index.js');
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-'));
  const before = gateHashes();
  try {
    writeFileSync(join(home, 'workspace-release.json'), JSON.stringify({ published: true, verdict: 'passed', threshold: 1, source: SOURCE_CANARY }));
    mkdirSync(join(home, 'fixtures', 'gates'), { recursive: true });
    writeFileSync(join(home, 'fixtures', 'gates', 'quality.json'), JSON.stringify({ verdict: 'passed', source: SOURCE_CANARY }));
    writeFileSync(
      join(home, 'draft.json'),
      JSON.stringify({ kind: 'calibration-proposal', published: false, loaded: false, source: SOURCE_CANARY }),
    );
    const missing = await loadReleasedCalibration(home, 'slice-evaluated');
    assert.equal(missing.outcome, 'abstain');
    assert.equal(missing.sliceId, 'slice-evaluated');
    assert.equal(missing.requestedModel, 'jev-1.13.0');
    assert.equal(missing.observedModel, 'unknown');
    assert.equal(missing.threshold, null);
    assertNoGrant(missing);
    assert.equal(existsSync(join(configDir(home), 'calibration-release.json')), false);
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(
      join(configDir(home), 'calibration-release.json'),
      JSON.stringify({ published: true, verdict: 'passed', threshold: 9, extra: true, source: SOURCE_CANARY }),
    );
    const refused = await loadReleasedCalibration(home);
    assert.equal(refused.outcome, 'abstain');
    assert.equal(refused.sliceId, 'unknown-slice');
    assert.equal(refused.threshold, null);
    assert.equal(refused.published, false);
    assertNoGrant(refused);
    const unsafe = await loadReleasedCalibration(home, `slice ${SOURCE_CANARY}`);
    assert.equal(unsafe.sliceId, 'unknown-slice');
    assert.equal(JSON.stringify(unsafe).includes(SOURCE_CANARY), false);
    assert.deepEqual(gateHashes(), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loader does not read a gate, a draft writer, or a workspace path as a release', async () => {
  const { loadReleasedCalibration } = await import('../dist/index.js');
  const root = repoRoot();
  const loaded = await loadReleasedCalibration(join(root, 'fixtures', 'gates'), 'slice-evaluated');
  assert.equal(loaded.outcome, 'abstain');
  assert.equal(loaded.published, false);
  assert.equal(loaded.threshold, null);
});

test('the dated tariff has no unsourced row and keeps aliases out of automation', async () => {
  const contracts = await import('@jevris/contracts');
  assert.equal(contracts.TARIFF_FETCHED_ON, '2026-09-24');
  assert.equal(contracts.accountQuota, null);
  const rows = contracts.tariffRows;
  const jev = rows.find((row) => row.modelId === 'jev-1.13.0');
  assert.equal(jev.inputMicroUsdPerMillion, 42000);
  assert.equal(jev.outputMicroUsdPerMillion, 0);
  assert.equal(jev.eligibleForPrice, true);
  assert.equal(jev.eligibleForAutomation, false);
  for (const alias of ['jev-latest', 'jev-preview']) {
    const row = rows.find((item) => item.modelId === alias);
    assert.equal(row.eligibleForAutomation, false);
    assert.equal(row.eligibleForPrice, false);
  }
  const fable = rows.find((row) => row.displayName === 'Fable 5.1');
  const haiku = rows.find((row) => row.displayName === 'Haiku 4.5');
  assert.equal(fable.apiId, null);
  assert.equal(haiku.apiId, null);
  assert.equal(fable.cacheReadMicroUsdPerMillion, 250000);
  assert.equal(haiku.cacheReadMicroUsdPerMillion, 100000);
  assert.notEqual(
    fable.cacheReadMicroUsdPerMillion / fable.inputMicroUsdPerMillion,
    haiku.cacheReadMicroUsdPerMillion / haiku.inputMicroUsdPerMillion,
  );
  for (const name of DISPLAY_NAMES) {
    const row = rows.find((item) => item.displayName === name);
    assert.equal(row.apiId, null);
    assert.equal(row.eligibleForAutomation, false);
    assert.equal(Number.isSafeInteger(row.inputMicroUsdPerMillion), true);
  }
  for (const id of SECTION_8) {
    assert.equal(rows.some((row) => row.apiId === id || row.modelId === id), false);
  }
  assert.equal(rows.some((row) => row.displayName === 'Opus 5.5'), false, 'the unsourced row is removed (RTE-01)');
});

function configDir(home) {
  return jevrisPaths({ home }).config;
}
