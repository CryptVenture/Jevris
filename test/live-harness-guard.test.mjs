import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const HARNESSES = ['claude', 'kilo', 'opencode', 'codex', 'agy'];
const liveHarness = await import('../apps/cli/dist/live-harness.js');
const { readInstalledHarnessVersion } = await import('../apps/cli/dist/harness-version.js');
const { probeInstalledHarness } = await import('../apps/cli/dist/harness-probe.js');
const { probeHookProcess } = await import('../apps/cli/dist/hook-certify.js');

function firstOnPath(name) {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function stubCalls() {
  const log = process.env.JEVRIS_STUB_LOG;
  if (typeof log !== 'string' || !existsSync(log)) return 0;
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * A process that still runs. A zombie (killed, not yet reaped) is dead: in a container whose
 * PID 1 is this test's Node process (docker run without --init), an orphaned grandchild that was
 * killed is reparented to PID 1, which never reaps it, so `kill(pid, 0)` keeps succeeding on it.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function waitFor(check, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('under npm test every harness name on PATH resolves to the runner stub', () => {
  assert.equal(process.env.JEVRIS_NO_LIVE_HARNESS, '1');
  const stubDir = process.env.JEVRIS_HARNESS_STUB_DIR;
  assert.equal(typeof stubDir, 'string');
  for (const name of HARNESSES) {
    const found = firstOnPath(name);
    assert.notEqual(found, null, name);
    assert.equal(found.startsWith(stubDir), true, `${name} resolved to ${found}`);
  }
});

test('a PATH lookup of claude runs the stub: exit 1, no stdout, call logged', { skip: process.platform === 'win32' && 'POSIX stub executables; the Windows .cmd stubs are covered by the runner stub test above' }, () => {
  const before = stubCalls();
  const ran = spawnSync('claude', ['--version'], { shell: false, encoding: 'utf8' });
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.equal(ran.stderr.includes('jevris test stub'), true);
  assert.equal(stubCalls(), before + 1);
});

test('the probes refuse a PATH lookup under tests and never start even the stub', async () => {
  assert.equal(liveHarness.liveHarnessBlocked(), true);
  assert.equal(liveHarness.liveHarnessBlocked({}), false);
  assert.equal(liveHarness.liveHarnessBlocked({ JEVRIS_NO_LIVE_HARNESS: '1' }), true);
  assert.equal(liveHarness.spawnRefused('claude'), true);
  assert.equal(liveHarness.spawnRefused('/opt/bin/claude'), false);
  const before = stubCalls();
  assert.equal(await readInstalledHarnessVersion(), null);
  const probe = await probeInstalledHarness();
  assert.equal(probe.binaryPresent, false);
  const hook = await probeHookProcess();
  assert.equal(hook.spawned, false);
  assert.equal(hook.eventProbe, 'did-not-pass');
  const launched = liveHarness.launchTree('claude', ['--version']);
  assert.deepEqual(await launched.done, { spawned: false, code: null });
  assert.equal(stubCalls(), before);
});

test('launchTree kills the whole tree on timeout and reaps what an exited child left behind', { skip: process.platform === 'win32' && 'POSIX process groups; Windows uses taskkill /T, which cannot reach an orphan whose parent exited' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-tree-'));
  try {
    const script = (pidFile, exitAfterSpawn) =>
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        exitAfterSpawn ? 'process.exit(0);' : 'setInterval(() => {}, 1000);',
      ].join('\n');

    // The pid file may be seen before its content is written: read until it holds a pid (a 0
    // would probe this test's own process group and look alive forever).
    const pidIn = (file) => {
      try {
        const pid = Number(readFileSync(file, 'utf8'));
        return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
      } catch {
        return null;
      }
    };
    const hungPid = join(dir, 'hung.pid');
    const hung = liveHarness.launchTree(process.execPath, ['-e', script(hungPid, false)]);
    assert.equal(await waitFor(() => pidIn(hungPid) !== null), true);
    const grandchild = pidIn(hungPid);
    assert.equal(alive(grandchild), true);
    hung.kill();
    await hung.done;
    assert.equal(await waitFor(() => !alive(grandchild)), true, 'grandchild of a killed child survived');

    const orphanPid = join(dir, 'orphan.pid');
    const exited = liveHarness.launchTree(process.execPath, ['-e', script(orphanPid, true)]);
    const exit = await exited.done;
    assert.equal(exit.spawned, true);
    assert.equal(await waitFor(() => pidIn(orphanPid) !== null), true);
    const orphan = pidIn(orphanPid);
    assert.equal(await waitFor(() => !alive(orphan)), true, 'a grandchild outlived its exited parent');

    const bounded = await liveHarness.runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200);
    assert.equal(bounded.timedOut, true);
    assert.equal(bounded.code, 124);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// "Only live-harness.ts starts processes in the CLI" reads src text and runs in
// lint/cli-spawn.lint.mjs (QA-07).

test('real-harness smoke runs only on explicit opt-in and never inside the test suite', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['smoke:harness'], 'node scripts/smoke-harness.mjs');
  assert.equal(pkg.scripts.test.includes('smoke'), false);
  const script = join(root, 'scripts', 'smoke-harness.mjs');
  const { JEVRIS_LIVE_HARNESS: _unused, ...env } = process.env;
  const noOptIn = spawnSync(process.execPath, [script], { env, encoding: 'utf8', shell: false });
  assert.equal(noOptIn.status, 2);
  assert.equal(noOptIn.stderr.includes('JEVRIS_LIVE_HARNESS=1'), true);
  const inSuite = spawnSync(process.execPath, [script], {
    env: { ...process.env, JEVRIS_LIVE_HARNESS: '1' },
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(inSuite.status, 2);
  assert.equal(inSuite.stderr.includes('does not run inside the test suite'), true);
});

test('real-harness smoke certifies only the harnesses it finds on PATH and checks its arguments', async (t) => {
  const { HARNESS_BINARIES, findOnPath, parseArgs } = await import('../scripts/smoke-harness.mjs');
  assert.deepEqual(Object.keys(HARNESS_BINARIES).sort(), [...HARNESSES].sort());
  const dir = mkdtempSync(join(tmpdir(), 'jevris-smoke-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'kilo.cmd' : 'kilo';
  writeFileSync(join(dir, name), '');
  assert.equal(findOnPath('kilo', { PATH: dir, PATHEXT: '.CMD' }), join(dir, name));
  assert.equal(findOnPath('codex', { PATH: dir, PATHEXT: '.CMD' }), null);
  assert.equal(findOnPath('kilo', { PATH: '' }), null);
  const options = parseArgs(['--harness', 'kilo', '--harness', 'agy', '--evidence', dir]);
  assert.deepEqual(options.harnesses, ['kilo', 'agy']);
  assert.equal(options.evidence, dir);
  assert.throws(() => parseArgs(['--harness', 'vim']), /unknown harness vim/);
  assert.throws(() => parseArgs(['--signing-key', 'k.pem']), /go together/);
  assert.throws(() => parseArgs(['--evidence']), /needs a value/);
  assert.throws(() => parseArgs(['--enable']), /unknown argument/);
});
