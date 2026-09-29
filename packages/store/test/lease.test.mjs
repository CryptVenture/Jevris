import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const { openStore, closeStore, commitOwned, publishCurrent, issueLease, recordStaleResult, readLeases, readLeaseEvidence } =
  await import('../dist/index.js');

function tempDir() {
  return makeTempDir('jevris-store-lease-');
}

function openTest(path) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
  });
}

function leaseInput(leaseId, taskId, directory, resourceKey = 'lockfile') {
  return {
    leaseId,
    taskId,
    ownerId: 'ownerA',
    resourceKey,
    directory,
    heartbeatAt: '2026-09-25T00:00:00Z',
    expiresAt: '2026-09-25T00:00:01Z',
  };
}

test('an expired fence is stale evidence, cannot publish, and the next token is a larger bigint', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'lease.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const committed = commitOwned(opened, {
      decisionId: 'decCurrent',
      operationId: 'opCurrent',
      reservationMicroUsd: 1n,
      remainingMicroUsd: 100n,
      questions: 1,
      attempts: 1,
      usage: { known: true, inputTokens: 1, outputTokens: 1 },
      consumedMicroUsd: 1n,
    });
    assert.equal(committed.ok, true);

    const first = issueLease(opened, leaseInput('leaseA', 'taskA', '/tmp/jevris-lease-a'));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(typeof first.fencingToken, 'bigint');
    assert.equal(first.fencingToken, 1n);
    assert.notEqual(typeof first.fencingToken, 'number');
    assert.equal(first.state, 'leased');
    assert.equal(first.worktreeId.length > 0, true);

    const coLeased = issueLease(opened, leaseInput('leaseB', 'taskB', '/tmp/jevris-lease-b'));
    assert.equal(coLeased.ok, false);
    if (!coLeased.ok) assert.equal(coLeased.reason, 'refused');

    const stale = recordStaleResult(opened, {
      leaseId: 'leaseA',
      decisionId: 'decCurrent',
      fencingToken: first.fencingToken,
      evidenceId: 'evStale',
      body: 'SECRET_CANARY_do_not_store',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'refused');
    assert.equal(stale.validity, 'stale');
    assert.equal(stale.published, false);
    assert.equal(stale.leaseState, 'blocked');
    assert.notEqual(stale.taskState, 'verified');
    assert.equal(stale.successor.state, 'ready');
    assert.notEqual(stale.successor.worktreeId, first.worktreeId);
    assert.notEqual(stale.successor.directory, first.directory);

    const published = publishCurrent(opened, 'decCurrent');
    assert.equal(published.ok, false);
    if (!published.ok) assert.equal(published.reason, 'refused');

    const rows = readLeases(opened);
    assert.equal(rows.some((row) => row.state === 'verified'), false);
    assert.equal(rows.some((row) => row.leaseId === 'leaseA' && row.state === 'blocked'), true);
    const evidence = readLeaseEvidence(opened);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].validity, 'stale');
    assert.equal(evidence[0].fencingToken, 1n);
    assert.equal(evidence[0].body.includes('SECRET_CANARY_do_not_store'), false);

    const reused = issueLease(opened, leaseInput('leaseC', 'taskA', first.directory, 'pkgC'));
    assert.equal(reused.ok, false);

    const next = issueLease(opened, leaseInput('leaseD', 'taskA', '/tmp/jevris-lease-d', 'pkgD'));
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(typeof next.fencingToken, 'bigint');
    assert.equal(next.fencingToken > first.fencingToken, true);
    assert.notEqual(next.worktreeId, first.worktreeId);
    assert.notEqual(next.worktreeId, stale.successor.worktreeId);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
