// The sidecar client reads the endpoint, key and locality files through readPrivateSmall. A
// transient EBUSY, EPERM or EACCES (Windows: the daemon or a scanner holds the file) made it return
// undefined, which reads as "no sidecar running"; it now retries a few times first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsModule from 'node:fs';

const { readPrivateSmall } = await import('../dist/protocol.js');

test('readPrivateSmall retries a transient open failure and returns the file; other failures stay undefined', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-private-')));
  try {
    const file = join(dir, 'endpoint.json');
    writeFileSync(file, '{"a":1}', { mode: 0o600 });
    chmodSync(file, 0o600);
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      let left = 2;
      const pauses = [];
      const fs = { openSync: (...args) => { if (left > 0) { left -= 1; throw Object.assign(new Error(code), { code }); } return fsModule.openSync(...args); } };
      const got = readPrivateSmall(file, process.platform, { fs, pause: (ms) => pauses.push(ms) });
      assert.equal(got?.toString('utf8'), '{"a":1}', code);
      assert.deepEqual(pauses, [5, 10]);
    }
    const never = { openSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
    assert.equal(readPrivateSmall(file, process.platform, { fs: never, pause: () => {} }), undefined, 'a file that stays busy is still undefined');
    const enoent = { openSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
    let pauses = 0;
    assert.equal(readPrivateSmall(file, process.platform, { fs: enoent, pause: () => { pauses += 1; } }), undefined);
    assert.equal(pauses, 0, 'a missing file is not retried');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
