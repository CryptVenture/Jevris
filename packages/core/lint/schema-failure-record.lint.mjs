import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/schema-failure-record.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('the kernel refuse path still assigns retainedBody', () => {
  const kernel = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
  assert.equal(kernel.includes('retainedBody:'), true);
  assert.equal(kernel.includes('retainedBody: body'), true);
});
