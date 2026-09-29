import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, repoRoot, workflow } from './lib.mjs';

// W11: installing and upgrading a policy pack through `jevris pack`, the admin command. Every
// step is the product's CLI against the sandbox home; the only inputs made up here are the pack
// sources, a shadow report and canary metrics, the files a pack author and a canary run produce.
const HOST = {
  schemaVersion: '1.0',
  mode: 'advise',
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 131072 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: ['advise', 'abstain', 'task-metadata', 'request-checkpoint'],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};
const FIXTURES = { 'fixtures/routing/cheap.json': JSON.stringify({ decision: 'route.v1', outcome: { selected: 'cheap' }, expect: { action: 'advise' } }) };

function manifest(over = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.acme-routing',
    version: '1.0.0',
    maturity: 'experimental',
    description: 'Worker-tier advice for routine tasks',
    requiresCapabilities: [],
    fallbackCapabilities: [],
    decisionSpecs: ['route.v1'],
    actions: ['advise', 'abstain'],
    dataScopes: ['task-metadata'],
    defaultMode: 'advise',
    conflicts: ['exclusive:worker-model-router'],
    fixtures: ['routing/cheap'],
    evidenceSelectors: [{ id: 'objective', builder: 'task-objective', priority: 'mandatory', maxItems: 1 }],
    decisions: [{ id: 'route.v1', kind: 'choice', domain: 'worker-routing', question: 'Which worker tier fits this task?', evidence: ['objective'], options: ['cheap', 'strong'] }],
    rules: [{ id: 'cheap-advice', decision: 'route.v1', selected: 'cheap', action: 'advise' }],
    ...over,
  };
}

workflow('W11', 'Installing or upgrading a policy pack', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { jevrisPaths } = await load('platform');
  const config = relative(box.dir, jevrisPaths({ home: box.home }).config);
  box.write(join(config, 'host.json'), HOST);
  box.write('work/lib/app.mjs', 'export const app = 1;\n');
  box.gitInit();
  const source = (name, doc, files = FIXTURES) => {
    const dir = join(box.dir, 'packs', name);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    box.write(join('packs', name, 'pack.json'), doc);
    return dir;
  };
  const pack = (...args) => box.jevris(['pack', ...args, '--json'], { json: true });
  const shadowReport = box.write('shadow-report.json', { schemaVersion: '1.0', kind: 'shadow-report', baselines: ['rules-only', 'native', 'jev'], recordCount: 12, actuationCount: 0, measuredSpeedRatio: null, measuredCostRatio: null });
  const metrics = (version, over = {}) => box.write(`canary-${version}.json`, { schemaVersion: '1.0', packId: 'jevris.acme-routing', version, tasks: 25, verifiedSuccessRate: 0.9, baselineVerifiedSuccessRate: 0.88, privacyViolations: 0, ...over });
  const listed = () => pack('list').json.packs.find((item) => item.id === 'jevris.acme-routing');
  // Approving a delta needs a person at an interactive terminal and refuses --yes (SR-1), and a
  // story run has no terminal: the sandbox approves through the pack registry, as the CLI does
  // after a person answers y, and answers in the CLI's JSON shape.
  const registry = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'packs', 'registry.js')).href);
  const approve = async (hash) => {
    const result = await registry.approvePack(box.home, hash, {});
    return { code: result.ok ? 0 : 2, stdout: JSON.stringify(result), json: { schemaVersion: '1.0', command: 'pack approve', ...result } };
  };
  const v1 = source('routing-1.0.0', manifest());
  let v1Hash;

  await then('the installer validates the manifest, provenance and permission delta, and installing activates nothing', () => {
    const broken = pack('install', source('broken', { ...manifest({ id: 'jevris.acme-broken' }), schemaVersion: '9.0' }));
    evidence(broken.json);
    assert.equal(broken.code, 2, `a broken manifest installed: ${broken.stdout}`);
    assert.equal(broken.json.ok, false);
    const inspected = pack('inspect', v1);
    evidence(inspected.json);
    assert.equal(inspected.code, 0, inspected.stdout);
    assert.deepEqual([inspected.json.packId, inspected.json.version, inspected.json.signature, inspected.json.adviseOnly], ['jevris.acme-routing', '1.0.0', 'unsigned', true]);
    assert.deepEqual(inspected.json.executables, []);
    const installed = pack('install', v1);
    evidence(installed.json);
    assert.equal(installed.code, 0, installed.stdout);
    assert.deepEqual([installed.json.stage, installed.json.signature], ['draft', 'unsigned']);
    assert.match(installed.json.delta.hash, /^sha256:[0-9a-f]{64}$/);
    for (const item of installed.json.delta.items) {
      assert.match(item.category, /^(executable|egress|tool-access|retention)$/);
      assert.match(item.reasonCode, /^[A-Z][A-Z0-9_]+$/);
      assert.equal(item.policy, 'within', `v1 asks beyond host policy: ${JSON.stringify(item)}`);
    }
    v1Hash = installed.json.delta.hash;
    assert.equal(listed().active, null, 'installing activated the pack');
  });

  await then('a pack with executable code shows it in the delta and cannot be activated until its publisher is trusted', async () => {
    const component = 'process.stdout.write(JSON.stringify({ proposals: [] }) + "\\n");\n';
    const files = { ...FIXTURES, 'bin/component.cjs': component };
    const executables = [{ id: 'component', path: 'bin/component.cjs', sha256: createHash('sha256').update(component).digest('hex'), runtime: 'node', writesPackData: false, timeoutMs: 5000 }];
    const dir = source('exec-1.0.0', manifest({ id: 'jevris.acme-exec', conflicts: [], executables }), files);
    const installed = pack('install', dir);
    evidence(installed.json);
    assert.equal(installed.code, 0, installed.stdout);
    assert.equal(installed.json.signature, 'unsigned');
    assert.equal(installed.json.delta.items.some((item) => item.category === 'executable'), true, 'the executable is not in the delta');
    assert.equal(pack('test', 'jevris.acme-exec@1.0.0').code, 0);
    assert.equal(pack('shadow', 'jevris.acme-exec@1.0.0', '--report', shadowReport).code, 0);
    const approved = await approve(installed.json.delta.hash);
    evidence(approved.json);
    assert.equal(approved.code, 2);
    assert.equal(approved.json.reasonCode, 'UNSIGNED_EXECUTABLE');
    assert.equal(pack('list').json.packs.find((item) => item.id === 'jevris.acme-exec').active, null);
  });

  await then('the pack runs its fixtures and shadow mode before a person approves it, then canary and promotion', async () => {
    const early = await approve(v1Hash);
    assert.deepEqual([early.code, early.json.reasonCode], [2, 'STAGE_NOT_READY']);
    const tested = pack('test', 'jevris.acme-routing@1.0.0');
    evidence(tested.json);
    assert.deepEqual([tested.code, tested.json.passed, tested.json.stage], [0, true, 'fixture-tested']);
    const shadowed = pack('shadow', 'jevris.acme-routing@1.0.0', '--report', shadowReport);
    evidence(shadowed.json);
    assert.deepEqual([shadowed.code, shadowed.json.recordCount], [0, 12]);
    // Without a terminal, with or without --yes, nothing changes (SR-1).
    const unconfirmed = box.jevris(['pack', 'approve', v1Hash]);
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.stdout + unconfirmed.stderr, /Nothing was changed \(CHANNEL_REFUSED\)/);
    const scripted = box.jevris(['pack', 'approve', v1Hash, '--yes']);
    assert.equal(scripted.code, 2);
    assert.match(scripted.stdout + scripted.stderr, /Nothing was changed \(CHANNEL_REFUSED\)/);
    assert.equal(listed().active, null);
    const approved = await approve(v1Hash);
    evidence(approved.json);
    assert.equal(approved.code, 0, approved.stdout);
    assert.deepEqual([approved.json.packId, approved.json.version, approved.json.previous], ['jevris.acme-routing', '1.0.0', null]);
    assert.equal(listed().versions['1.0.0'].stage, 'canary');
    assert.equal(pack('promote', 'jevris.acme-routing').json.reasonCode, 'CANARY_INSUFFICIENT', 'promoted without canary metrics');
    const canary = pack('canary', 'jevris.acme-routing', '--metrics', metrics('1.0.0'));
    evidence(canary.json);
    assert.deepEqual([canary.code, canary.json.regression], [0, false]);
    const promoted = pack('promote', 'jevris.acme-routing');
    assert.equal(promoted.code, 0, promoted.stdout);
    assert.equal(listed().versions['1.0.0'].stage, 'stable');
    // A second pack claiming the same exclusive domain is refused at approval.
    const rival = pack('install', source('rival-1.0.0', manifest({ id: 'jevris.acme-rival' })));
    pack('test', 'jevris.acme-rival@1.0.0');
    pack('shadow', 'jevris.acme-rival@1.0.0', '--report', shadowReport);
    const clash = await approve(rival.json.delta.hash);
    evidence(clash.json);
    assert.deepEqual([clash.code, clash.json.reasonCode], [2, 'EXCLUSIVE_CONFLICT']);
  });

  let v2Hash;
  await then('a policy-only update that changes a question still needs its evaluation', async () => {
    const v2 = manifest({ version: '1.1.0' });
    v2.decisions = [{ ...v2.decisions[0], question: 'Which worker tier fits this task, given its size?' }];
    const installed = pack('install', source('routing-1.1.0', v2));
    evidence(installed.json);
    assert.equal(installed.code, 0, installed.stdout);
    assert.equal(installed.json.stage, 'draft');
    v2Hash = installed.json.delta.hash;
    assert.notEqual(v2Hash, v1Hash);
    const early = await approve(v2Hash);
    assert.deepEqual([early.code, early.json.reasonCode], [2, 'STAGE_NOT_READY']);
    assert.equal(listed().active, '1.0.0');
  });

  await then('rollback restores the previous compatible pack and keeps the user\'s configuration', async () => {
    assert.equal(pack('enable', 'jevris.acme-routing', '--workspace', box.work).code, 0, 'enable failed');
    // The user's own configuration: a setting that differs from the default, so the file exists.
    assert.equal(box.jevris(['configure', 'set', 'orchestration.maxConcurrentWorkers', '3']).code, 0);
    const settingsBefore = box.read(join(config, 'jevris.config.json'));
    const hostBefore = box.read(join(config, 'host.json'));
    assert.equal(pack('test', 'jevris.acme-routing@1.1.0').code, 0);
    assert.equal(pack('shadow', 'jevris.acme-routing@1.1.0', '--report', shadowReport).code, 0);
    const approved = await approve(v2Hash);
    assert.equal(approved.code, 0, approved.stdout);
    assert.equal(approved.json.previous, '1.0.0');
    assert.equal(listed().active, '1.1.0');
    const rolled = pack('rollback', 'jevris.acme-routing');
    evidence(rolled.json);
    assert.equal(rolled.code, 0, rolled.stdout);
    assert.deepEqual([rolled.json.from, rolled.json.to], ['1.1.0', '1.0.0']);
    const after = listed();
    evidence(after);
    assert.equal(after.active, '1.0.0');
    assert.equal(Object.keys(after.workspaces).length, 1, `the workspace enablement was lost: ${JSON.stringify(after.workspaces)}`);
    assert.equal(box.read(join(config, 'jevris.config.json')), settingsBefore, 'rollback changed the user settings');
    assert.equal(box.read(join(config, 'host.json')), hostBefore, 'rollback changed host policy');
    assert.deepEqual(after.history.slice(-2).map((event) => event.event), ['approve', 'rollback']);
  });

  await then('disabling the pack removes only its own entry and leaves the workspace untouched', () => {
    const disabled = pack('disable', 'jevris.acme-routing', '--workspace', box.work);
    evidence(disabled.json);
    assert.equal(disabled.code, 0, disabled.stdout);
    assert.deepEqual(Object.keys(listed().workspaces), []);
    assert.equal(listed().active, '1.0.0', 'disabling in one workspace deactivated the pack');
    assert.equal(box.read('work/lib/app.mjs'), 'export const app = 1;\n');
    assert.equal(box.git('status', '--porcelain').stdout, '', 'the workspace changed');
  });

  await then('uninstalling removes only the pack\'s namespaced entries and keeps its data until the user chooses cleanup', () => {
    assert.equal(pack('enable', 'jevris.acme-routing', '--workspace', box.work).code, 0, 'enable failed');
    const packs = join(jevrisPaths({ home: box.home }).data, 'packs', 'jevris.acme-routing');
    const removed = pack('uninstall', 'jevris.acme-routing');
    evidence(removed.json);
    assert.equal(removed.code, 0, removed.stdout);
    assert.equal(removed.json.wasActive, '1.0.0');
    assert.deepEqual([...removed.json.removedVersions].sort(), ['1.0.0', '1.1.0']);
    assert.equal(removed.json.disabledIn.length, 1);
    assert.equal(removed.json.cleanedUp, false);
    assert.equal(existsSync(join(packs, '1.0.0')), false, 'a version folder was left');
    const after = listed();
    assert.deepEqual([after.active, Object.keys(after.versions), Object.keys(after.workspaces)], [null, [], []]);
    assert.equal(after.history.at(-1).event, 'uninstall', 'the history was not kept');
    // Other packs, the user's settings and the workspace are untouched.
    assert.notEqual(pack('list').json.packs.find((item) => item.id === 'jevris.acme-rival'), undefined, 'another pack was removed');
    assert.equal(box.read('work/lib/app.mjs'), 'export const app = 1;\n');
    assert.equal(box.git('status', '--porcelain').stdout, '');
    // Cleanup of what was kept is a separate, confirmed choice.
    const unconfirmed = box.jevris(['pack', 'uninstall', 'jevris.acme-routing', '--cleanup']);
    assert.equal(unconfirmed.code, 2);
    assert.match(unconfirmed.stdout + unconfirmed.stderr, /Nothing was changed\./);
    const cleaned = pack('uninstall', 'jevris.acme-routing', '--cleanup', '--yes');
    evidence(cleaned.json);
    assert.equal(cleaned.code, 0, cleaned.stdout);
    assert.equal(cleaned.json.cleanedUp, true);
    assert.equal(existsSync(packs), false, 'cleanup left the pack folder');
    const unknown = pack('uninstall', 'jevris.never-installed');
    assert.deepEqual([unknown.code, unknown.json.reasonCode], [2, 'PACK_UNKNOWN']);
  });
});
