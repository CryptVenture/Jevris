// US36 (F's part), CLA-07, CDX-06, AGY-06: the hooks an install writes run from a home whose
// path has spaces and non-ASCII letters, on a PATH with node and nothing else (no Bash, no jq).
// Claude's hook is exec form (command + args, no shell); Codex and Antigravity hooks are one
// command line, run the way each harness runs it (/bin/sh -c on POSIX, cmd.exe /d /s /c with
// commandWindows on Windows). Each answers its protocol's exact output. Temp home only; no
// harness binary runs; no sidecar is started (observe): the hooks' sidecar entry points at a
// file that does not exist, and the test ends any sidecar naming its folder before removing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const { main } = await import('../dist/cli.js');

const WIN = process.platform === 'win32';

/** A PATH that finds node and nothing else a hook might lean on. */
function nodeOnlyPath(base) {
  if (WIN) {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    return [dirname(process.execPath), system].join(delimiter);
  }
  const bin = join(base, 'bin');
  spawnSync(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(bin)})`]);
  symlinkSync(process.execPath, join(bin, 'node'));
  return bin;
}

function hookEnv(home, path) {
  // The hook launcher starts a sidecar on demand whatever JEVRIS_SIDECAR_AUTOSTART says; a missing
  // entry makes that start fail at once, so no detached sidecar outlives the test.
  const env = { PATH: path, HOME: home, USERPROFILE: home, JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_SIDECAR_ENTRY: join(home, '.jevris-test-no-sidecar.mjs'), JEVRIS_TEST: '1' };
  for (const key of ['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (WIN) Object.assign(env, { LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming') });
  return env;
}

async function install(home, harness) {
  let out = '';
  const code = await main(['install', '--yes', '--home', home, '--harness', harness], (chunk) => (out += chunk));
  assert.equal(code, 0, out);
}

function runLine(line, env, input) {
  return WIN
    ? spawnSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, input, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 30_000 })
    : spawnSync('/bin/sh', ['-c', line], { env, input, encoding: 'utf8', timeout: 30_000 });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ends any sidecar whose command line names `base` (POSIX `ps`; Windows has no detached leftover here). */
async function endSidecarsUnder(base) {
  if (WIN) return;
  const names = [base, base.replace(/^\/private(?=\/)/, '')];
  const ps = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', shell: false });
  const pids = String(ps.stdout ?? '')
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null && match[2].includes('sidecar') && names.some((name) => match[2].includes(name)))
    .map((match) => Number(match[1]))
    .filter((pid) => pid > 1 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  for (const pid of pids) {
    for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
}

test('installed hooks run from a home with spaces on a PATH without Bash or jq, and answer valid protocol output', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'jevris-launch-'));
  t.after(async () => {
    await endSidecarsUnder(base);
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const home = join(base, 'Ann Lée home');
  spawnSync(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(home)})`]);
  const path = nodeOnlyPath(base);
  for (const dir of path.split(delimiter)) {
    const names = existsSync(dir) ? readdirSync(dir).map((name) => name.toLowerCase()) : [];
    for (const tool of ['bash', 'bash.exe', 'jq', 'jq.exe']) assert.equal(names.includes(tool), false, `${tool} is on the test PATH (${dir})`);
  }
  const env = hookEnv(home, path);
  const work = join(home, 'my project');
  spawnSync(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(work)})`]);

  // Claude Code: exec form, so the arguments reach node exactly, with no shell to quote them.
  await install(home, 'claude');
  const claudeHooks = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'jevris-local', 'plugins', 'jevris', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const exec = claudeHooks.UserPromptSubmit[0].hooks[0];
  assert.equal(exec.command, 'node');
  assert.ok(exec.args[0].includes('Ann Lée home'), 'the runtime path with spaces is one argument');
  assert.deepEqual(exec.args.slice(1), ['--harness', 'claude']);
  const node = WIN ? process.execPath : join(path, 'node');
  const claude = spawnSync(node, exec.args, { env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', transcript_path: join(work, 's1.jsonl'), cwd: work, prompt: 'fix the build' }), encoding: 'utf8', timeout: 30_000 });
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.stdout, '', 'Claude observe output is empty');
  const stop = spawnSync(node, exec.args, { env, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: work, stop_hook_active: false }), encoding: 'utf8', timeout: 30_000 });
  assert.equal(stop.status, 0, stop.stderr);

  // Codex: one command line; Stop must answer JSON with no decision.
  await install(home, 'codex');
  const codexHooks = JSON.parse(readFileSync(join(home, '.codex', 'plugins', 'jevris', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const codexStop = codexHooks.Stop[0].hooks[0];
  const codexLine = WIN ? codexStop.commandWindows : codexStop.command;
  assert.equal(typeof codexLine, 'string', 'the Codex hook has a command line for this OS');
  const codex = runLine(codexLine, env, JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', turn_id: 't1', cwd: work, stop_hook_active: false }));
  assert.equal(codex.status, 0, codex.stderr);
  assert.deepEqual(JSON.parse(codex.stdout), {}, `Codex Stop answered ${codex.stdout}`);

  // Antigravity: one command line per event; Stop always lets the stop proceed.
  await install(home, 'antigravity');
  const agyHooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'plugins', 'jevris', 'hooks.json'), 'utf8'))['jevris-observe'];
  const agyStop = agyHooks.Stop[0];
  const agyLine = agyStop.command ?? agyStop.hooks?.[0]?.command;
  const agy = runLine(agyLine, env, JSON.stringify({ conversationId: 'c1', workspacePaths: [work], executionNum: 1, terminationReason: 'model_stop', error: '', fullyIdle: true }));
  assert.equal(agy.status, 0, agy.stderr);
  assert.deepEqual(JSON.parse(agy.stdout), { decision: 'stop' });
});
