// The trace file's synchronous write is not a try-once (slow-host gate, `--fs-error-first`).
// `fdLineWriter.writeSync` is what `close()` and `flushSync` reach when a chunk is queued but not
// yet in flight. It tried once and dropped the chunk on EPERM, EBUSY or EACCES, where the asynchronous
// write waits out the same error (5, 10, 20, 40 ms) and the sidecar log's synchronous write does too:
// on the fixed product "trace lines keep only bounded codes" and "diagnostic mode" (telemetry.test.mjs)
// still lost a line when the first trace write of the day was refused for a moment. Now the synchronous
// write is tried APPEND_TRIES times with the same waits, and a stop that is awaited has every line on
// disk. A day change (on a request) does not wait: it writes the old day's last chunk through the
// asynchronous path. Deterministic: the writes are injected and no wait is on a guessed duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The trace files of a telemetry the test opens: the write to such a descriptor is the one the
// telemetry tests below plan. Nothing else is touched, and the patch goes in before the product loads.
const realWriteSync = fs.writeSync;
const realOpenSync = fs.openSync;
const realCloseSync = fs.closeSync;
const traceFds = new Set();
/** What the next synchronous write of a trace file does: an error code to throw, or undefined to write. */
let tracePlan = () => undefined;
/** Every synchronous write of a trace file the product started, as text. */
const traceSyncWrites = [];
fs.openSync = function openSync(path, ...rest) {
  const fd = realOpenSync.call(this, path, ...rest);
  if (/trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(String(path))) traceFds.add(fd);
  return fd;
};
fs.closeSync = function closeSync(fd) {
  traceFds.delete(fd);
  return realCloseSync.call(this, fd);
};
fs.writeSync = function writeSync(fd, ...rest) {
  if (!traceFds.has(fd)) return realWriteSync.call(this, fd, ...rest);
  const code = tracePlan(traceSyncWrites.length);
  traceSyncWrites.push(String(rest[0]));
  if (code !== undefined) throw fault(code);
  return realWriteSync.call(this, fd, ...rest);
};
syncBuiltinESMExports();

const { fdLineWriter, APPEND_TRIES } = await import('../dist/line-writer.js');
const { openTelemetry } = await import('../dist/index.js');
const { TRACE_DIR } = await import('../dist/telemetry.js');

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, what) {
  for (let i = 0; i < 6_000 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `never happened: ${what}`);
}
function fault(code) {
  return Object.assign(new Error(`${code}: injected`), { code, syscall: 'write' });
}
const text = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'b-syncretry-')));

/**
 * An fd writer whose synchronous and asynchronous writes are injected. `syncPlan(index)` and
 * `asyncPlan(index)` name the error code for that start (undefined: it writes, to the real file).
 */
function rig(dir, { syncPlan = () => undefined, asyncPlan = () => undefined } = {}) {
  const path = join(dir, 'trace.jsonl');
  const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
  const syncCalls = [];
  const asyncCalls = [];
  const injected = {
    writeSync: (_fd, chunk) => {
      const code = syncPlan(syncCalls.length);
      syncCalls.push(chunk);
      if (code !== undefined) throw fault(code);
      return realWriteSync(fd, chunk);
    },
    write: (_fd, chunk, done) => {
      const code = asyncPlan(asyncCalls.length);
      asyncCalls.push(chunk);
      setImmediate(() => {
        if (code !== undefined) return done(fault(code));
        realWriteSync(fd, chunk);
        return done(null);
      });
    },
  };
  return { writer: fdLineWriter(fd, 0, { fs: injected }), syncCalls, asyncCalls, text: () => text(path), close: () => closeSync(fd) };
}

// The two ways a queued chunk reaches the synchronous write: `flushSync`, and the close of a file
// (`drained`/`drainThen`, which the telemetry's `close()` and a day change use) with nothing in flight.
const reach = {
  flushSync: (writer) => writer.flushSync(),
  drained: (writer) => writer.drained(),
};

for (const [via, go] of Object.entries(reach)) {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    test(`a synchronous write (${via}) that fails twice with ${code} is tried again and lands: the lines are written once, in order, none dropped`, async () => {
      const dir = temp();
      const h = rig(dir, { syncPlan: (index) => (index < 2 ? code : undefined) });
      try {
        for (let i = 0; i < 3; i += 1) assert.equal(h.writer.write(`line ${i}\n`), true);
        await go(h.writer);
        assert.equal(h.text(), 'line 0\nline 1\nline 2\n');
        assert.equal(h.writer.dropped(), 0);
        assert.deepEqual(h.syncCalls, Array(3).fill('line 0\nline 1\nline 2\n'), 'the same chunk each time');
        assert.equal(h.asyncCalls.length, 0, 'it never went through the asynchronous path');
        assert.equal(h.writer.size(), 21, 'the byte counter counts the chunk once');
      } finally {
        h.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`a synchronous write (${via}) that always fails with a transient error gives up after ${APPEND_TRIES} tries: its lines are dropped and counted, nothing hangs, the writer keeps working`, async () => {
    const dir = temp();
    let broken = true;
    const h = rig(dir, { syncPlan: () => (broken ? 'EPERM' : undefined) });
    try {
      h.writer.write('lost 1\n');
      h.writer.write('lost 2\n');
      await go(h.writer);
      assert.equal(h.syncCalls.length, APPEND_TRIES, 'the first try and one after each wait, no more');
      assert.equal(h.writer.dropped(), 2, 'every line of the chunk is counted');
      assert.equal(h.text(), '');
      assert.equal(h.writer.size(), 0, 'dropped bytes are not counted as written');
      broken = false;
      h.writer.write('kept\n');
      await go(h.writer);
      assert.equal(h.text(), 'kept\n');
      assert.equal(h.writer.dropped(), 2);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const code of ['ENOSPC', 'EIO', 'EBADF']) {
    test(`a synchronous write (${via}) that fails with ${code} is not tried again: the chunk is dropped and counted as before`, async () => {
      const dir = temp();
      const h = rig(dir, { syncPlan: (index) => (index === 0 ? code : undefined) });
      try {
        h.writer.write('one\n');
        h.writer.write('two\n');
        await go(h.writer);
        assert.equal(h.syncCalls.length, 1, 'no second try');
        assert.equal(h.writer.dropped(), 2);
        assert.equal(h.text(), '');
        h.writer.write('three\n');
        await go(h.writer);
        assert.equal(h.text(), 'three\n');
        assert.equal(h.syncCalls.length, 2);
      } finally {
        h.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('flushSync while a chunk waits out a failed asynchronous write, and its own synchronous write fails once too: the waiting chunk, then the queued line, each written once and in order', async (t) => {
  const dir = temp();
  // The first synchronous try (the waiting chunk) is refused, the rest pass.
  const h = rig(dir, { asyncPlan: (index) => (index === 0 ? 'EPERM' : undefined), syncPlan: (index) => (index === 0 ? 'EBUSY' : undefined) });
  try {
    h.writer.write('a1\n');
    await turn(); // the write starts
    assert.equal(h.asyncCalls.length, 1);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await turn(); // its EPERM arrives: the back-off timer is pending, under the mock clock
    h.writer.write('b1\n');
    h.writer.flushSync();
    assert.equal(h.text(), 'a1\nb1\n', 'the waiting chunk first');
    assert.deepEqual(h.syncCalls, ['a1\n', 'a1\n', 'b1\n'], 'the refused try, the waiting chunk again, then the queued line');
    assert.equal(h.writer.dropped(), 0);
    t.mock.timers.tick(10_000);
    for (let i = 0; i < 5; i += 1) await turn();
    assert.equal(h.asyncCalls.length, 1, 'the cancelled retry never started');
    assert.equal(h.text(), 'a1\nb1\n', 'nothing written twice');
  } finally {
    t.mock.timers.reset();
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainThen({ blocking: false }) writes a queued chunk through the asynchronous path, with its asynchronous retries, and never waits on the synchronous one', async () => {
  const dir = temp();
  const h = rig(dir, { asyncPlan: (index) => (index === 0 ? 'EBUSY' : undefined), syncPlan: () => 'EPERM' });
  try {
    h.writer.write('x1\n');
    h.writer.write('x2\n');
    let ran = false;
    h.writer.drainThen(() => {
      ran = true;
    }, { blocking: false });
    assert.equal(h.syncCalls.length, 0, 'no synchronous write, so no wait on the caller');
    assert.equal(ran, false, 'the closer waits for the write');
    await until(() => ran, 'the closer ran');
    assert.equal(h.text(), 'x1\nx2\n');
    assert.equal(h.asyncCalls.length, 2, 'the refused write was tried again, asynchronously');
    assert.equal(h.syncCalls.length, 0);
    assert.equal(h.writer.dropped(), 0);
    h.writer.write('y\n');
    await turn();
    await h.writer.drained();
    assert.equal(h.text(), 'x1\nx2\ny\n', 'the writer keeps working');
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainThen({ blocking: false }) with nothing queued runs the closer at once', () => {
  const dir = temp();
  const h = rig(dir);
  try {
    let ran = false;
    h.writer.drainThen(() => {
      ran = true;
    }, { blocking: false });
    assert.equal(ran, true);
    assert.equal(h.syncCalls.length + h.asyncCalls.length, 0);
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same through the telemetry the sidecar runs: the descriptor is the trace file's, the write
// is the one `close()` makes, and a refusal is injected into the synchronous write of that file.
function traceLines(stateDir) {
  const dir = join(stateDir, TRACE_DIR);
  if (!existsSync(dir)) return {};
  const byDay = {};
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl'))) {
    byDay[name.slice('trace-'.length, -'.jsonl'.length)] = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  return byDay;
}

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`the telemetry's close() waits out a transient ${code} on the trace file's synchronous write: the line is on disk when it resolves, nothing is dropped`, async () => {
    const stateDir = temp();
    traceSyncWrites.length = 0;
    tracePlan = (index) => (index < 2 ? code : undefined);
    try {
      mkdirSync(stateDir, { recursive: true });
      const telemetry = openTelemetry({ stateDir, now: () => Date.parse('2026-03-01T10:00:00.000Z') });
      telemetry.trace({ event: 'unit.step', ok: true });
      await telemetry.close();
      const days = traceLines(stateDir);
      assert.deepEqual(Object.keys(days), ['2026-03-01']);
      assert.equal(days['2026-03-01'].length, 1, 'the trace line is in the file');
      assert.equal(days['2026-03-01'][0].event, 'unit.step');
      assert.equal(telemetry.dropped(), 0);
      assert.ok(traceSyncWrites.length >= 3, `refused twice, then written (a slow-host run may refuse one more): ${traceSyncWrites.length} tries`);
    } finally {
      tracePlan = () => undefined;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test('a day change on a request writes the old day through the asynchronous path: no synchronous write (and so no wait) in the request, no line lost', async () => {
  const stateDir = temp();
  traceSyncWrites.length = 0;
  // Any synchronous write in the request would be refused and waited out; none may be started.
  tracePlan = () => 'EBUSY';
  let at = Date.parse('2026-03-01T23:59:59.990Z');
  try {
    const telemetry = openTelemetry({ stateDir, now: () => at });
    telemetry.trace({ event: 'unit.before', ok: true }); // queued, not yet written
    at = Date.parse('2026-03-02T00:00:00.010Z');
    telemetry.trace({ event: 'unit.after', ok: true }); // the day changed: the old day's file is closed
    assert.equal(traceSyncWrites.length, 0, 'the day change did not write synchronously');
    tracePlan = () => undefined;
    await telemetry.close();
    const days = traceLines(stateDir);
    assert.deepEqual(days['2026-03-01']?.map((line) => line.event), ['unit.before']);
    assert.deepEqual(days['2026-03-02']?.map((line) => line.event), ['unit.after']);
    assert.equal(telemetry.dropped(), 0);
  } finally {
    tracePlan = () => undefined;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
