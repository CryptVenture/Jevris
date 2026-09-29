import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/observe.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('an empty destination returns the record and does not invent a path (source)', () => {
  const source = readFileSync(new URL('../src/observe.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('homedir'), false);
  assert.equal(source.includes('runLocalRuntime'), false);
});

test('PreModelSwitch records advice and emits no decision (source)', () => {
  const adapterSource = readFileSync(new URL('../src/hook-adapter.ts', import.meta.url), 'utf8');
  assert.equal(adapterSource.includes('runLocalRuntime'), false);
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.equal(indexSource.includes("from './observe.js'"), true);
  assert.equal(indexSource.includes('handleHookEvent'), true);
});

test('command hook descriptor is uninstalled and the adapter has no decision surface (source)', () => {
  const adapter = readFileSync(new URL('../src/hook-adapter.ts', import.meta.url), 'utf8');
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
    'runLocalRuntime',
    'kernel.js',
    'permissionDecision',
    'systemMessage',
    'additionalContext',
    'readObservationFile',
    'command-hook.json',
  ];
  for (const word of banned) {
    assert.equal(adapter.includes(word), false, word);
  }
});
