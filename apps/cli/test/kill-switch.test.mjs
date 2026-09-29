import test from 'node:test';
import assert from 'node:assert/strict';
import { jevrisPaths } from '../../../packages/platform/dist/index.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const { rollbackPolicy } = await import('../dist/pack-policy.js');
const { auditPath, drillRecordPath, killSwitchPath, runKillSwitchDrill } = await import('../dist/kill-switch.js');
const { closeStore, commitOwned, effectDisposition, openStore } = await import('@jevris/store');

const WORKSPACE_ID = 'wsFlag';
const HOST_SCOPE = 'hostA';
const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';

function validHost() {
  return {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
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

test('kill switch flag is not written by rollback and an acknowledged effect is not re-run', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'jevris-cli-flag-'));
  const home = join(parent, 'home');
  const workspace = join(parent, 'workspace');
  const ledgerPath = join(parent, 'ledger.sqlite');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configDir(home), { recursive: true });
  const snapshot = `${JSON.stringify(validHost())}\n`;
  writeFileSync(join(configDir(home), 'host.json'), snapshot);
  writeFileSync(join(configDir(home), 'policy-previous.json'), snapshot);
  try {
    const rolled = await rollbackPolicy({ home, workspace });
    assert.equal(rolled.ok, true);
    assert.equal(absent(killSwitchPath(home)), true);
    assert.equal(absent(drillRecordPath(home)), true);

    const seeded = openStore({
      path: ledgerPath,
      role: 'in-process-test',
      workspaceId: WORKSPACE_ID,
      hostScope: HOST_SCOPE,
    });
    assert.equal(seeded.ok, true);
    const acknowledged = commitOwned(seeded, {
      decisionId: 'decAck',
      operationId: 'opAck',
      reservationMicroUsd: 1n,
      acknowledgment: 'present',
    });
    assert.equal(acknowledged.ok, true);
    closeStore(seeded);

    let effectCount = 0;
    const drilled = await runKillSwitchDrill({
      home,
      workspace,
      ledgerPath,
      workspaceId: WORKSPACE_ID,
      hostScope: HOST_SCOPE,
      acknowledgedOperationIds: ['opAck'],
      fixture: { canary: 'fixture-fired', source: SOURCE_CANARY },
      effect() {
        effectCount += 1;
      },
    });
    assert.equal(drilled.ok, true);
    assert.equal(effectCount, 0);
    const opened = openStore({
      path: ledgerPath,
      role: 'in-process-test',
      workspaceId: WORKSPACE_ID,
      hostScope: HOST_SCOPE,
    });
    assert.equal(opened.ok, true);
    const disposition = effectDisposition(opened, 'opAck');
    assert.equal(disposition.effectStatus, 'acknowledged');
    assert.equal(disposition.outboxCount, 1);
    assert.equal(disposition.repeatable, false);
    closeStore(opened);
    const audit = readFileSync(auditPath(home), 'utf8');
    assert.equal(audit.includes(SOURCE_CANARY), false);
    assert.equal(audit.includes('source'), false);
    assert.equal(audit.includes('\u001b'), false);
    assert.equal(audit.includes('canary fixture not a detector'), true);
    assert.equal(drilled.text.includes(SOURCE_CANARY), false);
    assert.equal(drilled.text.includes('\u001b'), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** Jevris config dir for this OS (BLD-09). */
function configDir(home) {
  return jevrisPaths({ home }).config;
}
