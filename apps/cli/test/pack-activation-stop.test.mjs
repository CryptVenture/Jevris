import test from 'node:test';
import assert from 'node:assert/strict';
import { jevrisPaths } from '../../../packages/platform/dist/index.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';


const { loadHostPolicy } = await import('../dist/host-policy.js');
const { packUpgradeGate, stagePackUpgrade } = await import('../dist/pack-policy.js');

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';
const ROUTING_PACK = fileURLToPath(new URL('../../../fixtures/ssot/examples/routing.pack.json', import.meta.url));
const UNMEASURED = ['rules-only', 'native', 'quality', 'retries', 'verification', 'cache', 'human effort'];

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
    id: 'jevris.canary-stop',
    version: '0.1.0',
    maturity: 'canary',
    description: 'Canary stays inactive',
    requiresCapabilities: ['task-metadata'],
    fallbackCapabilities: [],
    decisionSpecs: ['task-profile.v1'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'observe',
    conflicts: [],
    fixtures: ['routing/eligibility'],
    ...overrides,
  };
}

function trustedApproval() {
  return { approved: true, channel: 'trusted-channel', source: 'host-record' };
}

function measuredComparison() {
  return {
    baselines: ['rules-only', 'native'],
    measuredSpeedRatio: 1,
    measuredCostRatio: 1,
    vendorSpeedClaim: 'supplied-not-copied',
    vendorCostClaim: 'supplied-not-copied',
    fullCostPerVerifiedTask: 'supplied-not-copied',
  };
}

async function withRoots(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-canary-stop-'));
  const home = join(parent, 'home');
  const workspace = join(parent, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await fn({ home, workspace });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function activePath(home) {
  return join(configDir(home), 'policy-active.json');
}

function stagedPath(home) {
  return join(configDir(home), 'policy-staged.json');
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

test('a canary manifest is not activated and a workspace file is not approval', async () => {
  assert.equal(typeof packUpgradeGate, 'function');
  await withRoots(async ({ home, workspace }) => {
    const manifestPath = join(workspace, 'canary.json');
    await writeFile(manifestPath, JSON.stringify(validManifest({ description: SOURCE_CANARY })));
    await writeFile(
      join(workspace, 'approved.json'),
      JSON.stringify({
        approved: true,
        passed: true,
        measuredSpeedRatio: 9.5,
        note: SOURCE_CANARY,
      }),
    );
    const staged = await stagePackUpgrade({ home, workspace, manifestPath });
    assert.equal(staged.ok, false);
    assert.equal(staged.activated, false);
    assert.notEqual(staged.activated, true);
    assert.equal(staged.measuredSpeedRatio, null);
    assert.equal(staged.measuredCostRatio, null);
    assert.equal(staged.missing.includes('comparison'), true);
    assert.equal(staged.missing.includes('rollback'), true);
    assert.equal(staged.missing.includes('privilege-delta'), true);
    for (const name of UNMEASURED) {
      assert.equal(staged.unmeasured.includes(name), true);
    }
    assert.equal(JSON.stringify(staged).includes(SOURCE_CANARY), false);
    assert.equal(JSON.stringify(staged).includes('9.5'), false);
    assert.equal(await exists(activePath(home)), false);
    assert.equal(await exists(stagedPath(home)), false);

    await mkdir(configDir(home), { recursive: true });
    await writeFile(join(configDir(home), 'host.json'), `${JSON.stringify(validHost())}\n`);
    await loadHostPolicy({ home, workspace });
    const before = await readFile(activePath(home));
    const again = await stagePackUpgrade({ home, workspace, manifestPath });
    assert.equal(again.activated, false);
    assert.equal((await readFile(activePath(home))).equals(before), true);
    assert.equal(await exists(stagedPath(home)), false);
  });
});

test('four in-memory checks still do not start an applying pack', async () => {
  const gated = await packUpgradeGate({
    manifest: validManifest(),
    privilegeDelta: trustedApproval(),
    comparison: measuredComparison(),
    rollbackApproval: trustedApproval(),
  });
  assert.equal(gated.activated, false);
  assert.equal(gated.applyingPackStarted, false);
  assert.equal(gated.reason.includes('applying pack is not started'), true);
  assert.equal(gated.measuredSpeedRatio, null);
  assert.equal(gated.measuredCostRatio, null);
  assert.deepEqual(gated.missing, []);
  for (const name of UNMEASURED) {
    assert.equal(gated.unmeasured.includes(name), true);
  }
});

test('null ratios and a vendor not-a-jevris-result are not approval', async () => {
  const gated = await packUpgradeGate({
    manifest: validManifest(),
    privilegeDelta: trustedApproval(),
    comparison: {
      baselines: ['rules-only', 'native'],
      measuredSpeedRatio: null,
      measuredCostRatio: null,
      vendorSpeedClaim: 'not-a-jevris-result',
      vendorCostClaim: 'not-a-jevris-result',
      fullCostPerVerifiedTask: 'unmeasured',
    },
    rollbackApproval: { approved: true, source: 'project-file' },
  });
  assert.equal(gated.activated, false);
  assert.equal(gated.missing.includes('comparison'), true);
  assert.equal(gated.missing.includes('rollback'), true);
  assert.equal(gated.measuredSpeedRatio, null);
  assert.equal(gated.measuredCostRatio, null);
});

test('a missing comparison, a vendor claim, or a project-file rollback does not activate', async () => {
  const missingComparison = await packUpgradeGate({
    manifest: validManifest(),
    privilegeDelta: trustedApproval(),
    rollbackApproval: trustedApproval(),
  });
  assert.equal(missingComparison.activated, false);
  assert.equal(missingComparison.missing.includes('comparison'), true);
  assert.equal(missingComparison.applyingPackStarted, false);

  const vendor = await packUpgradeGate({
    manifest: validManifest(),
    privilegeDelta: trustedApproval(),
    comparison: {
      baselines: ['rules-only', 'native'],
      measuredSpeedRatio: 4,
      measuredCostRatio: 0.5,
      vendorSpeedClaim: 'not-a-jevris-result',
      vendorCostClaim: 'not-a-jevris-result',
      fullCostPerVerifiedTask: 'unmeasured',
    },
    rollbackApproval: trustedApproval(),
  });
  assert.equal(vendor.activated, false);
  assert.equal(vendor.missing.includes('comparison'), true);
  assert.equal(vendor.measuredSpeedRatio, null);
  assert.equal(vendor.measuredCostRatio, null);
  assert.equal(JSON.stringify(vendor).includes('4'), false);

  await withRoots(async ({ workspace }) => {
    const approval = join(workspace, 'approved.json');
    await writeFile(approval, JSON.stringify({ approved: true, passed: true, measuredSpeedRatio: 3 }));
    const fromFile = await packUpgradeGate({
      manifest: validManifest(),
      workspace,
      workspaceApprovalPath: approval,
      privilegeDelta: { approved: true, channel: 'trusted-channel', source: 'workspace' },
      rollbackApproval: { approved: true, source: 'project-file' },
    });
    assert.equal(fromFile.activated, false);
    assert.equal(fromFile.missing.includes('privilege-delta'), true);
    assert.equal(fromFile.missing.includes('rollback'), true);
    assert.equal(fromFile.measuredSpeedRatio, null);
    assert.equal(JSON.stringify(fromFile).includes('3'), false);
  });
});

test('experimental route-worker and advise returns stay as the phase 20 tests assert', async () => {
  await withRoots(async ({ home, workspace }) => {
    const routed = await stagePackUpgrade({ home, workspace, manifestPath: ROUTING_PACK });
    assert.equal(routed.ok, false);
    assert.equal(routed.reasonCode, 'DRILL_REQUIRED');
    assert.notEqual(routed.activated, true);

    await mkdir(configDir(home), { recursive: true });
    await writeFile(join(configDir(home), 'host.json'), `${JSON.stringify(validHost())}\n`);
    await loadHostPolicy({ home, workspace });
    const advisePath = join(workspace, 'advise.json');
    await writeFile(
      advisePath,
      JSON.stringify(validManifest({ maturity: 'experimental', actions: ['advise', 'abstain'], defaultMode: 'advise' })),
    );
    const advised = await stagePackUpgrade({ home, workspace, manifestPath: advisePath });
    assert.equal(advised.ok, true);
    assert.equal(advised.activated, false);
    assert.equal(advised.reasonCode, 'PRIVILEGE_DELTA');
  });
});

/** Jevris config dir for this OS (BLD-09). */
function configDir(home) {
  return jevrisPaths({ home }).config;
}
