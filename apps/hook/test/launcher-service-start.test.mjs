// A hook that finds no sidecar starts one on demand without waiting for it. When a service is
// installed for the home, that start goes through the service manager, never a second, unsupervised
// sidecar, and it can never hold the hook past its deadline: the hook answers rules-only and the
// start goes on by itself. The service manager is a stand-in that records its calls; nothing real
// runs (no launchctl, systemctl or schtasks, no sidecar process, no harness).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runLauncher, countedHookReason } = await import('../dist/launcher.js');
const { installService, runtimeFiles, serviceInputForHome } = await import('@jevris/sidecar');
const client = await import('@jevris/sidecar/client');
const claude = await import('@jevris/adapter-claude-code');

const platform = ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'linux';
const native = JSON.stringify(claude.FIXTURES.find((f) => f.id === 'claude.session-start').native);
const bases = new Set();

after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** A Jevris home and an account home in a short temp folder, with this home's service unit installed. */
function scene() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jhs-')));
  bases.add(base);
  const home = join(base, 'h');
  const osHome = join(base, 'a');
  mkdirSync(home);
  mkdirSync(osHome);
  const input = serviceInputForHome({ home, command: ['/opt/jevris/dist/sidecar.mjs'], platform, osHome });
  assert.equal(installService(input, () => ({ status: 0, stdout: '', stderr: '' })).ok, true);
  return { home, osHome };
}

/** The launcher's sidecar port over the real client, with a stand-in manager and a recorded spawn. */
function wiring({ home, osHome }, run) {
  const managerCalls = [];
  const spawns = [];
  const service = {
    platform,
    osHome,
    run: (file, args) => {
      managerCalls.push([file, ...args]);
      return run(file, args);
    },
  };
  const sidecar = {
    ensure: (input) =>
      client.ensureSidecar(input, {
        service,
        spawn: (options) => {
          spawns.push(options);
          return true;
        },
      }),
    // A hook's request finds no sidecar: the endpoint file is absent.
    request: async () => ({ ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' }),
  };
  const deps = (env = {}) => ({ adapters: { claude }, sidecar, env: { JEVRIS_HOME: home, ...env }, cwd: () => '/work', nowMs: () => Date.now() });
  return { managerCalls, spawns, deps };
}

test('a hook with no sidecar and a service installed asks the service manager, spawns nothing, and answers rules-only', async () => {
  const s = scene();
  const w = wiring(s, async () => ({ status: 0 }));
  const result = await runLauncher({ harness: 'claude', event: null }, native, w.deps(), Date.now());
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, 'SIDECAR_STARTING', 'the start proceeds on its own; this delivery observes');
  assert.equal(w.managerCalls.length, 1);
  assert.equal(w.spawns.length, 0, 'no second, unsupervised sidecar');
});

test('a service manager that is slow never holds the hook: it still answers inside its deadline, and the start goes on', async () => {
  const s = scene();
  let answer;
  const pending = new Promise((resolve) => {
    answer = resolve;
  });
  const w = wiring(s, () => pending);
  const result = await runLauncher({ harness: 'claude', event: null }, native, w.deps(), Date.now());
  assert.equal(result.exitCode, 0);
  assert.match(result.reason, /^SIDECAR_(STARTING|TIMEOUT)$/, 'rules-only, whichever of the manager grace or the hook deadline ended the wait');
  assert.equal(w.managerCalls.length, 1);
  assert.equal(w.spawns.length, 0, 'an unanswered start is not a refusal');
  // A tighter hook deadline ends the wait just as well.
  const tight = wiring(scene(), () => new Promise(() => undefined));
  const quick = await runLauncher({ harness: 'claude', event: null }, native, tight.deps({ JEVRIS_HOOK_DEADLINE_MS: '100' }), Date.now());
  assert.equal(quick.exitCode, 0);
  assert.match(quick.reason, /^(SIDECAR_(STARTING|TIMEOUT)|DEADLINE)$/);
  answer({ status: 0 });
});

test('a manager that refuses while the service\'s own sidecar is alive is a reason code on the hook, and nothing is spawned beside it', async () => {
  const s = scene();
  const files = runtimeFiles({ home: s.home });
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\jevris-test-nobody-${process.pid}` : join(files.dir, 'nobody.sock');
  writeFileSync(files.endpoint, JSON.stringify({ schemaVersion: 'jevris-sidecar-endpoint-1', protocol: 1, version: '0.1.0', pid: process.pid, bootId: 'bootnobody', endpoint, startedAtMs: Date.now(), supervised: true }), { mode: 0o600 });
  const w = wiring(s, async () => ({ status: 1 }));
  const result = await runLauncher({ harness: 'claude', event: null }, native, w.deps(), Date.now());
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, 'SIDECAR_SERVICE_START_REFUSED');
  assert.equal(countedHookReason(result.reason), true, 'a delivery miss like any other: it is counted');
  assert.equal(w.spawns.length, 0);
});

test('JEVRIS_SIDECAR_AUTOSTART=0 still means nothing starts anything: no service manager, no spawn (pair)', async () => {
  const s = scene();
  const w = wiring(s, async () => ({ status: 0 }));
  const off = await runLauncher({ harness: 'claude', event: null }, native, w.deps({ JEVRIS_SIDECAR_AUTOSTART: '0' }), Date.now());
  assert.equal(off.exitCode, 0);
  assert.equal(off.reason, 'SIDECAR_AUTOSTART_OFF');
  assert.equal(w.managerCalls.length, 0);
  assert.equal(w.spawns.length, 0);
  const on = await runLauncher({ harness: 'claude', event: null }, native, w.deps(), Date.now());
  assert.equal(on.reason, 'SIDECAR_STARTING');
  assert.equal(w.managerCalls.length, 1, 'with autostart on, the manager is asked');
});
