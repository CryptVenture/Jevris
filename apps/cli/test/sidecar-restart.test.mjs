// Install restarts a running sidecar on the new build, so the first hooks after a reinstall are
// answered and do not run rules-only. This drives the real default ports against a real sidecar
// process in a temp home (the sidecar's own dist/main.js, through JEVRIS_SIDECAR_ENTRY): the
// graceful stop, the start, the same endpoint. Only the build ids are labelled by the test, so
// the running sidecar counts as older. No harness binary, no real home, no model call. The same
// ports call @jevris/sidecar, which picks the socket or named pipe per OS through @jevris/platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');
const { refreshSidecarBuild } = await import('../dist/runtime-commands.js');
const sidecar = await import('@jevris/sidecar');

const OLD = '1111111111111111';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A short home: a socket path stays under the OS limit. */
function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'jvr-')));
}

async function withEntry(run) {
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = MAIN;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
  }
}

/** The real ports, with the first health answer labelled as an older build. */
function realPortsRunningOld(installedId) {
  let asked = 0;
  return {
    probe: async (home) => {
      const probe = await sidecar.probeSidecar(home, 500);
      return { running: probe.running && probe.foreign !== true, pid: probe.endpoint?.pid ?? null, supervised: probe.endpoint?.supervised === true };
    },
    health: async (home) => {
      const answer = await sidecar.sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
      asked += 1;
      return asked === 1 && answer.ok ? { ok: true, result: { ...answer.result, build: OLD } } : answer;
    },
    stop: (home) => sidecar.stopSidecarProcess(home),
    start: async (home) => {
      const ensured = await sidecar.ensureSidecar({ home, waitMs: 60_000 });
      return ensured.ok ? { ok: true } : { ok: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}` };
    },
    installedBuild: () => ({ id: installedId }),
  };
}

test('a running sidecar is replaced by a new process (on the same socket path off Windows), and answers at once (pair: none before means none after)', async () => {
  const home = tempHome();
  try {
    await withEntry(async () => {
      const first = await sidecar.ensureSidecar({ home, waitMs: 60_000 });
      assert.equal(first.ok, true, JSON.stringify(first));
      const before = await sidecar.probeSidecar(home, 500);
      const built = await sidecar.sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
      assert.equal(built.ok, true);
      const installedId = built.result.build ?? 'ffffffffffffffff';
      const line = await refreshSidecarBuild({ home, runtimeDir: '/unused', ports: realPortsRunningOld(installedId), env: {} });
      const after = await sidecar.probeSidecar(home, 500);
      assert.equal(after.running, true, `${String(line)}: a sidecar answers after the install`);
      assert.notEqual(after.endpoint.pid, before.endpoint.pid, 'a new process');
      assert.equal(alive(before.endpoint.pid), false, 'the old one exited');
      // A Unix socket keeps its path. A Windows pipe name carries a random part chosen at every start.
      if (process.platform === 'win32') assert.notEqual(after.endpoint.endpoint, before.endpoint.endpoint, 'a new pipe name');
      else assert.equal(after.endpoint.endpoint, before.endpoint.endpoint, 'the same endpoint');
      const ping = await sidecar.sidecarRequest({ home, op: 'ping', scope: 'hook' });
      assert.equal(ping.ok, true, 'the first hook after the install is answered');
      assert.match(line, /^sidecar build: restarted the sidecar/, `build ${String(built.result.build)}`);
      await sidecar.stopSidecarProcess(home);
      const none = await refreshSidecarBuild({ home, runtimeDir: '/unused', ports: realPortsRunningOld(installedId), env: {} });
      assert.equal(none, null, 'nothing ran before, so nothing is started');
      assert.equal((await sidecar.probeSidecar(home, 500)).running, false);
    });
  } finally {
    await sidecar.stopSidecarProcess(home).catch(() => undefined);
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('autostart off stops the old sidecar and starts none (real ports)', async () => {
  const home = tempHome();
  try {
    await withEntry(async () => {
      const first = await sidecar.ensureSidecar({ home, waitMs: 60_000 });
      assert.equal(first.ok, true, JSON.stringify(first));
      const line = await refreshSidecarBuild({ home, runtimeDir: '/unused', ports: realPortsRunningOld('ffffffffffffffff'), env: { JEVRIS_SIDECAR_AUTOSTART: '0' } });
      assert.match(line, /autostart is off \(JEVRIS_SIDECAR_AUTOSTART=0\)/);
      assert.equal((await sidecar.probeSidecar(home, 500)).running, false, 'nothing was started');
    });
  } finally {
    await sidecar.stopSidecarProcess(home).catch(() => undefined);
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
