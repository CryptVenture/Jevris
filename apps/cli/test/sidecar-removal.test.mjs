import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// IPC-16: `sidecarDoctorView` gives doctor the sidecar pid, version, uptime, endpoint, store
// health and kill switch without starting anything. IPC-17: `stopSidecarForRemoval` stops the
// sidecar (and removes its service unit) before uninstall or data delete.

const { main } = await import('../dist/cli.js');
const { sidecarDoctorView, stopSidecarForRemoval } = await import('../dist/runtime-commands.js');
const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');

test('doctor sees the sidecar facts, and removal stops it and its service first (IPC-16, IPC-17)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-removal-')));
  const saved = { entry: process.env.JEVRIS_SIDECAR_ENTRY, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  // Any service unit path lands under this temp OS home, never the real one.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    // Idle is normal: hooks and commands start the sidecar on demand (IPC-16).
    let view = await sidecarDoctorView(home);
    assert.equal(view.state, 'idle');
    assert.equal(view.degraded, false);
    assert.match(view.message, /starts on demand/);
    // With autostart off it is the user's choice: not running, not degraded, and it says why.
    const off = await sidecarDoctorView(home, { env: { ...process.env, JEVRIS_SIDECAR_AUTOSTART: '0' } });
    assert.deepEqual([off.state, off.degraded], ['not-running', false]);
    assert.match(off.message, /autostart is off \(JEVRIS_SIDECAR_AUTOSTART=0\)/);
    assert.equal(view.pid, null);
    assert.equal(view.killSwitch, 'clear');

    const noop = await stopSidecarForRemoval(home);
    assert.deepEqual([noop.stopped, noop.method, noop.service], [true, 'not-running', null]);

    assert.equal(await main(['sidecar', 'start', '--home', home], () => {}), 0);
    view = await sidecarDoctorView(home);
    assert.equal(view.state, 'running', JSON.stringify(view));
    assert.equal(view.degraded, false);
    assert.equal(typeof view.pid, 'number');
    assert.match(view.version ?? '', /^\d+\.\d+\.\d+/);
    assert.equal(typeof view.uptimeMs, 'number');
    assert.equal(typeof view.endpoint, 'string');
    assert.deepEqual(view.store, { state: 'ok', diagnostic: null });
    assert.equal(view.killSwitch, 'clear');

    const calls = [];
    let taskXml = '';
    const serviceExec = (file, args) => {
      calls.push([file.split(/[\\/]/).at(-1), ...args]);
      return { status: 0, stdout: args.includes('/XML') ? taskXml : '', stderr: '' };
    };
    // A unit for this home is installed first (the service manager is faked), so every OS has
    // one to remove, with or without a systemd user session.
    const { runRuntimeCommand } = await import('../dist/runtime-commands.js');
    let installOut = '';
    assert.equal(await runRuntimeCommand(['service', 'install', '--home', home, '--json'], (t) => (installOut += t), { serviceExec }), 0, installOut);
    const unitPath = JSON.parse(installOut).unitPath;
    assert.ok(unitPath.startsWith(home), 'the unit is under the temp OS home');
    // Install hands the sidecar that runs on demand over to the service: it was stopped (the faked
    // manager starts nothing), and the install line says so.
    assert.match(JSON.parse(installOut).sidecar, /^sidecar: stopped the on-demand sidecar \(pid \d+\) so the service can start its own$/);
    assert.equal((await sidecarDoctorView(home)).state, 'idle');
    // Removal must stop a sidecar that runs beside an installed unit, so start one on demand again
    // (the real manager is never asked: the test run keeps it from being called).
    const { ensureSidecar } = await import('@jevris/sidecar');
    const again = await ensureSidecar({ home, waitMs: 10_000 }, { service: false });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal((await sidecarDoctorView(home)).state, 'running');
    if (process.platform === 'win32') taskXml = readFileSync(unitPath).subarray(2).toString('utf16le');
    calls.length = 0;
    const removed = await stopSidecarForRemoval(home, { removeService: true, serviceExec });
    assert.equal(removed.stopped, true, JSON.stringify(removed));
    assert.equal(removed.method, 'shutdown-frame');
    assert.notEqual(removed.service, null);
    assert.equal(removed.service.ok, true);
    assert.equal(removed.service.state, 'not-installed');
    assert.equal(existsSync(unitPath), false, 'the unit file is removed');
    assert.ok(calls.length >= 1, 'the service manager was asked to remove the unit');
    assert.equal((await sidecarDoctorView(home)).state, 'idle');
  } finally {
    await main(['sidecar', 'stop', '--home', home], () => {});
    for (const [name, value] of [['JEVRIS_SIDECAR_ENTRY', saved.entry], ['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['XDG_CONFIG_HOME', saved.XDG_CONFIG_HOME]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor reports a sidecar killed without cleanup as degraded, and idle again once a start recovers it (IPC-16)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-stale-')));
  const saved = { entry: process.env.JEVRIS_SIDECAR_ENTRY, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.equal(await main(['sidecar', 'start', '--home', home], () => {}), 0);
    const running = await sidecarDoctorView(home);
    assert.equal(running.state, 'running');
    process.kill(running.pid, 'SIGKILL');
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 1_200 && alive(running.pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const stale = await sidecarDoctorView(home);
    assert.equal(stale.state, 'not-running');
    assert.equal(stale.degraded, true);
    assert.match(stale.message, /without cleaning up/);
    // The next start recovers the stale files; a clean stop leaves it idle, not degraded.
    assert.equal(await main(['sidecar', 'start', '--home', home], () => {}), 0);
    assert.equal(await main(['sidecar', 'stop', '--home', home], () => {}), 0);
    const idle = await sidecarDoctorView(home);
    assert.deepEqual([idle.state, idle.degraded], ['idle', false]);
  } finally {
    await main(['sidecar', 'stop', '--home', home], () => {});
    for (const [name, value] of [['JEVRIS_SIDECAR_ENTRY', saved.entry], ['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
