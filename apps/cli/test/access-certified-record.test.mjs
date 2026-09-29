// OP-4 (coordinator; A's R81 docs pass): the owned runner and the session subscriber trust an
// access signal only when the harness's signed certification record covers access.detect (K16-K18)
// or access.session (K19, K20) at the running version. This reads the record certify signs, through
// the orchestrator's default reader (the same one route.host uses, F's 622e3b27), never a plugin's
// claim. The stub case results stand in for a real kilo run (npm test never starts a harness).
// Temp home, file-based local key, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { recordFeatures, signedCertificationRecord } = await import('../dist/certification.js');
const { fixtureSuiteHash } = await import('../dist/conformance-run.js');
const { certificationsDir, localSigningKey } = await import('@jevris/cli/certifications');
const { accessCertified, recordHarnessVersion } = await import('@jevris/orchestrator');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const HARNESS = 'kilocode';
const VERSION = '7.7.9';
const os = process.platform;

const pass = (id) => ({ id, passed: true, reasonCode: null, detail: '' });
const fail = (id, reasonCode) => ({ id, passed: false, reasonCode, detail: '' });
const live = [
  { featureId: 'plugin.install', passed: true, reasonCode: null, detail: 'stand-in' },
  { featureId: 'hooks.observe', passed: true, reasonCode: null, detail: 'stand-in' },
];
const detect = ['rate', 'credit', 'auth'].map((kind) => [HARNESS, 'access-limit', kind].join('.'));
const session = [HARNESS, 'session', 'error'].join('.');

async function certify(home, stubCases) {
  const features = recordFeatures({ harness: HARNESS, live, extra: [], stubCases, policies: [] });
  const record = await signedCertificationRecord({ harness: HARNESS, os, harnessVersion: VERSION, nowMs: Date.now(), root, features, conformant: true, suiteHash: fixtureSuiteHash(HARNESS), key: await localSigningKey(home) });
  const dir = certificationsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HARNESS}-${os}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function tempHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-access-cert-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

const read = (home, featureId, harnessVersion) => accessCertified({ home, harness: 'kilo', featureId, nowMs: Date.now(), ...(harnessVersion === undefined ? {} : { harnessVersion }) });

test('OP-4: K16-K20 passing: access.detect and access.session are certified for that version only, from the signed record', { skip: managedHostSkip() }, async (t) => {
  const home = tempHome(t);
  const record = await certify(home, [...detect.map(pass), pass(session)]);
  assert.deepEqual(
    record.features.filter((item) => item.featureId.startsWith('access.')).map((item) => [item.featureId, item.status]),
    [['access.detect', 'certified'], ['access.session', 'certified']],
  );
  assert.equal(await read(home, 'access.detect', VERSION), true, 'the session-forwarded version');
  assert.equal(await read(home, 'access.session', VERSION), true);
  assert.equal(await read(home, 'access.detect', '7.8.0'), false, 'a version outside the record range');
  assert.equal(await read(home, 'access.detect'), false, 'no version known: not certified');
  // An owned run reads the installed version doctor or install recorded.
  await recordHarnessVersion(home, HARNESS, VERSION);
  assert.equal(await read(home, 'access.detect'), true);
  await recordHarnessVersion(home, HARNESS, '7.8.0');
  assert.equal(await read(home, 'access.detect'), false, 'the installed binary moved past the record');
});

test('OP-4: a failed K17 leaves access.detect uncertified while access.session holds; a tampered record certifies nothing', { skip: managedHostSkip() }, async (t) => {
  const home = tempHome(t);
  const record = await certify(home, [pass(detect[0]), fail(detect[1], 'FOUND_NOTHING'), pass(detect[2]), pass(session)]);
  assert.equal(record.features.find((item) => item.featureId === 'access.detect')?.status === 'certified', false);
  assert.equal(await read(home, 'access.detect', VERSION), false);
  assert.equal(await read(home, 'access.session', VERSION), true);
  // A record rewritten after signing fails its signature: nothing is certified.
  const file = join(certificationsDir(home), `${HARNESS}-${os}.json`);
  const forged = { ...record, features: record.features.map((item) => (item.featureId === 'access.detect' ? { ...item, status: 'certified', reasonCode: null } : item)) };
  writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`, { mode: 0o600 });
  assert.equal(await read(home, 'access.detect', VERSION), false);
  assert.equal(await read(home, 'access.session', VERSION), false);
});
