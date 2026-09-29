import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const { openStore, closeStore, storeFiles } = await import('../dist/index.js');
const { assertOwnerOnly } = await import('../../platform/dist/index.js');

const POSIX_ONLY = process.platform === 'win32' ? 'file modes are POSIX; Windows uses the data directory ACL (BLD-08)' : false;

function openAt(path) {
  return openStore({ path, role: 'in-process-test', workspaceId: 'wsA', hostScope: 'host-a' });
}

function tempDir(t) {
  const dir = makeTempDir('jevris-store-private-');
  t.after(() => removeTempDir(dir));
  return dir;
}

test('storeFiles names the db and its -wal and -shm siblings (BLD-08)', () => {
  assert.deepEqual(storeFiles(join('x', 'ledger.sqlite')), [
    join('x', 'ledger.sqlite'),
    `${join('x', 'ledger.sqlite')}-wal`,
    `${join('x', 'ledger.sqlite')}-shm`,
  ]);
});

test('a new store db, -wal and -shm are owner-only (BLD-08)', { skip: POSIX_ONLY }, async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'ledger.sqlite');
  const opened = openAt(path);
  assert.equal(opened.ok, true);
  try {
    for (const file of storeFiles(path)) {
      if (!existsSync(file)) continue;
      assert.deepEqual(await assertOwnerOnly(file), { ok: true }, file);
    }
    assert.equal(existsSync(`${path}-wal`), true);
  } finally {
    closeStore(opened);
  }
});

test('an existing wide store db is tightened to 0600 on open (BLD-08)', { skip: POSIX_ONLY }, (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'ledger.sqlite');
  const first = openAt(path);
  assert.equal(first.ok, true);
  closeStore(first);
  chmodSync(path, 0o644);
  const again = openAt(path);
  assert.equal(again.ok, true);
  closeStore(again);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a symlinked store db or -wal is refused and not followed (BLD-08)', (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'elsewhere.sqlite');
  writeFileSync(target, '');
  const link = join(dir, 'ledger.sqlite');
  try {
    symlinkSync(target, link);
  } catch {
    t.skip('this account cannot create symlinks (Windows without Developer Mode)');
    return;
  }
  const opened = openAt(link);
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, 'path-refused');

  const walBase = join(dir, 'other.sqlite');
  symlinkSync(target, `${walBase}-wal`);
  const walOpened = openAt(walBase);
  assert.equal(walOpened.ok, false);
  assert.equal(walOpened.reason, 'path-refused');
});

test('a store under a missing data directory creates it owner-only and opens (Linux keeps data apart from state)', async (t) => {
  const dir = tempDir(t);
  const data = join(dir, '.local', 'share', 'jevris');
  const path = join(data, 'jevris.db');
  const opened = openAt(path);
  assert.equal(opened.ok, true, opened.ok ? '' : opened.reason);
  try {
    assert.equal(statSync(data).isDirectory(), true);
    if (process.platform !== 'win32') assert.equal(statSync(data).mode & 0o777, 0o700);
  } finally {
    closeStore(opened);
  }
});

test('a store whose parent is a file, not a directory, is refused path-refused', (t) => {
  const dir = tempDir(t);
  const parent = join(dir, 'not-a-dir');
  writeFileSync(parent, 'x');
  const opened = openAt(join(parent, 'jevris.db'));
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, 'path-refused');
});
