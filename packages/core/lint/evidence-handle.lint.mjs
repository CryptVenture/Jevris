import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/evidence-handle.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('compaction advice has no replacement summary and omissions restore mandatory ids (source)', () => {
  const root = repoRoot();
  const viewSrc = readFileSync(join(root, 'packages/contracts/src/evidence-view.ts'), 'utf8');
  assert.equal(viewSrc.includes('errorState'), true);
  assert.equal(viewSrc.includes('passthrough'), true);
  assert.equal(/\bsource\b/.test(viewSrc), false);
  const handleSrc = readFileSync(join(root, 'packages/core/src/evidence-handle.ts'), 'utf8');
  assert.equal(handleSrc.includes('distillToolOutput'), true);
  assert.equal(handleSrc.includes('importCapsuleClaim'), true);
  assert.equal(handleSrc.includes('node:crypto'), true);
  assert.equal(handleSrc.includes('replacementSummary'), false);
});
