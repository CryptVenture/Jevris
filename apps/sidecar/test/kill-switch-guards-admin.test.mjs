import test from 'node:test';
import assert from 'node:assert/strict';

// GOV-02..04 (JEV-0021), the second half: the task, verification and admin operations. The named
// exemptions (audit record, export and verify, store backup and export, the switch itself) each have
// their reason in docs/security.md.

const { loadOps } = await import('../dist/index.js');
const { adminOps } = await import('../dist/admin-ops.js');
const storeApi = await import('@jevris/store');

test('task.cancel, task.revert-duplicate and verification.record carry the kill-switch flag', async () => {
  const { ops } = await loadOps();
  for (const name of ['task.cancel', 'task.revert-duplicate', 'verification.record']) {
    const definition = ops.get(name);
    assert.ok(definition, `${name} is registered`);
    assert.equal(definition.stoppedByKillSwitch, true, `${name} must be stopped by the kill switch`);
  }
});

test('the admin ops: learning.purge is flagged, data.purge and authorization.mint refuse while stopped, and the named exemptions stay open', async () => {
  const defs = new Map(adminOps({ home: '/nonexistent', paths: { data: '/nonexistent/data' }, store: () => ({ store: {}, api: storeApi }) }).map((d) => [d.op, d]));
  assert.equal(defs.get('learning.purge').stoppedByKillSwitch, true, 'learning.purge is stopped by the kill switch');
  // Exempt, each for the reason in docs/security.md: the audit trail, the person's own data, and the switch itself.
  for (const name of ['audit.record', 'audit.export', 'audit.verify', 'store.backup', 'store.export', 'kill-switch.activate']) {
    assert.notEqual(defs.get(name).stoppedByKillSwitch, true, `${name} stays available while stopped`);
  }
  const ctx = (body, killSwitchStopped) => ({ body, killSwitchStopped, home: '/nonexistent', store: undefined });
  const purge = await defs.get('data.purge').handle(ctx({}, true));
  assert.equal(purge.reasonCode, 'KILL_SWITCH');
  assert.match(purge.message, /Clear the kill switch first/);
  const mint = await defs.get('authorization.mint').handle(ctx({ channel: 'terminal', actionClass: 'data.delete', scope: 'x', ttlMs: 60000 }, true));
  assert.equal(mint.reasonCode, 'KILL_SWITCH');
  assert.match(mint.message, /Clear the kill switch first/);
});
