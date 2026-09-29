import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/loop-advice.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('loop-advice source does not import kernel, runtime, ledger, or a provider', () => {
  const source = readFileSync(new URL('../src/loop-advice.ts', import.meta.url), 'utf8');
  const banned = [
    './kernel.js',
    './runtime.js',
    './ledger.js',
    '@typesafe-ai/sdk',
    'ssot_docs/reference',
    'child_process',
    'fetch(',
    'api.typesafe.ai',
    'evaluateChoice',
  ];
  for (const item of banned) {
    assert.equal(source.includes(item), false, item);
  }
  const runtime = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  const kernel = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
  assert.equal(runtime.includes('loop-advice'), false);
  assert.equal(kernel.includes('loop-advice'), false);
});
