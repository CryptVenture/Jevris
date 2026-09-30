// A read of a file another Jevris process writes retries the errors Windows gives while a writer
// or scanner holds it (windows-latest, 84ccf26), and lets any other error through at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHARED_READ_TRIES, readSharedFileSync, retryTransientSync } from '../dist/index.js';

const busy = (code) => Object.assign(new Error(`${code}: busy`), { code });

test('a transient EPERM, EBUSY or EACCES is retried with a growing pause, then the file is read', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let left = 3;
    const pauses = [];
    const read = () => {
      if (left > 0) {
        left -= 1;
        throw busy(code);
      }
      return 'text';
    };
    assert.equal(readSharedFileSync('p', 'utf8', read, (ms) => pauses.push(ms)), 'text', code);
    assert.deepEqual(pauses, [5, 10, 20]);
  }
});

test('the last transient error is thrown after the bound, and ENOENT or another error at once', () => {
  let calls = 0;
  assert.throws(() => readSharedFileSync('p', 'utf8', () => { calls += 1; throw busy('EBUSY'); }, () => {}), /EBUSY/);
  assert.equal(calls, SHARED_READ_TRIES);
  calls = 0;
  assert.throws(() => retryTransientSync(() => { calls += 1; throw busy('ENOENT'); }, () => {}), /ENOENT/);
  assert.equal(calls, 1);
});
