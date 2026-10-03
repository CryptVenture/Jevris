import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Command-line size (QA-07): the test and lint runners put every file they run on one `node --test`
// command line, and Windows refuses a command line over 32,767 characters (spawnSync fails with
// ENAMETOOLONG and no test runs: CI run 37153768310). Every such start goes through runTestFiles
// (scripts/test.mjs), which keeps each command line under a budget and splits a longer list into
// batches (scripts/argv-batches.mjs). A script that spawns `node --test` with a file list of its
// own would bring the same failure back as the suite grows. This reads scripts/ text, so it lives
// here and not in a test; test/test-runner-batches.test.mjs checks the sizes.
const root = fileURLToPath(new URL('..', import.meta.url));

/** The scripts that start `node --test` themselves, found by the spawn of process.execPath with '--test' first. */
export function directTestSpawns(files) {
  const found = [];
  for (const [name, text] of files) {
    if (/spawn(?:Sync)?\(\s*process\.execPath,\s*\[\s*'--test'/.test(text)) found.push(name);
  }
  return found.sort();
}

test('no script starts node --test with a file list of its own: they use runTestFiles, which batches (scripts/argv-batches.mjs)', () => {
  const dir = join(root, 'scripts');
  const files = new Map(readdirSync(dir).filter((name) => name.endsWith('.mjs')).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
  assert.deepEqual(directTestSpawns(files), [], 'a script that spawns node --test with files must call runTestFiles in scripts/test.mjs instead');
  assert.ok(files.has('argv-batches.mjs') && files.has('test.mjs'), 'the batching moved: update this lint');
  assert.match(files.get('test.mjs'), /export function runTestFiles\(/);
  assert.match(files.get('lint.mjs'), /runTestFiles\(/, 'the lint runner uses it too');
  assert.match(files.get('test.mjs'), /runTestFiles\(\{ parallel, serial, spawnOptions, runTemp/, 'the test runner starts its files through it');
});

test('the check finds a direct spawn', () => {
  assert.deepEqual(directTestSpawns(new Map([['a.mjs', "const r = spawnSync(process.execPath, ['--test', ...files], {});"], ['b.mjs', "spawn(process.execPath, [tsc, '-p'])"]])), ['a.mjs']);
});
