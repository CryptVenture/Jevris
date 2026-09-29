import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const { openStore, commitOwned, readCommitted, closeStore, refusalReasons } = await import(
  '../dist/index.js'
);

const root = fileURLToPath(new URL('../../..', import.meta.url));

function tempDir() {
  return makeTempDir('jevris-store-driver-');
}

function openArgs(path, extra) {
  return {
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
    ...extra,
  };
}

test('a thrown addon load does not create the file or call a second driver', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'missing.sqlite');
  let fallback = 0;
  const fallbackDriver = () => {
    fallback += 1;
    throw new Error('second driver');
  };
  try {
    const opened = openStore(
      openArgs(dbPath, {
        loadDriver() {
          throw new Error('addon load failed');
        },
        fallbackDriver,
      }),
    );
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, 'store-unavailable');
    assert.equal(fallback, 0);
    assert.equal(existsSync(dbPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('role library does not call loadDriver or create the file', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'library.sqlite');
  let loads = 0;
  try {
    const opened = openStore({
      path: dbPath,
      role: 'library',
      workspaceId: 'wsA',
      hostScope: 'host-a',
      loadDriver() {
        loads += 1;
        throw new Error('must not load');
      },
    });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, 'production-writer-closed');
    assert.equal(loads, 0);
    assert.equal(existsSync(dbPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('a non-test role does not construct the driver', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'closed.sqlite');
  let loads = 0;
  try {
    const opened = openStore({
      path: dbPath,
      role: 'other',
      workspaceId: 'wsA',
      hostScope: 'host-a',
      loadDriver() {
        loads += 1;
        throw new Error('must not load');
      },
    });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, 'production-writer-closed');
    assert.equal(loads, 0);
    assert.equal(existsSync(dbPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('a second open is refused and commitOwned is not called', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'busy.sqlite');
  let secondLoads = 0;
  try {
    const first = openStore(openArgs(dbPath));
    assert.equal(first.ok, true);
    const second = openStore(
      openArgs(dbPath, {
        loadDriver() {
          secondLoads += 1;
          throw new Error('second driver');
        },
      }),
    );
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, 'writer-busy');
    assert.equal(secondLoads, 0);
    let committed = false;
    if (second.ok) {
      commitOwned(second, {
        decisionId: 'decBusy',
        operationId: 'opBusy',
        reservationMicroUsd: 1n,
      });
      committed = true;
    }
    assert.equal(committed, false);
    if (first.ok) {
      assert.equal(readCommitted(first, 'decBusy'), undefined);
      closeStore(first);
    }
  } finally {
    removeTempDir(dir);
  }
});

test('a path under plugins/claude is refused and does not create the file', () => {
  const dir = tempDir();
  const pluginDir = join(dir, 'plugins', 'claude');
  mkdirSync(pluginDir, { recursive: true });
  const dbPath = join(pluginDir, 'store.sqlite');
  let loads = 0;
  try {
    const opened = openStore(
      openArgs(dbPath, {
        loadDriver() {
          loads += 1;
          throw new Error('must not load');
        },
      }),
    );
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, 'path-refused');
    assert.equal(loads, 0);
    assert.equal(existsSync(dbPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('a path inside .claude-plugin is refused', () => {
  const dir = tempDir();
  const pluginDir = join(dir, '.claude-plugin');
  mkdirSync(pluginDir, { recursive: true });
  const dbPath = join(pluginDir, 'store.sqlite');
  try {
    const opened = openStore(openArgs(dbPath));
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, 'path-refused');
    assert.equal(existsSync(dbPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('a different hostScope refuses the write and leaves the stored scope', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'host.sqlite');
  try {
    const created = openStore(openArgs(dbPath));
    assert.equal(created.ok, true);
    if (created.ok) {
      const seeded = commitOwned(created, {
        decisionId: 'decHost',
        operationId: 'opHost',
        reservationMicroUsd: 1n,
      });
      assert.equal(seeded.ok, true);
      closeStore(created);
    }
    const foreign = openStore({
      path: dbPath,
      role: 'in-process-test',
      workspaceId: 'wsA',
      hostScope: 'host-b',
    });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.reason, 'host-scope-mismatch');
    let wrote = false;
    if (foreign.ok) {
      commitOwned(foreign, {
        decisionId: 'decForeign',
        operationId: 'opForeign',
        reservationMicroUsd: 1n,
      });
      wrote = true;
    }
    assert.equal(wrote, false);
    const again = openStore(openArgs(dbPath));
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.hostScope, 'host-a');
    assert.equal(readCommitted(again, 'decForeign'), undefined);
    assert.ok(readCommitted(again, 'decHost'));
    closeStore(again);
  } finally {
    removeTempDir(dir);
  }
});

test('a non-wal journal read-back refuses the open and writes nothing', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'nowal.sqlite');
  const writes = [];
  try {
    const opened = openStore(
      openArgs(dbPath, {
        loadDriver() {
          return {
            pragma(source) {
              const text = String(source);
              if (text.startsWith('journal_mode') && !text.includes('=')) return 'delete';
              if (text.startsWith('foreign_keys') && !text.includes('=')) return 1;
              if (text.startsWith('busy_timeout') && !text.includes('=')) return 2000;
              return null;
            },
            defaultSafeIntegers() {},
            exec(sql) {
              writes.push(sql);
            },
            prepare(sql) {
              writes.push(sql);
              return {
                run() {
                  writes.push('run');
                },
                get() {
                  writes.push('get');
                  return undefined;
                },
              };
            },
            transaction(fn) {
              return () => {
                writes.push('transaction');
                fn();
              };
            },
            close() {
              writes.push('close');
            },
          };
        },
      }),
    );
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, 'journal-mode-refused');
    assert.deepEqual(
      writes.filter((entry) => entry !== 'close'),
      [],
    );
    assert.equal(existsSync(dbPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('the addon is not a dependency of core, the CLI, or the provider', async () => {
  const storePkg = JSON.parse(readFileSync(join(root, 'packages/store/package.json'), 'utf8'));
  assert.equal(storePkg.dependencies['better-sqlite3'], '13.0.3');
  for (const rel of [
    'packages/core/package.json',
    'apps/cli/package.json',
    'packages/provider-typesafe/package.json',
    'packages/contracts/package.json',
  ]) {
    const pkg = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    assert.equal(deps['better-sqlite3'], undefined);
  }
  const banned = ['node:sqlite', '@types/better-sqlite3', 'kernel.js', 'runtime.js'];
  const srcDir = join(root, 'packages/store/src');
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue;
    const source = readFileSync(join(srcDir, name), 'utf8');
    for (const token of banned) assert.equal(source.includes(token), false, `${name} contains ${token}`);
  }
  const { assertProductHooksAbsentOrCertified } = await import(new URL('../../../apps/cli/test/product-hooks.mjs', import.meta.url));
  await assertProductHooksAbsentOrCertified();
  const sidecarPkg = JSON.parse(readFileSync(join(root, 'apps/sidecar/package.json'), 'utf8'));
  const sidecarDeps = Object.assign({}, sidecarPkg.dependencies, sidecarPkg.devDependencies);
  assert.equal(sidecarDeps['better-sqlite3'], undefined);
  assert.ok(refusalReasons.includes('store-unavailable'));
  assert.ok(refusalReasons.includes('production-writer-closed'));
  assert.ok(refusalReasons.includes('writer-busy'));
  assert.ok(refusalReasons.includes('host-scope-mismatch'));
  assert.ok(refusalReasons.includes('path-refused'));
  assert.equal(refusalReasons.includes('sidecar'), false);
});

test('every store connection commits with synchronous NORMAL, the one that makes a new file WAL too', async () => {
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const dir = tempDir();
  const dbPath = join(dir, 'sync.sqlite');
  try {
    for (const which of ['new file', 'existing file']) {
      let driver;
      const opened = openStore(
        openArgs(dbPath, {
          loadDriver(path) {
            driver = new Database(path);
            return driver;
          },
        }),
      );
      assert.equal(opened.ok, true, JSON.stringify(opened));
      try {
        // 1 is NORMAL. The build's WAL default gives an existing WAL file NORMAL, but a
        // connection that switches a new file to WAL keeps FULL (2) unless the store sets it.
        assert.equal(Number(driver.pragma('synchronous', { simple: true })), 1, which);
        assert.equal(String(driver.pragma('journal_mode', { simple: true })), 'wal', which);
      } finally {
        closeStore(opened);
      }
    }
  } finally {
    removeTempDir(dir);
  }
});
