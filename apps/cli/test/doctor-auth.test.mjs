// `jevris doctor` shows each harness's auth mode (owner decision 2026-09-26): D's effective mode
// from workers.json and the environment, with what the harness reports. Names and modes only;
// a key or token value never appears. The harness is a stub, never the real binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { authViews, runDoctorCommand } = await import('../dist/doctor-cli.js');
const { authLine } = await import('../dist/harness-auth.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { jevrisPaths } = await import('@jevris/platform');
const root = fileURLToPath(new URL('../../..', import.meta.url));

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-doctor-auth-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// The stub harness is asked only when the guard allows it; by default a test run is never probed.
const allow = () => null;

const cli = (answers) => ({
  available: (file) => file in answers,
  run: async (file) => ({ spawned: true, code: 0, stdout: answers[file] ?? '' }),
});

test('doctor auth: auto follows the vendor key in the environment; the harness says which login it holds', async (t) => {
  const home = tempHome(t);
  const answers = { claude: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.invalid' }), codex: 'Logged in using ChatGPT' };
  const plain = await authViews(home, cli(answers), undefined, {}, allow);
  assert.deepEqual(
    plain.views.map((v) => [v.harness, v.setting, v.mode, v.detected, v.problem]),
    [
      ['claude', 'auto', 'subscription', 'subscription', null],
      ['kilo', 'auto', 'subscription', 'unknown', null],
      ['codex', 'auto', 'subscription', 'subscription', null],
      ['opencode', 'auto', 'subscription', 'unknown', null],
      ['antigravity', 'auto', 'subscription', 'unknown', null],
    ],
  );
  const keyed = await authViews(home, cli(answers), 'claude', { ANTHROPIC_API_KEY: 'secret-value' }, allow);
  assert.deepEqual([keyed.views[0].mode, keyed.views[0].keysInEnvironment], ['api-key', ['ANTHROPIC_API_KEY']]);
  assert.equal(JSON.stringify(keyed).includes('secret-value'), false, 'never a value');
  assert.equal(JSON.stringify(plain).includes('example.invalid'), false, 'never an account detail');
});

test('doctor auth: a stated mode wins, and what would stop a run is named', async (t) => {
  const home = tempHome(t);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { claude: 'api-key', codex: 'subscription', kilo: 'api-key' } }));
  const { views, settingsProblem } = await authViews(home, cli({ codex: 'Not logged in' }), undefined, { OPENAI_API_KEY: 'o' }, allow);
  assert.equal(settingsProblem, null);
  const by = Object.fromEntries(views.map((v) => [v.harness, v]));
  assert.deepEqual([by.claude.setting, by.claude.mode, by.claude.problem], ['api-key', 'api-key', 'api-key mode needs ANTHROPIC_API_KEY in the environment']);
  assert.deepEqual([by.codex.mode, by.codex.problem], ['subscription', 'not signed in; run codex login'], 'a stated subscription ignores the key');
  assert.deepEqual([by.kilo.mode, by.kilo.problem], ['api-key', null]);

  // The real doctor in a test run never asks the harness, not even a stub.
  let asked = 0;
  let text = '';
  await runDoctorCommand({ home, json: false, harness: 'codex', values: {}, root, cli: { available: () => true, run: async (_file, args) => (args.includes('auth') || args.includes('login') ? (asked += 1) : 0, { spawned: true, code: 0, stdout: 'Not logged in' }) }, policies: [] }, (chunk) => (text += chunk));
  assert.match(text, /^harness codex auth: subscription \(stated in workers\.json; not probed: test run\)$/m);
  assert.equal(asked, 0, 'no status probe ran');

  writeFileSync(join(config, 'workers.json'), '{ not json');
  let broken = '';
  await runDoctorCommand({ home, json: false, harness: 'codex', values: {}, root, cli: cli({}), policies: [] }, (chunk) => (broken += chunk));
  assert.match(broken, /^workers\.json: workers\.json is not JSON; owned workers are refused until it is fixed$/m);
});

test('doctor auth: XAI_API_KEY is named (the name only) for Kilo and OpenCode, and never required', async (t) => {
  const home = tempHome(t);
  const env = { XAI_API_KEY: 'secret-xai-value' };
  const { views } = await authViews(home, cli({}), undefined, env, allow);
  const by = Object.fromEntries(views.map((v) => [v.harness, v]));
  assert.deepEqual(by.kilo.modelKeysInEnvironment, ['XAI_API_KEY']);
  assert.deepEqual(by.opencode.modelKeysInEnvironment, ['XAI_API_KEY']);
  assert.equal(by.claude.modelKeysInEnvironment, undefined);
  assert.equal(by.codex.modelKeysInEnvironment, undefined);
  assert.equal(JSON.stringify(views).includes('secret-xai-value'), false, 'never a value');
  const without = await authViews(home, cli({}), 'opencode', {}, allow);
  assert.equal(without.views[0].modelKeysInEnvironment, undefined, 'no key, no mention');
  assert.equal(without.views[0].problem, null, 'a SuperGrok login works too: no key is required');
});

test('doctor auth: Antigravity shows its Google sign-in, and a stated api-key is named as refused', async (t) => {
  const home = tempHome(t);
  const { views } = await authViews(home, cli({}), 'antigravity', { GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k' }, allow);
  assert.equal(authLine(views[0]), 'harness antigravity auth: google sign-in (auto: always its Google sign-in; Antigravity refuses api-key)', 'a Google key in the environment changes nothing');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { antigravity: 'api-key' } }));
  const stated = await authViews(home, cli({}), 'antigravity', {}, allow);
  assert.match(authLine(stated.views[0]), /^harness antigravity auth: api-key \(stated in workers\.json; Antigravity refuses api-key\); Antigravity has no API-key sign-in, so its owned workers are refused in api-key mode; fix: set "antigravity" to "subscription" in workers\.json, or remove it$/);
  assert.equal(doctorLineSeverity(authLine(stated.views[0])), 'action');
});
