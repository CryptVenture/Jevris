import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// IPC-19, US37, container end to end. A real container shares this machine's home directory
// with the host, as a dev container does. The sidecar started in the container keeps its socket
// and store there; the host and a second container see its files but never treat it as their
// worker. Opt-in, so npm test never loads it: it needs Docker. CI's Linux cell runs it.
// Run by hand: JEVRIS_TEST_DOCKER_IMAGE=node:24 node scripts/test.mjs --no-build apps/sidecar/test/opt-in/container.test.mjs

const { ensureSidecar, probeSidecar, sidecarRequest, startDaemon, stopSidecarProcess } = await import('../../dist/index.js');
const { runtimeFiles } = await import('../../dist/protocol.js');

const image = process.env.JEVRIS_TEST_DOCKER_IMAGE ?? '';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CHILD = '/repo/apps/sidecar/test/opt-in/container-child.mjs';

function docker(args, timeout = 120_000) {
  const out = spawnSync('docker', args, { encoding: 'utf8', timeout });
  return { code: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? String(out.error ?? '') };
}

test('a sidecar started in a container keeps its socket and store inside it, and the host is not its worker (US37, IPC-19)', async () => {
  assert.ok(image.length > 0, 'set JEVRIS_TEST_DOCKER_IMAGE to a Node image (node:24) Docker can run');
  assert.notEqual(process.platform, 'win32', 'the container case runs on the Linux and macOS cells');
  const shared = realpathSync(mkdtempSync(join(tmpdir(), 'b-ctr-')));
  const home = join(shared, 'home');
  mkdirSync(home, { mode: 0o700 });
  const name = `b-loc-${process.pid}-${Date.now()}`;
  const user = `${process.getuid()}:${process.getgid()}`;
  const mounts = ['-v', `${repo}:/repo:ro`, '-v', `${shared}:/shared`, '--user', user, '-e', 'HOME=/shared/home', '-e', 'JEVRIS_HOME=/shared/home'];
  try {
    const run = docker(['run', '-d', '--name', name, ...mounts, image, 'node', CHILD, 'start']);
    assert.equal(run.code, 0, run.stderr);
    // The container is Linux: its runtime files follow the Linux layout under the shared home.
    const files = runtimeFiles({ home, platform: 'linux', env: {} });
    const until = Date.now() + 60_000;
    while (!(existsSync(files.endpoint) && existsSync(files.locality)) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    assert.ok(existsSync(files.endpoint), `the container sidecar never wrote its endpoint: ${docker(['logs', name]).stderr}`);

    // In the container: it is the worker, it knows it runs in a container, and its socket and
    // store live under the container's home.
    const inside = docker(['exec', name, 'node', CHILD, 'health']);
    assert.equal(inside.code, 0, inside.stderr);
    const seen = JSON.parse(inside.stdout.trim().split('\n').pop());
    assert.equal(seen.locality.kind, 'container');
    assert.ok(seen.locality.signals.includes('dockerenv'), seen.locality.signals.join(','));
    assert.equal(seen.answer.ok, true, JSON.stringify(seen.answer));
    const health = seen.answer.result;
    assert.equal(health.locality.kind, 'container');
    assert.ok(health.endpoint.startsWith('/shared/home/') || health.endpoint.startsWith('/tmp/'), health.endpoint);
    assert.ok(health.locality.dataDir.startsWith('/shared/home/'), health.locality.dataDir);

    // On the host sharing that home: never the worker. A Linux host shares the runtime layout
    // and sees a foreign sidecar; a macOS host keeps its runtime files elsewhere and never
    // reaches the container's socket at all.
    const refused = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    if (process.platform === 'linux') {
      assert.equal(refused.reasonCode, 'FOREIGN_LOCALITY', JSON.stringify(refused));
      assert.equal((await probeSidecar(home)).foreign, true);
      assert.equal((await ensureSidecar({ home, waitMs: 0 })).reason, 'refused');
      const second = await startDaemon({ home, packageOps: false, idleMs: 0, store: false, log: () => undefined });
      assert.equal(second.ok ? 'started' : second.reason, 'foreign-locality');
      const stop = await stopSidecarProcess(home, 500);
      assert.deepEqual([stop.stopped, stop.foreign], [false, true]);
    } else {
      assert.equal(refused.reasonCode, 'NOT_RUNNING', JSON.stringify(refused));
    }
    assert.equal(docker(['exec', name, 'node', CHILD, 'health']).code, 0, 'the container sidecar is untouched');

    // A second container on the same home: another pid namespace, so also not its worker.
    const other = docker(['run', '--rm', ...mounts, image, 'node', CHILD, 'health']);
    assert.equal(other.code, 0, other.stderr);
    const otherSeen = JSON.parse(other.stdout.trim().split('\n').pop());
    assert.equal(otherSeen.answer.ok, false);
    assert.equal(otherSeen.answer.reasonCode, 'FOREIGN_LOCALITY');
  } finally {
    docker(['rm', '-f', name]);
    rmSync(shared, { recursive: true, force: true });
  }
});
