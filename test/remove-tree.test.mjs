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

// Windows only: a file another process holds open without delete sharing cannot be removed there
// (POSIX unlinks it anyway), so the waiting has nothing to wait for elsewhere. The holder is
// PowerShell opening the file with FileShare None; it prints once the file is open.
test('on Windows removeTree waits for a holder that lets go inside its window, and names one that does not', { skip: process.platform !== 'win32' ? 'an open file blocks removal only on Windows' : false }, async () => {
  const hold = (dir, ms) => {
    const file = join(dir, 'held.txt');
    writeFileSync(file, 'x');
    const script = `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); Write-Output held; Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('held')) resolve(child);
      });
      child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it held the file`)));
    });
  };
  const brief = mkdtempSync(join(tmpdir(), 'remove-tree-brief-'));
  await hold(brief, 1500);
  removeTree(brief);
  assert.equal(existsSync(brief), false, 'removed once the holder let go');

  const stubborn = mkdtempSync(join(tmpdir(), 'remove-tree-held-'));
  const child = await hold(stubborn, 60_000);
  try {
    assert.throws(() => removeTree(stubborn, 1000), /removing .*processes now:/s);
  } finally {
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    removeTree(stubborn);
  }
});
