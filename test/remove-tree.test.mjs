// scripts/remove-tree.mjs: the teardown removal tests and the pack smoke share. On Windows a
// failed removal names the processes that may hold the tree; elsewhere the error is rmSync's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { removeTree, windowsHolders } from '../scripts/remove-tree.mjs';

test('removeTree removes a nested tree, and a missing one is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remove-tree-'));
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x');
  removeTree(dir);
  assert.equal(existsSync(dir), false);
  removeTree(dir);
});

test('windowsHolders lists nothing off Windows, and on Windows names this process', () => {
  const lines = windowsHolders(tmpdir());
  if (process.platform !== 'win32') assert.deepEqual(lines, []);
  else assert.ok(lines.some((line) => line.startsWith(`pid ${process.pid} `)), lines.join('\n'));
});

// Windows only: a folder that is a live process's working folder cannot be removed there, and on
// POSIX it can, so the waiting has nothing to wait for elsewhere.
test('on Windows removeTree waits for a holder that lets go inside its window, and names one that does not', { skip: process.platform !== 'win32' ? 'a working folder blocks removal only on Windows' : false }, async () => {
  const hold = (dir, ms) => {
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return new Promise((resolve) => child.once('spawn', () => resolve(child)));
  };
  const brief = mkdtempSync(join(tmpdir(), 'remove-tree-brief-'));
  await hold(brief, 1500);
  removeTree(brief);
  assert.equal(existsSync(brief), false, 'removed once the holder exited');

  const stubborn = mkdtempSync(join(tmpdir(), 'remove-tree-held-'));
  const child = await hold(stubborn, 60_000);
  try {
    assert.throws(() => removeTree(stubborn, 1000), /removing .*processes now:/s);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    removeTree(stubborn);
  }
});
