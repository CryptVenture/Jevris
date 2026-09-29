// Process hygiene: a process a test starts (the detached sidecar above all) never outlives the
// test file that started it, even when that file's process is killed and no `finally` runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { managedHostSkip } from './managed-host.mjs';
import { OWNER_ENV, installOwnerWatch, ownerPid, pidRunning } from '../scripts/test-owner-watch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD = pathToFileURL(join(root, 'scripts', 'test-preload.mjs')).href;
const BIN = join(root, 'bin', 'jevris.mjs');

async function waitFor(check, limitMs) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/** A test file's process as the node:test runner starts one: no owner yet, the runner's mark, the preload. */
function ownerEnv(extra = {}) {
  const env = { ...process.env, ...extra, NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: `--import=${PRELOAD}` };
  delete env[OWNER_ENV];
  return env;
}

/** Starts a stand-in test file (`<dir>/owner.test.mjs`) that runs `script`, which prints one line when ready. */
async function startOwner(dir, script, env) {
  const file = join(dir, 'owner.test.mjs');
  writeFileSync(file, script);
  const owner = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  owner.stdout.on('data', (chunk) => (out += chunk));
  owner.stderr.on('data', (chunk) => (err += chunk));
  const ready = await waitFor(() => out.includes('\n') || owner.exitCode !== null, 60_000);
  assert.equal(ready && owner.exitCode === null, true, `the owner started: ${out} ${err}`);
  return { owner, line: out.split('\n')[0] ?? '' };
}

test('the owner is the test file\'s process: it claims once, the runner never does, nor a CLI whose environment lost the owner, and a malformed value is no owner', () => {
  const testFile = ['node', '/repo/apps/sidecar/test/daemon.test.mjs'];
  const none = {};
  assert.equal(installOwnerWatch({ env: none, pid: 11, argv: testFile }), 'none', 'the runner (no NODE_TEST_CONTEXT) never claims');
  assert.equal(OWNER_ENV in none, false);
  const cli = { NODE_TEST_CONTEXT: 'child-v8' };
  assert.equal(installOwnerWatch({ env: cli, pid: 13, argv: ['node', '/repo/bin/jevris.mjs', 'sidecar', 'start'] }), 'none', 'a CLI never owns the sidecar it starts');
  assert.equal(OWNER_ENV in cli, false);
  const file = { NODE_TEST_CONTEXT: 'child-v8' };
  assert.equal(installOwnerWatch({ env: file, pid: 12, argv: testFile }), 'owner');
  assert.equal(ownerPid(file), 12, 'its children inherit the owner');
  assert.equal(OWNER_ENV.startsWith('JEVRIS_'), false, 'it survives a test that drops every JEVRIS_ variable');
  assert.equal(installOwnerWatch({ env: { ...file }, pid: 12 }), 'owner', 'the owner itself never watches');
  for (const bad of ['', '0', '-3', '12abc', '99999999999']) assert.equal(ownerPid({ [OWNER_ENV]: bad }), null, bad);
  assert.equal(pidRunning(process.pid), true);
});

test('a process started under an owner ends once the owner has gone, and not before', async () => {
  let alive = true;
  let ended = 0;
  const env = { [OWNER_ENV]: '4242', NODE_TEST_CONTEXT: 'child-v8' };
  assert.equal(installOwnerWatch({ env, pid: 4343, check: 10, running: (pid) => pid === 4242 && alive, end: () => (ended += 1) }), 'watching');
  assert.equal(await waitFor(() => ended > 0, 300), false, 'the owner runs: nothing ends');
  alive = false;
  assert.equal(await waitFor(() => ended > 0, 30_000), true, 'the owner has gone: the process ends');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ended, 1, 'it ends once');
});

test('a detached grandchild ends cleanly once its test file\'s process is killed with SIGKILL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-owner-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const marker = join(dir, 'stopped');
  // The grandchild stands in for the sidecar: detached, kept alive, and it handles SIGTERM.
  const grandchild = [
    "import { writeFileSync } from 'node:fs';",
    `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'SIGTERM'); process.exit(0); });`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const script = [
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' });`,
    'child.unref();',
    `process.stdout.write(String(child.pid) + ' ' + process.env.${OWNER_ENV} + '\\n');`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const { owner, line } = await startOwner(dir, script, ownerEnv());
  const [childPid, claimed] = line.split(' ').map(Number);
  t.after(() => {
    if (Number.isSafeInteger(childPid) && pidRunning(childPid)) process.kill(childPid, 'SIGKILL');
  });
  assert.equal(claimed, owner.pid, 'the stand-in test file claimed ownership');
  assert.equal(pidRunning(childPid), true);
  owner.kill('SIGKILL');
  assert.equal(await waitFor(() => !pidRunning(childPid), 30_000), true, 'the orphan ended');
  if (process.platform !== 'win32') assert.equal(existsSync(marker), true, 'through its own SIGTERM handler');
});

/** A stand-in test file that starts a sidecar with `jevris sidecar start` (optionally with the owner dropped from the CLI's environment), and its sidecar's pid. */
async function sidecarUnderOwner(t, { dropOwner }) {
  const dir = mkdtempSync(join(tmpdir(), 'jow-'));
  const home = join(dir, 'h');
  mkdirSync(home);
  const homeEnv = { HOME: home, USERPROFILE: home, JEVRIS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
  const jevris = (args) => spawnSync(process.execPath, [BIN, ...args, '--home', home], { env: { ...process.env, ...homeEnv }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  t.after(() => {
    jevris(['sidecar', 'stop']);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const script = [
    "import { spawnSync } from 'node:child_process';",
    `const env = { ...process.env };`,
    dropOwner ? `delete env.${OWNER_ENV};` : '',
    `const started = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'sidecar', 'start', '--home', ${JSON.stringify(home)}], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });`,
    "process.stdout.write('started ' + String(started.status) + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const { owner, line } = await startOwner(dir, script, ownerEnv(homeEnv));
  t.after(() => owner.kill('SIGKILL'));
  assert.equal(line, 'started 0', line);
  const status = JSON.parse(jevris(['sidecar', 'status', '--json']).stdout.trim().split(/\r?\n/).at(-1) ?? '{}');
  assert.equal(status.state, 'running', JSON.stringify(status));
  assert.equal(Number.isSafeInteger(status.pid) && pidRunning(status.pid), true);
  return { owner, pid: status.pid };
}

test('a sidecar a killed test file started stops by itself; no sidecar is left with parent PID 1', { skip: managedHostSkip() }, async (t) => {
  const { owner, pid } = await sidecarUnderOwner(t, { dropOwner: false });
  owner.kill('SIGKILL');
  assert.equal(await waitFor(() => !pidRunning(pid), 30_000), true, 'the sidecar stopped once its test file had gone');
});

test('a CLI whose environment lost the owner never owns the sidecar it starts: the sidecar keeps running while its test file runs', { skip: managedHostSkip() }, async (t) => {
  const { owner, pid } = await sidecarUnderOwner(t, { dropOwner: true });
  // Three checks' worth: a CLI that had claimed ownership would have ended its sidecar by now.
  await new Promise((resolve) => setTimeout(resolve, 3 * 1000 + 500));
  assert.equal(pidRunning(pid), true, 'the sidecar outlived the CLI that started it');
  assert.equal(owner.exitCode, null);
});
