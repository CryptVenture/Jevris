import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './temp-dirs.mjs';


const { launchOwned } = await import('../dist/index.js');
const { openStore, closeStore, readLeases } = await import('@jevris/store');

const CHECKS = ['check-a', 'check-b'];

function launch(opened, dir, extra, sessionFactory) {
  return launchOwned({
    store: opened,
    leaseId: 'leaseLaunch',
    taskId: 'taskLaunch',
    ownerId: 'ownerA',
    resourceKey: 'pkgLaunch',
    directory: join(dir, 'wt-launch'),
    heartbeatAt: '1970-01-01T00:00:00Z',
    expiresAt: '1970-01-01T00:01:00Z',
    reservationId: 'jobLaunch',
    reservedMicroUsd: 6n,
    envelopeMicroUsd: 10n,
    revision: 'rev1',
    mandatoryCheckIds: CHECKS,
    sessionFactory,
    ...extra,
  });
}

test('launchOwned does not call the session factory when the reservation is refused', () => {
  const dir = tempDir('jevris-orchestrator-launch-');
  const dbPath = join(dir, 'launch.sqlite');
  let calls = 0;
  try {
    const opened = openStore({
      path: dbPath,
      role: 'in-process-test',
      workspaceId: 'wsA',
      hostScope: 'host-a',
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const numeric = launch(opened, dir, { reservedMicroUsd: 6, reservationId: 'jobNum', leaseId: 'leaseNum' }, () => {
      calls += 1;
      return { sessionId: 'must-not-run' };
    });
    assert.equal(numeric.ok, false);
    assert.equal(numeric.factoryCalled, false);
    assert.equal(numeric.reason, 'money-refused');
    assert.deepEqual([...numeric.mandatoryCheckIds], CHECKS);
    assert.equal(calls, 0);

    const first = launch(opened, dir, {}, () => {
      calls += 1;
      return { sessionId: 'owned-1' };
    });
    assert.equal(first.ok, true);
    assert.equal(first.factoryCalled, true);
    assert.deepEqual([...first.mandatoryCheckIds], CHECKS);
    assert.equal(calls, 1);
    assert.equal(readLeases(opened).length, 1);

    const refused = launch(
      opened,
      dir,
      {
        leaseId: 'leaseOver',
        taskId: 'taskOver',
        resourceKey: 'pkgOver',
        directory: join(dir, 'wt-over'),
        reservationId: 'jobOver',
        reservedMicroUsd: 5n,
      },
      () => {
        calls += 1;
        return { sessionId: 'must-not-run' };
      },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.factoryCalled, false);
    assert.equal(refused.reason, 'BUDGET');
    assert.deepEqual([...refused.mandatoryCheckIds], CHECKS);
    assert.equal(calls, 1);
    assert.equal(readLeases(opened).some((row) => row.leaseId === 'leaseOver'), false);
    closeStore(opened);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
