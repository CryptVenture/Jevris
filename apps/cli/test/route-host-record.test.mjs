// Serving hosts R57 with C's R50 (ac3b6e31): the record certify signs for K13 to K15 is the one
// the sidecar's default reader (no injected check) turns into hostRouteCertified for that harness
// version. The live harness checks and the stub case results stand in for a real kilo run (npm
// test never starts a harness); the feature composition, the signing, the record file, the
// loader and the sidecar are the product's own. Temp home, file-based local key, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { recordFeatures, signedCertificationRecord, HOST_STUB_CASES, SESSION_ROUTE_STUB_CASES } = await import('../dist/certification.js');
const { fixtureSuiteHash } = await import('../dist/conformance-run.js');
const { certificationsDir, localSigningKey } = await import('@jevris/cli/certifications');
const { hostRouteCertified } = await import('@jevris/orchestrator');
const { startDaemon, sidecarRequest } = await import('@jevris/sidecar');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const HARNESS = 'kilocode';
const VERSION = '7.7.9';
const os = process.platform;

const pass = (id) => ({ id, passed: true, reasonCode: null, detail: '' });
const fail = (id, reasonCode) => ({ id, passed: false, reasonCode, detail: '' });
// The harness loaded the plugin and ran its hooks (in a real run, liveFeatureChecks).
const live = [
  { featureId: 'plugin.install', passed: true, reasonCode: null, detail: 'stand-in' },
  { featureId: 'hooks.observe', passed: true, reasonCode: null, detail: 'stand-in' },
];
const ids = HOST_STUB_CASES[HARNESS];

/** What certify writes for these stub case results: the same composition, signature and file. */
async function certify(home, stubCases) {
  const features = recordFeatures({ harness: HARNESS, live, extra: [], stubCases, policies: [] });
  const record = await signedCertificationRecord({ harness: HARNESS, os, harnessVersion: VERSION, nowMs: Date.now(), root, features, conformant: true, suiteHash: fixtureSuiteHash(HARNESS), key: await localSigningKey(home) });
  const dir = certificationsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${HARNESS}-${os}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { features, record, file };
}

// The sidecar keeps each certification answer for TURN_CERT_TTL_MS (1 s; apps/sidecar/src/state.ts,
// certificationCache). A wait just past it reads the record again; change both together.
const PAST_CERT_CACHE_MS = 1100;

const read = (home, harnessVersion) => hostRouteCertified({ home, harness: HARNESS, nowMs: Date.now(), harnessVersion });

function tempHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-route-host-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

test('K13 to K15 passing: certify records route.host, and the sidecar default reader gives hostRouteCertified for that version only', { skip: managedHostSkip() }, async (t) => {
  const home = tempHome(t);
  const { features, record, file } = await certify(home, [pass(SESSION_ROUTE_STUB_CASES[HARNESS]), pass(ids.listing), pass(ids.route), pass(ids.redefined)]);
  assert.equal(features.find((item) => item.featureId === 'route.host')?.passed, true);
  assert.deepEqual(record.features.find((item) => item.featureId === 'route.host'), { featureId: 'route.host', status: 'certified', reasonCode: null });
  assert.equal(await read(home, VERSION), true, 'the orchestrator reader, on the signed file');
  assert.equal(await read(home, '7.8.0'), false, 'a version outside the record range');

  const workspace = join(home, 'ws');
  mkdirSync(workspace);
  const stamped = [];
  const subscribers = [{ name: 'host', handle: (ctx) => (stamped.push(ctx.body.hostRouteCertified), { ok: true }) }];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace });
    const ws = { id: registered.result.id, root: registered.result.root };
    const ctx = { home, workspace: ws, store: started.daemon.state.storeFor(ws), killSwitchStopped: false };
    const context = (sessionId) => started.daemon.state.turnContext(ctx, sessionId, HARNESS);
    const start = (key, sessionId, harnessVersion) =>
      sidecarRequest({ home, op: 'event', scope: 'hook', workspace, body: { deliveryKey: key, harnessVersion, envelope: { schemaVersion: '1.0', kind: 'session.started', sessionId, harness: HARNESS } } });
    assert.equal((await start('rh-1', 'kilo-in', VERSION)).result.recorded, true);
    assert.equal((await start('rh-2', 'kilo-out', '7.8.0')).result.recorded, true);
    assert.equal((await context('kilo-in')).hostRouteCertified, true, 'the recorded session at the certified version');
    assert.equal((await context('kilo-out')).hostRouteCertified, false, 'a session at another minor version');
    // The path C's subagent route reads (trigger-handlers): the event body the sidecar stamps, whatever the plugin claimed.
    const worker = (key, sessionId, harnessVersion, claim) =>
      sidecarRequest({ home, op: 'event', scope: 'hook', workspace, body: { deliveryKey: key, harnessVersion, hostRouteCertified: claim, envelope: { schemaVersion: '1.0', kind: 'worker.started', sessionId, harness: HARNESS } } });
    assert.equal((await worker('rh-3', 'kilo-in', VERSION, false)).result.recorded, true);
    assert.equal(stamped.at(-1), true, 'a worker event of the certified session carries hostRouteCertified true');
    assert.equal((await worker('rh-4', 'kilo-out', '7.8.0', true)).result.recorded, true);
    assert.equal(stamped.at(-1), false, 'the claim is replaced for the uncertified version');

    // A tampered record fails its signature and certifies nothing, once the cached answer expires.
    const tampered = JSON.parse(readFileSync(file, 'utf8'));
    tampered.harnessVersionRange = { ...tampered.harnessVersionRange, maximumExclusive: '99.0.0' };
    writeFileSync(file, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    assert.equal(await read(home, VERSION), false, 'the orchestrator reader refuses the tampered record');
    await new Promise((resolve) => setTimeout(resolve, PAST_CERT_CACHE_MS));
    assert.equal((await context('kilo-in')).hostRouteCertified, false, 'the sidecar reads not certified after tampering');
  } finally {
    await started.daemon.stop('test');
  }
});

test('K15 failing, or no session.route: certify records route.host unsupported and the default reader reads not certified', async (t) => {
  for (const [stubCases, reasonCode] of [
    [[pass(SESSION_ROUTE_STUB_CASES[HARNESS]), pass(ids.listing), pass(ids.route), fail(ids.redefined, 'ROUTE_NOT_REFUSED')], 'ROUTE_HOST_CASE_FAILED'],
    [[pass(ids.listing), pass(ids.route), pass(ids.redefined)], 'ROUTE_HOST_NEEDS_SESSION_ROUTE'],
  ]) {
    const home = tempHome(t);
    const { record } = await certify(home, stubCases);
    assert.deepEqual(record.features.find((item) => item.featureId === 'route.host'), { featureId: 'route.host', status: 'unsupported', reasonCode });
    assert.equal(await read(home, VERSION), false, reasonCode);
  }
});
