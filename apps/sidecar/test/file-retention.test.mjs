import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA-11: the retention classes for data kept in files beside the store. The orchestration
// ledger's history collections and worker runs, and live certification evidence, follow the
// redacted window (30 days by default); live state, held worker runs, live-evidence demotions
// and route learning (the machine-wide prior included) are kept. C's local calibration cases sit
// in the route-learning folder but follow the decision window (CALIBRATION_CASES_RETENTION).

const { sweepFileRetention, sweepCalibrationCases, orchestrationLedgerRoots } = await import('../dist/file-retention.js');
const { openLedger } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');
const { CALIBRATION_CASES_RETENTION, LIVE_EVIDENCE_RETENTION, ORCHESTRATION_RETENTION, ROUTE_LEARNING_RETENTION } = await import('@jevris/store');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12);
const POLICY = { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 };

function tempHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-fret-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function recordFile(root, collection, id) {
  return join(root, collection, `${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`);
}

function age(path, days) {
  const at = new Date(NOW - days * DAY);
  utimesSync(path, at, at);
}

async function fixture(t) {
  const home = tempHome(t);
  const data = jevrisPaths({ home }).data;
  const host = join(data, 'orchestration', 'host');
  const ws = join(data, 'orchestration', 'w0123456789abcdef01234567', 'state');
  const run = (id, endedDaysAgo, effectState) => ({ workspaceId: 'w0123456789abcdef01234567', taskId: id, leaseId: `l-${id}`, status: 'completed', reason: 'DONE', endedAtMs: NOW - endedDaysAgo * DAY, ...(effectState === undefined ? {} : { effectState }) });
  await openLedger(host).transact((tx) => {
    tx.put('worker-runs', 'old', run('old', 40, 'acknowledged'));
    tx.put('worker-runs', 'held', run('held', 40, 'held'));
    tx.put('worker-runs', 'recent', run('recent', 3, 'acknowledged'));
    tx.put('harness-versions', 'claude', { version: '2.1.278', probedAtMs: NOW - 90 * DAY });
  });
  await openLedger(ws).transact((tx) => {
    tx.put('hook-deliveries', 'old', { key: 'old', atMs: NOW - 40 * DAY });
    tx.put('hook-deliveries', 'recent', { key: 'recent', atMs: NOW - DAY });
    tx.put('loop-signals', 'old', []);
    tx.put('leases', 'old', { state: 'active' });
    // P10 (D): evidence selections and reads are history, ids, ranks and times only.
    tx.put('evidence-selections', 'old', { selectionId: 'sel-old', rankedHandleIds: ['h1', 'h2'], atMs: NOW - 40 * DAY });
    tx.put('evidence-reads', 'old', { handleId: 'h1', selectionId: 'sel-old', rank: 1, atMs: NOW - 40 * DAY });
    tx.put('evidence-reads', 'recent', { handleId: 'h2', selectionId: null, rank: null, atMs: NOW - DAY });
    // P11 (D): a task's estimate against its committed actual, numbers only.
    tx.put('task-estimates', 'old', { taskId: 'old', sliceId: 'bounded-edit', risk: 'low', rootBudgetId: 'b1', estimateMicroUsd: 10, actualMicroUsd: 12, runs: 1, wallMs: 5, inputTokens: 1, outputTokens: 1, state: 'verified', atMs: NOW - 40 * DAY });
    tx.put('task-estimates', 'recent', { taskId: 'recent', sliceId: 'bounded-edit', risk: 'low', rootBudgetId: 'b1', estimateMicroUsd: 10, actualMicroUsd: null, runs: 1, wallMs: 5, inputTokens: null, outputTokens: null, state: 'running', atMs: NOW - DAY });
    // P9 and P2 (D): restore outcomes, integration reverts and the revert-scan cursor, ids and counts only.
    tx.put('restore-outcomes', 'old', { sessionId: 's-old', outcome: 'delivered', reasks: 0, atMs: NOW - 40 * DAY });
    tx.put('integration-reverts', 'old', { workspaceId: 'w0123456789abcdef01234567', taskId: 't-old', integratedCommit: 'a'.repeat(40), revertCommit: 'b'.repeat(40), atMs: NOW - 40 * DAY });
    tx.put('integration-reverts', 'recent', { workspaceId: 'w0123456789abcdef01234567', taskId: 't-new', integratedCommit: 'c'.repeat(40), revertCommit: 'd'.repeat(40), atMs: NOW - DAY });
    tx.put('revert-scan', 'cursor', { head: 'e'.repeat(40), candidates: 0 });
    // P13 (D): a subagent's type, slice and times, ids only.
    tx.put('subagent-runs', 'old', { workspaceId: 'w0123456789abcdef01234567', sessionId: 's1', agentId: 'a-old', subagentType: 'explore', sliceId: 'bounded-edit', startedAtMs: NOW - 41 * DAY, stoppedAtMs: NOW - 40 * DAY, stops: 1, route: null, parentVerifiedAtMs: null, atMs: NOW - 40 * DAY });
    tx.put('subagent-runs', 'recent', { workspaceId: 'w0123456789abcdef01234567', sessionId: 's1', agentId: 'a-new', subagentType: 'explore', sliceId: 'bounded-edit', startedAtMs: NOW - DAY, stoppedAtMs: null, stops: 0, route: null, parentVerifiedAtMs: null, atMs: NOW - DAY });
  });
  age(recordFile(ws, 'hook-deliveries', 'old'), 40);
  age(recordFile(ws, 'loop-signals', 'old'), 31);
  age(recordFile(ws, 'hook-deliveries', 'recent'), 2);
  age(recordFile(ws, 'leases', 'old'), 400);
  age(recordFile(ws, 'evidence-selections', 'old'), 40);
  age(recordFile(ws, 'evidence-reads', 'old'), 40);
  age(recordFile(ws, 'evidence-reads', 'recent'), 1);
  age(recordFile(ws, 'task-estimates', 'old'), 40);
  age(recordFile(ws, 'task-estimates', 'recent'), 1);
  age(recordFile(ws, 'restore-outcomes', 'old'), 40);
  age(recordFile(ws, 'integration-reverts', 'old'), 40);
  age(recordFile(ws, 'integration-reverts', 'recent'), 1);
  age(recordFile(ws, 'revert-scan', 'cursor'), 35);
  age(recordFile(ws, 'subagent-runs', 'old'), 40);
  age(recordFile(ws, 'subagent-runs', 'recent'), 1);
  age(recordFile(host, 'harness-versions', 'claude'), 400);
  // Route learning, the machine-wide prior included, is its own class.
  const machine = join(data, ROUTE_LEARNING_RETENTION.directory, 'machine');
  mkdirSync(machine, { recursive: true });
  writeFileSync(join(machine, 'prior.json'), '{}');
  age(join(machine, 'prior.json'), 400);
  const availability = join(data, ROUTE_LEARNING_RETENTION.directory, 'model-availability.json');
  writeFileSync(availability, '{}');
  age(availability, 400);
  const offer = join(data, ROUTE_LEARNING_RETENTION.directory, 'model-offer.json');
  writeFileSync(offer, '{}');
  age(offer, 400);
  const limits = join(data, ROUTE_LEARNING_RETENTION.directory, 'access-limits.json');
  writeFileSync(limits, '{}', { mode: 0o600 });
  age(limits, 400);
  const usage = join(data, ROUTE_LEARNING_RETENTION.directory, 'usage-readings.json');
  writeFileSync(usage, '{}', { mode: 0o600 });
  age(usage, 400);
  // C's calibration cases: an export 40 days old, one 2 days old, and a stray non-JSON file.
  const cases = join(data, CALIBRATION_CASES_RETENTION.directory);
  mkdirSync(cases, { recursive: true });
  for (const [name, days] of [['wOld.json', 40], ['wNew.json', 2], ['notes.txt', 400]]) {
    writeFileSync(join(cases, name), '{}\n', { mode: 0o600 });
    age(join(cases, name), days);
  }
  // Live evidence: an old and a recent conforming line, an old compacted count, an old demotion.
  const evidence = join(data, LIVE_EVIDENCE_RETENTION.directory);
  mkdirSync(evidence, { recursive: true });
  const line = (ok, daysAgo, extra = {}) => JSON.stringify({ h: 'claude', v: '2.1.278', f: 'hook.preToolUse', ok, ...(ok ? {} : { r: 'MALFORMED_EVENT' }), t: NOW - daysAgo * DAY, ...extra });
  writeFileSync(join(evidence, 'events.jsonl'), `${[line(true, 45), line(true, 2), line(true, 60, { c: 12 }), line(false, 90)].join('\n')}\n`);
  return { home, data, host, ws, machine, availability, evidence, cases };
}

test('the file retention classes are declared with their windows (DATA-11)', () => {
  assert.deepEqual([...ORCHESTRATION_RETENTION.historyCollections], ['hook-deliveries', 'loop-signals', 'loop-explained', 'stop-reminders', 'stop-reports', 'compaction-deferrals', 'rehydrations', 'evidence-selections', 'evidence-reads', 'task-estimates', 'restore-outcomes', 'integration-reverts', 'revert-scan', 'subagent-runs']);
  assert.equal(ORCHESTRATION_RETENTION.workerRunsCollection, 'worker-runs');
  assert.equal(ORCHESTRATION_RETENTION.window, 'decisionRetentionDays');
  assert.equal(LIVE_EVIDENCE_RETENTION.window, 'decisionRetentionDays');
  assert.equal(LIVE_EVIDENCE_RETENTION.keeps, 'demotions');
  assert.equal(ROUTE_LEARNING_RETENTION.swept, false);
  assert.deepEqual([...ROUTE_LEARNING_RETENTION.subdirectories], ['machine', 'calibration-cases']);
  assert.equal(CALIBRATION_CASES_RETENTION.directory, `${ROUTE_LEARNING_RETENTION.directory}/calibration-cases`);
  assert.equal(CALIBRATION_CASES_RETENTION.window, 'decisionRetentionDays');
  assert.equal(CALIBRATION_CASES_RETENTION.swept, true);
  assert.deepEqual([...ROUTE_LEARNING_RETENTION.files], ['model-availability.json', 'model-offer.json', 'access-limits.json', 'usage-readings.json']);
});

test('a dry run counts the expired history, worker runs and live-evidence lines and changes nothing (DATA-11)', async (t) => {
  const box = await fixture(t);
  assert.deepEqual(orchestrationLedgerRoots(box.data), [box.host, box.ws]);
  const before = readFileSync(join(box.evidence, 'events.jsonl'), 'utf8');
  const result = await sweepFileRetention({ home: box.home, dataDir: box.data, policy: POLICY, nowMs: NOW, dryRun: true });
  assert.deepEqual(result, { orchestration: { 'worker-runs': 1, 'hook-deliveries': 1, 'loop-signals': 1, 'evidence-selections': 1, 'evidence-reads': 1, 'task-estimates': 1, 'restore-outcomes': 1, 'integration-reverts': 1, 'revert-scan': 1, 'subagent-runs': 1 }, liveEvidence: 2, calibrationCases: 1 });
  assert.equal(existsSync(recordFile(box.ws, 'hook-deliveries', 'old')), true);
  assert.equal(readFileSync(join(box.evidence, 'events.jsonl'), 'utf8'), before);
});

test('the sweep removes expired history and runs, keeps live state, held runs, demotions and route learning (DATA-11)', async (t) => {
  const box = await fixture(t);
  const result = await sweepFileRetention({ home: box.home, dataDir: box.data, policy: POLICY, nowMs: NOW });
  assert.deepEqual(result, { orchestration: { 'worker-runs': 1, 'hook-deliveries': 1, 'loop-signals': 1, 'evidence-selections': 1, 'evidence-reads': 1, 'task-estimates': 1, 'restore-outcomes': 1, 'integration-reverts': 1, 'revert-scan': 1, 'subagent-runs': 1 }, liveEvidence: 2, calibrationCases: 1 });
  const host = openLedger(box.host);
  const ws = openLedger(box.ws);
  assert.deepEqual(host.list('worker-runs').map((r) => r.taskId).sort(), ['held', 'recent'], 'a run held for reconciliation is kept');
  assert.notEqual(host.get('harness-versions', 'claude'), undefined, 'live state is not aged out');
  assert.deepEqual(ws.list('hook-deliveries').map((r) => r.key), ['recent']);
  assert.equal(ws.get('loop-signals', 'old'), undefined);
  assert.equal(ws.get('evidence-selections', 'old'), undefined);
  assert.deepEqual(ws.list('evidence-reads').map((r) => r.handleId), ['h2'], 'a recent evidence read stays');
  assert.deepEqual(ws.list('task-estimates').map((r) => r.taskId), ['recent'], 'a recent task estimate stays');
  assert.equal(ws.get('restore-outcomes', 'old'), undefined);
  assert.deepEqual(ws.list('integration-reverts').map((r) => r.taskId), ['t-new'], 'a recent revert record stays');
  assert.equal(ws.get('revert-scan', 'cursor'), undefined, 'an old scan cursor ages out; the next scan runs again');
  assert.deepEqual(ws.list('subagent-runs').map((r) => r.agentId), ['a-new'], 'a recent subagent run stays');
  assert.notEqual(ws.get('leases', 'old'), undefined, 'leases are live state');
  assert.equal(existsSync(join(box.machine, 'prior.json')), true, 'the machine-wide learning prior is its own class');
  assert.equal(existsSync(box.availability), true, 'so is model-availability.json (C clears it on a registry refresh)');
  assert.equal(existsSync(join(box.data, ROUTE_LEARNING_RETENTION.directory, 'model-offer.json')), true, 'and model-offer.json, which each idle refresh replaces');
  assert.equal(existsSync(join(box.data, ROUTE_LEARNING_RETENTION.directory, 'access-limits.json')), true, 'and access-limits.json, which prunes itself (R62)');
  assert.equal(existsSync(join(box.data, ROUTE_LEARNING_RETENTION.directory, 'usage-readings.json')), true, 'and usage-readings.json, where each reading replaces its sign-in\'s (OP-6)');
  const lines = readFileSync(join(box.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map((text) => JSON.parse(text));
  assert.deepEqual(lines.map((l) => [l.ok, Math.round((NOW - l.t) / DAY)]), [[true, 2], [false, 90]], 'the recent line and the demotion stay');
  // A shorter window from the policy removes more; nothing expired is left twice.
  const again = await sweepFileRetention({ home: box.home, dataDir: box.data, policy: { ...POLICY, decisionRetentionDays: 1 }, nowMs: NOW });
  assert.deepEqual(again, { orchestration: { 'worker-runs': 1, 'hook-deliveries': 1 }, liveEvidence: 1, calibrationCases: 1 });
  assert.deepEqual(host.list('worker-runs').map((r) => r.taskId), ['held']);
});

test('model-availability.json outlives the age sweep and goes with route learning reset --machine (DATA-11, C 1547c8b)', async (t) => {
  const box = await fixture(t);
  const { resetMachineLearning } = await import('@jevris/core');
  await sweepFileRetention({ home: box.home, dataDir: box.data, policy: { rawArtifactRetentionDays: 0, decisionRetentionDays: 0 }, nowMs: NOW });
  assert.equal(existsSync(box.availability), true, 'no age window applies to it, even a 0-day one');
  assert.ok(ROUTE_LEARNING_RETENTION.removedBy.includes('jevris route learning reset --machine'));
  const reset = await resetMachineLearning(box.home);
  assert.equal(reset.ok, true);
  assert.equal(existsSync(box.availability), false, 'reset --machine removes it');
  assert.equal(existsSync(join(box.machine, 'prior.json')), false, 'with the machine-wide prior');
});

test('no orchestration or evidence folder is a no-op (DATA-11)', async (t) => {
  const home = tempHome(t);
  assert.deepEqual(await sweepFileRetention({ home, dataDir: jevrisPaths({ home }).data, policy: POLICY, nowMs: NOW }), { orchestration: {}, liveEvidence: 0, calibrationCases: 0 });
});

test('local calibration cases follow the decision window, not route learning: an export older than decisionRetentionDays goes, by its last write (P4, C 01c1e29)', async (t) => {
  const box = await fixture(t);
  const file = (name) => join(box.cases, name);
  // The dry run counts the old export and changes nothing.
  assert.equal(sweepCalibrationCases(box.data, NOW - 30 * DAY, true), 1);
  assert.equal(existsSync(file('wOld.json')), true);
  await sweepFileRetention({ home: box.home, dataDir: box.data, policy: POLICY, nowMs: NOW });
  assert.equal(existsSync(file('wOld.json')), false, 'the export older than the window goes');
  assert.equal(existsSync(file('wNew.json')), true, 'a recent export stays');
  assert.equal(existsSync(file('notes.txt')), true, 'only the exports (*.json) are in the class');
  assert.equal(existsSync(join(box.machine, 'prior.json')), true, 'the rest of route learning is not aged out');
  // A re-export rewrites the file, so its window starts again.
  writeFileSync(file('wNew.json'), '{}\n');
  age(file('wNew.json'), 29);
  assert.equal(sweepCalibrationCases(box.data, NOW - 30 * DAY, false), 0);
  age(file('wNew.json'), 31);
  assert.equal(sweepCalibrationCases(box.data, NOW - 30 * DAY, false), 1);
  assert.equal(existsSync(file('wNew.json')), false);
  // A folder named like an export is not a file: it is left alone.
  mkdirSync(file('wDir.json'));
  age(file('wDir.json'), 400);
  assert.equal(sweepCalibrationCases(box.data, NOW, false), 0);
  assert.equal(existsSync(file('wDir.json')), true);
  for (const how of ['jevris route learning reset --clear-evidence (this workspace\'s)', 'jevris data delete', 'jevris uninstall --delete-data']) assert.ok(CALIBRATION_CASES_RETENTION.removedBy.includes(how), how);
});
