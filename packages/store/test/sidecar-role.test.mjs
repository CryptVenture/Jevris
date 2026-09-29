import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const { openStore, commitOwned, readCommitted, closeStore } = await import('../dist/index.js');

function tempDir() {
  return makeTempDir('jevris-store-sidecar-');
}

test('role sidecar is the production open and role library stays closed', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'ledger.sqlite');
  const closedPath = join(dir, 'library.sqlite');
  let loads = 0;
  try {
    const opened = openStore({
      path: dbPath,
      role: 'sidecar',
      workspaceId: 'wsA',
      hostScope: 'host-a',
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const committed = commitOwned(opened, {
      decisionId: 'decSidecar',
      operationId: 'opSidecar',
      reservationMicroUsd: 0n,
    });
    assert.equal(committed.ok, true);
    const row = readCommitted(opened, 'decSidecar');
    assert.ok(row);
    assert.equal(row.decisionId, 'decSidecar');
    assert.equal(row.operationId, 'opSidecar');
    assert.equal(row.decisionPresent, true);
    assert.equal(row.proposedActionPresent, true);
    assert.equal(row.outboxPresent, true);
    assert.equal(row.applied, false);
    closeStore(opened);

    const library = openStore({
      path: closedPath,
      role: 'library',
      workspaceId: 'wsA',
      hostScope: 'host-a',
      loadDriver() {
        loads += 1;
        throw new Error('must not load');
      },
    });
    assert.equal(library.ok, false);
    if (!library.ok) assert.equal(library.reason, 'production-writer-closed');
    assert.equal(loads, 0);
    assert.equal(existsSync(closedPath), false);
  } finally {
    removeTempDir(dir);
  }
});
