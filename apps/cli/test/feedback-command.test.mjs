// `jevris feedback <decision-id>` (audit P12, C 216d411): a person's feedback on one decision's
// advice through C's decision.feedback op. Accepted, or rejected with a reason or none
// (unspecified); the answer is checked before it is shown; a refusal is a reason code. And the
// cost-report feedback block (jevris-feedback-report-1) is checked and rendered with C's lines.
// Temporary home, a fake sidecar port, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFeedbackCommand, checkFeedbackRecorded } = await import('../dist/feedback-command.js');
const { checkCostReport, checkFeedback, renderCostReport } = await import('../dist/cost-report.js');
const core = await import('@jevris/core');

const ID = 'd-0123abcd-0000-4000-8000-000000000000';
const RECORDED = { schemaVersion: 'jevris-decision-feedback-1', recorded: true, result: 'recorded', policyChanged: false, lines: ['Recorded: the advice was rejected (error).', 'Feedback never changes a policy by itself; it gives hypotheses for a reviewed release.'] };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-feedback-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts(answer) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          return typeof answer === 'function' ? answer(input) : answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(box, argv, ports) {
  let text = '';
  let asked = false;
  const code = await runFeedbackCommand(argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.work, confirm: async () => ((asked = true), false) });
  return { code, text, asked, json: argv.includes('--json') && text.startsWith('{') ? JSON.parse(text) : null };
}

test('feedback sends accepted, a reasoned rejection or an unspecified one to decision.feedback, asks nothing, and prints its lines', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: RECORDED });
  const cases = [
    [['--accepted'], { decisionId: ID, accepted: true }],
    [['--rejected'], { decisionId: ID, accepted: false }],
    [['--reason', 'error'], { decisionId: ID, accepted: false, reason: 'error' }],
    [['--rejected', '--reason', 'unavailable-context'], { decisionId: ID, accepted: false, reason: 'unavailable-context' }],
    [['--reason', 'preference'], { decisionId: ID, accepted: false, reason: 'preference' }],
  ];
  for (const [flags, body] of cases) {
    const shown = await run(box, [ID, ...flags], fake.ports);
    assert.equal(shown.code, 0, shown.text);
    assert.equal(shown.asked, false);
    assert.equal(shown.text, `${RECORDED.lines.join('\n')}\n`);
    const request = fake.calls.at(-1);
    assert.deepEqual([request.op, request.scope, request.budget, request.workspace], ['decision.feedback', 'cli', 'hot', box.work]);
    assert.deepEqual(request.body, body, flags.join(' '));
  }
  const json = await run(box, [ID, '--rejected', '--json'], fakePorts({ ok: true, result: { ...RECORDED, result: 'replaced' } }).ports);
  assert.deepEqual(json.json, { schemaVersion: '1.0', command: 'feedback', decisionId: ID, recorded: true, reasonCode: null, result: 'replaced', accepted: false, reason: 'unspecified', policyChanged: false });
});

test('feedback needs one decision id and exactly one answer; a usage error sends nothing', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ ok: true, result: RECORDED });
  for (const argv of [[ID], [ID, '--accepted', '--rejected'], [ID, '--accepted', '--reason', 'error'], [ID, '--reason', 'unspecified'], [ID, '--reason', 'bad'], ['not-an-id', '--accepted'], [ID, ID, '--accepted'], [ID, '--yes', '--accepted']]) {
    assert.equal((await run(box, argv, fake.ports)).code, 2, argv.join(' '));
  }
  assert.equal((await run(box, [], fake.ports)).code, 2);
  assert.equal(fake.calls.length, 0);
});

test('feedback shows a refusal or an answer that does not match as a reason code and exits 1', async (t) => {
  const box = sandbox(t);
  for (const reasonCode of ['DECISION_NOT_FOUND', 'STORE_UNAVAILABLE', 'STORE_REFUSED', 'INVALID_REQUEST']) {
    const refused = await run(box, [ID, '--accepted'], fakePorts({ ok: false, reason: 'refused', reasonCode }).ports);
    assert.equal(refused.code, 1);
    assert.match(refused.text, new RegExp(`^No feedback was recorded \\(${reasonCode}\\): `));
    const json = await run(box, [ID, '--accepted', '--json'], fakePorts({ ok: false, reason: 'refused', reasonCode }).ports);
    assert.deepEqual(json.json, { schemaVersion: '1.0', command: 'feedback', decisionId: ID, recorded: false, reasonCode });
  }
  const down = await run(box, [ID, '--accepted'], fakePorts({ ok: false, reason: 'unavailable' }).ports);
  assert.match(down.text, /^No feedback was recorded \(SIDECAR_UNAVAILABLE\): .*jevris sidecar start/);
  for (const result of [{ ...RECORDED, policyChanged: true }, { ...RECORDED, result: 'x' }, { ...RECORDED, lines: ['a\nb'] }, { ...RECORDED, schemaVersion: '2' }, null]) {
    assert.equal(checkFeedbackRecorded(result), null);
    const bad = await run(box, [ID, '--accepted'], fakePorts({ ok: true, result }).ports);
    assert.equal(bad.code, 1);
    assert.equal(bad.text, 'No feedback was recorded (SIDECAR_INVALID_RESULT).\n');
  }
});

test('cost-report shows the feedback block (jevris-feedback-report-1) in C\'s words; one that does not match prints nothing', () => {
  const report = core.feedbackReport([
    { decisionId: 'a', kind: 'route.worker', accepted: true, reason: null },
    { decisionId: 'b', kind: 'route.worker', accepted: false, reason: 'error' },
    { decisionId: 'c', kind: 'route.worker', accepted: false, reason: 'unspecified' },
    { decisionId: 'd', kind: 'plan.check', accepted: false, reason: 'preference' },
  ]);
  const base = {
    schemaVersion: 'jevris-cost-report-1',
    providerConfigured: false,
    decisions: null,
    budget: null,
    diagnostics: [],
  };
  const checked = checkCostReport({ ...base, feedback: { ...report, lines: core.feedbackLines(report) } });
  assert.deepEqual(checked.feedback, report);
  const text = renderCostReport(checked);
  for (const line of core.feedbackLines(report)) assert.ok(text.includes(`${line}\n`), line);
  assert.match(text, /^route\.worker: 1 accepted, 2 rejected \(1 error, 0 unavailable context, 0 preference, 1 no reason\); error rate /m);
  assert.equal(checkCostReport(base).feedback, null);
  const kind = report.byKind[0];
  for (const bad of [{ ...report, policyChanged: true }, { ...report, schemaVersion: 'x' }, { ...report, byKind: [{ ...kind, rejectedBy: { ...kind.rejectedBy, error: -1 } }] }, { ...report, byKind: [{ ...kind, kind: 'not a kind' }] }, { ...report, byKind: [{ ...kind, errorRate: { point: 2, lower: 0, upper: 1 } }] }, { ...report, byKind: [{ ...kind, hypotheses: [{ kind: 'apply-now', action: 'review-through-release-pipeline' }] }] }]) {
    assert.equal(checkFeedback(bad), null, JSON.stringify(bad).slice(0, 80));
    assert.doesNotMatch(renderCostReport(checkCostReport({ ...base, feedback: bad })), /Feedback on advice/);
  }
});
