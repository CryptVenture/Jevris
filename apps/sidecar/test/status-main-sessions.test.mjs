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
const { recordHarnessVersion } = await import('@jevris/orchestrator');

test('status lists each harness main-session view in HARNESS_IDS order; a harness with no recorded version is not seen, one with a version and no record is uncertified', { skip: managedHostSkip() }, async () => {
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
    // No version recorded: nothing to certify, so it is not an uncertified harness (the dev-server report that said "uncertified" for harnesses that were never installed).
    for (const h of ['kilocode', 'opencode']) assert.deepEqual(byHarness[h], { harness: h, mode: 'plugin-bounded-auto', turnSwitching: 'advice-only', reasonCode: 'HARNESS_NOT_SEEN', sessionHost: null, tariff: null }, 'no session: no host (R54)');
    for (const h of ['claude', 'codex', 'antigravity']) assert.equal(byHarness[h].turnSwitching, 'advice-only');
    assert.equal(surfacePayloadContract('status').validate(status.result).ok, true);
    // A version recorded and no certification record: that one is uncertified, the other is still not seen.
    await recordHarnessVersion(home, 'kilocode', '7.8.1');
    const after = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
    assert.equal(after.ok, true, JSON.stringify(after));
    const reasons = Object.fromEntries(after.result.mainSessions.map((v) => [v.harness, v.reasonCode]));
    assert.deepEqual([reasons.kilocode, reasons.opencode, reasons.claude, reasons.codex], ['TURN_ROUTE_UNCERTIFIED', 'HARNESS_NOT_SEEN', 'HARNESS_ADVICE_ONLY', 'HARNESS_ADVICE_ONLY']);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
