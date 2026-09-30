// P8 (B a51d524): a hook that answers without the sidecar (the watchdog, a deadline, the sidecar
// unreachable) appends one line to `<state>/hook-latency.pending.jsonl` after its answer, for the
// sidecar to fold into its latency counters. A choice (observe-only, autostart off) writes
// nothing. The real launcher process with a temp JEVRIS_HOME; no sidecar is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardStdin } from '../../../scripts/child-stdin.mjs';
import { readLive } from '../../../test/live-files.mjs';

const { hookLatencyFile, parseHookLatencyLine } = await import('@jevris/sidecar/client');
const claude = await import('@jevris/adapter-claude-code');

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const SESSION_START = JSON.stringify(claude.FIXTURES.find((item) => item.id === 'claude.session-start').native);

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-hook-latency-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function runBin(home, argv, { input, env = {}, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const child = guardStdin(spawn(process.execPath, [BIN, ...argv], { env: { ...process.env, JEVRIS_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }));
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve({ code, stdout }));
    if (input !== undefined) child.stdin.write(input);
    if (!keepOpen) child.stdin.end();
    else setTimeout(() => child.stdin.end(), 5_000).unref();
  });
}

function lines(home) {
  const file = hookLatencyFile({ env: { ...process.env, JEVRIS_HOME: home } });
  if (!existsSync(file)) return [];
  return readLive(file, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => parseHookLatencyLine(line));
}

test('the watchdog answers and then records one HOOK_WATCHDOG line under the harness id', async (t) => {
  const home = withHome(t);
  const ran = await runBin(home, ['--harness', 'claude'], { keepOpen: true, env: { JEVRIS_HOOK_DEADLINE_MS: '100', JEVRIS_HOOK_OBSERVE_ONLY: '1' } });
  assert.equal(ran.code, 0);
  const got = lines(home);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.deepEqual([got[0].harness, got[0].reasonCode], ['claude', 'HOOK_WATCHDOG']);
  assert.ok(got[0].elapsedMs >= 100 && got[0].elapsedMs < 60_000, String(got[0].elapsedMs));
  const kilo = await runBin(home, ['--harness', 'kilo'], { keepOpen: true, env: { JEVRIS_HOOK_DEADLINE_MS: '100', JEVRIS_HOOK_OBSERVE_ONLY: '1' } });
  assert.equal(kilo.code, 0);
  assert.deepEqual(lines(home).map((entry) => [entry.harness, entry.reasonCode]), [['claude', 'HOOK_WATCHDOG'], ['kilocode', 'HOOK_WATCHDOG']], 'the launcher name kilo is recorded as the harness id kilocode');
});

test('observe-only and autostart off are choices, not misses: nothing is recorded', async (t) => {
  const home = withHome(t);
  const observe = await runBin(home, ['--harness', 'claude'], { input: SESSION_START, env: { JEVRIS_HOOK_OBSERVE_ONLY: '1' } });
  assert.equal(observe.code, 0);
  const off = await runBin(home, ['--harness', 'claude'], { input: SESSION_START, env: { JEVRIS_HOOK_OBSERVE_ONLY: '0', JEVRIS_SIDECAR_AUTOSTART: '0' } });
  assert.equal(off.code, 0);
  assert.deepEqual(lines(home), []);
});

test('the counted reasons: deadlines, the watchdog, sidecar start states and the client-side misses (K8); never a choice or an answer', async () => {
  const { countedHookReason } = await import('../dist/launcher.js');
  for (const reason of ['DEADLINE', 'HOOK_DEADLINE', 'HOOK_WATCHDOG', 'TIMEOUT', 'HANDSHAKE_TIMEOUT', 'BUSY', 'CONNECT_TIMEOUT', 'CONNECT_FAILED', 'ECONNREFUSED', 'CLOSED', 'SIDECAR_STARTING', 'SIDECAR_UNAVAILABLE', 'SIDECAR_TIMEOUT']) {
    assert.equal(countedHookReason(reason), true, reason);
  }
  for (const reason of ['SIDECAR_AUTOSTART_OFF', 'OBSERVE_ONLY', 'NO_PROPOSAL', 'NOT_CERTIFIED', 'SCOPE_DENIED', 'INPUT_REFUSED', 'PROPOSED_BY_SECURITY', 'timeout', 'CONNECT_', 'XTIMEOUT']) {
    assert.equal(countedHookReason(reason), false, reason);
  }
});

test('G16: the misses a Kilo shim carried become one line each under kilocode, at their longest wait', async (t) => {
  const home = withHome(t);
  const kilo = await import('@jevris/adapter-kilocode');
  const idle = kilo.FIXTURES.find((item) => item.id === 'kilocode.session-idle').native;
  const input = JSON.stringify({ ...idle, shimMisses: [{ reasonCode: 'SHIM_DROPPED', count: 2, maxMs: 0 }, { reasonCode: 'SHIM_KILLED', count: 1, maxMs: 30000 }] });
  const ran = await runBin(home, ['--harness', 'kilo'], { input, env: { JEVRIS_HOOK_OBSERVE_ONLY: '1' } });
  assert.equal(ran.code, 0);
  assert.deepEqual(
    lines(home).map((entry) => [entry.harness, entry.reasonCode, entry.elapsedMs]),
    [
      ['kilocode', 'SHIM_DROPPED', 0],
      ['kilocode', 'SHIM_DROPPED', 0],
      ['kilocode', 'SHIM_KILLED', 30000],
    ],
  );
  const many = JSON.stringify({ ...idle, shimMisses: [{ reasonCode: 'SHIM_DROPPED', count: 1000, maxMs: 0 }] });
  await runBin(home, ['--harness', 'opencode'], { input: many, env: { JEVRIS_HOOK_OBSERVE_ONLY: '1' } });
  assert.equal(lines(home).filter((entry) => entry.harness === 'opencode').length, 64, 'at most 64 lines per delivery');
});
