// IPC-19: doctor and hook certification learn "in a container" from the sidecar's detector,
// not from a flag. The detector reads a fake filesystem root only in test mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { classifyEnvironment, detectInContainer } = await import('../dist/platform.js');

test('detectInContainer answers from the sidecar locality detector, and classifyEnvironment reduces a container (IPC-19)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-locality-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, 'bare');
  const docker = join(dir, 'docker');
  const podman = join(dir, 'podman');
  const cgroup = join(dir, 'cgroup');
  for (const root of [bare, docker, podman, cgroup]) mkdirSync(join(root, 'proc', '1'), { recursive: true });
  writeFileSync(join(docker, '.dockerenv'), '');
  mkdirSync(join(podman, 'run'), { recursive: true });
  writeFileSync(join(podman, 'run', '.containerenv'), '');
  writeFileSync(join(cgroup, 'proc', '1', 'cgroup'), '0::/kubepods/besteffort/pod1234\n');
  const at = (root, extra = {}) => ({ platform: 'linux', env: { JEVRIS_TEST: '1', JEVRIS_TEST_LOCALITY_ROOT: root, ...extra } });

  assert.equal(await detectInContainer(at(bare)), false);
  assert.equal(await detectInContainer(at(docker)), true);
  assert.equal(await detectInContainer(at(podman)), true);
  assert.equal(await detectInContainer(at(cgroup)), true);
  assert.equal(await detectInContainer(at(bare, { container: 'podman' })), true, 'the container variable');
  assert.equal(await detectInContainer(at(bare, { REMOTE_CONTAINERS: 'true' })), true, 'a devcontainer');
  // Outside test mode the fake root is ignored: the real filesystem decides.
  const real = await detectInContainer({ platform: 'linux', env: { JEVRIS_TEST_LOCALITY_ROOT: docker } });
  assert.equal(typeof real, 'boolean');

  const inside = await detectInContainer(at(docker));
  assert.equal(classifyEnvironment({ platform: 'linux', nodeVersion: 'v24.0.0', env: {}, inContainer: inside }), 'reduced');
  assert.equal(classifyEnvironment({ platform: 'linux', nodeVersion: 'v24.0.0', env: {}, inContainer: await detectInContainer(at(bare)) }), 'local');
});
