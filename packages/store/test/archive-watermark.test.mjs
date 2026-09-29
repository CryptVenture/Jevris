import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

// Audit K4 (B with C 89c9420): the journal archive never brings back a decision row the retention
// sweep removed. An entry created before the sweep's cutoff is skipped as expired, so every daily
// sweep does not find the same rows again (and VACUUM runs only when rows really left).

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import('@jevris/core');

const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost() {
  const dir = makeTempDir('jevris-store-watermark-');
  dirs.push(dir);
  const opened = s.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

const HASH = 'a'.repeat(64);
function entry(id, atMs) {
  return {
    decisionId: id,
    state: 'refused',
    history: [
      { state: 'received', atMs },
      { state: 'refused', atMs: atMs + 40 },
    ],
    draft: { specVersion: 'spec-2', packetHash: HASH, workspaceId: 'wAbc', taskId: null },
    record: {
      schemaVersion: '1.0', decisionId: id, specId: 'route', specVersion: 'spec-2', modelResolved: 'jev-1.13.0', mode: 'advisory', evidenceRevision: 'rev1',
      outcome: 'refused', reasonCodes: ['BUDGET'], usage: null, billingBasis: 'provider-usage', calibration: { id: 'cal', version: 'cal-3' }, policyVersion: 'policy-7',
      durationMs: 38, providerCalls: 1, cost: { reservedMicroUsd: 90, actualMicroUsd: null }, workspaceId: 'wAbc',
    },
  };
}

const journalOf = (entries) => ({ list: async () => entries.map((e) => e.decisionId), read: async (id) => entries.find((e) => e.decisionId === id) ?? null });

test('the store and C agree on a journal entry\'s created time (the watermark\'s one clock)', () => {
  const e = entry('d1', 123_456);
  assert.equal(s.rowFromJournal(e, 'sidecar').createdAtMs, core.journalEntryCreatedAtMs(e));
  assert.equal(core.journalEntryCreatedAtMs(e), 123_456);
});

test('the archive skips entries past the watermark, so a swept row never returns and the next sweep finds nothing (K4)', async () => {
  const store = openHost();
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const cutoff = now - 30 * DAY;
  const entries = [entry('old', now - 40 * DAY), entry('new', now - DAY)];
  // Before the watermark existed: both archived, and the sweep removes the old one and vacuums.
  assert.equal((await s.archiveJournal(store, journalOf(entries))).inserted, 2);
  const first = s.sweepRetention(store, { policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now });
  assert.equal(first.removed.decision_record, 1);
  assert.equal(first.vacuumed, true);
  // The periodic archive with the watermark does not bring it back.
  const again = await s.archiveJournal(store, journalOf(entries), 'sidecar', { notBeforeMs: cutoff });
  assert.deepEqual({ inserted: again.inserted, duplicate: again.duplicate, expired: again.expired }, { inserted: 0, duplicate: 1, expired: 1 });
  assert.deepEqual((await s.archiveJournalEntry(store, journalOf(entries), 'old', 'sidecar', { notBeforeMs: cutoff })).result, 'expired');
  assert.deepEqual((await s.archiveJournalEntry(store, journalOf(entries), 'new', 'sidecar', { notBeforeMs: cutoff })).result, 'duplicate');
  // So the next sweep removes nothing and does not vacuum.
  const second = s.sweepRetention(store, { policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now });
  assert.equal(second.removed.decision_record, 0);
  assert.equal(second.vacuumed, false);
  s.closeStore(store);
});
