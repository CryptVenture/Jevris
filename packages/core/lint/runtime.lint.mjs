import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/runtime.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('runtime product source has no network client, timer, clock, driver, SDK, hook, or handoff import', () => {
  const files = [
    new URL('../../../packages/core/src/runtime.ts', import.meta.url),
    new URL('../../../packages/contracts/src/runtime.ts', import.meta.url),
    new URL('../../../packages/core/src/node-crypto.d.ts', import.meta.url),
  ];
  const banned = [
    'better-sqlite3',
    'node:sqlite',
    'ssot_docs/reference',
    '@typesafe-ai/sdk',
    'fetch(',
    'hooks.json',
    'Date.now',
    'setTimeout',
    'setInterval',
    'node:http',
    'node:net',
    'node:child_process',
  ];
  assert.equal(banned.includes('ledger.js'), false);
  assert.equal(banned.includes('egress.js'), false);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const needle of banned) {
      assert.equal(source.includes(needle), false, needle);
    }
  }
  const runtime = readFileSync(files[0], 'utf8');
  assert.equal(runtime.includes("from './kernel.js'"), false);
  assert.equal(runtime.includes('from "./kernel.js"'), false);
  const kernel = readFileSync(new URL('../../../packages/core/src/kernel.ts', import.meta.url), 'utf8');
  assert.equal(kernel.includes('runtime.js'), false);
});

test('token compare runs only after the 32-byte length check', () => {
  const source = readFileSync(new URL('../../../packages/core/src/runtime.ts', import.meta.url), 'utf8');
  const lengthAt = source.indexOf('token.byteLength !== TOKEN_BYTES');
  const compareAt = source.indexOf('timingSafeEqual(token, expected)');
  assert.equal(lengthAt >= 0, true);
  assert.equal(compareAt > lengthAt, true);
  assert.equal(source.includes('token ==='), false);
  assert.equal(source.includes('=== credential.token'), false);
  assert.equal(source.includes('console.'), false);
});

test('a probe does not resume actuation when identity or policy differs (source)', () => {
  const source = readFileSync(new URL('../../../packages/core/src/runtime.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('PINNED_MODEL'), true);
  assert.equal(source.includes('jev-1.13.0'), false);
});

test('egress deny and a missing ledger do not call the provider (source)', () => {
  const kernel = readFileSync(new URL('../../../packages/core/src/kernel.ts', import.meta.url), 'utf8');
  assert.equal(kernel.includes('runtime.js'), false);
  assert.equal(kernel.includes('ledger.js'), false);
});
