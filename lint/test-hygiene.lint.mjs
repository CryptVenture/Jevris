import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test hygiene (QA-01, QA-07).
 *
 * - Behavioural tests do not read product source text. A check on src/*.ts wording or
 *   imports lives in a `lint/*.lint.mjs` file and runs in `npm run lint`.
 * - Tests hold no 64-hex byte-hash pin. A test that needs a hash recomputes it from the
 *   bytes it checks.
 * - Tests never call os.homedir(). Under scripts/test.mjs it is a temp home, but a test file run
 *   directly (`node --test <file>`) gets the real one: the retired listener tests left short
 *   `~/.j<hex>` socket directories in the owner's home that way. Use a temp directory, or a
 *   sandbox's own home.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'fixtures' && name !== 'node_modules') walk(full, out);
    } else if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(full);
  }
  return out;
}

export function testFiles(base = root) {
  const files = [];
  for (const group of ['apps', 'packages']) {
    const dir = join(base, group);
    if (!existsSync(dir)) continue;
    for (const pkg of readdirSync(dir)) walk(join(dir, pkg, 'test'), files);
  }
  walk(join(base, 'test'), files);
  return files;
}

/**
 * A read of product source: a relative `../src/` URL or a `'src'` path segment. A string that
 * only names a source file (a gate citation id) is data, not a read.
 */
export const SOURCE_READ = [
  /['"`]\.\.?\/(?:\.\.\/)*(?:[\w.-]+\/)*src\/[^'"`]*['"`]/,
  /['"`]src['"`]\s*[,)]/,
  /(?:readFile(?:Sync)?|readdirSync|new URL)\([^;]*['"`](?:\.\.\/)*(?:apps|packages)\/[\w.-]+\/src\//,
];

export const HEX_PIN = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/;

/** A line naming a temp directory called src, not product source, ends with this comment. */
const NOT_SOURCE = /\/\/ test-hygiene: not product source\b/;

export function sourceReads(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (NOT_SOURCE.test(lines[i])) continue;
    if (SOURCE_READ.some((pattern) => pattern.test(lines[i]))) hits.push(i + 1);
  }
  return hits;
}

test('no behavioural test reads product source text (QA-07)', () => {
  const findings = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const line of sourceReads(readFileSync(file, 'utf8'))) findings.push(`${rel}:${line}`);
  }
  assert.deepEqual(findings, []);
});

test('no test holds a 64-hex byte-hash pin (QA-01)', () => {
  const findings = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (HEX_PIN.test(line)) findings.push(`${rel}:${index + 1}`);
    });
  }
  assert.deepEqual(findings, []);
});

/** Lines (1-based) of `text` that call os.homedir() or homedir(), outside comments. */
export function homedirCalls(text) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(code)) return;
    if (/\bhomedir\s*\(\s*\)/.test(code)) hits.push(index + 1);
  });
  return hits;
}

test('no test calls os.homedir(), so nothing lands in the real home when a file is run directly', () => {
  const findings = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const line of homedirCalls(readFileSync(file, 'utf8'))) findings.push(`${rel}:${line}`);
  }
  assert.deepEqual(findings, []);
});

test('the detectors catch a source read and a pin', () => {
  assert.deepEqual(homedirCalls("const dir = join(homedir(), `.j16${'ab'}`);"), [1]);
  assert.deepEqual(homedirCalls("const h = os.homedir ();"), [1]);
  assert.deepEqual(homedirCalls("// homedir() is the temp home here"), []);
  assert.deepEqual(homedirCalls("const home = box.home;"), []);
  assert.deepEqual(sourceReads("const s = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');"), [1]);
  assert.deepEqual(sourceReads("const s = readFileSync(join(root, 'apps', 'cli', 'src', 'cli.ts'));"), [1]);
  assert.deepEqual(sourceReads("readdirSync(join(root, base, pkg, 'src'))"), [1]);
  assert.deepEqual(sourceReads("const s = readFileSync(join(root, 'packages/core/src/index.ts'));"), [1]);
  assert.deepEqual(sourceReads("assert.equal(citations.includes('apps/cli/src/doctor.ts'), true);"), []);
  assert.deepEqual(sourceReads("const { main } = await import('../dist/cli.js');"), []);
  assert.deepEqual(sourceReads("const dir = join(home, 'src'); // test-hygiene: not product source"), []);
  assert.equal(HEX_PIN.test(`const h = '${'ab'.repeat(32)}';`), true);
  assert.equal(HEX_PIN.test(`const h = sha256(bytes);`), false);
});
