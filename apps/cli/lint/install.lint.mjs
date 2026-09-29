// Source-text checks moved out of apps/cli/test/install.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('main uninstall does not spawn a process', () => {
  const source = read('uninstall.ts');
  const cli = read('cli.ts');
  assert.equal(source.includes('node:child_process'), false);
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('spawn('), false);
  assert.equal(source.includes('execFile'), false);
  assert.equal(source.includes('plugin uninstall'), false);
  assert.equal(cli.includes('process.platform'), true);
  assert.equal(cli.includes('node:child_process'), false);
  assert.equal(cli.includes('plugin uninstall'), false);
});

test('uninstall leaves the .jevris canary until data delete and does not call it', () => {
  const source = read('uninstall.ts');
  const start = source.indexOf('export async function uninstallPlugin');
  const end = source.indexOf('export async function deleteJevrisData');
  assert.equal(start >= 0 && end > start, true);
  assert.equal(source.slice(start, end).includes('deleteJevrisData'), false);
});

test('observe install copies files without a process and gemini is retired', () => {
  const installSource = read('install.ts');
  assert.equal(installSource.includes('child_process'), false);
  assert.equal(installSource.includes('@antigravity/jevris'), false);
});
