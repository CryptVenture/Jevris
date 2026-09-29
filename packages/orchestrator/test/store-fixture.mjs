// A real on-disk store for one test, opened as the in-process test writer (never the sidecar role).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { closeStore, openStore } from '@jevris/store';

export function testStore(dir, workspaceId = 'testhost') {
  const store = openStore({ path: join(dir, 'jevris-test.db'), role: 'in-process-test', workspaceId, hostScope: 'testhost' });
  assert.ok(store.ok, `store: ${store.reason}`);
  return store;
}

export function closeTestStore(store) {
  if (store !== undefined && store.ok) closeStore(store);
}
