import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, story } from './lib.mjs';

// US37: the IDE is local, the coding process runs in a container. Jevris starts where the coding
// process runs: its sidecar, socket and store are in that environment, and a client on the other
// side of the boundary (the host the IDE and its localhost run on) never treats it as its worker.
// The container is described by the Linux markers a real one shows, under a test-only root that
// the product reads only with JEVRIS_TEST=1 (IPC-19). The real-container run is
// apps/sidecar/test/opt-in/container.test.mjs (Docker).

const BOOT = '6f1c2a0e-8d7b-4c55-9a51-0b2d7c3e4f10';

function fakeRoot(dir, { container }) {
  mkdirSync(join(dir, 'proc', '1'), { recursive: true });
  mkdirSync(join(dir, 'proc', 'self', 'ns'), { recursive: true });
  mkdirSync(join(dir, 'proc', 'sys', 'kernel', 'random'), { recursive: true });
  writeFileSync(join(dir, 'proc', 'sys', 'kernel', 'random', 'boot_id'), `${BOOT}\n`);
  writeFileSync(join(dir, 'proc', 'self', 'ns', 'pid'), container ? 'pid:[4026532401]\n' : 'pid:[4026531836]\n');
  writeFileSync(join(dir, 'proc', '1', 'cgroup'), container ? `0::/system.slice/docker-${'c'.repeat(64)}.scope\n` : '0::/init.scope\n');
  if (container) writeFileSync(join(dir, '.dockerenv'), '');
  return dir;
}

story('US37', async ({ t, then, sandbox, evidence }) => {
  const roots = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-us37-')));
  const containerRoot = fakeRoot(join(roots, 'container'), { container: true });
  const hostRoot = fakeRoot(join(roots, 'host'), { container: false });
  const box = await sandbox({ env: { JEVRIS_TEST: '1', JEVRIS_TEST_LOCALITY_ROOT: containerRoot } });
  // Added after the sandbox's own teardown, so it runs after it (node:test runs after-hooks in
  // the order added): the teardown's sidecar stop still sees the container it started in.
  t.after(() => rmSync(roots, { recursive: true, force: true }));
  const host = { JEVRIS_TEST_LOCALITY_ROOT: hostRoot };

  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start in the container');
  const inside = box.jevris(['sidecar', 'status', '--home', box.home], { json: true });
  const hook = box.hook('claude', { hook_event_name: 'PostToolUse', session_id: 'us37', cwd: box.work, tool_name: 'Read', tool_input: { file_path: join(box.work, 'a.ts') }, tool_use_id: 'tu-us37' });
  const status = box.jevris(['status'], { json: true });
  const fromHost = box.jevris(['sidecar', 'status', '--home', box.home], { json: true, extraEnv: host });
  const hostStart = box.jevris(['sidecar', 'start', '--home', box.home], { extraEnv: host });
  const hostStop = box.jevris(['sidecar', 'stop', '--home', box.home], { extraEnv: host });
  const hostHook = box.hook('claude', { hook_event_name: 'PostToolUse', session_id: 'us37-host', cwd: box.work, tool_name: 'Read', tool_input: { file_path: join(box.work, 'b.ts') }, tool_use_id: 'tu-us37-host' }, { extraEnv: host });
  const after = box.jevris(['sidecar', 'status', '--home', box.home], { json: true });
  evidence({ locality: inside.json?.locality ?? null, hostState: fromHost.json?.state ?? null, hostHook: hostHook.reason ?? null });

  await then('Its adapter, file access and IPC are located in the actual execution environment', async () => {
    assert.equal(inside.code, 0, inside.stdout + inside.stderr);
    const locality = inside.json.locality;
    assert.equal(locality.kind, 'container');
    assert.equal(locality.container, true);
    assert.ok(locality.signals.includes('dockerenv'), locality.signals.join(','));
    // IPC and data live in the environment's own home: the socket under its runtime directory
    // (or its private temporary fallback) and the store under its data directory.
    const { jevrisPaths } = await load('platform');
    const paths = jevrisPaths({ home: box.home, env: box.env });
    assert.equal(locality.dataDir, paths.data);
    assert.equal(locality.runtimeDir, paths.runtime);
    assert.ok(inside.json.endpoint.startsWith(paths.runtime) || /^\/tmp\/|^\\\\\.\\pipe\\/.test(inside.json.endpoint) || inside.json.endpoint.startsWith(tmpdir()), inside.json.endpoint);
    assert.equal(inside.json.store.state, 'ok', JSON.stringify(inside.json.store));
    // The harness adapter ran here and its event reached this sidecar.
    assert.equal(hook.code, 0, hook.stderr);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.json?.sidecar?.state, 'running', JSON.stringify(status.json?.sidecar));
  });

  await then('UI localhost is not assumed to be the worker', () => {
    // A client on the host sees the container's sidecar files but never treats it as its worker:
    // status says so, start refuses to take its place, stop signals nothing, and a hook there
    // does not reach it.
    assert.equal(fromHost.code, 1);
    assert.equal(fromHost.json?.state, 'foreign-locality', fromHost.stdout);
    assert.equal(fromHost.json?.reasonCode, 'FOREIGN_LOCALITY');
    assert.equal(hostStart.code, 1);
    assert.match(hostStart.stdout, /another execution environment/);
    assert.equal(hostStop.code, 1);
    assert.match(hostStop.stdout, /another execution environment/);
    assert.equal(hostHook.code, 0, 'a hook never blocks the harness');
    // The container's sidecar is untouched and still the worker in the container.
    assert.equal(after.code, 0, after.stdout);
    assert.equal(after.json?.pid, inside.json?.pid);
  });
});
