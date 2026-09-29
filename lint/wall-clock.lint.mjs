import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './test-hygiene.lint.mjs';

/**
 * Wall-clock windows (QA-05, §18.1, US29). A deadline test uses an injected clock (a `nowMs`
 * port, a fake timer or a deadline argument) and asserts the outcome, not how fast the machine
 * ran. An assertion that a real elapsed time stays under 2 s fails on a loaded CI runner, so it
 * is banned; a generous hang guard of 2 s or more is allowed.
 *
 * The ratchet of remaining findings is empty and gone: every finding fails lint.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
export const FLOOR_MS = 2000;

const WINDOWS = [
  // Date.now() - started < 500, performance.now() - t0 <= 900
  /(?:Date\.now\(\)|performance\.now\(\))\s*-\s*[\w.]+\)?\s*<=?\s*([\d_]+)/g,
  // took < 600, elapsed <= 1000, durationMs < 300, run.ms < 500 (inside an assertion)
  /\b(?:took|elapsed\w*|duration\w*|(?:\w+\.)?ms)\s*<=?\s*([\d_]+)/g,
];

/** Asserted wall-clock windows under the floor in one test file: [{ line, ms }]. */
export function shortWindows(text) {
  const out = [];
  text.split('\n').forEach((line, index) => {
    if (!/assert|\bok\(/.test(line)) return;
    for (const pattern of WINDOWS) {
      for (const match of line.matchAll(pattern)) {
        const ms = Number(match[1].replaceAll('_', ''));
        if (ms < FLOOR_MS) out.push({ line: index + 1, ms });
      }
    }
  });
  return out;
}

function findings() {
  const out = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    if (shortWindows(readFileSync(file, 'utf8')).length > 0) out.push(rel);
  }
  return out.sort();
}

// The ratchet emptied (QA-05 done); there is no allowlist, so any short window fails lint.
test('no test asserts a wall-clock window under 2 s (QA-05)', () => {
  assert.deepEqual(findings(), [], 'use an injected clock, or a hang guard of at least 2 s');
});

test('the detector flags short windows and allows hang guards and request fields (QA-05)', () => {
  assert.deepEqual(shortWindows('    assert.ok(Date.now() - started < 500);'), [{ line: 1, ms: 500 }]);
  assert.deepEqual(shortWindows("  assert.ok(took < 600, 'fast');"), [{ line: 1, ms: 600 }]);
  assert.deepEqual(shortWindows('  assert.equal(Date.now() - began < 380, true);'), [{ line: 1, ms: 380 }]);
  assert.deepEqual(shortWindows('    assert.ok(Date.now() - started < 2000);'), []);
  assert.deepEqual(shortWindows('  assert.equal(hung.ms < 2000, true);'), []);
  assert.deepEqual(shortWindows('    assert.equal(request.timeoutMs > 0 && request.timeoutMs <= 1500, true);'), []);
  assert.deepEqual(shortWindows('  const deadline = Date.now() - start < 100;'), []);
});
