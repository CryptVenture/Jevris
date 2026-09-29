import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { surfacePayloadContract } from '@jevris/contracts';
import { DEFAULT_CONFIG, raiseRefusal, OWNED_MODE_OP, effectiveRetention, ownedModeEnabled, ownedModeRecord, setOwnedMode, workspaceIdFor, loadEffectiveConfig, readEffectiveConfig, readOrganizationPolicy, renderConfigDiff, setConfigValue } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

function fixture() {
  const dir = tempDir('jv-set-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.jevris'), { recursive: true }); // test-hygiene: not product source
  const configDir = jevrisPaths({ home }).config;
  mkdirSync(configDir, { recursive: true });
  return { home, repo, configDir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('defaults load, and the payload matches the configure contract (SET-02)', async () => {
  const f = fixture();
  try {
    const payload = await loadEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
    assert.equal(surfacePayloadContract('configure').validate(payload).ok, true);
    assert.equal(payload.source, 'defaults');
    assert.equal(payload.effective.mode, 'bounded-auto');
    assert.equal(payload.nativePermissionsChanged, false);
  } finally {
    f.done();
  }
});

test('unknown keys are refused and an invalid file falls back to defaults with issues, the mode capped at observe (SET-02, SR-20)', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.configDir, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, surprise: 1 }));
    const eff = readEffectiveConfig({ home: f.home });
    assert.equal(eff.valid, false);
    assert.ok(eff.issues.length > 0);
    assert.equal(eff.config.mode, 'observe');
    assert.ok(eff.issues.some((issue) => issue.path === 'user:' && issue.code === 'INVALID_CONFIG'));
  } finally {
    f.done();
  }
});

test('a workspace file and organization policy only narrow (SET-02)', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.configDir, 'jevris.config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, mode: 'advise', orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 8 } }),
    );
    writeFileSync(
      join(f.repo, '.jevris', 'config.json'), // test-hygiene: not product source
      JSON.stringify({ orchestration: { maxConcurrentWorkers: 20, maxRepairAttempts: 1 }, privacy: { sourceEgress: 'approved-scoped' } }),
    );
    const eff = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
    assert.equal(eff.config.orchestration.maxConcurrentWorkers, 8, 'a workspace cannot raise a cap');
    assert.equal(eff.config.orchestration.maxRepairAttempts, 1);
    assert.equal(eff.config.privacy.sourceEgress, 'deny-until-approved', 'a workspace cannot widen egress');
    assert.ok(eff.issues.some((i) => i.code === 'NOT_NARROWABLE'));
    writeFileSync(
      join(f.configDir, 'organization.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        mode: 'observe',
        egress: 'deny-until-approved',
        retention: { rawArtifactRetentionDays: 3, decisionRetentionDays: 10 },
        budget: { maxRequestBytes: 65536 },
        pin: { model: 'jev-1.13.0', respectHumanPins: true },
        packPrivileges: [],
        credentialRef: 'host-secret:typesafe-primary',
        installerEnvName: 'TYPESAFE_API_KEY',
        allowUncalibratedActuation: false,
      }),
    );
    const org = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
    assert.equal(org.config.mode, 'observe');
    assert.equal(org.config.privacy.rawArtifactRetentionDays, 3);
    assert.equal(org.config.decisions.maxRequestBytes, 65536);
    assert.ok(org.narrowed.some((n) => n.layer === 'organization' && n.key === 'mode'));
  } finally {
    f.done();
  }
});

test('managed-worker routing is bounded-auto from install; raising it again needs a person at a terminal (owner decision 7922ee3, SR-19)', async () => {
  const f = fixture();
  try {
    const shown = await loadEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
    assert.deepEqual([shown.effective.managedWorkers, shown.effective.orchestrationEnabled], ['bounded-auto', true]);
    const file = join(f.configDir, 'jevris.config.json');
    assert.equal((await setConfigValue({ home: f.home, key: 'routing.managedWorkers', value: 'observe', dryRun: false })).changed.length, 1, 'observe needs no confirmation');
    // Paired: bounded-auto without confirmation is refused and writes nothing; a dry run shows it; confirmed, it is written.
    const refused = await setConfigValue({ home: f.home, key: 'routing.managedWorkers', value: 'bounded-auto', dryRun: false });
    assert.deepEqual([refused.ok, refused.reasonCode, refused.message], [false, 'CHANNEL_REFUSED', raiseRefusal('routing.managedWorkers', 'bounded-auto')]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).routing.managedWorkers, 'observe');
    const dry = await setConfigValue({ home: f.home, key: 'routing.managedWorkers', value: 'bounded-auto', dryRun: true });
    assert.deepEqual(dry.changed, [{ key: 'routing.managedWorkers', from: 'observe', to: 'bounded-auto' }]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).routing.managedWorkers, 'observe');
    const confirmed = await setConfigValue({ home: f.home, key: 'routing.managedWorkers', value: 'bounded-auto', dryRun: false, confirmed: true });
    assert.deepEqual([confirmed.effective.managedWorkers, JSON.parse(readFileSync(file, 'utf8')).routing.managedWorkers], ['bounded-auto', 'bounded-auto']);
    // The organization's mode still caps it.
    writeFileSync(join(f.configDir, 'organization.json'), JSON.stringify({ schemaVersion: '1.0', mode: 'advise', egress: 'deny-until-approved', retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, budget: { maxRequestBytes: 131072 }, pin: { model: 'jev-1.13.0', respectHumanPins: true }, packPrivileges: [], credentialRef: 'host-secret:typesafe-primary', installerEnvName: 'TYPESAFE_API_KEY', allowUncalibratedActuation: false }));
    assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.routing.managedWorkers, 'advise');
  } finally {
    f.done();
  }
});

test('routing.modelListing is on by default, settable on or off, and a workspace may only turn it off', async () => {
  const f = fixture();
  try {
    assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.routing.modelListing, 'on');
    assert.match((await setConfigValue({ home: f.home, key: 'routing.modelListing', value: 'maybe', dryRun: false })).message, /not a valid value/);
    assert.equal((await setConfigValue({ home: f.home, key: 'routing.modelListing', value: 'off', dryRun: false })).changed[0].to, 'off');
    const ws = join(f.repo, '.jevris', 'config.json'); // test-hygiene: not product source
    // Paired: with the user's off, a workspace on changes nothing; with the user's on, a workspace off turns it off.
    writeFileSync(ws, JSON.stringify({ routing: { modelListing: 'on' } }));
    assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.routing.modelListing, 'off');
    await setConfigValue({ home: f.home, key: 'routing.modelListing', value: 'on', dryRun: false });
    assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.routing.modelListing, 'on');
    writeFileSync(ws, JSON.stringify({ routing: { modelListing: 'off' } }));
    const eff = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
    assert.equal(eff.config.routing.modelListing, 'off');
    assert.ok(eff.narrowed.some((n) => n.layer === 'workspace' && n.key === 'routing.modelListing'));
  } finally {
    f.done();
  }
});

test('set --dry-run shows a diff and writes nothing; set writes only product keys; admin keys refuse (SET-03)', async () => {
  const f = fixture();
  try {
    const dry = await setConfigValue({ home: f.home, key: 'orchestration.enabled', value: 'false', dryRun: true });
    assert.equal(surfacePayloadContract('configure').validate(dry).ok, true);
    assert.deepEqual(dry.changed, [{ key: 'orchestration.enabled', from: 'true', to: 'false' }]);
    assert.equal(existsSync(join(f.configDir, 'jevris.config.json')), false);
    assert.match(renderConfigDiff(dry.changed, true), /^- orchestration.enabled: true\n\+ orchestration.enabled: false\nDry run/);
    const real = await setConfigValue({ home: f.home, key: 'orchestration.maxConcurrentWorkers', value: '3', dryRun: false });
    assert.equal(real.changed[0].to, '3');
    assert.equal(JSON.parse(readFileSync(join(f.configDir, 'jevris.config.json'), 'utf8')).orchestration.maxConcurrentWorkers, 3);
    assert.equal(real.nativePermissionsChanged, false);
    assert.match((await setConfigValue({ home: f.home, key: 'privacy.sourceEgress', value: 'approved-scoped', dryRun: false })).message, /administrator/);
    assert.match((await setConfigValue({ home: f.home, key: 'nope', value: '1', dryRun: false })).message, /not a setting/);
    assert.match((await setConfigValue({ home: f.home, key: 'orchestration.maxConcurrentWorkers', value: '99', dryRun: false })).message, /not a valid value/);
  } finally {
    f.done();
  }
});

test('organization.json is parsed by one validator; retention is capped by the organization maximums (SSOT 16.3)', () => {
  const f = fixture();
  try {
    assert.deepEqual(readOrganizationPolicy({ home: f.home }), { state: 'absent' });
    assert.deepEqual(effectiveRetention({ home: f.home }), { rawArtifactRetentionDays: 7, decisionRetentionDays: 30, organization: 'absent' });
    writeFileSync(join(f.configDir, 'organization.json'), JSON.stringify({ schemaVersion: '1.0', retention: { rawDaysMax: 99 } }));
    assert.equal(readOrganizationPolicy({ home: f.home }).state, 'invalid');
    assert.equal(effectiveRetention({ home: f.home }).organization, 'invalid');
    writeFileSync(
      join(f.configDir, 'organization.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        mode: 'advise',
        egress: 'deny-until-approved',
        retention: { rawArtifactRetentionDays: 2, decisionRetentionDays: 60 },
        budget: { maxRequestBytes: 131072 },
        pin: { model: 'jev-1.13.0', respectHumanPins: true },
        packPrivileges: [],
        credentialRef: 'host-secret:typesafe-primary',
        installerEnvName: 'TYPESAFE_API_KEY',
        allowUncalibratedActuation: false,
      }),
    );
    const policy = readOrganizationPolicy({ home: f.home });
    assert.equal(policy.state, 'ok');
    assert.equal(policy.policy.retention.rawArtifactRetentionDays, 2);
    assert.deepEqual(effectiveRetention({ home: f.home }), { rawArtifactRetentionDays: 2, decisionRetentionDays: 30, organization: 'ok' });
  } finally {
    f.done();
  }
});

test('owned mode is off by default, changes only through the CLI channel, and is read per workspace (TOOL-10, IPC-10)', async () => {
  const f = fixture();
  try {
    const wsId = workspaceIdFor(f.repo);
    assert.match(wsId, /^w[0-9a-f]{24}$/);
    assert.equal(ownedModeEnabled(f.home, wsId), false);
    assert.deepEqual(await setOwnedMode({ home: f.home, workspaceId: wsId, enabled: true, channel: 'mcp' }), { ok: false, reasonCode: 'CHANNEL_REFUSED' });
    assert.equal((await setOwnedMode({ home: f.home, workspaceId: 'bad id', enabled: true, channel: 'cli' })).ok, false);
    const on = await setOwnedMode({ home: f.home, workspaceId: wsId, enabled: true, channel: 'cli', actor: 'alice' });
    assert.equal(on.ok, true);
    assert.equal(ownedModeEnabled(f.home, wsId), true);
    assert.equal(ownedModeRecord(f.home, wsId).changedBy, 'alice');
    assert.equal(ownedModeEnabled(f.home, 'wother'), false);
    assert.equal(OWNED_MODE_OP, 'task.submit');
    await setOwnedMode({ home: f.home, workspaceId: wsId, enabled: false, channel: 'cli' });
    assert.equal(ownedModeEnabled(f.home, wsId), false);
  } finally {
    f.done();
  }
});
