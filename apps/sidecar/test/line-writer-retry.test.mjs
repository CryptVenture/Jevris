// A trace or log line is not lost to a transient write error (CI run 37259348616, windows-latest:
// "refusals are traced", one trace line missing). The sidecar log and trace are written
// asynchronously; on Windows a write can fail for a moment with EPERM, EBUSY or EACCES while a
// scanner or another handle holds the file. The writer tries the same chunk again, asynchronously,
// after 5, 10, 20 and 40 ms, before anything queued behind it, and counts the lines dropped only when
// the last try also fails (or at once for another error). Deterministic: the write is injected and
// completed by the test, and every wait is on state, never on a guessed duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, constants, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pathLineWriter, fdLineWriter, APPEND_TRIES, waitAtMost } = await import('../dist/line-writer.js');

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, what) {
  for (let i = 0; i < 6_000 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `never happened: ${what}`);
}
const text = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const fault = (code) => Object.assign(new Error(`${code}: injected`), { code });

/**
 * A writer of one kind whose asynchronous write is injected: every start is recorded in `calls` and,
 * when `auto` is given, answered from it (`auto(index)` is an error code, or undefined for success);
 * otherwise the test completes it with `ok` or `fail`. A write that succeeds lands in the real file.
 */
function harness(kind, dir, { maxPendingBytes, auto } = {}) {
  const path = join(dir, `${kind}.log`);
  const calls = [];
  const finish = (call, code) => {
    if (code === undefined) {
      appendFileSync(path, call.chunk);
      call.done(null);
    } else call.done(fault(code));
  };
  const start = (chunk, done) => {
    const call = { chunk, done, index: calls.length };
    calls.push(call);
    if (auto !== undefined) setImmediate(() => finish(call, auto(call.index)));
  };
  const bound = maxPendingBytes === undefined ? {} : { maxPendingBytes };
  let fd;
  let writer;
  if (kind === 'path') writer = pathLineWriter(path, 1024 * 1024, { ...bound, fs: { appendFile: (_path, chunk, _options, done) => start(chunk, done) } });
  else {
    fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
    writer = fdLineWriter(fd, 0, { ...bound, fs: { write: (_fd, chunk, done) => start(chunk, done) } });
  }
  return {
    writer,
    calls,
    // Lets the queued lines start their asynchronous write (drained() on a queue that has not
    // started writing would write it synchronously), then waits until the writer is done.
    flush: async () => {
      await turn();
      await writer.drained();
    },
    text: () => text(path),
    ok: (call) => finish(call, undefined),
    fail: (call, code) => finish(call, code),
    close: () => {
      if (fd !== undefined) closeSync(fd);
    },
  };
}

function temp() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'b-retry-')));
}

for (const kind of ['path', 'fd']) {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    test(`a write that fails twice with ${code} is tried again and lands: no line lost, repeated or reordered, none dropped (${kind} writer)`, async () => {
      const dir = temp();
      const h = harness(kind, dir, { auto: (index) => (index < 2 ? code : undefined) });
      try {
        for (let i = 0; i < 3; i += 1) assert.equal(h.writer.write(`line ${i}\n`), true);
        await h.flush();
        assert.equal(h.text(), 'line 0\nline 1\nline 2\n');
        assert.equal(h.writer.dropped(), 0);
        assert.deepEqual(h.calls.map((call) => call.chunk), ['line 0\nline 1\nline 2\n', 'line 0\nline 1\nline 2\n', 'line 0\nline 1\nline 2\n'], 'the same chunk each time');
        assert.equal(h.writer.size(), 21, 'the byte counter counts the chunk once');
      } finally {
        h.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`lines queued while a chunk waits out a failed write stay behind it, in order, and are written once (${kind} writer)`, async () => {
    const dir = temp();
    const h = harness(kind, dir);
    try {
      h.writer.write('a1\n');
      h.writer.write('a2\n');
      await until(() => h.calls.length === 1, 'the first write started');
      h.writer.write('b1\n'); // queued while the first write is in flight
      h.fail(h.calls[0], 'EPERM'); // now the chunk waits out its back-off
      h.writer.write('b2\n');
      await until(() => h.calls.length === 2, 'the chunk was tried again');
      assert.equal(h.calls[1].chunk, 'a1\na2\n', 'the retry is the failed chunk, ahead of what was queued behind it');
      h.ok(h.calls[1]);
      await until(() => h.calls.length === 3, 'the queued lines were written next');
      assert.equal(h.calls[2].chunk, 'b1\nb2\n');
      h.ok(h.calls[2]);
      await h.writer.drained();
      assert.equal(h.text(), 'a1\na2\nb1\nb2\n');
      assert.equal(h.writer.dropped(), 0);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a write that always fails with a transient error is tried ${APPEND_TRIES} times, then its lines are dropped and counted; the writer keeps working (${kind} writer)`, async () => {
    const dir = temp();
    let broken = true;
    const h = harness(kind, dir, { auto: () => (broken ? 'EPERM' : undefined) });
    try {
      assert.doesNotThrow(() => {
        h.writer.write('lost 1\n');
        h.writer.write('lost 2\n');
        h.writer.write('lost 3\n');
      });
      await h.flush();
      assert.equal(h.calls.length, APPEND_TRIES, 'tried the first time and again after each back-off, no more');
      assert.equal(h.writer.dropped(), 3, 'every line of the chunk is counted');
      assert.equal(h.text(), '');
      assert.equal(h.writer.size(), 0, 'dropped bytes are not counted as written');
      broken = false;
      h.writer.write('kept\n');
      await h.flush();
      assert.equal(h.text(), 'kept\n', 'a later line is written');
      assert.equal(h.calls.length, APPEND_TRIES + 1);
      assert.equal(h.writer.dropped(), 3);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const code of ['ENOSPC', 'EIO', 'EBADF']) {
    test(`a ${code} drops the chunk at once, with no second try (${kind} writer)`, async () => {
      const dir = temp();
      const h = harness(kind, dir, { auto: (index) => (index === 0 ? code : undefined) });
      try {
        h.writer.write('one\n');
        h.writer.write('two\n');
        await h.flush();
        assert.equal(h.calls.length, 1, 'no retry');
        assert.equal(h.writer.dropped(), 2);
        assert.equal(h.text(), '');
        h.writer.write('three\n');
        await h.flush();
        assert.equal(h.text(), 'three\n');
        assert.equal(h.calls.length, 2);
      } finally {
        h.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`a write that throws is a drop, not a crash or a stuck queue (${kind} writer)`, async () => {
    const dir = temp();
    const path = join(dir, 'throws.log');
    let throwing = true;
    const fs = {
      appendFile: (_path, chunk, _options, done) => {
        if (throwing) throw new TypeError('injected');
        appendFileSync(path, chunk);
        done(null);
      },
      write: (_fd, chunk, done) => {
        if (throwing) throw new TypeError('injected');
        appendFileSync(path, chunk);
        done(null);
      },
    };
    const writer = kind === 'path' ? pathLineWriter(path, 1024 * 1024, { fs }) : fdLineWriter(-1, 0, { fs });
    try {
      writer.write('lost\n');
      await turn();
      await writer.drained();
      assert.equal(writer.dropped(), 1);
      throwing = false;
      writer.write('kept\n');
      await turn();
      await writer.drained();
      assert.equal(text(path), 'kept\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the memory bound holds while a chunk is tried again: lines past the cap are dropped and counted, the rest written once, in order (${kind} writer)`, async () => {
    const dir = temp();
    const h = harness(kind, dir, { maxPendingBytes: 20 });
    try {
      const line = (n) => `${String(n).repeat(9)}\n`; // 10 bytes
      assert.equal(h.writer.write(line(1)), true);
      assert.equal(h.writer.write(line(2)), true);
      assert.equal(h.writer.write(line(3)), false, 'the queue is full');
      await until(() => h.calls.length === 1, 'the first write started');
      h.fail(h.calls[0], 'EBUSY'); // the chunk of 1 and 2 waits out its back-off; the queue is empty again
      assert.equal(h.writer.write(line(4)), true);
      assert.equal(h.writer.write(line(5)), true);
      assert.equal(h.writer.write(line(6)), false, 'the cap holds during the back-off');
      assert.equal(h.writer.dropped(), 2);
      await until(() => h.calls.length === 2, 'the chunk was tried again');
      h.ok(h.calls[1]);
      await until(() => h.calls.length === 3, 'the queued lines were written');
      h.ok(h.calls[2]);
      await h.writer.drained();
      assert.equal(h.text(), line(1) + line(2) + line(4) + line(5));
      assert.equal(h.writer.dropped(), 2, 'only the two lines past the cap');
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`drained waits for the write in flight and for its retries (${kind} writer)`, async () => {
    const dir = temp();
    const h = harness(kind, dir);
    try {
      h.writer.write('only\n');
      await until(() => h.calls.length === 1, 'the write started');
      let drained = false;
      const waiting = h.writer.drained().then(() => {
        drained = true;
      });
      h.fail(h.calls[0], 'EPERM');
      await until(() => h.calls.length === 2, 'the chunk was tried again');
      for (let i = 0; i < 5; i += 1) await turn();
      assert.equal(drained, false, 'a retry is still outstanding');
      h.ok(h.calls[1]);
      await waiting;
      assert.equal(h.text(), 'only\n');
      assert.equal(h.writer.dropped(), 0);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`flushSync while a chunk waits out a failed write writes that chunk first, then the queue, and cancels the retry (${kind} writer)`, async (t) => {
    const dir = temp();
    const h = harness(kind, dir);
    try {
      h.writer.write('a1\n');
      await until(() => h.calls.length === 1, 'the write started');
      let drained = false;
      const waiting = h.writer.drained().then(() => {
        drained = true;
      });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      h.fail(h.calls[0], 'EPERM'); // the back-off timer is now pending, under the mock clock
      h.writer.write('b1\n');
      h.writer.flushSync();
      assert.equal(h.text(), 'a1\nb1\n', 'the waiting chunk, then the queued line');
      await waiting;
      assert.equal(drained, true, 'a closer waiting on the chunk is released');
      t.mock.timers.tick(10_000);
      for (let i = 0; i < 5; i += 1) await turn();
      assert.equal(h.calls.length, 1, 'the cancelled retry never started');
      assert.equal(h.text(), 'a1\nb1\n', 'nothing written twice');
      assert.equal(h.writer.dropped(), 0);
    } finally {
      t.mock.timers.reset();
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the log\'s synchronous flush at shutdown waits out a transient append error too, and drops at once for another', () => {
  const dir = temp();
  try {
    const path = join(dir, 'sync.log');
    let failures = 2;
    const writer = pathLineWriter(path, 1024 * 1024, {
      fs: {
        appendFileSync: (target, chunk, options) => {
          if (failures > 0) {
            failures -= 1;
            throw fault('EBUSY');
          }
          appendFileSync(target, chunk, options);
        },
      },
    });
    writer.write('stopped\n');
    writer.flushSync();
    assert.equal(text(path), 'stopped\n');
    assert.equal(writer.dropped(), 0);

    let calls = 0;
    const refused = pathLineWriter(join(dir, 'refused.log'), 1024 * 1024, {
      fs: {
        appendFileSync: () => {
          calls += 1;
          throw fault('ENOSPC');
        },
      },
    });
    refused.write('lost\n');
    refused.flushSync();
    assert.equal(calls, 1, 'no second try for an error a retry cannot mend');
    assert.equal(refused.dropped(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waitAtMost returns when the work does, and gives up on work that never does', async (t) => {
  await waitAtMost(60_000, Promise.resolve());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let gaveUp = false;
    const waiting = waitAtMost(5000, new Promise(() => undefined)).then(() => {
      gaveUp = true;
    });
    for (let i = 0; i < 5; i += 1) await turn();
    assert.equal(gaveUp, false, 'it waits for the work until the bound');
    t.mock.timers.tick(5000);
    await waiting;
    assert.equal(gaveUp, true);
  } finally {
    t.mock.timers.reset();
  }
});
