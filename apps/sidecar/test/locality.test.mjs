import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// IPC-19, US37: the sidecar starts where the coding process runs. A detector replaces the
// injected container flag, and a client never treats a sidecar from another execution
// environment (a container sharing this home, WSL, another host) as its worker.

const { detectLocality } = await import('../dist/locality.js');
const { ensureSidecar, probeSidecar, sidecarRequest, startDaemon, stopSidecarProcess } = await import('../dist/index.js');
const protocol = await import('../dist/protocol.js');

const dirs = [];
function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `b-loc-${prefix}-`)));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const BOOT = '6f1c2a0e-8d7b-4c55-9a51-0b2d7c3e4f10';
const CONTAINER = 'a'.repeat(64);

/** A fake filesystem root with the Linux markers a host or a container shows. */
function fakeRoot({ container = false, pidNs = '4026531836', osrelease = '6.8.0-45-generic' } = {}) {
  const root = tempDir(container ? 'ctr' : 'host');
  mkdirSync(join(root, 'proc', '1'), { recursive: true });
  mkdirSync(join(root, 'proc', 'self', 'ns'), { recursive: true });
  mkdirSync(join(root, 'proc', 'sys', 'kernel', 'random'), { recursive: true });
  writeFileSync(join(root, 'proc', 'sys', 'kernel', 'random', 'boot_id'), `${BOOT}\n`);
  writeFileSync(join(root, 'proc', 'sys', 'kernel', 'osrelease'), `${osrelease}\n`);
  writeFileSync(join(root, 'proc', 'self', 'ns', 'pid'), `pid:[${pidNs}]\n`);
  if (container) {
    writeFileSync(join(root, '.dockerenv'), '');
    writeFileSync(join(root, 'proc', '1', 'cgroup'), `0::/system.slice/docker-${CONTAINER}.scope\n`);
    writeFileSync(join(root, 'proc', 'self', 'mountinfo'), `812 790 0:170 / / rw,relatime master:337 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/X\n900 812 254:1 /var/lib/docker/containers/${CONTAINER}/hostname /etc/hostname rw - ext4 /dev/vda1 rw\n`);
  } else {
    writeFileSync(join(root, 'proc', '1', 'cgroup'), '0::/init.scope\n');
    writeFileSync(join(root, 'proc', 'self', 'mountinfo'), '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n');
  }
  return root;
}

test('the detector names a container from its markers, and its id differs from the host it runs on (IPC-19)', () => {
  const host = detectLocality({ root: fakeRoot(), env: {} });
  const container = detectLocality({ root: fakeRoot({ container: true, pidNs: '4026532401' }), env: {} });
  assert.equal(host.kind, 'local');
  assert.equal(host.container, false);
  assert.deepEqual(host.signals, []);
  assert.equal(container.kind, 'container');
  assert.equal(container.container, true);
  for (const signal of ['dockerenv', 'cgroup', 'overlay-root']) assert.ok(container.signals.includes(signal), `${signal} missing from ${container.signals}`);
  assert.match(host.id, /^[a-f0-9]{16}$/);
  assert.notEqual(host.id, container.id, 'a container shares the host kernel boot but not its pid namespace');
});

test('variables name the kind (SSH, devcontainer, WSL) but never change the id (IPC-19)', () => {
  const root = fakeRoot();
  const plain = detectLocality({ root, env: {} });
  const ssh = detectLocality({ root, env: { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22' } });
  assert.equal(ssh.kind, 'ssh');
  assert.equal(ssh.ssh, true);
  assert.equal(ssh.id, plain.id, 'the SSH terminal and a harness started elsewhere on the same host share one sidecar');
  const dev = detectLocality({ root, env: { REMOTE_CONTAINERS: 'true' } });
  assert.equal(dev.kind, 'container');
  assert.equal(dev.id, plain.id);
  const wsl = detectLocality({ root: fakeRoot({ osrelease: '5.15.153.1-microsoft-standard-WSL2' }), env: {} });
  assert.equal(wsl.kind, 'wsl');
  // Windows and macOS: the platform alone, stable across a hostname change.
  assert.equal(detectLocality({ platform: 'win32', env: {} }).id, detectLocality({ platform: 'win32', env: { COMPUTERNAME: 'other' } }).id);
  assert.notEqual(detectLocality({ platform: 'win32', env: {} }).id, wsl.id, 'WSL and Windows are distinct environments');
  // The test root is honoured only in test mode.
  const viaEnv = detectLocality({ platform: 'darwin', env: { JEVRIS_TEST: '1', JEVRIS_TEST_LOCALITY_ROOT: root } });
  assert.equal(viaEnv.id, plain.id);
  assert.equal(detectLocality({ platform: 'darwin', env: { JEVRIS_TEST_LOCALITY_ROOT: root } }).id, detectLocality({ platform: 'darwin', env: {} }).id);
});

test('without boot id and pid namespace, Linux keys the id on the machine id, not the host name (IPC-19, DATA-10)', () => {
  const MACHINE = 'b08dfa6083e7567a1921a715000001fb';
  /** A Linux root with no /proc markers (a restricted sandbox), and optionally a machine id. */
  const bare = (machineId, where = ['etc', 'machine-id']) => {
    const root = tempDir('bare');
    if (machineId !== undefined) {
      mkdirSync(join(root, ...where.slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...where), `${machineId}\n`);
    }
    return root;
  };
  const root = bare(MACHINE);
  const before = detectLocality({ root, env: {}, hostname: 'laptop.home.example' });
  const after = detectLocality({ root, env: {}, hostname: 'dhcp-10-0-0-7.example.net' });
  assert.match(before.id, /^[a-f0-9]{16}$/);
  assert.equal(after.id, before.id, 'a host-name change keeps the id');
  assert.equal(detectLocality({ root: bare(MACHINE, ['var', 'lib', 'dbus', 'machine-id']), env: {}, hostname: 'x' }).id, before.id, 'the D-Bus copy is the same machine');
  assert.notEqual(detectLocality({ root: bare('c0ffee0083e7567a1921a715000001fb'), env: {}, hostname: 'laptop.home.example' }).id, before.id, 'another machine id');
  // A container marker still separates a container from its host, even with the host's id.
  const ctr = bare(MACHINE);
  writeFileSync(join(ctr, '.dockerenv'), '');
  assert.notEqual(detectLocality({ root: ctr, env: {}, hostname: 'laptop.home.example' }).id, before.id);
  // No machine id at all: the host name is the last resort.
  const none = bare(undefined);
  assert.notEqual(detectLocality({ root: none, env: {}, hostname: 'a' }).id, detectLocality({ root: none, env: {}, hostname: 'b' }).id);
  assert.equal(before.id.includes(MACHINE.slice(0, 8)), false);
});

test('a sidecar started in a container keeps its socket and store there, and a host client never treats it as its worker (US37, IPC-19)', async () => {
  const home = tempDir('home');
  const containerRoot = fakeRoot({ container: true, pidNs: '4026532401' });
  const hostRoot = fakeRoot();
  const saved = { test: process.env.JEVRIS_TEST, root: process.env.JEVRIS_TEST_LOCALITY_ROOT };
  const as = (root) => {
    process.env.JEVRIS_TEST = '1';
    process.env.JEVRIS_TEST_LOCALITY_ROOT = root;
  };
  const env = { ...process.env, JEVRIS_TEST: '1', JEVRIS_TEST_LOCALITY_ROOT: containerRoot };
  const started = await startDaemon({ home, env, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const files = protocol.runtimeFiles({ home });
    // Inside the container: health names the container, and the socket and store are under
    // the container's own home.
    as(containerRoot);
    const health = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(health.result.locality.kind, 'container');
    assert.equal(health.result.locality.container, true);
    assert.ok(health.result.locality.signals.includes('dockerenv'));
    assert.equal(health.result.endpoint.startsWith(home) || health.result.endpoint.startsWith(files.dir) || health.result.endpoint.startsWith('\\\\.\\pipe\\'), true, health.result.endpoint);
    assert.ok(health.result.locality.dataDir.startsWith(home), health.result.locality.dataDir);
    assert.ok(health.result.locality.runtimeDir.startsWith(home) || health.result.locality.runtimeDir === files.dir, health.result.locality.runtimeDir);
    const record = protocol.readLocalityRecord(files);
    assert.equal(record.bootId, started.daemon.endpoint.bootId);
    assert.equal(record.kind, 'container');

    // On the host that shares this home: the container's sidecar is not the worker.
    as(hostRoot);
    const refused = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(refused.ok, false);
    assert.equal(refused.reasonCode, 'FOREIGN_LOCALITY');
    const probe = await probeSidecar(home);
    assert.equal(probe.running, false);
    assert.equal(probe.foreign, true);
    const ensured = await ensureSidecar({ home, waitMs: 0 });
    assert.deepEqual([ensured.ok, ensured.reason], [false, 'refused']);
    const second = await startDaemon({ home, env: { ...process.env }, packageOps: false, idleMs: 0, log: () => undefined });
    assert.deepEqual([second.ok, second.reason], [false, 'foreign-locality']);
    // Its pid means nothing here: stop signals nothing.
    const stop = await stopSidecarProcess(home, 500);
    assert.deepEqual([stop.stopped, stop.foreign], [false, true]);
    assert.equal(existsSync(files.endpoint), true, 'the container sidecar kept its files');

    // A record the container sidecar stopped refreshing (it crashed) no longer blocks.
    const stale = JSON.parse(readFileSync(files.locality, 'utf8'));
    writeFileSync(files.locality, `${JSON.stringify({ ...stale, refreshedAtMs: Date.now() - protocol.LOCALITY_STALE_MS - 1000 })}\n`, { mode: 0o600 });
    assert.equal((await probeSidecar(home)).foreign, undefined);
    writeFileSync(files.locality, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    as(containerRoot);
    assert.equal((await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} })).ok, true);
  } finally {
    await started.daemon.stop('test');
    if (saved.test === undefined) delete process.env.JEVRIS_TEST;
    else process.env.JEVRIS_TEST = saved.test;
    if (saved.root === undefined) delete process.env.JEVRIS_TEST_LOCALITY_ROOT;
    else process.env.JEVRIS_TEST_LOCALITY_ROOT = saved.root;
  }
  assert.equal(existsSync(protocol.runtimeFiles({ home }).locality), false, 'stop removes the locality record');
});
