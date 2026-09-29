// Owner decision DOMAINS 9d6a66d: an unsigned administrator registry override stays supported,
// validated against the registry schema, and status says when it is active or refused. A refused
// override fails closed: the router's loader refuses the same file (routing unavailable), never a
// silent fall back to the bundled prices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { modelRegistryStatusReader, checkModelRegistryBytes, MODEL_REGISTRY_MAX_BYTES } = await import('../dist/model-registry-status.js');
const core = await import('@jevris/core');
const { startDaemon, sidecarRequest } = await import('../dist/index.js');

function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-registry-')));
  return Promise.resolve(fn(home, core.modelRegistryFile(home))).finally(() => rmSync(home, { recursive: true, force: true }));
}

function put(path, text, bumpMs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  // A distinct mtime, so the size-and-mtime cache sees each rewrite.
  const t = new Date(Date.now() + bumpMs);
  utimesSync(path, t, t);
}

test('no override: the bundled snapshot; a valid override is named by its snapshot id', async () => {
  await withHome(async (home, path) => {
    const read = modelRegistryStatusReader(home);
    assert.deepEqual(read(), { source: 'bundled', snapshotId: core.BUNDLED_MODEL_REGISTRY.snapshotId, reasonCode: null });
    const override = { ...core.BUNDLED_MODEL_REGISTRY, snapshotId: 'admin-2026-09-27' };
    put(path, JSON.stringify(override), 1000);
    assert.deepEqual(read(), { source: 'override', snapshotId: 'admin-2026-09-27', reasonCode: null });
    assert.equal((await core.loadModelRegistry({ home }))?.snapshotId, 'admin-2026-09-27', 'the router uses the same file');
  });
});

test('a malformed override is refused with a reason code, and the router refuses it too (fail closed)', async () => {
  await withHome(async (home, path) => {
    const read = modelRegistryStatusReader(home);
    put(path, '{ not json', 1000);
    assert.deepEqual(read(), { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_NOT_JSON' });
    assert.equal(await core.loadModelRegistry({ home }), null, 'routing unavailable, not the bundled prices');
    assert.deepEqual(await core.loadModelRegistryChecked({ home }), { registry: null, reasonCode: 'MODEL_REGISTRY_NOT_JSON' }, 'route names the same code (C 586a520)');
    put(path, JSON.stringify({ ...core.BUNDLED_MODEL_REGISTRY, entries: 'none' }), 2000);
    assert.deepEqual(read(), { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_INVALID' });
    assert.equal(await core.loadModelRegistry({ home }), null);
    assert.equal((await core.loadModelRegistryChecked({ home })).reasonCode, 'MODEL_REGISTRY_INVALID');
    put(path, ' '.repeat(MODEL_REGISTRY_MAX_BYTES + 1), 3000);
    assert.deepEqual(read(), { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_TOO_LARGE' });
    assert.equal(await core.loadModelRegistry({ home }), null);
    assert.equal((await core.loadModelRegistryChecked({ home })).reasonCode, 'MODEL_REGISTRY_TOO_LARGE');
    rmSync(path);
    assert.equal(read().source, 'bundled', 'removing the file returns to the bundled snapshot');
  });
});

test('the byte check refuses text that is not UTF-8', () => {
  assert.equal(checkModelRegistryBytes(new Uint8Array([0x7b, 0xff, 0x7d])).reasonCode, 'MODEL_REGISTRY_NOT_JSON');
});

test('the sidecar status answer carries modelRegistry: bundled, then a refused override with its reason code (E 2219223)', async () => {
  // A short base keeps the socket path under the platform limit.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-reg-')));
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const first = await sidecarRequest({ home, op: 'status', scope: 'cli', body: {} });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.result.modelRegistry, { source: 'bundled', snapshotId: core.BUNDLED_MODEL_REGISTRY.snapshotId, reasonCode: null });
    put(core.modelRegistryFile(home), '{ not json', 1000);
    const second = await sidecarRequest({ home, op: 'status', scope: 'cli', body: {} });
    assert.deepEqual(second.result.modelRegistry, { source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_NOT_JSON' });
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
