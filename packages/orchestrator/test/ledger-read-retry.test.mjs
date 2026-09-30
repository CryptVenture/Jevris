// A record the ledger cannot open for a moment is not an absent record. On Windows a read that
// meets a file being replaced or scanned fails with EPERM, EBUSY or EACCES for a few milliseconds;
// the ledger read took that as "no record", so an approved check read back as unapproved and
// `jevris verify` ran nothing (surface e2e, windows-latest, a9ca080). The read now retries those
// codes as the write already does. POSIX stands in here: a record made unreadable (EACCES) for a
// moment by another thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openLedger } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

const root = typeof process.getuid === 'function' && process.getuid() === 0;

test('a ledger read that meets a record unreadable for a moment waits for it instead of reporting it absent', { skip: process.platform === 'win32' || root ? 'needs POSIX file modes and a non-root user' : false }, async () => {
  const dir = tempDir('jv-ledger-read-');
  const ledger = openLedger(dir, { staleMs: 600_000, lockWaitMs: 30_000 });
  await ledger.transact((tx) => tx.put('check-approvals', 'ws1', { hashes: { unit: 'h' } }));
  const folder = join(dir, 'check-approvals');
  const file = join(folder, readdirSync(folder).find((name) => name.endsWith('.json')));
  chmodSync(file, 0o000);
  // Another thread restores the mode while this one is inside the synchronous read.
  const worker = new Worker(`const { chmodSync } = require('node:fs'); const { workerData } = require('node:worker_threads'); setTimeout(() => chmodSync(workerData, 0o600), 30);`, { eval: true, workerData: file });
  await new Promise((resolve) => worker.once('online', resolve));
  try {
    assert.deepEqual(ledger.get('check-approvals', 'ws1'), { hashes: { unit: 'h' } });
  } finally {
    chmodSync(file, 0o600);
    await worker.terminate();
  }
});

test('a missing ledger record still reads as absent', async () => {
  const dir = tempDir('jv-ledger-read-');
  const ledger = openLedger(dir, { staleMs: 600_000, lockWaitMs: 30_000 });
  assert.equal(ledger.get('check-approvals', 'none'), undefined);
});
