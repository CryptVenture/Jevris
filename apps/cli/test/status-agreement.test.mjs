// `jevris status` answers the same mode, model pin and workers from the sidecar (full) and from
// local state (reduced) for the same settings: both read D's effective-settings resolver, and the
// CLI sends the pinned harness model with the request. A temporary home, an in-process sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { startDaemon, sidecarRequest } = await import('@jevris/sidecar');
const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

const organization = (mode) => ({
  schemaVersion: '1.0',
  mode,
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 131072 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
});

function ports(forward) {
  return {
    sidecar: {
      async ensure() {
        return forward ? { ok: true, endpoint: 'in-process', started: false } : NOT_RUNNING;
      },
      async request(input) {
        return forward ? sidecarRequest(input) : NOT_RUNNING;
      },
    },
    engine: {},
    config: {},
  };
}

test('status from the sidecar and the local reduced status agree on mode, model pin and workers', { skip: managedHostSkip() }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-status-agree-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(() => started.daemon.stop('test'));

  const status = async (forward, extraEnv = {}) => {
    let text = '';
    const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', ...extraEnv };
    const code = await runPublicCommand('status', ['--json'], (chunk) => (text += chunk), { ports: ports(forward), env, cwd: workspace, nowMs: () => Date.UTC(2026, 8, 28) });
    assert.equal(code, 0, text);
    const out = JSON.parse(text.trimEnd().split('\n').at(-1));
    assert.equal(out.mode, forward ? 'full' : 'reduced', text);
    return out.result;
  };
  const agree = async (label, expectedMode, extraEnv = {}) => {
    const full = await status(true, extraEnv);
    const reduced = await status(false, extraEnv);
    assert.equal(full.jevrisMode, expectedMode, `${label}: sidecar mode`);
    assert.equal(reduced.jevrisMode, expectedMode, `${label}: local mode`);
    assert.deepEqual(full.routing, reduced.routing, `${label}: routing`);
    assert.deepEqual(full.activeWorkers, reduced.activeWorkers, `${label}: workers`);
    assert.equal(full.modeSource, reduced.modeSource, `${label}: mode source`);
    assert.deepEqual(full.settingsIssues, reduced.settingsIssues, `${label}: settings issues`);
    assert.deepEqual(full.mainSessions.map((s) => [s.harness, s.mode]), reduced.mainSessions.map((s) => [s.harness, s.mode]), `${label}: main sessions`);
    return full;
  };

  await agree('defaults', 'bounded-auto');
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode: 'advise' }));
  assert.equal((await agree('user file', 'advise')).modeSource, 'user');
  mkdirSync(join(workspace, '.jevris'));
  writeFileSync(join(workspace, '.jevris', 'config.json'), JSON.stringify({ mode: 'observe' }));
  assert.equal((await agree('workspace lowering', 'observe')).modeSource, 'workspace');
  rmSync(join(workspace, '.jevris'), { recursive: true, force: true });
  writeFileSync(join(config, 'organization.json'), JSON.stringify(organization('off')));
  assert.equal((await agree('organization ceiling', 'off')).modeSource, 'organization');
  rmSync(join(config, 'organization.json'));
  writeFileSync(join(config, 'host.json'), JSON.stringify(organization('observe')), { mode: 0o600 });
  assert.equal((await agree('host ceiling', 'observe')).modeSource, 'host');
  writeFileSync(join(config, 'host.json'), '{ not json', { mode: 0o600 });
  const invalid = await agree('invalid host.json', 'observe');
  assert.deepEqual(invalid.settingsIssues, [{ path: 'host:', code: 'INVALID_JSON' }]);
  rmSync(join(config, 'host.json'));
  const pinned = await agree('model pin', 'advise', { ANTHROPIC_MODEL: 'claude-opus-5-5' });
  assert.deepEqual(pinned.routing, { modelPin: 'claude-opus-5-5', pinned: true });
});
