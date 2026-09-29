// HCF-02, SKL-03, KIL-01: `jevris certify` with a stand-in harness CLI. The install, the MCP
// and hook smoke and the conformance cases run for real against the built runtime in a temp
// profile; only the harness binary is simulated (npm test never starts one). Temp homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_HELP } from './harness-cli-stubs.mjs';

// An email-shaped value built at run time on a reserved domain, so no address sits in this file.
const ADDRESS = ['someone', 'example.invalid'].join('@');
const { certifyHarness, formatCertify, runCertifyCommand, liveFeatureChecks, isolatedEnv } = await import('../dist/certification.js');
const { loadCertifications, coveringCertification } = await import('@jevris/cli/certifications');
const { runDoctorCommand } = await import('../dist/doctor-cli.js');
const { loadEvidence } = await import('../dist/gate-records.js');
const { evidenceCommit } = await import('../dist/certification.js');
const { PUBLIC_COMMAND_NAMES } = await import('../../../packages/contracts/dist/index.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-certify-test-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** A harness CLI stand-in: answers by argv, records every call and the HOME it ran with. */
function stub(harness, answers) {
  const calls = [];
  return {
    calls,
    cli: {
      available: (file) => file === harness,
      run: async (file, args, _timeout, env) => {
        calls.push({ file, args: [...args], home: env?.HOME });
        if (args.at(-1) === '--help') return { spawned: true, code: 0, stdout: WORKER_HELP[file] ?? '' };
        const answer = answers(args.join(' '));
        return { spawned: true, code: answer.code ?? 0, stdout: answer.stdout ?? '' };
      },
    },
  };
}

const allSkills = JSON.stringify([{ name: 'kilo-config', location: 'builtin' }, ...PUBLIC_COMMAND_NAMES.map((name) => ({ name: `jevris-${name}`, location: `/p/jevris-${name}/SKILL.md` }))]);

test('certify claude: validates the marketplace, sees the installed plugin and its skills, signs a local record that covers the version', async () => {
  await withHome(async (home) => {
    const fake = stub('claude', (line) => {
      if (line === '--version') return { stdout: '2.1.282 (Claude Code)\n' };
      if (line.startsWith('plugin validate')) return { stdout: '✔ Validation passed\n' };
      if (line === 'plugin list --json') return { stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      if (line.startsWith('plugin details')) return { stdout: 'Skills: status, plan, route, checkpoint, recover, verify, explain, configure\n' };
      return {};
    });
    const evidence = join(home, 'evidence');
    const result = await certifyHarness({ home, harness: 'claude', json: false, root, cli: fake.cli, evidence, listModels: async () => ({ ok: true, models: ['claude-opus-5-5'] }), policies: [] });
    assert.equal(result.error, null, formatCertify(result));
    assert.equal(result.ok, true);
    assert.equal(result.harnessVersion, '2.1.282');
    const validate = fake.calls.find((call) => call.args[0] === 'plugin' && call.args[1] === 'validate');
    assert.match(validate.args[2], /[\\/]\.claude[\\/]plugins[\\/]jevris-local$/, 'the marketplace folder is validated');
    assert.ok(fake.calls.some((call) => call.args.join(' ') === 'plugin install jevris@jevris-local'), 'install ran claude plugin install in the profile');
    assert.ok(fake.calls.every((call) => call.home !== home && typeof call.home === 'string'), 'every harness call ran in the temp profile, not the home');
    const features = Object.fromEntries(result.features.map((item) => [item.featureId, item.passed]));
    // The stand-in binary never reaches the stub, so the access cases fail; both features are optional (R69).
    assert.deepEqual(features, { 'plugin.install': true, 'mcp.tools': true, 'skills.discovery': true, 'hooks.observe': true, 'hooks.context': true, 'hooks.route': true, 'worker.route': true, 'models.list': true, 'access.detect': false, 'access.session': false });
    assert.deepEqual(['access.detect', 'access.session'].map((id) => result.features.find((item) => item.featureId === id).reasonCode), ['ACCESS_DETECT_CASE_FAILED', 'ACCESS_SESSION_CASE_FAILED']);
    assert.equal(result.evidence.length, 2);
    for (const file of result.evidence) assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion !== undefined, true);
    const conformance = (await Promise.all(result.evidence.map(async (file) => JSON.parse(await readFile(file, 'utf8'))))).find((item) => item.kind === 'harness-conformance');
    assert.deepEqual(conformance.payload.workerCases.map((item) => [item.passed, item.reasonCode]), Array.from({ length: 9 }, () => [true, null]), 'the worker port cases go to the release evidence (A cf23be8)');
    assert.deepEqual(conformance.payload.listing, { reasonCode: null, touched: [] }, "models.list's reason and the paths its checked run touched go to the evidence");
    assert.ok(result.stubCases.length > 0);
    assert.deepEqual(conformance.payload.stubCases, result.stubCases.map(({ id, passed, reasonCode }) => ({ id, passed, reasonCode })), "each stub case's id, pass and reason code go to the evidence, never its detail");
    // What certify writes passes the validator `jevris gates` reads it with (A: INVALID_PATTERN at /producer/tool).
    const loaded = await loadEvidence(evidence);
    assert.deepEqual(loaded.rejected, []);
    assert.deepEqual(loaded.accepted.map((item) => item.record.kind).sort(), ['certification-record', 'harness-conformance']);
    assert.ok(loaded.accepted.every((item) => item.record.producer.tool === 'jevris-certify'));
    const load = await loadCertifications(home, { root });
    assert.equal(load.records.length, 1);
    assert.equal(load.records[0].trust, 'local');
    const context = { harness: 'claude', harnessVersion: '2.1.290', operatingSystem: load.records[0].record.operatingSystems[0], nowMs: Date.now(), featureId: 'hooks.observe' };
    assert.notEqual(coveringCertification(load, context).covered, null);
    assert.equal(coveringCertification(load, { ...context, harnessVersion: '2.2.0' }).reasonCode, 'VERSION_OUT_OF_RANGE');
    assert.match(formatCertify(result), /certified/);

    // doctor names what the record covers on this host, and says plainly when nothing does.
    let text = '';
    await runDoctorCommand({ home, json: false, values: {}, root, cli: fake.cli, policies: [] }, (chunk) => (text += chunk));
    const claudeLine = text.split('\n').find((line) => line.startsWith('harness claude:'));
    // The record covers a version range, and doctor names it with the version it last verified.
    assert.match(claudeLine, /certified for >=2\.1\.282 <2\.2\.0 \(last verified 2\.1\.282, \d{4}-\d{2}-\d{2}\): plugin\.install, mcp\.tools, skills\.discovery, hooks\.observe, hooks\.context, hooks\.route, worker\.route, models\.list; optional, not certified here: access\.detect \(ACCESS_DETECT_CASE_FAILED\), access\.session \(ACCESS_SESSION_CASE_FAILED\)$/, 'the optional access features are named with no fix');
    const codexLine = text.split('\n').find((line) => line.startsWith('harness codex:'));
    assert.match(codexLine, /; not found on this host$/);
    // Claude Code has its adapter row too, derived from the same record and naming its range.
    assert.equal(text.split('\n').includes('actuator claude.adapter: certified'), true, text);
    assert.match(text, /\nclaude 2\.1\.282 is certified for >=2\.1\.282 <2\.2\.0 \([^)]*claude-[a-z0-9]+\.json\); observe hooks run/);
    let json = '';
    await runDoctorCommand({ home, json: true, harness: 'claude', values: { platform: 'plan9' }, root, cli: fake.cli }, (chunk) => (json += chunk));
    const row = JSON.parse(json).harnesses[0];
    assert.deepEqual(row.certifiedFeatures, [], 'a record for another OS covers nothing here');
    assert.equal(row.certifyCommand, 'jevris certify --harness claude');
    assert.deepEqual(row.unsupported.map((item) => item.feature), ['statusLine', 'subagents'], 'the parity row comes from plugins/claude/harness.json');
    // Every harness prints its parity line: by-design limits, each with its reason.
    const parity = text.split('\n').filter((line) => / parity: not available in [a-z]+, by design: /.test(line));
    assert.equal(parity.length, 5);
    assert.match(text, /harness kilocode parity: not available in kilocode, by design: statusLine \(/);
    assert.equal(/D-F4/.test(text), false, 'Kilo and OpenCode route subagents now (R20); hooks.route is no longer a by-design limit');
    assert.match(text, /harness antigravity parity: not available in antigravity, by design: PreToolUse \(Antigravity's PreToolUse allow would auto-approve/);
    assert.equal(/hookTrust \(/.test(text), false, 'Codex hook trust is its own line, not a by-design limit');
  });
});

test('certify claude: skills.discovery needs every skill named in plugin details, not just "status" (G17)', async () => {
  await withHome(async (home) => {
    const fake = stub('claude', (line) => {
      if (line === '--version') return { stdout: '2.1.282 (Claude Code)\n' };
      if (line.startsWith('plugin validate')) return { stdout: '✔ Validation passed\n' };
      if (line === 'plugin list --json') return { stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      if (line.startsWith('plugin details')) return { stdout: 'Component inventory\n  Skills: status, planner, route-map\n' };
      return {};
    });
    const result = await certifyHarness({ home, harness: 'claude', json: false, root, cli: fake.cli, policies: [] });
    const skills = result.features.find((item) => item.featureId === 'skills.discovery');
    assert.equal(skills.passed, false);
    assert.match(skills.detail, /missing plan, route, checkpoint, recover, verify, explain, configure$/, 'a longer word is not the skill');
  });
});

test('certify antigravity: the throwaway profile gets the hook group enabled, so the hooks it certifies are live there (G17)', async () => {
  await withHome(async (home) => {
    const seen = [];
    const cli = {
      available: (file) => file === 'agy',
      run: async (file, args, _timeout, env) => {
        if (args.at(-1) === '--help') return { spawned: true, code: 0, stdout: WORKER_HELP[file] ?? '' };
        const line = args.join(' ');
        if (line === '--version') return { spawned: true, code: 0, stdout: '1.4.2\n' };
        if (line.startsWith('plugin list')) {
          const text = await readFile(join(env.HOME, '.gemini', 'config', 'plugins', 'jevris', 'hooks.json'), 'utf8').catch(() => null);
          seen.push({ profile: env.HOME, hooks: text === null ? null : JSON.parse(text) });
          return { spawned: true, code: 0, stdout: 'jevris (installed)\n' };
        }
        return { spawned: true, code: 0, stdout: '' };
      },
    };
    await certifyHarness({ home, harness: 'antigravity', json: false, root, cli, policies: [] });
    assert.equal(seen.length > 0, true, 'plugin list ran in the profile');
    assert.notEqual(seen[0].profile, home, 'never the home');
    assert.equal(seen[0].hooks?.['jevris-observe']?.enabled, true, JSON.stringify(seen[0].hooks));
  });
});

test('certify kilo: all 8 jevris-* skills once each and a connected MCP are required; a missing serve leaves plugin.install unsupported', async () => {
  await withHome(async (home) => {
    const partial = JSON.stringify(PUBLIC_COMMAND_NAMES.slice(1).map((name) => ({ name: `jevris-${name}` })).concat([{ name: 'status' }]));
    const fake = stub('kilo', (line) => {
      if (line === '--version') return { stdout: '7.7.9\n' };
      if (line === 'mcp list') return { stdout: '●  ✓ jevris \u001b[90mconnected\n' };
      if (line === 'debug info') return { stdout: 'plugins:\n- file:///p/.config/kilo/plugin/jevris.js\n' };
      if (line === 'debug skill') return { stdout: partial };
      return {};
    });
    const result = await certifyHarness({ home, harness: 'kilocode', json: false, root, cli: fake.cli });
    assert.equal(result.ok, false);
    const byId = Object.fromEntries(result.features.map((item) => [item.featureId, item]));
    assert.equal(byId['mcp.tools'].passed, true, byId['mcp.tools'].detail);
    assert.equal(byId['skills.discovery'].passed, false);
    assert.match(byId['skills.discovery'].detail, /missing jevris-[a-z]+; unprefixed status/);
    assert.equal(byId['plugin.install'].passed, false, 'serve is never started in tests');
    assert.equal(byId['hooks.route'].passed, false, 'the hooks did not run, so the Kilo route is not certified');
    assert.equal(byId['session.route'].passed, false);
    assert.equal(byId['session.route'].reasonCode, 'HOOKS_NOT_RUNNING');
    assert.equal(byId['route.host'].reasonCode, 'ROUTE_HOST_NEEDS_SESSION_ROUTE', 'no host route without session.route');
    assert.equal(byId['models.list-hosts'].reasonCode, 'MODELS_LIST_HOSTS_FAILED', 'the K13 case ran against a stand-in that lists no host line');
    const record = JSON.parse(await readFile(result.record, 'utf8'));
    assert.deepEqual(record.features.find((item) => item.featureId === 'skills.discovery'), { featureId: 'skills.discovery', status: 'unsupported', reasonCode: 'SKILLS_NOT_DISCOVERED' });
    // ADM-08: the doctor's adapter rows come from the same records, never from a fixed string.
    let json = '';
    await runDoctorCommand({ home, json: true, values: {}, root, cli: fake.cli, policies: [] }, (chunk) => (json += chunk));
    const doctor = JSON.parse(json);
    const byRow = Object.fromEntries(doctor.report.actuators.map((row) => [row.id, row]));
    const observed = doctor.harnesses.find((row) => row.harness === 'kilocode').certifiedFeatures.includes('hooks.observe');
    assert.equal(byRow['kilocode.adapter'].status, observed ? 'certified' : 'unsupported');
    if (observed) assert.match(byRow['kilocode.adapter'].reason, /kilocode 7\.7\.9 is certified for >=7\.7\.9 <7\.8\.0 /);
    assert.equal(byRow['codex.adapter'].status, 'unsupported');
    assert.match(byRow['codex.adapter'].reason, /^codex: not found on this host\.$/);
    assert.match(byRow['antigravity.adapter'].reason, /^antigravity: /);
    assert.equal(Object.hasOwn(byRow, 'gemini.adapter'), false, 'the row is antigravity.adapter');
    assert.equal(JSON.stringify(doctor).includes('2.12.2'), false, 'no hard-coded harness version');
  });
});

test('live feature checks: a full kilo skill list passes, a duplicate or a missing JSON list fails', async () => {
  const install = { ok: true, smoke: [{ harness: 'kilocode', check: 'mcp', ok: true }, { harness: 'kilocode', check: 'hook', ok: true }] };
  const run = async (skills) => {
    const fake = stub('kilo', (line) => {
      if (line === 'debug skill') return skills;
      if (line === 'mcp list') return { stdout: 'jevris connected' };
      if (line === 'debug info') return { stdout: 'plugin/jevris.js' };
      return {};
    });
    const checks = await liveFeatureChecks({ harness: 'kilocode', cli: fake.cli, env: {}, profile: join(tmpdir(), 'jevris-no-profile'), install });
    return checks.find((item) => item.featureId === 'skills.discovery');
  };
  assert.equal((await run({ stdout: `log line\n${allSkills}` })).passed, true);
  const dup = JSON.parse(allSkills);
  dup.push({ name: 'jevris-status' });
  assert.match((await run({ stdout: JSON.stringify(dup) })).detail, /listed twice/);
  assert.match((await run({ stdout: 'no json here' })).detail, /not a JSON list/);
  assert.match((await run({ stdout: '{"a":1}' })).detail, /not a JSON list/);
  assert.match((await run({ code: 3 })).detail, /exit 3/);
});

test('certify refuses to start a real harness under npm test and says why; the command exits 1', async () => {
  await withHome(async (home) => {
    const result = await certifyHarness({ home, harness: 'opencode', json: false, root });
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled in a test run .* unless JEVRIS_LIVE_HARNESS=1 is set/);
    let text = '';
    const code = await runCertifyCommand({ home, harness: 'opencode', json: true, root }, (chunk) => (text += chunk));
    assert.equal(code, 1);
    assert.equal(JSON.parse(text).ok, false);
    const missing = await certifyHarness({ home, harness: 'codex', json: false, root, cli: { available: () => false, run: async () => ({ spawned: false, code: 1, stdout: '' }) } });
    assert.match(missing.error, /codex is not on PATH/);
    const noVersion = await certifyHarness({ home, harness: 'codex', json: false, root, cli: stub('codex', () => ({ stdout: 'no version' })).cli });
    assert.match(noVersion.error, /did not print a version/);
    const noManifest = await certifyHarness({ home, harness: 'codex', json: false, root: home, cli: stub('codex', () => ({ stdout: '0.50.0' })).cli });
    assert.match(noManifest.error, /no runtime manifest/);
  });
});

test('the temp profile inherits no variable that points a harness at another config', () => {
  const env = isolatedEnv('/tmp/profile', { PATH: '/bin', CLAUDE_CONFIG_DIR: '/Users/me/.claude', KILO_CONFIG_DIR: '/x', OPENCODE_CONFIG: '/y', HOME: '/Users/me' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/tmp/profile');
  for (const key of ['CLAUDE_CONFIG_DIR', 'KILO_CONFIG_DIR', 'OPENCODE_CONFIG']) assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(env.JEVRIS_HOOK_OBSERVE_ONLY, '1');
});

test('HCF-02: managed policy that stops hooks is reported by doctor and fails every hook feature in certify, never bypassed', async () => {
  const { managedHookPolicies, claudeManagedSettingsPaths, managedPolicyLine } = await import('../dist/managed-policy.js');
  const { applyManagedPolicy } = await import('../dist/certification.js');
  assert.deepEqual(claudeManagedSettingsPaths('darwin'), ['/Library/Application Support/ClaudeCode/managed-settings.json']);
  assert.deepEqual(claudeManagedSettingsPaths('linux'), ['/etc/claude-code/managed-settings.json']);
  assert.deepEqual(claudeManagedSettingsPaths('win32', { ProgramFiles: 'D:\\PF', ProgramData: 'D:\\PD' }), ['D:\\PF\\ClaudeCode\\managed-settings.json', 'D:\\PD\\ClaudeCode\\managed-settings.json']);
  const files = { '/etc/claude-code/managed-settings.json': '{"allowManagedHooksOnly": true, "disableAllHooks": false}' };
  const policies = await managedHookPolicies({ platform: 'linux', readText: async (path) => files[path] ?? null });
  assert.deepEqual(policies, [{ harness: 'claude', path: '/etc/claude-code/managed-settings.json', key: 'allowManagedHooksOnly' }]);
  assert.deepEqual(await managedHookPolicies({ platform: 'linux', readText: async () => 'not json' }), []);
  assert.deepEqual(await managedHookPolicies({ platform: 'linux', readText: async () => '{"disableAllHooks": "yes"}' }), [], 'only a literal true counts');
  assert.match(managedPolicyLine(policies[0]), /allows only managed hooks \(allowManagedHooksOnly\); the Jevris hooks will not run, and Jevris does not work around managed policy/);

  const features = [
    { featureId: 'plugin.install', passed: true, reasonCode: null, detail: 'ok' },
    { featureId: 'hooks.observe', passed: true, reasonCode: null, detail: 'ok' },
    { featureId: 'hooks.route', passed: true, reasonCode: null, detail: 'ok' },
  ];
  const blocked = applyManagedPolicy(features, policies);
  assert.deepEqual(blocked.map((item) => [item.featureId, item.passed, item.reasonCode]), [['plugin.install', true, null], ['hooks.observe', false, 'MANAGED_POLICY_BLOCKS_HOOKS'], ['hooks.route', false, 'MANAGED_POLICY_BLOCKS_HOOKS']]);
  assert.deepEqual(applyManagedPolicy(features, []), features);

  await withHome(async (home) => {
    let text = '';
    await runDoctorCommand({ home, json: false, values: {}, root, cli: { available: () => false, run: async () => ({ spawned: false, code: 1, stdout: '' }) }, policies }, (chunk) => (text += chunk));
    assert.ok(text.split('\n').some((line) => line.startsWith('harness claude policy: /etc/claude-code/managed-settings.json allows only managed hooks')));
    let json = '';
    await runDoctorCommand({ home, json: true, values: {}, root, cli: { available: () => false, run: async () => ({ spawned: false, code: 1, stdout: '' }) }, policies: [] }, (chunk) => (json += chunk));
    assert.deepEqual(JSON.parse(json).managedPolicies, []);
  });
});

test('certify --evidence is confined (GOV-11): a Jevris private directory or a linked directory is refused before the harness runs, exit 2, nothing written', async () => {
  const { mkdir, readdir, symlink } = await import('node:fs/promises');
  const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');
  await withHome(async (home) => {
    const fake = stub('claude', () => ({}));
    const privateDir = join(jevrisPaths({ home }).data, 'evidence-out');
    let text = '';
    const code = await runCertifyCommand({ home, harness: 'claude', json: false, root, cli: fake.cli, evidence: privateDir, policies: [], cwd: home }, (chunk) => (text += chunk));
    assert.equal(code, 2);
    assert.match(text, /--evidence refused \(OUTPUT_PRIVATE_DIR\)/);
    assert.equal(fake.calls.length, 0, 'the harness never ran');

    const real = join(home, 'real');
    await mkdir(real);
    await symlink(real, join(home, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await certifyHarness({ home, harness: 'claude', json: false, root, cli: fake.cli, evidence: join(home, 'linked', 'ev'), policies: [], cwd: home });
    assert.equal(linked.outputRefused, 'OUTPUT_SYMLINK');
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await readdir(real), [], 'nothing written through the link');
  });
});

test('in a test run, JEVRIS_LIVE_HARNESS=1 lets certify run the binary PATH names (a stub in the temp folder)', { skip: process.platform === 'win32' ? 'POSIX stub script' : false }, async () => {
  await withHome(async (home) => {
    const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const log = join(home, 'calls.log');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log('no version here');\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    const saved = { PATH: process.env.PATH, LIVE: process.env.JEVRIS_LIVE_HARNESS };
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.JEVRIS_LIVE_HARNESS = '1';
    try {
      const result = await certifyHarness({ home, harness: 'codex', json: false, root });
      assert.match(result.error ?? '', /did not print a version/, 'the stub ran through the default harness CLI');
      assert.match(await readFile(log, 'utf8'), /--version/);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.LIVE === undefined) delete process.env.JEVRIS_LIVE_HARNESS;
      else process.env.JEVRIS_LIVE_HARNESS = saved.LIVE;
    }
  });
});

test('certify evidence names the commit of a clean build only; a dirty build or one with no source claims none (A d449a54)', () => {
  const sha = 'b'.repeat(40);
  assert.equal(evidenceCommit({ source: { commit: sha, dirty: false } }), sha);
  assert.equal(evidenceCommit({ source: { commit: sha, dirty: true } }), null);
  assert.equal(evidenceCommit({ source: { commit: null, dirty: false } }), null);
  assert.equal(evidenceCommit({}), null);
});

test("the conformance evidence's listing row: profile-relative paths only, capped, unique, never contents (A's review)", async () => {
  const contracts = await import('../../../packages/contracts/dist/index.js');
  const { listingEvidence } = await import('../dist/certification.js');
  const payload = (listing) => ({
    harness: 'opencode',
    os: 'darwin',
    harnessVersion: '1.18.32',
    realBinary: true,
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    cases: contracts.CONFORMANCE_CASES.map((id) => ({ id, passed: true, reasonCode: null })),
    ...(listing === undefined ? {} : { listing }),
  });
  const valid = (listing) => contracts.ReleaseEvidenceContract.validate(contracts.releaseEvidence({ kind: 'harness-conformance', id: 'hc-1', producedAt: '2026-09-28T12:00:00Z', version: '1.2.0', commit: null, tool: 'jevris-certify', os: 'darwin', payload: payload(listing) })).ok;
  assert.equal(valid(undefined), true, 'a record without listing still validates');
  assert.equal(valid({ reasonCode: 'LISTING_SIDE_EFFECT', touched: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'] }), true);
  assert.equal(valid({ reasonCode: null, touched: [] }), true);
  for (const [label, listing] of [
    ['an absolute POSIX path', { reasonCode: null, touched: ['/Users/someone/.codex/x'] }],
    ['a Windows drive path', { reasonCode: null, touched: ['C:\\Users\\someone\\x'] }],
    ['a leading backslash', { reasonCode: null, touched: ['\\share\\x'] }],
    ['a home tilde', { reasonCode: null, touched: ['~/x'] }],
    ['a .. segment', { reasonCode: null, touched: ['a/../../etc/passwd'] }],
    ['a trailing .. segment', { reasonCode: null, touched: ['a/..'] }],
    ['a control character', { reasonCode: null, touched: ['a\u0001b'] }],
    ['65 entries', { reasonCode: null, touched: Array.from({ length: 65 }, (_, i) => `f${i}`) }],
    ['a 201-character path', { reasonCode: null, touched: ['a'.repeat(201)] }],
    ['a duplicate path', { reasonCode: null, touched: ['a/b', 'a/b'] }],
    ['a URL', { reasonCode: null, touched: ['https://example.invalid/x'] }],
    ['an email address', { reasonCode: null, touched: [`x/${ADDRESS}/y`] }],
    ['an email address as a whole path', { reasonCode: null, touched: [ADDRESS] }],
    ['an extra key', { reasonCode: null, touched: [], content: 'x' }],
    ['a bad reason code', { reasonCode: 'side effect', touched: [] }],
  ]) assert.equal(valid(listing), false, label);
  assert.equal(valid({ reasonCode: null, touched: ['a..b/c..'] }), true, 'two dots inside a name are not a .. segment');

  const check = (touched, passed = false, reasonCode = 'LISTING_SIDE_EFFECT') => listingEvidence({ passed, reasonCode, detail: 'x', touched });
  assert.deepEqual(check(['.codex/logs_2.sqlite', '.codex/.tmp/git-1/HEAD']), { reasonCode: 'LISTING_SIDE_EFFECT', touched: ['.codex/logs_2.sqlite', '.codex/.tmp/git-1/HEAD'] });
  assert.deepEqual(check(['a'], true, null), { reasonCode: null, touched: ['a'] });
  assert.equal(check([], false, 'odd reason').reasonCode, 'LISTING_FAILED');
  const withheld = check(['/abs/path', `x/${ADDRESS}/y`, 'x/https://h/y', 'ok/path', '../up']);
  assert.deepEqual(withheld.touched, ['[path withheld]', 'ok/path'], 'each unsafe path is withheld, once');
  const many = check(Array.from({ length: 100 }, (_, i) => `f${i}/${'n'.repeat(300)}`));
  assert.equal(many.touched.length, 64);
  assert.ok(many.touched.every((path) => path.length <= 200));
  for (const listing of [withheld, many, check(['a'], true, null)]) assert.equal(valid(listing), true, 'what certify records always passes the contract');
});

test("the conformance evidence's stub-case rows: id, pass and reason code only, capped, always valid (coordinator, after the owner's run)", async () => {
  const contracts = await import('../../../packages/contracts/dist/index.js');
  const { stubCaseEvidence } = await import('../dist/certification.js');
  const payload = (stubCases) => ({
    harness: 'codex',
    os: 'darwin',
    harnessVersion: '0.157.1',
    realBinary: true,
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    cases: contracts.CONFORMANCE_CASES.map((id) => ({ id, passed: true, reasonCode: null })),
    ...(stubCases === undefined ? {} : { stubCases }),
  });
  const valid = (stubCases) => contracts.ReleaseEvidenceContract.validate(contracts.releaseEvidence({ kind: 'harness-conformance', id: 'hc-1', producedAt: '2026-09-28T12:00:00Z', version: '1.2.0', commit: null, tool: 'jevris-certify', os: 'darwin', payload: payload(stubCases) })).ok;
  assert.equal(valid(undefined), true, 'a record without stub cases still validates');
  assert.equal(valid([]), true);
  assert.equal(valid([{ id: 'codex.subagent-route', passed: false, reasonCode: 'ROUTE_IGNORED' }, { id: 'codex.usage-read', passed: true, reasonCode: null }]), true);
  for (const [label, rows] of [
    ['a detail key', [{ id: 'codex.subagent-route', passed: false, reasonCode: 'ROUTE_IGNORED', detail: 'text' }]],
    ['a sentence as reason', [{ id: 'codex.subagent-route', passed: false, reasonCode: 'route ignored' }]],
    ['an id with a space', [{ id: 'codex subagent route', passed: true, reasonCode: null }]],
    ['a path as id', [{ id: '/tmp/x', passed: true, reasonCode: null }]],
    ['65 rows', Array.from({ length: 65 }, (_, i) => ({ id: `codex.case-${i}`, passed: true, reasonCode: null }))],
  ]) assert.equal(valid(rows), false, label);

  const rows = stubCaseEvidence('codex', [
    { id: 'codex.subagent-route', passed: false, reasonCode: 'SPAWN_INPUT_UNEXPECTED', detail: 'the spawn_agent input was not the scripted call' },
    { id: 'codex.access-limit.rate', passed: true, reasonCode: null, detail: 'row x gave rate-limit' },
    { id: 'codex.access-limit.credit', passed: false, reasonCode: 'not a code', detail: 'x' },
    { id: 'bad id/with slash', passed: false, reasonCode: null, detail: 'x' },
  ]);
  assert.deepEqual(rows, [
    { id: 'codex.subagent-route', passed: false, reasonCode: 'SPAWN_INPUT_UNEXPECTED' },
    { id: 'codex.access-limit.rate', passed: true, reasonCode: null },
    { id: 'codex.access-limit.credit', passed: false, reasonCode: 'STUB_CASE_FAILED' },
    { id: 'codex.stub-case-4', passed: false, reasonCode: 'STUB_CASE_FAILED' },
  ], 'no detail text is kept; an odd id or reason is replaced, not dropped');
  const many = stubCaseEvidence('kilocode', Array.from({ length: 80 }, (_, i) => ({ id: `kilocode.case-${i}`, passed: true, reasonCode: null, detail: 'x' })));
  assert.equal(many.length, contracts.STUB_CASE_EVIDENCE_MAX);
  for (const list of [rows, many]) assert.equal(valid(list), true, 'what certify records always passes the contract');

  // K2's trace (coordinator, after the owner's RC5 run): names and thread roles only.
  const step = (from, name, thread = 'none', count = 1) => ({ from, name, thread, count });
  const traced = (trace) => [{ id: 'codex.subagent-route', passed: false, reasonCode: 'SHELL_NOT_SEEN', trace }];
  assert.equal(valid(traced([step('client', 'turn/start', 'parent'), step('server', 'item/started:subAgentActivity:started', 'parent'), step('hook', 'PreToolUse:Bash', 'child-1', 3)])), true);
  for (const [label, trace] of [
    ['a thread id', [step('server', 'turn/started', 'thread-0199')]],
    ['a sentence as name', [step('server', 'the child ran rm -rf')]],
    ['a URL as name', [step('stub', 'https://example.test/x')]],
    ['an unknown speaker', [step('model', 'reply:text')]],
    ['a zero count', [step('stub', 'reply:text', 'none', 0)]],
    ['a content key', [{ ...step('stub', 'reply:text'), text: 'hi' }]],
    ['257 entries', Array.from({ length: 257 }, (_, i) => step('stub', `n${i}`))],
  ]) assert.equal(valid(traced(trace)), false, label);
  const [row] = stubCaseEvidence('codex', [
    { id: 'codex.subagent-route', passed: false, reasonCode: 'SHELL_NOT_SEEN', detail: 'x', trace: [step('server', 'turn/started', 'child-1'), step('server', 'has space', 'thread-0199', 0), step('stub', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'none', 2e6), { from: 'model', name: 'x', thread: 'none', count: 1 }] },
  ]);
  assert.deepEqual(row.trace, [step('server', 'turn/started', 'child-1'), step('server', 'unnamed', 'none', 1), step('stub', 'unnamed', 'none', 1_000_000)], 'an odd name, thread or count is replaced; an odd speaker is dropped');
  assert.equal(valid([row]), true);
  assert.equal('trace' in stubCaseEvidence('codex', [{ id: 'codex.usage-read', passed: true, reasonCode: null, detail: 'x', trace: [] }])[0], false, 'an empty trace is left out');
  const { createStubTrace, STUB_TRACE_LIMIT } = await import('../dist/stub-cases.js');
  const long = createStubTrace();
  long.add('client', 'initialize', 'none');
  long.add('server', 'item/agentMessage/delta', 'parent');
  long.add('server', 'item/agentMessage/delta', 'parent');
  for (let i = 0; i < 1000; i += 1) long.add('server', `n${i}`, 'child-1');
  long.add('client', 'ended:timeout', 'none');
  const kept = long.entries();
  assert.equal(kept.length, STUB_TRACE_LIMIT);
  assert.deepEqual(kept[1], step('server', 'item/agentMessage/delta', 'parent', 2), 'consecutive repeats are counted');
  assert.equal(kept.filter((item) => item.name === 'elided').length, 1);
  assert.deepEqual(kept.at(-1), step('client', 'ended:timeout'), 'the end of a long run is kept');
  assert.equal(valid(stubCaseEvidence('codex', traced(kept))), true);
});
