import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// P5 end to end (owner decision 7922ee3; C 3185b71, B 0d977da): in the running sidecar with its
// real store, every delivery of main-route advice is opened for adherence; a session event that
// changes the model to another one resolves it as overridden; advice the session did not follow
// twice is not repeated in that session, a new session starts at 0, and route learning is not fed.
// Rules-only: the keyring is blocked under the test runner, so no provider is called.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { hostScopeId } = await import('../dist/state.js');
const { jevrisPaths } = await import('@jevris/platform');
const store = await import('@jevris/store');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { TEST_CALIBRATION_KEYS_ENV } = await import('@jevris/provider-typesafe');

const SLICE = 'bounded-edit';
const ACCOUNT = 'acct-p5-e2e';
const KEYS = generateKeyPairSync('ed25519');
const KEY_ID = 'calibration-p5-e2e';
const QUALITIES = [
  { modelId: 'claude-opus-5', sliceId: SLICE, lower: 0.9, point: 0.94, upper: 0.97, sampleSize: 60 },
  { modelId: 'claude-sonnet-5', sliceId: SLICE, lower: 0.86, point: 0.9, upper: 0.94, sampleSize: 60 },
];

function prepareHome(home) {
  const paths = jevrisPaths({ home });
  mkdirSync(paths.state, { recursive: true });
  writeFileSync(join(paths.state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }));
  chmodSync(join(paths.state, 'test-home.json'), 0o600);
  const keys = join(home, 'test-keys.json');
  writeFileSync(keys, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: KEY_ID, role: 'calibration', publicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  mkdirSync(paths.config, { recursive: true });
  const registry = { ...core.BUNDLED_MODEL_REGISTRY, entries: core.BUNDLED_MODEL_REGISTRY.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })) };
  writeFileSync(join(paths.config, 'model-registry.json'), JSON.stringify(registry));
  writeFileSync(core.routingPolicyFile(home), JSON.stringify({ schemaVersion: '1.0', accountId: ACCOUNT }));
  const nowMs = Date.now(); // pinned-clock: the sidecar routes on the real clock, so the release is signed at it
  const context = core.workerCalibrationContext({ sliceId: SLICE, nowMs });
  const artifact = contracts.signRecord(
    {
      id: 'cal-p5-e2e', schemaVersion: '1.0', releaseState: 'released',
      decisionSpecId: context.decisionSpecId, decisionSpecVersion: context.decisionSpecVersion,
      dataset: { id: 'synthetic-routing', version: 'v1', contentHash: `sha256:${'d'.repeat(64)}` },
      questionHash: context.questionHash, model: { modelId: context.modelId, revisionHash: context.modelRevisionHash }, encoderHash: context.encoderHash,
      threshold: { metric: 'noul-probability', value: 0.8, errorBudget: 0.05 },
      permittedSlices: [{ sliceId: SLICE, calibrationSampleSize: 120, holdoutSampleSize: 60 }],
      uncertaintyInterval: { lower: 0.82, upper: 0.93, confidenceLevel: 0.95, method: 'wilson' },
      reviewer: { id: 'reviewer-1', reviewedAt: new Date(nowMs - 2 * 86_400_000).toISOString() },
      issuedAt: new Date(nowMs - 86_400_000).toISOString(), expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(),
      expiryConditions: ['model-revision-changed'], modelQualities: QUALITIES,
    },
    KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    KEY_ID,
  );
  const file = core.calibrationFileFor(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(artifact));
  return keys;
}

test('P5 through the sidecar: advice not followed twice in a session is not repeated there; a new session starts again; learning is not fed', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'c-p5-')));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const previous = process.env[TEST_CALIBRATION_KEYS_ENV];
  process.env[TEST_CALIBRATION_KEYS_ENV] = prepareHome(home);
  try {
    const started = await startDaemon({ home, idleMs: 0, log: () => undefined, liveCertification: false, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    let ws;
    try {
      let seq = 0;
      const event = async (sessionId, kind, model, payload = {}) => {
        seq += 1;
        const key = `p5-${seq}`;
        const res = await sidecarRequest({ home, op: 'event', workspace: repo, scope: 'hook', timeoutMs: 60_000, body: { deliveryKey: key, envelope: { schemaVersion: '1.0', harness: 'claude', nativeEventName: kind, kind, sessionId, model, payload, dedupKey: key, flags: {} } } });
        assert.equal(res.ok, true, JSON.stringify(res));
      };
      const ask = async (sessionId) => {
        const res = await sidecarRequest({ home, op: 'route', workspace: repo, scope: 'cli', body: { currentModel: 'claude-opus-5', sliceId: SLICE, sessionId, remaining: { inputTokens: 2_000_000, outputTokens: 200_000 }, session: { warmPrefixTokens: 0, atBoundary: true } } });
        assert.equal(res.ok, true, JSON.stringify(res));
        return res.result.main;
      };
      await event('s1', 'session.started', 'claude-opus-5');
      const first = await ask('s1');
      assert.deepEqual([first.outcome, first.recommendedModel], ['recommend', 'claude-sonnet-5'], JSON.stringify(first));
      // Shown again without a switch: the first delivery closes as no-change (1).
      assert.equal((await ask('s1')).outcome, 'recommend');
      // The session switches to another model than advised: the open advice is overridden (2).
      await event('s1', 'model.changed', 'claude-opus-5', { toModel: 'claude-haiku-5' });
      const quiet = await ask('s1');
      assert.deepEqual([quiet.outcome, quiet.recommendedModel, quiet.reasonCode], ['abstain', null, 'ADVICE_NOT_FOLLOWED'], JSON.stringify(quiet));
      // Another session starts at 0.
      await event('s2', 'session.started', 'claude-opus-5');
      assert.equal((await ask('s2')).outcome, 'recommend');

      ws = (await sidecarRequest({ home, op: 'workspace.register', workspace: repo, scope: 'cli' })).result.id;
      const view = started.daemon.state.storeFor({ id: ws, root: realpathSync(repo) });
      assert.equal(store.adviceOverrides(view, { sessionId: 's1', adviceKind: 'main-route', slice: SLICE, advisedModel: 'claude-sonnet-5' }), 2);
      // A new session starts at 0: its first line is open and not yet followed (1, JEV-0081), below the limit of 2, so it was shown.
      assert.equal(store.adviceOverrides(view, { sessionId: 's2', adviceKind: 'main-route', slice: SLICE, advisedModel: 'claude-sonnet-5' }), 1);
    } finally {
      await started.daemon.stop('test');
    }
    // Adherence never feeds the routing posterior: no learning state was written for the workspace.
    assert.equal(await core.loadLearningState({ home, workspaceId: ws }), null);
    const opened = store.openStore({ path: join(jevrisPaths({ home }).data, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: hostScopeId(home) });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    try {
      // Three deliveries opened (the suppressed answer opened nothing): no-change and overridden in s1, open in s2.
      assert.deepEqual(store.adviceAdherenceCounts(opened, { workspaceId: ws, sinceMs: 0 }), { 'main-route': { 'no-change': 1, overridden: 1, open: 1 } });
    } finally {
      store.closeStore(opened);
    }
  } finally {
    if (previous === undefined) delete process.env[TEST_CALIBRATION_KEYS_ENV];
    else process.env[TEST_CALIBRATION_KEYS_ENV] = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
