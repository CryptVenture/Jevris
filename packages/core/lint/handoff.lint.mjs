import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/handoff.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('CAPSULE_KEYS does not gain a transcript key and import does not call the hook adapter', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/checkpoint.ts'), 'utf8');
  const keysStart = source.indexOf('const CAPSULE_KEYS = [');
  const keysEnd = source.indexOf('] as const;', keysStart);
  const keys = source.slice(keysStart, keysEnd);
  assert.equal(keys.includes('transcript'), false);
  const start = source.indexOf('export function importPortableCapsule');
  assert.equal(start >= 0, true);
  const next = source.indexOf('\nexport ', start + 1);
  const body = source.slice(start, next === -1 ? source.length : next);
  assert.equal(body.includes('handleHookEvent'), false);
  assert.equal(body.includes('spawn'), false);
});
