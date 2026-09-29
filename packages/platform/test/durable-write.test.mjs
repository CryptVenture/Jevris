import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableWrite, isTempFor, removeStaleTemps, renameWithRetry, tempNameFor } from '../dist/index.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jdw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeOld(path) {
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
}

test('durableWrite replaces the destination and leaves no temp (BLD-01)', async (t) => {
  const dir = tempDir(t);
  const destination = join(dir, 'ledger.json');
  writeFileSync(destination, 'old');
  assert.deepEqual(await durableWrite(destination, '{"v":2}'), { ok: true });
  assert.equal(readFileSync(destination, 'utf8'), '{"v":2}');
  assert.deepEqual(readdirSync(dir), ['ledger.json']);
});

test('a leftover temp from a killed write never blocks the next write (BLD-01)', async (t) => {
  const dir = tempDir(t);
  const destination = join(dir, 'decisions.json');
  // The pre-v1.2 writers used fixed names with O_EXCL: a leftover blocked every later write.
  const legacy = `${destination}.tmp`;
  const legacyLabelled = `${destination}.decision-1.tmp`;
  const unique = join(dir, tempNameFor('decisions.json', 4242, 'abcdef'));
  for (const path of [legacy, legacyLabelled, unique]) writeFileSync(path, 'partial');
  assert.deepEqual(await durableWrite(destination, 'fresh'), { ok: true });
  assert.equal(readFileSync(destination, 'utf8'), 'fresh');
  // Fresh leftovers are kept (a concurrent writer may own them); stale ones are removed.
  for (const path of [legacy, legacyLabelled, unique]) makeOld(path);
  assert.deepEqual(await durableWrite(destination, 'again'), { ok: true });
  assert.deepEqual(readdirSync(dir).sort(), ['decisions.json']);
});

test('the temp name is unique per call and recognised as stale-able', () => {
  assert.equal(isTempFor('a.json', tempNameFor('a.json', 1, 'ff00')), true);
  assert.equal(isTempFor('a.json', 'a.json.tmp'), true);
  assert.equal(isTempFor('a.json', 'a.json.observe.tmp'), true);
  assert.equal(isTempFor('a.json', 'b.json.tmp'), false);
  assert.equal(isTempFor('a.json', 'a.json'), false);
  assert.equal(isTempFor('a.json', '.a.json.1.zz.jtmp'), false);
});

test('an EPERM or EBUSY rename is retried and then succeeds (Windows open-file case) (BLD-01)', async () => {
  const codes = ['EPERM', 'EBUSY', 'EACCES'];
  const sleeps = [];
  let calls = 0;
  const result = await renameWithRetry('a', 'b', {
    fs: {
      rename: async () => {
        calls += 1;
        const code = codes.shift();
        if (code !== undefined) throw Object.assign(new Error(code), { code });
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [10, 20, 40]);
});

test('the retry is bounded and a non-retryable code fails at once (BLD-01)', async () => {
  let calls = 0;
  const busy = await renameWithRetry('a', 'b', {
    retries: 2,
    sleep: async () => undefined,
    fs: {
      rename: async () => {
        calls += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    },
  });
  assert.deepEqual(busy, { ok: false, code: 'EBUSY' });
  assert.equal(calls, 3);
  calls = 0;
  const gone = await renameWithRetry('a', 'b', {
    sleep: async () => undefined,
    fs: {
      rename: async () => {
        calls += 1;
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    },
  });
  assert.deepEqual(gone, { ok: false, code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('a failed rename removes only this call\'s temp and reports the code', async (t) => {
  const dir = tempDir(t);
  const destination = join(dir, 'x.json');
  const result = await durableWrite(destination, 'data', {
    retries: 0,
    fs: {
      rename: async () => {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      },
    },
  });
  assert.deepEqual(result, { ok: false, code: 'EBUSY' });
  assert.deepEqual(readdirSync(dir), []);
});

test('the new file is created 0600 on POSIX (BLD-01, BLD-08)', { skip: process.platform === 'win32' ? 'POSIX mode bits; the Windows ACL is covered in owner-only.test' : false }, async (t) => {
  const dir = tempDir(t);
  const destination = join(dir, 'p.json');
  writeFileSync(destination, 'wide', { mode: 0o644 });
  assert.deepEqual(await durableWrite(destination, 'narrow'), { ok: true });
  assert.equal(statSync(destination).mode & 0o777, 0o600);
});

test('a symlinked destination or parent directory is refused (BLD-08)', { skip: process.platform === 'win32' ? 'symlink creation needs privileges on Windows' : false }, async (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'target.json');
  writeFileSync(target, 'keep');
  symlinkSync(target, join(dir, 'link.json'));
  assert.deepEqual(await durableWrite(join(dir, 'link.json'), 'x'), { ok: false, code: 'ESYMLINK' });
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'linked-dir'));
  assert.deepEqual(await durableWrite(join(dir, 'linked-dir', 'f.json'), 'x'), { ok: false, code: 'ESYMLINK' });
  assert.equal(existsSync(join(dir, 'real', 'f.json')), false);
});

test('beforeRename can veto the write, and the temp is removed', async (t) => {
  const dir = tempDir(t);
  const destination = join(dir, 'acl.json');
  const seen = [];
  const result = await durableWrite(destination, 'x', {
    beforeRename: (temp) => {
      seen.push(temp);
      return false;
    },
  });
  assert.deepEqual(result, { ok: false, code: 'EACL' });
  assert.equal(seen.length, 1);
  assert.deepEqual(readdirSync(dir), []);
});

test('removeStaleTemps honours the age and ignores other files', async (t) => {
  const dir = tempDir(t);
  const destination = join(dir, 'd.json');
  const stale = join(dir, 'd.json.tmp');
  const other = join(dir, 'e.json.tmp');
  writeFileSync(stale, '');
  writeFileSync(other, '');
  makeOld(stale);
  makeOld(other);
  assert.deepEqual(await removeStaleTemps(destination), [stale]);
  assert.equal(existsSync(other), true);
});
