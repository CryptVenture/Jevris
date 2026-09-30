// The live-file readers retry what a Windows writer, scanner or indexer makes a read fail with,
// and say why when the bound is reached (windows-latest, 84ccf26: EBUSY in security-hook-e2e).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLive, scanRead, waitForText } from './live-files.mjs';

const failing = (code, times, value) => {
  let left = times;
  return {
    read: () => {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error(`${code}: busy`), { code });
      }
      return value;
    },
    calls: () => times - left,
  };
};

test('readLive retries EBUSY, EPERM and EACCES and then returns the file', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const fake = failing(code, 4, 'text');
    assert.equal(readLive('x', 'utf8', { read: fake.read, pause: () => {} }), 'text', code);
    assert.equal(fake.calls(), 4);
  }
});

test('readLive says which error held the file when its bound is reached, and does not retry other errors', () => {
  const fake = failing('EBUSY', 1_000_000, '');
  assert.throws(() => readLive('x', 'utf8', { read: fake.read, pause: () => {}, boundMs: 20 }), /stayed unreadable for 20 ms \(EBUSY\)/);
  const enoent = failing('ENOENT', 1, 'never');
  assert.throws(() => readLive('x', 'utf8', { read: enoent.read, pause: () => {} }), /ENOENT/);
  assert.equal(readLive('x', 'utf8', { read: failing('ENOENT', 1, 'never').read, pause: () => {}, vanished: 'empty' }), '');
  assert.equal(readLive('x', undefined, { read: failing('ENOENT', 1, 'never').read, pause: () => {}, vanished: 'empty' }).length, 0);
});

test('scanRead and waitForText read real files, and waitForText waits for the text and reports what it saw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-files-'));
  try {
    const file = join(dir, 'a.log');
    assert.equal(scanRead(join(dir, 'gone')).length, 0);
    setTimeout(() => writeFileSync(file, 'hello\n'), 30);
    assert.equal(await waitForText(file, (text) => text.includes('hello')), 'hello\n');
    await assert.rejects(waitForText(file, (text) => text.includes('never'), { boundMs: 50 }), /did not reach the expected text within 50 ms.*"hello/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
