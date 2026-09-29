// Source-text checks moved out of apps/cli/test/shadow.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the shadow module does not import the runtime, the hook adapter, or a child process', () => {
  const cliShadow = readFileSync(join(import.meta.dirname, '../src/shadow.ts'), 'utf8');
  const runtime = readFileSync(join(import.meta.dirname, '../../../packages/core/src/runtime.ts'), 'utf8');
  const banned = ['@typesafe-ai/sdk', 'api.typesafe.ai', 'runtime.js', 'hook-adapter.js', 'child_process'];
  for (const token of banned) {
    assert.equal(cliShadow.includes(token), false);
  }
  assert.equal(runtime.includes('shadow.js'), false);
});
