import test from 'node:test';
import assert from 'node:assert/strict';

// P4 (learning-coverage audit; owner decision 7922ee3): a decision's task outcome from the
// store's join, and the local report. Codes and counts only; nothing here tunes a threshold.
const core = await import('@jevris/core');
const { taskOutcomeOfLabel, taskOutcomeOfLabels, decisionOutcomeReport, decisionOutcomeLines, LABEL_SOURCES } = core;

test('every route-learning label maps to a task outcome of the decision record', () => {
  assert.equal(taskOutcomeOfLabel('verified-pass'), 'verified-success');
  for (const failure of ['verified-fail', 'reverted', 'retried', 'run-incomplete']) assert.equal(taskOutcomeOfLabel(failure), 'verified-failure');
  assert.equal(taskOutcomeOfLabel('cancelled'), 'abandoned');
  for (const other of ['stale', 'usage-limited', 'anything-else']) assert.equal(taskOutcomeOfLabel(other), 'unknown');
  for (const label of core.OUTCOME_KINDS) assert.ok(['verified-success', 'verified-failure', 'abandoned', 'unknown'].includes(taskOutcomeOfLabel(label)), label);
  assert.ok(Array.isArray(LABEL_SOURCES));
});

test('one decision takes its latest task-joined label; a session window counts only without one', () => {
  assert.equal(taskOutcomeOfLabels([]), 'not-yet-observed');
  assert.equal(taskOutcomeOfLabels([{ label: 'verified-pass', joinBasis: 'session-window', labelledAtMs: 9 }]), 'verified-success');
  assert.equal(
    taskOutcomeOfLabels([
      { label: 'verified-pass', joinBasis: 'task', labelledAtMs: 1 },
      { label: 'reverted', joinBasis: 'task', labelledAtMs: 5 },
      { label: 'verified-pass', joinBasis: 'session-window', labelledAtMs: 9 },
    ]),
    'verified-failure',
  );
});

function row(decisionId, extra = {}) {
  return { decisionId, kind: 'task-profile', decisionOutcome: 'advisory', providerCalls: 1, label: 'verified-pass', joinBasis: 'task', labelledAtMs: 10, ...extra };
}

test('the report counts decisions with a known outcome and Jev answers on tasks that later verified, per kind', () => {
  const report = decisionOutcomeReport([
    row('d1'),
    row('d1', { label: 'reverted', labelledAtMs: 20 }),
    row('d2'),
    row('d3', { decisionOutcome: 'abstained', providerCalls: 0 }),
    row('d4', { decisionOutcome: 'abstained', providerCalls: 1 }),
    row('d5', { label: 'cancelled' }),
    row('d6', { kind: 'route', label: 'usage-limited' }),
    row('d7', { joinBasis: 'session-window' }),
  ]);
  assert.equal(report.schemaVersion, 'jevris-decision-outcomes-1');
  assert.equal(report.decisionsWithOutcome, 6);
  assert.equal(report.sessionWindowOnly, 1);
  assert.deepEqual(report.byKind, [
    { kind: 'route', decisions: 1, verifiedSuccess: 0, verifiedFailure: 0, abandoned: 0, unknown: 1, jevAnswered: 1, jevAnsweredVerified: 0, abstained: 0 },
    { kind: 'task-profile', decisions: 5, verifiedSuccess: 3, verifiedFailure: 1, abandoned: 1, unknown: 0, jevAnswered: 3, jevAnsweredVerified: 1, abstained: 2 },
  ]);
  const lines = decisionOutcomeLines(report);
  assert.equal(lines[0], 'Decisions with a known task outcome: 6 (and 1 joined only by session, not counted).');
  assert.match(lines[2], /^task-profile: 5 with an outcome, 3 verified, 1 failed, 1 abandoned, 0 unknown; Jev answered 3, of which 1 on tasks that later verified; 2 abstained\.$/);
});

test('with no joined outcome the report says so and names no decision', () => {
  const empty = decisionOutcomeReport([]);
  assert.deepEqual(decisionOutcomeLines(empty), ['Decisions with a known task outcome: none yet.']);
  assert.deepEqual(decisionOutcomeLines(decisionOutcomeReport([row('d9', { joinBasis: 'session-window' })])), ['Decisions with a known task outcome: none yet (1 joined only by session, not counted).']);
  for (const line of decisionOutcomeLines(decisionOutcomeReport([row('d-secret-id')]))) assert.doesNotMatch(line, /d-secret-id/);
});
