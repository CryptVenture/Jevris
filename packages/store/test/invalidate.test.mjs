import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const {
  openStore,
  closeStore,
  putEvidence,
  putReceipt,
  insertInvalidationEdge,
  reviseSource,
  listCurrent,
  listRetained,
  listEdges,
  publishCurrent,
} = await import('../dist/index.js');

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';

function tempDir() {
  return makeTempDir('jevris-store-invalidate-');
}

function openTest(path, extra) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
    ...extra,
  });
}

function rowById(result, id) {
  assert.equal(result.ok, true);
  if (!result.ok) return undefined;
  return result.rows.find((row) => row.id === id);
}

test('a source revision invalidates only the edged receipt and evidence', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'invalidate.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'rcptHit',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'rcptMiss',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    assert.equal(
      putEvidence(opened, {
        workspaceId: 'wsA',
        evidenceId: 'evHit',
        contentHash: 'hash-hit',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    assert.equal(
      putEvidence(opened, {
        workspaceId: 'wsA',
        evidenceId: 'evMiss',
        contentHash: 'hash-miss',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    assert.equal(
      insertInvalidationEdge(opened, {
        workspaceId: 'wsA',
        fromKind: 'source-revision',
        fromKey: 'rev-a',
        toKind: 'receipt',
        toId: 'rcptHit',
        resolved: 1,
      }).ok,
      true,
    );
    assert.equal(
      insertInvalidationEdge(opened, {
        workspaceId: 'wsA',
        fromKind: 'source-revision',
        fromKey: 'rev-a',
        toKind: 'evidence',
        toId: 'evHit',
        resolved: 1,
      }).ok,
      true,
    );

    const revised = reviseSource(opened, 'rev-a', 'rev-b');
    assert.equal(revised.ok, true);

    const current = listCurrent(opened, { workspaceId: 'wsA' });
    assert.equal(current.ok, true);
    assert.equal(rowById(current, 'rcptHit'), undefined);
    assert.equal(rowById(current, 'evHit'), undefined);
    const missed = rowById(current, 'rcptMiss');
    assert.ok(missed);
    assert.equal(missed.validity, 'current');
    const missedEvidence = rowById(current, 'evMiss');
    assert.ok(missedEvidence);
    assert.equal(missedEvidence.validity, 'current');
    assert.equal(missedEvidence.contentHash, 'hash-miss');

    const retained = listRetained(opened, { workspaceId: 'wsA' });
    const hit = rowById(retained, 'rcptHit');
    assert.ok(hit);
    assert.equal(hit.validity, 'invalidated');
    assert.equal(hit.sourceRevision, 'rev-a');
    const hitEvidence = rowById(retained, 'evHit');
    assert.ok(hitEvidence);
    assert.equal(hitEvidence.validity, 'invalidated');
    assert.equal(hitEvidence.contentHash, 'hash-hit');
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('an unresolved edge invalidates its receipt without a revision change', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'unresolved.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'rcptOpen',
        sourceRevision: 'rev-same',
      }).ok,
      true,
    );
    assert.equal(
      insertInvalidationEdge(opened, {
        workspaceId: 'wsA',
        fromKind: 'source-revision',
        fromKey: 'rev-same',
        toKind: 'receipt',
        toId: 'rcptOpen',
        resolved: 0,
      }).ok,
      true,
    );

    assert.equal(reviseSource(opened, 'rev-same', 'rev-same').ok, true);
    assert.equal(reviseSource(opened, 'rev-same', 'rev-same').ok, true);

    const current = listCurrent(opened, { workspaceId: 'wsA' });
    assert.equal(rowById(current, 'rcptOpen'), undefined);
    const retained = listRetained(opened, { workspaceId: 'wsA' });
    const row = rowById(retained, 'rcptOpen');
    assert.ok(row);
    assert.equal(row.validity, 'invalidated');

    const published = publishCurrent(opened, 'rcptOpen');
    assert.equal(published.ok, false);
    if (!published.ok) assert.equal(published.reason, 'refused');
    const still = rowById(listRetained(opened, { workspaceId: 'wsA' }), 'rcptOpen');
    assert.ok(still);
    assert.equal(still.validity, 'invalidated');
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a source body property is refused and the evidence row stores a hash', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'hash.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const refused = putEvidence(opened, {
      workspaceId: 'wsA',
      evidenceId: 'evBody',
      contentHash: 'hash-body',
      sourceRevision: 'rev-a',
      sourceBody: SOURCE_CANARY,
    });
    assert.deepEqual(refused, { ok: false, reason: 'source-body-refused' });
    assert.equal(rowById(listRetained(opened, { workspaceId: 'wsA' }), 'evBody'), undefined);

    const stored = putEvidence(opened, {
      workspaceId: 'wsA',
      evidenceId: 'evHash',
      contentHash: 'hash-kept',
      sourceRevision: 'rev-a',
    });
    assert.equal(stored.ok, true);
    const row = rowById(listRetained(opened, { workspaceId: 'wsA' }), 'evHash');
    assert.ok(row);
    assert.equal(row.kind, 'evidence');
    assert.equal(row.contentHash, 'hash-kept');
    assert.equal(row.sourceRevision, 'rev-a');
    assert.equal(JSON.stringify(row).includes(SOURCE_CANARY), false);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a refused migration makes reviseSource return migration-refused and inserts nothing', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'refused.sqlite');
  try {
    const seeded = openTest(dbPath);
    assert.equal(seeded.ok, true);
    if (!seeded.ok) return;
    assert.equal(
      putReceipt(seeded, {
        workspaceId: 'wsA',
        receiptId: 'rcptKept',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    closeStore(seeded);

    const refused = openTest(dbPath, {
      extraMigrations: [
        () => {
          throw new Error('migration-threw-secret-text');
        },
      ],
    });
    assert.equal(refused.ok, true);
    if (!refused.ok) return;
    assert.deepEqual(
      putEvidence(refused, {
        workspaceId: 'wsA',
        evidenceId: 'evNew',
        contentHash: 'hash-new',
        sourceRevision: 'rev-b',
      }),
      { ok: false, reason: 'migration-refused' },
    );
    assert.deepEqual(
      insertInvalidationEdge(refused, {
        workspaceId: 'wsA',
        fromKind: 'source-revision',
        fromKey: 'rev-a',
        toKind: 'receipt',
        toId: 'rcptKept',
        resolved: 1,
      }),
      { ok: false, reason: 'migration-refused' },
    );
    const revised = reviseSource(refused, 'rev-a', 'rev-b');
    assert.deepEqual(revised, { ok: false, reason: 'migration-refused' });
    assert.equal(typeof revised.reason, 'string');
    assert.notEqual(revised, 'migration-refused');

    const retained = listRetained(refused, { workspaceId: 'wsA' });
    const kept = rowById(retained, 'rcptKept');
    assert.ok(kept);
    assert.equal(kept.validity, 'current');
    assert.equal(retained.rows.filter((row) => row.kind === 'evidence').length, 0);
    const edges = listEdges(refused, { workspaceId: 'wsA' });
    assert.equal(edges.ok, true);
    if (edges.ok) assert.equal(edges.rows.length, 0);
    closeStore(refused);
  } finally {
    removeTempDir(dir);
  }
});

test('a caller-supplied lockfile key invalidates only its edged receipt', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'lockfile.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'lock-1',
        sourceRevision: 'lock-rev',
      }).ok,
      true,
    );
    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'other-1',
        sourceRevision: 'lock-rev',
      }).ok,
      true,
    );
    assert.equal(
      insertInvalidationEdge(opened, {
        workspaceId: 'wsA',
        fromKind: 'lockfile',
        fromKey: 'lock-rev',
        toKind: 'receipt',
        toId: 'lock-1',
        resolved: 1,
      }).ok,
      true,
    );
    assert.equal(reviseSource(opened, 'lock-rev', 'lock-next').ok, true);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'lock-1'), undefined);
    const other = rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'other-1');
    assert.ok(other);
    assert.equal(other.validity, 'current');
    const locked = rowById(listRetained(opened, { workspaceId: 'wsA' }), 'lock-1');
    assert.ok(locked);
    assert.equal(locked.validity, 'invalidated');
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a schema-version key invalidates only the receipt named by that edge', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'schema-key.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'rcptSchema',
        sourceRevision: 'schema-1',
      }).ok,
      true,
    );
    assert.equal(
      putReceipt(opened, {
        workspaceId: 'wsA',
        receiptId: 'rcptOther',
        sourceRevision: 'schema-1',
      }).ok,
      true,
    );
    assert.equal(
      insertInvalidationEdge(opened, {
        workspaceId: 'wsA',
        fromKind: 'schema-version',
        fromKey: 'schema-1',
        toKind: 'receipt',
        toId: 'rcptSchema',
        resolved: 1,
      }).ok,
      true,
    );
    assert.equal(reviseSource(opened, 'schema-1', 'schema-2').ok, true);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptSchema'), undefined);
    const other = rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptOther');
    assert.ok(other);
    assert.equal(other.validity, 'current');
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a workspace list does not return another workspace and a missing scope returns no rows', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'isolation.sqlite');
  try {
    const openedA = openTest(dbPath);
    assert.equal(openedA.ok, true);
    if (!openedA.ok) return;
    assert.equal(
      putReceipt(openedA, {
        workspaceId: 'wsA',
        receiptId: 'rcptA',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    assert.equal(
      putEvidence(openedA, {
        workspaceId: 'wsA',
        evidenceId: 'evA',
        contentHash: 'hash-a',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    closeStore(openedA);

    const openedB = openStore({
      path: dbPath,
      role: 'in-process-test',
      workspaceId: 'wsB',
      hostScope: 'host-a',
    });
    assert.equal(openedB.ok, true);
    if (!openedB.ok) return;
    assert.equal(
      putReceipt(openedB, {
        workspaceId: 'wsB',
        receiptId: 'rcptB',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );
    assert.equal(
      putEvidence(openedB, {
        workspaceId: 'wsB',
        evidenceId: 'evB',
        contentHash: 'hash-b',
        sourceRevision: 'rev-a',
      }).ok,
      true,
    );

    const listedB = listCurrent(openedB, { workspaceId: 'wsB' });
    assert.equal(rowById(listedB, 'rcptA'), undefined);
    assert.equal(rowById(listedB, 'evA'), undefined);
    assert.ok(rowById(listedB, 'rcptB'));
    assert.ok(rowById(listedB, 'evB'));
    const listedA = listCurrent(openedB, { workspaceId: 'wsA' });
    assert.ok(rowById(listedA, 'rcptA'));
    assert.ok(rowById(listedA, 'evA'));
    assert.equal(rowById(listedA, 'rcptB'), undefined);
    assert.equal(rowById(listedA, 'evB'), undefined);

    const omitted = listCurrent(openedB);
    assert.equal(omitted.ok, false);
    if (!omitted.ok) assert.equal(omitted.reason, 'refused');
    assert.equal(omitted.rows.length, 0);
    const blank = listCurrent(openedB, {});
    assert.equal(blank.ok, false);
    assert.equal(blank.rows.length, 0);
    const omittedRetained = listRetained(openedB);
    assert.equal(omittedRetained.ok, false);
    assert.equal(omittedRetained.rows.length, 0);

    const bare = putEvidence(openedB, {
      evidenceId: 'evBare',
      contentHash: 'hash-bare',
      sourceRevision: 'rev-a',
    });
    assert.deepEqual(bare, { ok: false, reason: 'refused' });
    assert.equal(rowById(listRetained(openedB, { workspaceId: 'wsB' }), 'evBare'), undefined);
    assert.equal(rowById(listRetained(openedB, { workspaceId: 'wsA' }), 'evBare'), undefined);
    closeStore(openedB);
  } finally {
    removeTempDir(dir);
  }
});
