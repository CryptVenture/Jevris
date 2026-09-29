import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// K4 (sidecar concurrency audit; owner decisions ededdba): the decision journal is pruned on the
// retention window, so the store's re-archive cannot bring swept rows back. Unknown effects stay.
const core = await import('@jevris/core');
const { DecisionJournal, journalEntryCreatedAtMs } = core;

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-27T12:00:00Z'); // pinned-clock: entries are dated against this time
const CUTOFF = NOW - 30 * DAY;

function draft(extra = {}) {
  return {
    specId: 'task-profile', specVersion: 'v1', workspaceId: 'wK4', taskId: null, evidenceRevision: 'rev-1', lane: 'interactive', mode: 'observe',
    receivedAt: new Date(NOW).toISOString(), questionHash: `sha256:${'a'.repeat(64)}`, packetHash: null, reservationId: null, reservedMicroUsd: 0,
    sent: false, usage: null, modelResolved: null, ...extra,
  };
}
function record(id, billingBasis = 'no-provider-call') {
  return {
    schemaVersion: '1.0', decisionId: id, specId: 'task-profile', modelResolved: null, mode: 'observe', evidenceRevision: 'rev-1', outcome: 'abstained',
    reasonCodes: ['RULES_ONLY'], proposedAction: { kind: 'abstain', reasonCode: 'RULES_ONLY' }, appliedAction: null, usage: null, billingBasis, actualTaskOutcome: 'not-yet-observed',
  };
}
const id = (n) => `d-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function entry(n, atMs, { state = 'abstained', rec = record(id(n)), sent = false } = {}) {
  return { schemaVersion: 1, decisionId: id(n), state, history: [{ state: 'received', atMs }, { state, atMs: atMs + 5 }], draft: draft({ sent }), record: rec, schemaFailure: null };
}

test('prune removes at-rest entries received before the cutoff and keeps the window and every unknown effect', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-journal-prune-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new DecisionJournal(dir, () => NOW);
  // Learn the on-disk version from a real entry, then write fixtures in the same shape.
  const created = await journal.create(id(99), draft());
  assert.equal(created.ok, true);
  const version = created.entry.schemaVersion;
  const write = (e) => writeFileSync(join(dir, `${e.decisionId}.json`), `${JSON.stringify({ ...e, schemaVersion: version })}\n`);
  write(entry(1, CUTOFF - DAY)); // old, at rest: removed
  write(entry(2, CUTOFF - DAY, { state: 'planned' })); // old advisory rest: removed
  write(entry(3, CUTOFF + DAY)); // inside the window: kept
  write(entry(4, CUTOFF - DAY, { rec: record(id(4), 'estimate-pending-reconcile') })); // usage pending: kept
  write(entry(5, CUTOFF - DAY, { state: 'evaluating', rec: null, sent: true })); // in flight after sending: kept
  write(entry(6, CUTOFF - DAY, { state: 'validated', rec: null, sent: false })); // in flight, nothing sent: removed
  writeFileSync(join(dir, `${id(7)}.json`), 'not json'); // unreadable: left alone
  assert.equal(journalEntryCreatedAtMs(entry(1, 1234)), 1234);

  const dry = await journal.prune({ beforeMs: CUTOFF, dryRun: true });
  assert.deepEqual(dry, { removed: 3, kept: 2, keptForReconciliation: 2, unreadable: 1, failed: 0 });
  assert.equal(existsSync(join(dir, `${id(1)}.json`)), true, 'a dry run removes nothing');
  const pruned = await journal.prune({ beforeMs: CUTOFF });
  assert.deepEqual(pruned, dry);
  for (const n of [1, 2, 6]) assert.equal(existsSync(join(dir, `${id(n)}.json`)), false, `entry ${n} removed`);
  for (const n of [3, 4, 5, 7, 99]) assert.equal(existsSync(join(dir, `${id(n)}.json`)), true, `entry ${n} kept`);
  assert.equal(await journal.read(id(1)), null);
  // Idempotent, and a non-finite cutoff removes nothing.
  assert.equal((await journal.prune({ beforeMs: CUTOFF })).removed, 0);
  assert.equal((await journal.prune({ beforeMs: Number.NaN })).removed, 0);
});
