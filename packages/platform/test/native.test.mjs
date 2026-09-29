import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BETTER_SQLITE3, assetPath, findPackageRoot, nativeDiagnostic, packageRoot, probeNativeAddon } from '../dist/index.js';

test('a native addon that fails to load gives one plain diagnostic line (BLD-13)', () => {
  const probe = probeNativeAddon(BETTER_SQLITE3, {
    load: () => {
      throw Object.assign(new Error('dlopen failed at /very/long/stack'), { code: 'ERR_DLOPEN_FAILED' });
    },
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'ERR_DLOPEN_FAILED');
  assert.equal(probe.diagnostic.includes('\n'), false);
  assert.equal(probe.diagnostic.includes('/very/long/stack'), false, 'no error text or stack is echoed');
  assert.match(probe.diagnostic, /better-sqlite3 could not be loaded \(ERR_DLOPEN_FAILED\)\. Jevris continues rules-only/);
  assert.equal(nativeDiagnostic({ name: 'x', effect: 'Effect sentence.' }, 'X').includes('Effect sentence.'), true);
});

test('an odd error code is replaced, so nothing unbounded reaches the terminal', () => {
  const probe = probeNativeAddon(BETTER_SQLITE3, {
    load: () => {
      throw Object.assign(new Error('x'), { code: 'weird code\nwith newline' });
    },
  });
  assert.equal(probe.code, 'LOAD_FAILED');
});

test('the real better-sqlite3 loads in this checkout (BLD-13)', () => {
  assert.deepEqual(probeNativeAddon(BETTER_SQLITE3), { ok: true, name: 'better-sqlite3' });
  const wrapperOnly = probeNativeAddon(BETTER_SQLITE3, { load: () => ({ notAConstructor: true }) });
  assert.equal(wrapperOnly.ok, false, 'a loaded wrapper without a working binding is not ok');
});

test('the package root is found from a module URL, and assets resolve under it (BLD-03, BLD-04)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jpr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // An installed layout: node_modules/@cryptventure/jevris/packages/platform/dist/x.js
  const pkg = join(root, 'node_modules', '@cryptventure', 'jevris');
  const dist = join(pkg, 'packages', 'platform', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@cryptventure/jevris' }));
  writeFileSync(join(pkg, 'packages', 'platform', 'package.json'), JSON.stringify({ name: '@jevris/platform' }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'someone-else' }));
  assert.equal(findPackageRoot(pathToFileURL(join(dist, 'x.js')).href), pkg);
  assert.equal(findPackageRoot(join(root, 'elsewhere', 'x.js')), null);
  assert.equal(assetPath('schemas', 'pack-manifest.schema.json'), join(packageRoot(), 'assets', 'schemas', 'pack-manifest.schema.json'));
});
