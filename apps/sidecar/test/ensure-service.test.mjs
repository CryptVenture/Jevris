// A caller that finds no sidecar starts one on demand (hooks, CLI commands, the MCP server). When
// `jevris service install` set up a service for this home, that start now asks the service
// manager to start the unit (launchctl kickstart, systemctl --user start, schtasks /Run) instead of
// spawning a second, unsupervised sidecar beside it. With no service installed nothing changes.
//
// Every service manager call is a stand-in that records what it was given and returns a scripted
// result; the platform and the account's home are injected, so one host covers the three command
// sets. No real launchctl, systemctl or schtasks runs, and no sidecar process is spawned (a
// supervised sidecar that "comes up" is an in-process daemon the stand-in manager starts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ensureSidecar, installService, probeSidecar, runtimeFiles, serviceInputForHome, serviceInstalledFor, serviceStartCommand, startDaemon } = await import('../dist/index.js');
const { sidecarCommand } = await import('../dist/client.js');

const PLATFORMS = ['darwin', 'linux', 'win32'];
const ENTRY = '/opt/jevris/dist/sidecar.mjs';

/** In-process daemons a test started; the file-level after() stops any a failed assertion left. */
const daemons = new Set();
const bases = new Set();

after(async () => {
  for (const daemon of [...daemons]) await daemon.stop('test-cleanup').catch(() => undefined);
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** A short, real temp folder: a Jevris home and an account home (where per-user units live). */
function folders() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jes-')));
  bases.add(base);
  const home = join(base, 'h');
  const osHome = join(base, 'a');
  mkdirSync(home);
  mkdirSync(osHome);
  return { base, home, osHome };
}

/** Installs the unit for `home` through a stand-in manager (it only has to say yes). */
function installUnit({ home, osHome, platform }) {
  const input = serviceInputForHome({ home, command: [ENTRY], platform, osHome });
  const installed = installService(input, () => ({ status: 0, stdout: '', stderr: '' }));
  assert.equal(installed.ok, true, JSON.stringify(installed));
  return input;
}

/** A stand-in service manager: records every command, answers as scripted, and may start a sidecar. */
function manager({ answer = { status: 0 }, onStart } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (onStart !== undefined) await onStart();
    return typeof answer === 'function' ? answer() : answer;
  };
  return { calls, run };
}

/** A stand-in for the on-demand spawn: records its calls and says it started. */
function spawner() {
  const spawns = [];
  return {
    spawns,
    spawn: (options) => {
      spawns.push(options);
      return true;
    },
  };
}

const depsFor = ({ platform, osHome, run, spawn }) => ({ service: { platform, osHome, run }, ...(spawn === undefined ? {} : { spawn }) });

/** The start command each manager is asked, spelled out so the test does not just echo the code. */
function expectedStart(platform, input) {
  if (platform === 'darwin') return { file: '/bin/launchctl', args: ['kickstart', `gui/${String(input.uid ?? 0)}/dev.jevris.sidecar`] };
  if (platform === 'linux') return { file: 'systemctl', args: ['--user', 'start', 'jevris-sidecar.service'] };
  return { file: /schtasks\.exe$/, args: ['/Run', '/TN', '\\Jevris\\Sidecar'] };
}

function assertStartCommand(call, platform, input) {
  const want = expectedStart(platform, input);
  const [file, ...args] = call;
  if (want.file instanceof RegExp) assert.match(file, want.file);
  else assert.equal(file, want.file);
  assert.deepEqual(args, want.args);
  assert.ok(!args.includes('-k'), 'no forced kill');
}

function lockOf(home) {
  const { spawnLock } = runtimeFiles({ home });
  return existsSync(spawnLock) ? JSON.parse(readFileSync(spawnLock, 'utf8')) : undefined;
}

/** An endpoint file for a sidecar that is "alive" (this process) but has nothing listening. */
function writeDeadSocketEndpoint(home, supervised) {
  const files = runtimeFiles({ home });
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\jevris-test-nobody-${process.pid}` : join(files.dir, 'nobody.sock');
  writeFileSync(files.endpoint, JSON.stringify({ schemaVersion: 'jevris-sidecar-endpoint-1', protocol: 1, version: '0.1.0', pid: process.pid, bootId: 'bootnobody', endpoint, startedAtMs: Date.now(), supervised }), { mode: 0o600 });
}

for (const platform of PLATFORMS) {
  test(`${platform}: a service is installed and the sidecar is down: the manager is asked once, with its start command, and nothing is spawned on demand`, async () => {
    const { home, osHome } = folders();
    const input = installUnit({ home, osHome, platform });
    const m = manager();
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'starting', 'a hook runs rules-only meanwhile: the start proceeds on its own');
    assert.equal(m.calls.length, 1);
    assertStartCommand(m.calls[0], platform, input);
    assert.deepEqual(m.calls[0].slice(1), serviceStartCommand(input).args, 'the same command `jevris sidecar start` asks');
    assert.equal(s.spawns.length, 0, 'no second, unsupervised sidecar');
    assert.equal(lockOf(home)?.via, 'service', 'the lock records that the service was asked');
  });

  test(`${platform}: the supervised sidecar the manager starts is the one a waiting caller connects to`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    const m = manager({
      onStart: async () => {
        const started = await startDaemon({ home, packageOps: false, idleMs: 0, supervised: true, log: () => undefined });
        assert.equal(started.ok, true, started.ok ? '' : started.message);
        daemons.add(started.daemon);
      },
    });
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 60_000 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.started, true);
    assert.equal(m.calls.length, 1);
    assert.equal(s.spawns.length, 0);
    const probe = await probeSidecar(home);
    assert.equal(probe.running, true);
    assert.equal(probe.endpoint?.supervised, true, 'the sidecar that answers is the supervised one');
    assert.equal(existsSync(runtimeFiles({ home }).spawnLock), false, 'the daemon removed the lock once it listened');
    // The next caller finds it running and asks nobody.
    const again = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(again.ok, true);
    assert.equal(again.started, false);
    assert.equal(m.calls.length, 1);
    for (const daemon of [...daemons]) {
      await daemon.stop('test');
      daemons.delete(daemon);
    }
  });

  test(`${platform}: many callers at once ask the manager once, and spawn nothing`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    const m = manager();
    const s = spawner();
    const results = await Promise.all(Array.from({ length: 12 }, () => ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }))));
    assert.equal(m.calls.length, 1, 'the spawn lock picks one caller to ask');
    assert.equal(s.spawns.length, 0);
    for (const result of results) assert.equal(result.reason, 'starting');
  });

  test(`${platform}: a manager that refuses, with no service sidecar alive, falls back to the on-demand spawn (the only sidecar)`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    const m = manager({ answer: { status: 1 } });
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(m.calls.length, 1, 'the manager was asked first');
    assert.equal(s.spawns.length, 1, 'then, safely, the on-demand start');
    assert.equal(result.reason, 'starting');
  });

  test(`${platform}: a manager that cannot be run falls back to the on-demand spawn too`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    const m = manager({ answer: { status: null, error: 'ENOENT' } });
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(s.spawns.length, 1);
    assert.equal(result.reason, 'starting');
  });

  test(`${platform}: a manager that refuses while the service's own sidecar is alive but silent spawns nothing and reports the reason code`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    writeDeadSocketEndpoint(home, true);
    const refused = manager({ answer: { status: 1 } });
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: refused.run, spawn: s.spawn }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.reasonCode, 'SERVICE_START_REFUSED');
    assert.match(result.message, new RegExp(`pid ${process.pid}\\b`));
    assert.match(result.message, /no second sidecar was started/);
    assert.match(result.message, /jevris service status/);
    assert.equal(s.spawns.length, 0, 'a second sidecar is never started beside the service\'s');
    assert.equal(lockOf(home), undefined, 'the lock is released, so the next caller may try again');
    const unreachable = manager({ answer: { status: null, error: 'ENOENT' } });
    const second = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: unreachable.run, spawn: s.spawn }));
    assert.equal(second.reasonCode, 'SERVICE_UNREACHABLE');
    assert.equal(s.spawns.length, 0);
  });

  test(`${platform}: the same refusal while an unsupervised sidecar is alive still spawns nothing from the service path's point of view, but a dead endpoint does not block the fallback (pair)`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    // An on-demand (unsupervised) endpoint that is not answering is not a service-run sidecar: the fallback may spawn.
    writeDeadSocketEndpoint(home, false);
    const m = manager({ answer: { status: 1 } });
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(s.spawns.length, 1);
    assert.equal(result.reason, 'starting');
  });

  test(`${platform}: with no service installed nothing asks a manager and the on-demand spawn is unchanged (pair)`, async () => {
    const { home, osHome } = folders();
    const m = manager();
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(m.calls.length, 0);
    assert.equal(s.spawns.length, 1);
    assert.equal(result.reason, 'starting');
    assert.equal(lockOf(home)?.via, 'spawn');
  });

  test(`${platform}: a unit that serves another home is not this home's service`, async () => {
    const { home, osHome } = folders();
    const other = join(osHome, 'elsewhere');
    mkdirSync(other);
    installUnit({ home: other, osHome, platform });
    const m = manager();
    const s = spawner();
    await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
    assert.equal(m.calls.length, 0, 'the unit (the one per account, or the task definition kept in the other home) serves the other home');
    assert.equal(s.spawns.length, 1);
  });

  test(`${platform}: service false never asks a manager, even with a unit installed`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    const m = manager();
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, { service: false, spawn: s.spawn });
    assert.equal(m.calls.length, 0);
    assert.equal(s.spawns.length, 1);
    assert.equal(result.reason, 'starting');
  });

  test(`${platform}: a slow manager never holds a caller that must not wait: it answers 'starting' and the start goes on by itself`, async () => {
    const { home, osHome } = folders();
    installUnit({ home, osHome, platform });
    const calls = [];
    // The stand-in manager does not answer until the test lets it, after the caller was released.
    let answer;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    const run = (file, args) => {
      calls.push([file, ...args]);
      return pending;
    };
    const s = spawner();
    const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run, spawn: s.spawn }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'starting');
    assert.equal(calls.length, 1);
    assert.equal(s.spawns.length, 0, 'an unanswered start is not a refusal: nothing is spawned beside it');
    assert.equal(lockOf(home)?.via, 'service');
    answer({ status: 0 });
  });
}

test('a service start that left no sidecar within the lock window is not repeated: the next call spawns on demand, without asking the manager', async () => {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const { home, osHome } = folders();
  installUnit({ home, osHome, platform });
  const files = runtimeFiles({ home });
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  writeFileSync(files.spawnLock, JSON.stringify({ pid: process.pid, atMs: Date.now() - 60_000, via: 'service' }), { mode: 0o600 });
  const m = manager();
  const s = spawner();
  const result = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
  assert.equal(m.calls.length, 0, 'the manager already had its chance');
  assert.equal(s.spawns.length, 1);
  assert.equal(result.reason, 'starting');
});

test('a fresh service lock whose caller has already exited still holds: a hook is gone in milliseconds, the service is still starting (pair)', async () => {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const { home, osHome } = folders();
  installUnit({ home, osHome, platform });
  const files = runtimeFiles({ home });
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const gone = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(gone.status, 0);
  writeFileSync(files.spawnLock, JSON.stringify({ pid: gone.pid, atMs: Date.now(), via: 'service' }), { mode: 0o600 });
  const m = manager();
  const s = spawner();
  const held = await ensureSidecar({ home, waitMs: 0 }, depsFor({ platform, osHome, run: m.run, spawn: s.spawn }));
  assert.equal(held.reason, 'starting');
  assert.equal(m.calls.length, 0, 'nobody asks the manager a second time');
  assert.equal(s.spawns.length, 0, 'and nobody races the service with an unsupervised sidecar');
  // The pair: an on-demand lock whose spawner died is still taken over at once, as before.
  writeFileSync(files.spawnLock, JSON.stringify({ pid: gone.pid, atMs: Date.now(), via: 'spawn' }), { mode: 0o600 });
  const none = folders();
  const plain = manager();
  const spawned = spawner();
  mkdirSync(runtimeFiles({ home: none.home }).dir, { recursive: true, mode: 0o700 });
  writeFileSync(runtimeFiles({ home: none.home }).spawnLock, JSON.stringify({ pid: gone.pid, atMs: Date.now(), via: 'spawn' }), { mode: 0o600 });
  await ensureSidecar({ home: none.home, waitMs: 0 }, depsFor({ platform, osHome: none.osHome, run: plain.run, spawn: spawned.spawn }));
  assert.equal(spawned.spawns.length, 1, 'a dead on-demand spawner holds nothing');
  assert.equal(plain.calls.length, 0);
});

test('serviceInstalledFor reads the unit file alone: true for this home, false for another or none, and no manager is called', () => {
  const { home, osHome } = folders();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = osHome;
    process.env.USERPROFILE = osHome;
    assert.equal(serviceInstalledFor(home), false, 'nothing installed');
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return;
    const input = serviceInputForHome({ home, command: sidecarCommand() ?? [ENTRY] });
    const installed = installService(input, () => ({ status: 0, stdout: '', stderr: '' }));
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(serviceInstalledFor(home), true);
    const other = join(osHome, 'elsewhere');
    mkdirSync(other);
    assert.equal(serviceInstalledFor(other), false, 'a unit for one home is not another home\'s service');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('the account\'s own home is the default home: a unit installed for it carries no --home, however the home was named', () => {
  const { osHome } = folders();
  const byDefault = serviceInputForHome({ command: [ENTRY], platform: 'linux', osHome, env: {} });
  const byName = serviceInputForHome({ home: osHome, command: [ENTRY], platform: 'linux', osHome, env: {} });
  assert.ok(!byDefault.argv.includes('--home'));
  assert.ok(!byName.argv.includes('--home'));
  assert.equal(byName.stateDir, byDefault.stateDir);
  const elsewhere = serviceInputForHome({ home: join(osHome, 'x'), command: [ENTRY], platform: 'linux', osHome, env: {} });
  assert.deepEqual(elsewhere.argv.slice(-2), ['--home', join(osHome, 'x')]);
});
