// Certify never makes macOS ask for a keychain (coordinator, 2026-09-26), and a record covers
// the version range its harness.json declares. Claude Code and Codex find their login keychain
// through HOME, so on macOS certify runs them with the account's HOME and their config folders
// in the throwaway profile. Stub CLIs and temp homes only; no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_HELP } from './harness-cli-stubs.mjs';

const { certifyEnv, certifyHarness, formatCertify, compatibilityRule } = await import('../dist/certification.js');
const { versionBound } = await import('../dist/harness-versions.js');
const { parseHarnessManifest } = await import('../dist/harness-manifest.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const HARNESSES = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'];

test('macOS: Claude Code keeps the account HOME and its config folder is in the profile; the others keep the temp HOME', () => {
  const base = { HOME: '/tmp/foreign', CLAUDE_CONFIG_DIR: '/Users/me/.claude', CODEX_HOME: '/Users/me/.codex', PATH: '/bin' };
  const claude = certifyEnv('claude', '/tmp/p', base, 'darwin', '/Users/me');
  assert.equal(claude.env.HOME, '/Users/me');
  assert.equal(claude.env.CLAUDE_CONFIG_DIR, join('/tmp/p', '.claude'), 'never the real ~/.claude');
  assert.equal(claude.env.CODEX_HOME, join('/tmp/p', '.codex'));
  assert.equal(claude.harnessHome, '/Users/me');
  // Codex reads its marketplace from $HOME/.agents: the account HOME would show it the user's plugins.
  for (const harness of ['codex', 'kilocode', 'opencode', 'antigravity']) {
    const other = certifyEnv(harness, '/tmp/p', base, 'darwin', '/Users/me');
    assert.equal(other.env.HOME, '/tmp/p', `${harness} keeps the temp HOME`);
    assert.equal(other.env.CODEX_HOME, join('/tmp/p', '.codex'), 'never the real ~/.codex');
    assert.equal(Object.hasOwn(other.env, 'CLAUDE_CONFIG_DIR'), false);
    assert.equal(other.harnessHome, null);
  }
  for (const platform of ['linux', 'win32']) {
    const other = certifyEnv('claude', '/tmp/p', base, platform, '/home/me');
    assert.equal(other.env.HOME, '/tmp/p', `${platform} has no login keychain found through HOME`);
    assert.equal(other.env.CLAUDE_CONFIG_DIR, join('/tmp/p', '.claude'), 'the config folder is named on every OS');
    assert.equal(other.harnessHome, null);
  }
  assert.equal(certifyEnv('claude', '/tmp/p', base, 'darwin', null).env.HOME, '/tmp/p', 'no account home known: the temp HOME');
});

test('certify claude runs every harness call with the config folder in the profile; on macOS with the account HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-certify-env-'));
  try {
    const calls = [];
    const cli = {
      available: (file) => file === 'claude',
      run: async (file, args, _timeout, env) => {
        calls.push({ args: [...args], home: env?.HOME, config: env?.CLAUDE_CONFIG_DIR });
        const line = args.join(' ');
        if (line === '--version') return { spawned: true, code: 0, stdout: '2.1.283 (Claude Code)\n' };
        if (line === '--help') return { spawned: true, code: 0, stdout: WORKER_HELP.claude };
        if (line.startsWith('plugin validate')) return { spawned: true, code: 0, stdout: '✔ Validation passed\n' };
        if (line === 'plugin list --json') return { spawned: true, code: 0, stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
        if (line.startsWith('plugin details')) return { spawned: true, code: 0, stdout: 'Skills: status, plan, route, checkpoint, recover, verify, explain, configure, guide\n' };
        return { spawned: true, code: 0, stdout: '' };
      },
    };
    const result = await certifyHarness({ home, harness: 'claude', json: false, root, cli, policies: [] });
    assert.equal(result.ok, true, formatCertify(result));
    assert.ok(calls.length > 3);
    const account = userInfo().homedir;
    for (const call of calls) {
      assert.equal(typeof call.config, 'string', `${call.args.join(' ')} ran without CLAUDE_CONFIG_DIR`);
      assert.match(call.config, /jevris-certify-claude-[^/\\]+[/\\]\.claude$/, 'the config folder is in the throwaway profile');
      if (process.platform === 'darwin') assert.equal(call.home, account, `${call.args.join(' ')}: the account HOME, so no keychain dialog`);
      else assert.notEqual(call.home, account);
    }
    // The record covers the range plugins/claude/harness.json declares (same-minor).
    const record = JSON.parse(await readFile(result.record, 'utf8'));
    assert.deepEqual(record.harnessVersionRange, { minimum: '2.1.283', maximumExclusive: '2.2.0' });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('the installer runs a harness under another HOME only when it is the account home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-harness-home-'));
  try {
    const { installGlobal } = await import('../dist/global-harness.js');
    const seen = [];
    const cli = { available: () => true, run: async (_file, _args, _timeout, env) => (seen.push(env?.HOME), { spawned: true, code: 0, stdout: '' }) };
    await installGlobal({ home, root, harness: 'claude', cli, env: { PATH: '' }, smoke: false, harnessHome: join(home, 'elsewhere') });
    assert.ok(seen.length > 0);
    assert.equal(seen.every((value) => value === home), true, 'a harnessHome that is not the account home is ignored');
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('each harness.json declares its compatibility rule with a basis; the bound follows the rule', async () => {
  for (const harness of HARNESSES) {
    const manifest = parseHarnessManifest(await readFile(join(root, 'plugins', harness, 'harness.json'), 'utf8'), harness).manifest;
    assert.notEqual(manifest, null, harness);
    assert.equal(manifest.compatibility.rule, 'same-minor', harness);
    assert.ok(manifest.compatibility.basis.length > 40, harness);
    assert.equal(await compatibilityRule(root, harness), 'same-minor');
  }
  assert.equal(versionBound('2.1.283', 'same-minor'), '2.2.0');
  assert.equal(versionBound('0.157.1', 'same-minor'), '0.158.0');
  assert.equal(versionBound('7.7.9', 'same-major'), '8.0.0');
  assert.equal(versionBound('1.18.32', 'exact'), '1.18.33');
  assert.equal(parseHarnessManifest(JSON.stringify({ ...JSON.parse(await readFile(join(root, 'plugins', 'claude', 'harness.json'), 'utf8')), compatibility: { rule: 'forever', basis: 'x' } }), 'claude').problem, 'compatibility');
});

// install, certify --harness all (five harnesses) and doctor in one test: about 40 s on a loaded
// host, and past the runner's 120 s default in a loaded Linux cell, so it gets 10 minutes.
test('pack smoke path: with the certifiable stand-ins first on PATH and JEVRIS_LIVE_HARNESS=1, certify --harness all certifies all five, and doctor then reads full', { timeout: 600_000, skip: process.platform === 'win32' ? 'POSIX PATH and shell stubs; the .cmd form is written for Windows but not run here' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-certify-all-'));
  const saved = { PATH: process.env.PATH, LIVE: process.env.JEVRIS_LIVE_HARNESS };
  try {
    const { writeCertifiableHarnessStubs } = await import('./harness-cli-stubs.mjs');
    const bin = await writeCertifiableHarnessStubs(join(dir, 'bin'));
    const home = join(dir, 'home');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(home);
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.JEVRIS_LIVE_HARNESS = '1';
    const { main } = await import('../dist/cli.js');
    let installed = '';
    assert.equal(await main(['install', '--yes', '--home', home], (chunk) => (installed += chunk)), 0, installed);
    // G1: the first install writes Antigravity's hooks disabled, certifies them, then re-renders
    // them enabled in the same run.
    assert.match(installed, /^antigravity hooks: enabled \(certified in this run\)$/m);
    const agyHooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'plugins', 'jevris', 'hooks.json'), 'utf8'));
    assert.equal(agyHooks['jevris-observe'].enabled, true, 'the hooks are on after the first install');
    let text = '';
    const code = await main(['certify', '--harness', 'all', '--home', home, '--json'], (chunk) => (text += chunk));
    const out = JSON.parse(text);
    assert.equal(code, 0, JSON.stringify(out.results.map((item) => ({ harness: item.harness, ok: item.ok, error: item.error, failed: item.features.filter((f) => !f.passed) })), null, 1));
    assert.deepEqual(out.results.map((item) => item.harness).sort(), ['antigravity', 'claude', 'codex', 'kilocode', 'opencode']);
    // models.list (DOMAINS 3f090fa): each stand-in's listing parses and writes nothing in the profile.
    const listing = Object.fromEntries(out.results.map((item) => [item.harness, item.features.find((f) => f.featureId === 'models.list')?.passed ?? null]));
    assert.deepEqual(listing, { antigravity: true, claude: true, codex: true, kilocode: true, opencode: true }, JSON.stringify(out.results.map((item) => item.features.find((f) => f.featureId === 'models.list')?.detail ?? null)));
    let doctor = '';
    await main(['doctor', '--home', home, '--json'], (chunk) => (doctor += chunk));
    const report = JSON.parse(doctor);
    const models = report.lines.map((line) => line.text).filter((line) => / models: /.test(line)).sort();
    assert.deepEqual(models, [
      'harness antigravity models: lists its models (refreshed by the sidecar while idle, no model call)',
      'harness claude models: lists its models (refreshed by the sidecar while idle, no model call)',
      'harness codex models: lists its models (refreshed by the sidecar while idle, no model call)',
      'harness kilocode models: lists its models (refreshed by the sidecar while idle, no model call)',
      'harness opencode models: lists its models (refreshed by the sidecar while idle, no model call)',
    ]);
    assert.deepEqual(report.summary, { installStatus: 'full', harnessProbe: 'certified', eventProbe: 'passed' }, JSON.stringify(report.lines.filter((line) => line.severity === 'action' || line.severity === 'broken'), null, 1));
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.LIVE === undefined) delete process.env.JEVRIS_LIVE_HARNESS;
    else process.env.JEVRIS_LIVE_HARNESS = saved.LIVE;
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
