// P2 (sidecar concurrency audit): hook-path collections live in the store's hook records, so a
// hook's bookkeeping takes no directory lock; everything else stays in the file ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { flushHookRecords, hookRecordsPending } from '@jevris/store';
import { HOOK_COLLECTIONS, openWorkspace } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function setup() {
  const dir = tempDir('jv-hs-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { dir, home, repo };
}

test('with a store, hook-path records go to the store and read back from both ledgers; other collections stay in files', async () => {
  const { dir, home, repo } = setup();
  let store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    assert.notEqual(ws.hook, ws.state);
    await ws.hook.transact((tx) => tx.put('loop-signals', 'k1', [{ n: 1 }]));
    assert.deepEqual(ws.state.get('loop-signals', 'k1'), [{ n: 1 }], 'readable at once, before the commit');
    assert.deepEqual(ws.hook.list('loop-signals'), [[{ n: 1 }]]);
    assert.equal(existsSync(join(ws.state.root, 'loop-signals')), false, 'no file-ledger directory for a hook collection');
    // A workspace-ledger transaction may write both kinds together.
    await ws.state.transact((tx) => {
      tx.put('duplicate-feedback', 'd1', { atMs: 1 });
      tx.put('stop-reminders', 'r1', { fired: 1 });
      assert.deepEqual(tx.get('stop-reminders', 'r1'), { fired: 1 }, 'its own write is visible inside it');
    });
    assert.deepEqual(ws.state.get('duplicate-feedback', 'd1'), { atMs: 1 });
    assert.deepEqual(ws.hook.get('stop-reminders', 'r1'), { fired: 1 });
    assert.equal(existsSync(join(ws.state.root, 'duplicate-feedback')), true);
    assert.equal(existsSync(join(ws.state.root, 'stop-reminders')), false);
    // A throwing transaction writes neither kind.
    await assert.rejects(
      ws.state.transact((tx) => {
        tx.put('duplicate-feedback', 'd2', { atMs: 2 });
        tx.put('restores', 'x', { taken: false });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(ws.state.get('duplicate-feedback', 'd2'), undefined);
    assert.equal(ws.state.get('restores', 'x'), undefined);
    // The hook ledger writes only hook collections.
    await assert.rejects(ws.hook.transact((tx) => tx.put('freshness', 'f', {})), /not a hook-path collection/);
    assert.ok(hookRecordsPending(store).records >= 2);
    assert.equal(flushHookRecords(store), true);
    assert.equal(hookRecordsPending(store).records, 0);
  } finally {
    closeTestStore(store);
  }
  // Committed: a new store handle reads the records back from SQLite.
  store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    assert.deepEqual(ws.state.get('loop-signals', 'k1'), [{ n: 1 }]);
    assert.deepEqual(ws.state.get('stop-reminders', 'r1'), { fired: 1 });
  } finally {
    closeTestStore(store);
  }
});

test('a hook-path transaction does not wait on the file ledger lock', async () => {
  const { dir, home, repo } = setup();
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const lock = join(ws.state.root, '.lock');
  // A fresh lock with no owner file: held by someone else until it goes stale.
  mkdirSync(lock, { recursive: true });
  try {
    await assert.rejects(ws.state.transact((tx) => tx.put('duplicate-feedback', 'd', {}), { waitMs: 50 }), /ledger: lock busy/, 'the file ledger is held');
    const at = await ws.hook.transact((tx) => {
      tx.put('compaction-deferrals', 'c1', 5);
      return 'done';
    });
    assert.equal(at, 'done');
    assert.equal(ws.hook.get('compaction-deferrals', 'c1'), 5);
  } finally {
    rmSync(lock, { recursive: true, force: true });
    closeTestStore(store);
  }
});

test('without a store both ledgers are the file ledger, as before', async () => {
  const { home, repo } = setup();
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home } });
  assert.equal(ws.hook, ws.state);
  await ws.hook.transact((tx) => tx.put('subagent-runs', 's1', { stops: 0 }));
  assert.equal(existsSync(join(ws.state.root, 'subagent-runs')), true);
  assert.ok(HOOK_COLLECTIONS.has('subagent-runs'));
});

test('a record an earlier version wrote as a file stays readable until a hook write shadows it (upgrade)', async () => {
  const { dir, home, repo } = setup();
  const plain = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home } });
  await plain.state.transact((tx) => {
    tx.put('stop-reminders', 'old-1', { fired: 1 });
    tx.put('stop-reminders', 'old-2', { fired: 2 });
  });
  const store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    assert.deepEqual(ws.state.get('stop-reminders', 'old-1'), { fired: 1 });
    assert.deepEqual(ws.hook.get('stop-reminders', 'old-2'), { fired: 2 });
    await ws.hook.transact((tx) => {
      assert.deepEqual(tx.get('stop-reminders', 'old-1'), { fired: 1 }, 'visible inside a hook transaction too');
      tx.put('stop-reminders', 'old-1', { fired: 5 });
      tx.put('stop-reminders', 'new-1', { fired: 0 });
    });
    assert.deepEqual(ws.state.get('stop-reminders', 'old-1'), { fired: 5 }, 'the hook record shadows the file');
    const fired = ws.state.list('stop-reminders').map((r) => r.fired).sort();
    assert.deepEqual(fired, [0, 2, 5], 'each key once');
  } finally {
    closeTestStore(store);
  }
});
