import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/egress.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('core index re-exports diagnoseCredential', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /\bdiagnoseCredential\b/);
});

test('egress source does not import the kernel module', () => {
  const source = readFileSync(new URL('../src/egress.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('kernel.js'), false);
  assert.equal(source.includes('evaluateChoice'), false);
});

test('kernel keeps a single authorityGranted false assignment', () => {
  const kernel = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
  const matches = kernel.match(/authorityGranted:\s*false/g) ?? [];
  assert.equal(matches.length, 1);
});
