// JEV-0045: a service is installed and the sidecar it runs is alive but does not answer. A hook, a
// command and an MCP call start nothing beside it (CHANGELOG, the F3-04 rule: the failure carries
// SERVICE_START_REFUSED or SERVICE_UNREACHABLE). `jevris sidecar start` asked the manager first, but when
// the manager refused it fell back to an on-demand start that skipped the "service sidecar alive" check, so
// it put an unsupervised sidecar beside the service's. `jevris sidecar restart` of a silent service-run
// sidecar did the same after it had stopped it. Both now apply the same rule. (JEV-0073 then made restart
// ask the manager before it stops the silent sidecar: apps/cli/test/sidecar-service-silent-restart.test.mjs.)
//
// The service manager, the sidecar stop and the on-demand start are stand-ins that record what they are
// asked; the "alive but silent" sidecar is a real endpoint file that names this test process (alive) and
// a socket nobody listens on, read by the product's own probe. HOME points at a temporary folder (the unit
// file lands there, never in the real home) and no sidecar process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { runRuntimeCommand } = await import('../dist/runtime-commands.js');
const sidecar = await import('@jevris/sidecar');

const SUPPORTED = ['darwin', 'linux', 'win32'].includes(process.platform);

/** True for the one call that asks the service manager to start the unit (never a forced kill). */
function isStart(args) {
  if (process.platform === 'darwin') return args[0] === 'kickstart' && !args.includes('-k');
  if (process.platform === 'linux') return args.join(' ') === '--user start jevris-sidecar.service';
  return args[0] === '/Run';
}

async function withScene(run) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jvr-sil-')));
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

async function run(argv, hooks) {
  let text = '';
  const code = await runRuntimeCommand(argv, (chunk) => (text += chunk), hooks);
  return { code, text };
}

/** Installs the unit for `home` through a stand-in manager that says yes, and returns what Windows' task query must answer. */
async function installUnit(home) {
  const hooks = {
    serviceExec: () => ({ status: 0, stdout: '', stderr: '' }),
    sidecar: { probeSidecar: async () => ({ running: false, reachable: false, endpoint: undefined }) },
  };
  const installed = await run(['service', 'install', '--home', home, '--json'], hooks);
  assert.equal(installed.code, 0, installed.text);
  const unitPath = JSON.parse(installed.text).unitPath;
  return process.platform === 'win32' ? readFileSync(unitPath).subarray(2).toString('utf16le') : '';
}

/** An endpoint file for a sidecar that is "alive" (this process) with nothing listening: alive but not answering. */
function writeSilentEndpoint(home, supervised) {
  const files = sidecar.runtimeFiles({ home });
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\jevris-test-silent-${process.pid}` : join(files.dir, 'nobody.sock');
  writeFileSync(files.endpoint, JSON.stringify({ schemaVersion: 'jevris-sidecar-endpoint-1', protocol: 1, version: '0.1.0', pid: process.pid, bootId: 'bootsilent', endpoint, startedAtMs: Date.now(), supervised }), { mode: 0o600 });
}

/**
 * The stand-ins and what they were asked. `manager`: `up` (it answers and starts the unit), `refuses` (it answers, and the start
 * command fails) or `down` (it cannot be reached). The stop and the on-demand start only record the call.
 */
function stage(home, taskXml, manager) {
  const events = [];
  const state = { started: false };
  const serviceExec = (_file, args) => {
    events.push(`exec ${args.join(' ')}`);
    if (manager === 'down') return { status: 1, stdout: '', stderr: 'unreachable' };
    if (process.platform === 'win32' && args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: taskXml, stderr: '' };
    if (isStart(args)) {
      if (manager === 'refuses') return { status: 1, stdout: '', stderr: 'refused' };
      state.started = true;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const ports = {
    // The real probe and the real endpoint read: the silent sidecar is found the way the product finds it. After the manager's
    // start the sidecar answers, as the unit's does.
    probeSidecar: async (h, timeoutMs) => (state.started ? { running: true, reachable: true, endpoint: { pid: 4242, supervised: true } } : sidecar.probeSidecar(h, timeoutMs)),
    stopSidecarProcess: async () => {
      events.push('stop');
      return { stopped: true, method: 'signal', pid: process.pid };
    },
    ensureSidecar: async () => {
      events.push('ensure');
      return { ok: true, started: true };
    },
  };
  return { events, hooks: { serviceExec, sidecar: ports } };
}

const startedByManager = (events) => events.some((event) => event.startsWith('exec ') && isStart(event.slice(5).split(' ')));

const SKIP = { skip: managedHostSkip() || !SUPPORTED };

test('start: the manager refuses while the service\'s sidecar is alive but silent: nothing is started beside it, and the failure says why', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    writeSilentEndpoint(home, true);
    const s = stage(home, xml, 'refuses');
    const result = await run(['sidecar', 'start', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /\(SERVICE_START_REFUSED\)/);
    assert.match(result.text, new RegExp(`pid ${process.pid}\\b`));
    assert.match(result.text, /alive but did not answer, so no second sidecar was started/);
    assert.match(result.text, /jevris service status.*jevris sidecar restart/);
    assert.ok(!s.events.includes('ensure'), `no on-demand sidecar is started beside the service's: ${s.events.join(' | ')}`);
    assert.ok(!s.events.includes('stop'));
  });
});

test('start: the manager cannot be reached while the service\'s sidecar is alive but silent: SERVICE_UNREACHABLE, and nothing is started', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    writeSilentEndpoint(home, true);
    const s = stage(home, xml, 'down');
    const result = await run(['sidecar', 'start', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /\(SERVICE_UNREACHABLE\)/);
    assert.match(result.text, /could not be reached to start/);
    assert.ok(!s.events.includes('ensure'), s.events.join(' | '));
  });
});

test('start, the pairs: a refusing manager with nothing alive, or with an alive sidecar that is not the service\'s, still starts one on demand', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    const none = stage(home, xml, 'refuses');
    const first = await run(['sidecar', 'start', '--home', home], none.hooks);
    assert.equal(first.code, 0, first.text);
    assert.match(first.text, /sidecar: running \(started\)/);
    assert.equal(none.events.filter((event) => event === 'ensure').length, 1, 'nothing alive: the on-demand start runs');
    writeSilentEndpoint(home, false);
    const onDemand = stage(home, xml, 'refuses');
    const second = await run(['sidecar', 'start', '--home', home], onDemand.hooks);
    assert.equal(second.code, 0, second.text);
    assert.equal(onDemand.events.filter((event) => event === 'ensure').length, 1, 'an unsupervised endpoint that does not answer is not the service\'s: the fallback may start');
  });
});

test('start, with no service installed for the home, is unchanged even with a silent supervised endpoint on disk', SKIP, async () => {
  await withScene(async ({ home }) => {
    writeSilentEndpoint(home, true);
    const s = stage(home, '', 'refuses');
    const result = await run(['sidecar', 'start', '--home', home], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.ok(s.events.includes('ensure'), 'no unit for this home: nothing of the service\'s is in the way, as before');
  });
});

test('every surface agrees: a hook, a command and an MCP call (ensureSidecar) and `sidecar start` refuse with the same code and spawn nothing', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    writeSilentEndpoint(home, true);
    const spawns = [];
    const refused = await sidecar.ensureSidecar({ home, waitMs: 0 }, { service: { run: () => ({ status: 1 }) }, spawn: (options) => (spawns.push(options), true) });
    assert.deepEqual([refused.ok, refused.reason, refused.reasonCode], [false, 'unavailable', 'SERVICE_START_REFUSED']);
    const unreachable = await sidecar.ensureSidecar({ home, waitMs: 0 }, { service: { run: () => ({ status: null, error: 'ENOENT' }) }, spawn: (options) => (spawns.push(options), true) });
    assert.equal(unreachable.reasonCode, 'SERVICE_UNREACHABLE');
    assert.deepEqual(spawns, [], 'the shared start path spawned nothing');
    const refusing = stage(home, xml, 'refuses');
    const command = await run(['sidecar', 'start', '--home', home], refusing.hooks);
    assert.match(command.text, new RegExp(`\\(${refused.reasonCode}\\)`), 'the explicit start gives the code the hook and the command give');
    assert.ok(!refusing.events.includes('ensure'));
  });
});

test('restart of a silent service-run sidecar refuses when the manager cannot be reached, and stops nothing', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    writeSilentEndpoint(home, true);
    const s = stage(home, xml, 'down');
    const result = await run(['sidecar', 'restart', '--home', home], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /SERVICE_UNREACHABLE/);
    assert.match(result.text, /Nothing was stopped/);
    assert.ok(!s.events.includes('stop'), `the service's sidecar is left alone: ${s.events.join(' | ')}`);
    assert.ok(!s.events.includes('ensure'), 'and no unsupervised one is started');
    assert.ok(!startedByManager(s.events));
  });
});

test('restart of a silent service-run sidecar stops it, starts it through the manager, and never spawns an unsupervised one', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    writeSilentEndpoint(home, true);
    const s = stage(home, xml, 'up');
    const result = await run(['sidecar', 'restart', '--home', home, '--wait-ms', '60000'], s.hooks);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /sidecar: running \(restarted by /);
    assert.deepEqual(s.events.filter((event) => !event.startsWith('exec ')), ['stop']);
    assert.ok(startedByManager(s.events), 'the manager starts the one that replaces it');
    assert.ok(!s.events.includes('ensure'));
  });
});

test('restart of a silent service-run sidecar whose manager refuses the start gives start\'s refusal, stops nothing and spawns nothing (JEV-0073)', SKIP, async () => {
  await withScene(async ({ home }) => {
    const xml = await installUnit(home);
    writeSilentEndpoint(home, true);
    const s = stage(home, xml, 'refuses');
    const result = await run(['sidecar', 'restart', '--home', home], s.hooks);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /\(SERVICE_START_REFUSED\)/);
    assert.match(result.text, new RegExp(`pid ${process.pid}\\b`));
    assert.ok(!s.events.includes('stop'), `the service's sidecar is not asked to stop: ${s.events.join(' | ')}`);
    assert.ok(!s.events.includes('ensure'), `no unsupervised sidecar takes its place: ${s.events.join(' | ')}`);
  });
});
