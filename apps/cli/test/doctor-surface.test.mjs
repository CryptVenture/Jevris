// The doctor after install and certification (coordinator's doctor list, 2026-09-26): ✓ for
// what works, i for by-design limits, ! or ✗ only for real problems, each with the one command
// that fixes it. Stub harness CLIs and temp homes only; no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_HELP } from './harness-cli-stubs.mjs';

const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { runDoctorCommand, OLDER_INSTALL } = await import('../dist/doctor-cli.js');
const { certifyHarness, formatCertify } = await import('../dist/certification.js');
const { main } = await import('../dist/cli.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-doctor-surface-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

/** A Claude Code stand-in that answers what install, certify and doctor ask. */
function claudeStub(version = '2.1.282') {
  return {
    available: (file) => file === 'claude',
    run: async (_file, args) => {
      const line = args.join(' ');
      if (line === '--version') return { spawned: true, code: 0, stdout: `${version} (Claude Code)\n` };
      if (line === '--help') return { spawned: true, code: 0, stdout: WORKER_HELP.claude };
      if (line.startsWith('plugin validate')) return { spawned: true, code: 0, stdout: '✔ Validation passed\n' };
      if (line === 'plugin list --json') return { spawned: true, code: 0, stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      if (line.startsWith('plugin details')) return { spawned: true, code: 0, stdout: 'Skills: status, plan, route, checkpoint, recover, verify, explain, configure\n' };
      return { spawned: true, code: 0, stdout: '' };
    },
  };
}

async function doctor(home, cli, json = false, env = undefined) {
  let out = '';
  await runDoctorCommand({ home, json, values: {}, root, cli, policies: [], ...(env === undefined ? {} : { env }) }, (chunk) => (out += chunk));
  return out;
}

async function install(home, harness) {
  let out = '';
  const code = await main(['install', '--yes', '--home', home, '--harness', harness], (chunk) => (out += chunk));
  assert.equal(code, 0, out);
}

test('severity: works is ok, a by-design limit is info, a fixable problem is action, damage is broken', () => {
  const cases = [
    ['harnessProbe: certified (every installed harness is certified for its version range: claude >=2.1.282 <2.2.0)', 'ok'],
    ['harnessProbe: installation-only (no signed record covers claude 2.1.282 on this host yet; fix: jevris certify --harness all)', 'action'],
    ['eventProbe: passed (certification delivered a live hook event through each installed harness)', 'ok'],
    ['eventProbe: did-not-pass (no live hook event has been checked on this host yet; fix: jevris certify --harness all)', 'action'],
    ['installStatus: full (every installed harness is certified for its version range and passed its smoke)', 'ok'],
    ['installStatus: reduced (hooks observe and advise, and actuation waits (installed by an older Jevris: claude); fix: jevris install)', 'action'],
    ['egressDecision: deny', 'info'],
    ['actuator pretooluse-deny: unsupported', 'info'],
    ['actuator codex.adapter: certified', 'ok'],
    ['A timed-out command PreToolUse can let the tool proceed.', null],
    ['worker.route is not certified: no signed record covers an owned worker here; fix: jevris certify --harness all (no model call)', null],
    ['harness claude worker: certified, pending first use (the first owned run checks its init before any tool runs)', 'ok'],
    ['harness claude worker: verified in use (3 runs at 2.1.283)', 'ok'],
    ["harness claude worker: demoted: an owned run's first-use check failed; re-checking in the background, no model call", 'info'],
    ["harness claude worker: demoted: an owned run's first-use check failed; fix: jevris certify --harness claude", 'action'],
    ['harness claude worker: not certified yet: the record for 2.1.283 predates owned-worker certification; fix: jevris certify --harness claude', 'action'],
    ['verification: unsupported', 'info'],
    ['sidecar: idle; kill switch clear. The Jevris sidecar is idle. It starts on demand when a hook or command needs it, and stops again when idle.', 'info'],
    ['sidecar: not-running (degraded); kill switch clear. The Jevris sidecar is not running.', 'action'],
    ['sidecar: not-running; kill switch clear. The Jevris sidecar is not running, and autostart is off (JEVRIS_SIDECAR_AUTOSTART=0).', 'info'],
    ['sidecar: running; pid 1, version 1.2.0, up 3 s, endpoint x; store ok; kill switch clear', 'ok'],
    ['harness claude: installed; version 2.1.282; certification records: 1; certified for >=2.1.282 <2.2.0 (last verified 2.1.282, 2026-09-26): hooks.observe', 'ok'],
    ['harness codex: installed; version 0.157.1; certification records: 0; not certified: no signed record covers this version on this host; fix: jevris certify --harness codex', 'action'],
    ['harness opencode: not installed; version not found; certification records: 0; not found on this host', 'info'],
    [`harness claude install: ${OLDER_INSTALL}`, 'action'],
    ['harness claude mcp handshake: ok (initialize and tools/list)', 'ok'],
    ['harness claude hook fixture: failed (no answer)', 'broken'],
    ['harness codex parity: not available in codex, by design: statusLine (Codex has no plugin status line; run jevris status.)', 'info'],
    ['harness codex hookTrust: Codex keeps its /hooks trust decisions to itself, so doctor cannot read them; run /hooks in Codex to review and trust the Jevris hooks.', 'action'],
    ['harness kilo auth: unknown (not detected, and not stated); state it in /h/.config/jevris/workers.json (subscription or api-key)', 'action'],
    ['harness claude auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)', 'ok'],
    ['harness claude auth: api-key (stated in workers.json; not detected); api-key mode needs ANTHROPIC_API_KEY in the environment', 'action'],
    ['harness claude auth: subscription (auto: no vendor key in the environment; not probed: test run)', 'info'],
    ['privateFiles: ok', 'ok'],
    ['privateFiles: 2 Jevris entries are readable by other users (.jevris 0755, .jevris/x 0644); fix: jevris install (it makes them owner-only)', 'action'],
    ['nativeAddon better-sqlite3: unavailable (ABI)', 'broken'],
    ['legacyLayout: none', 'ok'],
  ];
  for (const [line, severity] of cases) assert.equal(doctorLineSeverity(line), severity, line);
});

test('a home installed by an older Jevris says so with the fix; jevris install upgrades it in place and the handshake passes', async (t) => {
  const home = tempHome(t);
  const data = jevrisPaths({ home }).data;
  mkdirSync(join(home, '.claude', 'skills', 'jevris'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'jevris', 'SKILL.md'), '---\nname: jevris\ndescription: old\n---\n');
  mkdirSync(data, { recursive: true });
  // The receipt a 1.2 pre-release wrote: no runtime copy.
  writeFileSync(join(data, 'install-receipt.json'), JSON.stringify({ schemaVersion: '1.0', pluginId: 'jevris@skills-dir', ownedPaths: [join(home, '.claude', 'skills', 'jevris')] }));
  const before = await doctor(home, claudeStub());
  assert.match(before, /^harness claude install: installed by an older Jevris; run `jevris install` to upgrade$/m);
  assert.equal(/receipt names no runtime copy/.test(before), false);
  assert.match(before, /^installStatus: reduced \(.*installed by an older Jevris: claude.*; fix: jevris install/m);
  await install(home, 'claude');
  const after = await doctor(home, claudeStub());
  assert.equal(/installed by an older Jevris/.test(after), false, after);
  assert.match(after, /^harness claude mcp handshake: ok /m);
  assert.match(after, /^harness claude hook fixture: ok /m);
});

test('after install and certify, the top block is full, certified and passed, and no line asks for anything', async (t) => {
  const home = tempHome(t);
  await install(home, 'claude');
  const before = JSON.parse(await doctor(home, claudeStub(), true));
  assert.deepEqual(before.summary, { installStatus: 'reduced', harnessProbe: before.report.harnessProbe.health, eventProbe: 'did-not-pass' });
  assert.equal(before.report.harnessProbe.actuators, 'unsupported', 'a probe alone certifies no actuator');
  const probe = before.lines.find((line) => line.text.startsWith('harnessProbe: '));
  assert.equal(probe.severity, 'action');
  assert.match(before.lines.find((line) => line.text.startsWith('installStatus: ')).text, /no signed record for this version here: claude 2\.1\.282\); fix: jevris certify --harness all\)$/);

  const result = await certifyHarness({ home, harness: 'claude', json: false, root, cli: claudeStub(), listModels: async () => ({ ok: true, models: ['claude-opus-5-5'] }), policies: [] });
  assert.equal(result.ok, true, formatCertify(result));

  // The jevris command install wrote, with its folder first on this (fake) PATH.
  const commandDir = process.platform === 'win32' ? join(realpathSync(jevrisPaths({ home }).data), 'bin') : join(realpathSync(home), '.local', 'bin');
  const onPath = { PATH: `${commandDir}${delimiter}${process.env.PATH ?? ''}`, PATHEXT: process.env.PATHEXT };
  const after = JSON.parse(await doctor(home, claudeStub(), true, onPath));
  assert.equal(after.lines.find((line) => line.text.startsWith('jevris command: ')).severity, 'ok');
  assert.deepEqual(after.summary, { installStatus: 'full', harnessProbe: 'certified', eventProbe: 'passed' });
  assert.equal(after.report.installStatus, 'full');
  // Raised with health from the same records, so it never reads "unsupported" beside certified actuators.
  assert.equal(after.report.harnessProbe.actuators, 'certified');
  assert.equal(after.report.actuators.find((row) => row.id === 'claude.adapter').status, 'certified');
  assert.match(after.lines.find((line) => line.text.startsWith('harnessProbe: ')).text, /^harnessProbe: certified \(every installed harness is certified for its version range: claude >=2\.1\.282 <2\.2\.0\)$/);
  assert.equal(after.lines.some((line) => /certified on this host/.test(line.text)), false, 'certified always names its range');
  const problems = after.lines.filter((line) => line.severity === 'action' || line.severity === 'broken');
  // The sidecar is started on demand in real use; a test home has none, which doctor may report.
  assert.deepEqual(problems.filter((line) => !line.text.startsWith('sidecar: ')), [], JSON.stringify(problems, null, 1));
  assert.deepEqual(after.privateFiles, { loose: [] });
  const text = await doctor(home, claudeStub());
  assert.match(text, /^harnessProbe: certified \(/m);
  assert.match(text, /^eventProbe: passed \(/m);
  assert.match(text, /^installStatus: full \(/m);
  assert.match(text, /^harness claude: installed; version 2\.1\.282; certification records: 1; certified for >=2\.1\.282 <2\.2\.0 \(last verified 2\.1\.282, \d{4}-\d{2}-\d{2}\): /m);
  assert.match(text, /^harness claude parity: not available in claude, by design: statusLine \(/m);
});

test('the Windows launcher row shows only on Windows; the Antigravity row is antigravity.adapter', async (t) => {
  const home = tempHome(t);
  const mac = JSON.parse(await doctor(home, claudeStub(), true));
  const ids = mac.report.actuators.map((row) => row.id);
  assert.equal(ids.includes('windows-launcher'), process.platform === 'win32');
  assert.equal(ids.includes('antigravity.adapter'), true);
  assert.equal(ids.includes('gemini.adapter'), false);
  let win = '';
  await runDoctorCommand({ home, json: true, values: { platform: 'win32' }, root, cli: claudeStub(), policies: [] }, (chunk) => (win += chunk));
  assert.equal(JSON.parse(win).report.actuators.some((row) => row.id === 'windows-launcher'), true);
});

test('Kilo and OpenCode auth is unknown until stated, never assumed; stating it in workers.json settles it', async (t) => {
  const home = tempHome(t);
  const cli = { available: (file) => file === 'kilo', run: async (_file, args) => ({ spawned: true, code: 0, stdout: args.join(' ') === '--version' ? '7.7.9\n' : '' }) };
  const text = await doctor(home, cli);
  const workers = join(jevrisPaths({ home }).config, 'workers.json');
  const line = text.split('\n').find((item) => item.startsWith('harness kilo auth: '));
  assert.equal(line, `harness kilo auth: unknown (not detected, and not stated); state it in ${workers} (subscription or api-key), for example {"schemaVersion":"jevris-workers-1","auth":{"kilo":"subscription"}}`);
  assert.equal(doctorLineSeverity(line), 'action');
  assert.equal(/^harness opencode auth: /m.test(text), false, 'a harness not on this machine has no auth line');
  mkdirSync(jevrisPaths({ home }).config, { recursive: true });
  writeFileSync(workers, JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { kilo: 'subscription' } }));
  const stated = await doctor(home, cli);
  const settled = stated.split('\n').find((item) => item.startsWith('harness kilo auth: '));
  assert.equal(settled, 'harness kilo auth: subscription (stated in workers.json; not probed: test run)');
  assert.equal(doctorLineSeverity(settled), 'ok');
});

test('Codex hook trust is its own action line; the other Codex limits are information', async (t) => {
  const home = tempHome(t);
  mkdirSync(jevrisPaths({ home }).data, { recursive: true });
  // Installed (a receipt), so its trust line applies.
  writeFileSync(join(jevrisPaths({ home }).data, 'codex-install-receipt.json'), JSON.stringify({ schemaVersion: '1.0', pluginId: 'jevris@codex', ownedPaths: [] }));
  const text = await doctor(home, { available: () => false, run: async () => ({ spawned: false, code: 1, stdout: '' }) });
  assert.match(text, /^harness codex parity: not available in codex, by design: statusLine \(.*\); PermissionRequest \(/m);
  const trust = text.split('\n').find((line) => line.startsWith('harness codex hookTrust: '));
  assert.match(trust, /run \/hooks in Codex/);
  assert.equal(doctorLineSeverity(trust), 'action');
});

test('every keyed doctor line has a severity; only the lines that continue the one above have none (E)', async (t) => {
  const home = tempHome(t);
  await install(home, 'claude');
  const out = JSON.parse(await doctor(home, claudeStub(), true));
  const continuation = new Set([...out.report.actuators.map((row) => row.reason), out.report.verificationReason, out.report.sameUserLimit, 'UI localhost is not the worker.']);
  const unkeyed = out.lines.filter((line) => line.severity === null).map((line) => line.text);
  assert.deepEqual(unkeyed.filter((text) => !continuation.has(text)), [], 'a keyed line without a severity');
  assert.ok(out.lines.length > 20);
});
