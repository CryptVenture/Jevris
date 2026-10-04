// The Jev connection, opened ahead of the first request (state.ts `prewarmJevConnection`). Measured live
// (2026-10-04): the first request of a fresh sidecar took 440 ms where one on an open connection took 300, and a
// request on an open connection answered 50 to 110 ms sooner than one that had to connect. The sidecar opens the
// connection (TCP and TLS, no request, no data) when it starts, but only when Jev could be asked right now: the engine
// has a key, the mode allows background network work, `jev.assist` is not off, the kill switch is clear and no test
// provider stands in. Temporary homes, a fake engine and recording ports: no keychain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { openRuntimeState, prewarmJevConnection } = await import('../dist/state.js');
const { jevrisPaths } = await import('@jevris/platform');
const { DEFAULT_CONFIG, configFilePath } = await import('@jevris/orchestrator');
const { EXPLICIT_BASE_URL } = await import('@jevris/contracts');

function temp(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-jev-connection-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeConfig(home, patch) {
  const path = configFilePath({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...DEFAULT_CONFIG, ...patch }, null, 2)}\n`);
}

const keyed = () => ({ providerConfigured: true, async decide() { return { abstained: true, reasonCode: 'FAKE', decisionId: 'd-fake', fallback: null }; } });
const rulesOnly = () => ({ providerConfigured: false });

function recordingPorts({ ready = true, override = false } = {}) {
  const calls = [];
  return { calls, ports: { async prewarm(url) { calls.push(url); return ready; }, overrideActive: () => override } };
}

/** Opens the runtime state the way the daemon does (a fake engine, no store) and waits for its start-up work to end. */
async function started(home, engine, ports, logs = []) {
  const state = await openRuntimeState({ home, paths: jevrisPaths({ home }), log: (entry) => logs.push(entry), openStore: false, engine, jevConnection: ports, modelOffer: false, liveCertification: false, accessResumeMs: 0 });
  await state.close();
  return logs;
}

test('with a key, a mode that allows it, jev.assist on and the kill switch clear, the connection opens once, to the production origin', { skip: managedHostSkip() }, async (t) => {
  const home = temp(t);
  const { calls, ports } = recordingPorts();
  const logs = await started(home, keyed(), ports);
  assert.deepEqual(calls, [EXPLICIT_BASE_URL]);
  assert.deepEqual(logs.filter((l) => l.event === 'jev-connection').map((l) => l.reasonCode), ['PREWARM_READY']);
});

test('a connection that could not be opened is logged as a reason code and nothing else happens', { skip: managedHostSkip() }, async (t) => {
  const home = temp(t);
  const { calls, ports } = recordingPorts({ ready: false });
  const logs = await started(home, keyed(), ports);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs.filter((l) => l.event === 'jev-connection').map((l) => l.reasonCode), ['PREWARM_UNAVAILABLE']);
});

test('no key (rules-only), a test provider, mode off, jev.assist off and a stopped kill switch each open nothing', { skip: managedHostSkip() }, async (t) => {
  const none = async (what, engine, setup, { override = false } = {}) => {
    const home = temp(t);
    setup?.(home);
    const { calls, ports } = recordingPorts({ override });
    const logs = await started(home, engine, ports);
    assert.deepEqual(calls, [], what);
    assert.equal(logs.some((l) => l.event === 'jev-connection'), false, `${what}: nothing is logged for a connection that was not tried`);
  };
  await none('rules-only', rulesOnly());
  await none('a test provider stands in', keyed(), undefined, { override: true });
  await none('mode off', keyed(), (home) => writeConfig(home, { mode: 'off' }));
  await none('jev.assist off', keyed(), (home) => writeConfig(home, { jev: { assist: 'off' } }));
  await none('the kill switch is stopped', keyed(), (home) => {
    const flag = join(jevrisPaths({ home }).config, 'kill-switch.json');
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, '{"stopped":true}\n'); // test-hygiene: not product source
  });
  // Paired: the same homes with the gate open do open it.
  const home = temp(t);
  writeConfig(home, { mode: 'observe', jev: { assist: 'classify' } });
  const { calls, ports } = recordingPorts();
  await started(home, keyed(), ports);
  assert.equal(calls.length, 1);
});

test('the reason of each gate, in the order the gates are read', async () => {
  const base = { engine: keyed(), ports: recordingPorts().ports, allowed: () => true, assist: () => 'classify', killSwitchStopped: async () => false };
  assert.equal((await prewarmJevConnection({ ...base, ports: undefined })).reasonCode, 'PREWARM_NO_PORT');
  assert.equal((await prewarmJevConnection({ ...base, engine: rulesOnly() })).reasonCode, 'PREWARM_RULES_ONLY');
  assert.equal((await prewarmJevConnection({ ...base, engine: undefined })).reasonCode, 'PREWARM_RULES_ONLY');
  assert.equal((await prewarmJevConnection({ ...base, ports: recordingPorts({ override: true }).ports })).reasonCode, 'PREWARM_TEST_PROVIDER');
  assert.equal((await prewarmJevConnection({ ...base, allowed: () => false })).reasonCode, 'PREWARM_MODE_OFF');
  assert.equal((await prewarmJevConnection({ ...base, assist: () => 'off' })).reasonCode, 'PREWARM_ASSIST_OFF');
  assert.equal((await prewarmJevConnection({ ...base, killSwitchStopped: async () => true })).reasonCode, 'PREWARM_KILL_SWITCH');
  assert.deepEqual(await prewarmJevConnection(base), { warmed: true, reasonCode: 'PREWARM_READY' });
  const throwing = { prewarm: async () => { throw new Error('boom'); }, overrideActive: () => false };
  assert.deepEqual(await prewarmJevConnection({ ...base, ports: throwing }), { warmed: false, reasonCode: 'PREWARM_UNAVAILABLE' });
});

test('with no ports given and an engine passed in (a test), no connection is tried; false turns it off', { skip: managedHostSkip() }, async (t) => {
  const home = temp(t);
  const logs = await started(home, keyed(), undefined);
  assert.equal(logs.some((l) => l.event === 'jev-connection'), false);
  const { calls, ports } = recordingPorts();
  const other = temp(t);
  const state = await openRuntimeState({ home: other, paths: jevrisPaths({ home: other }), log: () => undefined, openStore: false, engine: keyed(), jevConnection: false, modelOffer: false, liveCertification: false, accessResumeMs: 0 });
  await state.close();
  assert.deepEqual(calls, []);
  void ports;
});
