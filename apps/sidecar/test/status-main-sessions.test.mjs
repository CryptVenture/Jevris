import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// OD-8 (E f9a92f2, D 0b1fb09): the sidecar's status carries one main-session view per harness,
// from D's mainSessionView. With no recorded harness version nothing is certified, so no harness
// shows turns as switchable.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { surfacePayloadContract } = await import('@jevris/contracts');

test('status lists each harness main-session view in HARNESS_IDS order; uncertified Kilo and OpenCode are advice only', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-main-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const status = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
    assert.equal(status.ok, true, JSON.stringify(status));
    const views = status.result.mainSessions;
    assert.deepEqual(views.map((v) => v.harness), ['claude', 'kilocode', 'codex', 'opencode', 'antigravity']);
    const byHarness = Object.fromEntries(views.map((v) => [v.harness, v]));
    for (const h of ['kilocode', 'opencode']) assert.deepEqual(byHarness[h], { harness: h, mode: 'plugin-bounded-auto', turnSwitching: 'advice-only', reasonCode: 'TURN_ROUTE_UNCERTIFIED', sessionHost: null, tariff: null }, 'no session: no host (R54)');
    for (const h of ['claude', 'codex', 'antigravity']) assert.equal(byHarness[h].turnSwitching, 'advice-only');
    assert.equal(surfacePayloadContract('status').validate(status.result).ok, true);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
