// The writer lock's holder is read by other processes. A read that meets a file held for a moment
// (Windows: EBUSY, EPERM, EACCES) made the holder "unreadable", so a live writer looked absent.
// POSIX stand-in for the hold: the file is unreadable (mode 000) until a worker thread restores it
// while the main thread waits inside the retrying read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const { acquireWriterLock, releaseWriterLock, writerLockHolder, writerLockPath } = await import('../dist/index.js');
const canTest = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

test('a holder read that meets an unreadable lock file retries, and finds the live holder', { skip: canTest ? false : 'needs POSIX permissions and a non-root user' }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-lock-busy-')));
  try {
    const db = join(dir, 'jevris.db');
    const got = acquireWriterLock(db, 'sidecar');
    assert.equal(got.ok, true, JSON.stringify(got));
    const lock = writerLockPath(db);
    chmodSync(lock, 0o000);
    // The worker says it is running (shared flag), then restores the mode 20 ms later, while this
    // thread sleeps inside the retry: the timing does not depend on how slow a worker starts.
    const flag = new Int32Array(new SharedArrayBuffer(4));
    new Worker(`const { workerData } = require('node:worker_threads'); const flag = new Int32Array(workerData.flag); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); setTimeout(() => require('node:fs').chmodSync(workerData.lock, 0o600), 20);`, { eval: true, workerData: { flag: flag.buffer, lock } });
    Atomics.wait(flag, 0, 0, 30_000);
    const holder = writerLockHolder(db);
    assert.equal(holder?.pid, process.pid, JSON.stringify(holder));
    releaseWriterLock(got.lock);
  } finally {
    try {
      chmodSync(join(dir, 'jevris.db.writer.lock'), 0o600);
    } catch {
      // not there
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
