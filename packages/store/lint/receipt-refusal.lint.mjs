import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/store/test/receipt-refusal.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('receipt validity stays current or invalidated', () => {
  const schema = readFileSync(join(repoRoot(), 'packages/store/src/schema.ts'), 'utf8');
  assert.equal(schema.includes("validity IN ('current', 'invalidated')"), true);
  assert.equal(schema.includes("'passed'"), false);
  assert.equal(schema.includes("'stale'"), false);
});

test('revision B does not inherit revision A receipts (source)', () => {
  const gate = readFileSync(join(repoRoot(), 'packages/store/src/receipt-gate.ts'), 'utf8');
  assert.equal(gate.includes('reviseSource'), true);
  assert.equal(gate.includes('markStale'), false);
  assert.equal(gate.includes("validity = 'stale'"), false);
  assert.equal(gate.includes("validity = 'passed'"), false);
});
