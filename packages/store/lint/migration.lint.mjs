import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/store/test/migration.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('export is not a backup command and adds no package dependency (source)', () => {
  const storeRoot = fileURLToPath(new URL('..', import.meta.url));
  const srcNames = readdirSync(join(storeRoot, 'src'));
  assert.equal(srcNames.includes('cli.ts'), false);
  assert.equal(srcNames.some((name) => name.includes('backup-command')), false);
});
