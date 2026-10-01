// `jevris sidecar restart|stop|start` and `jevris service install` with a service-supervised
// sidecar. A supervised sidecar that is stopped cleanly is not restarted by its manager (launchd
// SuccessfulExit false, systemd Restart=on-failure), so a restart that stopped it and then
// spawned an unsupervised one left the service dead and supervision silently lost. Now the
// restart stops it cleanly and asks its own service manager to start it, and never spawns one.
//
// Every service manager call and every sidecar probe, stop and start here is a stand-in that
// records its calls. HOME points at a temporary folder (the unit file lands there, never in the
// real home) and no sidecar process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { runRuntimeCommand } = await import('../dist/runtime-commands.js');

const SUPPORTED = ['darwin', 'linux', 'win32'].includes(process.platform);

/** True for the one call that asks the service manager to start the unit (never a forced kill). */
function isStart(args) {
  if (process.platform === 'darwin') return args[0] === 'kickstart' && !args.includes('-k');
  if (process.platform === 'linux') return args.join(' ') === '--user start jevris-sidecar.service';
  return args[0] === '/Run';
}

async function withScene(run) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jvr-sup-')));
  const home = join(dir, 'home');
  const account = join(dir, 'account');
  mkdirSync(home);
  mkdirSync(account);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = account;
  process.env.USERPROFILE = account;
  try {
    return await run({ home });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stand-in service manager and sidecar. `running` is the sidecar's state: a stop clears it and
 * the manager's start sets it, so a restart is observed end to end. `events` is the call order.
 */
function scene(options = {}) {
  const events = [];
  const state = { running: options.running ?? true, supervised: options.supervised ?? true, taskXml: '' };
  const managerUp = options.managerUp ?? true;
  const serviceExec = (file, args) => {
    events.push(`exec ${args.join(' ')}`);
    if (!managerUp) return { status: 1, stdout: '', stderr: 'unreachable' };
    if (process.platform === 'win32' && args[0] === '/Create') return { status: 0, stdout: '', stderr: '' };
    if (process.platform === 'win32' && args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: state.taskXml, stderr: '' };
    if (isStart(args)) state.running = true;
    return { status: 0, stdout: '', stderr: '' };
  };
  const ports = {
    probeSidecar: async () => ({ running: state.running, reachable: state.running, endpoint: state.running ? { pid: 4242, supervised: state.supervised } : undefined }),
    stopSidecarProcess: async () => {
      events.push('stop');
      const was = state.running;
      state.running = false;
      return was ? { stopped: true, method: 'shutdown-frame', pid: 4242 } : { stopped: true, method: 'not-running' };
    },
    ensureSidecar: async () => {
      events.push('ensure');
      state.running = true;
      return { ok: true, started: true };
    },
  };
  return { events, state, hooks: { serviceExec, sidecar: ports } };
}

async function run(argv, hooks) {
  let text = '';
  const code = await runRuntimeCommand(argv, (chunk) => (text += chunk), hooks);
  return { code, text };
}

/** Installs the unit for `home` through the stand-in manager, so the unit file exists. */
async function install(home, s) {
  const saved = s.state.running;
  s.state.running = false;
  const installed = await run(['service', 'install', '--home', home, '--json'], s.hooks);
  assert.equal(installed.code, 0, installed.text);
  const unitPath = JSON.parse(installed.text).unitPath;
  if (process.platform === 'win32') s.state.taskXml = readFileSync(unitPath).subarray(2).toString('utf16le');
  s.state.running = saved;
  s.events.length = 0;
}

test('restart of a supervised sidecar stops it cleanly and starts it through its service manager, never an unsupervised one', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene();
    await install(home, s);
    const result = await run(['sidecar', 'restart', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(restarted by /);
    assert.ok(!s.events.includes('ensure'), `no unsupervised sidecar is spawned: ${s.events.join(' | ')}`);
    const stopAt = s.events.indexOf('stop');
    const startAt = s.events.findIndex((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' ')));
    assert.ok(stopAt >= 0 && startAt > stopAt, `the clean stop comes first, then the manager start: ${s.events.join(' | ')}`);
    assert.equal(s.events.filter((event) => event === 'stop').length, 1);
    assert.ok(!s.events.some((event) => / -k /.test(` ${event} `)), 'no forced kill');
  });
});

test('restart of a supervised sidecar refuses when the service manager cannot be reached, and stops nothing', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene();
    await install(home, s);
    const down = scene({ managerUp: false });
    const result = await run(['sidecar', 'restart', '--home', home], down.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /SERVICE_UNREACHABLE/);
    assert.match(result.text, /jevris service install/);
    assert.match(result.text, /Nothing was stopped/);
    assert.ok(!down.events.includes('stop'), `the running sidecar is left alone: ${down.events.join(' | ')}`);
    assert.ok(!down.events.includes('ensure'));
    assert.ok(!down.events.some((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' '))));
    assert.equal(down.state.running, true);
  });
});

test('restart of a supervised sidecar with no service installed for this home refuses too', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene();
    const result = await run(['sidecar', 'restart', '--home', home], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /SERVICE_UNREACHABLE/);
    assert.ok(!s.events.includes('stop'));
    assert.ok(!s.events.includes('ensure'));
  });
});

test('restart of an on-demand sidecar with a service installed hands it over: stop, then the service manager starts the supervised one, no on-demand spawn', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ supervised: false });
    await install(home, s);
    const result = await run(['sidecar', 'restart', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(restarted by /);
    assert.ok(!s.events.includes('ensure'), `no second, unsupervised sidecar is spawned: ${s.events.join(' | ')}`);
    const stopAt = s.events.indexOf('stop');
    const startAt = s.events.findIndex((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' ')));
    assert.ok(stopAt >= 0 && startAt > stopAt, `the clean stop comes first, then the manager start: ${s.events.join(' | ')}`);
  });
});

test('restart of an on-demand sidecar with a service whose manager does not answer falls back to an on-demand start', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ supervised: false });
    await install(home, s);
    const down = scene({ supervised: false, managerUp: false });
    const result = await run(['sidecar', 'restart', '--home', home], down.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(started\)/);
    assert.deepEqual(down.events.filter((event) => !event.startsWith('exec ')), ['stop', 'ensure']);
  });
});

test('restart of an unsupervised sidecar with no service installed is unchanged: stop, then start it on demand, no service manager start', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ supervised: false });
    const result = await run(['sidecar', 'restart', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(started\)/);
    assert.deepEqual(
      s.events.filter((event) => !event.startsWith('exec ')),
      ['stop', 'ensure'],
    );
    assert.ok(!s.events.some((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' '))), `no service manager start: ${s.events.join(' | ')}`);
  });
});

test('stop of a supervised sidecar stops it cleanly and says the service does not restart it', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene();
    await install(home, s);
    const result = await run(['sidecar', 'stop', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: stopped \(pid 4242\)/);
    assert.match(result.text, /does not restart a clean stop/);
    assert.match(result.text, /jevris sidecar start/);
    assert.deepEqual(s.events, ['stop']);
  });
});

test('start with nothing running starts the installed service through its manager, not an unsupervised sidecar', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ running: false });
    await install(home, s);
    const result = await run(['sidecar', 'start', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(started by /);
    assert.ok(!s.events.includes('ensure'), s.events.join(' | '));
    assert.ok(s.events.some((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' '))));
  });
});

test('start with no service for this home starts it on demand, as before', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ running: false });
    const result = await run(['sidecar', 'start', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(started\)/);
    assert.ok(s.events.includes('ensure'));
    assert.ok(!s.events.some((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' '))));
  });
});

test('start with a service whose manager does not answer falls back to an on-demand start', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ running: false });
    await install(home, s);
    const down = scene({ running: false, managerUp: false });
    const result = await run(['sidecar', 'start', '--home', home], down.hooks);
    assert.equal(result.code, 0, result.text);
    assert.ok(down.events.includes('ensure'));
  });
});

test('service install stops a running sidecar cleanly first, so the manager starts the new one (systemd and Task Scheduler leave a running unit alone)', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene();
    const result = await run(['service', 'install', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: stopped \(pid 4242\) so the service can start it/);
    const stopAt = s.events.indexOf('stop');
    const firstExec = s.events.findIndex((event) => event.startsWith('exec '));
    assert.ok(stopAt === 0 && firstExec > stopAt, `the clean stop comes before any manager call: ${s.events.join(' | ')}`);
    assert.ok(!s.events.includes('ensure'));
  });
});

test('service install asks a running on-demand sidecar to finish and exit first, so the service starts the one sidecar, and says so in one line', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ supervised: false });
    const result = await run(['service', 'install', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /^sidecar: stopped the on-demand sidecar \(pid 4242\) so the service can start its own$/m);
    const stopAt = s.events.indexOf('stop');
    const firstExec = s.events.findIndex((event) => event.startsWith('exec '));
    assert.ok(stopAt === 0 && firstExec > stopAt, `the clean stop comes before any manager call: ${s.events.join(' | ')}`);
    assert.ok(!s.events.includes('ensure'), 'nothing is spawned on demand');
    const json = await run(['service', 'install', '--home', home, '--json'], scene({ supervised: false }).hooks);
    assert.equal(json.code, 0, json.text);
    assert.match(JSON.parse(json.text).sidecar, /^sidecar: stopped the on-demand sidecar \(pid 4242\)/, 'the json carries the same line');
  });
});

test('service install leaves an on-demand sidecar that will not stop alone, installs the unit, and says so (no kill)', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ supervised: false });
    const asked = [];
    s.hooks.sidecar.stopSidecarProcess = async (_home, timeoutMs) => {
      s.events.push('stop');
      asked.push(timeoutMs);
      return { stopped: false, method: 'failed', pid: 4242 };
    };
    const result = await run(['service', 'install', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /^sidecar: the on-demand sidecar \(pid 4242\) did not stop within 15 s and was left running \(nothing was killed\); it is not under the service yet\. Run `jevris sidecar restart` to hand it over\.$/m);
    assert.match(result.text, /service: installed/);
    assert.deepEqual(asked, [15_000], 'a generous bound, asked once');
    assert.equal(s.state.running, true, 'the sidecar is left running');
    assert.ok(!s.events.includes('ensure'));
  });
});

test('service install leaves an on-demand sidecar that is finishing a verification run alone, and installs the unit', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ supervised: false });
    s.hooks.sidecar.sidecarRequest = async () => ({ ok: true, result: { verificationRuns: 2 } });
    const result = await run(['service', 'install', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /^sidecar: the on-demand sidecar \(pid 4242\) is finishing 2 verification runs and was left running; it is not under the service yet\./m);
    assert.ok(!s.events.includes('stop'), `a run is never cut off: ${s.events.join(' | ')}`);
    assert.equal(s.state.running, true);
    assert.match(result.text, /service: installed/);
  });
});

test('service install with nothing running stops nothing; with --json it prints only the result', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene({ running: false });
    const result = await run(['service', 'install', '--home', home, '--json'], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.equal(JSON.parse(result.text).state, 'installed');
    assert.ok(!s.events.includes('stop'));
    const running = scene();
    const json = await run(['service', 'install', '--home', home, '--json'], running.hooks);
    assert.equal(json.code, 0, json.text);
    assert.equal(JSON.parse(json.text).state, 'installed', 'json stays a single object');
    assert.ok(running.events.includes('stop'));
  });
});

test('service install does not change the service when the running sidecar will not stop', { skip: managedHostSkip() || !SUPPORTED }, async () => {
  await withScene(async ({ home }) => {
    const s = scene();
    s.hooks.sidecar.stopSidecarProcess = async () => {
      s.events.push('stop');
      return { stopped: false, method: 'failed', pid: 4242 };
    };
    const result = await run(['service', 'install', '--home', home], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /did not stop, so the service was not changed/);
    assert.deepEqual(s.events, ['stop']);
  });
});
