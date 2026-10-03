import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// IPC-20: `jevris service install|uninstall|status` generates a LaunchAgent (macOS), a systemd
// user unit (Linux) and a per-user Scheduled Task (Windows). The units are golden-tested; each
// restarts the sidecar on a crash and not after a clean stop. The service managers are faked
// here; live restart-on-crash runs on real machines (external).

const su = await import('../dist/service-units.js');
const golden = (name) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');

const POSIX_INPUT = { osHome: '/home/dev', stateDir: '/home/dev/.local/state/jevris', argv: ['/usr/local/bin/node', '/opt/jevris/dist/sidecar.mjs', '--supervised', '--home', '/home/dev/My Jevris "home" $x %y'], uid: 501, env: {} };
const WIN_INPUT = {
  platform: 'win32',
  osHome: 'C:\\Users\\dev',
  stateDir: 'C:\\Users\\dev\\AppData\\Local\\Jevris\\state',
  argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@webventures\\jevris\\dist\\sidecar.mjs', '--supervised', '--home', 'C:\\Users\\dev\\Jevris Home\\'],
  windowsUser: 'DEVBOX\\dev',
  env: {},
};

test('the generated units match their golden files (IPC-20)', () => {
  assert.equal(su.launchAgentPlist({ ...POSIX_INPUT, platform: 'darwin', stateDir: '/Users/dev/.jevris' }), golden('dev.jevris.sidecar.plist'));
  assert.equal(su.systemdUnit({ ...POSIX_INPUT, platform: 'linux' }), golden('jevris-sidecar.service'));
  assert.equal(su.scheduledTaskXml(WIN_INPUT), golden('jevris-sidecar-task.xml'));
});

test('each unit restarts on a crash, not after a clean stop, and never idles out (IPC-20)', () => {
  const plist = golden('dev.jevris.sidecar.plist');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  const unit = golden('jevris-sidecar.service');
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  const task = golden('jevris-sidecar-task.xml');
  assert.match(task, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
  assert.match(task, /<LogonTrigger>/);
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  for (const text of [plist, unit, task]) assert.match(text, /--supervised/);
  // Special characters survive each format's quoting.
  assert.match(unit, /"\/home\/dev\/My Jevris \\"home\\" \$\$x %%y"/);
  assert.match(plist, /My Jevris &quot;home&quot; \$x %y/);
  assert.equal(su.windowsArg('C:\\Users\\dev\\Jevris Home\\'), '"C:\\Users\\dev\\Jevris Home\\\\"', 'a trailing backslash is doubled before the closing quote');
  assert.equal(su.windowsArg('plain'), 'plain');
  assert.equal(su.windowsArg('say "hi"'), '"say \\"hi\\""');
});

function fakeExec(answers = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file.split(/[\\/]/).at(-1), ...args]);
    const key = args.slice(0, 2).join(' ');
    const answer = answers[args.join(' ')] ?? answers[key] ?? { status: 0, stdout: '', stderr: '' };
    return typeof answer === 'function' ? answer() : answer;
  };
  return { exec, calls };
}

test('install, status and uninstall drive each service manager without a shell (IPC-20)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b-service-')));
  try {
    // macOS
    let fake = fakeExec({ 'print gui/501/dev.jevris.sidecar': { status: 0, stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' } });
    const mac = { ...POSIX_INPUT, platform: 'darwin', osHome: root, stateDir: join(root, 'state') };
    let result = su.installService(mac, fake.exec);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.unitPath, join(root, 'Library', 'LaunchAgents', 'dev.jevris.sidecar.plist'));
    assert.equal(readFileSync(result.unitPath, 'utf8'), su.launchAgentPlist(mac));
    assert.deepEqual(fake.calls, [
      ['launchctl', 'bootout', 'gui/501/dev.jevris.sidecar'],
      ['launchctl', 'bootstrap', 'gui/501', result.unitPath],
      ['launchctl', 'kickstart', 'gui/501/dev.jevris.sidecar'],
    ]);
    result = su.serviceStatus(mac, fake.exec);
    assert.deepEqual([result.state, result.pid], ['running', 4242]);
    result = su.uninstallService(mac, fake.exec);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.unitPath), false);

    // Linux: a systemd user session, then none (a container or CI).
    fake = fakeExec({ '--user show': { status: 0, stdout: 'ActiveState=active\nMainPID=77\n', stderr: '' } });
    const linux = { ...POSIX_INPUT, platform: 'linux', osHome: root, stateDir: join(root, 'state') };
    result = su.installService(linux, fake.exec);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.unitPath, join(root, '.config', 'systemd', 'user', 'jevris-sidecar.service'));
    assert.deepEqual(fake.calls, [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'jevris-sidecar.service'],
    ]);
    result = su.serviceStatus(linux, fake.exec);
    assert.deepEqual([result.state, result.pid], ['running', 77]);
    // Without a systemd user session, status still answers: the unit is there, its state unknown.
    result = su.serviceStatus(linux, fakeExec({ '--user show': { status: 1, stdout: '', stderr: 'Failed to connect to bus' } }).exec);
    assert.deepEqual([result.ok, result.state], [true, 'unknown']);
    assert.match(result.message, /starts on demand/);
    result = su.uninstallService(linux, fake.exec);
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(root, '.config', 'systemd', 'user', 'jevris-sidecar.service')), false);
    const noSession = fakeExec({ '--user daemon-reload': { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } });
    result = su.installService(linux, noSession.exec);
    assert.deepEqual([result.ok, result.state], [false, 'unsupported']);
    assert.match(result.message, /starts on demand/);
    su.uninstallService(linux, fakeExec().exec);

    // Windows: the task XML is written as UTF-16 with a BOM, then imported.
    const win = { ...WIN_INPUT, osHome: root, stateDir: join(root, 'state') };
    fake = fakeExec({
      '/Query /TN': { status: 0, stdout: 'TaskName: \\Jevris\\Sidecar\r\nStatus:   Running\r\n', stderr: '' },
      [`/Query /TN \\Jevris\\Sidecar /XML`]: () => ({ status: 0, stdout: su.scheduledTaskXml(win), stderr: '' }),
    });
    result = su.installService(win, fake.exec);
    assert.equal(result.ok, true, JSON.stringify(result));
    const bytes = readFileSync(result.unitPath);
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
    assert.equal(bytes.subarray(2).toString('utf16le'), su.scheduledTaskXml(win));
    assert.deepEqual(fake.calls, [
      ['schtasks.exe', '/Create', '/TN', '\\Jevris\\Sidecar', '/XML', result.unitPath, '/F'],
      ['schtasks.exe', '/Run', '/TN', '\\Jevris\\Sidecar'],
    ]);
    assert.equal(su.serviceStatus(win, fake.exec).state, 'running');
    result = su.uninstallService(win, fake.exec);
    assert.equal(result.ok, true);
    assert.deepEqual(fake.calls.slice(-2), [
      ['schtasks.exe', '/End', '/TN', '\\Jevris\\Sidecar'],
      ['schtasks.exe', '/Delete', '/TN', '\\Jevris\\Sidecar', '/F'],
    ]);
    // With no task installed, uninstall is not an error and ends nothing.
    const none = fakeExec({ '/Query /TN': { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } });
    result = su.uninstallService(win, none.exec);
    assert.deepEqual([result.ok, result.state], [true, 'not-installed']);
    assert.deepEqual(none.calls.map((c) => c[1]), ['/Query']);
    // Nothing installed: uninstall is not an error.
    assert.equal(su.uninstallService(mac, fakeExec({ 'bootout gui/501/dev.jevris.sidecar': { status: 3, stdout: '', stderr: 'No such process' } }).exec).message, 'No Jevris sidecar service was installed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall leaves a unit that serves another Jevris home in place (IPC-17, IPC-20)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b-service-home-')));
  try {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const base = platform === 'win32' ? { ...WIN_INPUT, osHome: root, stateDir: join(root, 'state') } : { ...POSIX_INPUT, platform, osHome: root, stateDir: join(root, 'state') };
      const owner = { ...base, argv: base.argv.slice(0, 3) };
      const other = { ...base, argv: [...base.argv.slice(0, 3), '--home', join(root, 'secondary home')] };
      let installed = su.scheduledTaskXml(owner);
      const exec = (file, args) => (args.includes('/XML') ? { status: 0, stdout: installed, stderr: '' } : { status: 0, stdout: '', stderr: '' });
      assert.equal(su.installService(owner, exec).ok, true, platform);
      // The secondary home's uninstall refuses and removes nothing.
      let result = su.uninstallService(other, exec);
      assert.deepEqual([result.ok, result.state], [false, 'other-home'], platform);
      if (platform !== 'win32') assert.equal(existsSync(result.unitPath), true, `${platform}: the owner's unit was removed`);
      assert.equal(su.unitServesHome(su.planService(owner).unitText, owner), true);
      assert.equal(su.unitServesHome(su.planService(owner).unitText, other), false);
      // The owner's own uninstall removes it.
      result = su.uninstallService(owner, exec);
      assert.equal(result.ok, true, `${platform}: ${result.message}`);
      installed = '';
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('jevris service through the CLI writes the unit for this Node and this Jevris, and never calls a real manager in tests (IPC-20)', async () => {
  const { runRuntimeCommand } = await import('../../cli/dist/runtime-commands.js');
  const account = realpathSync(mkdtempSync(join(tmpdir(), 'b-service-cli-')));
  // A Jevris home that is not the account's own: a folder inside the account's home. The unit
  // for it must name it with --home; the account's own home gets a unit with no --home.
  const jevrisHome = join(account, 'jevris-home');
  mkdirSync(jevrisHome);
  // The unit goes under the OS home: point every variable the OS home and the default folders come from at the temp account.
  const names = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HOME = account;
  process.env.USERPROFILE = account;
  process.env.APPDATA = join(account, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = join(account, 'AppData', 'Local');
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) delete process.env[name];
  try {
    const calls = [];
    let unitPath = null;
    // schtasks /Query /XML prints the registered task, which here is the unit file install wrote.
    const registered = () => (unitPath !== null && existsSync(unitPath) ? { status: 0, stdout: readFileSync(unitPath).subarray(2).toString('utf16le'), stderr: '' } : { status: 1, stdout: '', stderr: 'not found' });
    const serviceExec = (file, args) => (calls.push([file, ...args]), args[0] === '/Query' ? registered() : { status: 0, stdout: '', stderr: '' });
    let text = '';
    const run = (args, hooks, home = jevrisHome) => runRuntimeCommand([...args, '--home', home], (chunk) => (text += chunk), hooks);
    const unitText = (path) => (process.platform === 'win32' ? readFileSync(path).subarray(2).toString('utf16le') : readFileSync(path, 'utf8'));
    if (!['darwin', 'linux', 'win32'].includes(process.platform)) return;

    // A Jevris home that differs from the account's own is served with --home.
    assert.equal(await run(['service', 'install', '--json'], { serviceExec }), 0, text);
    const result = JSON.parse(text.trim());
    assert.equal(result.ok, true);
    unitPath = result.unitPath;
    const unit = unitText(result.unitPath);
    assert.ok(unit.includes('--supervised'));
    // The unit's own --home argument, not any path that happens to sit under the home (a macOS
    // plist also names a log file there, which once made this assertion pass for the wrong reason).
    const named = su.unitHomeFragment(unit);
    assert.ok(named !== null && named.includes(jevrisHome), `the non-default home is served: the unit names ${jevrisHome} after --home (${String(named)})`);
    assert.ok(calls.length >= 1);
    assert.ok(result.unitPath.startsWith(account), 'the unit is under the temp OS home');
    // Without an injected runner, JEVRIS_TEST never reaches launchctl, systemctl or schtasks.
    text = '';
    assert.equal(await run(['service', 'status', '--json']), 0);
    assert.notEqual(JSON.parse(text.trim()).state, 'running');
    text = '';
    assert.equal(await run(['service', 'uninstall'], { serviceExec }), 0, text);
    assert.equal(existsSync(result.unitPath), false);

    // The account's own home is the default home, whichever way it is named: its unit has no --home.
    // On Linux and Windows the OS home follows $HOME / %USERPROFILE%, so the folder this test made
    // the OS home is that account's own home on every OS.
    text = '';
    assert.equal(await run(['service', 'install', '--json'], { serviceExec }, account), 0, text);
    const own = JSON.parse(text.trim());
    assert.equal(own.ok, true);
    unitPath = own.unitPath;
    const ownUnit = unitText(own.unitPath);
    assert.ok(ownUnit.includes('--supervised'));
    assert.equal(su.unitHomeFragment(ownUnit), null, 'the account\'s own home is served without --home');
    assert.ok(own.unitPath.startsWith(account), 'the unit is under the temp OS home');
    text = '';
    assert.equal(await run(['service', 'uninstall'], { serviceExec }, account), 0, text);
    assert.equal(existsSync(own.unitPath), false);
    text = '';
    assert.equal(await run(['service', 'bogus']), 2);
    assert.match(text, /Usage: jevris service install\|uninstall\|status/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(account, { recursive: true, force: true });
  }
});

test('serviceReady and startService ask each service manager to start the installed unit, with no forced kill (a clean exit is not restarted by the manager)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b-service-start-')));
  try {
    const cases = [
      { input: { ...POSIX_INPUT, platform: 'darwin', osHome: root, stateDir: join(root, 'state') }, start: ['launchctl', 'kickstart', 'gui/501/dev.jevris.sidecar'], ready: ['launchctl', 'print', 'gui/501/dev.jevris.sidecar'] },
      { input: { ...POSIX_INPUT, platform: 'linux', osHome: root, stateDir: join(root, 'state'), env: { XDG_CONFIG_HOME: join(root, 'xdg') } }, start: ['systemctl', '--user', 'start', 'jevris-sidecar.service'], ready: ['systemctl', '--user', 'show', 'jevris-sidecar.service', '--property=ActiveState'] },
    ];
    for (const { input, start, ready } of cases) {
      // No unit yet: nothing is started.
      let fake = fakeExec();
      let result = su.startService(input, fake.exec);
      assert.deepEqual([result.ok, result.state], [false, 'not-installed']);
      assert.deepEqual(fake.calls, []);
      assert.equal(su.installService(input, fakeExec().exec).ok, true);
      // Installed, manager answers: the one start call, and a running unit is not killed.
      fake = fakeExec();
      result = su.startService(input, fake.exec);
      assert.deepEqual([result.ok, result.state], [true, 'running'], JSON.stringify(result));
      assert.deepEqual(fake.calls, [ready, start]);
      assert.ok(!fake.calls.flat().includes('-k') && !fake.calls.flat().includes('restart'));
      // The manager does not answer: unreachable, and nothing is started.
      fake = fakeExec({ [ready.slice(1).join(' ')]: { status: 1, stdout: '', stderr: 'Could not find service' } });
      result = su.startService(input, fake.exec);
      assert.deepEqual([result.ok, result.state], [false, 'unknown']);
      assert.deepEqual(fake.calls, [ready]);
      assert.equal(su.serviceReady(input, fakeExec().exec).ok, true);
      // The start call is refused.
      fake = fakeExec({ [start.slice(1).join(' ')]: { status: 5, stdout: '', stderr: 'Operation not permitted' } });
      result = su.startService(input, fake.exec);
      assert.deepEqual([result.ok, result.state], [false, 'failed']);
      assert.equal(result.steps.at(-1).detail, 'Operation not permitted');
      // A unit for another Jevris home is left alone.
      fake = fakeExec();
      result = su.startService({ ...input, argv: [...input.argv.slice(0, -1), '/somewhere/else'] }, fake.exec);
      assert.deepEqual([result.ok, result.state], [false, 'other-home']);
      assert.deepEqual(fake.calls, []);
    }
    // Windows: the task is read back (its XML names the home), then /Run.
    const win = { ...WIN_INPUT, osHome: root, stateDir: join(root, 'state') };
    const xml = su.scheduledTaskXml(win);
    let fake = fakeExec({ '/Query /TN': { status: 0, stdout: xml, stderr: '' } });
    let result = su.startService(win, fake.exec);
    assert.deepEqual([result.ok, result.state], [true, 'running'], JSON.stringify(result));
    assert.deepEqual(fake.calls, [
      ['schtasks.exe', '/Query', '/TN', '\\Jevris\\Sidecar', '/XML'],
      ['schtasks.exe', '/Run', '/TN', '\\Jevris\\Sidecar'],
    ]);
    fake = fakeExec({ '/Query /TN': { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } });
    result = su.startService(win, fake.exec);
    assert.deepEqual([result.ok, result.state], [false, 'not-installed']);
    assert.equal(fake.calls.length, 1);
    fake = fakeExec({ '/Query /TN': { status: 0, stdout: xml.replace('Jevris Home', 'Other Home'), stderr: '' } });
    assert.equal(su.startService(win, fake.exec).state, 'other-home');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
