import test from 'node:test';
import assert from 'node:assert/strict';
import { jevrisPaths } from '../../../packages/platform/dist/index.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';


const { main } = await import('../dist/cli.js');
const { loadHostPolicy } = await import('../dist/host-policy.js');
const { rollbackPolicy, stagePackUpgrade } = await import('../dist/pack-policy.js');
const { auditPath, drillRecordPath, killSwitchPath, runKillSwitchDrill } = await import('../dist/kill-switch.js');

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';
const SKILL_ADVICE = fileURLToPath(new URL('../../../packs/skill-advice/pack.json', import.meta.url));

function validHost() {
  return {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain', 'task-metadata'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
}

function validManifest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.temp',
    version: '0.1.0',
    maturity: 'experimental',
    description: 'Temp manifest',
    requiresCapabilities: ['task-metadata'],
    fallbackCapabilities: [],
    decisionSpecs: ['task-profile.v1'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'advise',
    conflicts: [],
    fixtures: ['routing/eligibility'],
    ...overrides,
  };
}

function absent(path) {
  try {
    readFileSync(path);
    return false;
  } catch {
    return true;
  }
}

function withRoots() {
  const parent = mkdtempSync(join(tmpdir(), 'jevris-install-gate-'));
  const home = join(parent, 'home');
  const workspace = join(parent, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configDir(home), { recursive: true });
  return {
    parent,
    home,
    workspace,
    cleanup() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

async function activePolicy(home, workspace) {
  writeFileSync(join(configDir(home), 'host.json'), `${JSON.stringify(validHost())}\n`);
  const loaded = await loadHostPolicy({ home, workspace });
  assert.equal(loaded.active, true);
  assert.equal(loaded.document.allowUncalibratedActuation, false);
  return readFileSync(join(configDir(home), 'policy-active.json'));
}

test('an applying manifest is refused until the host drill record says passed', async () => {
  const roots = withRoots();
  const priorEnv = process.env.JEVRIS_DRILL_PASSED;
  try {
    const before = await activePolicy(roots.home, roots.workspace);
    const routeWorker = join(roots.workspace, 'route-worker.json');
    writeFileSync(
      routeWorker,
      JSON.stringify(validManifest({ actions: ['route-worker'], description: SOURCE_CANARY })),
    );
    const refused = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: routeWorker,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reasonCode, 'DRILL_REQUIRED');
    assert.notEqual(refused.activated, true);
    assert.equal(JSON.stringify(refused).includes(SOURCE_CANARY), false);
    assert.equal(absent(join(configDir(roots.home), 'policy-staged.json')), true);
    assert.equal(readFileSync(join(configDir(roots.home), 'policy-active.json')).equals(before), true);

    const bounded = join(roots.workspace, 'bounded-auto.json');
    writeFileSync(bounded, JSON.stringify(validManifest({ actions: ['advise'], defaultMode: 'bounded-auto' })));
    const boundedRefused = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: bounded,
    });
    assert.equal(boundedRefused.ok, false);
    assert.equal(boundedRefused.reasonCode, 'DRILL_REQUIRED');
    assert.equal(absent(join(configDir(roots.home), 'policy-staged.json')), true);

    mkdirSync(configDir(roots.workspace), { recursive: true });
    writeFileSync(join(roots.workspace, 'kill-switch-drill.json'), '{"passed":true}\n');
    writeFileSync(join(configDir(roots.workspace), 'kill-switch-drill.json'), '{"passed":true}\n');
    writeFileSync(join(roots.workspace, 'project-flag.json'), '{"passed":true,"allowUncalibratedActuation":true}\n');
    process.env.JEVRIS_DRILL_PASSED = 'true';
    const forged = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: routeWorker,
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.reasonCode, 'DRILL_REQUIRED');
    assert.equal(absent(drillRecordPath(roots.home)), true);
    assert.equal(absent(join(configDir(roots.home), 'policy-staged.json')), true);
    assert.equal(readFileSync(join(configDir(roots.home), 'policy-active.json')).equals(before), true);

    const adviseOnly = join(roots.workspace, 'advise-abstain.json');
    writeFileSync(adviseOnly, JSON.stringify(validManifest({ actions: ['advise', 'abstain'], defaultMode: 'advise' })));
    const observed = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: adviseOnly,
    });
    assert.equal(observed.ok, true);
    assert.equal(observed.activated, false);
    assert.equal(observed.reasonCode, 'PRIVILEGE_DELTA');
    const skill = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: SKILL_ADVICE,
    });
    assert.equal(skill.ok, true);
    assert.equal(skill.activated, false);
    assert.equal(skill.reasonCode, 'PRIVILEGE_DELTA');
    const stagedAdvice = JSON.parse(readFileSync(join(configDir(roots.home), 'policy-staged.json'), 'utf8'));
    assert.equal(stagedAdvice.activated, false);
    assert.equal(readFileSync(join(configDir(roots.home), 'policy-active.json')).equals(before), true);
    const active = JSON.parse(readFileSync(join(configDir(roots.home), 'policy-active.json'), 'utf8'));
    assert.equal(active.allowUncalibratedActuation, false);

    writeFileSync(drillRecordPath(roots.home), '{"passed":false}\n');
    const notPassed = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: routeWorker,
    });
    assert.equal(notPassed.ok, false);
    assert.equal(notPassed.reasonCode, 'DRILL_REQUIRED');

    writeFileSync(drillRecordPath(roots.home), '{"passed":true}\n');
    const lifted = await stagePackUpgrade({
      home: roots.home,
      workspace: roots.workspace,
      manifestPath: routeWorker,
    });
    assert.equal(lifted.ok, true);
    assert.notEqual(lifted.reasonCode, 'DRILL_REQUIRED');
    assert.notEqual(lifted.activated, true);
    assert.equal(lifted.activated, false);
    const stagedLifted = JSON.parse(readFileSync(join(configDir(roots.home), 'policy-staged.json'), 'utf8'));
    assert.equal(stagedLifted.activated, false);
    assert.equal(stagedLifted.allowUncalibratedActuation, undefined);
    assert.equal(readFileSync(join(configDir(roots.home), 'policy-active.json')).equals(before), true);
    assert.equal(JSON.parse(readFileSync(join(configDir(roots.home), 'host.json'), 'utf8')).allowUncalibratedActuation, false);
  } finally {
    if (priorEnv === undefined) delete process.env.JEVRIS_DRILL_PASSED;
    else process.env.JEVRIS_DRILL_PASSED = priorEnv;
    roots.cleanup();
  }
});

test('off, credential deletion, and uninstall are not the drill', async () => {
  const roots = withRoots();
  const ledgerPath = join(roots.parent, 'ledger.sqlite');
  try {
    const removed = await main(['uninstall', '--home', roots.home], () => {});
    assert.equal(typeof removed, 'number');
    assert.equal(absent(killSwitchPath(roots.home)), true);
    assert.equal(absent(drillRecordPath(roots.home)), true);

    const deleted = await main(['data', 'delete', '--home', roots.home], () => {});
    assert.equal(typeof deleted, 'number');
    assert.equal(absent(killSwitchPath(roots.home)), true);
    assert.equal(absent(drillRecordPath(roots.home)), true);

    let deletes = 0;
    const cleared = await main(['credential', 'clear'], () => {}, {
      openKeyring() {
        return {
          get() {
            return undefined;
          },
          set() {},
          delete() {
            deletes += 1;
          },
        };
      },
    });
    assert.equal(typeof cleared, 'number');
    assert.equal(deletes, 1);
    assert.equal(absent(killSwitchPath(roots.home)), true);
    assert.equal(absent(drillRecordPath(roots.home)), true);

    const snapshot = `${JSON.stringify(validHost())}\n`;
    writeFileSync(join(configDir(roots.home), 'host.json'), snapshot);
    writeFileSync(join(configDir(roots.home), 'policy-previous.json'), snapshot);
    const rolled = await main(['policy', 'rollback', '--home', roots.home, '--workspace', roots.workspace], () => {});
    assert.equal(typeof rolled, 'number');
    assert.equal(rolled, 0);
    assert.equal(absent(killSwitchPath(roots.home)), true);
    assert.equal(absent(drillRecordPath(roots.home)), true);

    const drilled = await runKillSwitchDrill({
      home: roots.home,
      workspace: roots.workspace,
      ledgerPath,
      workspaceId: 'wsFlag',
      hostScope: 'hostA',
      fixture: { canary: 'fixture-fired', source: SOURCE_CANARY },
    });
    assert.equal(drilled.ok, true);
    const audit = readFileSync(auditPath(roots.home), 'utf8');
    assert.equal(audit.includes(SOURCE_CANARY), false);
    assert.equal(audit.includes('source'), false);
    assert.equal(audit.includes('\u001b'), false);
    assert.equal(drilled.text.includes(SOURCE_CANARY), false);
    const drillBefore = readFileSync(drillRecordPath(roots.home));
    assert.equal(absent(drillRecordPath(roots.home)), false);
    const restored = await rollbackPolicy({ home: roots.home, workspace: roots.workspace });
    assert.equal(restored.ok, true);
    assert.equal(readFileSync(drillRecordPath(roots.home)).equals(drillBefore), true);
    assert.equal(JSON.parse(drillBefore.toString('utf8')).passed, true);
  } finally {
    roots.cleanup();
  }
});

/** Jevris config dir for this OS (BLD-09). */
function configDir(home) {
  return jevrisPaths({ home }).config;
}
