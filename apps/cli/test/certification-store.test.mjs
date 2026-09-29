// HCF-02: the certification loader every consumer shares (`@jevris/cli/certifications`).
// Records count only when they pass the contract and their signature verifies against a
// release `certification` key or the local certify key. Temp homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = await import('@jevris/cli/certifications');
const { signRecord } = await import('../../../packages/contracts/dist/index.js');

const DAY = 86_400_000;

function unsigned(overrides = {}) {
  const now = Date.now();
  return {
    id: 'cert-kilocode-test',
    schemaVersion: '1.0',
    harness: 'kilocode',
    actuatorId: 'kilocode.observe',
    harnessVersionRange: { minimum: '7.7.0', maximumExclusive: '7.8.0' },
    operatingSystems: [process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin'],
    models: [],
    tools: [],
    limitations: ['Observe only.'],
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: [
      { featureId: 'hooks.observe', status: 'certified', reasonCode: null },
      { featureId: 'mcp.tools', status: 'unsupported', reasonCode: 'MCP_NOT_REGISTERED' },
    ],
    certifiedAt: new Date(now - DAY).toISOString(),
    expiresAt: new Date(now + 30 * DAY).toISOString(),
    ...overrides,
  };
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-cert-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('a record signed by the local certify key loads as local and covers its feature', async () => {
  await withHome(async (home) => {
    const key = await store.localSigningKey(home);
    assert.match(key.keyId, /^local-[0-9a-f]{16}$/);
    const again = await store.localSigningKey(home);
    assert.equal(again.keyId, key.keyId, 'the key is created once');
    const dir = store.certificationsDir(home);
    await writeFile(join(dir, 'kilocode.json'), JSON.stringify(signRecord(unsigned(), key.privateKeyPem, key.keyId)));
    const load = await store.loadCertifications(home);
    assert.equal(load.records.length, 1);
    assert.equal(load.records[0].trust, 'local');
    const context = { harness: 'kilocode', harnessVersion: '7.7.9', operatingSystem: load.records[0].record.operatingSystems[0], nowMs: Date.now() };
    assert.notEqual(store.coveringCertification(load, { ...context, featureId: 'hooks.observe' }).covered, null);
    assert.equal(store.coveringCertification(load, { ...context, featureId: 'mcp.tools' }).reasonCode, 'FEATURE_NOT_CERTIFIED');
    assert.equal(store.coveringCertification(load, { ...context, harnessVersion: '7.8.0', featureId: 'hooks.observe' }).reasonCode, 'VERSION_OUT_OF_RANGE');
    assert.equal(store.coveringCertification(load, { ...context, harness: 'codex', featureId: 'hooks.observe' }).reasonCode, 'NO_RECORD');
    assert.equal((await store.loadCertifications(home, { trustLocal: false })).records.length, 0);
  });
});

test('tampered, unknown-key, invalid and non-JSON records are rejected with a reason', async () => {
  await withHome(async (home) => {
    const key = await store.localSigningKey(home);
    const dir = store.certificationsDir(home);
    const signed = signRecord(unsigned(), key.privateKeyPem, key.keyId);
    await writeFile(join(dir, 'tampered.json'), JSON.stringify({ ...signed, harnessVersionRange: { minimum: '0.0.1', maximumExclusive: '99.0.0' } }));
    const stranger = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(join(dir, 'stranger.json'), JSON.stringify(signRecord(unsigned(), stranger, 'someone')));
    await writeFile(join(dir, 'invalid.json'), JSON.stringify({ ...signed, schemaVersion: '9' }));
    await writeFile(join(dir, 'garbage.json'), '{not json');
    const load = await store.loadCertifications(home);
    assert.equal(load.records.length, 0);
    const reasons = Object.fromEntries(load.rejected.map((item) => [item.file, item.reasonCode]));
    assert.equal(reasons['tampered.json'], 'SIGNATURE_BAD_SIGNATURE');
    assert.equal(reasons['stranger.json'], 'SIGNATURE_UNKNOWN_KEY');
    assert.equal(reasons['invalid.json'], 'INVALID');
    assert.equal(reasons['garbage.json'], 'NOT_JSON');
  });
});

test('a record signed by a release certification key loads as release, and a forged key file id is refused', async () => {
  await withHome(async (home) => {
    const pair = generateKeyPairSync('ed25519');
    const root = join(home, 'package');
    await mkdir(join(root, 'assets', 'trust'), { recursive: true });
    await writeFile(
      join(root, 'assets', 'trust', 'release-keys.json'),
      JSON.stringify({ schemaVersion: 1, keys: [{ keyId: 'release-cert-1', role: 'certification', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) }] }),
    );
    const dir = store.certificationsDir(home);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'release.json'), JSON.stringify(signRecord(unsigned(), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'release-cert-1')));
    const load = await store.loadCertifications(home, { root });
    assert.equal(load.records.length, 1);
    assert.equal(load.records[0].trust, 'release');
    assert.equal(load.records[0].keyId, 'release-cert-1');
    // Without the trust file the same record is unknown.
    assert.equal((await store.loadCertifications(home, { root: join(home, 'nowhere') })).records.length, 0);
    // A local public key whose id does not match its bytes is not trusted.
    const other = generateKeyPairSync('ed25519');
    await mkdir(join(dir, 'keys'), { recursive: true });
    await writeFile(join(dir, 'keys', 'local.pub.pem'), other.publicKey.export({ type: 'spki', format: 'pem' }));
    await writeFile(join(dir, 'forged.json'), JSON.stringify(signRecord(unsigned(), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'local-0000000000000000')));
    const forged = await store.loadCertifications(home, { root: join(home, 'nowhere') });
    assert.equal(forged.records.length, 0);
  });
});

test('an absent certifications folder loads nothing and never throws', async () => {
  await withHome(async (home) => {
    const load = await store.loadCertifications(home);
    assert.deepEqual([load.records.length, load.rejected.length], [0, 0]);
    assert.equal(load.dir, store.certificationsDir(home));
    assert.equal((await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).includes('"./certifications"'), true);
  });
});
