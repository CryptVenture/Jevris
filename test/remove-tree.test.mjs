// scripts/remove-tree.mjs: the teardown removal tests and the pack smoke share. On Windows a
// failed removal names the processes that may hold the tree; elsewhere the error is rmSync's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
