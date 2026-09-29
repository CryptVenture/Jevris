// SR-19 and SR-20 (owner decision 2e13b6fe) outside configure itself: install still writes its
// defaults without the raise gate, and an unusable user file shows in doctor and status with its
// fix. Temp homes only; no harness binary, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { main } = await import('../dist/cli.js');
const { runDoctorCommand } = await import('../dist/doctor-cli.js');
const { runPublicCommand } = await import('../dist/public-commands.js');
const { DEFAULT_CONFIG, readEffectiveConfig } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const cli = { available: () => false, run: async () => ({ spawned: false, code: -1, stdout: '' }) };

function tempHome(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-configure-raise-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(dir, 'home');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const workspace = join(dir, 'work');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { home, config, workspace, file: join(config, 'jevris.config.json') };
}

test('install --yes never goes through the raise gate: it writes no jevris.config.json, so the defaults apply (owner decisions 1fc4abd, 7922ee3)', async (t) => {
  const { home, file } = tempHome(t);
  let text = '';
  const code = await main(['install', '--home', home, '--harness', 'claude', '--yes'], (chunk) => (text += chunk));
  assert.equal(code, 0, text);
  assert.equal(existsSync(file), false, 'install leaves the user file to configure');
  assert.equal(text.includes('CHANNEL_REFUSED'), false, text);
  const eff = readEffectiveConfig({ home });
  assert.deepEqual([eff.config.mode, eff.config.routing.managedWorkers, eff.config.routing.mainSession, eff.modeSource], ['bounded-auto', 'bounded-auto', 'plugin-bounded-auto', 'defaults']);
  assert.deepEqual([eff.config.mode, eff.config.routing.managedWorkers], [DEFAULT_CONFIG.mode, DEFAULT_CONFIG.routing.managedWorkers]);
});

test('SR-20: an unusable jevris.config.json shows in doctor and status as a user: issue with its fix, the mode capped at observe', async (t) => {
  const { home, workspace, file } = tempHome(t);
  writeFileSync(file, '{ not json');
  let out = '';
  await runDoctorCommand({ home, json: true, values: {}, root, cli, policies: [], env: { PATH: '' } }, (chunk) => (out += chunk));
  const doctor = JSON.parse(out);
  const lines = doctor.lines.filter((line) => line.text.startsWith('settings '));
  assert.deepEqual(lines[0], { text: 'settings mode: observe (set by your jevris.config.json)', severity: 'info' });
  assert.deepEqual(lines[1], { text: 'settings issue: user: INVALID_JSON; your jevris.config.json cannot be used, so the mode is capped at observe; fix it by hand, or run jevris configure set mode off (or observe) to write a fresh one', severity: 'action' });
  assert.ok(doctor.settings.issues.some((issue) => issue.path === 'user:' && issue.code === 'INVALID_JSON'));
  const ports = { sidecar: { ensure: async () => ({ ok: true, endpoint: 'fake', started: false }), request: async () => ({ ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'x' }) }, engine: {}, config: {} };
  const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' };
  let json = '';
  await runPublicCommand('status', ['--json'], (chunk) => (json += chunk), { ports, env, cwd: workspace });
  const status = JSON.parse(json).result;
  assert.ok(status.settingsIssues.some((issue) => issue.path === 'user:' && issue.code === 'INVALID_JSON'), JSON.stringify(status.settingsIssues));
  let text = '';
  await runPublicCommand('status', [], (chunk) => (text += chunk), { ports, env, cwd: workspace });
  assert.ok(text.includes('settings issue: user: INVALID_JSON'), text);
});
