import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/bounded-escalation.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('escalation does not launch a worker and does not weaken loop advice literals', () => {
  const source = readFileSync(new URL('../src/bounded-escalation.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('acceptRunnerReceipt'), true);
  assert.equal(source.includes('@anthropic-ai/claude-agent-sdk'), false);
  assert.equal(source.includes('child_process'), false);
  const loop = readFileSync(new URL('../../contracts/src/loop-advice.ts', import.meta.url), 'utf8');
  assert.equal(loop.includes('escalated: false'), true);
  assert.equal(loop.includes('verified: false'), true);
  assert.equal(loop.includes('testsPassed: false'), true);
  assert.equal(loop.includes('authorityGranted: false'), true);
});
