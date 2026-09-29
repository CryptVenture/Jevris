// Owner report: a reinstall of the same version left the running sidecar on the old code (the
// hook was new, the sidecar old). Install and upgrade compare the running sidecar's build with
// the runtime just installed (build ids, never the version string) and move it onto the new
// build without cutting off a verification run; doctor flags a sidecar on an older build. Stub
// sidecar ports and temp homes only; no real sidecar and no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { refreshSidecarBuild } = await import('../dist/runtime-commands.js');
const { sidecarBuildLine } = await import('../dist/doctor-cli.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { main } = await import('../dist/cli.js');

const NEW = '2222222222222222';
const OLD = '1111111111111111';

/** A stub sidecar: what it reports, and what install asked of it. */
function sidecar({ running = true, pid = 63410, supervised = false, build = OLD, runs = 0, healthy = true, stops = true, installed = NEW } = {}) {
  const calls = [];
  return {
    calls,
    ports: {
      probe: async () => (calls.push('probe'), { running, pid, supervised }),
      health: async () => (calls.push('health'), healthy ? { ok: true, result: { pid, version: '1.2.0', build, verificationRuns: runs } } : { ok: false }),
      stop: async () => (calls.push('stop'), { stopped: stops }),
      installedBuild: (dir) => (calls.push(`build ${dir}`), installed === null ? null : { id: installed }),
    },
  };
}

const refresh = (stub) => refreshSidecarBuild({ home: '/h', runtimeDir: '/h/.jevris/runtime/1.2.0', ports: stub.ports });

test('install leaves a sidecar on the installed build alone, and one on another build is stopped with one line (pair)', async () => {
  const same = sidecar({ build: NEW });
  assert.equal(await refresh(same), null);
  assert.deepEqual(same.calls, ['build /h/.jevris/runtime/1.2.0', 'probe', 'health'], 'same build: nothing is stopped');
  const older = sidecar();
  assert.equal(await refresh(older), 'sidecar build: stopped the sidecar (pid 63410), which ran an older build; the next hook or command starts the installed build');
  assert.deepEqual(older.calls.at(-1), 'stop');
});

test('a sidecar from before build ids is stopped too: it cannot retire itself', async () => {
  const legacy = sidecar({ build: null });
  assert.match(await refresh(legacy), /^sidecar build: stopped the sidecar \(pid 63410\), which ran an older build/);
  assert.ok(legacy.calls.includes('stop'));
});

test('a verification run under way is never cut off: the sidecar finishes it and retires itself; with none it stops now (pair)', async () => {
  const busy = sidecar({ runs: 2 });
  assert.equal(await refresh(busy), 'sidecar build: the sidecar (pid 63410) runs an older build and is finishing 2 verification runs; it restarts on the installed build once they end');
  assert.equal(busy.calls.includes('stop'), false);
  const one = sidecar({ runs: 1 });
  assert.match(await refresh(one), /is finishing a verification run; it restarts on the installed build once it ends$/);
  assert.ok((await refresh(sidecar({ runs: 0 }))).startsWith('sidecar build: stopped'));
});

test('a supervised sidecar is left to its service manager, which restarts it on the new build; an unsupervised one is stopped (pair)', async () => {
  const supervised = sidecar({ supervised: true });
  assert.equal(await refresh(supervised), 'sidecar build: the sidecar (pid 63410) runs an older build; its service restarts it on the installed build within a minute, once it is idle');
  assert.equal(supervised.calls.includes('stop'), false);
  assert.ok((await refresh(sidecar({ supervised: false }))).startsWith('sidecar build: stopped'));
});

test('nothing running, no bundle installed, or no answer: no stop, and at most one line with the fix', async () => {
  const idle = sidecar({ running: false });
  assert.equal(await refresh(idle), null);
  assert.equal(idle.calls.includes('health'), false);
  const noBundle = sidecar({ installed: null });
  assert.equal(await refresh(noBundle), null);
  assert.equal(noBundle.calls.includes('probe'), false);
  const silent = sidecar({ healthy: false });
  assert.equal(await refresh(silent), 'sidecar build: the sidecar (pid 63410) did not answer, so its build is unknown; if it misbehaves, run jevris sidecar restart');
  assert.equal(silent.calls.includes('stop'), false);
  const stuck = sidecar({ stops: false });
  assert.equal(await refresh(stuck), 'sidecar build: the sidecar (pid 63410) runs an older build and did not stop; fix: jevris sidecar restart');
  const throwing = { ports: { ...sidecar().ports, probe: async () => { throw new Error('boom'); } } };
  assert.match(await refresh(throwing), /could not be checked; if it misbehaves, run jevris sidecar restart$/);
});

test('doctor flags a running sidecar on an older build than the installed runtime, as an action; the same build has no line (pair)', () => {
  const view = (build, state = 'running') => ({ state, pid: 63410, ...(build === undefined ? {} : { build }) });
  assert.equal(sidecarBuildLine(view({ running: NEW, installed: NEW, verificationRuns: 0 })), null);
  assert.equal(sidecarBuildLine(view(undefined)), null, 'no bundle here: nothing to compare');
  assert.equal(sidecarBuildLine(view({ running: OLD, installed: NEW, verificationRuns: 0 }, 'idle')), null, 'not running: nothing runs old code');
  const line = sidecarBuildLine(view({ running: OLD, installed: NEW, verificationRuns: 0 }));
  assert.equal(line, `sidecar build: the sidecar (pid 63410) runs an older build than the installed runtime (running ${OLD}, installed ${NEW}); fix: jevris sidecar restart`);
  assert.equal(doctorLineSeverity(line), 'action');
  assert.match(sidecarBuildLine(view({ running: null, installed: NEW, verificationRuns: 1 })), /\(running a build from before build ids, installed 2{16}\); it restarts by itself once its verification run ends; fix: jevris sidecar restart$/);
  assert.equal(doctorLineSeverity('sidecar: running; pid 1, version 1.2.0; store ok; kill switch clear'), 'ok', 'the sidecar line keeps its own severity');
});

test('install prints the sidecar build line after a real install into a temp home, and none when no sidecar runs (pair)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-sidecar-build-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const run = async (hooks) => {
    let text = '';
    const code = await main(['install', '--yes', '--home', home, '--harness', 'kilocode', '--no-smoke', '--no-certify'], (chunk) => (text += chunk), { isTTY: false, ...hooks });
    return { code, text };
  };
  const older = sidecar();
  const first = await run({ sidecarBuild: older.ports });
  assert.equal(first.code, 0, first.text);
  assert.match(first.text, /^sidecar build: stopped the sidecar \(pid 63410\), which ran an older build/m);
  assert.ok(older.calls.some((call) => call.startsWith('build ') && /[\\/]runtime[\\/]/.test(call)), 'compared with the runtime folder just installed');
  const none = await run({ sidecarBuild: sidecar({ running: false }).ports });
  assert.equal(none.code, 0, none.text);
  assert.doesNotMatch(none.text, /sidecar build:/);
});
