// Source-text checks moved out of apps/cli/test/shortlist.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the CLI shortlist module calls core and does not spawn or open a socket', async () => {
  const source = await readFile(new URL('../src/shortlist.ts', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.equal(source.includes("from '@jevris/core'"), true);
  assert.equal(source.includes('shortlistInstalledSkills'), true);
  assert.equal(source.includes('shortlistEvidence'), true);
  assert.equal(source.includes('formatShortlist'), true);
  for (const banned of ['child_process', 'node:http', 'node:net', 'node:https', 'spawn(', 'execFile(']) {
    assert.equal(source.includes(banned), false, banned);
  }
  for (const flag of ['home:', 'source:', 'enable:', 'platform:', "'harness-version':", "'node-version':"]) {
    assert.equal(cli.includes(flag), true, flag);
  }
});
