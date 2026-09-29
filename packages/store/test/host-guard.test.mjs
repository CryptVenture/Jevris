import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const {
  closeStore,
  issueLease,
  openGuardedStore,
  readWorkspaceLeases,
  readJobReservations,
  COPIED_HOST_SCOPE_IS_NOT_NFS_DETECTION,
} = await import('../dist/index.js');

function tempDir() {
  return makeTempDir('jevris-store-host-');
}

function openHost(path, hostScope) {
  return openGuardedStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope,
  });
}

test('a copied hostScope string is not NFS detection and the module does not listen', () => {
  assert.match(
    COPIED_HOST_SCOPE_IS_NOT_NFS_DETECTION,
    /copied hostScope string is not NFS detection/,
  );
  assert.equal(/network mount/i.test(COPIED_HOST_SCOPE_IS_NOT_NFS_DETECTION), false);
});

test('a second hostScope returns host-scope-mismatch and writes nothing', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'host.sqlite');
  try {
    const created = openHost(dbPath, 'host-a');
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const seeded = issueLease(created, {
      leaseId: 'leaseHost',
      taskId: 'taskHost',
      ownerId: 'ownerA',
      resourceKey: 'pkgHost',
      directory: join(dir, 'wt-host'),
      heartbeatAt: '1970-01-01T00:00:00Z',
      expiresAt: '1970-01-01T00:01:00Z',
    });
    assert.equal(seeded.ok, true);
    const before = readWorkspaceLeases(created, 'wsA').map((row) => row.leaseId);
    closeStore(created);

    const foreign = openHost(dbPath, 'host-b');
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.reason, 'host-scope-mismatch');
    let wrote = false;
    if (foreign.ok) {
      issueLease(foreign, {
        leaseId: 'leaseForeign',
        taskId: 'taskForeign',
        ownerId: 'ownerB',
        resourceKey: 'pkgForeign',
        directory: join(dir, 'wt-foreign'),
        heartbeatAt: '1970-01-01T00:00:00Z',
        expiresAt: '1970-01-01T00:01:00Z',
      });
      wrote = true;
    }
    assert.equal(wrote, false);

    const again = openHost(dbPath, 'host-a');
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.deepEqual(
      readWorkspaceLeases(again, 'wsA').map((row) => row.leaseId),
      before,
    );
    assert.equal(
      readWorkspaceLeases(again, 'wsA').some((row) => row.leaseId === 'leaseForeign'),
      false,
    );
    assert.equal(readJobReservations(again).length, 0);
    closeStore(again);
  } finally {
    removeTempDir(dir);
  }
});

test('a read for another workspace returns no leases from this workspace', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'tenant.sqlite');
  try {
    const opened = openHost(dbPath, 'host-a');
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const seeded = issueLease(opened, {
      leaseId: 'leaseTenant',
      taskId: 'taskTenant',
      ownerId: 'ownerA',
      resourceKey: 'pkgTenant',
      directory: join(dir, 'wt-tenant'),
      heartbeatAt: '1970-01-01T00:00:00Z',
      expiresAt: '1970-01-01T00:01:00Z',
    });
    assert.equal(seeded.ok, true);
    const other = readWorkspaceLeases(opened, 'wsB');
    assert.equal(other.length, 0);
    const own = readWorkspaceLeases(opened, 'wsA');
    assert.equal(own.length, 1);
    assert.equal(own[0].leaseId, 'leaseTenant');
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
