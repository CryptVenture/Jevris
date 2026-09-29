import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const {
  STORE_PACKAGE_VERSION,
  openStore,
  commitOwned,
  readCommitted,
  closeStore,
  exportConsistent,
  assessCopy,
  automationRefusedGuard,
  putEvidence,
  reviseSource,
  insertInvalidationEdge,
  latestSchemaVersion,
} = await import('../dist/index.js');

const MONEY = 9007199254740993n;
const THROWN_TEXT = 'migration-threw-secret-text';

function tempDir() {
  return makeTempDir('jevris-store-migration-');
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

test('a failed migration leaves the current schema readable and refuses the next automation write', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'ledger.sqlite');
  const exported = join(dir, 'exported.sqlite');
  let ran = 0;
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const committed = commitOwned(opened, {
      decisionId: 'decA',
      operationId: 'opA',
      reservationMicroUsd: MONEY,
    });
    assert.equal(committed.ok, true);
    assert.equal(existsSync(dbPath + '-wal'), true);
    assert.equal(existsSync(dbPath + '-shm'), true);

    const copied = await exportConsistent(opened, exported);
    assert.equal(copied.ok, true);
    assert.equal(existsSync(exported), true);
    assert.equal(existsSync(exported + '-wal'), false);
    assert.equal(existsSync(exported + '-shm'), false);
    assert.equal(existsSync(dbPath + '-wal'), true);

    const emptyCopy = join(dir, 'naive-empty');
    mkdirSync(emptyCopy);
    assert.equal(assessCopy(dbPath, emptyCopy), 'inconsistent');
    const walOnly = join(dir, 'naive-wal');
    mkdirSync(walOnly);
    writeFileSync(join(walOnly, basename(dbPath) + '-wal'), '');
    assert.equal(assessCopy(dbPath, walOnly), 'inconsistent');
    const both = join(dir, 'naive-both');
    mkdirSync(both);
    writeFileSync(join(both, basename(dbPath) + '-wal'), '');
    writeFileSync(join(both, basename(dbPath) + '-shm'), '');
    assert.equal(assessCopy(dbPath, both), 'consistent');
    assert.equal(existsSync(dbPath + '-wal'), true);
    assert.equal(existsSync(dbPath + '-shm'), true);
    closeStore(opened);

    const fromExport = openTest(exported);
    assert.equal(fromExport.ok, true);
    if (!fromExport.ok) return;
    const exportedRow = readCommitted(fromExport, 'decA');
    assert.ok(exportedRow);
    assert.equal(typeof exportedRow.reservationMicroUsd, 'bigint');
    assert.equal(exportedRow.reservationMicroUsd, MONEY);
    closeStore(fromExport);

    const refused = openTest(dbPath, {
      extraMigrations: [
        (driver) => {
          ran += 1;
          driver
            .prepare('UPDATE schema_meta SET schema_version = 9, package_label = ? WHERE id = 1')
            .run('9.9.9');
          driver
            .prepare(
              'INSERT INTO decision_row (workspace_id, decision_id, operation_id, reservation_micro_usd) VALUES (?, ?, ?, ?)',
            )
            .run('wsA', 'decMigrated', 'opMigrated', 2n);
          throw new Error(THROWN_TEXT);
        },
      ],
    });
    assert.equal(ran, 1);
    assert.equal(refused.ok, true);
    if (!refused.ok) return;
    assert.equal(refused.schemaVersion, latestSchemaVersion());
    assert.equal(refused.packageVersion, '0.1.0');
    assert.equal(STORE_PACKAGE_VERSION, '0.1.0');
    assert.equal(readCommitted(refused, 'decMigrated'), undefined);
    const kept = readCommitted(refused, 'decA');
    assert.ok(kept);
    assert.equal(kept.reservationMicroUsd, MONEY);
    assert.deepEqual(automationRefusedGuard(refused), { ok: false, reason: 'migration-refused' });
    assert.deepEqual(putEvidence(refused, { evidenceId: 'evA' }), {
      ok: false,
      reason: 'migration-refused',
    });
    assert.deepEqual(reviseSource(refused, 'rev-a', 'rev-b'), {
      ok: false,
      reason: 'migration-refused',
    });
    assert.equal(typeof reviseSource(refused, 'rev-a', 'rev-b').reason, 'string');
    assert.notEqual(reviseSource(refused, 'rev-a', 'rev-b'), 'migration-refused');
    assert.deepEqual(insertInvalidationEdge(refused, { fromKey: 'rev-a' }), {
      ok: false,
      reason: 'migration-refused',
    });

    const next = commitOwned(refused, {
      decisionId: 'decNext',
      operationId: 'opNext',
      reservationMicroUsd: 4n,
    });
    assert.equal(next.ok, false);
    if (!next.ok) assert.equal(next.reason, 'migration-refused');
    assert.equal(typeof next, 'object');
    assert.equal(readCommitted(refused, 'decNext'), undefined);
    const fileText = readFileSync(dbPath).toString('utf8');
    assert.equal(fileText.includes(THROWN_TEXT), false);
    if (existsSync(dbPath + '-wal')) {
      assert.equal(readFileSync(dbPath + '-wal').toString('utf8').includes(THROWN_TEXT), false);
    }

    const afterRefusal = await exportConsistent(refused, join(dir, 'after-refusal.sqlite'));
    assert.equal(afterRefusal.ok, true);
    closeStore(refused);

    const again = openTest(dbPath);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.schemaVersion, latestSchemaVersion());
    assert.equal(again.packageVersion, '0.1.0');
    const replay = commitOwned(again, {
      decisionId: 'decReplay',
      operationId: 'opReplay',
      reservationMicroUsd: 5n,
    });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason, 'migration-refused');
    assert.equal(readCommitted(again, 'decReplay'), undefined);
    const still = readCommitted(again, 'decA');
    assert.ok(still);
    assert.equal(typeof still.reservationMicroUsd, 'bigint');
    assert.equal(still.reservationMicroUsd, MONEY);
    closeStore(again);
  } finally {
    removeTempDir(dir);
  }
});

test('export is not a backup command and adds no package dependency', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.dependencies['better-sqlite3'], '13.0.3');
  assert.equal(pkg.bin, undefined);
  const names = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies));
  // The only third-party dependency is better-sqlite3; @jevris/platform is the workspace leaf (BLD-06).
  assert.deepEqual(names.sort(), ['@jevris/platform', 'better-sqlite3']);
  assert.equal(pkg.dependencies['@jevris/platform'], '*');
  const storeRoot = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(existsSync(join(storeRoot, 'bin')), false);
});
