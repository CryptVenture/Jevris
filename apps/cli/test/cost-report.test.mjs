// EVL-08, US33: jevris cost-report shows Jevris's decision-call cost as three labelled measures
// that are never added up or called a saving; a measure the op does not supply is "unmeasured"
// or "hypothetical", never zero. Temp home and a real sidecar only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const { checkCostReport, renderCostReport } = await import('../dist/cost-report.js');

const base = {
  schemaVersion: 'jevris-cost-report-1',
  providerConfigured: true,
  route: 'direct',
  budget: { period: '2026-09', limitMicroUsd: 5_000_000, committedMicroUsd: 1_250, reservedMicroUsd: 0, heldMicroUsd: 0, availableMicroUsd: 4_998_750, holds: 0, reservations: 1 },
  decisions: { total: 3, providerCalls: 2, inputTokens: 900, outputTokens: 120, usageUnknown: 1, actualMicroUsd: 1_250, byOutcome: { advisory: 3 }, byBillingBasis: { 'provider-reported-usage': 2, 'estimate-pending-reconcile': 1 }, scanned: 3, truncated: false },
  note: 'Decision-call cost only (Jev). Unknown usage stays unknown until reconciled; no savings are claimed.',
  diagnostics: [],
};

test('the three measures stay apart: actual from the journal, the others unmeasured or hypothetical, never zero', () => {
  const report = checkCostReport(base);
  assert.notEqual(report, null);
  assert.deepEqual(report.measures, { actual: 1_250, apiEquivalentEstimate: 'unmeasured', counterfactual: 'hypothetical' });
  const text = renderCostReport(report);
  assert.match(text, /^actual \(reported or reconciled billing\): \$0\.0013 \(1 call\(s\) with usage not yet known are not included\)$/m);
  assert.match(text, /^API-equivalent estimate: unmeasured$/m);
  assert.match(text, /^counterfactual: hypothetical \(not claimed as a saving\)$/m);
  assert.match(text, /billing basis estimate-pending-reconcile: 1/);
  assert.doesNotMatch(text, /sav(ed|ing): \$/i);
});

test('the estimator block (C 5a0d00c, audit P7) prints the estimate-over-reported distribution and warns on an under-estimate', async () => {
  const core = await import('@jevris/core');
  const report = (samples) => core.estimatorCalibration(samples);
  const est = (inputTokens) => ({ inputTokens, encoderId: core.ENCODER_ID });
  const ok = report([{ estimate: est(1200), usage: { inputTokens: 1000, outputTokens: 10 } }, { estimate: est(1500), usage: { inputTokens: 1000, outputTokens: 10 } }].map(toSample));
  const under = report([{ estimate: est(900), usage: { inputTokens: 1000, outputTokens: 10 } }, { estimate: est(1300), usage: { inputTokens: 1000, outputTokens: 10 } }].map(toSample));
  for (const estimator of [ok, under]) {
    const checked = checkCostReport({ ...base, estimator: { ...estimator, lines: core.estimatorCalibrationLines(estimator) } });
    assert.deepEqual(checked.estimator, estimator);
    const text = renderCostReport(checked);
    for (const lineText of core.estimatorCalibrationLines(estimator)) assert.ok(text.includes(`${lineText}\n`), lineText);
    assert.match(text, /estimate \/ reported input tokens over 2 decision\(s\): min [\d.]+, p10 [\d.]+, median [\d.]+, p90 [\d.]+, max [\d.]+\./);
  }
  assert.doesNotMatch(renderCostReport(checkCostReport({ ...base, estimator: ok })), /ESTIMATE_BELOW_REPORTED/);
  assert.match(renderCostReport(checkCostReport({ ...base, estimator: under })), /^Warning: 1 estimate\(s\) were below the reported input tokens \(ESTIMATE_BELOW_REPORTED\)/m);
  // None, or a block that does not match, prints no estimator line and keeps the report.
  assert.equal(checkCostReport(base).estimator, null);
  for (const bad of [{ ...ok, schemaVersion: 'x' }, { ...ok, ratio: null }, { ...ok, reasonCodes: ['not a code'] }, { ...ok, samples: -1 }, { ...ok, encoderId: 'a b' }]) {
    const checked = checkCostReport({ ...base, estimator: bad });
    assert.notEqual(checked, null);
    assert.equal(checked.estimator, null, JSON.stringify(bad).slice(0, 80));
    assert.doesNotMatch(renderCostReport(checked), /Token estimator/);
  }
});

test('the outcomes block (C df9087b, audit P4) prints which decisions led to verified work per kind; a missing or malformed block prints nothing', async () => {
  const core = await import('@jevris/core');
  const outcomes = {
    schemaVersion: 'jevris-decision-outcomes-1',
    decisionsWithOutcome: 3,
    sessionWindowOnly: 1,
    byKind: [{ kind: 'task-profile', decisions: 3, verifiedSuccess: 2, verifiedFailure: 1, abandoned: 0, unknown: 0, jevAnswered: 2, jevAnsweredVerified: 1, abstained: 1 }],
  };
  const checked = checkCostReport({ ...base, outcomes: { ...outcomes, lines: core.decisionOutcomeLines(outcomes) } });
  assert.deepEqual(checked.outcomes, outcomes);
  const text = renderCostReport(checked);
  for (const lineText of core.decisionOutcomeLines(outcomes)) assert.ok(text.includes(`${lineText}\n`), lineText);
  assert.match(text, /^task-profile: 3 with an outcome, 2 verified, 1 failed, 0 abandoned, 0 unknown; Jev answered 2, of which 1 on tasks that later verified; 1 abstained\.$/m);
  assert.equal(checkCostReport({ ...base, outcomes: null }).outcomes, null);
  for (const bad of [{ ...outcomes, schemaVersion: 'x' }, { ...outcomes, byKind: [{ ...outcomes.byKind[0], abstained: -1 }] }, { ...outcomes, byKind: [{ ...outcomes.byKind[0], kind: 'not a kind' }] }, { ...outcomes, decisionsWithOutcome: 1.5 }]) {
    const report = checkCostReport({ ...base, outcomes: bad });
    assert.notEqual(report, null);
    assert.equal(report.outcomes, null);
    assert.doesNotMatch(renderCostReport(report), /known task outcome/);
  }
});

function toSample(s) {
  return { estimate: s.estimate, usage: s.usage, reasonCodes: [] };
}

test('a billing block from the op fills the measures; a malformed answer is refused', () => {
  const withBilling = checkCostReport({ ...base, billing: { subscriptionActual: 'unknown', apiEquivalentEstimate: '4200', counterfactualHypothetical: 'hypothetical' } });
  assert.deepEqual(withBilling.measures, { actual: 'unknown', apiEquivalentEstimate: 4200, counterfactual: 'hypothetical' });
  assert.equal(checkCostReport({ ...base, schemaVersion: '2' }), null);
  assert.equal(checkCostReport({ ...base, decisions: { ...base.decisions, actualMicroUsd: -1 } }), null);
  assert.equal(checkCostReport({ ...base, billing: { apiEquivalentEstimate: 0.5 } }), null);
  assert.equal(checkCostReport({ ...base, decisions: null, providerConfigured: false }).measures.actual, 'unknown');
});

test('jevris cost-report reads the report from the running sidecar', async (t) => {
  const box = await sandbox(t);
  assert.equal(box.startSidecar().code, 0);
  const json = box.jevris(['cost-report'], { json: true });
  assert.equal(json.code, 0, `${json.stdout} ${json.stderr}`);
  assert.equal(json.json.command, 'cost-report');
  assert.equal(json.json.report.measures.apiEquivalentEstimate, 'unmeasured');
  assert.equal(json.json.report.measures.counterfactual, 'hypothetical');
  const text = box.jevris(['cost-report']);
  assert.match(text.stdout, /three measures are separate; none is a saving/);
  box.stopSidecar();
  const down = box.jevris(['cost-report'], { json: true, extraEnv: { JEVRIS_SIDECAR_AUTOSTART: '0' } });
  assert.equal(down.code, 1, down.stdout);
  assert.equal(down.json.report, null);
});

test('the Learning section (D 2794ac4 learning.report) prints counts only; a sidecar without the op, or a block that does not match, leaves it out with no error', async (t) => {
  const { runCostReportCommand } = await import('../dist/cost-report.js');
  const { mkdirSync, mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-cost-learning-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const learning = {
    estimates: { tasks: 3, compared: 2, estimateMicroUsd: 20_000, actualMicroUsd: 26_000, medianRatio: 1.3, underEstimated: 1 },
    restores: { delivered: 4, degraded: 1, refused: 1, omittedItems: 2, reasked: 1, withRepeats: 0, checkStarted: 3, verified: 2 },
    reminders: { fired: 5, ledToCheck: 3, ledToVerification: 2, endedUnverified: 1 },
    evidence: { selections: 2, reads: 4, readsFromSelection: 3, precisionAtK: 0.3, k: 5, recall: 0.75 },
  };
  const run = async (learned, argv = []) => {
    const calls = [];
    const ports = {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          return input.op === 'cost.report' ? { ok: true, result: base } : learned;
        },
      },
      engine: {},
      config: {},
    };
    let text = '';
    const code = await runCostReportCommand(argv, (chunk) => (text += chunk), { ports, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' }, cwd: work });
    return { code, text, calls };
  };
  const shown = await run({ ok: true, result: learning });
  assert.equal(shown.code, 0, shown.text);
  assert.deepEqual(shown.calls.map((c) => [c.op, c.scope, c.budget, JSON.stringify(c.body)]), [['cost.report', 'cli', 'background', '{}'], ['learning.report', 'cli', 'background', '{}']]);
  assert.match(shown.text, /^Learning in this workspace \(ids and counts only; none is a saving\):$/m);
  assert.match(shown.text, /^estimates: 3 finished task\(s\), 2 compared: estimated \$0\.0200, committed \$0\.0260, median committed \/ estimate 1\.30, 1 over their estimate$/m);
  assert.match(shown.text, /^restores: 4 delivered, 1 degraded, 1 refused, 2 item\(s\) left out; after a restore 1 re-asked, 0 repeated a failure, 3 started a check, 2 verified$/m);
  assert.match(shown.text, /^reminders \(Stop\): 5 fired, 3 led to a check, 2 led to verification, 1 ended unverified$/m);
  assert.match(shown.text, /^evidence: 2 selection\(s\), 4 read\(s\), 3 of them ranked by a selection; precision at 5 30\.0%, recall 75\.0%$/m);
  const json = await run({ ok: true, result: learning }, ['--json']);
  assert.deepEqual(JSON.parse(json.text).report.learning, learning);

  // An older sidecar (unknown op), a refusal or a malformed answer: no section, still exit 0.
  for (const learned of [{ ok: false, reason: 'refused', reasonCode: 'UNKNOWN_OP' }, { ok: false, reason: 'unavailable' }, { ok: true, result: null }, { ok: true, result: 'x' }]) {
    const quiet = await run(learned);
    assert.equal(quiet.code, 0, quiet.text);
    assert.doesNotMatch(quiet.text, /Learning in this workspace/);
  }
  // A block that does not match is left out on its own; the others still print.
  const partial = await run({ ok: true, result: { ...learning, estimates: { ...learning.estimates, compared: 9 }, evidence: { ...learning.evidence, recall: 2 } } });
  assert.doesNotMatch(partial.text, /^estimates:|^evidence:/m);
  assert.match(partial.text, /^restores: /m);
  assert.match(partial.text, /^reminders \(Stop\): /m);
  const noCompared = await run({ ok: true, result: { ...learning, estimates: { tasks: 2, compared: 0, estimateMicroUsd: 0, actualMicroUsd: 0, medianRatio: null, underEstimated: 0 } } });
  assert.match(noCompared.text, /^estimates: 2 finished task\(s\); none has a committed cost to compare with its estimate yet$/m);
});
