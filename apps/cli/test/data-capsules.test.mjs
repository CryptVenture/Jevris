import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA-12 `data delete --scope capsules`, the store half: `purgeStoreCapsules` stops the sidecar
// (the store has one writer), removes the capsule index rows (pinned ones too, one workspace's
// or all), and leaves every other row alone.

const { purgeStoreCapsules } = await import('../dist/runtime-commands.js');
const store = await import('@jevris/store');
const { hostScopeId } = await import('@jevris/sidecar');
const { jevrisPaths } = await import('@jevris/platform');

test('purgeStoreCapsules removes capsule rows for one workspace or all, and nothing else (DATA-12)', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-capsules-')));
  try {
    assert.deepEqual(await purgeStoreCapsules(home), { ok: true, removed: 0 }, 'no store yet: nothing to remove');
    const path = join(jevrisPaths({ home }).data, 'jevris.db');
    const hostScope = hostScopeId(home);
    for (const [ws, ids] of [['wsA', ['c1', 'c2']], ['wsB', ['c3']]]) {
      const opened = store.openStore({ path, role: 'sidecar', workspaceId: ws, hostScope });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      for (const id of ids) assert.equal(store.putCapsule(opened, { capsuleId: id, encoderVersion: 'v1', contentHash: 'a'.repeat(64), retentionClass: id === 'c2' ? 'pinned' : 'standard', nowMs: Date.now() }).ok, true);
      assert.equal(store.recordSession(opened, { sessionId: `s-${ws}`, harness: 'claude', state: 'active', atMs: Date.now() }).ok, true);
      store.closeStore(opened);
    }
    assert.equal((await purgeStoreCapsules(home, { workspaceId: 'bad id' })).reasonCode, 'INVALID_WORKSPACE');
    assert.deepEqual(await purgeStoreCapsules(home, { workspaceId: 'wsA' }), { ok: true, removed: 2 }, 'a pinned capsule goes too');
    assert.deepEqual(await purgeStoreCapsules(home), { ok: true, removed: 1 });
    const check = store.openStore({ path, role: 'sidecar', workspaceId: 'wsB', hostScope });
    assert.equal(store.currentCapsule(check, 'c3'), undefined);
    assert.equal(store.getSession(check, 's-wsB')?.harness, 'claude', 'other rows stay');
    store.closeStore(check);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
