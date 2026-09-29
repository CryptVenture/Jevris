// A reinstall of the same version (owner report: the hook was new, the sidecar old) must not
// leave a sidecar running the code it started with. The build id is a hash of the runtime's
// bundle manifest, so two builds of one version differ; the endpoint and health name it, and a
// sidecar whose runtime on disk was replaced retires itself once idle, never during a request
// or a verification run. Temp homes and temp runtime folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { startDaemon, sidecarRequest, runtimeBuild, runtimeFiles, BUILD_ID, STALE_BUILD_EXIT_CODE } = await import('../dist/index.js');
const protocol = await import('../dist/protocol.js');

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

function runtimeRoot(outputs, source) {
  const root = tempDir('jvb-rt');
  mkdirSync(join(root, 'dist', 'runtime'), { recursive: true });
  writeFileSync(join(root, 'dist', 'bundle-manifest.json'), JSON.stringify({ schemaVersion: 1, outputs }));
  if (source !== undefined) writeFileSync(join(root, 'dist', 'runtime', 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: '1.2.0', source }));
  return root;
}

const COMMIT = 'a'.repeat(40);

test('a runtime build is a hash of its bundle manifest: the same version built twice differs, the same build matches (pair)', () => {
  const one = runtimeRoot([{ path: 'dist/sidecar.mjs', sha256: '1'.repeat(64) }], { commit: COMMIT, dirty: false });
  const same = runtimeRoot([{ path: 'dist/sidecar.mjs', sha256: '1'.repeat(64) }], { commit: COMMIT, dirty: false });
  const other = runtimeRoot([{ path: 'dist/sidecar.mjs', sha256: '2'.repeat(64) }], { commit: COMMIT, dirty: true });
  const none = tempDir('jvb-none');
  try {
    const a = runtimeBuild(one);
    assert.match(a.id, BUILD_ID);
    assert.deepEqual(a, { id: a.id, commit: COMMIT, dirty: false });
    assert.equal(runtimeBuild(same).id, a.id, 'the same outputs are the same build');
    const b = runtimeBuild(other);
    assert.notEqual(b.id, a.id, 'another output is another build, although the version is the same');
    assert.deepEqual([b.commit, b.dirty], [null, true], 'a dirty build names no commit');
    assert.equal(runtimeBuild(none), null, 'no bundle, no build');
    assert.equal(runtimeBuild(null), null);
  } finally {
    for (const dir of [one, same, other, none]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the endpoint file keeps a well-formed build id and drops anything else (pair)', () => {
  const base = { schemaVersion: 'jevris-sidecar-endpoint-1', protocol: 1, version: '1.2.0', pid: 42, bootId: 'bootid-123456', endpoint: '/tmp/x.sock', startedAtMs: 1, supervised: false };
  assert.equal(protocol.parseEndpoint(JSON.stringify({ ...base, build: '0123456789abcdef' })).build, '0123456789abcdef');
  for (const bad of [undefined, 'short', 'ZZZZZZZZZZZZZZZZ', 7]) {
    const parsed = protocol.parseEndpoint(JSON.stringify(bad === undefined ? base : { ...base, build: bad }));
    assert.notEqual(parsed, undefined, 'an endpoint without a usable build still parses');
    assert.equal(Object.hasOwn(parsed, 'build'), false, JSON.stringify(bad ?? null));
  }
});

async function daemonWith(options) {
  const home = tempDir('jvb');
  const logs = [];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: (entry) => logs.push(entry), ...options });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  return { home, logs, daemon: started.daemon };
}

const settle = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still running'), ms))]);

test('a sidecar names its build in the endpoint and health, and keeps running while the installed build is its own (pair)', async () => {
  const { home, daemon } = await daemonWith({ build: { loaded: () => ({ id: '1111111111111111', commit: null, dirty: true }), onDisk: () => ({ id: '1111111111111111', commit: null, dirty: true }), checkMs: 20 } });
  try {
    const endpoint = JSON.parse(readFileSync(runtimeFiles({ home }).endpoint, 'utf8'));
    assert.equal(endpoint.build, '1111111111111111');
    const health = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(typeof health.result.verificationRuns, 'number');
    assert.ok(health.result.build === null || BUILD_ID.test(health.result.build));
    assert.equal(await settle(daemon.stopped, 300), 'still running', 'the same build never retires');
  } finally {
    await daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('a sidecar whose runtime was replaced by another build retires once idle, after its verification run ends (pair)', async () => {
  let onDisk = '1111111111111111';
  let runs = 1;
  const { home, logs, daemon } = await daemonWith({
    backgroundWork: () => runs,
    build: { loaded: () => ({ id: '1111111111111111', commit: null, dirty: false }), onDisk: () => ({ id: onDisk, commit: null, dirty: false }), checkMs: 20 },
  });
  try {
    onDisk = '2222222222222222';
    assert.equal(await settle(daemon.stopped, 300), 'still running', 'a verification run under way holds it');
    runs = 0;
    assert.equal(await daemon.stopped, 'stale-build');
    assert.ok(logs.some((entry) => entry.event === 'stale-build' && entry.loaded === '1111111111111111' && entry.installed === '2222222222222222'));
  } finally {
    await daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('a sidecar without a build of its own, or with no installed build on disk, never retires for it (pair)', async () => {
  for (const build of [
    { loaded: () => null, onDisk: () => ({ id: '2222222222222222', commit: null, dirty: false }), checkMs: 20 },
    { loaded: () => ({ id: '1111111111111111', commit: null, dirty: false }), onDisk: () => null, checkMs: 20 },
  ]) {
    const { home, daemon } = await daemonWith({ build });
    try {
      assert.equal(await settle(daemon.stopped, 250), 'still running');
    } finally {
      await daemon.stop('test');
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a supervised sidecar retired for a stale build exits non-zero so its service manager restarts it; a plain stop exits 0', async () => {
  const { runSidecarMain } = await import('../dist/daemon.js');
  assert.notEqual(STALE_BUILD_EXIT_CODE, 0);
  const home = tempDir('jvb-sup');
  try {
    const code = await runSidecarMain({ home, packageOps: false, idleMs: 0, supervised: true, log: () => undefined, write: () => undefined, build: { loaded: () => ({ id: '1111111111111111', commit: null, dirty: false }), onDisk: () => ({ id: '2222222222222222', commit: null, dirty: false }), checkMs: 20 } });
    assert.equal(code, STALE_BUILD_EXIT_CODE);
    const same = { loaded: () => ({ id: '1111111111111111', commit: null, dirty: false }), onDisk: () => ({ id: '1111111111111111', commit: null, dirty: false }), checkMs: 20 };
    const running = runSidecarMain({ home, packageOps: false, idleMs: 150, log: () => undefined, write: () => undefined, build: same });
    assert.equal(await running, 0, 'an idle exit is a clean exit');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
