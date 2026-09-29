// Source-text checks moved out of apps/cli/test/shared-config-safety.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the global installer has no sibling sweep of ~/.codex/hooks (FIX-16)', () => {
  const installSource = readFileSync(new URL('../src/global-harness.ts', import.meta.url), 'utf8');
  assert.equal(installSource.includes('removeHookSiblings'), false);
});
