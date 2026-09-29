import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/ledger.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('ledger product sources do not install a hidden provider or a stop hook', () => {
  const ledger = readFileSync(new URL('../src/ledger.ts', import.meta.url), 'utf8');
  const contracts = readFileSync(new URL('../../contracts/src/ledger.ts', import.meta.url), 'utf8');
  const banned = [
    'better-sqlite3',
    'node:sqlite',
    'ssot_docs/reference',
    '@typesafe-ai/sdk',
    'fetch(',
    'hooks.json',
    'Date.now',
    'setTimeout',
    'node:child_process',
  ];
  for (const source of [ledger, contracts]) {
    for (const needle of banned) {
      assert.equal(source.includes(needle), false);
    }
  }
  const kernel = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
  assert.equal(kernel.includes('ledger.js'), false);
  assert.equal((kernel.match(/persisted: false/g) || []).length, 1);
});
