import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Status carries live values, not placeholders: the effective mode for the workspace (D's
// readEffectiveConfig: your file, the workspace lowering, the organization ceiling), the pinned
// harness model the client names, and the workspace's owned tasks leased or running.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { surfacePayloadContract } = await import('@jevris/contracts');
const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');
const store = await import('@jevris/store');

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

test('status shows the effective mode, the named model pin and the active owned workers', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-status-live-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const status = async (body = {}) => {
      const answer = await sidecarRequest({ home, op: 'status', scope: 'mcp', workspace: root, body });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(surfacePayloadContract('status').validate(answer.result).ok, true);
      return answer.result;
    };

    // Defaults: bounded-auto (owner decision 0eb319de), no pin, no workers.
    let result = await status();
    assert.equal(result.jevrisMode, 'bounded-auto');
    assert.deepEqual(result.routing, { modelPin: null, pinned: false });
    assert.deepEqual(result.activeWorkers, []);

    // `jevris configure set mode advise` writes the user file: status follows it.
    writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode: 'advise' }));
    assert.equal((await status()).jevrisMode, 'advise');

    // The workspace's .jevris/config.json may lower the mode.
    mkdirSync(join(root, '.jevris'));
    writeFileSync(join(root, '.jevris', 'config.json'), JSON.stringify({ mode: 'observe' }));
    assert.equal((await status()).jevrisMode, 'observe', 'workspace lowering');
    // ...and never raise it.
    writeFileSync(join(root, '.jevris', 'config.json'), JSON.stringify({ mode: 'bounded-auto' }));
    assert.equal((await status()).jevrisMode, 'advise', 'a workspace file cannot raise the mode');
    rmSync(join(root, '.jevris'), { recursive: true, force: true });

    // The organization ceiling caps it.
    writeFileSync(join(config, 'organization.json'), JSON.stringify(organization('off')));
    result = await status();
    assert.equal(result.jevrisMode, 'off', 'organization ceiling');
    rmSync(join(config, 'organization.json'));
    // The global workspace (no root) reads the user file alone.
    const global = await sidecarRequest({ home, op: 'status', scope: 'cli', body: {} });
    assert.equal(global.ok, true, JSON.stringify(global));
    assert.equal(global.result.jevrisMode, 'advise');
    assert.deepEqual(global.result.activeWorkers, []);

    // A pinned harness model the client names is shown; a malformed or secret-shaped one is not.
    assert.deepEqual((await status({ modelPin: 'claude-opus-5-5' })).routing, { modelPin: 'claude-opus-5-5', pinned: true });
    assert.deepEqual((await status({ modelPin: 'not a model' })).routing, { modelPin: null, pinned: false });
    assert.deepEqual((await status({ modelPin: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).routing, { modelPin: null, pinned: false });

    // One owned task leased (a worker is starting) is an active worker; a validated one is not.
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root });
    const view = started.daemon.state.storeFor({ id: registered.result.id, root: registered.result.root });
    const task = (taskId, states) => {
      assert.equal(store.createTask(view, { taskId, ownerId: 'planner', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], record: { writeScopes: ['src'], risk: 'low' }, nowMs: 1 }).ok, true);
      for (const [to, actor] of states) assert.equal(store.transitionTask(view, { taskId, to, actor, reasonCode: 'TEST', nowMs: 2 }).ok, true, to);
    };
    task('T1', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]);
    task('T2', [['validated', 'planner']]);
    assert.deepEqual((await status()).activeWorkers, ['T1']);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
