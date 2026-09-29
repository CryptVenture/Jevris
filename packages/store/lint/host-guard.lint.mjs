import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/store/test/host-guard.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('a copied hostScope string is not NFS detection and the module does not listen (source)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/host-guard.ts', import.meta.url)),
    'utf8',
  );
  assert.equal(source.includes('listen('), false);
  assert.equal(source.includes('node:net'), false);
  assert.equal(source.includes('node:sqlite'), false);
});
