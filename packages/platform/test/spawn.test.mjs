import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeCmdArgument, pathExtensions, planSpawn, resolveExecutable, runSync } from '../dist/index.js';

const WIN_ENV = {
  Path: 'C:\\Program Files\\nodejs;"C:\\Users\\Ada\\AppData\\Roaming\\npm";C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
};

function winFiles(...files) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return (path) => set.has(path.toLowerCase());
}

test('win32 resolution walks PATH (case-insensitive key, quoted entries) with PATHEXT (BLD-06)', () => {
  const isExecutableFile = winFiles(
    'C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude',
    'C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Windows\\System32\\git.exe',
  );
  const options = { platform: 'win32', env: WIN_ENV, isExecutableFile };
  assert.equal(resolveExecutable('claude', options), 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd', 'the extensionless POSIX shim is never picked');
  assert.equal(resolveExecutable('git', options), 'C:\\Windows\\System32\\git.exe');
  assert.equal(resolveExecutable('git.exe', options), 'C:\\Windows\\System32\\git.exe');
  assert.equal(resolveExecutable('missing', options), null);
  assert.deepEqual(pathExtensions({}, 'win32'), ['.com', '.exe', '.bat', '.cmd']);
});

test('a .exe runs directly with no shell (BLD-06)', () => {
  const plan = planSpawn('git', ['status', '--porcelain'], {
    platform: 'win32',
    env: WIN_ENV,
    isExecutableFile: winFiles('C:\\Windows\\System32\\git.exe'),
  });
  assert.deepEqual(plan, {
    ok: true,
    kind: 'direct',
    command: 'C:\\Windows\\System32\\git.exe',
    args: ['status', '--porcelain'],
    resolved: 'C:\\Windows\\System32\\git.exe',
    shell: false,
    windowsVerbatimArguments: false,
  });
});

test('a .cmd shim runs through cmd.exe /d /s /c with quoted, caret-escaped arguments (BLD-06)', () => {
  const plan = planSpawn('claude', ['--version', 'a b&c', 'C:\\dir\\'], {
    platform: 'win32',
    env: WIN_ENV,
    isExecutableFile: winFiles('C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd'),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'cmd-shim');
  assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(plan.shell, false);
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    plan.args[3],
    '"C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd ^"--version^" ^"a^ b^&c^" ^"C:\\dir\\\\^""',
  );
});

test('C:\\Program Files (x86) shims are escaped, not refused (BLD-06, BLD-07)', () => {
  const shim = 'C:\\Program Files (x86)\\Tool\\tool.bat';
  const plan = planSpawn(shim, ['--check'], { platform: 'win32', env: WIN_ENV, isExecutableFile: winFiles(shim) });
  assert.equal(plan.ok, true);
  assert.equal(plan.args[3], '"C:\\Program^ Files^ ^(x86^)\\Tool\\tool.bat ^"--check^""');
});

test('a shim argument cmd.exe cannot escape is refused (BLD-06)', () => {
  const options = { platform: 'win32', env: WIN_ENV, isExecutableFile: winFiles('C:\\Windows\\System32\\x.cmd') };
  for (const bad of ['%PATH%', 'say "hi"', 'bang!', 'line\nbreak', 'cr\rhere']) {
    assert.deepEqual(planSpawn('x.cmd', [bad], { ...options, env: { ...WIN_ENV, Path: 'C:\\Windows\\System32' } }), { ok: false, reason: 'unsafe-argument' }, bad);
  }
  assert.deepEqual(planSpawn('x', ['nul\0'], options), { ok: false, reason: 'invalid' });
});

test('escapeCmdArgument quotes and doubles trailing backslashes', () => {
  assert.equal(escapeCmdArgument('plain'), '^"plain^"');
  assert.equal(escapeCmdArgument('end\\'), '^"end\\\\^"');
});

test('POSIX resolution needs the executable bit and never uses a shell (BLD-06)', { skip: process.platform === 'win32' ? 'POSIX execute bits' : false }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jsp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = join(dir, 'tool');
  writeFileSync(tool, '#!/bin/sh\necho "$1"\n');
  const env = { PATH: dir };
  assert.equal(resolveExecutable('tool', { env }), null, 'not executable yet');
  chmodSync(tool, 0o755);
  assert.equal(resolveExecutable('tool', { env }), tool);
  const run = runSync('tool', ['$HOME;echo injected'], { env });
  assert.equal(run.ok, true);
  assert.equal(run.stdout, '$HOME;echo injected\n');
});

test('runSync reports a missing executable without spawning', () => {
  assert.deepEqual(runSync('definitely-not-a-jevris-binary', [], { env: { PATH: '' } }), {
    ok: false,
    status: null,
    stdout: '',
    stderr: '',
    reason: 'not-found',
  });
});

test('runSync runs node by absolute path on every OS (BLD-06)', () => {
  const run = runSync(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(run.ok, true);
  assert.equal(run.stdout, 'ok');
});
