import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

// Learning records (owner 2026-09-27; learning-coverage audit P4, P5, P8): decision outcomes
// joined to task labels, session model changes and advice adherence, and daily latency counters.
// Ids, codes, counts and times only; they follow the decision window and are removed by the
// learning purge.

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost() {
  const dir = makeTempDir('jevris-store-learning-');
  dirs.push(dir);
  const path = join(dir, 'jevris.db');
  const opened = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { store: opened, path };
}

const CANARY = ['learning', 'canary', 'text', process.pid].join('-');

function decision(store, id, extra = {}) {
  const row = {
    workspaceId: 'wAbc',
    decisionId: id,
    taskId: 't1',
    kind: 'route',
    specVersion: 'spec-2',
    model: 'jev-1.13.0',
    encoderVersion: 'packet-1',
    calibrationVersion: 'cal-3',
    policyVersion: 'policy-7',
    state: 'applied',
    outcome: 'advisory',
    reasonCodes: ['ROUTE_ADVICE'],
    latencyMs: 41,
    providerCalls: 1,
    usage: { inputTokens: 1200, outputTokens: 30 },
    reservedMicroUsd: 90,
    costMicroUsd: 51,
    billingBasis: 'provider-usage',
    processRole: 'sidecar',
    source: 'journal',
    record: { decisionId: id, sessionId: 's1', route: 'main', lane: 'hot', note: CANARY },
    createdAtMs: 1_000,
    ...extra,
  };
  assert.equal(s.recordDecisionRow(store, row).ok, true);
}

test('the store is at the latest schema (7 or later) with the learning tables, decision feedback included', () => {
  const { store } = openHost();
  assert.ok(s.latestSchemaVersion() >= 7);
  assert.equal(store.schemaVersion, s.latestSchemaVersion());
  assert.deepEqual([...s.LEARNING_TABLES], ['decision_outcome', 'session_model_change', 'advice_adherence', 'latency_counter', 'decision_feedback']);
  assert.deepEqual([...s.LEARNING_RECORDS_RETENTION.tables], [...s.LEARNING_TABLES]);
  assert.equal(s.LEARNING_RECORDS_RETENTION.window, 'decisionRetentionDays');
  s.closeStore(store);
});

test('a task label joins every decision of that task, text-free, and a session window joins that session for the report only (P4)', () => {
  const { store, path } = openHost();
  decision(store, 'd1');
  decision(store, 'd2', { createdAtMs: 1_500, usage: null, costMicroUsd: null });
  decision(store, 'd3', { taskId: null, createdAtMs: 2_000 });
  decision(store, 'd4', { taskId: null, createdAtMs: 9_000 });
  decision(store, 'd5', { taskId: 'other', createdAtMs: 1_200 });
  const first = s.recordDecisionOutcomes(store, { workspaceId: 'wAbc', taskId: 't1', label: 'verified-pass', labelSource: 'verification-receipt', receiptId: 'r-1', atMs: 5_000, sessionWindow: { sessionId: 's1', fromMs: 1_000, toMs: 3_000 } });
  assert.deepEqual(first, { ok: true, joined: 3, relabelled: 0 });
  // Idempotent.
  assert.deepEqual(s.recordDecisionOutcomes(store, { workspaceId: 'wAbc', taskId: 't1', label: 'verified-pass', labelSource: 'verification-receipt', receiptId: 'r-1', atMs: 5_001 }), { ok: true, joined: 0, relabelled: 0 });
  const rows = s.readDecisionOutcomes(store, { workspaceId: 'wAbc' });
  assert.deepEqual(rows.map((r) => [r.decisionId, r.joinBasis]).sort(), [['d1', 'task'], ['d2', 'task'], ['d3', 'session-window']]);
  assert.deepEqual(s.readDecisionOutcomes(store, { workspaceId: 'wAbc', joinBasis: 'task' }).map((r) => r.decisionId), ['d1', 'd2']);
  const d1 = s.decisionOutcomeFor(store, 'd1', 'wAbc')[0];
  assert.equal(d1.label, 'verified-pass');
  assert.equal(d1.receiptId, 'r-1');
  assert.equal(d1.sessionId, 's1');
  assert.equal(d1.route, 'main');
  assert.equal(d1.lane, 'hot');
  assert.deepEqual(d1.reasonCodes, ['ROUTE_ADVICE']);
  assert.deepEqual(d1.usage, { inputTokens: 1200, outputTokens: 30 });
  assert.equal(d1.costMicroUsd, 51);
  assert.equal(s.decisionOutcomeFor(store, 'd2', 'wAbc')[0].usage, null);
  // Codes only: the decision record's free text is never copied.
  s.closeStore(store);
  const db = new Database(path, { readonly: true });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM decision_outcome').all()).includes(CANARY), false);
  db.close();
});

test('a later revert, retry or incomplete run overturns a pass; a pass overturns only an incomplete run (P4, owner 2026-09-27)', () => {
  const { store } = openHost();
  decision(store, 'd1');
  const label = (value, atMs) => s.recordDecisionOutcomes(store, { workspaceId: 'wAbc', taskId: 't1', label: value, labelSource: 'test-source', atMs });
  assert.equal(label('verified-pass', 10).joined, 1);
  assert.equal(label('reverted', 20).relabelled, 1);
  let row = s.decisionOutcomeFor(store, 'd1', 'wAbc')[0];
  assert.deepEqual([row.label, row.previousLabel, row.revision], ['reverted', 'verified-pass', 2]);
  assert.equal(label('verified-pass', 30).relabelled, 0, 'a pass never overturns a revert');
  assert.equal(label('run-incomplete', 40).relabelled, 1);
  assert.equal(label('verified-pass', 50).relabelled, 1, 'a relaunch that passed overturns the incomplete run');
  assert.equal(label('verified-fail', 60).relabelled, 0, 'a fail is not an overturning label');
  row = s.decisionOutcomeFor(store, 'd1', 'wAbc')[0];
  assert.deepEqual([row.label, row.previousLabel, row.revision, row.labelledAtMs], ['verified-pass', 'run-incomplete', 4, 50]);
  assert.equal(s.labelOverturns('verified-fail', 'verified-pass'), false);
  assert.equal(s.labelOverturns('retried', 'verified-pass'), false);
  assert.equal(s.labelOverturns('verified-pass', 'retried'), true);
  assert.equal(s.labelOverturns('run-incomplete', 'run-incomplete'), false);
  // Only codes are accepted.
  for (const bad of ['Verified', 'has space', '', 'x'.repeat(40)]) assert.deepEqual(label(bad, 70), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(s.recordDecisionOutcomes(store, { workspaceId: 'wAbc', taskId: 't1', label: 'run-incomplete', labelSource: 'Free text', atMs: 1 }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(s.recordDecisionOutcomes(store, { taskId: 't1', label: 'run-incomplete', labelSource: 'harness-limit', atMs: 1 }), { ok: false, reason: 'invalid-input' }, 'the host handle needs a workspace');
  s.closeStore(store);
});

test('session model changes are appended and resolve model advice: followed, overridden, no change, unknown; overrides count per session (P5)', () => {
  const { store } = openHost();
  const view = s.workspaceView(store, 'wAbc');
  const session = (model, atMs, extra = {}) => assert.equal(s.recordSession(view, { sessionId: 's1', harness: 'claude', actualModel: model, state: 'active', atMs, source: 'model.changed', ...extra }).ok, true);
  const advise = (decisionId, advisedModel, atMs, sessionId = 's1') => s.openAdvice(view, { decisionId, sessionId, adviceKind: 'main-route', slice: 'edit-small', advisedModel, atMs });
  session('claude-opus-5-5', 10, { source: 'session.started' });
  assert.equal(advise('a1', 'claude-sonnet-5', 20).ok, true);
  session(null, 25, { source: 'tool.finished' });
  session('claude-sonnet-5', 30);
  assert.equal(s.adviceAdherenceFor(view, 'a1').verdict, 'followed');
  assert.equal(s.adviceAdherenceFor(view, 'a1').eventsUntil, 1);
  assert.equal(s.adviceAdherenceFor(view, 'a1').resolvedBy, 'model-change');
  // Overridden: a switch to another model.
  advise('a2', 'claude-haiku-5', 40);
  session('claude-opus-5-5', 50);
  assert.equal(s.adviceAdherenceFor(view, 'a2').verdict, 'overridden');
  // No change: the next advice for the same slice closes the earlier one.
  advise('a3', 'claude-haiku-5', 60);
  assert.deepEqual(advise('a4', 'claude-haiku-5', 70), { ok: true, closed: 1 });
  assert.deepEqual([s.adviceAdherenceFor(view, 'a3').verdict, s.adviceAdherenceFor(view, 'a3').resolvedBy], ['no-change', 'next-advice']);
  assert.equal(s.adviceOverrides(view, { sessionId: 's1', adviceKind: 'main-route', slice: 'edit-small', advisedModel: 'claude-haiku-5' }), 2, 'overridden plus no-change');
  assert.equal(s.adviceOverrides(view, { sessionId: 's2', adviceKind: 'main-route', slice: 'edit-small', advisedModel: 'claude-haiku-5' }), 0, 'a new session starts at 0');
  // The session end closes the open advice.
  s.recordSession(view, { sessionId: 's1', harness: 'claude', state: 'ended', atMs: 80, source: 'session.ended' });
  assert.deepEqual([s.adviceAdherenceFor(view, 'a4').verdict, s.adviceAdherenceFor(view, 'a4').resolvedBy], ['no-change', 'session-end']);
  // No model known: unknown.
  s.openAdvice(view, { decisionId: 'a5', sessionId: 's9', adviceKind: 'model-change', slice: 'edit-small', advisedModel: 'claude-haiku-5', atMs: 90 });
  s.recordSession(view, { sessionId: 's9', harness: 'claude', state: 'ended', atMs: 95 });
  assert.equal(s.adviceAdherenceFor(view, 'a5').verdict, 'unknown');
  assert.deepEqual(s.sessionModelChanges(view, 's1').map((c) => [c.seq, c.fromModel, c.toModel, c.source]), [
    [1, 'claude-opus-5-5', 'claude-sonnet-5', 'model.changed'],
    [2, 'claude-sonnet-5', 'claude-opus-5-5', 'model.changed'],
  ]);
  assert.deepEqual(s.adviceAdherenceCounts(view, { sinceMs: 0 }), { 'main-route': { followed: 1, overridden: 1, 'no-change': 2 }, 'model-change': { unknown: 1 } });
  assert.deepEqual(s.openAdvice(view, { decisionId: 'a6', sessionId: 's1', adviceKind: 'other', slice: 'edit-small', advisedModel: 'x', atMs: 1 }), { ok: false, reason: 'invalid-input' });
  s.closeStore(store);
});

test('latency counters add up per day, scope, name and metric, and drop anything but codes and numbers (P8)', () => {
  const { store } = openHost();
  const DAY = 86_400_000;
  const at = 3 * DAY + 5_000;
  const added = s.addLatencyCounts(store, [
    { atMs: at, scope: 'hook', name: 'claude', metric: 'HOOK_DEADLINE', count: 1, totalMs: 900, maxMs: 900 },
    { atMs: at + 10, scope: 'hook', name: 'claude', metric: 'HOOK_DEADLINE', count: 2, totalMs: 1900, maxMs: 1100 },
    { atMs: at, scope: 'sidecar-op', name: 'event', metric: 'answered', count: 5, totalMs: 50, maxMs: 20 },
    { atMs: at, scope: 'hook', name: 'claude', metric: 'free text', count: 1, totalMs: 1, maxMs: 1 },
    { atMs: at, scope: 'other', name: 'claude', metric: 'DEADLINE', count: 1, totalMs: 1, maxMs: 1 },
  ]);
  assert.deepEqual(added, { ok: true, added: 3, dropped: 2 });
  const rows = s.latencyCounters(store, { sinceMs: at });
  assert.deepEqual(rows.map((r) => [r.dayStartMs, r.scope, r.name, r.metric, r.count, r.totalMs, r.maxMs]), [
    [3 * DAY, 'hook', 'claude', 'HOOK_DEADLINE', 3, 2800, 1100],
    [3 * DAY, 'sidecar-op', 'event', 'answered', 5, 50, 20],
  ]);
  assert.equal(s.latencyCounters(store, { sinceMs: 4 * DAY }).length, 0);
  assert.equal(s.latencyCounters(store, { sinceMs: 0, scope: 'hook' }).length, 1);
  s.closeStore(store);
});

test('the learning records follow the decision window and go with the learning purge, per workspace or all', () => {
  const { store } = openHost();
  const DAY = 86_400_000;
  const now = 100 * DAY;
  decision(store, 'd1', { createdAtMs: now - 40 * DAY });
  decision(store, 'd2', { createdAtMs: now - DAY, taskId: 't2' });
  s.recordDecisionOutcomes(store, { workspaceId: 'wAbc', taskId: 't1', label: 'verified-pass', labelSource: 'verification-receipt', atMs: now - 35 * DAY });
  s.recordDecisionOutcomes(store, { workspaceId: 'wAbc', taskId: 't2', label: 'verified-pass', labelSource: 'verification-receipt', atMs: now - DAY });
  const view = s.workspaceView(store, 'wAbc');
  s.recordSession(view, { sessionId: 's1', harness: 'claude', actualModel: 'm-a', state: 'active', atMs: now - 40 * DAY });
  s.openAdvice(view, { decisionId: 'a-old', sessionId: 's1', adviceKind: 'main-route', slice: 'x', advisedModel: 'm-b', atMs: now - 40 * DAY });
  s.recordSession(view, { sessionId: 's1', harness: 'claude', actualModel: 'm-b', state: 'active', atMs: now - 39 * DAY });
  s.openAdvice(view, { decisionId: 'a-new', sessionId: 's1', adviceKind: 'main-route', slice: 'x', advisedModel: 'm-c', atMs: now - DAY });
  s.addLatencyCounts(store, [
    { atMs: now - 40 * DAY, scope: 'hook', name: 'claude', metric: 'DEADLINE', count: 1, totalMs: 1, maxMs: 1 },
    { atMs: now - DAY, scope: 'hook', name: 'claude', metric: 'DEADLINE', count: 1, totalMs: 1, maxMs: 1 },
  ]);
  const swept = s.sweepRetention(store, { policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now });
  assert.equal(swept.ok, true);
  assert.equal(swept.removed.decision_outcome, 1);
  assert.equal(swept.removed.session_model_change, 1);
  assert.equal(swept.removed.advice_adherence, 1);
  assert.equal(swept.removed.latency_counter, 1);
  assert.deepEqual(s.readDecisionOutcomes(store, { workspaceId: 'wAbc' }).map((r) => r.decisionId), ['d2']);
  // Another workspace's records stay when one workspace is purged; the host counters go only with all.
  decision(store, 'e1', { workspaceId: 'wOther', taskId: 't9' });
  s.recordDecisionOutcomes(store, { workspaceId: 'wOther', taskId: 't9', label: 'verified-fail', labelSource: 'verification-receipt', atMs: now });
  const one = s.deleteLearningRecords(store, { workspaceId: 'wAbc' });
  assert.deepEqual(one, { ok: true, removed: { decision_outcome: 1, session_model_change: 0, advice_adherence: 1, latency_counter: 0, decision_feedback: 0 } });
  assert.equal(s.readDecisionOutcomes(store, { workspaceId: 'wOther' }).length, 1);
  const all = s.deleteLearningRecords(store);
  assert.deepEqual(all, { ok: true, removed: { decision_outcome: 1, session_model_change: 0, advice_adherence: 0, latency_counter: 1, decision_feedback: 0 } });
  assert.deepEqual(s.deleteLearningRecords(store, { workspaceId: 'not an id' }), { ok: false, reason: 'invalid-input' });
  s.closeStore(store);
});

test('decision feedback keeps the latest accept or reject per decision with a closed reason, never free text (P12)', async () => {
  const { FEEDBACK_REASONS } = await import('@jevris/contracts');
  assert.deepEqual([...s.DECISION_FEEDBACK_REASONS], [...FEEDBACK_REASONS], 'the store copy matches contracts');
  const { store, path } = openHost();
  const put = (input) => s.recordDecisionFeedback(store, { workspaceId: 'wAbc', kind: 'route.main', atMs: 1_000, ...input });
  assert.deepEqual(put({ decisionId: 'd1', accepted: false, reason: 'error' }), { ok: true, result: 'recorded', revision: 1 });
  assert.deepEqual(put({ decisionId: 'd1', accepted: true, reason: null, atMs: 2_000 }), { ok: true, result: 'replaced', revision: 2 });
  assert.deepEqual(put({ decisionId: 'd2', accepted: false, reason: 'unspecified', kind: 'loop.stop', atMs: 3_000 }), { ok: true, result: 'recorded', revision: 1 });
  assert.deepEqual(s.recordDecisionFeedback(store, { workspaceId: 'wOther', decisionId: 'd1', kind: 'route.main', accepted: false, reason: 'preference', atMs: 4_000 }).result, 'recorded');
  // A reason on an acceptance, a rejection without a closed reason, free text and bad ids are refused.
  for (const bad of [
    { decisionId: 'd3', accepted: true, reason: 'error' },
    { decisionId: 'd3', accepted: false, reason: null },
    { decisionId: 'd3', accepted: false, reason: 'missing-context' },
    { decisionId: 'd3', accepted: false, reason: CANARY },
    { decisionId: 'd3', accepted: 'yes', reason: null },
    { decisionId: 'not an id', accepted: true, reason: null },
    { decisionId: 'd3', accepted: true, reason: null, kind: 'free text kind' },
    { decisionId: 'd3', accepted: true, reason: null, atMs: -1 },
    { decisionId: 'd3', accepted: true, reason: null, workspaceId: 'bad id' },
  ]) assert.deepEqual(put(bad), { ok: false, reason: 'invalid-input' }, JSON.stringify(bad));
  assert.deepEqual(s.readDecisionFeedback(store, { workspaceId: 'wAbc' }), [
    { decisionId: 'd2', kind: 'loop.stop', accepted: false, reason: 'unspecified', atMs: 3_000, revision: 1 },
    { decisionId: 'd1', kind: 'route.main', accepted: true, reason: null, atMs: 2_000, revision: 2 },
  ]);
  assert.deepEqual(s.readDecisionFeedback(store, { workspaceId: 'wAbc', kind: 'route.main' }).map((r) => r.decisionId), ['d1']);
  assert.deepEqual(s.readDecisionFeedback(store, { workspaceId: 'wAbc', sinceMs: 2_500 }).map((r) => r.decisionId), ['d2']);
  assert.deepEqual(s.readDecisionFeedback(store, { limit: 1 }).map((r) => r.decisionId), ['d1'], 'the host reads every workspace, newest first');
  assert.deepEqual(s.readDecisionFeedback(store, { kind: 'free text kind' }), []);
  // The table itself refuses a reason outside the closed list and a reason on an acceptance.
  const db = new Database(path);
  assert.throws(() => db.prepare("INSERT INTO decision_feedback (workspace_id, decision_id, kind, accepted, reason, at_ms) VALUES ('wAbc', 'dx', 'k', 0, 'free text', 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO decision_feedback (workspace_id, decision_id, kind, accepted, reason, at_ms) VALUES ('wAbc', 'dx', 'k', 1, 'error', 1)").run(), /CHECK/);
  db.close();
  assert.doesNotMatch(JSON.stringify(s.readDecisionFeedback(store)), new RegExp(CANARY));
  // It follows the decision window, and goes with the learning purge per workspace or all.
  const DAY = 86_400_000;
  const now = 100 * DAY;
  put({ decisionId: 'd-old', accepted: true, reason: null, atMs: now - 40 * DAY });
  const swept = s.sweepRetention(store, { policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now });
  assert.equal(swept.ok, true);
  assert.equal(swept.removed.decision_feedback, 4, 'every row older than 30 days goes');
  put({ decisionId: 'd1', accepted: true, reason: null, atMs: now });
  s.recordDecisionFeedback(store, { workspaceId: 'wOther', decisionId: 'd1', kind: 'route.main', accepted: true, reason: null, atMs: now });
  assert.equal(s.deleteLearningRecords(store, { workspaceId: 'wAbc' }).removed.decision_feedback, 1);
  assert.equal(s.deleteLearningRecords(store).removed.decision_feedback, 1);
  assert.deepEqual(s.readDecisionFeedback(store), []);
  s.closeStore(store);
});
