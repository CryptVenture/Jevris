// P5 (sidecar concurrency audit): snapshot hashing is asynchronous, cached by file identity,
// and bounded per snapshot, so a large dirty tree never holds the sidecar's event loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileHashStats, hashFileAsync, hashFilesAsync, resetFileHashCache, snapshotBudget, snapshotRevision } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
/** Moves a file's times into the past, out of the racy window. */
const settle = (path) => utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('a file hash is its sha256; an unchanged settled file is served from the cache, and a change is seen', async () => {
  resetFileHashCache();
  const dir = tempDir('jv-fh-');
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'one\n');
  settle(file);
  assert.equal(await hashFileAsync(file), sha('one\n'));
  assert.equal(await hashFileAsync(file), sha('one\n'));
  assert.deepEqual([fileHashStats().misses, fileHashStats().hits], [1, 1], 'the second read came from the cache');
  // Same size, new content and a new time: hashed again.
  writeFileSync(file, 'two\n');
  settle(file);
  utimesSync(file, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
  assert.equal(await hashFileAsync(file), sha('two\n'));
  assert.equal(await hashFileAsync(join(dir, 'nope')), 'missing');
  assert.equal(await hashFileAsync(dir), 'missing', 'a directory has no content hash');
});

test('a file written just now is hashed but not cached (the racy window); past the snapshot budget a file is named by size and time', async () => {
  resetFileHashCache();
  const dir = tempDir('jv-fh-');
  const fresh = join(dir, 'fresh.txt');
  writeFileSync(fresh, 'x');
  await hashFileAsync(fresh);
  await hashFileAsync(fresh);
  assert.deepEqual([fileHashStats().misses, fileHashStats().hits, fileHashStats().entries], [2, 0, 0]);
  const big = join(dir, 'big.bin');
  writeFileSync(big, Buffer.alloc(4096, 1));
  settle(big);
  const budget = snapshotBudget();
  budget.remaining = 1024;
  assert.match(await hashFileAsync(big, budget), /^unhashed:4096:\d+$/);
  assert.equal(budget.remaining, 1024, 'nothing was read');
  // In input order, whatever order the reads finish in.
  const paths = Array.from({ length: 9 }, (_, i) => join(dir, `f${String(i)}.txt`));
  paths.forEach((p, i) => writeFileSync(p, `file ${String(i)}`));
  assert.deepEqual(await hashFilesAsync(paths), paths.map((_, i) => sha(`file ${String(i)}`)));
});

test('the event loop keeps turning while a large untracked file is hashed for a snapshot, and the snapshot names its content hash', async () => {
  resetFileHashCache();
  const dir = tempDir('jv-fh-');
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const content = Buffer.alloc(24 * 1024 * 1024, 7);
  writeFileSync(join(repo, 'artifact.bin'), content);
  let turns = 0;
  let running = true;
  const spin = () => {
    turns += 1;
    if (running) setImmediate(spin);
  };
  setImmediate(spin);
  const snap = await snapshotRevision(repo);
  running = false;
  assert.ok(turns >= 3, `the loop turned ${String(turns)} times during the snapshot`);
  assert.deepEqual(snap.dirty.map((d) => [d.path, d.hash]), [['artifact.bin', sha(content)]]);
  // The same tree gives the same revision on a second snapshot.
  assert.equal((await snapshotRevision(repo)).revision, snap.revision);
});
