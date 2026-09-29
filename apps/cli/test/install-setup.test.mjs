// Owner directive 2026-09-26: "the setup you just made me do manually should be automatic at
// install". Paired tests: install certifies what it installed (a stand-in harness, no model
// call) and a harness that does not certify never fails the install; --no-certify skips it; on a
// terminal, a sign-in nothing could detect is asked once and recorded in workers.json. Stub
// harness CLIs and temp homes only; a test run never starts a real harness or asks one its login.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_HELP } from './harness-cli-stubs.mjs';

const { main } = await import('../dist/cli.js');
const { recordWorkerAuth, certificationLines } = await import('../dist/install-setup.js');
const { jevrisPaths } = await import('@jevris/platform');

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-install-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

async function run(argv, hooks) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk), hooks);
  return { code, text };
}

/** A Claude Code stand-in that install and certify can both use. */
function claudeStub(version = '2.1.283', help = WORKER_HELP.claude) {
  return {
    available: (file) => file === 'claude',
    run: async (_file, args) => {
      const line = args.join(' ');
      if (line === '--version') return { spawned: true, code: 0, stdout: `${version} (Claude Code)\n` };
      if (line === '--help') return { spawned: true, code: 0, stdout: help };
      if (line.startsWith('plugin validate')) return { spawned: true, code: 0, stdout: '✔ Validation passed\n' };
      if (line === 'plugin list --json') return { spawned: true, code: 0, stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      if (line.startsWith('plugin details')) return { spawned: true, code: 0, stdout: 'Skills: status, plan, route, checkpoint, recover, verify, explain, configure\n' };
      return { spawned: true, code: 0, stdout: '' };
    },
  };
}

/** The PATH question for the jevris command (command-launcher.ts) is answered no here. */
const noPath = async () => false;

const workersFile = (home) => join(jevrisPaths({ home }).config, 'workers.json');

test('install certifies what it installed: the harness is certified straight away, and doctor needs nothing more', async (t) => {
  const home = tempHome(t);
  const { code, text } = await run(['install', '--yes', '--home', home, '--harness', 'claude', '--no-smoke'], { harnessCli: claudeStub(), isTTY: false });
  assert.equal(code, 0, text);
  assert.match(text, /^certify claude: certified \(version 2\.1\.283\)$/m);
  assert.match(text, /^mode: certified \(hooks act on their certified features; jevris doctor shows each harness\)$/m);
  assert.doesNotMatch(text, /mode: reduced/);
  // The next lines are only what cannot be automated.
  assert.deepEqual(text.split('\n').filter((line) => line.startsWith('next: ')), ['next: Claude Code: restart Claude Code; /plugin lists jevris and /hooks shows the Jevris hooks.']);
  let doctor = '';
  await main(['doctor', '--home', home, '--harness', 'claude'], (chunk) => (doctor += chunk), { harnessCli: claudeStub() });
  assert.match(doctor, /^harness claude: installed; version 2\.1\.283; certification records: 1; certified for >=2\.1\.283 <2\.2\.0 /m);
  assert.match(doctor, /^harness claude worker: certified, pending first use/m);

  const json = JSON.parse((await run(['install', '--yes', '--home', home, '--harness', 'claude', '--no-smoke', '--json'], { harnessCli: claudeStub() })).text);
  assert.deepEqual(json.certification.map((item) => [item.harness, item.ok, item.harnessVersion, item.reason]), [['claude', true, '2.1.283', null]]);
});

test('a harness that does not certify never fails the install; its line names why and the fix, and --no-certify skips it', async (t) => {
  const home = tempHome(t);
  const helpWithoutEffort = WORKER_HELP.claude.replace('--effort <level>', '');
  const partial = await run(['install', '--yes', '--home', home, '--harness', 'claude', '--no-smoke'], { harnessCli: claudeStub('2.1.283', helpWithoutEffort) });
  assert.equal(partial.code, 0, partial.text);
  assert.match(partial.text, /^certify claude: not certified: worker\.route \(WORKER_FLAG_MISSING\), models\.list \(HARNESS_NOT_INSTALLED\), access\.detect \(ACCESS_DETECT_CASE_FAILED\), access\.session \(ACCESS_SESSION_CASE_FAILED\); fix: jevris certify --harness claude$/m);
  assert.match(partial.text, /^mode: reduced for claude \(observe only until certified; the lines above name the fix\)$/m);

  const home2 = tempHome(t);
  const silent = { available: (file) => file === 'claude', run: async () => ({ spawned: true, code: 0, stdout: '' }) };
  const failed = await run(['install', '--yes', '--home', home2, '--harness', 'claude', '--no-smoke'], { harnessCli: silent });
  assert.equal(failed.code, 0, failed.text);
  assert.match(failed.text, /^certify claude: claude --version did not print a version; fix: jevris certify --harness claude$/m);

  const home3 = tempHome(t);
  const calls = [];
  const counting = { available: (file) => file === 'claude', run: async (_file, args) => (calls.push(args.join(' ')), { spawned: true, code: 0, stdout: '' }) };
  const skipped = await run(['install', '--yes', '--home', home3, '--harness', 'claude', '--no-smoke', '--no-certify'], { harnessCli: counting });
  assert.equal(skipped.code, 0, skipped.text);
  assert.doesNotMatch(skipped.text, /^certify /m);
  assert.match(skipped.text, /^mode: reduced \(observe only until certified: jevris certify --harness all\)$/m);
  assert.equal(calls.includes('--help'), false, 'no certification ran (certify reads the worker flags from --help)');

  // In a test run the real harness binaries are never started: each harness says so, and the install still succeeds.
  const home4 = tempHome(t);
  const guarded = await run(['install', '--yes', '--home', home4, '--harness', 'kilocode', '--no-smoke']);
  assert.equal(guarded.code, 0, guarded.text);
  assert.match(guarded.text, /^certify kilocode: certify starts the real harness binary, which is disabled in a test run .*; fix: jevris certify --harness kilocode$/m);
  assert.deepEqual(certificationLines([]), ['mode: certified (hooks act on their certified features; jevris doctor shows each harness)']);
});

test('on a terminal, a sign-in nothing could detect is asked once and recorded in workers.json; no terminal, no question', async (t) => {
  const home = tempHome(t);
  const asked = [];
  const ask = async (question) => (asked.push(question), 's');
  const { code, text } = await run(['install', '--yes', '--home', home, '--harness', 'kilocode', '--no-smoke', '--no-certify'], { isTTY: true, confirm: noPath, ask });
  assert.equal(code, 0, text);
  // A test run never asks Kilo for its login, so its sign-in is unknown here and the person is asked.
  assert.deepEqual(asked, ["How does kilo sign in for Jevris's owned workers? [s]ubscription, [a]pi-key, or Enter to skip: "]);
  assert.match(text, /^auth kilo: subscription \(recorded in .*workers\.json\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(workersFile(home), 'utf8')), { schemaVersion: 'jevris-workers-1', auth: { kilo: 'subscription' } });
  if (process.platform !== 'win32') assert.equal(statSync(workersFile(home)).mode & 0o777, 0o600);

  // Stated now, so a second install asks nothing.
  asked.length = 0;
  await run(['install', '--yes', '--home', home, '--harness', 'kilocode', '--no-smoke', '--no-certify'], { isTTY: true, confirm: noPath, ask });
  assert.deepEqual(asked, []);

  // Enter skips; no terminal (or --json) never asks.
  const home2 = tempHome(t);
  const skipped = await run(['install', '--yes', '--home', home2, '--harness', 'opencode', '--no-smoke', '--no-certify'], { isTTY: true, confirm: noPath, ask: async () => '' });
  assert.match(skipped.text, /^auth opencode: skipped; state it in .*workers\.json when you know$/m);
  let never = 0;
  await run(['install', '--yes', '--home', home2, '--harness', 'opencode', '--no-smoke', '--no-certify'], { isTTY: false, ask: async () => (never += 1, 'a') });
  await run(['install', '--yes', '--home', home2, '--harness', 'opencode', '--no-smoke', '--no-certify', '--json'], { isTTY: true, confirm: noPath, ask: async () => (never += 1, 'a') });
  assert.equal(never, 0);
});

test('workers.json keeps everything else when a mode is recorded, and a file Jevris cannot read is left alone', async (t) => {
  const home = tempHome(t);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const file = join(config, 'workers.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { claude: 'api-key' }, harness: { xai: 'opencode' } }));
  assert.equal(await recordWorkerAuth(config, 'opencode', 'api-key'), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 'jevris-workers-1', auth: { claude: 'api-key', opencode: 'api-key' }, harness: { xai: 'opencode' } });
  for (const bad of ['not json', JSON.stringify({ schemaVersion: 'other' }), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: [] })]) {
    writeFileSync(file, bad);
    assert.equal(await recordWorkerAuth(config, 'kilo', 'subscription'), false);
    assert.equal(readFileSync(file, 'utf8'), bad, 'left byte for byte');
  }
});
