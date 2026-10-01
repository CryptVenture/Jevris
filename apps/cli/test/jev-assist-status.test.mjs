// Owner decision 2026-10-01 (Jev as an active decision aid): `jevris status` and `jevris configure`
// show `jev.assist` (classify by default), `configure set` lowers it freely and refuses a raise
// without a person at a terminal. Temp home, no sidecar, no harness binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));
const { surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-jev-assist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, JEVRIS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), JEVRIS_SIDECAR_AUTOSTART: '0', CLAUDE_PROJECT_DIR: work };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd: work, encoding: 'utf8', input: '' });
  return { run };
}

test('status and configure show jev assist as classify from install', (t) => {
  const { run } = sandbox(t);
  const status = run('status', '--json');
  assert.equal(status.status, 0, status.stderr);
  const result = JSON.parse(status.stdout).result;
  assert.equal(result.jevAssist, 'classify');
  assert.equal(surfacePayloadContract('status').validate(result).ok, true);
  assert.match(run('status').stdout, /jev assist: classify \(Jev classifies a route request's task slice/);
  const configure = JSON.parse(run('configure', '--json').stdout).result;
  assert.equal(configure.effective.jevAssist, 'classify');
  assert.match(run('configure').stdout, /jev assist: classify/);
});

test('configure set jev.assist off is free; turning it back on needs a person at a terminal', (t) => {
  const { run } = sandbox(t);
  const off = run('configure', 'set', 'jev.assist', 'off');
  assert.equal(off.status, 0, off.stderr + off.stdout);
  assert.equal(JSON.parse(run('status', '--json').stdout).result.jevAssist, 'off');
  assert.match(run('status').stdout, /jev assist: off \(every such decision is rules-only\)/);
  const on = run('configure', 'set', 'jev.assist', 'classify');
  assert.notEqual(on.status, 0);
  assert.match(on.stdout + on.stderr, /CHANNEL_REFUSED|needs a person at an interactive terminal/);
  assert.equal(JSON.parse(run('status', '--json').stdout).result.jevAssist, 'off', 'nothing was written');
});
