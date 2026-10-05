import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// CI run 37259348616 (windows-latest, commit d5efc10): "a request is traced from receipt to
// outcome" failed with `refusals are traced`. The refusal had happened (the hook-scope
// diagnostic.set was answered SCOPE_DENIED) but its trace line was not in the file. The trace is
// queued and written asynchronously, and two things could lose a line there, both reproduced by
// injecting the fault below into the write of the trace file:
//   - a write that fails for a moment (EPERM, EBUSY, EACCES) dropped its whole chunk, never tried again;
//   - a stop returned while the last write was still in flight, so a read right after it missed lines.
// Deterministic: the write of a trace file (never any other file) is held, failed or passed by the
// test, and every wait is on state. This file runs in its own process, so patching fs here affects
// no other test; the patch goes in before the product modules load.

const realWrite = fs.write;
const realOpenSync = fs.openSync;
const realCloseSync = fs.closeSync;
const traceFds = new Set();
/** What to do with the write of a trace chunk: 'pass', 'hold' (until `held` is released) or an error code. */
let plan = () => 'pass';
/** Trace writes held back; each entry performs the real write when called. */
const held = [];
/** Every write of a trace file the product started, as text. */
const started = [];
fs.openSync = function openSync(path, ...rest) {
  const fd = realOpenSync.call(this, path, ...rest);
  if (/trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(String(path))) traceFds.add(fd);
  return fd;
};
fs.closeSync = function closeSync(fd) {
  traceFds.delete(fd);
  return realCloseSync.call(this, fd);
};
fs.write = function write(fd, chunk, ...rest) {
  const done = rest[rest.length - 1];
  if (!traceFds.has(fd) || typeof chunk !== 'string' || typeof done !== 'function') return realWrite.call(this, fd, chunk, ...rest);
  started.push(chunk);
  const verdict = plan(chunk);
  if (verdict === 'pass') return realWrite.call(this, fd, chunk, ...rest);
  if (verdict === 'hold') {
    held.push(() => realWrite.call(fs, fd, chunk, ...rest));
    return undefined;
  }
  setImmediate(() => done(Object.assign(new Error(`${verdict}: injected`), { code: verdict, syscall: 'write' })));
  return undefined;
};
syncBuiltinESMExports();

const { startDaemon, sidecarRequest, openTelemetry } = await import('../dist/index.js');
const { TRACE_DIR } = await import('../dist/telemetry.js');
const { jevrisPaths } = await import('@jevris/platform');

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, what) {
  for (let i = 0; i < 6_000 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `never happened: ${what}`);
}

function reset(next = () => 'pass') {
  plan = next;
  held.length = 0;
  started.length = 0;
}

function traceLines(stateDir) {
  const dir = join(stateDir, TRACE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}

function tempState() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'b-trace-dur-')));
}

test('close() waits for the write in flight and for the lines queued behind it: a stop never leaves accepted lines unwritten', async () => {
  const stateDir = tempState();
  reset((chunk) => (chunk.includes('unit.one') ? 'hold' : 'pass'));
  try {
    const t = openTelemetry({ stateDir });
    t.trace({ event: 'unit.one' });
    await until(() => held.length === 1, 'the first write is in flight');
    t.trace({ event: 'unit.two' }); // queued behind the write in flight
    let closed = false;
    const closing = t.close().then(() => {
      closed = true;
    });
    for (let i = 0; i < 10; i += 1) await turn();
    assert.equal(closed, false, 'close() returned with a write still in flight');
    assert.deepEqual(traceLines(stateDir), [], 'nothing has landed yet');
    held.shift()(); // the disk answers
    await closing;
    assert.deepEqual(traceLines(stateDir).map((line) => line.event), ['unit.one', 'unit.two'], 'both lines, in order, by the time close() resolves');
    assert.equal(t.dropped(), 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`a trace write that fails twice with ${code} is tried again: every line lands in order and none is counted dropped`, async () => {
    const stateDir = tempState();
    let failures = 0;
    reset((chunk) => {
      if (!chunk.includes('unit.refused') || failures >= 2) return 'pass';
      failures += 1;
      return code;
    });
    try {
      const t = openTelemetry({ stateDir });
      t.trace({ event: 'unit.before' });
      t.trace({ event: 'unit.refused', reasonCode: 'SCOPE_DENIED' });
      await turn(); // the chunk is now in flight, so close() waits for it as a stop does
      t.trace({ event: 'unit.after' });
      await t.close();
      assert.equal(failures, 2, 'the injected failures were met');
      assert.deepEqual(traceLines(stateDir).map((line) => line.event), ['unit.before', 'unit.refused', 'unit.after']);
      assert.equal(t.dropped(), 0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test('a trace write that never succeeds drops its lines, counts them, and neither throws nor holds a stop', async () => {
  const stateDir = tempState();
  reset((chunk) => (chunk.includes('unit.lost') ? 'EPERM' : 'pass'));
  try {
    const t = openTelemetry({ stateDir });
    t.trace({ event: 'unit.lost' });
    await turn();
    await t.close();
    assert.equal(t.dropped(), 1);
    assert.deepEqual(traceLines(stateDir), []);
    assert.equal(started.filter((chunk) => chunk.includes('unit.lost')).length, 5, 'the first try and four more, no more');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a non-transient trace write error drops the chunk at once, with no second try', async () => {
  const stateDir = tempState();
  reset((chunk) => (chunk.includes('unit.full') ? 'ENOSPC' : 'pass'));
  try {
    const t = openTelemetry({ stateDir });
    t.trace({ event: 'unit.full' });
    await turn();
    await t.close();
    assert.equal(t.dropped(), 1);
    assert.equal(started.length, 1, 'no retry');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a refusal is traced even when the write that carries it fails for a moment (CI 37259348616: refusals are traced)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-trace-daemon-')));
  const root = join(home, 'repo');
  mkdirSync(root);
  const stateDir = jevrisPaths({ home }).state;
  let failures = 0;
  reset((chunk) => {
    if (!chunk.includes('SCOPE_DENIED') || failures >= 2) return 'pass';
    failures += 1;
    return 'EPERM';
  });
  const running = await startDaemon({ home, packageOps: false, idleMs: 0, engine: null, subscribers: [], log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, subscriberSliceMs: 60_000 });
  assert.equal(running.ok, true, running.ok ? '' : running.message);
  try {
    await running.daemon.state.startupMaintenance();
    const refused = await sidecarRequest({ home, op: 'diagnostic.set', scope: 'hook', timeoutMs: 60_000, body: { minutes: 5 } });
    assert.equal(refused.reasonCode, 'SCOPE_DENIED');
    const status = await sidecarRequest({ home, op: 'status', scope: 'hook', timeoutMs: 60_000, workspace: root, body: {} });
    assert.equal(status.ok, true, JSON.stringify(status));
  } finally {
    await running.daemon.stop('test');
  }
  try {
    assert.equal(failures, 2, 'the injected failures were met');
    const lines = traceLines(stateDir);
    const refusal = lines.find((line) => line.event === 'request.outcome' && line.reasonCode === 'SCOPE_DENIED');
    assert.ok(refusal, `refusals are traced: ${JSON.stringify(lines.map((line) => [line.event, line.reasonCode]))}`);
    assert.deepEqual(
      lines.filter((line) => line.rid === refusal.rid).map((line) => line.event),
      ['request.received', 'request.outcome'],
      'the refusal is traced from receipt to outcome, once each',
    );
    assert.ok(lines.some((line) => line.event === 'request.outcome' && line.op === 'status'), 'the request after it is traced too, behind it');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
