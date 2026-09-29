import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const { openStore, commitOwned, readCommitted, closeStore, STORE_PACKAGE_VERSION, latestSchemaVersion } = await import(
  '../dist/index.js'
);

const MONEY = 9007199254740993n;
const SIGNED_MAX = 9223372036854775807n;

function tempDir() {
  return makeTempDir('jevris-store-');
}

function openTest(path, workspaceId) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId,
    hostScope: 'host-a',
  });
}

test('in-process commit stores decision, proposed action, and outbox with bigint micro-USD', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'ledger.sqlite');
  try {
    const opened = openTest(dbPath, 'wsA');
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.journalMode, 'wal');
    assert.equal(opened.foreignKeys, 'on');
    assert.equal(opened.busyTimeout, 2000);
    assert.equal(opened.schemaVersion, latestSchemaVersion());
    assert.equal(STORE_PACKAGE_VERSION, '0.1.0');
    assert.equal(opened.packageVersion, STORE_PACKAGE_VERSION);
    assert.notEqual(opened.schemaVersion, STORE_PACKAGE_VERSION);

    const committed = commitOwned(opened, {
      decisionId: 'decA',
      operationId: 'opA',
      reservationMicroUsd: MONEY,
    });
    assert.equal(committed.ok, true);
    const row = readCommitted(opened, 'decA');
    assert.ok(row);
    assert.equal(row.decisionId, 'decA');
    assert.equal(row.operationId, 'opA');
    assert.equal(row.decisionPresent, true);
    assert.equal(row.proposedActionPresent, true);
    assert.equal(row.outboxPresent, true);
    assert.equal(row.applied, false);
    assert.equal(row.nonOwnedBilling, 'unknown');
    assert.equal(typeof row.reservationMicroUsd, 'bigint');
    assert.notEqual(typeof row.reservationMicroUsd, 'number');
    assert.equal(row.reservationMicroUsd, MONEY);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('child process restart reads the same three rows and bigint', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'restart.sqlite');
  const childPath = join(dir, 'child.mjs');
  const storeUrl = new URL('../dist/index.js', import.meta.url).href;
  writeFileSync(
    childPath,
    `import { openStore, commitOwned, closeStore } from ${JSON.stringify(storeUrl)};
const dbPath = process.argv[2];
const opened = openStore({
  path: dbPath,
  role: 'in-process-test',
  workspaceId: 'wsA',
  hostScope: 'host-a',
});
if (!opened.ok) {
  console.error(opened.reason);
  process.exit(2);
}
const committed = commitOwned(opened, {
  decisionId: 'decRestart',
  operationId: 'opRestart',
  reservationMicroUsd: 9007199254740993n,
});
if (!committed.ok) {
  console.error(committed.reason);
  process.exit(3);
}
closeStore(opened);
process.exit(0);
`,
  );
  try {
    const executable = process.execPath;
    const child = spawnSync(executable, [childPath, dbPath], { encoding: 'utf8' });
    assert.equal(executable, process.execPath);
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);

    const reopened = openTest(dbPath, 'wsA');
    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    const row = readCommitted(reopened, 'decRestart');
    assert.ok(row);
    assert.equal(row.decisionId, 'decRestart');
    assert.equal(row.operationId, 'opRestart');
    assert.equal(row.decisionPresent, true);
    assert.equal(row.proposedActionPresent, true);
    assert.equal(row.outboxPresent, true);
    assert.equal(typeof row.reservationMicroUsd, 'bigint');
    assert.equal(row.reservationMicroUsd, MONEY);
    assert.equal(row.applied, false);
    assert.equal(row.nonOwnedBilling, 'unknown');
    closeStore(reopened);

    const other = openTest(dbPath, 'wsB');
    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(readCommitted(other, 'decRestart'), undefined);
    closeStore(other);
  } finally {
    removeTempDir(dir);
  }
});

test('a thrown commit callback inserts none of the three rows', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'rollback.sqlite');
  try {
    const opened = openTest(dbPath, 'wsA');
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.throws(() => {
      commitOwned(
        opened,
        {
          decisionId: 'decThrow',
          operationId: 'opThrow',
          reservationMicroUsd: 1n,
        },
        () => {
          throw new Error('rollback');
        },
      );
    });
    assert.equal(readCommitted(opened, 'decThrow'), undefined);
    closeStore(opened);

    const again = openTest(dbPath, 'wsA');
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(readCommitted(again, 'decThrow'), undefined);
    closeStore(again);
  } finally {
    removeTempDir(dir);
  }
});

test('a number, a negative bigint, and an overflow bigint insert nothing', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'money.sqlite');
  try {
    const opened = openTest(dbPath, 'wsA');
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const refused = [
      1,
      9007199254740993,
      -1n,
      SIGNED_MAX + 1n,
    ];
    for (const reservationMicroUsd of refused) {
      const result = commitOwned(opened, {
        decisionId: 'decBad',
        operationId: 'opBad',
        reservationMicroUsd,
      });
      assert.equal(result.ok, false);
    }
    assert.equal(readCommitted(opened, 'decBad'), undefined);
    const body = commitOwned(opened, {
      decisionId: 'decBody',
      operationId: 'opBody',
      reservationMicroUsd: 1n,
      sourceBody: 'do-not-store',
    });
    assert.equal(body.ok, false);
    assert.equal(readCommitted(opened, 'decBody'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a second in-process open of the same path cannot write', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'busy.sqlite');
  try {
    const first = openTest(dbPath, 'wsA');
    assert.equal(first.ok, true);
    const second = openTest(dbPath, 'wsA');
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, 'writer-busy');
    let wrote = false;
    if (second.ok) {
      commitOwned(second, {
        decisionId: 'decBusy',
        operationId: 'opBusy',
        reservationMicroUsd: 1n,
      });
      wrote = true;
    }
    assert.equal(wrote, false);
    if (first.ok) {
      assert.equal(readCommitted(first, 'decBusy'), undefined);
      closeStore(first);
    }
  } finally {
    removeTempDir(dir);
  }
});
