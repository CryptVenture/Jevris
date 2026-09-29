// SSOT §4.2 "Off: no Jev calls, no optimization actuation, and no invisible background network
// activity" (owner decision 0eb319de, coordinator follow-up):
// - the explicit asks for Jev (route, plan, recover, capability.advise, jev.reenable) are refused
//   with MODE_OFF and the command that raises the mode;
// - read-only ops keep working, and every op sees an engine that never calls Jev;
// - the sidecar's background harness and network work (the model listing with Codex's usage read,
//   the live re-check) does not run, while it does in any other mode.
// Temporary homes, a fake engine, stub listing and re-check ports: no keychain, no harness, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { engineWhenOff } = await import('../dist/mode-off.js');
const { createModelOfferRefresher } = await import('../dist/model-offer.js');
const { DEFAULT_CONFIG, configFilePath } = await import('@jevris/orchestrator');
const { MODE_OFF_REFUSED_OPS } = await import('@jevris/contracts');

function writeMode(home, mode) {
  const path = configFilePath({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...DEFAULT_CONFIG, mode }, null, 2)}\n`);
}

function fakeEngine() {
  const calls = { decide: 0, recordAdvice: 0, probeProvider: 0, routeManagedWorker: 0, lookup: 0 };
  return {
    calls,
    engine: {
      async decide() {
        calls.decide += 1;
        return { abstained: true, reasonCode: 'FAKE', decisionId: 'd-fake', fallback: null };
      },
      async recordAdvice() {
        calls.recordAdvice += 1;
        return { ok: false, reasonCode: 'FAKE' };
      },
      async probeProvider() {
        calls.probeProvider += 1;
        return { probed: true, state: null, reasonCode: 'FAKE' };
      },
      async routeManagedWorker() {
        calls.routeManagedWorker += 1;
        return { launched: false, reasonCode: 'FAKE', selection: null };
      },
      async lookup() {
        calls.lookup += 1;
        return null;
      },
      async entry() {
        return null;
      },
    },
  };
}

test('the engine an op sees in off answers MODE_OFF for anything that would call Jev, and reads through', async () => {
  const { engine, calls } = fakeEngine();
  const off = engineWhenOff(engine);
  assert.deepEqual(await off.decide({}), { abstained: true, reasonCode: 'MODE_OFF', fallback: null });
  assert.deepEqual(await off.recordAdvice({}), { ok: false, reasonCode: 'MODE_OFF' });
  assert.equal((await off.probeProvider()).reasonCode, 'MODE_OFF');
  assert.equal((await off.routeManagedWorker({})).launched, false);
  assert.equal(await off.lookup('d-1'), null);
  assert.deepEqual(calls, { decide: 0, recordAdvice: 0, probeProvider: 0, routeManagedWorker: 0, lookup: 1 });
  // A method the engine does not have stays absent.
  assert.equal(engineWhenOff({ lookup: async () => null }).decide, undefined);
});

test('the model listing does not run while it is not allowed, and runs once it is', async () => {
  let allowed = false;
  const listed = [];
  const refresher = createModelOfferRefresher({
    ports: {
      installed: () => ['codex'],
      recordedVersion: () => null,
      read: () => ({}),
      list: async ({ harness }) => (listed.push(harness), { ok: true, models: ['gpt-5.5'] }),
      record: () => undefined,
    },
    isIdle: () => true,
    allowed: () => allowed,
  });
  assert.deepEqual(await refresher.tick(), []);
  refresher.request('start');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(listed, [], 'a listing (and Codex usage read) ran in off');
  allowed = true;
  assert.equal((await refresher.tick()).length, 1);
  assert.deepEqual(listed, ['codex']);
  await refresher.close();
});

test('off through a running sidecar: Jev asks refused, reads answered, no engine call, no background listing', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-mode-off-')));
  const ws = join(home, 'ws');
  mkdirSync(join(ws, '.git'), { recursive: true });
  writeMode(home, 'off');
  const { engine, calls } = fakeEngine();
  const listed = [];
  const logs = [];
  const ports = {
    installed: () => ['codex'],
    recordedVersion: () => null,
    read: () => ({}),
    list: async ({ harness }) => (listed.push(harness), { ok: true, models: ['gpt-5.5'] }),
    record: () => undefined,
  };
  const started = await startDaemon({ home, idleMs: 0, engine, log: (entry) => logs.push(entry), liveCertification: { root: () => null, reverify: async () => undefined }, modelOffer: ports, modelOfferIdleMs: 0 });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(async () => {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  });
  const ask = (op, body = {}, scope = 'cli') => sidecarRequest({ home, op, scope, workspace: ws, body });

  for (const op of MODE_OFF_REFUSED_OPS) {
    const answer = await ask(op);
    assert.equal(answer.ok, false, op);
    assert.equal(answer.reasonCode, 'MODE_OFF', `${op}: ${JSON.stringify(answer)}`);
    assert.match(answer.message, /jevris configure set mode advise/, op);
  }
  const status = await ask('status', {}, 'mcp');
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.result.jevrisMode, 'off');
  assert.equal(status.result.decisionHealth, 'off');
  const explain = await ask('explain', { decisionId: 'd-missing' }, 'mcp');
  assert.equal(explain.ok, true, `explain still answers in off: ${JSON.stringify(explain)}`);
  // A checkpoint is local and still works; it never reaches Jev in off.
  const checkpoint = await ask('checkpoint', { taskId: 'task-1' }, 'mcp');
  assert.notEqual(checkpoint.reasonCode, 'MODE_OFF');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual([calls.decide, calls.recordAdvice, calls.probeProvider, calls.routeManagedWorker], [0, 0, 0, 0], 'the engine was asked in off');
  assert.deepEqual(listed, [], 'the model listing ran in off');
  assert.ok(logs.some((entry) => entry.event === 'live-recheck-skipped' && entry.reasonCode === 'MODE_OFF'), 'the live re-check was not skipped');

  // Raised to advise, the same asks run (whatever they then answer) and the listing runs when idle.
  writeMode(home, 'advise');
  const route = await ask('route', {}, 'mcp');
  assert.notEqual(route.reasonCode, 'MODE_OFF');
  await started.daemon.state.startupMaintenance();
  for (let i = 0; i < 100 && listed.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(listed, ['codex'], 'the listing did not run once the mode allowed it');
});

test('the sidecar status carries the upgrade notice while it applies (1.2 mode migration)', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-mode-notice-')));
  const ws = join(home, 'ws');
  mkdirSync(join(ws, '.git'), { recursive: true });
  writeMode(home, 'observe');
  const { MODE_MIGRATION_NOTICE } = await import('@jevris/orchestrator');
  // The sidecar's start runs the migration: the old default moves, and the fact is kept.
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification: false, modelOffer: false });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(async () => {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  });
  const status = await sidecarRequest({ home, op: 'status', scope: 'mcp', workspace: ws, body: {} });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.result.jevrisMode, 'bounded-auto');
  assert.equal(status.result.modeNotice, MODE_MIGRATION_NOTICE);
});
