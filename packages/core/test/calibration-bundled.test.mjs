// C16 day 1: the package ships its signed baseline release (assets/calibration/calibration-release.json).
// The config folder's release overrides it; both go through validate, signature and applies; with
// neither the loader abstains. Temp directories only; nothing reads the real config or package file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');

const KEY = generateKeyPairSync('ed25519');
const OTHER = generateKeyPairSync('ed25519');
const pem = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });
const TRUSTED = new Map([['calibration-bundled-test', KEY.publicKey.export({ type: 'spki', format: 'pem' })]]);
const SLICE = 'bounded-edit';
const NOW = Date.parse('2026-10-01T00:00:00Z');

function signed(id, key = KEY, keyId = 'calibration-bundled-test') {
  const c = core.workerCalibrationContext({ sliceId: SLICE, nowMs: NOW });
  return contracts.signRecord({
    id,
    schemaVersion: '1.0',
    releaseState: 'released',
    decisionSpecId: c.decisionSpecId,
    decisionSpecVersion: c.decisionSpecVersion,
    dataset: { id: 'synthetic', version: 'v1', contentHash: `sha256:${'d'.repeat(64)}` },
    questionHash: c.questionHash,
    model: { modelId: c.modelId, revisionHash: c.modelRevisionHash },
    encoderHash: c.encoderHash,
    threshold: { metric: 'noul-probability', value: 0.8, errorBudget: 0.05 },
    permittedSlices: [{ sliceId: SLICE, calibrationSampleSize: 60, holdoutSampleSize: 60 }],
    uncertaintyInterval: { lower: 0.8, upper: 0.9, confidenceLevel: 0.95, method: 'wilson' },
    reviewer: { id: 'reviewer-1', reviewedAt: '2026-09-29T00:00:00Z' },
    issuedAt: '2026-09-30T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    expiryConditions: ['model-revision-changed'],
  }, pem(key), keyId);
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-bundled-cal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const pkg = join(dir, 'package');
  const bundled = core.bundledCalibrationFile(pkg);
  const write = (file, value) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { home, bundled, config: core.calibrationFileFor(home), write };
}

const load = (s) => core.loadCalibration({ home: s.home, bundled: s.bundled, trustedKeys: TRUSTED, context: core.workerCalibrationContext({ sliceId: SLICE, nowMs: NOW }) });

test('C16 day 1: the bundled baseline release applies when the config folder has none', async (t) => {
  const s = setup(t);
  assert.deepEqual(core.BUNDLED_CALIBRATION_PARTS, ['assets', 'calibration', 'calibration-release.json']);
  s.write(s.bundled, signed('cal-bundled'));
  const d = await load(s);
  assert.equal(d.eligible, true, JSON.stringify(d));
  assert.deepEqual([d.artifact.id, d.source, d.path, d.qualityFloor], ['cal-bundled', 'bundled', s.bundled, 0.8]);
});

test('C16 day 1: the config-folder release overrides the bundled one, and a broken override abstains rather than falling back', async (t) => {
  const s = setup(t);
  s.write(s.bundled, signed('cal-bundled'));
  s.write(s.config, signed('cal-config'));
  const d = await load(s);
  assert.deepEqual([d.eligible, d.artifact.id, d.source, d.path], [true, 'cal-config', 'config', s.config]);
  s.write(s.config, 'not json');
  const broken = await load(s);
  assert.deepEqual([broken.eligible, broken.stage, broken.reasonCode, broken.source], [false, 'validate', 'NOT_JSON', 'config']);
  s.write(s.config, signed('cal-config-foreign', OTHER, 'someone-else'));
  const foreign = await load(s);
  assert.deepEqual([foreign.eligible, foreign.stage, foreign.source], [false, 'signature', 'config']);
});

test('C16 day 1: a bundled release signed by a key outside the shipped calibration keys is refused', async (t) => {
  const s = setup(t);
  s.write(s.bundled, signed('cal-bundled-untrusted', OTHER, 'not-shipped'));
  const d = await load(s);
  assert.deepEqual([d.eligible, d.stage, d.reasonCode, d.source], [false, 'signature', 'UNKNOWN_KEY', 'bundled']);
  // A bundled release that fails the applies step abstains the same way a config one does.
  s.write(s.bundled, signed('cal-bundled-trusted'));
  const other = await core.loadCalibration({ home: s.home, bundled: s.bundled, trustedKeys: TRUSTED, context: core.workerCalibrationContext({ sliceId: 'refactor', nowMs: NOW }) });
  assert.deepEqual([other.eligible, other.stage, other.reasonCode, other.source], [false, 'applies', 'SLICE_NOT_PERMITTED', 'bundled']);
});

test('C16 day 1: with no release in the package or the config folder the loader abstains and says so', async (t) => {
  const s = setup(t);
  const d = await load(s);
  assert.deepEqual([d.eligible, d.stage, d.reasonCode], [false, 'read', 'NO_RELEASE']);
  assert.match(d.detail, /no signed baseline release in this package/);
  // Without a bundled path (the old callers) nothing changes.
  const legacy = await core.loadCalibration({ home: s.home, trustedKeys: TRUSTED, context: core.workerCalibrationContext({ sliceId: SLICE, nowMs: NOW }) });
  assert.deepEqual([legacy.eligible, legacy.reasonCode], [false, 'NO_RELEASE']);
});
