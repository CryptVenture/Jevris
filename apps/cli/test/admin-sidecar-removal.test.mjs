import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// IPC-16: jevris doctor shows the sidecar facts. IPC-17: jevris uninstall and jevris data delete
// stop the sidecar before removing anything. The service unit is one per OS account, so it is
// removed only for the account's own home; every service manager call here is a stand-in, and
// HOME points at a temporary folder, never the real one.

const { runAdminCommand } = await import('../dist/admin-cli.js');
const { main } = await import('../dist/cli.js');
const { runRuntimeCommand, sidecarDoctorView } = await import('../dist/runtime-commands.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');
const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');

async function admin(argv, hooks = {}) {
  let text = '';
  const code = await runAdminCommand(argv, (chunk) => (text += chunk), { isTTY: false, ...hooks });
  return { code, text };
}

test('doctor shows the sidecar; uninstall and data delete stop it first, and remove the service unit only for the account home (IPC-16, IPC-17)', { skip: managedHostSkip() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'f-sidecar-removal-')));
  const home = join(dir, 'home');
  const account = join(dir, 'account');
  mkdirSync(home);
  mkdirSync(account);
  const saved = { entry: process.env.JEVRIS_SIDECAR_ENTRY, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  // Any service unit path lands under the temporary OS home, never the real one. The OS home is
  // the folder $HOME and %USERPROFILE% name, and the account's default folders come from the XDG
  // and AppData variables, so all of them point at the temporary account.
  const asAccount = (folder) => {
    process.env.HOME = folder;
    process.env.USERPROFILE = folder;
    process.env.APPDATA = join(folder, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = join(folder, 'AppData', 'Local');
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) delete process.env[name];
  };
  asAccount(account);
  const calls = [];
  let taskXml = '';
  const serviceExec = (file, args) => (calls.push([file.split(/[\\/]/).at(-1), ...args]), { status: 0, stdout: args.includes('/XML') ? taskXml : '', stderr: '' });
  try {
    const idle = await admin(['doctor', '--home', home, '--json']);
    assert.equal(JSON.parse(idle.text).sidecar.state, 'idle', idle.text);
    assert.match((await admin(['doctor', '--home', home])).text, /^sidecar: idle; kill switch clear\. .*starts on demand/m);

    assert.equal(await main(['sidecar', 'start', '--home', home], () => {}), 0);
    const running = JSON.parse((await admin(['doctor', '--home', home, '--json'])).text).sidecar;
    assert.equal(running.state, 'running', JSON.stringify(running));
    assert.equal(typeof running.pid, 'number');
    assert.match((await admin(['doctor', '--home', home])).text, /^sidecar: running; pid \d+, version \S+, up \d+ s, endpoint \S.*; store ok; kill switch clear$/m);

    // Uninstall of a home that is not the account's own: the sidecar stops, the unit is left alone.
    const removed = await admin(['uninstall', '--home', home], { serviceExec });
    assert.equal(removed.code, 0, removed.text);
    assert.equal((await sidecarDoctorView(home)).state, 'idle');
    assert.deepEqual(calls, [], 'no service manager call for another home');
    assert.match(removed.text, /jevris service uninstall --home/);

    // Data delete of the account's own home: the unit is removed, then the sidecar stops, then the data goes.
    // The Jevris home is now the account's own home, so its unit has no --home and lives in the default layout.
    asAccount(home);
    assert.equal(await main(['sidecar', 'start', '--home', home], () => {}), 0);
    assert.equal((await sidecarDoctorView(home)).state, 'running');
    // A unit for this home is installed first (the service manager is faked), so every OS has
    // one to remove, with or without a systemd user session.
    let installOut = '';
    assert.equal(await runRuntimeCommand(['service', 'install', '--home', home, '--json'], (chunk) => (installOut += chunk), { serviceExec }), 0, installOut);
    const unitPath = JSON.parse(installOut).unitPath;
    assert.ok(unitPath.startsWith(home), 'the unit is under the temporary OS home');
    if (process.platform === 'win32') taskXml = readFileSync(unitPath).subarray(2).toString('utf16le');
    calls.length = 0;
    const data = jevrisPaths({ home }).data;
    writeFileSync(join(data, 'marker.txt'), 'x');
    const deleted = await admin(['data', 'delete', '--home', home, '--json'], { serviceExec });
    assert.equal(deleted.code, 0, deleted.text);
    assert.equal(JSON.parse(deleted.text).ok, true);
    assert.equal((await sidecarDoctorView(home)).state, 'idle');
    assert.equal(existsSync(data), false);
    if (['darwin', 'linux', 'win32'].includes(process.platform)) {
      assert.ok(calls.length >= 1, 'the service manager was asked to remove the unit');
      if (process.platform !== 'win32') assert.equal(existsSync(unitPath), false, 'the unit file is gone');
    }
  } finally {
    await main(['sidecar', 'stop', '--home', home], () => {});
    for (const [name, value] of [['JEVRIS_SIDECAR_ENTRY', saved.entry], ['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['APPDATA', saved.APPDATA], ['LOCALAPPDATA', saved.LOCALAPPDATA], ['XDG_CONFIG_HOME', saved.XDG_CONFIG_HOME], ['XDG_DATA_HOME', saved.XDG_DATA_HOME], ['XDG_STATE_HOME', saved.XDG_STATE_HOME]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
