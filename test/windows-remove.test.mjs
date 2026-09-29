// scripts/test-windows-remove.mjs: on Windows, a teardown's recursive, forced removal inside the
// run's temp folder waits out a handle that closes late; nothing else is retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retriedRemoval, transient } from '../scripts/test-windows-remove.mjs';

test('only a recursive, forced removal inside the run temp folder is retried, and only on a transient code', () => {
  const run = join(tmpdir(), 'jt-run');
  const inside = join(run, 'jvc-1');
  assert.equal(retriedRemoval(inside, { recursive: true, force: true }, run), true);
  assert.equal(retriedRemoval(inside.toUpperCase(), { recursive: true, force: true }, run.toLowerCase(), 'win32'), true, 'Windows paths compare without case');
  assert.equal(retriedRemoval(inside.toUpperCase(), { recursive: true, force: true }, run.toLowerCase(), 'linux'), false);
  assert.equal(retriedRemoval(inside, { recursive: true }, run), false, 'not forced');
  assert.equal(retriedRemoval(inside, { force: true }, run), false, 'not recursive');
  assert.equal(retriedRemoval(inside, undefined, run), false);
  assert.equal(retriedRemoval(run, { recursive: true, force: true }, run), false, 'the run folder itself is the runner\'s');
  assert.equal(retriedRemoval(join(tmpdir(), 'jt-other', 'x'), { recursive: true, force: true }, run), false);
  assert.equal(retriedRemoval(inside, { recursive: true, force: true }, undefined), false);
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']) assert.equal(transient(Object.assign(new Error(code), { code })), true, code);
  for (const code of ['ENOENT', 'EINVAL', undefined]) assert.equal(transient(Object.assign(new Error('x'), { code })), false, String(code));
});

// Windows only: a file another process holds open without delete sharing blocks its removal
// there, and on POSIX it does not, so there is nothing to wait for elsewhere.
test('on Windows a plain rmSync of a folder whose file is let go a moment later succeeds', { skip: process.platform !== 'win32' ? 'an open file blocks removal only on Windows' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'win-remove-'));
  const file = join(dir, 'held.txt');
  writeFileSync(file, 'x');
  const script = `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); Write-Output held; Start-Sleep -Milliseconds 1500; $f.Close()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('held')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it held the file`)));
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});
