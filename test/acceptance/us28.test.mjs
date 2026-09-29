import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load, story } from './lib.mjs';

// The administrator's host policy: the privileges any pack may use without review.
function hostPolicy(retentionDays) {
  return {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: retentionDays, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain', 'task-metadata'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
}

function pack(version, extra = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.log-helper',
    version,
    maturity: 'stable',
    description: 'Summarise failing test logs',
    requiresCapabilities: ['task-metadata'],
    fallbackCapabilities: [],
    decisionSpecs: ['task-profile.v1'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'observe',
    conflicts: [],
    fixtures: ['routing/eligibility'],
    ...extra,
  };
}

const NETWORK = 'network:logs.acme.invalid';
const EXECUTABLE = 'executable:bin/log-helper';

story('US28', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { jevrisPaths } = await load('platform');
  const config = jevrisPaths({ home: box.home, env: box.env }).config;
  const rel = (name) => relative(box.dir, join(config, name));
  const policy = (sub, extra = []) => box.jevris(['policy', sub, '--home', box.home, '--workspace', box.work, ...extra]);
  const read = (name) => (existsSync(join(config, name)) ? readFileSync(join(config, name), 'utf8') : null);

  // The administrator's policy is in force, then revised once (so a previous snapshot exists).
  box.write(rel('host.json'), hostPolicy(7));
  box.write('work/packs/log-helper-1.0.0.json', pack('1.0.0'));
  const first = policy('stage', ['--manifest', join(box.work, 'packs', 'log-helper-1.0.0.json')]);
  assert.equal(first.code, 0, `staging the current pack failed: ${first.stdout} ${first.stderr}`);
  const original = read('policy-active.json');
  assert.notEqual(original, null, 'the host policy was not activated');
  box.write(rel('host.json'), hostPolicy(14));
  assert.equal(policy('stage', ['--manifest', join(box.work, 'packs', 'log-helper-1.0.0.json')]).code, 0);
  const current = read('policy-active.json');
  assert.notEqual(current, original, 'the revised host policy is not active');
  assert.equal(read('policy-previous.json'), original, 'no previous policy snapshot to roll back to');

  // Given: the update adds a network destination and an executable component.
  box.write('work/packs/log-helper-1.1.0.json', pack('1.1.0', { requiresCapabilities: ['task-metadata', NETWORK, EXECUTABLE], dataScopes: ['task-metadata', 'approved-tool-output'] }));
  // A file in the repository that claims approval is not an approval.
  box.write('work/packs/approved.json', { approved: true, passed: true, channel: 'trusted-channel', source: 'workspace' });

  // When: the update is available and staged.
  const staged = policy('stage', ['--manifest', join(box.work, 'packs', 'log-helper-1.1.0.json')]);
  evidence({ code: staged.code, staged: read('policy-staged.json') });

  await then('Automatic activation stops until the declared permission delta is approved', () => {
    assert.equal(staged.code, 0, `staging failed: ${staged.stdout} ${staged.stderr}`);
    const record = JSON.parse(read('policy-staged.json') ?? 'null');
    assert.ok(record !== null, 'the update was not staged for review');
    assert.equal(record.activated, false, 'the update activated');
    assert.equal(record.reasonCode, 'PRIVILEGE_DELTA');
    // The declared delta is what a reviewer sees: the new destination, component and data scope.
    assert.ok(record.requiresCapabilities.includes(NETWORK) && record.requiresCapabilities.includes(EXECUTABLE), JSON.stringify(record));
    assert.ok(record.dataScopes.includes('approved-tool-output'));
    // Nothing the pack asked for reached the active policy.
    assert.equal(read('policy-active.json'), current, 'the active policy changed on an unapproved delta');
    const active = JSON.parse(current);
    for (const privilege of [NETWORK, EXECUTABLE, 'approved-tool-output']) assert.equal(active.packPrivileges.includes(privilege), false, `${privilege} became a pack privilege`);
    // Staging again (as an automatic updater would) still does not activate it.
    assert.equal(policy('stage', ['--manifest', join(box.work, 'packs', 'log-helper-1.1.0.json')]).code, 0);
    assert.equal(JSON.parse(read('policy-staged.json')).activated, false);
    assert.equal(read('policy-active.json'), current);
  });

  await then('rollback remains possible', () => {
    const rolled = policy('rollback');
    evidence({ code: rolled.code, active: read('policy-active.json') });
    assert.equal(rolled.code, 0, `rollback failed: ${rolled.stdout} ${rolled.stderr}`);
    assert.equal(read('policy-staged.json'), null, 'the staged update was not discarded');
    assert.equal(read('policy-active.json'), original, 'the previous policy was not restored');
  });
});
