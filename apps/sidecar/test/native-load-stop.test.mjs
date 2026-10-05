// A stop never ends the maintenance worker inside the load of the SQLite addon. A thread ended there
// aborts the whole sidecar (SIGABRT, "FATAL ERROR: Error::New napi_get_last_error_info"), which then
// leaves its endpoint file behind: the doctor view of such a home reads "not-running" with a last run
// that "ended without cleaning up". The worker is a fixture (fixtures/native-load-worker.mjs) that
// does what the real one does around the load with the slow parts sized by the test, so every
// ordering is deterministic and no test process can abort. A thread ended inside the load shows as a
// load that never reaches its "loaded" line. Temporary folders only; no real addon, store or sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const { sweepInWorker, enterNativeLoad, leaveNativeLoad, NATIVE_LOAD, NATIVE_LOAD_WAIT_MS } = await import('../dist/maintenance.js');
const FIXTURE = new URL('./fixtures/native-load-worker.mjs', import.meta.url);

/** Starts the fixture worker; `done` ends it and its temporary folder. */
function start(waits, loadWaitMs) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nl-stop-')));
  const log = join(dir, 'steps.log');
  const running = sweepInWorker(FIXTURE, { path: log, hostScope: JSON.stringify(waits), policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: 0, rawDir: dir }, undefined, loadWaitMs);
  const steps = () => {
    try {
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const until = async (step) => {
    const stop = Date.now() + 60_000;
    while (!steps().includes(step) && Date.now() < stop) await sleep(5);
    assert.ok(steps().includes(step), `the worker reached "${step}": ${steps().join(', ')}`);
  };
  const done = async () => {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { running, steps, until, done };
}

test('a stop that arrives while the worker is inside the native load waits for the load to end', async () => {
  const worker = start({ bootMs: 0, loadMs: 600 });
  try {
    await worker.until('loading');
    const began = Date.now();
    await worker.running.stop();
    assert.deepEqual(worker.steps(), ['booted', 'loading', 'loaded'], 'the load ran to its end before the thread was ended');
    assert.ok(Date.now() - began < 30_000, 'and the sweep after it was ended, not waited for');
    assert.deepEqual(await worker.running.done, { ok: false, reason: 'MAINTENANCE_STOPPED', where: 'worker' });
  } finally {
    await worker.done();
  }
});

test('a stop that arrives before the worker begins the load does not wait for the boot, and no load begins', async () => {
  const worker = start({ bootMs: 30_000, loadMs: 600 });
  try {
    await worker.until('booted');
    const began = Date.now();
    await worker.running.stop();
    assert.ok(Date.now() - began < 20_000, 'a thread that is only booting is ended at once');
    assert.deepEqual(worker.steps(), ['booted'], 'the load never began');
  } finally {
    await worker.done();
  }
});

test('a load that outlasts the wait is ended anyway once the wait is over', async () => {
  const worker = start({ bootMs: 0, loadMs: 8000 }, 250);
  try {
    await worker.until('loading');
    const began = Date.now();
    await worker.running.stop();
    const waited = Date.now() - began;
    assert.ok(waited >= 200, `the stop waited for the load (${String(waited)} ms)`);
    assert.ok(waited < 7000, `and gave up at its bound, not at the end of the load (${String(waited)} ms)`);
    assert.deepEqual(worker.steps(), ['booted', 'loading'], 'the load was cut off');
  } finally {
    await worker.done();
  }
});

test('the worker side of the handshake: it loads unless it was told to stop, and records the load only while it runs', () => {
  assert.equal(NATIVE_LOAD_WAIT_MS, 5000, 'the default wait');
  const state = (shared) => Atomics.load(new Int32Array(shared), 0);
  const running = new SharedArrayBuffer(4);
  assert.equal(enterNativeLoad(running), true);
  assert.equal(state(running), NATIVE_LOAD.loading);
  leaveNativeLoad(running);
  assert.equal(state(running), NATIVE_LOAD.loaded);

  const told = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(told), 0, NATIVE_LOAD.declined);
  assert.equal(enterNativeLoad(told), false, 'a worker told to stop does not begin the load');
  assert.equal(state(told), NATIVE_LOAD.declined, 'and the state stays declined');

  // A worker started without the shared state (older code, a test) loads and records nothing.
  assert.equal(enterNativeLoad(undefined), true);
  assert.doesNotThrow(() => leaveNativeLoad(undefined));
  assert.equal(enterNativeLoad({}), true);
});
