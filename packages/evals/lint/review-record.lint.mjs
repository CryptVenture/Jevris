import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/evals/test/review-record.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

import { readdir } from 'node:fs/promises';

const root = repoRoot();

test('the evals source does not import a store writer, the TypeSafe client, or a process library', async () => {
  const srcDir = join(root, 'packages', 'evals', 'src');
  const names = (await readdir(srcDir)).filter((name) => name.endsWith('.ts'));
  assert.equal(names.length > 0, true);
  for (const name of names) {
    const text = await readFile(join(srcDir, name), 'utf8');
    assert.equal(text.includes('@jevris/store'), false, name);
    assert.equal(text.includes('@typesafe-ai/sdk'), false, name);
    assert.equal(text.includes('node:child_process'), false, name);
    assert.equal(text.includes('child_process'), false, name);
    assert.equal(/\bspawn(Sync)?\s*\(/.test(text), false, name);
  }
});
