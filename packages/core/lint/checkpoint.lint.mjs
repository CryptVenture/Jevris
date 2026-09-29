import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/checkpoint.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('checkpoint product source does not import the kernel, the ledger, or a provider', () => {
  const repo = new URL('../../../', import.meta.url);
  const banned = [
    '@typesafe-ai/sdk',
    'ssot_docs/reference',
    'api.typesafe.ai',
    'fetch(',
    'kernel.js',
    'ledger.js',
    'evaluateChoice',
  ];
  for (const rel of ['packages/core/src/checkpoint.ts', 'packages/contracts/src/checkpoint.ts']) {
    const source = readFileSync(new URL(rel, repo), 'utf8');
    for (const needle of banned) {
      assert.equal(source.includes(needle), false, `${rel} contains ${needle}`);
    }
  }
  const runtime = readFileSync(new URL('packages/core/src/runtime.ts', repo), 'utf8');
  const kernel = readFileSync(new URL('packages/core/src/kernel.ts', repo), 'utf8');
  assert.equal(runtime.includes('checkpoint.js'), false);
  assert.equal(kernel.includes('checkpoint.js'), false);
});
