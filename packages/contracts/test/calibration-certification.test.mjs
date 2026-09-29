import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import * as F from './fixtures.mjs';

const c = await import('../dist/index.js');

const codes = (result) => (result.ok ? [] : result.issues.map((issue) => issue.code));

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function unsigned(record) {
  const copy = { ...record };
  delete copy.signature;
  return copy;
}

const RECORDS = [
  ['CalibrationArtifact', F.calibrationArtifact],
  ['CertificationRecord', F.certificationRecord],
];

test('CalibrationArtifact and CertificationRecord validate the SSOT fields (CTR-05)', () => {
  assert.equal(c.CalibrationArtifactContract.validate(F.calibrationArtifact()).ok, true);
  assert.equal(c.CertificationRecordContract.validate(F.certificationRecord()).ok, true);
  // §18.3: dataset/version, question/model/encoder hashes, threshold, permitted slices, interval, reviewer, expiry.
  for (const key of ['dataset', 'questionHash', 'model', 'encoderHash', 'threshold', 'permittedSlices', 'uncertaintyInterval', 'reviewer', 'expiresAt', 'expiryConditions', 'signature']) {
    const value = F.calibrationArtifact();
    delete value[key];
    assert.deepEqual(codes(c.CalibrationArtifactContract.validate(value)), ['required'], key);
  }
  // §15.4: actuator, version range, OS, model and tool availability, limitations, fixture hash, feature status.
  for (const key of ['actuatorId', 'harnessVersionRange', 'operatingSystems', 'models', 'tools', 'limitations', 'fixtureSuiteHash', 'features', 'expiresAt', 'signature']) {
    const value = F.certificationRecord();
    delete value[key];
    assert.deepEqual(codes(c.CertificationRecordContract.validate(value)), ['required'], key);
  }
});

test('a missing, null or malformed signature or expiry is rejected (CTR-05)', () => {
  for (const [name, make] of RECORDS) {
    const contract = c.CONTRACTS.get(name);
    for (const signature of [null, {}, { ...F.dummySignature(), algorithm: 'rsa' }, { ...F.dummySignature(), value: 'short' }, { ...F.dummySignature(), keyId: 'a b' }]) {
      assert.equal(contract.validate({ ...make(), signature }).ok, false, `${name} ${JSON.stringify(signature)}`);
    }
    for (const expiresAt of [null, '', 'never', '2026-09-25']) {
      assert.equal(contract.validate({ ...make(), expiresAt }).ok, false, `${name} expiresAt ${expiresAt}`);
    }
  }
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...F.calibrationArtifact(), expiresAt: F.T0 })), ['EXPIRY_NOT_AFTER_ISSUE']);
  assert.deepEqual(codes(c.CertificationRecordContract.validate({ ...F.certificationRecord(), expiresAt: '2026-01-01T00:00:00Z' })), [
    'EXPIRY_NOT_AFTER_ISSUE',
  ]);
});

test('calibration refinements: slices, interval, threshold range and review order', () => {
  const v = () => F.calibrationArtifact();
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), permittedSlices: [] }).ok, false);
  const duplicate = v();
  duplicate.permittedSlices.push({ ...duplicate.permittedSlices[0] });
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate(duplicate)), ['DUPLICATE_SLICE']);
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...v(), uncertaintyInterval: { ...v().uncertaintyInterval, lower: 0.95 } })), [
    'INTERVAL_ORDER',
  ]);
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...v(), threshold: { ...v().threshold, value: 2 } })), ['PROBABILITY_RANGE']);
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), threshold: { metric: 'score', value: 2, errorBudget: 0.1 } }).ok, true);
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...v(), reviewer: { id: 'r', reviewedAt: F.T1 } })), ['REVIEW_AFTER_ISSUE']);
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), releaseState: 'approved' }).ok, false);
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), model: { modelId: 'jev-1.13.0', revisionHash: 'latest' } }).ok, false);
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), uncertaintyInterval: { ...v().uncertaintyInterval, confidenceLevel: 1 } }).ok, false);
});

test('calibration model qualities: only permitted slices, an ordered interval and one entry per model and slice (RTE-03)', () => {
  const v = () => F.calibrationArtifact();
  const slice = v().permittedSlices[0].sliceId;
  const q = (overrides = {}) => ({ modelId: 'claude-sonnet-5', sliceId: slice, lower: 0.86, point: 0.9, upper: 0.94, sampleSize: 60, ...overrides });
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), modelQualities: [q(), q({ modelId: 'claude-opus-5' })] }).ok, true);
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...v(), modelQualities: [q({ sliceId: 'not-permitted' })] })), ['SLICE_NOT_PERMITTED']);
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...v(), modelQualities: [q({ point: 0.99 })] })), ['POINT_OUTSIDE_INTERVAL']);
  assert.deepEqual(codes(c.CalibrationArtifactContract.validate({ ...v(), modelQualities: [q(), q()] })), ['DUPLICATE_MODEL_QUALITY']);
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), modelQualities: [q({ upper: 1.2 })] }).ok, false);
  assert.equal(c.CalibrationArtifactContract.validate({ ...v(), modelQualities: [q({ sampleSize: 0 })] }).ok, false);
});

test('certification refinements: version range, unknown OS, duplicates and unexplained non-certified features', () => {
  const v = () => F.certificationRecord();
  assert.equal(c.CertificationRecordContract.validate({ ...v(), operatingSystems: ['windows'] }).ok, false);
  assert.equal(c.CertificationRecordContract.validate({ ...v(), operatingSystems: [] }).ok, false);
  assert.equal(c.CertificationRecordContract.validate({ ...v(), harness: 'gemini' }).ok, false);
  assert.deepEqual(codes(c.CertificationRecordContract.validate({ ...v(), harnessVersionRange: { minimum: '2.3.0', maximumExclusive: '2.3.0' } })), [
    'EMPTY_RANGE',
  ]);
  assert.equal(c.CertificationRecordContract.validate({ ...v(), harnessVersionRange: { minimum: '2.1', maximumExclusive: '3.0.0' } }).ok, false);
  const unexplained = v();
  unexplained.features[1].reasonCode = null;
  assert.deepEqual(codes(c.CertificationRecordContract.validate(unexplained)), ['REASON_REQUIRED']);
  const dupModel = v();
  dupModel.models.push({ modelId: 'claude-opus-4-1', available: false });
  assert.deepEqual(codes(c.CertificationRecordContract.validate(dupModel)), ['DUPLICATE']);
  // Unknown availability stays null; it is not false.
  assert.equal(c.CertificationRecordContract.assert(v()).models[1].available, null);
  const missingAvailability = v();
  delete missingAvailability.models[1].available;
  assert.equal(c.CertificationRecordContract.validate(missingAvailability).ok, false);
});

test('Ed25519 sign and verify round-trip; any changed field or an untrusted key breaks it (CTR-05)', () => {
  const release = keyPair();
  const other = keyPair();
  const trusted = new Map([['release-2026', release.publicPem]]);
  for (const [name, make] of RECORDS) {
    const contract = c.CONTRACTS.get(name);
    const signed = c.signRecord(unsigned(make()), release.privatePem, 'release-2026');
    assert.equal(contract.validate(signed).ok, true, name);
    assert.deepEqual(c.verifyRecordSignature(signed, trusted), { ok: true, keyId: 'release-2026' }, name);
    // Key order does not matter: the payload is canonical JSON.
    const reordered = Object.fromEntries(Object.entries(signed).reverse());
    assert.equal(c.verifyRecordSignature(reordered, trusted).ok, true, `${name} reordered`);
    // A threshold change or any other edit is a new release and needs a new signature.
    const tampered = structuredClone(signed);
    if (name === 'CalibrationArtifact') tampered.threshold.value = 0.5;
    else tampered.harnessVersionRange.maximumExclusive = '9.0.0';
    assert.equal(contract.validate(tampered).ok, true, `${name} tampered is still well formed`);
    assert.deepEqual(c.verifyRecordSignature(tampered, trusted), { ok: false, reasonCode: 'BAD_SIGNATURE' });
    assert.deepEqual(c.verifyRecordSignature(signed, new Map([['release-2026', other.publicPem]])), { ok: false, reasonCode: 'BAD_SIGNATURE' });
    assert.deepEqual(c.verifyRecordSignature(signed, new Map()), { ok: false, reasonCode: 'UNKNOWN_KEY' });
    assert.deepEqual(c.verifyRecordSignature(unsigned(signed), trusted), { ok: false, reasonCode: 'MISSING_SIGNATURE' });
    assert.deepEqual(c.verifyRecordSignature(signed, new Map([['release-2026', 'not a key']])), { ok: false, reasonCode: 'INVALID_KEY' });
    assert.deepEqual(c.verifyRecordSignature({ ...signed, signature: F.dummySignature() }, trusted), { ok: false, reasonCode: 'BAD_SIGNATURE' });
  }
  assert.throws(() => c.signRecord({ a: 1 }, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), 'k'), /NOT_ED25519/);
});

test('base64 helpers are strict and round-trip every length', () => {
  for (let n = 0; n < 70; n += 1) {
    const data = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    const text = c.base64Encode(data);
    assert.equal(text, Buffer.from(data).toString('base64'));
    assert.deepEqual(c.base64Decode(text), data);
  }
  for (const bad of ['A', 'AAA', 'AA=A', '====', 'AB==', 'A$==']) assert.equal(c.base64Decode(bad), null, bad);
});

test('calibrationApplies disables automation on any mismatch, draft, expiry or small slice (CTR-05)', () => {
  const artifact = c.CalibrationArtifactContract.assert(F.calibrationArtifact());
  const context = {
    nowMs: Date.parse('2026-09-30T00:00:00Z'),
    decisionSpecId: 'task-profile',
    decisionSpecVersion: 'v1',
    questionHash: F.H2,
    modelId: 'jev-1.13.0',
    modelRevisionHash: F.H1,
    encoderHash: F.H2,
    sliceId: 'ts-small-edit',
    minimumSliceSamples: 100,
  };
  assert.deepEqual(c.calibrationApplies(artifact, context), { ok: true });
  const expect = (overrides, reasonCode, subject = artifact) =>
    assert.deepEqual(c.calibrationApplies(subject, { ...context, ...overrides }), { ok: false, reasonCode }, reasonCode);
  expect({}, 'DRAFT', { ...artifact, releaseState: 'draft' });
  expect({ nowMs: Date.parse('2026-09-01T00:00:00Z') }, 'NOT_YET_VALID');
  expect({ nowMs: Date.parse('2026-12-01T00:00:00Z') }, 'EXPIRED');
  expect({ nowMs: Number.NaN }, 'NOT_YET_VALID');
  expect({ decisionSpecVersion: 'v2' }, 'SPEC_MISMATCH');
  expect({ questionHash: F.H1 }, 'QUESTION_MISMATCH');
  expect({ modelRevisionHash: F.H2 }, 'MODEL_MISMATCH');
  expect({ modelId: 'jev-1.14.0' }, 'MODEL_MISMATCH');
  expect({ encoderHash: F.H1 }, 'ENCODER_MISMATCH');
  expect({ sliceId: 'rust-large-refactor' }, 'SLICE_NOT_PERMITTED');
  expect({ sliceId: 'py-small-edit' }, 'SLICE_TOO_SMALL');
});

test('certificationCovers disables actuation outside the range, OS, validity or feature (§15.4, CTR-05)', () => {
  const record = c.CertificationRecordContract.assert(F.certificationRecord());
  const context = {
    harness: 'claude',
    harnessVersion: '2.2.7',
    operatingSystem: 'darwin',
    nowMs: Date.parse('2026-09-30T00:00:00Z'),
    featureId: 'pre-compact-context',
  };
  assert.deepEqual(c.certificationCovers(record, context), { ok: true });
  const expect = (overrides, reasonCode) =>
    assert.deepEqual(c.certificationCovers(record, { ...context, ...overrides }), { ok: false, reasonCode }, `${reasonCode} ${JSON.stringify(overrides)}`);
  expect({ harness: 'codex' }, 'HARNESS_MISMATCH');
  expect({ harnessVersion: '2.3.0' }, 'VERSION_OUT_OF_RANGE');
  expect({ harnessVersion: '2.0.9' }, 'VERSION_OUT_OF_RANGE');
  expect({ harnessVersion: '2.1.0-beta.1' }, 'VERSION_OUT_OF_RANGE');
  expect({ harnessVersion: 'latest' }, 'INVALID_VERSION');
  expect({ operatingSystem: 'win32' }, 'OS_NOT_CERTIFIED');
  expect({ nowMs: Date.parse('2026-12-01T00:00:00Z') }, 'EXPIRED');
  expect({ nowMs: Date.parse('2026-01-01T00:00:00Z') }, 'NOT_YET_VALID');
  expect({ featureId: 'worker-routing' }, 'FEATURE_NOT_CERTIFIED');
  expect({ featureId: 'unknown-feature' }, 'FEATURE_NOT_CERTIFIED');
  assert.deepEqual(c.certificationCovers(record, { ...context, harnessVersion: '2.1.0' }), { ok: true });
  assert.deepEqual(c.certificationCovers(record, { ...context, harnessVersion: '2.2.99-rc.1' }), { ok: true });
});

test('compareSemver follows semver precedence', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(c.compareSemver(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(c.compareSemver(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(c.compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(c.compareSemver('1.2', '1.2.3'), null);
  assert.equal(c.compareSemver('01.2.3', '1.2.3'), null);
});
