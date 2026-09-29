// Doctor's settings lines (51fb3122): the effective mode and the layer that set it (info), and each
// problem with a file that caps it (action, with its fix). Temp homes only; no harness, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { runDoctorCommand } = await import('../dist/doctor-cli.js');
const { defaultHostDocument } = await import('../dist/egress-command.js');
const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const cli = { available: () => false, run: async () => ({ spawned: false, code: -1, stdout: '' }) };

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-doctor-settings-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  return { home, config };
}

async function doctor(home) {
  let out = '';
  await runDoctorCommand({ home, json: true, values: {}, root, cli, policies: [], env: { PATH: '' } }, (chunk) => (out += chunk));
  const parsed = JSON.parse(out);
  return { lines: parsed.lines.filter((line) => line.text.startsWith('settings ')), json: parsed.settings };
}

test('no policy file: the mode from the defaults, then from your file, as info', async (t) => {
  const { home, config } = tempHome(t);
  let got = await doctor(home);
  assert.deepEqual(got.lines, [{ text: 'settings mode: bounded-auto (set by the defaults)', severity: 'info' }]);
  assert.deepEqual(got.json, { mode: 'bounded-auto', modeSource: 'defaults', issues: [] });
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode: 'advise' }));
  got = await doctor(home);
  assert.deepEqual(got.lines, [{ text: 'settings mode: advise (set by your jevris.config.json)', severity: 'info' }]);
});

test('a host.json ceiling names its layer; a problem with it is an action with its fix', async (t) => {
  const { home, config } = tempHome(t);
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode: 'advise' }));
  writeFileSync(join(config, 'host.json'), JSON.stringify({ ...defaultHostDocument('deny-until-approved'), mode: 'observe' }), { mode: 0o600 });
  let got = await doctor(home);
  assert.deepEqual(got.lines, [{ text: 'settings mode: observe (set by host.json (a ceiling))', severity: 'info' }]);
  writeFileSync(join(config, 'host.json'), '{ not json', { mode: 0o600 });
  got = await doctor(home);
  assert.deepEqual(got.lines[1], { text: 'settings issue: host: INVALID_JSON; it is not used, so the mode is capped at observe; fix the file to match the host-policy contract', severity: 'action' });
  assert.deepEqual(got.json.issues, [{ path: 'host:', code: 'INVALID_JSON' }]);
  if (process.platform !== 'win32') {
    writeFileSync(join(config, 'host.json'), JSON.stringify({ ...defaultHostDocument('deny-until-approved'), mode: 'observe' }));
    chmodSync(join(config, 'host.json'), 0o664);
    got = await doctor(home);
    assert.equal(got.lines[0].text, 'settings mode: observe (set by host.json (a ceiling))', 'a refused file still caps');
    assert.deepEqual(got.lines[1], { text: 'settings issue: host: AUTHORITY_FILE_SHARED_WRITE; its ceiling still applies, but it grants nothing; make the file yours and owner-only (chmod 600)', severity: 'action' });
  }
});

test('after the upgrade moved the mode, doctor and status show the one-time notice until configure set mode', async (t) => {
  const { home, config } = tempHome(t);
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode: 'observe' }));
  const { migrateModeDefault, MODE_MIGRATION_NOTICE, setConfigValue } = await import('@jevris/orchestrator');
  assert.equal(await migrateModeDefault({ home }), 'migrated');
  let got = await doctor(home);
  assert.deepEqual(got.lines, [
    { text: 'settings mode: bounded-auto (set by your jevris.config.json)', severity: 'info' },
    { text: `settings notice: ${MODE_MIGRATION_NOTICE}`, severity: 'info' },
  ]);
  assert.equal(got.json.notice, MODE_MIGRATION_NOTICE);
  // The local status carries it too, and renders it as one line.
  const { runPublicCommand } = await import('../dist/public-commands.js');
  const workspace = join(home, 'work');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const ports = { sidecar: { ensure: async () => ({ ok: true, endpoint: 'fake', started: false }), request: async () => ({ ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'x' }) }, engine: {}, config: {} };
  const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' };
  let json = '';
  await runPublicCommand('status', ['--json'], (chunk) => (json += chunk), { ports, env, cwd: workspace });
  assert.equal(JSON.parse(json).result.modeNotice, MODE_MIGRATION_NOTICE);
  let text = '';
  await runPublicCommand('status', [], (chunk) => (text += chunk), { ports, env, cwd: workspace });
  assert.ok(text.includes(`notice: ${MODE_MIGRATION_NOTICE}`), text);
  await setConfigValue({ home, key: 'mode', value: 'observe', dryRun: false, sourceEgress: async () => 'not-approved' });
  got = await doctor(home);
  assert.deepEqual(got.lines.map((line) => line.text), ['settings mode: observe (set by your jevris.config.json)']);
  json = '';
  await runPublicCommand('status', ['--json'], (chunk) => (json += chunk), { ports, env, cwd: workspace });
  assert.equal(JSON.parse(json).result.modeNotice, undefined);
});
