// The sidecar's lock files (the spawn lock a caller takes before it starts a sidecar, the daemon lock a
// sidecar holds) are read and removed by several processes at the same moment. On Windows an unlink
// then meets EPERM, EBUSY or EACCES while another process has the file open, and a removal that
// gave up at the first such error left a stale lock (or took a held one for stale). The removal now
// retries a transient error a few times with a short wait before the lock is treated as held; an
// unlink that works the first time costs nothing more. The file system is an injected stand-in that
// fails with those codes a few times and then removes the file for real, or never succeeds; the
// waits are recorded, never slept. Temporary folders only; no sidecar runs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { removeLockFile } = await import('../dist/lock-file.js');
const { releaseSpawnLock, takeSpawnLock } = await import('../dist/client.js');
const { releaseDaemonLock, takeDaemonLock } = await import('../dist/daemon.js');
const { runtimeFiles } = await import('../dist/index.js');

const bases = new Set();
after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

function scene() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jlf-')));
  bases.add(base);
  const files = runtimeFiles({ home: join(base, 'h') });
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  return files;
}

const coded = (code) => Object.assign(new Error(`${code}: stand-in`), { code });

/**
 * An unlink that fails with `codes[i]` on call i and then removes the file for real; `never` fails with
 * `codes` repeated for ever. `calls` counts every call, `pauses` the waits asked for.
 */
function flakyFs(codes, { never = false } = {}) {
  const state = { calls: 0, pauses: [] };
  return {
    state,
    deps: {
      unlinkSync: (path) => {
        const code = never ? codes[state.calls % codes.length] : codes[state.calls];
        state.calls += 1;
        if (code !== undefined) throw coded(code);
        unlinkSync(path);
      },
      pause: (ms) => state.pauses.push(ms),
    },
  };
}

const goneChild = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

// ------------------------------------------------------------------ removeLockFile

test('an unlink that works the first time costs nothing more: one call, no wait', () => {
  const files = scene();
  writeFileSync(files.spawnLock, '{}');
  const fs = flakyFs([]);
  assert.equal(removeLockFile(files.spawnLock, fs.deps), true);
  assert.deepEqual([fs.state.calls, fs.state.pauses], [1, []]);
  assert.equal(existsSync(files.spawnLock), false);
  // And with the real file system, no stand-in at all.
  writeFileSync(files.spawnLock, '{}');
  assert.equal(removeLockFile(files.spawnLock), true);
  assert.equal(existsSync(files.spawnLock), false);
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`${code} a few times, then the unlink works: the lock is removed after short waits`, () => {
    const files = scene();
    writeFileSync(files.spawnLock, '{}');
    const fs = flakyFs([code, code, code]);
    assert.equal(removeLockFile(files.spawnLock, fs.deps), true);
    assert.equal(fs.state.calls, 4);
    assert.deepEqual(fs.state.pauses, [5, 10, 20], 'a short, growing wait before each retry');
    assert.equal(existsSync(files.spawnLock), false);
  });
}

test('the codes can differ from one attempt to the next, and the last allowed attempt still counts', () => {
  const files = scene();
  writeFileSync(files.spawnLock, '{}');
  const fs = flakyFs(['EPERM', 'EBUSY', 'EACCES', 'EPERM']);
  assert.equal(removeLockFile(files.spawnLock, fs.deps), true, 'four errors, then the fifth attempt works');
  assert.deepEqual([fs.state.calls, fs.state.pauses], [5, [5, 10, 20, 40]]);
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`${code} on every attempt: the lock stays, nothing throws, and the wait is bounded`, () => {
    const files = scene();
    writeFileSync(files.spawnLock, '{}');
    const fs = flakyFs([code], { never: true });
    assert.equal(removeLockFile(files.spawnLock, fs.deps), false);
    assert.deepEqual([fs.state.calls, fs.state.pauses], [5, [5, 10, 20, 40]], 'five attempts and 75 ms at most');
    assert.equal(existsSync(files.spawnLock), true, 'the lock is left, as before: it is judged by its owner or its age');
  });
}

test('an error that is not transient is not retried: ENOENT (already gone) and anything else give up at once', () => {
  const files = scene();
  for (const code of ['ENOENT', 'EIO', 'EISDIR']) {
    const fs = flakyFs([code], { never: true });
    assert.equal(removeLockFile(files.spawnLock, fs.deps), false, code);
    assert.deepEqual([fs.state.calls, fs.state.pauses], [1, []], `${code}: one call, no wait`);
  }
  // A file that is not there, on the real file system.
  assert.equal(removeLockFile(files.spawnLock), false);
});

// ------------------------------------------------------------------ the spawn lock

/** A spawn lock a spawner left long ago: stale by its time stamp whatever its pid. */
function staleSpawnLock(files, via = 'service') {
  writeFileSync(files.spawnLock, JSON.stringify({ pid: process.pid, atMs: 0, via }), { mode: 0o600 });
}

test('taking the spawn lock replaces a stale one even when the first unlinks meet EPERM, EBUSY and EACCES', () => {
  const files = scene();
  staleSpawnLock(files, 'service');
  const fs = flakyFs(['EPERM', 'EBUSY', 'EACCES']);
  const taken = takeSpawnLock(files, 'spawn', fs.deps);
  assert.deepEqual(taken, { previousVia: 'service' }, 'the stale lock was replaced and says how it was made');
  assert.equal(fs.state.calls, 4);
  const lock = JSON.parse(readFileSync(files.spawnLock, 'utf8'));
  assert.deepEqual([lock.pid, lock.via], [process.pid, 'spawn'], 'the file is now this caller\'s');
});

test('a stale spawn lock that cannot be removed is held, not fatal: false, the lock is left untouched', () => {
  const files = scene();
  staleSpawnLock(files, 'spawn');
  const before = readFileSync(files.spawnLock, 'utf8');
  const fs = flakyFs(['EBUSY'], { never: true });
  assert.equal(takeSpawnLock(files, 'spawn', fs.deps), false);
  assert.equal(fs.state.calls, 5, 'the unlink was tried five times and then given up');
  assert.equal(readFileSync(files.spawnLock, 'utf8'), before);
});

test('a spawn lock that is not stale is never unlinked at all, so the retry costs nothing there either', () => {
  const files = scene();
  writeFileSync(files.spawnLock, JSON.stringify({ pid: process.pid, atMs: Date.now(), via: 'spawn' }), { mode: 0o600 });
  const fs = flakyFs([]);
  assert.equal(takeSpawnLock(files, 'spawn', fs.deps), false, 'held by a live, recent spawner');
  assert.equal(fs.state.calls, 0);
  // No lock at all: the exclusive create wins with no unlink.
  rmSync(files.spawnLock);
  assert.deepEqual(takeSpawnLock(files, 'spawn', fs.deps), { previousVia: undefined });
  assert.equal(fs.state.calls, 0);
});

test('releasing the spawn lock retries a transient error; one that never succeeds leaves the lock and does not throw', () => {
  const files = scene();
  writeFileSync(files.spawnLock, '{}');
  const flaky = flakyFs(['EPERM', 'EACCES']);
  releaseSpawnLock(files, flaky.deps);
  assert.equal(existsSync(files.spawnLock), false);
  assert.deepEqual([flaky.state.calls, flaky.state.pauses], [3, [5, 10]]);
  writeFileSync(files.spawnLock, '{}');
  const stuck = flakyFs(['EPERM'], { never: true });
  assert.doesNotThrow(() => releaseSpawnLock(files, stuck.deps));
  assert.equal(existsSync(files.spawnLock), true, 'the daemon removes it once it listens, or its age ends it');
  assert.equal(stuck.state.calls, 5);
});

// ------------------------------------------------------------------ the daemon lock

/** A daemon lock whose holder is gone: a stale lock another start may replace. */
function deadDaemonLock(files) {
  writeFileSync(files.lock, JSON.stringify({ pid: goneChild(), atMs: Date.now() }), { mode: 0o600 });
}

test('a start replaces a dead sidecar\'s lock even when the first unlinks meet EPERM, EBUSY and EACCES', () => {
  const files = scene();
  deadDaemonLock(files);
  const fs = flakyFs(['EBUSY', 'EPERM', 'EACCES']);
  try {
    assert.equal(takeDaemonLock(files, fs.deps), 'taken');
    assert.equal(fs.state.calls, 4);
    assert.equal(JSON.parse(readFileSync(files.lock, 'utf8')).pid, process.pid, 'the lock is now this sidecar\'s');
  } finally {
    releaseDaemonLock(files);
  }
  assert.equal(existsSync(files.lock), false, 'released');
});

test('a dead sidecar\'s lock that cannot be removed leaves this start held (it exits), after bounded retries', () => {
  const files = scene();
  deadDaemonLock(files);
  const fs = flakyFs(['EPERM'], { never: true });
  assert.equal(takeDaemonLock(files, fs.deps), 'held');
  assert.equal(fs.state.calls, 15, 'three attempts of five unlinks each');
  assert.equal(existsSync(files.lock), true);
  // The next start, with a file system that works, replaces it.
  try {
    assert.equal(takeDaemonLock(files), 'taken');
  } finally {
    releaseDaemonLock(files);
  }
});

test('releasing the daemon lock retries a transient error; one that never succeeds leaves a lock a dead pid names', () => {
  const files = scene();
  assert.equal(takeDaemonLock(files), 'taken');
  const flaky = flakyFs(['EACCES', 'EBUSY']);
  releaseDaemonLock(files, flaky.deps);
  assert.equal(existsSync(files.lock), false);
  assert.deepEqual([flaky.state.calls, flaky.state.pauses], [3, [5, 10]]);
  assert.equal(takeDaemonLock(files), 'taken');
  const stuck = flakyFs(['EPERM'], { never: true });
  assert.doesNotThrow(() => releaseDaemonLock(files, stuck.deps));
  assert.equal(existsSync(files.lock), true);
  assert.equal(stuck.state.calls, 5);
  // The file that stayed names this process, which has let go of it: a later start replaces it.
  assert.equal(takeDaemonLock(files), 'taken');
  releaseDaemonLock(files);
  assert.equal(existsSync(files.lock), false);
});
