// P7 (sidecar concurrency audit; owner ededdba): the sidecar log and trace are written
// asynchronously in batches, bounded in memory, rotated from a byte counter, and flushed at close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pathLineWriter, fdLineWriter } = await import('../dist/line-writer.js');
const { createFileLog } = await import('../dist/daemon.js');

function tempDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'b-lines-')));
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
/** The file's text, or '' while it does not exist (between a rotation's rename and the append). */
function text(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
async function settle(check) {
  for (let i = 0; i < 6_000 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('lines are queued, not written in the caller\'s turn, then written together in order', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'a.log');
    const writer = pathLineWriter(path, 1024 * 1024);
    for (let i = 0; i < 50; i += 1) assert.equal(writer.write(`line ${i}\n`), true);
    assert.equal(existsSync(path), false, 'nothing touched the disk in the caller\'s turn');
    await turn();
    await settle(() => text(path).split('\n').length > 50);
    assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n'), Array.from({ length: 50 }, (_, i) => `line ${i}`));
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a full queue drops and counts lines; flushSync writes the rest at once', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'b.log');
    const writer = pathLineWriter(path, 1024 * 1024, { maxPendingBytes: 20 });
    assert.equal(writer.write('0123456789\n'), true);
    assert.equal(writer.write('0123456789\n'), false);
    assert.equal(writer.dropped(), 1);
    writer.flushSync();
    assert.equal(readFileSync(path, 'utf8'), '0123456789\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the log rotates by its byte counter, not a stat per line', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'c.log');
    const writer = pathLineWriter(path, 30);
    writer.write('a'.repeat(19) + '\n');
    writer.flushSync();
    writer.write('b'.repeat(19) + '\n');
    writer.flushSync();
    assert.equal(readFileSync(`${path}.1`, 'utf8'), 'a'.repeat(19) + '\n');
    assert.equal(readFileSync(path, 'utf8'), 'b'.repeat(19) + '\n');
    writer.write('c'.repeat(19) + '\n');
    await turn();
    await settle(() => text(`${path}.1`).startsWith('b'));
    assert.equal(readFileSync(`${path}.1`, 'utf8'), 'b'.repeat(19) + '\n');
    await settle(() => text(path).startsWith('c'));
    assert.equal(readFileSync(path, 'utf8'), 'c'.repeat(19) + '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainThen closes a descriptor only after the write in flight lands', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'd.jsonl');
    const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
    const writer = fdLineWriter(fd, 0);
    writer.write('first\n');
    await turn(); // the first write is now in flight
    writer.write('second\n');
    let closed = false;
    writer.drainThen(() => {
      closeSync(fd);
      closed = true;
    });
    await settle(() => closed);
    assert.equal(closed, true);
    assert.equal(readFileSync(path, 'utf8'), 'first\nsecond\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createFileLog writes JSON lines asynchronously and flushSync writes them at shutdown', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'sidecar.log');
    const log = createFileLog(path);
    log({ level: 'info', event: 'stopped', reason: 'test' });
    assert.equal(existsSync(path), false);
    log.flushSync();
    const line = JSON.parse(readFileSync(path, 'utf8').trim());
    assert.equal(line.event, 'stopped');
    assert.equal(line.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
