import test from 'node:test';
import assert from 'node:assert/strict';

// P12: feedback on advice with reasons gives hypotheses, never a policy change.
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { feedbackReport, feedbackLines, GIVEN_FEEDBACK_REASONS } = core;

const row = (decisionId, kind, accepted, reason = null) => ({ decisionId, kind, accepted, reason });

test('the reasons a person may give are the contracts\' labels without unspecified', () => {
  assert.deepEqual([...GIVEN_FEEDBACK_REASONS], contracts.FEEDBACK_REASONS.filter((r) => r !== 'unspecified'));
});

test('rejections are counted by reason, only errors count toward the error rate, and nothing changes a policy', () => {
  const report = feedbackReport([
    row('d1', 'task-profile', true),
    row('d2', 'task-profile', false, 'error'),
    row('d3', 'task-profile', false, 'unavailable-context'),
    row('d4', 'task-profile', false, null),
    row('d5', 'route', false, 'preference'),
    row('d6', 'route', true),
  ]);
  assert.equal(report.schemaVersion, 'jevris-feedback-report-1');
  assert.equal(report.policyChanged, false);
  assert.equal(report.total, 6);
  const [route, profile] = report.byKind;
  assert.equal(route.kind, 'route');
  assert.deepEqual(route.rejectedBy, { preference: 1, 'unavailable-context': 0, error: 0, unspecified: 0 });
  assert.deepEqual(route.hypotheses.map((h) => h.kind), ['preference-only']);
  assert.equal(route.errorRate.point, 0);
  assert.deepEqual([profile.total, profile.accepted], [4, 1]);
  assert.deepEqual(profile.rejectedBy, { preference: 0, 'unavailable-context': 1, error: 1, unspecified: 1 });
  assert.equal(profile.errorRate.point, 0.25);
  assert.ok(profile.errorRate.lower < 0.25 && profile.errorRate.upper > 0.25);
  assert.equal(profile.unlabelledShare, 0.3333);
  assert.deepEqual(profile.hypotheses.map((h) => h.kind), ['possible-error', 'unavailable-context']);
  const lines = feedbackLines(report);
  assert.match(lines[0], /^Feedback on advice: 6 decision\(s\)\. Feedback never changes a policy/);
  assert.match(lines[2], /^task-profile: 1 accepted, 3 rejected \(1 error, 1 unavailable context, 0 preference, 1 no reason\); error rate 0\.25/);
  for (const line of lines) assert.doesNotMatch(line, /\bd[1-6]\b/);
  assert.deepEqual(feedbackLines(feedbackReport([])), ['Feedback on advice: none yet.']);
});
