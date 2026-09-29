import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLauncherPlan } from '../dist/launcher.js';
import { acceptAnalyzerManifest, triageUnknownStack } from '../dist/manifest.js';


const WINDOWS_PATH = 'C:\\Program Files\\work';
const SPACED_PATH = '/tmp/with spaces/proj';
const DOCTOR_SENTENCE = 'verification remains unsupported until an approved runner manifest exists.';

function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jevris-languages-'));
}

/**
 * Opens a test store in a fresh folder, runs `fn`, and always closes the store before the folder
 * goes: Windows refuses to remove an open database, and a removal error must never hide the
 * assertion that failed first.
 */
function withTestStore(name, fn) {
  const dir = tempDir();
  let opened;
  try {
    opened = openTest(join(dir, name), openStore);
    assert.equal(opened.ok, true);
    if (opened.ok) fn(dir, opened);
  } finally {
    if (opened?.ok) closeStore(opened);
    rmSync(dir, { recursive: true, force: true });
  }
}

function openTest(path, openStore) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
  });
}

function manifest(dir, name, overrides = {}) {
  const marker = join(dir, name);
  const command = process.execPath;
  return {
    marker,
    value: {
      runnerId: 'runnerA',
      command,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      commandHash: sha256(command),
      workspaceId: 'wsA',
      receiptId: 'rcptBound',
      sourceRevision: 'rev-a',
      evidenceId: 'evBound',
      currentRevision: 'rev-a',
      ...overrides,
    },
  };
}

const root = repoRoot();
const storeUrl = pathToFileURL(join(root, 'packages/store/dist/index.js')).href;
const platformUrl = pathToFileURL(join(root, 'apps/cli/dist/platform.js')).href;
const { openStore, closeStore, runDeclaredCheck, listCurrent } = await import(storeUrl);
const { classifyEnvironment } = await import(platformUrl);

test('a spaced path stays one argv element and shell stays false', () => {
  const windows = buildLauncherPlan(process.execPath, WINDOWS_PATH);
  const spaced = buildLauncherPlan(process.execPath, SPACED_PATH);
  assert.equal(Array.isArray(windows.argv), true);
  assert.equal(windows.argv.length, 2);
  assert.equal(windows.argv[0], process.execPath);
  assert.equal(windows.argv[1], WINDOWS_PATH);
  assert.equal(windows.shell, false);
  assert.equal(Object.hasOwn(windows, 'platform'), false);
  assert.equal(spaced.argv.length, 2);
  assert.equal(spaced.argv[1], SPACED_PATH);
  assert.equal(spaced.shell, false);
  assert.equal(spaced.argv[1].includes('"'), false);
});

test('win32 is a supported local environment (VER-08)', () => {
  assert.equal(classifyEnvironment({ platform: 'win32', nodeVersion: 'v24.18.1', env: {} }), 'local');
  assert.equal(
    classifyEnvironment({ platform: 'win32', nodeVersion: 'v24.18.1', env: { SSH_CONNECTION: '1 2 3 4' }, inContainer: true }),
    'reduced',
  );
});

test('the launcher plans a runnable spawn on linux, macOS and Windows (VER-08)', () => {
  const posixTool = '/opt/tools with space/analyze';
  for (const platform of ['linux', 'darwin']) {
    const plan = buildLauncherPlan(posixTool, '/work dir/src', { platform, env: { PATH: '/usr/bin' }, isExecutableFile: (p) => p === posixTool });
    assert.equal(plan.spawn.ok, true, platform);
    assert.equal(plan.spawn.kind, 'direct');
    assert.equal(plan.spawn.command, posixTool);
    assert.deepEqual(plan.spawn.args, ['/work dir/src']);
  }
  const exe = 'C:\\Program Files (x86)\\Tool\\analyze.exe';
  const direct = buildLauncherPlan(exe, 'C:\\work dir\\src', { platform: 'win32', env: { PATHEXT: '.EXE;.CMD' }, isExecutableFile: (p) => p === exe });
  assert.equal(direct.spawn.ok, true);
  assert.equal(direct.spawn.kind, 'direct');
  assert.equal(direct.spawn.windowsVerbatimArguments, false);
  // A bare name resolves through PATH and PATHEXT to a .cmd shim, which runs through cmd.exe.
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\eslint.cmd';
  const viaPath = buildLauncherPlan('eslint', 'C:\\work dir\\src', {
    platform: 'win32',
    env: { PATH: 'C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    isExecutableFile: (p) => p === shim,
  });
  assert.equal(viaPath.spawn.ok, true);
  assert.equal(viaPath.spawn.kind, 'cmd-shim');
  assert.equal(viaPath.spawn.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(viaPath.spawn.resolved, shim);
});

test('argument injection through a Windows shim is escaped or refused (VER-08)', () => {
  const shim = 'C:\\t\\lint.cmd';
  const opts = { platform: 'win32', env: { PATHEXT: '.CMD' }, isExecutableFile: (p) => p === shim };
  const escaped = buildLauncherPlan(shim, 'x & calc', opts);
  assert.equal(escaped.spawn.ok, true);
  assert.equal(escaped.spawn.args[3].includes('^&'), true);
  assert.equal(escaped.spawn.args[3].includes(' & '), false);
  for (const bad of ['a"b', '%PATH%', '!x!', 'a\nb']) {
    const plan = buildLauncherPlan(shim, bad.replace('\\n', '\n'), opts);
    assert.equal(plan.spawn.ok, false, bad);
    assert.equal(plan.spawn.reason, 'unsafe-argument');
  }
});

test('a launcher in a path with spaces runs on this OS and receives its argument verbatim (VER-08)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-launch-'));
  try {
    const toolDir = join(dir, 'tools with space (x86)');
    mkdirSync(toolDir);
    const out = join(dir, 'arg.txt');
    const arg = 'src dir; touch pwned';
    let tool;
    if (process.platform === 'win32') {
      tool = join(toolDir, 'record.cmd');
      writeFileSync(tool, `@"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], process.argv[2])" "${out}" %1\r\n`);
    } else {
      tool = join(toolDir, 'record');
      writeFileSync(tool, `#!/bin/sh\nexec "${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], process.argv[2])" "${out}" "$1"\n`);
      chmodSync(tool, 0o755);
    }
    const plan = buildLauncherPlan(tool, arg);
    assert.equal(plan.spawn.ok, true);
    const r = spawnSync(plan.spawn.command, plan.spawn.args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.spawn.windowsVerbatimArguments,
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const got = readFileSync(out, 'utf8');
    assert.equal(got.replace(/^"|"$/g, ''), arg);
    assert.equal(existsSync(join(dir, 'pwned')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown stack gets triage and checkpoints without a receipt', () => {
  withTestStore('unknown.sqlite', (dir, opened) => {
    const result = triageUnknownStack();
    assert.equal(result.triage, 'allowed');
    assert.equal(result.checkpoint.applied, false);
    assert.equal(result.checkpoint.providerCalls, 0);
    assert.equal(result.checkpoint.toolPermission, false);
    assert.equal(result.verification, 'unsupported');
    assert.equal(result.verificationReason, DOCTOR_SENTENCE);
    assert.equal(result.receipt, null);
    assert.equal(result.binaryCorrectness, 'unverified');
    const current = listCurrent(opened, { workspaceId: 'wsA' });
    assert.equal(current.ok, true);
    if (!current.ok) return;
    assert.equal(current.rows.length, 0);
  });
});

test('Windows absolute commands, including C:\\Program Files (x86), are accepted on win32 (BLD-07)', () => {
  for (const command of [
    'C:\\Program Files (x86)\\Tool\\analyzer.exe',
    '\\\\server\\share\\tools\\analyzer.exe',
    '\\\\?\\C:\\tools\\analyzer.exe',
  ]) {
    assert.equal(acceptAnalyzerManifest({ command, args: [] }, { platform: 'win32' }).ok, true, command);
  }
  assert.equal(acceptAnalyzerManifest({ command: 'tools\\analyzer.exe', args: [] }, { platform: 'win32' }).ok, false);
  assert.equal(acceptAnalyzerManifest({ command: 'C:\\x.exe', args: [] }, { platform: 'linux' }).ok, false);
  assert.equal(acceptAnalyzerManifest({ command: 'C:\\x.exe & calc', args: [] }, { platform: 'win32' }).ok, false);
});

test('the launcher plan carries the platform spawn plan: a .cmd analyzer runs through cmd.exe (BLD-06)', () => {
  const plan = buildLauncherPlan('C:\\Tools (x86)\\lint.cmd', 'C:\\work dir\\src', {
    platform: 'win32',
    env: { PATHEXT: '.EXE;.CMD' },
    isExecutableFile: (path) => path === 'C:\\Tools (x86)\\lint.cmd',
  });
  assert.equal(plan.spawn.ok, true);
  assert.equal(plan.spawn.kind, 'cmd-shim');
  assert.equal(plan.spawn.windowsVerbatimArguments, true);
  assert.equal(plan.spawn.args[3], '"C:\\Tools^ ^(x86^)\\lint.cmd ^"C:\\work^ dir\\src^""');
  const direct = buildLauncherPlan(process.execPath, SPACED_PATH);
  assert.equal(direct.spawn.ok, true);
  assert.equal(direct.spawn.kind, 'direct');
  assert.deepEqual(direct.spawn.args, [SPACED_PATH]);
});

test('a relative command, a shell metacharacter, and a Jev command field are refused', () => {
  assert.equal(acceptAnalyzerManifest({ command: 'tsc', args: [] }).ok, false);
  assert.equal(acceptAnalyzerManifest({ command: './node', args: [] }).ok, false);
  assert.equal(acceptAnalyzerManifest({ command: '/usr/bin/tsc;id', args: [] }).ok, false);
  assert.equal(acceptAnalyzerManifest({ command: '/usr/bin/tsc|id', args: [] }).ok, false);
  assert.equal(
    acceptAnalyzerManifest({
      command: process.execPath,
      args: [],
      jevCommand: 'echo unsafe',
    }).ok,
    false,
  );
  assert.equal(
    acceptAnalyzerManifest({
      command: process.execPath,
      args: [],
      passed: true,
    }).ok,
    false,
  );
  assert.equal(
    acceptAnalyzerManifest({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }).ok,
    true,
  );
});

test('a passed frame is refused before spawn and a model sentence is not a passed claim', () => {
  withTestStore('frame.sqlite', (dir, opened) => {
    const passed = manifest(dir, 'passed-frame');
    const refused = runDeclaredCheck(opened, passed.value, { passed: true });
    assert.equal(refused.ok, false);
    assert.equal(existsSync(passed.marker), false);

    const sentence = manifest(dir, 'sentence-frame', {
      receiptId: 'rcptSentence',
      evidenceId: 'evSentence',
    });
    const allowed = runDeclaredCheck(opened, sentence.value, {
      modelSentence: 'all checks passed',
    });
    assert.equal(allowed.ok, true);
    assert.equal(existsSync(sentence.marker), true);

    const marker = join(dir, 'shell-ran');
    const write = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const command = `${process.execPath} -e ${JSON.stringify(write)};true`;
    assert.equal(isAbsolute(process.execPath), true);
    assert.equal(command.includes(';'), true);
    const shell = manifest(dir, 'unused-shell', {
      receiptId: 'rcptShell',
      evidenceId: 'evShell',
      command,
      commandHash: sha256(command),
      args: [],
    });
    const shellRefused = runDeclaredCheck(opened, shell.value);
    assert.equal(shellRefused.ok, false);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(shell.marker), false);

    const relative = manifest(dir, 'relative-ran', {
      receiptId: 'rcptRel',
      evidenceId: 'evRel',
      command: 'tsc',
      commandHash: sha256('tsc'),
    });
    assert.equal(runDeclaredCheck(opened, relative.value).ok, false);
    assert.equal(existsSync(relative.marker), false);

    const jev = manifest(dir, 'jev-ran', {
      receiptId: 'rcptJev',
      evidenceId: 'evJev',
      jevCommand: process.execPath,
    });
    assert.equal(runDeclaredCheck(opened, jev.value).ok, false);
    assert.equal(existsSync(jev.marker), false);
  });
});
