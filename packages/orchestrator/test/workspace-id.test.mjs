// Workspace identity (IPC-09): device, inode and birth time of the root, shared with the sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootIdentityId, workspaceIdFor } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

test('a root keeps its id when moved or reached through a link, and a removed-and-recreated root gets a new one where the filesystem records birth time', () => {
  const dir = tempDir('jv-wsid-');
  try {
    const a = join(dir, 'a');
    mkdirSync(a);
    const id = rootIdentityId(a);
    assert.match(id, /^w[a-f0-9]{24}$/);
    assert.equal(workspaceIdFor(a), id);
    const moved = join(dir, 'moved');
    renameSync(a, moved);
    assert.equal(rootIdentityId(moved), id, 'a moved root keeps its id');
    if (process.platform !== 'win32') {
      symlinkSync(moved, join(dir, 'link'));
      assert.equal(rootIdentityId(join(dir, 'link')), id, 'two spellings share one id');
    }
    rmSync(moved, { recursive: true });
    mkdirSync(moved);
    const birth = statSync(moved, { bigint: true }).birthtimeNs;
    if (birth !== 0n) assert.notEqual(rootIdentityId(moved), id, 'a recreated root (even on a reused inode) is a new workspace');
    assert.equal(rootIdentityId(join(dir, 'missing')), undefined);
    assert.match(workspaceIdFor(join(dir, 'missing')), /^ws-[a-f0-9]{20}$/, 'an unreadable root falls back to a path id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
