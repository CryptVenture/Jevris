import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// P4 (learning-coverage audit; owner decision 7922ee3): explain and decision.get fill a
// decision's actualTaskOutcome from the store's join as a view (the journal record stays as it
// was), and cost.report carries the local outcome report.
const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const store = await import('@jevris/store');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST, sidecarOps } = provider;
const { createDecisionEngine, decide, compileDecisionSpec, DecisionBudget } = core;
const ops = Object.fromEntries(sidecarOps.map((def) => [def.op, def]));

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-decision-outcomes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function engine(dir) {
  const port = createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: createMockFetch({ scenario: 'valid' }) });
  return createDecisionEngine({ transport: port, journalDir: join(dir, 'decisions'), budget: DecisionBudget.open(join(dir, 'budget.json'), { limitMicroUsd: 1_000_000 }) });
}
function request() {
  const compiled = compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 2000, fallback: 'rules-only' });
  return {
    spec: compiled.spec, questions: CONFORMANCE_REQUEST.questions, workspaceId: 'wOutcome', evidenceRevision: 'rev-1', taskId: 'task-1', sessionId: 'sess-1',
    packet: { objective: 'Rename a helper', trustedPolicy: {}, facts: {}, evidence: [{ id: 'e1', text: 'A helper exists.', sourceKind: 'file', priority: 'mandatory' }], missingEvidence: [] },
  };
}
function ctx(op, body, e, opened, home) {
  return {
    op, client: 'cli', scopes: ['status'], workspace: { id: 'wOutcome', root: null }, body, home,
    signal: new AbortController().signal, deadline: createDeadline(900), store: opened, killSwitchStopped: false, engine: e, trace() {},
  };
}
function openHost(dir) {
  const opened = store.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}
function label(ws, kind, atMs) {
  const result = store.recordDecisionOutcomes(ws, { workspaceId: 'wOutcome', taskId: 'task-1', label: kind, labelSource: core.LABEL_SOURCE_OF[kind], receiptId: kind === 'verified-pass' ? 'r-1' : null, atMs });
  assert.equal(result.ok, true, JSON.stringify(result));
}

test('explain and decision.get show the task outcome from the join; the journal record is unchanged', async (t) => {
  const dir = temp(t);
  const e = engine(dir);
  const host = openHost(dir);
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'wOutcome');
  const outcome = await decide(request(), e);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  const archived = await store.archiveJournalEntry(ws, e.journal, outcome.decisionId, 'sidecar');
  assert.equal(archived.ok, true, JSON.stringify(archived));

  // Before any label: not yet observed.
  let got = await ops['decision.get'].handle(ctx('decision.get', { decisionId: outcome.decisionId }, e, ws, dir));
  assert.equal(got.body.record.actualTaskOutcome, 'not-yet-observed');

  label(ws, 'verified-pass', 5_000);
  got = await ops['decision.get'].handle(ctx('decision.get', { decisionId: outcome.decisionId }, e, ws, dir));
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.body.record.actualTaskOutcome, 'verified-success');
  assert.equal(contracts.DecisionRecordContract.validate(got.body.record).ok, true);
  let explained = await ops.explain.handle(ctx('explain', { decisionId: outcome.decisionId }, e, ws, dir));
  assert.equal(explained.ok, true, JSON.stringify(explained));
  assert.equal(contracts.surfacePayloadContract('explain').validate(explained.body).ok, true);
  assert.match(explained.body.trace.rendered, /Task outcome: verified success\./);

  // A later revert overturns the pass.
  label(ws, 'reverted', 6_000);
  explained = await ops.explain.handle(ctx('explain', { decisionId: outcome.decisionId }, e, ws, dir));
  assert.match(explained.body.trace.rendered, /Task outcome: verified failure\./);

  // The journal record itself stays immutable.
  assert.equal((await e.entry(outcome.decisionId)).record.actualTaskOutcome, 'not-yet-observed');

  // Another workspace's view sees no outcome for it.
  const other = store.workspaceView(host, 'wOther');
  assert.deepEqual(store.decisionOutcomeFor(other, outcome.decisionId, 'wOther'), []);
});

test('cost.report carries the local outcome report; without a store it is null', async (t) => {
  const dir = temp(t);
  const e = engine(dir);
  const host = openHost(dir);
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'wOutcome');
  const outcome = await decide(request(), e);
  await store.archiveJournalEntry(ws, e.journal, outcome.decisionId, 'sidecar');
  label(ws, 'verified-pass', 5_000);
  const report = await ops['cost.report'].handle(ctx('cost.report', {}, e, ws, dir));
  assert.equal(report.ok, true, JSON.stringify(report));
  const block = report.body.outcomes;
  assert.equal(block.schemaVersion, 'jevris-decision-outcomes-1');
  assert.equal(block.decisionsWithOutcome, 1);
  assert.equal(block.byKind.length, 1);
  assert.equal(block.byKind[0].verifiedSuccess, 1);
  assert.equal(block.byKind[0].jevAnswered, 1);
  assert.equal(block.byKind[0].jevAnsweredVerified, 1);
  assert.equal(block.lines[0], 'Decisions with a known task outcome: 1.');
  assert.doesNotMatch(JSON.stringify(block), new RegExp(outcome.decisionId));

  const bare = await ops['cost.report'].handle(ctx('cost.report', {}, e, undefined, dir));
  assert.equal(bare.body.outcomes, null);
});

test('a Jev decision records its answer probabilities, and calibration.export writes local cases from verified outcomes', async (t) => {
  const dir = temp(t);
  const e = engine(dir);
  const host = openHost(dir);
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'wOutcome');
  const outcome = await decide(request(), e);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  const rec = (await e.entry(outcome.decisionId)).record;
  assert.ok(Array.isArray(rec.answerProbabilities) && rec.answerProbabilities.length > 0, JSON.stringify(rec));
  assert.equal(contracts.DecisionRecordContract.validate(rec).ok, true);
  await store.archiveJournalEntry(ws, e.journal, outcome.decisionId, 'sidecar');
  label(ws, 'verified-pass', 5_000);
  const exported = await ops['calibration.export'].handle({ ...ctx('calibration.export', {}, e, ws, dir), scopes: ['admin'] });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.body.totals.decisions, 1);
  assert.equal(exported.body.totals.cases, rec.answerProbabilities.length);
  assert.equal(ops['calibration.export'].scope, 'admin');
  const file = JSON.parse(readFileSync(exported.body.file, 'utf8'));
  assert.equal(file.reviewState, 'unreviewed');
  assert.ok(file.groups.every((g) => g.cases.every((c) => c.outcome === true && c.sliceId === 'task-profile')));
  assert.doesNotMatch(JSON.stringify(file), new RegExp(outcome.decisionId));
  // Without a store there is nothing to join.
  const bare = await ops['calibration.export'].handle(ctx('calibration.export', {}, e, undefined, dir));
  assert.deepEqual([bare.ok, bare.reasonCode], [false, 'STORE_UNAVAILABLE']);
  const bad = await ops['calibration.export'].handle(ctx('calibration.export', { path: '/x' }, e, ws, dir));
  assert.equal(bad.reasonCode, 'INVALID_REQUEST');
});

test('P12: decision.feedback records a reasoned rejection of a known decision, the latest wins, and cost.report reports it without changing a policy', async (t) => {
  const dir = temp(t);
  const e = engine(dir);
  const host = openHost(dir);
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'wOutcome');
  const outcome = await decide(request(), e);
  const feedback = (body, opened = ws) => ops['decision.feedback'].handle({ ...ctx('decision.feedback', body, e, opened, dir), scopes: ['submit'] });
  assert.equal(ops['decision.feedback'].scope, 'submit');

  const rejected = await feedback({ decisionId: outcome.decisionId, accepted: false, reason: 'unavailable-context' });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.deepEqual([rejected.body.result, rejected.body.policyChanged], ['recorded', false]);
  const changed = await feedback({ decisionId: outcome.decisionId, accepted: false, reason: 'error' });
  assert.equal(changed.body.result, 'replaced');
  const rows = store.readDecisionFeedback(ws, { workspaceId: 'wOutcome' });
  assert.deepEqual(rows.map((r) => [r.kind, r.accepted, r.reason]), [['task-profile', false, 'error']]);

  const report = await ops['cost.report'].handle(ctx('cost.report', {}, e, ws, dir));
  assert.equal(report.body.feedback.policyChanged, false);
  assert.deepEqual(report.body.feedback.byKind[0].rejectedBy, { preference: 0, 'unavailable-context': 0, error: 1, unspecified: 0 });
  assert.doesNotMatch(JSON.stringify(report.body.feedback), new RegExp(outcome.decisionId));

  // Refusals: a reason on an acceptance, an unknown reason, an unknown decision, no store.
  assert.equal((await feedback({ decisionId: outcome.decisionId, accepted: true, reason: 'error' })).reasonCode, 'INVALID_REQUEST');
  assert.equal((await feedback({ decisionId: outcome.decisionId, accepted: false, reason: 'missing-context' })).reasonCode, 'INVALID_REQUEST');
  assert.equal((await feedback({ decisionId: outcome.decisionId, accepted: false, note: 'free text' })).reasonCode, 'INVALID_REQUEST');
  assert.equal((await feedback({ decisionId: 'd-00000000-0000-4000-8000-000000000000', accepted: false })).reasonCode, 'DECISION_NOT_FOUND');
  assert.equal((await feedback({ decisionId: outcome.decisionId, accepted: false }, null)).reasonCode, 'STORE_UNAVAILABLE');
  // A rejection without a reason is unspecified; an acceptance has none.
  await feedback({ decisionId: outcome.decisionId, accepted: false });
  assert.equal(store.readDecisionFeedback(ws, { workspaceId: 'wOutcome' })[0].reason, 'unspecified');
  await feedback({ decisionId: outcome.decisionId, accepted: true });
  assert.equal(store.readDecisionFeedback(ws, { workspaceId: 'wOutcome' })[0].reason, null);
});
