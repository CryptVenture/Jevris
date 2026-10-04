import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as hostPath from 'node:path';
import { join, posix, win32 } from 'node:path';

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

/**
 * Where the table's paths come from. The platform whose unit is planned and the path rules of the
 * names it holds are two things: a macOS host can plan a Windows unit, and then the home is
 * `C:\Users\dev`, not a macOS path. So the table runs twice:
 *  - "its own paths": every platform with its own account (`/Users/dev`, `/home/dev`,
 *    `C:\Users\dev`) and its own path rules (`pathRules`), with nothing read from this host. The
 *    table, and so the result, is the same on every host.
 *  - "this host's paths": every platform's unit with the names of a temp folder on this host, which
 *    is what the tests that write a unit to disk use. On a Windows host a `linux` unit then holds a
 *    Windows path, and systemd's quoting doubles its backslashes (CI run 37159176084).
 */
const ACCOUNTS = {
  darwin: { api: posix, osHome: '/Users/dev', folds: true },
  linux: { api: posix, osHome: '/home/dev', folds: false },
  win32: { api: win32, osHome: 'C:\\Users\\dev', folds: true },
};
const hostBase = join(tmpdir(), 'jsih-account');
const SHAPES = [
  { shape: 'its own paths', of: (platform) => ({ ...ACCOUNTS[platform], pathRules: platform }) },
  // Whether two names that differ in case are one folder follows the file system the paths are on: this host's.
  { shape: "this host's paths", of: () => ({ api: hostPath, osHome: join(hostBase, 'home'), pathRules: undefined, folds: process.platform !== 'linux' }) },
];
/** serviceInputForHome with the shape's path rules. */
const inputFor = (platform, account, options) => su.serviceInputForHome({ ...options, command: [ENTRY], platform, osHome: account.osHome, ...(account.pathRules === undefined ? {} : { pathRules: account.pathRules }) });

/** The names the table uses, in an account's own path shape. */
function namesOf({ api, osHome }) {
  return { inside: api.join(osHome, 'jevris-home'), beside: `${osHome}-two`, sep: api.sep };
}

// ------------------------------------------------------------ reading a unit back, in its own format

const unxml = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** One Windows command line split by the CommandLineToArgvW rules (the inverse of windowsArg). */
function splitWindowsArgs(line) {
  const args = [];
  let current = null;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') {
      let slashes = 0;
      while (line[i] === '\\') {
        slashes += 1;
        i += 1;
      }
      if (line[i] === '"') {
        current = `${current ?? ''}${'\\'.repeat(Math.floor(slashes / 2))}`;
        if (slashes % 2 === 1) current += '"';
        else quoted = !quoted;
      } else {
        current = `${current ?? ''}${'\\'.repeat(slashes)}`;
        i -= 1;
      }
    } else if (ch === '"') {
      current = current ?? '';
      quoted = !quoted;
    } else if (/\s/.test(ch) && !quoted) {
      if (current !== null) args.push(current);
      current = null;
    } else {
      current = `${current ?? ''}${ch}`;
    }
  }
  if (current !== null) args.push(current);
  return args;
}

/** One systemd ExecStart word, unquoted the way systemd reads it: only \\ and \" are escapes, and a % or $ stands for itself only when doubled (a lone one is a specifier or a variable). */
function unsystemd(raw) {
  return raw.replace(/\\(.)|%(.?)|\$(.?)/g, (whole, escaped, percent, dollar) => {
    if (escaped !== undefined) {
      assert.ok(escaped === '\\' || escaped === '"', `systemd has no escape ${whole}`);
      return escaped;
    }
    if (percent !== undefined) {
      assert.equal(percent, '%', `a lone % in a systemd word is a specifier: ${raw}`);
      return '%';
    }
    assert.equal(dollar, '$', `a lone $ in a systemd word is a variable: ${raw}`);
    return '$';
  });
}

/** The arguments a unit's text passes to the sidecar: the launch agent's strings, systemd's ExecStart words, the task's Arguments. */
function argumentsOfUnit(platform, text) {
  if (platform === 'darwin') return [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1])).slice(1);
  if (platform === 'linux') {
    const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
    return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unsystemd(m[1]));
  }
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(text)?.[1] ?? '';
  return splitWindowsArgs(unxml(args));
}

/** The home a unit's text names after --home, exactly as the sidecar would receive it; null when it names none. */
function homeOfUnit(platform, text) {
  const args = argumentsOfUnit(platform, text);
  const at = args.indexOf('--home');
  return at < 0 ? null : (args[at + 1] ?? null);
}

/** The rows: what is passed, and the home the unit must name (null: the unit has no --home). */
function rowsOf({ api, osHome, folds }) {
  const { inside, beside, sep } = namesOf({ api, osHome });
  const swapped = osHome.toUpperCase() === osHome ? osHome.toLowerCase() : osHome.toUpperCase();
  return [
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
    // The same folder in other letters is the account's own home where the file system ignores case (Windows, macOS), another home on Linux.
    { name: 'an explicit home equal to the account home in other letters', options: { home: swapped, env: {} }, named: folds ? null : api.resolve(swapped) },
  ];
}

test('the unit carries --home exactly when the Jevris home is not the account\'s own, on every platform (IPC-20)', () => {
  for (const { shape, of } of SHAPES) {
    for (const platform of PLATFORMS) {
      const account = of(platform);
      for (const row of rowsOf(account)) {
        const where = `${platform}, ${shape}: ${row.name}`;
        const named = row.named;
        const input = inputFor(platform, account, row.options);
        assert.equal(input.platform, platform, where);
        assert.equal(input.osHome, account.osHome, where);
        assert.deepEqual(input.argv, [process.execPath, ENTRY, '--supervised', ...(named === null ? [] : ['--home', named])], where);
        const text = su.planService(input).unitText;
        const fragment = su.unitHomeFragment(text);
        // The unit names the home exactly, in its own format's quoting: not a path that merely contains it.
        assert.equal(homeOfUnit(platform, text), named, `${where}: the unit names ${String(named)} after --home (${String(fragment)})`);
        assert.equal(fragment === null, named === null, `${where}: --home is in the unit exactly when a home is named`);
      }
    }
  }
});

test('a unit writes any home the way its own format reads it back: spaces, quotes, % and $ (IPC-20)', () => {
  const awkward = { darwin: '/Users/dev/My Jevris "home" $x %y <&> \\n', linux: '/home/dev/My Jevris "home" $x %y <&> back\\slash', win32: 'C:\\Users\\dev\\My Jevris "home" $x %y <&>' };
  for (const platform of PLATFORMS) {
    const account = { ...ACCOUNTS[platform], pathRules: platform };
    const input = inputFor(platform, account, { home: awkward[platform], env: {} });
    assert.deepEqual(input.argv.slice(-2), ['--home', awkward[platform]], platform);
    assert.equal(homeOfUnit(platform, su.planService(input).unitText), awkward[platform], `${platform}: the unit's text reads back as the home`);
  }
  // The reader is not a loophole: a unit for another home reads back as that home, and the account's own as none.
  const own = inputFor('linux', { ...ACCOUNTS.linux, pathRules: 'linux' }, { env: {} });
  assert.equal(homeOfUnit('linux', su.planService(own).unitText), null);
});

test('a unit serves one home: the account\'s own home however named, or the one --home names (IPC-20)', () => {
  for (const { shape, of } of SHAPES) {
    for (const platform of PLATFORMS) {
      const account = of(platform);
      const { inside } = namesOf(account);
      const input = (options) => inputFor(platform, account, options);
      const byDefault = input({ env: {} });
      const byName = input({ home: account.osHome, env: {} });
      const byEnv = input({ env: { JEVRIS_HOME: account.osHome } });
      const elsewhere = input({ home: inside, env: {} });
      const installedDefault = su.planService(byDefault).unitText;
      const installedElsewhere = su.planService(elsewhere).unitText;
      const where = `${platform}, ${shape}`;
      // The unit a hook's input (no home) installs serves the CLI's `--home <account home>` and JEVRIS_HOME alike.
      for (const same of [byDefault, byName, byEnv]) assert.equal(su.unitServesHome(installedDefault, same), true, where);
      assert.equal(su.unitServesHome(installedDefault, elsewhere), false, `${where}: a unit with no --home does not serve another home`);
      assert.equal(su.unitServesHome(installedElsewhere, elsewhere), true, where);
      for (const own of [byDefault, byName, byEnv]) assert.equal(su.unitServesHome(installedElsewhere, own), false, `${where}: a unit for another home does not serve the account's own`);
    }
  }
});

test('the state folder follows the home the unit serves: the account\'s default layout for its own home, the folder itself for another (IPC-20)', () => {
  const base = hostBase;
  const env = { XDG_STATE_HOME: join(base, 'xdg-state'), LOCALAPPDATA: join(base, 'local') };
  const osHome = join(base, 'home');
  const inside = join(osHome, 'jevris-home');
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

test('the state folder follows the platform\'s own layout when the paths are the platform\'s too, the same on every host (IPC-20)', () => {
  for (const platform of PLATFORMS) {
    const account = { ...ACCOUNTS[platform], pathRules: platform };
    const { api, osHome } = account;
    const { inside } = namesOf(account);
    const env = { XDG_STATE_HOME: api.join(osHome, 'xdg-state'), LOCALAPPDATA: api.join(osHome, 'local') };
    const input = (options) => inputFor(platform, account, options);
    const layout = {
      linux: { own: api.join(env.XDG_STATE_HOME, 'jevris'), other: api.join(inside, '.local', 'state', 'jevris') },
      win32: { own: api.join(env.LOCALAPPDATA, 'Jevris', 'state'), other: api.join(inside, 'AppData', 'Local', 'Jevris', 'state') },
      darwin: { own: api.join(osHome, '.jevris'), other: api.join(inside, '.jevris') },
    }[platform];
    assert.equal(input({ env }).stateDir, layout.own, `${platform}: no home`);
    assert.equal(input({ home: osHome, env }).stateDir, layout.own, `${platform}: the account home named with --home`);
    assert.equal(input({ env: { ...env, JEVRIS_HOME: osHome } }).stateDir, layout.own, `${platform}: the account home named by JEVRIS_HOME`);
    assert.equal(input({ home: inside, env }).stateDir, layout.other, `${platform}: another home`);
    assert.equal(input({ home: inside, env }).stateDir, jevrisPaths({ home: inside, env, platform }).state, platform);
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
    // The shapes a Windows home comes in: a lower-case drive with forward slashes, doubled separators, a share, another drive's twin, a parent step.
    ['C:/Users/Dev/', 'c:\\users\\dev', 'win32', true],
    ['C:\\Users\\\\Dev\\\\x\\..', 'C:\\Users\\Dev', 'win32', true],
    ['\\\\Server\\Share\\Dev', '\\\\server\\share\\dev\\', 'win32', true],
    ['\\\\Server\\Share\\Dev', '\\\\Server\\Other\\Dev', 'win32', false],
    ['C:\\Users\\Dev\\..\\Dev', 'C:\\Users\\Dev', 'win32', true],
    ['/home//dev///', '/home/dev', 'linux', true],
    ['/home/dev/../dev2', '/home/dev', 'linux', false],
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
