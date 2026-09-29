// AGY-01, AGY-05, AGY-06: Antigravity is three products with one plugin root. The CLI (`agy`) is
// found on PATH or in its documented install folder; the app and IDE bundles are found on macOS
// and named with their versions; certify without the CLI says why the GUI products cannot be
// certified headlessly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { antigravityProducts, antigravityProductsLine, antigravityCertifyHint } = await import('../dist/antigravity-products.js');
const { harnessExecutableEnv } = await import('../dist/global-harness.js');
const { resolveExecutable } = await import('../../../packages/platform/dist/index.js');

const plist = (id, version) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n  <dict>\n    <key>CFBundleIdentifier</key>\n    <string>${id}</string>\n    <key>CFBundleShortVersionString</key>\n    <string>${version}</string>\n  </dict>\n</plist>\n`;

function bundle(dir, name, id, version, cli) {
  const contents = join(dir, name, 'Contents');
  mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, 'Info.plist'), plist(id, version));
  if (cli) {
    mkdirSync(join(contents, 'Resources', 'app', 'bin'), { recursive: true });
    writeFileSync(join(contents, 'Resources', 'app', 'bin', 'antigravity-ide'), '#!/bin/sh\n');
  }
}

test('the Antigravity app and IDE are found by bundle, with id, version and the IDE editor CLI', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-agy-apps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const system = join(dir, 'Applications');
  const user = join(dir, 'home', 'Applications');
  bundle(system, 'Antigravity.app', 'com.google.antigravity', '2.12.2', false);
  bundle(user, 'Antigravity IDE.app', 'com.google.antigravity-ide', '2.5.5', true);
  const found = antigravityProducts({ platform: 'darwin', applicationDirs: [system, user] });
  assert.deepEqual([found.app.bundleId, found.app.version, found.app.cli], ['com.google.antigravity', '2.12.2', null]);
  assert.deepEqual([found.ide.bundleId, found.ide.version], ['com.google.antigravity-ide', '2.5.5']);
  assert.equal(found.ide.cli, join(user, 'Antigravity IDE.app', 'Contents', 'Resources', 'app', 'bin', 'antigravity-ide'));
  assert.equal(
    antigravityProductsLine(found, { found: false, version: null, certified: false }),
    'harness antigravity products: Antigravity CLI (agy) not found; Antigravity app 2.12.2 (GUI only); Antigravity IDE 2.5.5 (GUI only); all three load ~/.gemini/config/plugins/jevris; certify needs the CLI, because the app and IDE load plugins only in their GUI',
  );
  assert.match(antigravityProductsLine(found, { found: true, version: '1.2.11', certified: true, range: '>=1.2.11 <1.3.0' }), /^harness antigravity products: Antigravity CLI \(agy\) 1\.2\.11, certified for >=1\.2\.11 <1\.3\.0; Antigravity app 2\.12\.2 \(GUI only\);/);
  assert.match(antigravityProductsLine({ app: null, ide: null }, { found: true, version: '1.2.11', certified: false }), /agy\) 1\.2\.11, not certified on this host; Antigravity app not found; Antigravity IDE not found;/);
  assert.match(antigravityCertifyHint(found), /The Antigravity app and Antigravity IDE are installed, but they load plugins only in the GUI/);
  assert.deepEqual(antigravityProducts({ platform: 'darwin', applicationDirs: [join(dir, 'none')] }), { app: null, ide: null });
  assert.deepEqual(antigravityProducts({ platform: 'linux', home: dir }), { app: null, ide: null }, 'no undocumented location is guessed off macOS');
  assert.match(antigravityCertifyHint({ app: null, ide: null }), /^agy \(the Antigravity CLI\) is not on PATH or in its install folder/);
});

test('agy is found in its documented install folder after PATH: ~/.local/bin, or %LOCALAPPDATA%\\agy\\bin, from the discovery environment', () => {
  const env = { PATH: '/usr/bin', HOME: '/Users/a b' };
  const searched = harnessExecutableEnv('agy', env, 'darwin');
  assert.equal(searched.PATH, '/usr/bin:/Users/a b/.local/bin');
  assert.equal(resolveExecutable('agy', { platform: 'darwin', env: searched, isExecutableFile: (p) => p === '/Users/a b/.local/bin/agy' }), '/Users/a b/.local/bin/agy');
  assert.equal(harnessExecutableEnv('agy', searched, 'darwin'), searched, 'added once');
  // certify runs agy with a temporary HOME; the binary is still found where the user installed it.
  const child = { PATH: '/usr/bin', HOME: '/tmp/profile', LOCALAPPDATA: 'C:\\tmp\\profile\\AppData\\Local' };
  assert.equal(harnessExecutableEnv('agy', child, 'linux', { HOME: '/home/u' }).PATH, '/usr/bin:/home/u/.local/bin');
  assert.equal(harnessExecutableEnv('agy', { Path: 'C:\\T' }, 'win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }).Path, 'C:\\T;C:\\Users\\u\\AppData\\Local\\agy\\bin');
  assert.equal(harnessExecutableEnv('codex', env, 'darwin'), env, 'only agy');
});
