import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installReceiptPath,
  jevrisPaths,
  jevrisRoots,
  legacyLeftovers,
  migrateLegacyLayout,
  resolveHome,
} from '../dist/index.js';

const WIN_HOME = 'C:\\Users\\Ada Lovelace';
// On-disk tests use a layout whose path rules match the host, so real temp paths resolve.
const DISK = process.platform === 'win32' ? 'win32' : 'linux';

test('darwin keeps ~/.config/jevris and ~/.jevris (E-18 default) (BLD-02)', () => {
  const paths = jevrisPaths({ platform: 'darwin', home: '/Users/ada', env: {} });
  assert.equal(paths.config, '/Users/ada/.config/jevris');
  assert.equal(paths.data, '/Users/ada/.jevris');
  assert.equal(paths.state, '/Users/ada/.jevris');
  assert.equal(paths.runtime, '/Users/ada/.jevris/run');
  assert.equal(installReceiptPath(paths), '/Users/ada/.jevris/install-receipt.json');
});

test('linux follows XDG with defaults under the home (BLD-02)', () => {
  const paths = jevrisPaths({ platform: 'linux', env: {}, osHome: '/home/ada' });
  assert.equal(paths.homeSource, 'os');
  assert.equal(paths.config, '/home/ada/.config/jevris');
  assert.equal(paths.data, '/home/ada/.local/share/jevris');
  assert.equal(paths.state, '/home/ada/.local/state/jevris');
  assert.equal(paths.runtime, '/home/ada/.local/state/jevris/run');
  assert.equal(paths.legacyData, '/home/ada/.jevris');
});

test('linux honours absolute XDG variables for the OS home only (BLD-02)', () => {
  const env = { XDG_CONFIG_HOME: '/xdg/config', XDG_DATA_HOME: '/xdg/data', XDG_STATE_HOME: 'relative/ignored' };
  const os = jevrisPaths({ platform: 'linux', env, osHome: '/home/ada' });
  assert.equal(os.config, '/xdg/config/jevris');
  assert.equal(os.data, '/xdg/data/jevris');
  assert.equal(os.state, '/home/ada/.local/state/jevris', 'a relative XDG value is ignored');
  const explicit = jevrisPaths({ platform: 'linux', env, home: '/tmp/h', osHome: '/home/ada' });
  assert.equal(explicit.homeSource, 'explicit');
  assert.equal(explicit.config, '/tmp/h/.config/jevris', 'an explicit home never leaves the home through XDG');
  assert.equal(explicit.data, '/tmp/h/.local/share/jevris');
});

test('win32 uses %APPDATA% and %LOCALAPPDATA%, case-insensitively, for the OS home (BLD-02)', () => {
  const env = { appdata: 'D:\\Roaming', LocalAppData: 'D:\\Local' };
  const paths = jevrisPaths({ platform: 'win32', env, osHome: WIN_HOME });
  assert.equal(paths.config, 'D:\\Roaming\\Jevris');
  assert.equal(paths.data, 'D:\\Local\\Jevris');
  assert.equal(paths.state, 'D:\\Local\\Jevris\\state');
  assert.equal(paths.runtime, 'D:\\Local\\Jevris\\run');
  const fallback = jevrisPaths({ platform: 'win32', env: {}, osHome: WIN_HOME });
  assert.equal(fallback.config, `${WIN_HOME}\\AppData\\Roaming\\Jevris`);
  assert.equal(fallback.data, `${WIN_HOME}\\AppData\\Local\\Jevris`);
  assert.equal(fallback.legacyData, `${WIN_HOME}\\.jevris`);
  assert.equal(fallback.legacyConfig, `${WIN_HOME}\\.config\\jevris`);
});

test('JEVRIS_HOME is the home when no explicit home is given, and disables OS variables (BLD-02)', () => {
  const env = { JEVRIS_HOME: '/srv/jh', XDG_DATA_HOME: '/xdg/data' };
  assert.deepEqual(resolveHome({ platform: 'linux', env, osHome: '/home/ada' }), { home: '/srv/jh', source: 'JEVRIS_HOME' });
  const paths = jevrisPaths({ platform: 'linux', env, osHome: '/home/ada' });
  assert.equal(paths.data, '/srv/jh/.local/share/jevris');
  assert.equal(jevrisPaths({ platform: 'linux', env, home: '/x', osHome: '/home/ada' }).home, '/x');
});

test('jevrisRoots lists each distinct root once, deepest first', () => {
  const darwin = jevrisRoots(jevrisPaths({ platform: 'darwin', home: '/Users/ada', env: {} }));
  assert.deepEqual(darwin, ['/Users/ada/.config/jevris', '/Users/ada/.jevris/run', '/Users/ada/.jevris']);
  const linux = jevrisRoots(jevrisPaths({ platform: 'linux', home: '/h', env: {} }));
  assert.equal(linux.length, 4);
  assert.equal(new Set(linux).size, 4);
});

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jp-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('migration moves legacy entries on linux, never overwrites, and removes an empty run dir (BLD-02)', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.jevris', 'packs'), { recursive: true });
  mkdirSync(join(home, '.jevris', 'run'), { recursive: true });
  writeFileSync(join(home, '.jevris', 'install-receipt.json'), '{"legacy":true}');
  writeFileSync(join(home, '.jevris', 'packs', 'a.json'), '{}');
  writeFileSync(join(home, '.jevris', 'keep.json'), 'legacy');
  const paths = jevrisPaths({ platform: DISK, home, env: {} });
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(join(paths.data, 'keep.json'), 'current');

  const report = await migrateLegacyLayout(paths);
  assert.equal(readFileSync(join(paths.data, 'install-receipt.json'), 'utf8'), '{"legacy":true}');
  assert.equal(existsSync(join(paths.data, 'packs', 'a.json')), true);
  assert.equal(readFileSync(join(paths.data, 'keep.json'), 'utf8'), 'current', 'an existing destination is never overwritten');
  assert.equal(readFileSync(join(home, '.jevris', 'keep.json'), 'utf8'), 'legacy');
  assert.deepEqual(report.leftovers, [join(home, '.jevris', 'keep.json')]);
  assert.equal(existsSync(join(home, '.jevris', 'run')), false);
  assert.deepEqual(await legacyLeftovers(paths), [join(home, '.jevris')]);
});

test('migration is a no-op on darwin, where legacy and current are the same (BLD-02)', { skip: process.platform === 'win32' ? 'a darwin layout needs POSIX paths on disk' : false }, async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.jevris'), { recursive: true });
  writeFileSync(join(home, '.jevris', 'install-receipt.json'), '{}');
  const report = await migrateLegacyLayout(jevrisPaths({ platform: 'darwin', home, env: {} }));
  assert.deepEqual(report, { moved: [], leftovers: [], refused: [] });
  assert.equal(existsSync(join(home, '.jevris', 'install-receipt.json')), true);
});

test('migration refuses a symlinked legacy root or entry (BLD-02)', { skip: process.platform === 'win32' ? 'symlink creation needs privileges on Windows' : false }, async (t) => {
  const home = tempHome(t);
  const outside = tempHome(t);
  writeFileSync(join(outside, 'secret.json'), 'x');
  symlinkSync(outside, join(home, '.jevris'));
  const paths = jevrisPaths({ platform: DISK, home, env: {} });
  const report = await migrateLegacyLayout(paths);
  assert.deepEqual(report.refused, [join(home, '.jevris')]);
  assert.equal(existsSync(join(paths.data, 'secret.json')), false);
  assert.equal(lstatSync(join(home, '.jevris')).isSymbolicLink(), true);
});

test('migration moves ~/.config/jevris when the config directory differs (BLD-02)', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.config', 'jevris'), { recursive: true });
  writeFileSync(join(home, '.config', 'jevris', 'host.json'), '{}');
  // win32 always differs (%APPDATA%); linux differs when XDG_CONFIG_HOME points elsewhere.
  const env = DISK === 'win32' ? {} : { XDG_CONFIG_HOME: join(home, 'xdg') };
  const paths = jevrisPaths({ platform: DISK, env, osHome: home });
  assert.notEqual(paths.config, paths.legacyConfig);
  const report = await migrateLegacyLayout(paths);
  assert.equal(existsSync(join(paths.config, 'host.json')), true);
  assert.equal(report.moved.includes(join(paths.config, 'host.json')), true);
});

test('migration falls back to copy and remove on EXDEV', async () => {
  const calls = [];
  const fs = {
    lstat: async (path) => {
      if (path === '/h/.jevris') return { isSymbolicLink: () => false, isDirectory: () => true };
      if (path === '/h/.jevris/a.json') return { isSymbolicLink: () => false, isDirectory: () => false };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readdir: async () => ['a.json'],
    mkdir: async () => undefined,
    rename: async () => {
      throw Object.assign(new Error('cross'), { code: 'EXDEV' });
    },
    cp: async (from, to) => calls.push(['cp', from, to]),
    rm: async (path) => calls.push(['rm', path]),
    rmdir: async () => undefined,
  };
  const report = await migrateLegacyLayout(jevrisPaths({ platform: 'linux', home: '/h', env: {} }), fs);
  assert.deepEqual(calls, [
    ['cp', '/h/.jevris/a.json', '/h/.local/share/jevris/a.json'],
    ['rm', '/h/.jevris/a.json'],
  ]);
  assert.deepEqual(report.moved, ['/h/.local/share/jevris/a.json']);
});
