import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GOV-10: credential set and clear, policy changes and egress refusals are audit rows in the
// hash-chained log, with content-free detail. A CLI action taken while no sidecar runs is kept
// in a private pending file and appended, with its original time, when the sidecar next starts.

const { startDaemon } = await import('../dist/index.js');
const { hostScopeId, PENDING_AUDIT_FILE } = await import('../dist/state.js');
const { jevrisPaths } = await import('@jevris/platform');
const store = await import('@jevris/store');
const { main } = await import('../../cli/dist/cli.js');
const { recordCliAudit } = await import('../../cli/dist/runtime-commands.js');

const CANARY = ['gov10', 'canary', process.pid].join('-');

function memoryKeyring() {
  let value;
  return () => ({
    set(next) {
      value = next;
    },
    get() {
      return value;
    },
    delete() {
      value = undefined;
    },
  });
}

async function cli(args, hooks) {
  let text = '';
  const code = await main(args, (chunk) => (text += chunk), hooks);
  return { code, text };
}

function auditRows(home) {
  const opened = store.openStore({ path: join(jevrisPaths({ home }).data, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: hostScopeId(home) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  try {
    assert.equal(store.verifyAuditChain(opened).ok, true, 'the audit chain is intact');
    return store.readAudit(opened);
  } finally {
    store.closeStore(opened);
  }
}

test('credential set and clear, egress refusals and deferred CLI actions are audit rows without content (GOV-10)', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-audit-')));
  mkdirSync(join(home, 'repo'));
  const saved = process.env.JEVRIS_HOME;
  process.env.JEVRIS_HOME = home;
  const openKeyring = memoryKeyring();
  try {
    // No sidecar yet: the credential set is kept as a pending row.
    assert.equal((await cli(['credential', 'set'], { openKeyring, readStdin: () => new TextEncoder().encode(CANARY) })).code, 0);
    const pending = join(jevrisPaths({ home }).state, PENDING_AUDIT_FILE);
    assert.equal(existsSync(pending), true, 'the action was kept for the next sidecar start');

    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    try {
      await started.daemon.state.startupMaintenance();
      assert.equal(existsSync(pending), false, 'the pending rows were appended and the file removed');
      // With the sidecar running the row is written at once.
      assert.equal((await cli(['credential', 'clear'], { openKeyring })).code, 0);
      // The engine's transport guard reports a refusal.
      started.daemon.state.recordEgressRefusal('EGRESS_SECRET_BLOCKED', 2);
    } finally {
      await started.daemon.stop('test');
    }
    const rows = auditRows(home);
    const set = rows.find((row) => row.kind === 'credential.set');
    assert.ok(set, JSON.stringify(rows.map((row) => row.kind)));
    assert.equal(set.channel, 'cli');
    assert.equal(set.detail.deferred, true);
    assert.ok(rows.some((row) => row.kind === 'credential.remove' && row.detail.deferred === undefined));
    const egress = rows.find((row) => row.kind === 'egress.decision');
    assert.deepEqual(egress.detail, { decision: 'refused', fields: 2, reasonCode: 'EGRESS_SECRET_BLOCKED' });
    assert.equal(JSON.stringify(rows).includes(CANARY), false, 'no credential value in the audit log');
  } finally {
    if (saved === undefined) delete process.env.JEVRIS_HOME;
    else process.env.JEVRIS_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('egress approve and revoke are recordable CLI audit kinds, deferred or direct, and the sidecar exports the egress resolver', async () => {
  const sidecar = await import('../dist/index.js');
  assert.equal(typeof sidecar.resolveSourceEgress, 'function');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-audit-egress-')));
  try {
    assert.equal(sidecar.resolveSourceEgress({ home }), 'not-approved', 'no host policy is no approval');
    // No sidecar yet: the approval waits in the pending file.
    await recordCliAudit('egress.enable', { egress: 'approved-scoped', created: true, source: 'host.json' }, home);
    const pending = join(jevrisPaths({ home }).state, PENDING_AUDIT_FILE);
    assert.equal(existsSync(pending), true);
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    try {
      await started.daemon.state.startupMaintenance();
      assert.equal(existsSync(pending), false, 'the pending egress row was appended');
      // With the sidecar running the audit.record op accepts the revoke at once.
      await recordCliAudit('egress.revoke', { egress: 'deny-until-approved' }, home);
      assert.equal(existsSync(pending), false, 'the revoke went through the sidecar, not the pending file');
    } finally {
      await started.daemon.stop('test');
    }
    const rows = auditRows(home);
    const enable = rows.find((row) => row.kind === 'egress.enable');
    assert.ok(enable, JSON.stringify(rows.map((row) => row.kind)));
    assert.equal(enable.channel, 'cli');
    assert.equal(enable.detail.deferred, true);
    assert.equal(enable.detail.egress, 'approved-scoped');
    assert.equal(enable.detail.created, true);
    const revoke = rows.find((row) => row.kind === 'egress.revoke');
    assert.ok(revoke);
    assert.equal(revoke.detail.deferred, undefined);
    assert.equal(revoke.detail.egress, 'deny-until-approved');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
