import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_TARGETS, expandTargets, parseArgs } from '../scripts/repeat-tests.mjs';

test('repeat-tests defaults to 20 runs of the hook and sidecar suites (QA-05)', () => {
  const options = parseArgs([]);
  assert.equal(options.runs, 20);
  assert.deepEqual(options.targets, DEFAULT_TARGETS);
  assert.deepEqual(parseArgs(['--runs', '3', 'test/qa']).targets, ['test/qa']);
  assert.throws(() => parseArgs(['--runs', '0']), /--runs/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('repeat-tests expands a directory to its test files and refuses a missing target (QA-05)', () => {
  const files = expandTargets(['test/qa']).map((file) => file.split('\\').join('/'));
  assert.ok(files.length >= 3);
  assert.ok(files.every((file) => file.startsWith('test/qa/') && file.endsWith('.test.mjs')));
  assert.throws(() => expandTargets(['test/no-such-dir']), /no such test target/);
});

test('the stability workflow runs the suites 20 times on all nine cells with no secrets (QA-05)', () => {
  const text = readFileSync(new URL('../.github/workflows/stability.yml', import.meta.url), 'utf8');
  assert.match(text, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(text, /node: \['22\.14\.0', '24', 'latest'\]/);
  assert.match(text, /node scripts\/repeat-tests\.mjs --runs "\$RUNS"/);
  assert.match(text, /default: 20/);
  assert.doesNotMatch(text, /\$\{\{[^}]*secrets\./);
});
