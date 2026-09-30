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
function sidecar({ running = true, pid = 63410, supervised = false, build = OLD, runs = 0, healthy = true, stops = true, installed = NEW, starts = true, startsAs = NEW } = {}) {
  const calls = [];
  let started = false;
  return {
    calls,
    ports: {
      probe: async () => (calls.push('probe'), { running, pid, supervised }),
      health: async () => (calls.push('health'), healthy ? { ok: true, result: { pid, version: '1.2.0', build: started ? startsAs : build, verificationRuns: runs } } : { ok: false }),
      stop: async () => (calls.push('stop'), { stopped: stops }),
      start: async () => (calls.push('start'), (started = starts), starts ? { ok: true } : { ok: false, reasonCode: 'SIDECAR_STARTING' }),
      installedBuild: (dir) => (calls.push(`build ${dir}`), installed === null ? null : { id: installed }),
    },
  };
}

const refresh = (stub, env = {}) => refreshSidecarBuild({ home: '/h', runtimeDir: '/h/.jevris/runtime/1.2.0', ports: stub.ports, env });

test('install leaves a sidecar on the installed build alone, and one on another build is stopped with one line (pair)', async () => {
  const same = sidecar({ build: NEW });
  assert.equal(await refresh(same), null);
  assert.deepEqual(same.calls, ['build /h/.jevris/runtime/1.2.0', 'probe', 'health'], 'same build: nothing is stopped');
  const older = sidecar();
  assert.equal(await refresh(older), 'sidecar build: restarted the sidecar (pid 63410) on the installed build (it ran an older build); hooks are answered again at once');
  assert.deepEqual(older.calls.filter((call) => call === 'stop' || call === 'start'), ['stop', 'start'], 'stopped first, then started');
});

test('a sidecar from before build ids is stopped too: it cannot retire itself', async () => {
  const legacy = sidecar({ build: null });
  assert.match(await refresh(legacy), /^sidecar build: restarted the sidecar \(pid 63410\) on the installed build/);
  assert.ok(legacy.calls.includes('stop'));
});

test('a verification run under way is never cut off: the sidecar finishes it and retires itself; with none it stops now (pair)', async () => {
  const busy = sidecar({ runs: 2 });
  assert.equal(await refresh(busy), 'sidecar build: the sidecar (pid 63410) runs an older build and is finishing 2 verification runs; it restarts on the installed build once they end');
  assert.equal(busy.calls.includes('stop'), false);
  const one = sidecar({ runs: 1 });
  assert.match(await refresh(one), /is finishing a verification run; it restarts on the installed build once it ends$/);
  assert.ok((await refresh(sidecar({ runs: 0 }))).startsWith('sidecar build: restarted'));
  assert.equal(busy.calls.includes('start'), false, 'a busy sidecar is never started over');
});

test('a supervised sidecar is left to its service manager, which restarts it on the new build; an unsupervised one is stopped (pair)', async () => {
  const supervised = sidecar({ supervised: true });
  assert.equal(await refresh(supervised), 'sidecar build: the sidecar (pid 63410) runs an older build; its service restarts it on the installed build within a minute, once it is idle');
  assert.equal(supervised.calls.includes('stop'), false);
  assert.equal(supervised.calls.includes('start'), false, 'never a second, unsupervised sidecar next to the service');
  assert.ok((await refresh(sidecar({ supervised: false }))).startsWith('sidecar build: restarted'));
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
  assert.equal(stuck.calls.includes('start'), false, 'a sidecar that did not stop is not started over');
  assert.match(await refresh(throwing), /could not be checked; if it misbehaves, run jevris sidecar restart$/);
});

test('install starts the installed build after the graceful stop, and only when a sidecar ran before (pair)', async () => {
  const older = sidecar();
  assert.match(await refresh(older), /^sidecar build: restarted the sidecar \(pid 63410\) on the installed build/);
  assert.deepEqual(older.calls.filter((call) => ['stop', 'start'].includes(call)), ['stop', 'start']);
  const none = sidecar({ running: false });
  assert.equal(await refresh(none), null, 'no sidecar before install means none after');
  assert.equal(none.calls.includes('start'), false);
  const same = sidecar({ build: NEW });
  assert.equal(await refresh(same), null);
  assert.equal(same.calls.includes('start'), false, 'a sidecar already on the installed build is left alone');
});

test('a supervised sidecar is never duplicated: not stopped, not started, also when it predates build ids (pair)', async () => {
  const legacy = sidecar({ supervised: true, build: null });
  assert.equal(await refresh(legacy), 'sidecar build: the sidecar (pid 63410) is supervised and runs a build from before build ids, which cannot retire itself; fix: jevris service install');
  assert.equal(legacy.calls.includes('stop'), false);
  assert.equal(legacy.calls.includes('start'), false);
  const modern = sidecar({ supervised: true });
  assert.match(await refresh(modern), /its service restarts it on the installed build/);
  assert.equal(modern.calls.includes('start'), false);
});

test('JEVRIS_SIDECAR_AUTOSTART=0 stops the old build but starts nothing, and says how to start it (pair)', async () => {
  const off = sidecar();
  assert.equal(await refresh(off, { JEVRIS_SIDECAR_AUTOSTART: '0' }), 'sidecar build: stopped the sidecar (pid 63410), which ran an older build; autostart is off (JEVRIS_SIDECAR_AUTOSTART=0), so nothing starts the installed build; fix: jevris sidecar start');
  assert.equal(off.calls.includes('start'), false);
  const on = sidecar();
  assert.match(await refresh(on, { JEVRIS_SIDECAR_AUTOSTART: '1' }), /^sidecar build: restarted/);
  assert.ok(on.calls.includes('start'));
});

test('a start that fails is one plain line with the reason code and the fix, and never throws; a start on another build says so (pair)', async () => {
  const failing = sidecar({ starts: false });
  assert.equal(await refresh(failing), 'sidecar build: stopped the sidecar (pid 63410), which ran an older build; the installed build did not start (SIDECAR_STARTING); fix: the next hook or jevris sidecar start starts it');
  const throwing = sidecar();
  throwing.ports.start = async () => { throw new Error('boom'); };
  assert.match(await refresh(throwing), /did not start \(SIDECAR_UNAVAILABLE\); fix: the next hook or jevris sidecar start starts it$/);
  const other = sidecar({ startsAs: OLD });
  assert.match(await refresh(other), new RegExp(`runs another build than the installed one \\(${OLD}, installed ${NEW}\\); fix: jevris sidecar restart$`));
});

test('install exits 0 and prints the reason when the restart fails, and starts nothing when autostart is off (pair)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-sidecar-restart-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const run = async (hooks) => {
    let text = '';
    const code = await main(['install', '--yes', '--home', home, '--harness', 'kilocode', '--no-smoke', '--no-certify'], (chunk) => (text += chunk), { isTTY: false, ...hooks });
    return { code, text };
  };
  const failing = sidecar({ starts: false });
  const failed = await run({ sidecarBuild: failing.ports });
  assert.equal(failed.code, 0, failed.text);
  assert.match(failed.text, /^sidecar build: stopped the sidecar \(pid 63410\), which ran an older build; the installed build did not start \(SIDECAR_STARTING\); fix: /m);
  const off = sidecar();
  const skipped = await run({ sidecarBuild: off.ports, env: { ...process.env, JEVRIS_SIDECAR_AUTOSTART: '0' } });
  assert.equal(skipped.code, 0, skipped.text);
  assert.match(skipped.text, /autostart is off \(JEVRIS_SIDECAR_AUTOSTART=0\)/);
  assert.equal(off.calls.includes('start'), false);
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
  assert.match(first.text, /^sidecar build: restarted the sidecar \(pid 63410\) on the installed build/m);
  assert.ok(older.calls.some((call) => call.startsWith('build ') && /[\\/]runtime[\\/]/.test(call)), 'compared with the runtime folder just installed');
  const none = await run({ sidecarBuild: sidecar({ running: false }).ports });
  assert.equal(none.code, 0, none.text);
  assert.doesNotMatch(none.text, /sidecar build:/);
});
