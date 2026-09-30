import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Serving hosts R54 (design 8): each harness's main-session view in status names the host its
// newest active session runs through (a maker, a gateway or an inference host) and whether the
// router knows the model's tariff there (R48). An unknown tariff means advice only. Both are null
// with no recent session, an unrecorded model, or a spelling that does not resolve.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { surfacePayloadContract } = await import('@jevris/contracts');

test('status names each harness session host and whether its tariff is known (R54)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-host-status-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const send = (key, sessionId, harness, model) =>
      sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: key, envelope: { schemaVersion: '1.0', kind: 'session.started', sessionId, harness, model }, harnessVersion: '1.0.0' } });
    const status = async () => {
      const answer = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(surfacePayloadContract('status').validate(answer.result).ok, true);
      return Object.fromEntries(answer.result.mainSessions.map((v) => [v.harness, v]));
    };

    const before = await status();
    for (const h of ['claude', 'kilocode', 'codex', 'opencode', 'antigravity']) assert.deepEqual([before[h].sessionHost, before[h].tariff], [null, null], `${h}: no session yet`);

    assert.equal((await send('s-1', 'claude-s1', 'claude', 'claude-opus-5-5')).result.recorded, true);
    assert.equal((await send('s-2', 'kilo-s1', 'kilocode', 'openrouter/moonshotai/kimi-k3')).result.recorded, true);
    assert.equal((await send('s-3', 'oc-s1', 'opencode', 'nvidia/moonshotai/kimi-k3')).result.recorded, true);
    assert.equal((await send('s-4', 'codex-s1', 'codex', 'not-a-registered-model')).result.recorded, true);

    const after = await status();
    assert.deepEqual(after.claude.sessionHost, { id: 'anthropic', kind: 'maker' });
    assert.equal(after.claude.tariff, 'known');
    assert.deepEqual(after.kilocode.sessionHost, { id: 'openrouter', kind: 'gateway' });
    assert.equal(after.kilocode.tariff, 'known', 'the snapshot prices kimi-k3 on openrouter');
    assert.deepEqual(after.opencode.sessionHost, { id: 'nvidia', kind: 'inference-host' });
    assert.equal(after.opencode.tariff, 'unknown', 'no nvidia tariff: advice only');
    assert.deepEqual([after.codex.sessionHost, after.codex.tariff], [null, null], 'a spelling that does not resolve names no host');
    assert.deepEqual([after.antigravity.sessionHost, after.antigravity.tariff], [null, null]);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
