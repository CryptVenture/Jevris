import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

// Audit K5: status and the provider-down health line read the newest decisions, newest first,
// without the record column, however many decisions the window holds.

const s = await import(new URL('../dist/index.js', import.meta.url).href);

const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost() {
  const dir = makeTempDir('jevris-store-recent-');
  dirs.push(dir);
  const opened = s.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

function decision(store, id, createdAtMs, workspaceId = 'wAbc') {
  const row = {
    workspaceId, decisionId: id, taskId: null, kind: 'route', specVersion: 'spec-2', model: 'jev-1.13.0', encoderVersion: 'packet-1',
    calibrationVersion: 'cal-3', policyVersion: 'policy-7', state: 'applied', outcome: 'advisory', reasonCodes: [`CODE_${String(createdAtMs)}`],
    latencyMs: 41, providerCalls: 1, usage: null, reservedMicroUsd: 0, costMicroUsd: null, billingBasis: 'provider-usage', processRole: 'sidecar',
    source: 'journal', record: { decisionId: id, note: 'x'.repeat(2000) }, createdAtMs,
  };
  assert.equal(s.recordDecisionRow(store, row).ok, true);
}

test('the newest decisions come first, at most the limit, past a thousand rows in the window (K5)', () => {
  const store = openHost();
  for (let i = 1; i <= 1200; i += 1) decision(store, `d${String(i).padStart(4, '0')}`, 10_000 + i);
  decision(store, 'other', 20_000, 'wOther');
  const recent = s.recentDecisionSummaries(store, { workspaceId: 'wAbc', sinceMs: 0, limit: 5 });
  assert.deepEqual(recent.map((r) => r.decisionId), ['d1200', 'd1199', 'd1198', 'd1197', 'd1196']);
  assert.deepEqual(recent[0], { decisionId: 'd1200', outcome: 'advisory', reasonCodes: ['CODE_11200'], model: 'jev-1.13.0', createdAtMs: 11_200 });
  assert.equal('record' in recent[0], false, 'no record column');
  assert.deepEqual(s.recentDecisionSummaries(store, { sinceMs: 0, limit: 1 }).map((r) => r.decisionId), ['other'], 'the host reads every workspace');
  assert.deepEqual(s.recentDecisionSummaries(store, { workspaceId: 'wAbc', sinceMs: 11_199 }).map((r) => r.decisionId), ['d1200', 'd1199']);
  assert.equal(s.recentDecisionSummaries(store, { sinceMs: 0, limit: 500 }).length, 20, 'capped at 20');
  s.closeStore(store);
});

// Audit P9: the status line's day tally is summed in SQL and advanced from the last row counted,
// and agrees with decisionCounters on the same rows.
test('decisionTally sums the day like decisionCounters, and counts only rows after the last one it saw (P9)', () => {
  const store = openHost();
  const add = (id, createdAtMs, outcome, providerCalls, costMicroUsd) => {
    const row = {
      workspaceId: 'wAbc', decisionId: id, taskId: null, kind: 'route', specVersion: 'spec-2', model: 'jev-1.13.0', encoderVersion: 'packet-1',
      calibrationVersion: 'cal-3', policyVersion: 'policy-7', state: 'applied', outcome, reasonCodes: ['TALLY'], latencyMs: 5, providerCalls, usage: null,
      reservedMicroUsd: 0, costMicroUsd, billingBasis: 'provider-usage', processRole: 'sidecar', source: 'journal', record: { decisionId: id }, createdAtMs,
    };
    const written = s.recordDecisionRow(store, row);
    assert.equal(written.ok, true, `${id}: ${JSON.stringify(written)}`);
  };
  add('yesterday', 500, 'advisory', 1, 999);
  add('a', 1_000, 'advisory', 1, 100);
  add('b', 1_100, 'abstained', 0, null);
  add('c', 1_200, 'abstained', 1, 40);
  const first = s.decisionTally(store, { sinceMs: 1_000 });
  const counters = s.decisionCounters(store, { sinceMs: 1_000 });
  assert.deepEqual(
    { decisions: first.decisions, abstentions: first.abstentions, fallbacks: first.fallbacks, costMicroUsd: first.costMicroUsd },
    { decisions: counters.decisions, abstentions: counters.abstentions, fallbacks: counters.fallbacks, costMicroUsd: counters.costMicroUsd.actual },
  );
  assert.deepEqual({ decisions: first.decisions, abstentions: first.abstentions, fallbacks: first.fallbacks, costMicroUsd: first.costMicroUsd }, { decisions: 3, abstentions: 2, fallbacks: 1, costMicroUsd: 140 });
  add('d', 1_300, 'refused', 2, 7);
  add('old-late', 900, 'advisory', 1, 5);
  const next = s.decisionTally(store, { sinceMs: 1_000, afterRowid: first.lastRowid });
  assert.deepEqual({ decisions: next.decisions, fallbacks: next.fallbacks, costMicroUsd: next.costMicroUsd }, { decisions: 1, fallbacks: 1, costMicroUsd: 7 }, 'only the new row of the day');
  assert.ok(next.lastRowid > first.lastRowid);
  const none = s.decisionTally(store, { sinceMs: 1_000, afterRowid: next.lastRowid });
  assert.equal(none.decisions, 0);
  assert.equal(none.lastRowid, next.lastRowid, 'the mark never goes back');
  s.closeStore(store);
});
