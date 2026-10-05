import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The slow-host kit is test-only (scripts/slow-host.mjs, scripts/slow-host-preload.cjs, `npm run test:slow`). It makes a fast host
 * behave like the Windows runner: slow writes, slow process starts, transient write errors, frozen processes. None of that may ever
 * be reachable from a product path: no product source, no bundled entry and no plugin file names the kit, its preload or its
 * variables, and the preload is named by the kit alone.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const KIT = /slow-host|slow_host|JEVRIS_SLOW_|test:slow|test-slow\.mjs/;

function walk(dir, out, skip) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (skip.has(name)) continue;
    if (statSync(full).isDirectory()) walk(full, out, skip);
    else if (/\.(?:ts|mjs|js|cjs|json|md)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every product file: each workspace's src, the plugin sources, the policy packs and the runtime assets. */
export function productFiles(base = root) {
  const files = [];
  const skip = new Set(['node_modules', 'test', 'dist', 'lint']);
  for (const group of ['apps', 'packages']) {
    const dir = join(base, group);
    if (!existsSync(dir)) continue;
    for (const workspace of readdirSync(dir)) walk(join(dir, workspace, 'src'), files, skip);
  }
  for (const folder of ['plugins', 'packs', 'assets', 'bin']) walk(join(base, folder), files, skip);
  return files;
}

/** The product files in `files` whose text names the kit. */
export function kitReferences(files, read = (file) => readFileSync(file, 'utf8')) {
  return files.filter((file) => KIT.test(read(file)));
}

test('no product file names the slow-host kit, its preload or its variables', () => {
  assert.deepEqual(kitReferences(productFiles()).map((file) => relative(root, file).split(sep).join('/')), []);
});

test('the preload is loaded by the kit alone, and only through a generated enable file', () => {
  const holders = [];
  for (const dir of ['scripts', 'test', 'lint', 'apps', 'packages']) {
    for (const file of walk(join(root, dir), [], new Set(['node_modules', 'dist']))) {
      if (/slow-host-preload/.test(readFileSync(file, 'utf8'))) holders.push(relative(root, file).split(sep).join('/'));
    }
  }
  // The kit names it (and writes enable.cjs around it), its own test runs it, and this lint names it.
  assert.deepEqual(holders.sort(), ['lint/slow-host.lint.mjs', 'scripts/slow-host.mjs', 'test/slow-host.test.mjs']);
  assert.match(readFileSync(join(root, 'scripts', 'slow-host-preload.cjs'), 'utf8'), /if \(config !== null\) install\(config\)/, 'it does nothing without a configuration that says active');
});

test('the detector names a file that reaches for the kit', () => {
  const texts = new Map([
    ['a.ts', "import { x } from '../../scripts/slow-host.mjs';"],
    ['b.ts', 'const delay = process.env.JEVRIS_SLOW_CONFIG;'],
    ['c.ts', "const s = 'npm run test:slow';"],
    ['d.ts', "export const slowest = (hosts: string[]) => hosts.sort(); // nothing of the kit"],
  ]);
  assert.deepEqual(kitReferences([...texts.keys()], (file) => texts.get(file)), ['a.ts', 'b.ts', 'c.ts']);
});
