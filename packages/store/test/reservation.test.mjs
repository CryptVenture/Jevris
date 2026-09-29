import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const {
  openStore,
  closeStore,
  readCommitted,
  readLeases,
  admitJobReservation,
  leaseAndReserve,
  readJobReservations,
} = await import('../dist/index.js');

const CHECKS = ['check-a', 'check-b'];

function tempDir() {
  return makeTempDir('jevris-store-reservation-');
}

function openTest(path) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
  });
}

function job(reservationId, reservedMicroUsd, extra) {
  return {
    reservationId,
    ownerId: 'ownerA',
    reservedMicroUsd,
    revision: 'rev1',
    ...extra,
  };
}

test('two competing jobs admit at most the affordable set and the loser is BUDGET', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'compete.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const admitted = admitJobReservation(opened, {
      envelopeMicroUsd: 10n,
      revision: 'rev1',
      mandatoryCheckIds: CHECKS,
      jobs: [job('jobA', 6n, { ownerId: 'ownerA' }), job('jobB', 5n, { ownerId: 'ownerB' })],
    });
    assert.equal(admitted.ok, true);
    assert.deepEqual(admitted.admitted, ['jobA']);
    assert.equal(admitted.refused.length, 1);
    assert.equal(admitted.refused[0].reservationId, 'jobB');
    assert.equal(admitted.refused[0].reason, 'BUDGET');
    assert.deepEqual([...admitted.mandatoryCheckIds], CHECKS);
    const rows = readJobReservations(opened);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reservationId, 'jobA');
    assert.equal(rows[0].reservedMicroUsd, 6n);
    assert.equal(typeof rows[0].reservedMicroUsd, 'bigint');
    assert.equal(rows[0].state, 'reserved');
    assert.equal(readCommitted(opened, 'jobA'), undefined);
    assert.equal(readCommitted(opened, 'jobB'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('uncertain usage blocks the next admission even when the envelope has room', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'uncertain.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const recorded = admitJobReservation(opened, {
      reservationId: 'jobUnknown',
      ownerId: 'ownerA',
      reservedMicroUsd: 1n,
      envelopeMicroUsd: 100n,
      revision: 'rev1',
      state: 'uncertain',
      mandatoryCheckIds: CHECKS,
    });
    assert.equal(recorded.ok, true);
    const stored = readJobReservations(opened).find((row) => row.reservationId === 'jobUnknown');
    assert.ok(stored);
    assert.equal(stored.state, 'uncertain');
    assert.equal(readCommitted(opened, 'jobUnknown'), undefined);
    const next = admitJobReservation(opened, {
      reservationId: 'jobNext',
      ownerId: 'ownerA',
      reservedMicroUsd: 1n,
      envelopeMicroUsd: 100n,
      revision: 'rev1',
      mandatoryCheckIds: CHECKS,
    });
    assert.equal(next.ok, false);
    if (!next.ok) assert.equal(next.reason, 'BUDGET');
    assert.deepEqual([...next.mandatoryCheckIds], CHECKS);
    assert.equal(
      readJobReservations(opened).some((row) => row.reservationId === 'jobNext'),
      false,
    );
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a JavaScript number is money-refused and is not stored as a decision row', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'number.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const refused = admitJobReservation(opened, {
      reservationId: 'jobNum',
      ownerId: 'ownerA',
      reservedMicroUsd: 6,
      envelopeMicroUsd: 10n,
      revision: 'rev1',
      mandatoryCheckIds: CHECKS,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'money-refused');
    assert.deepEqual([...refused.mandatoryCheckIds], CHECKS);
    assert.equal(readJobReservations(opened).length, 0);
    assert.equal(readCommitted(opened, 'jobNum'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('an over-envelope refusal returns the submitted mandatory check ids unchanged', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'over.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const refused = admitJobReservation(opened, {
      reservationId: 'jobOver',
      ownerId: 'ownerA',
      reservedMicroUsd: 11n,
      envelopeMicroUsd: 10n,
      revision: 'rev1',
      mandatoryCheckIds: CHECKS,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'BUDGET');
    assert.deepEqual([...refused.mandatoryCheckIds], CHECKS);
    assert.equal(refused.mandatoryCheckIds.length, 2);
    assert.equal(readJobReservations(opened).length, 0);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a refused reservation does not commit the lease', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'lease.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const refused = leaseAndReserve(opened, {
      leaseId: 'leaseOver',
      taskId: 'taskOver',
      ownerId: 'ownerA',
      resourceKey: 'pkgOver',
      directory: join(dir, 'wt-over'),
      heartbeatAt: '1970-01-01T00:00:00Z',
      expiresAt: '1970-01-01T00:01:00Z',
      reservationId: 'jobOver',
      reservedMicroUsd: 11n,
      envelopeMicroUsd: 10n,
      revision: 'rev1',
      mandatoryCheckIds: CHECKS,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'BUDGET');
    assert.deepEqual([...refused.mandatoryCheckIds], CHECKS);
    assert.equal(readLeases(opened).length, 0);
    assert.equal(readJobReservations(opened).length, 0);
    const kept = leaseAndReserve(opened, {
      leaseId: 'leaseKeep',
      taskId: 'taskKeep',
      ownerId: 'ownerA',
      resourceKey: 'pkgKeep',
      directory: join(dir, 'wt-keep'),
      heartbeatAt: '1970-01-01T00:00:00Z',
      expiresAt: '1970-01-01T00:01:00Z',
      reservationId: 'jobKeep',
      reservedMicroUsd: 6n,
      envelopeMicroUsd: 10n,
      revision: 'rev1',
      mandatoryCheckIds: CHECKS,
    });
    assert.equal(kept.ok, true);
    assert.deepEqual([...kept.mandatoryCheckIds], CHECKS);
    assert.equal(readLeases(opened).length, 1);
    assert.equal(readJobReservations(opened).length, 1);
    assert.equal(readCommitted(opened, 'jobKeep'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
