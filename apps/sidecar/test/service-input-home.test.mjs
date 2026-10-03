import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

// IPC-20: the unit for the account's own home carries no --home, however that home was named, and
// the unit for any other Jevris home names it. The rule is what lets a hook (which names no home),
// `jevris service` and `jevris sidecar` agree on which unit serves which home. A test run points
// $HOME (and %USERPROFILE%) at a temp folder, and on Linux and Windows the OS home follows them,
// so a test that names that same folder as the Jevris home is naming the account's own home:
// its unit has no --home. (On macOS an assertion that the unit "includes the home" held anyway,
// because the LaunchAgent's log path sits under it; on Linux it did not, and CI failed.)
//
// Nothing here starts a service manager or reads a real home: the account's home, the
// environment and the platform are injected.

const su = await import('../dist/service-units.js');
const { jevrisPaths } = await import('@jevris/platform');

const ENTRY = '/opt/jevris/dist/sidecar.mjs';
const PLATFORMS = ['darwin', 'linux', 'win32'];

const base = join(tmpdir(), 'jsih-account');
const osHome = join(base, 'home');
const inside = join(osHome, 'jevris-home');
const beside = `${osHome}-two`;

/** The rows: what is passed, and the home the unit must name (null: the unit has no --home). */
const ROWS = [
  { name: 'no home at all', options: { env: {} }, named: null },
  { name: 'an explicit home equal to the account home', options: { home: osHome, env: {} }, named: null },
  { name: 'an explicit home with a trailing separator', options: { home: `${osHome}${sep}`, env: {} }, named: null },
  { name: 'an explicit home spelled with . and ..', options: { home: `${osHome}${sep}x${sep}..${sep}.`, env: {} }, named: null },
  { name: 'an explicit home inside the account home', options: { home: inside, env: {} }, named: inside },
  { name: 'an explicit home beside the account home (a name that starts the same)', options: { home: beside, env: {} }, named: beside },
  { name: 'JEVRIS_HOME equal to the account home', options: { env: { JEVRIS_HOME: osHome } }, named: null },
  { name: 'JEVRIS_HOME inside the account home', options: { env: { JEVRIS_HOME: inside } }, named: inside },
  { name: 'an explicit home equal to the account home beats a JEVRIS_HOME elsewhere', options: { home: osHome, env: { JEVRIS_HOME: inside } }, named: null },
  { name: 'an explicit home elsewhere beats a JEVRIS_HOME equal to the account home', options: { home: inside, env: { JEVRIS_HOME: osHome } }, named: inside },
];

test('the unit carries --home exactly when the Jevris home is not the account\'s own, on every platform (IPC-20)', () => {
  for (const platform of PLATFORMS) {
    for (const row of ROWS) {
      const where = `${platform}: ${row.name}`;
      const input = su.serviceInputForHome({ ...row.options, command: [ENTRY], platform, osHome });
      assert.equal(input.platform, platform, where);
      assert.equal(input.osHome, osHome, where);
      assert.deepEqual(input.argv, [process.execPath, ENTRY, '--supervised', ...(row.named === null ? [] : ['--home', row.named])], where);
      const text = su.planService(input).unitText;
      const fragment = su.unitHomeFragment(text);
      if (row.named === null) assert.equal(fragment, null, `${where}: the unit has no --home`);
      else assert.ok(fragment !== null && fragment.includes(row.named), `${where}: the unit names ${row.named} after --home (${String(fragment)})`);
    }
  }
});

test('a unit serves one home: the account\'s own home however named, or the one --home names (IPC-20)', () => {
  for (const platform of PLATFORMS) {
    const input = (options) => su.serviceInputForHome({ ...options, command: [ENTRY], platform, osHome });
    const byDefault = input({ env: {} });
    const byName = input({ home: osHome, env: {} });
    const byEnv = input({ env: { JEVRIS_HOME: osHome } });
    const elsewhere = input({ home: inside, env: {} });
    const installedDefault = su.planService(byDefault).unitText;
    const installedElsewhere = su.planService(elsewhere).unitText;
    // The unit a hook's input (no home) installs serves the CLI's `--home <account home>` and JEVRIS_HOME alike.
    for (const same of [byDefault, byName, byEnv]) assert.equal(su.unitServesHome(installedDefault, same), true, platform);
    assert.equal(su.unitServesHome(installedDefault, elsewhere), false, `${platform}: a unit with no --home does not serve another home`);
    assert.equal(su.unitServesHome(installedElsewhere, elsewhere), true, platform);
    for (const own of [byDefault, byName, byEnv]) assert.equal(su.unitServesHome(installedElsewhere, own), false, `${platform}: a unit for another home does not serve the account's own`);
  }
});

test('the state folder follows the home the unit serves: the account\'s default layout for its own home, the folder itself for another (IPC-20)', () => {
  const env = { XDG_STATE_HOME: join(base, 'xdg-state'), LOCALAPPDATA: join(base, 'local') };
  for (const platform of PLATFORMS) {
    const input = (options) => su.serviceInputForHome({ ...options, command: [ENTRY], platform, osHome });
    // The paths are resolved for this host whichever platform's unit is planned.
    const own = process.platform === 'linux' ? join(env.XDG_STATE_HOME, 'jevris') : process.platform === 'win32' ? join(env.LOCALAPPDATA, 'Jevris', 'state') : join(osHome, '.jevris');
    assert.equal(input({ env }).stateDir, own, `${platform}: no home`);
    assert.equal(input({ home: osHome, env }).stateDir, own, `${platform}: the account home named with --home`);
    assert.equal(input({ env: { ...env, JEVRIS_HOME: osHome } }).stateDir, own, `${platform}: the account home named by JEVRIS_HOME`);
    // Another Jevris home keeps everything inside it: the account's XDG and AppData variables do not apply.
    const other = process.platform === 'linux' ? join(inside, '.local', 'state', 'jevris') : process.platform === 'win32' ? join(inside, 'AppData', 'Local', 'Jevris', 'state') : join(inside, '.jevris');
    assert.equal(input({ home: inside, env }).stateDir, other, `${platform}: another home`);
    assert.equal(input({ home: inside, env }).stateDir, jevrisPaths({ home: inside, env }).state, platform);
  }
});

test('sameHomeDirectory compares the names the way the file system does: case-blind on Windows and macOS only (IPC-20)', () => {
  const rows = [
    ['/home/dev', '/home/dev', 'linux', true],
    ['/home/dev/', '/home/dev', 'linux', true],
    ['/home/dev/x/..', '/home/dev', 'linux', true],
    ['/home/dev', '/home/Dev', 'linux', false],
    ['/home/dev', '/home/dev2', 'linux', false],
    ['/home/dev', '/home/dev/x', 'linux', false],
    ['/Users/dev', '/users/DEV', 'darwin', true],
    ['/Users/dev', '/Users/dev2', 'darwin', false],
    ['C:\\Users\\Dev', 'c:\\users\\dev\\', 'win32', true],
    ['C:\\Users\\Dev', 'C:/Users/Dev', 'win32', true],
    ['C:\\Users\\Dev', 'D:\\Users\\Dev', 'win32', false],
    ['C:\\Users\\Dev', 'C:\\Users\\Dev2', 'win32', false],
  ];
  for (const [a, b, platform, same] of rows) assert.equal(su.sameHomeDirectory(a, b, platform), same, `${platform}: ${a} vs ${b}`);
});

test('a test that points $HOME and %USERPROFILE% at a folder and names it as the Jevris home gets the account\'s own home, on every OS (IPC-20)', () => {
  // The scenario CI hit: no osHome is injected, so the account's home is read the way the product
  // reads it (os.homedir(), which follows $HOME on Linux and macOS and %USERPROFILE% on Windows).
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'jsih-real-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = folder;
  process.env.USERPROFILE = folder;
  try {
    for (const platform of PLATFORMS) {
      const own = su.serviceInputForHome({ home: folder, command: [ENTRY], platform, env: {} });
      assert.equal(own.osHome, folder, `${platform}: the OS home follows $HOME`);
      assert.ok(!own.argv.includes('--home'), `${platform}: the account's own home is the default home`);
      const sub = join(folder, 'jevris-home');
      const other = su.serviceInputForHome({ home: sub, command: [ENTRY], platform, env: {} });
      assert.deepEqual(other.argv.slice(-2), ['--home', sub], `${platform}: a folder inside it is another home`);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(folder, { recursive: true, force: true });
  }
});
