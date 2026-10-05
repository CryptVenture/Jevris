// JEV-0073: `jevris sidecar restart` beside a service-run sidecar that is alive but does not answer. JEV-0045 made `start` refuse (SERVICE_START_REFUSED or
// SERVICE_UNREACHABLE, naming the pid, `jevris service status` and `jevris sidecar restart`, exit 1, nothing started beside it), but `restart` first asked
// the silent sidecar to stop: the request cannot be delivered, so the stop became a SIGTERM that its shutdown guard (a verification run it is finishing)
// never sees, and only then was the manager asked. With a manager that refused the start the sidecar was signalled and the command ended with "did not
// stop. Stop that process by hand" instead of the refusal. Now the manager is asked first, as `start` asks it, and a refusal leaves the sidecar alone.
//
// The scene is the one the E2E bench builds: a live dummy process (a real child of this test) that an endpoint file names as the service's sidecar, with a
// socket nobody listens on, read by the product's own probe, and the product's own stop (a real signal to a real pid). The service manager is a stand-in
// in each state: it refuses the start, it cannot be reached, or it accepts the start and brings nothing up. HOME points at a temporary folder (the unit file
// lands there, never in the real home) and no sidecar is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { runRuntimeCommand } = await import('../dist/runtime-commands.js');
const sidecar = await import('@jevris/sidecar');

const SUPPORTED = ['darwin', 'linux', 'win32'].includes(process.platform);
const SKIP = { skip: managedHostSkip() || !SUPPORTED };

/** True for the one call that asks the service manager to start the unit (never a forced kill). */
function isStart(args) {
  if (process.platform === 'darwin') return args[0] === 'kickstart' && !args.includes('-k');
  if (process.platform === 'linux') return args.join(' ') === '--user start jevris-sidecar.service';
  return args[0] === '/Run';
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until a state holds (polls, never a guessed sleep); false when it did not within the bound. */
async function until(check, boundMs = 30_000) {
  const end = Date.now() + boundMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

async function withScene(body) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jvr-silr-')));
  const home = join(dir, 'home');
  const account = join(dir, 'account');
  mkdirSync(home);
  mkdirSync(account);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = account;
  process.env.USERPROFILE = account;
  const dummies = [];
  /** A live process the endpoint file names as the service's sidecar: it does nothing, and a signal ends it. */
  const silentSidecar = async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("up\\n");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    dummies.push(child);
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const files = sidecar.runtimeFiles({ home });
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\jevris-test-silent-${String(child.pid)}` : join(files.dir, 'nobody.sock');
    writeFileSync(files.endpoint, JSON.stringify({ schemaVersion: 'jevris-sidecar-endpoint-1', protocol: 1, version: '0.1.0', pid: child.pid, bootId: 'bootsilent', endpoint, startedAtMs: Date.now(), supervised: true }), { mode: 0o600 });
    return child.pid;
  };
  try {
    return await body({ home, silentSidecar });
  } finally {
    for (const child of dummies) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(argv, hooks) {
  let text = '';
  const code = await runRuntimeCommand(argv, (chunk) => (text += chunk), hooks);
  return { code, text };
}

/** The manager states: `refuses` (answers, and the start fails), `down` (cannot be reached) and `accepts` (the start succeeds, and nothing comes up). */
function stage(taskXml, manager) {
  const events = [];
  const serviceExec = (_file, args) => {
    events.push(`exec ${args.join(' ')}`);
    if (manager === 'down') return { status: 1, stdout: '', stderr: 'unreachable' };
    if (process.platform === 'win32' && args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: taskXml, stderr: '' };
    if (isStart(args) && manager === 'refuses') return { status: 1, stdout: '', stderr: 'refused' };
    return { status: 0, stdout: '', stderr: '' };
  };
  // Only the on-demand start is a stand-in (it must never run); the probe and the stop are the product's own.
  const ensureSidecar = async () => {
    events.push('ensure');
    return { ok: true, started: true };
  };
  return { events, hooks: { serviceExec, sidecar: { ensureSidecar } } };
}

async function installUnit(home) {
  const hooks = { serviceExec: () => ({ status: 0, stdout: '', stderr: '' }), sidecar: { probeSidecar: async () => ({ running: false, reachable: false, endpoint: undefined }) } };
  const installed = await run(['service', 'install', '--home', home, '--json'], hooks);
  assert.equal(installed.code, 0, installed.text);
  const unitPath = JSON.parse(installed.text).unitPath;
  return process.platform === 'win32' ? readFileSync(unitPath).subarray(2).toString('utf16le') : '';
}

const starts = (events) => events.filter((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' '))).length;
const SENTENCE = (code, pid) => new RegExp(`\\(${code}\\), and the sidecar the service runs \\(pid ${String(pid)}\\) is alive but did not answer, so no second sidecar was started\\.`);

for (const [manager, code] of [['refuses', 'SERVICE_START_REFUSED'], ['down', 'SERVICE_UNREACHABLE']]) {
  test(`${manager === 'refuses' ? 'a manager that refuses the start' : 'a manager that cannot be reached'}: start and restart give ${code}, naming the pid and the two commands, and the silent sidecar is never signalled`, SKIP, async () => {
    await withScene(async ({ home, silentSidecar }) => {
      const xml = await installUnit(home);
      const pid = await silentSidecar();
      const answers = {};
      for (const verb of ['start', 'restart']) {
        const s = stage(xml, manager);
        const result = await run(['sidecar', verb, '--home', home, '--wait-ms', '60000'], s.hooks);
        assert.equal(result.code, 1, `${verb}: ${result.text}`);
        assert.match(result.text, SENTENCE(code, pid), `${verb}: ${result.text}`);
        assert.match(result.text, /`jevris service status`, then `jevris sidecar restart`/, verb);
        assert.equal(result.text.includes('did not stop'), false, `${verb} asked the sidecar to stop: ${result.text}`);
        assert.equal(result.text.includes('Stop that process by hand'), false, `${verb}: ${result.text}`);
        assert.ok(!s.events.includes('ensure'), `${verb} started an unsupervised sidecar beside the service's: ${s.events.join(' | ')}`);
        assert.equal(alive(pid), true, `${verb} signalled the service's sidecar`);
        assert.equal(JSON.parse(readFileSync(sidecar.runtimeFiles({ home }).endpoint, 'utf8')).pid, pid, `${verb} replaced the endpoint`);
        answers[verb] = result.text.replace(/ Nothing was stopped\./, '');
      }
      assert.equal(answers.restart, answers.start, 'restart and start give one sentence; restart adds only that nothing was stopped');
    });
  });
}

// The wait is the subject here: the manager said yes and nothing answers, so each command waits its --wait-ms (10 s, the floor of lint/slow-ci.lint.mjs) and ends.
test('a manager that accepts the start and brings nothing up: start and restart agree (SERVICE_START_TIMEOUT, exit 1, nothing spawned beside the service); the restart stopped the sidecar only after the manager took the start', SKIP, async () => {
  await withScene(async ({ home, silentSidecar }) => {
    const xml = await installUnit(home);
    const pid = await silentSidecar();
    const start = stage(xml, 'accepts');
    const started = await run(['sidecar', 'start', '--home', home, '--wait-ms', '10000'], start.hooks);
    assert.equal(started.code, 1, started.text);
    assert.match(started.text, /\(SERVICE_START_TIMEOUT\)/);
    assert.equal(alive(pid), true, 'start signalled the service\'s sidecar');
    assert.ok(!start.events.includes('ensure'));
    const restart = stage(xml, 'accepts');
    const restarted = await run(['sidecar', 'restart', '--home', home, '--wait-ms', '10000'], restart.hooks);
    assert.equal(restarted.code, 1, restarted.text);
    assert.match(restarted.text, /\(SERVICE_START_TIMEOUT\)/);
    assert.ok(!restart.events.includes('ensure'), 'no unsupervised sidecar takes its place');
    assert.equal(starts(restart.events), 2, `the manager was asked before the stop, and again after it: ${restart.events.join(' | ')}`);
    assert.equal(await until(() => !alive(pid)), true, 'the manager took the start, so the silent sidecar was then stopped');
  });
});

test('restart --force orders the stop anyway: no question to the manager first, the sidecar is stopped, and a manager that then refuses is SERVICE_START_FAILED', SKIP, async () => {
  await withScene(async ({ home, silentSidecar }) => {
    const xml = await installUnit(home);
    const pid = await silentSidecar();
    const s = stage(xml, 'refuses');
    const result = await run(['sidecar', 'restart', '--force', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /\(SERVICE_START_FAILED/);
    assert.match(result.text, /The sidecar was stopped, but/);
    assert.equal(starts(s.events), 1, `no probe before a forced stop: ${s.events.join(' | ')}`);
    assert.equal(await until(() => !alive(pid)), true, 'the forced restart ended the silent sidecar');
    assert.ok(!s.events.includes('ensure'));
  });
});

test('the sidecar that answers is unchanged: a restart of an answering supervised sidecar is not asked of the manager before the stop', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    const s = stage(xml, 'accepts');
    const events = s.events;
    let answering = true;
    const hooks = {
      ...s.hooks,
      sidecar: {
        ...s.hooks.sidecar,
        probeSidecar: async () => (answering ? { running: true, reachable: true, endpoint: { pid: 4242, supervised: true } } : { running: true, reachable: true, endpoint: { pid: 4343, supervised: true } }),
        stopSidecarProcess: async () => {
          events.push('stop');
          answering = false;
          return { stopped: true, method: 'shutdown-frame', pid: 4242 };
        },
      },
    };
    const result = await run(['sidecar', 'restart', '--home', home, '--wait-ms', '60000'], hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(restarted by /);
    const order = events.filter((event) => event === 'stop' || (event.startsWith('exec ') && isStart(event.slice(5).split(' '))));
    assert.deepEqual(order.map((event) => (event === 'stop' ? 'stop' : 'start')), ['stop', 'start'], `an answering sidecar is stopped first and the manager is asked once: ${events.join(' | ')}`);
  });
});
