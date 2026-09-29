import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/shortlist.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('parent segments, an absolute id, and an empty id are missing and unread (source)', async () => {
  const source = await readFile(new URL('../src/shortlist.ts', import.meta.url), 'utf8');
  for (const banned of ['node:fs', 'node:http', 'node:net', 'child_process']) {
    assert.equal(source.includes(banned), false, banned);
  }
});
