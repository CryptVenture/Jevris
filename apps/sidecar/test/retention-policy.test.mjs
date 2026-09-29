import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA-11: the sweeper's retention uses the SSOT names from host.json, organization.json and
// jevris.config.json; policy files are validated by the contracts' HostDocument schema.

const { resolveRetention } = await import('../dist/retention-policy.js');
const { jevrisPaths } = await import('@jevris/platform');

function hostDocument(retention) {
  return {
    schemaVersion: '1.0',
    mode: 'observe',
    egress: 'deny-until-approved',
    retention,
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: [],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'TYPESAFE_API_KEY',
    allowUncalibratedActuation: false,
  };
}

function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvr-')));
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  try {
    return fn({ home, config, write: (name, value) => writeFileSync(join(config, name), typeof value === 'string' ? value : JSON.stringify(value)) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('no policy files: the 7 and 30 day defaults', () => {
  withHome(({ home }) => {
    const resolved = resolveRetention({ home });
    assert.deepEqual(resolved.policy, { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 });
    assert.equal(resolved.host, 'absent');
    assert.equal(resolved.organization, 'absent');
    assert.deepEqual(resolved.issues, []);
  });
});

test('a valid host.json with 3 and 10 days gives that retention', () => {
  withHome(({ home, write }) => {
    write('host.json', hostDocument({ rawArtifactRetentionDays: 3, decisionRetentionDays: 10 }));
    const resolved = resolveRetention({ home });
    assert.equal(resolved.host, 'ok');
    assert.deepEqual(resolved.policy, { rawArtifactRetentionDays: 3, decisionRetentionDays: 10 });
  });
});

test("an organization limit caps the user's longer choice, and never lengthens a shorter one", () => {
  withHome(({ home, write }) => {
    const user = { schemaVersion: '1.0' };
    // The user's jevris.config.json asks for 60 and 365 days.
    write(
      'jevris.config.json',
      JSON.stringify({
        ...user,
        mode: 'observe',
        provider: { kind: 'typesafe-direct', model: 'jev-1.13.0', credentialRef: 'host-secret:typesafe-primary' },
        decisions: { hotPathDeadlineMs: 900, backgroundDeadlineMs: 5000, maxRequestBytes: 131072, maxQuestions: 12, allowUncalibratedActuation: false },
        privacy: { sourceEgress: 'deny-until-approved', remoteTelemetry: 'off', rawArtifactRetentionDays: 60, decisionRetentionDays: 365 },
        routing: { mainSession: 'advice-only', managedWorkers: 'observe', respectHumanPins: true, calibrationArtifact: null },
        orchestration: { enabled: false, maxConcurrentWorkers: 2, maxWorkerDepth: 1, maxRepairAttempts: 2, maxStopContinuationsPerCondition: 1 },
        compaction: { nativeAutoDeferral: false, preserveMandatoryFacts: true, rawTranscriptEditing: false },
        packs: ['jevris.observability', 'jevris.memory', 'jevris.skill-advice'],
      }),
    );
    assert.deepEqual(resolveRetention({ home }).policy, { rawArtifactRetentionDays: 60, decisionRetentionDays: 365 });
    write('organization.json', hostDocument({ rawArtifactRetentionDays: 14, decisionRetentionDays: 90 }));
    const capped = resolveRetention({ home });
    assert.equal(capped.organization, 'ok');
    assert.deepEqual(capped.policy, { rawArtifactRetentionDays: 14, decisionRetentionDays: 90 });
    write('organization.json', hostDocument({ rawArtifactRetentionDays: 365, decisionRetentionDays: 3650 }));
    assert.deepEqual(resolveRetention({ home }).policy, { rawArtifactRetentionDays: 60, decisionRetentionDays: 365 });
  });
});

test('a host.json with unknown retention keys fails validation with its reason code, and retention stays at the stricter default', () => {
  withHome(({ home, write }) => {
    const bad = hostDocument({ rawDays: 3, redactedDays: 10 });
    write('host.json', bad);
    const resolved = resolveRetention({ home });
    assert.equal(resolved.host, 'invalid');
    assert.deepEqual(resolved.issues, ['HOST_POLICY_INVALID']);
    assert.deepEqual(resolved.policy, { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 });
    // An extra key beside the SSOT names is refused too, as is a file that is not JSON.
    write('host.json', hostDocument({ rawArtifactRetentionDays: 3, decisionRetentionDays: 10, rawDaysMin: 1 }));
    assert.equal(resolveRetention({ home }).host, 'invalid');
    write('organization.json', '{not json');
    assert.deepEqual(resolveRetention({ home }).issues, ['HOST_POLICY_INVALID', 'ORGANIZATION_POLICY_INVALID']);
  });
});
