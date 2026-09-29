// P2 (sidecar concurrency audit, owner ededdba; agreed with D): D's hook-path collections in the
// store. Writes are atomic to a buffer, readable at once, and committed within the flush window
// or at close; retention follows decisionRetentionDays by last write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DAY = 86_400_000;
const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openTemp() {
  const dir = makeTempDir('jevris-store-hook-records-');
  dirs.push(dir);
  const path = join(dir, 'jevris.db');
  const open = () => s.openStore({ path, role: 'sidecar', workspaceId: 'wsA', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  const store = open();
  assert.equal(store.ok, true, JSON.stringify(store));
  return { store, open, path };
}

/** Rows a second connection sees: only what was committed. */
function committedKeys(path, collection) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT key FROM hook_records WHERE collection = ? ORDER BY key').all(collection).map((row) => row.key);
  } finally {
    db.close();
  }
}

test('the store is at schema 8 with hook_records, and the class follows decision retention', (t) => {
  const { store } = openTemp();
  assert.ok(s.latestSchemaVersion() >= 8);
  assert.equal(store.schemaVersion, s.latestSchemaVersion());
  assert.equal(s.HOOK_RECORDS_RETENTION.table, 'hook_records');
  assert.equal(s.HOOK_RECORDS_RETENTION.window, 'decisionRetentionDays');
  s.closeStore(store);
});

test('a transaction is readable at once, all-or-nothing, and committed within the window or at close', async (t) => {
  const { store, open, path } = openTemp();
  const ledger = s.hookLedger(store, { flushMs: 50 });
  await ledger.transact((tx) => {
    tx.put('loop-signals', 'b', { n: 2 });
    tx.put('loop-signals', 'a', { n: 1 });
    assert.deepEqual(tx.get('loop-signals', 'a'), { n: 1 }, 'a transaction reads its own write');
    assert.deepEqual(tx.list('loop-signals'), [{ n: 1 }, { n: 2 }]);
  });
  assert.deepEqual(ledger.get('loop-signals', 'a'), { n: 1 }, 'readable before the commit');
  assert.deepEqual(ledger.list('loop-signals'), [{ n: 1 }, { n: 2 }], 'sorted by key');
  assert.equal(s.hookRecordsPending(store).records, 2);
  assert.deepEqual(committedKeys(path, 'loop-signals'), [], 'nothing is committed before the window');

  await assert.rejects(
    ledger.transact((tx) => {
      tx.put('loop-signals', 'c', { n: 3 });
      tx.delete('loop-signals', 'a');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(ledger.get('loop-signals', 'c'), undefined, 'a throwing transaction writes nothing');
  assert.deepEqual(ledger.get('loop-signals', 'a'), { n: 1 });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(s.hookRecordsPending(store).records, 0, 'the timer committed the buffer');
  assert.deepEqual(committedKeys(path, 'loop-signals'), ['a', 'b'], 'in one batch');

  await ledger.transact((tx) => {
    tx.delete('loop-signals', 'b');
    tx.put('stop-reports', 'r1', { stop: 1 });
  });
  assert.deepEqual(ledger.list('loop-signals'), [{ n: 1 }], 'a buffered delete hides the committed row');
  s.closeStore(store);

  const again = open();
  assert.equal(again.ok, true);
  const reread = s.hookLedger(again);
  assert.deepEqual(reread.list('loop-signals'), [{ n: 1 }], 'the close committed the delete');
  assert.deepEqual(reread.get('stop-reports', 'r1'), { stop: 1 }, 'and the put');
  s.closeStore(again);
});

test('an aborted signal refuses before the function runs; bad input is refused', async (t) => {
  const { store } = openTemp();
  const ledger = s.hookLedger(store);
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  await assert.rejects(ledger.transact(() => { ran = true; }, { signal: controller.signal }), /lock wait aborted/);
  assert.equal(ran, false);
  await assert.rejects(ledger.transact((tx) => tx.put('Bad_Collection', 'k', 1)), /invalid collection/);
  await assert.rejects(ledger.transact((tx) => tx.put('loop-signals', '', 1)), /invalid key/);
  await assert.rejects(ledger.transact((tx) => tx.put('loop-signals', 'k', 'x'.repeat(s.MAX_HOOK_RECORD_BYTES))), /record too large/);
  await assert.rejects(ledger.transact((tx) => tx.put('loop-signals', 'k', () => 1)), /not JSON/);
  await assert.rejects(ledger.transact(async () => 1), /synchronous/);
  assert.equal(s.hookRecordsPending(store).records, 0, 'no refused transaction reached the buffer');
  s.closeStore(store);
});

test('workspaces do not see each other, and a view writes its own workspace', async (t) => {
  const { store } = openTemp();
  const view = s.workspaceView(store, 'wsB');
  assert.ok(view);
  await s.hookLedger(store).transact((tx) => tx.put('restores', 'k', { ws: 'A' }));
  await s.hookLedger(view).transact((tx) => tx.put('restores', 'k', { ws: 'B' }));
  assert.equal(s.flushHookRecords(store), true);
  assert.deepEqual(s.hookLedger(store).get('restores', 'k'), { ws: 'A' });
  assert.deepEqual(s.hookLedger(view).get('restores', 'k'), { ws: 'B' });
  s.closeStore(store);
});

test('the retention sweep removes rows whose last write is past decisionRetentionDays', async (t) => {
  const { store } = openTemp();
  const now = Date.now();
  await s.hookLedger(store, { nowMs: () => now - 40 * DAY }).transact((tx) => tx.put('subagent-runs', 'old', { old: true }));
  await s.hookLedger(store, { nowMs: () => now - 1 * DAY }).transact((tx) => tx.put('subagent-runs', 'new', { old: false }));
  assert.equal(s.flushHookRecords(store), true);
  const swept = s.sweepRetention(store, { policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now });
  assert.equal(swept.ok, true, JSON.stringify(swept));
  assert.equal(swept.removed.hook_records, 1);
  assert.deepEqual(s.hookLedger(store).list('subagent-runs'), [{ old: false }]);
  s.closeStore(store);
});
