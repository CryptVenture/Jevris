import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from './managed-host.mjs';
import {
  RUNTIME_MODULE_PROBE,
  SEEDED_CONFIGS,
  applyUserEdit,
  configFiles,
  configProblems,
  drillsEvidence,
  expandHomeTokens,
  installedEvidence,
  installedPackageDir,
  isInstallReceipt,
  mcpHandshake,
  parseArgs,
  quotedStrings,
  receiptCheck,
  receiptLeftovers,
  referencedEntryPaths,
  shimPath,
} from '../scripts/pack-smoke.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('a user edit keeps every seeded config valid and is reproducible from the seed (RLS-04)', () => {
  for (const item of SEEDED_CONFIGS) {
    const edited = applyUserEdit(item.text, item.kind);
    assert.notEqual(edited, item.text);
    assert.equal(applyUserEdit(item.text, item.kind), edited, 'deterministic');
    if (item.kind === 'json') {
      const parsed = JSON.parse(edited);
      assert.equal(parsed.userEditAfterInstall, true);
      assert.deepEqual({ ...parsed, userEditAfterInstall: undefined }, { ...JSON.parse(item.text), userEditAfterInstall: undefined });
    } else {
      assert.equal(edited.startsWith(item.text), true);
    }
  }
  assert.equal(new Set(SEEDED_CONFIGS.map((item) => item.rel.join('/'))).size, SEEDED_CONFIGS.length);
});

test('quotedStrings unescapes JSON and TOML strings, including Windows paths', () => {
  const json = '{"command": "node", "args": ["C:\\\\Users\\\\a b\\\\AppData\\\\Local\\\\Jevris\\\\runtime\\\\1.2.0\\\\plugins\\\\shared\\\\mcp.js"]}';
  assert.equal(quotedStrings(json).includes('C:\\Users\\a b\\AppData\\Local\\Jevris\\runtime\\1.2.0\\plugins\\shared\\mcp.js'), true);
  const toml = "command = 'node'\nargs = [\"/home/u/.local/share/jevris/runtime/1.2.0/plugins/shared/mcp.js\"]\n";
  assert.deepEqual(quotedStrings(toml), ['/home/u/.local/share/jevris/runtime/1.2.0/plugins/shared/mcp.js', 'node']);
});

test('referencedEntryPaths finds MCP, bin and hook entry paths inside commands', () => {
  const text = JSON.stringify({
    mcp: { command: 'node', args: ['/d/runtime/1.2.0/plugins/shared/mcp.js'] },
    hooks: [{ command: 'node "/d/runtime/1.2.0/dist/hook.mjs" --harness codex' }],
    other: 'mcp.js',
  });
  assert.deepEqual(referencedEntryPaths(text).sort(), ['/d/runtime/1.2.0/dist/hook.mjs', '/d/runtime/1.2.0/plugins/shared/mcp.js']);
});

test('configProblems refuses the repository path and the npx cache on any OS spelling', () => {
  assert.deepEqual(configProblems('a.json', '{"x":"/tmp/data/runtime/mcp.js"}', { repo: '/src/Jevris' }), []);
  assert.equal(configProblems('a.json', '{"x":"/src/Jevris/plugins/shared/mcp.js"}', { repo: '/src/Jevris' }).length, 1);
  assert.equal(configProblems('a.json', '{"x":"C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\npm-cache\\\\_npx\\\\ab\\\\mcp.js"}', { repo: '/x' }).length, 1);
  assert.equal(configProblems('a.json', '{"x":"C:\\\\SRC\\\\jevris\\\\mcp.js"}', { repo: 'c:\\src\\Jevris' }).length, 1);
});

test('shim and package locations follow npm global prefix layout per OS', () => {
  assert.equal(shimPath('/p', 'linux'), join('/p', 'bin', 'jevris'));
  assert.equal(shimPath('C:\\p', 'win32'), join('C:\\p', 'jevris.cmd'));
  assert.equal(installedPackageDir('/p', 'darwin'), join('/p', 'lib', 'node_modules', '@webventures', 'jevris'));
  assert.equal(installedPackageDir('/p', 'win32'), join('/p', 'node_modules', '@webventures', 'jevris'));
});

test('parseArgs accepts the documented modes and refuses anything else', () => {
  assert.deepEqual(parseArgs(['--full', '--npx', '--no-build', '--report', 'r.json']), {
    full: true,
    npx: true,
    build: false,
    tarball: undefined,
    report: 'r.json',
    evidence: undefined,
    drillsEvidence: undefined,
    keep: false,
  });
  assert.equal(parseArgs(['--full', '--drills-evidence', 'd.json']).drillsEvidence, 'd.json');
  assert.throws(() => parseArgs(['--drills-evidence', 'd.json']), /needs --full/);
  assert.throws(() => parseArgs(['--publish']), /unknown argument/);
});

test('mcpHandshake completes initialize and tools/list against the shipped MCP server', async () => {
  const result = await mcpHandshake(process.execPath, [join(root, 'plugins', 'shared', 'mcp.js')], process.env, 15000);
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.tools.length > 0, true);
  const bad = await mcpHandshake(process.execPath, ['-e', 'process.exit(3)'], process.env, 5000);
  assert.equal(bad.ok, false);
});

test('mcpHandshake reports a child that is gone before its first write as a failure, never an uncaught EPIPE', () => {
  // The parent stalls between spawn and its first stdin write, as on a loaded host, so the child
  // has exited and the write fails with EPIPE. The handshake must report it, not crash.
  const script = [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const original = childProcess.spawn;',
    'childProcess.spawn = (...args) => { const child = original(...args); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); return child; };',
    'syncBuiltinESMExports();',
    "let uncaught = 0; process.on('uncaughtException', () => { uncaught += 1; });",
    `const { mcpHandshake } = await import(${JSON.stringify(new URL('../scripts/pack-smoke.mjs', import.meta.url).href)});`,
    'const details = [];',
    "for (let i = 0; i < 3; i += 1) details.push((await mcpHandshake(process.execPath, ['-e', 'process.exit(3)'], process.env, 5000)).detail);",
    'await new Promise((resolve) => setTimeout(resolve, 50));',
    'console.log(JSON.stringify({ uncaught, details }));',
  ].join('\n');
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(ran.status, 0, ran.stderr);
  const { uncaught, details } = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.equal(uncaught, 0, 'no uncaught EPIPE');
  assert.deepEqual(details.map((detail) => detail.startsWith('exited 3 before tools/list')), [true, true, true]);
});

test('a smoke report becomes a valid installed-e2e ReleaseEvidence record (RLS-04)', async () => {
  const { ReleaseEvidenceContract } = await import('../packages/contracts/dist/index.js');
  const report = {
    platform: 'linux',
    arch: 'x64',
    node: 'v22.14.0',
    at: '2026-09-30T12:00:00.000Z',
    ok: true,
    modes: { full: true, npx: true },
    steps: [{ id: 'jevris --version', ok: true, ms: 1, detail: '1.2.0' }],
  };
  const record = await installedEvidence(report, { version: '1.2.0' }, { GITHUB_SHA: 'f'.repeat(40), GITHUB_RUN_ID: '42' });
  const checked = ReleaseEvidenceContract.validate(record);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.equal(record.subject.commit, 'f'.repeat(40));
  assert.equal(record.environment.os, 'linux');
  assert.equal(record.producer.run, 'github-actions:42');
  assert.deepEqual(record.payload, { ok: true, full: true, npx: true, steps: [{ id: 'jevris --version', ok: true }] });
});

test('a full smoke of more than 256 steps still makes a valid installed-e2e record (257 on 28 September 2026)', async () => {
  const { ReleaseEvidenceContract } = await import('../packages/contracts/dist/index.js');
  const steps = Array.from({ length: 600 }, (_, index) => ({ id: `step ${index}`, ok: true, ms: 1, detail: '' }));
  const report = { platform: 'darwin', arch: 'arm64', node: 'v26.5.0', at: '2026-09-28T09:00:00.000Z', ok: true, modes: { full: true, npx: true }, steps };
  const record = await installedEvidence(report, { version: '1.2.0' }, { GITHUB_SHA: 'a'.repeat(40) });
  const checked = ReleaseEvidenceContract.validate(record);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.equal(record.payload.steps.length, 600);
});

test('the operations drills become a valid installed-tarball operations-drills record (OBS-05)', async () => {
  const { ReleaseEvidenceContract, contentHash } = await import('../packages/contracts/dist/index.js');
  const { DRILL_IDS } = await import('../apps/sidecar/scripts/ops-drills.mjs');
  const report = { platform: 'win32', arch: 'x64', node: 'v22.14.0', at: '2026-09-30T12:00:00.000Z' };
  const drills = Object.fromEntries(DRILL_IDS.map((id) => [id, { passed: id !== 'disk-full', recordHash: contentHash({ drill: id }), detail: 'x' }]));
  const record = await drillsEvidence(report, drills, { version: '1.2.0' }, { GITHUB_SHA: 'e'.repeat(40) });
  assert.equal(ReleaseEvidenceContract.validate(record).ok, true);
  assert.equal(record.kind, 'operations-drills');
  assert.equal(record.id, 'operations-drills-win32-x64-v22.14.0');
  assert.equal(record.subject.commit, 'e'.repeat(40));
  assert.equal(record.payload.os, 'win32');
  assert.equal(record.payload.ranAgainst, 'installed-tarball');
  assert.deepEqual(record.payload.drills.map((drill) => drill.id), DRILL_IDS);
  assert.deepEqual(record.payload.drills.filter((drill) => !drill.passed).map((drill) => drill.id), ['disk-full'], 'a failed drill stays failed in the record');
  const missing = await drillsEvidence(report, { crash: drills.crash }, { version: '1.2.0' }, {});
  assert.equal(missing.payload.drills.filter((drill) => drill.passed).length, 1, 'a drill with no result is recorded as not passed');
});

test('plugin roots inside the runtime copy resolve their relative entries and MCP servers (ADM-03)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pluginRootEntries, configFiles, absolutePaths } = await import('../scripts/pack-smoke.mjs');
  const root = mkdtempSync(join(tmpdir(), 'jevris-root-'));
  try {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hook.js"' }] }] } }));
    writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { jevris: { command: 'node', args: ['./bin/mcp.js'] } } }));
    const found = pluginRootEntries(root);
    assert.deepEqual(found.scripts.sort(), [join(root, 'bin', 'hook.js'), join(root, 'bin', 'mcp.js')].sort());
    assert.deepEqual(found.servers, [{ command: 'node', args: [join(root, 'bin', 'mcp.js')] }]);
    const runtime = join(root, 'runtime');
    mkdirSync(join(runtime, '1.2.0'), { recursive: true });
    writeFileSync(join(runtime, '1.2.0', 'manifest.json'), '{"entries":{"bin":"bin/jevris.mjs"}}');
    assert.equal(configFiles(root, runtime).some((file) => file.includes('manifest.json')), false);
    assert.equal(configFiles(root, runtime).some((file) => file.endsWith('mcp.json')), true);
    assert.deepEqual(absolutePaths('[plugins."jevris@jevris-local"]\nsource = "/home/u/.jevris/runtime/1.2.0/plugins/codex"\n'), ['/home/u/.jevris/runtime/1.2.0/plugins/codex']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command tokens keep quoted paths with spaces whole (US36)', async () => {
  const { commandTokens, referencedEntryPaths } = await import('../scripts/pack-smoke.mjs');
  assert.deepEqual(commandTokens('node "C:\\Users\\John Doe\\rt\\dist\\hook.mjs" --harness codex'), ['node', 'C:\\Users\\John Doe\\rt\\dist\\hook.mjs', '--harness', 'codex']);
  assert.deepEqual(referencedEntryPaths(JSON.stringify({ command: 'node "/home/a b/rt/plugins/shared/mcp.js"' })), ['/home/a b/rt/plugins/shared/mcp.js']);
});

test('the runtime-module probe loads credential, kill-switch and certifications from the built bundle (PKG-06)', { skip: managedHostSkip() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-probe-'));
  try {
    const home = join(dir, 'home');
    const script = join(dir, 'probe.mjs');
    writeFileSync(script, RUNTIME_MODULE_PROBE);
    const run = spawnSync(process.execPath, [script, root, home], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, JEVRIS_TEST: '1' }, timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { credential: true, killSwitch: true, certifications: true });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('install receipts are checked against the files they list, not scanned as harness configs (ADM-06)', () => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-receipt-'));
  try {
    const write = (rel, text) => {
      mkdirSync(join(home, ...rel.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(home, ...rel.split('/')), text);
    };
    const skill = '# skill\n';
    write('.config/kilo/skills/jevris-plan/SKILL.md', skill);
    // The same path text as the splice below, whose tail is written with '/' on every OS.
    write('.config/kilo/kilo.json', JSON.stringify({ mcp: { jevris: { command: [`${home}/.jevris/runtime/mcp.mjs`] } } }));
    const splice = JSON.stringify({ command: ['${JEVRIS_HOME_JSON}/.jevris/runtime/mcp.mjs'] }).slice(12, -1);
    const receipt = {
      schemaVersion: '2.1',
      pluginId: 'jevris',
      files: [{ path: '.config/kilo/skills/jevris-plan/SKILL.md', sha256: createHash('sha256').update(skill).digest('hex') }],
      dirs: ['.config/kilo/skills/jevris-plan'],
      edits: [{ file: '.config/kilo/kilo.json', format: 'json', pointer: '/mcp/jevris', preHash: null, postHash: 'x', created: true, splices: [{ text: splice.replace(JSON.stringify(home).slice(1, -1), '${JEVRIS_HOME_JSON}') }] }],
    };
    write('.jevris/kilo-install-receipt.json', JSON.stringify(receipt));

    assert.equal(isInstallReceipt(join(home, '.jevris', 'kilo-install-receipt.json')), true);
    assert.equal(isInstallReceipt(join(home, '.config', 'kilo', 'kilo.json')), false);
    assert.deepEqual(configFiles(home).map((file) => file.slice(home.length + 1).split('\\').join('/')), ['.config/kilo/kilo.json']);
    assert.equal(expandHomeTokens('${JEVRIS_HOME_JSON}|${JEVRIS_HOME_POSIX}|${JEVRIS_HOME}', 'C:\\Users\\a b'), 'C:\\\\Users\\\\a b|C:/Users/a b|C:\\Users\\a b');

    const after = receiptCheck(home);
    assert.deepEqual(after.problems, []);
    assert.equal(after.receipts, 1);
    assert.deepEqual(receiptLeftovers(home, after), ['.config/kilo/skills/jevris-plan/SKILL.md']);

    // A changed owned file, a receipt that names the absolute home, and a lost splice are all reported.
    write('.config/kilo/skills/jevris-plan/SKILL.md', '# edited\n');
    write('.config/kilo/kilo.json', '{}');
    write('.jevris/codex-install-receipt.json', JSON.stringify({ ...receipt, files: [], dirs: [], edits: [], note: home }));
    const broken = receiptCheck(home);
    assert.equal(broken.problems.some((line) => /does not match its sha256/.test(line)), true, broken.problems.join('; '));
    assert.equal(broken.problems.some((line) => /lacks the text install inserted/.test(line)), true, broken.problems.join('; '));
    assert.equal(broken.problems.some((line) => /codex-install-receipt\.json names the absolute home/.test(line)), true, broken.problems.join('; '));

    // After uninstall: no listed file, and no listed folder left empty.
    rmSync(join(home, '.config', 'kilo', 'skills', 'jevris-plan', 'SKILL.md'));
    assert.deepEqual(receiptLeftovers(home, after), ['.config/kilo/skills/jevris-plan']);
    rmSync(join(home, '.config', 'kilo', 'skills', 'jevris-plan'), { recursive: true });
    assert.deepEqual(receiptLeftovers(home, after), []);
    assert.deepEqual(receiptLeftovers(home, undefined).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
