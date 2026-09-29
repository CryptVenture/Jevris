import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST, createSidecarEngine, sidecarOps, RULES_ONLY_DIAGNOSTIC } = provider;
const { createDecisionEngine, decide, compileDecisionSpec, DecisionBudget, lookupDecision, explainDecision } = core;

const KEY = 'test-key-not-a-secret';
const QUESTIONS = CONFORMANCE_REQUEST.questions;

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// These tests count provider calls and states, not the hot-path deadline: a 2 s decision
// deadline ran out before the send on a loaded CI cell (DEADLINE, no call), so they allow 60 s.
// The deadline paths have their own tests with an injected deadline.
const TEST_DEADLINE_MS = 60_000;

function spec(overrides = {}) {
  const compiled = compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: QUESTIONS, evidenceRequirements: ['e1'], deadlineMs: TEST_DEADLINE_MS, fallback: 'rules-only', ...overrides });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  return compiled.spec;
}

function request(overrides = {}) {
  return {
    spec: spec(),
    questions: QUESTIONS,
    workspaceId: 'w-test',
    evidenceRevision: 'rev-1',
    taskId: 'task-1',
    packet: {
      objective: 'Add an optional display label to an existing response',
      trustedPolicy: { compatibilityRequired: true },
      facts: { publicApiChanged: true, migrationPresent: false },
      evidence: [{ id: 'e1', text: 'Existing consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' }],
      missingEvidence: ['consumer compatibility test result'],
    },
    ...overrides,
  };
}

function engine(t, { scenario = 'valid', fetch, limit = 1_000_000, transport, lateMs, killSwitch } = {}) {
  const dir = temp(t);
  const mock = fetch ?? createMockFetch({ scenario, ...(lateMs === undefined ? {} : { lateMs }) });
  const port = transport === undefined ? createSdkTransport({ apiKey: KEY, fetch: mock }) : transport;
  const budget = DecisionBudget.open(join(dir, 'budget.json'), { limitMicroUsd: limit });
  const e = createDecisionEngine({ transport: port, journalDir: join(dir, 'decisions'), budget, ...(killSwitch === undefined ? {} : { killSwitch }) });
  return { engine: e, dir, mock, port, budget };
}

test('DEC-04/06/07: a decision runs the state machine, persists usage and model, and plans advice only', async (t) => {
  const { engine: e, dir, port, budget } = engine(t);
  const outcome = await decide(request(), e);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  assert.equal(contracts.DecisionResultContract.validate(outcome.result).ok, true);
  assert.equal(outcome.result.resolvedModelId, 'jev-1.13.0');
  assert.deepEqual(Object.keys(outcome.result.answers).sort(), ['changeRisk', 'compatibilityEvidenceMissing', 'taskFamily']);
  assert.equal(outcome.result.empiricalSuccessEstimate, null, 'no invented success probability');
  assert.equal(port.calls, 1);
  const entry = await e.entry(outcome.decisionId);
  assert.deepEqual(entry.history.map((h) => h.state), ['received', 'validated', 'evidence-ready', 'reserved', 'evaluating', 'evaluated', 'planned']);
  const record = entry.record;
  assert.equal(contracts.DecisionRecordContract.validate(record).ok, true);
  assert.equal(record.outcome, 'advisory');
  assert.equal(record.appliedAction, null);
  assert.equal(record.modelResolved, 'jev-1.13.0');
  assert.ok(record.usage.inputTokens > 0, 'usage persisted (DEC-06)');
  assert.equal(record.billingBasis, 'provider-reported-usage');
  assert.equal(record.providerCalls, 1);
  assert.match(record.hashes.requestHash, /^sha256:/);
  assert.match(record.hashes.responseHash, /^sha256:/);
  assert.match(record.hashes.packetHash, /^sha256:/);
  assert.equal(record.route, 'typesafe-sdk');
  assert.ok(record.cost.actualMicroUsd >= 1 && record.cost.actualMicroUsd <= record.cost.reservedMicroUsd);
  assert.equal(record.actualTaskOutcome, 'not-yet-observed');
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.committedMicroUsd, record.cost.actualMicroUsd);
  assert.equal(snapshot.reservedMicroUsd, 0);
  const again = await lookupDecision(outcome.decisionId, { journalDir: join(dir, 'decisions') });
  assert.deepEqual(again, record);
  const text = explainDecision(record);
  assert.match(text, /advice only/);
  assert.match(text, /not a success probability and does not mark the task verified/);
  assert.doesNotMatch(text, /\d+\s*%|will succeed|saved|savings of/i);
  for (const name of readdirSync(join(dir, 'decisions'))) assert.equal(readFileSync(join(dir, 'decisions', name), 'utf8').includes(KEY), false);
});

test('DEC-04: rules-sufficient inputs replay with zero provider calls', async (t) => {
  const { engine: e, port } = engine(t);
  const rules = () => ({ answers: { compatibilityEvidenceMissing: { type: 'noul', noul: 1 } }, reasonCode: 'CONSUMER_TEST_ABSENT' });
  for (let i = 0; i < 5; i += 1) {
    const outcome = await decide(request({ rules }), e);
    assert.equal(outcome.abstained, false);
    assert.equal(outcome.rulesOnly, true);
    const record = await e.lookup(outcome.decisionId);
    assert.equal(record.billingBasis, 'no-provider-call');
    assert.equal(record.providerCalls, 0);
    assert.deepEqual(record.reasonCodes, ['RULES_SUFFICIENT', 'CONSUMER_TEST_ABSENT']);
  }
  assert.equal(port.calls, 0);
});

test('DEC-09: an identical packet under identical policy is served from the cache; any change or a security spec calls again', async (t) => {
  const { engine: e, port } = engine(t);
  const first = await decide(request(), e);
  assert.equal(first.abstained, false, JSON.stringify(first));
  assert.equal(port.calls, 1);
  const hit = await decide(request(), e);
  assert.equal(hit.abstained, false);
  assert.equal(port.calls, 1, 'no second provider call');
  const record = await e.lookup(hit.decisionId);
  assert.ok(record.reasonCodes.includes('CACHE_HIT'));
  assert.equal(record.billingBasis, 'no-provider-call');
  assert.equal(record.providerCalls, 0);
  assert.equal(record.modelResolved, 'jev-1.13.0');
  const changed = request();
  changed.packet = { ...changed.packet, facts: { ...changed.packet.facts, migrationPresent: true } };
  await decide(changed, e);
  assert.equal(port.calls, 2, 'a changed packet misses');
  await decide(request({ evidenceRevision: 'rev-2' }), e);
  assert.equal(port.calls, 2, 'a new revision with byte-identical packet content is the same question');
  const security = request({ spec: spec({ id: 'egress-review' }) });
  await decide(security, e);
  await decide(security, e);
  assert.equal(port.calls, 4, 'a security decision is never cached');
  const otherWorkspace = await decide(request({ workspaceId: 'w-other' }), e);
  assert.equal(otherWorkspace.abstained, false);
  assert.equal(port.calls, 5, 'no cross-workspace sharing');
});

test('DEC-05: an invalid provider answer is quarantined with a redacted note and the fallback runs', async (t) => {
  const { engine: e, dir } = engine(t, { scenario: 'invalid-distribution' });
  const outcome = await decide(request(), e);
  assert.equal(outcome.abstained, true);
  assert.equal(outcome.reasonCode, 'INVALID_RESPONSE');
  assert.equal(outcome.fallback, 'rules-only');
  const entry = await e.entry(outcome.decisionId);
  assert.equal(entry.state, 'quarantined');
  assert.equal(entry.record.outcome, 'quarantined');
  assert.ok(entry.record.reasonCodes.includes('FALLBACK_RULES_ONLY'));
  assert.equal(entry.schemaFailure.applied, false);
  assert.match(entry.schemaFailure.kind, /^[a-z-]+$/);
  assert.match(entry.schemaFailure.responseHash, /^sha256:/);
  const raw = readFileSync(join(dir, 'decisions', `${outcome.decisionId}.json`), 'utf8');
  assert.equal(raw.includes('probabilities'), false, 'no response body is stored');
  assert.equal(entry.record.billingBasis, 'provider-reported-usage', 'the invalid call was still billed');
});

test('DEC-11: without a provider the decision is rules-only; budget and missing evidence refuse before any call', async (t) => {
  const none = engine(t, { transport: null });
  const outcome = await decide(request(), none.engine);
  assert.equal(outcome.abstained, true);
  assert.equal(outcome.reasonCode, 'PROVIDER_NOT_CONFIGURED');
  assert.equal((await none.engine.lookup(outcome.decisionId)).billingBasis, 'no-provider-call');

  const poor = engine(t, { limit: 1 });
  const refused = await decide(request(), poor.engine);
  assert.equal(refused.reasonCode, 'BUDGET');
  assert.equal(poor.port.calls, 0);

  const missing = engine(t);
  const noEvidence = await decide(request({ packet: { ...request().packet, evidence: [] } }), missing.engine);
  assert.equal(noEvidence.reasonCode, 'MISSING_EVIDENCE');
  const secret = await decide(request({ packet: { ...request().packet, objective: `token ghp_${'a'.repeat(36)}` } }), missing.engine);
  assert.equal(secret.reasonCode, 'SECRET_BLOCKED');
  assert.equal((await missing.engine.lookup(secret.decisionId)).outcome, 'refused');
  const mismatch = await decide(request({ questions: { only: { type: 'noul', instructions: 'Is the packet empty of evidence?' } } }), missing.engine);
  assert.equal(mismatch.reasonCode, 'SPEC_QUESTION_MISMATCH');
  assert.equal(missing.port.calls, 0);

  const stopped = engine(t, { killSwitch: () => true });
  assert.equal((await decide(request(), stopped.engine)).reasonCode, 'KILL_SWITCH');
  assert.equal(stopped.port.calls, 0);
});

test('DEC-04: the post-evaluation recheck marks a decision stale when the revision moved', async (t) => {
  const { engine: e, port } = engine(t);
  const outcome = await e.decide(request(), { currentRevision: () => 'rev-2' });
  assert.equal(outcome.abstained, true);
  assert.equal(outcome.reasonCode, 'STALE_REVISION');
  const record = await e.lookup(outcome.decisionId);
  assert.equal(record.outcome, 'stale');
  assert.ok(record.usage !== null, 'the spent call is still recorded');
  assert.equal(port.calls, 1);
});

test('cancellation aborts the in-flight request and releases nothing that was billed', async (t) => {
  const { engine: e, budget } = engine(t, { scenario: 'aborted' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const outcome = await e.decide(request(), { signal: controller.signal });
  assert.equal(outcome.reasonCode, 'CANCELLED');
  const record = await e.lookup(outcome.decisionId);
  assert.equal(record.outcome, 'abstained');
  const snap = await budget.snapshot();
  assert.equal(snap.reservedMicroUsd, 0, 'no reservation is left open');
});

test('an ambiguous timeout holds the reservation; reconciling settles the record and the budget', async (t) => {
  // Deterministic: the deadline expires only once the mock provider has received the request,
  // so the call is always in flight (ambiguous) when time runs out, whatever the host load.
  let received = false;
  const fetch = createMockFetch({ scenario: 'late', lateMs: 30_000, onRequest: () => (received = true) });
  const { engine: e, budget } = engine(t, { fetch });
  const deadline = { remainingMs: () => (received ? 0 : 400), expired: () => received };
  const outcome = await e.decide(request(), { deadline });
  assert.equal(received, true);
  assert.equal(outcome.reasonCode, 'DEADLINE');
  const record = await e.lookup(outcome.decisionId);
  assert.equal(record.billingBasis, 'estimate-pending-reconcile');
  assert.equal(record.usage, null, 'unknown usage stays unknown, never zero');
  assert.equal((await budget.snapshot()).holds, 1);
  const next = await decide(request(), engine(t).engine);
  assert.equal(next.abstained, false, 'other decisions are not locked out');
  const reconciled = await e.reconcileUsage(outcome.decisionId, { actualMicroUsd: 9, source: 'billing-export' });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.record.billingBasis, 'reconciled-billing-export');
  assert.equal(reconciled.record.cost.actualMicroUsd, 9);
  assert.equal((await budget.snapshot()).holds, 0);
  assert.equal((await e.reconcileUsage(outcome.decisionId, { actualMicroUsd: 9, source: 'billing-export' })).reasonCode, 'ALREADY_RECONCILED');
});

test('DEC-04: nothing is applied without an adapter receipt, and terminal states are immutable', async (t) => {
  const { engine: e } = engine(t);
  const outcome = await decide(request(), e);
  const receipt = (status) => ({ id: `rcpt-${status}`, intentId: 'intent-1', status, resultingRevision: 'rev-2', observedModelId: null, reasonCode: 'ADAPTER_RECEIPT', occurredAt: new Date().toISOString() });
  assert.equal((await e.markApplied(outcome.decisionId, { ...receipt('applied'), id: '' })).reasonCode, 'INVALID_RECEIPT');
  const applied = await e.markApplied(outcome.decisionId, receipt('applied'));
  assert.equal(applied.ok, true);
  assert.equal(applied.record.outcome, 'applied');
  assert.equal(applied.record.actionReceiptId, 'rcpt-applied');
  assert.deepEqual(applied.record.appliedAction, applied.record.proposedAction);
  assert.equal((await e.markApplied(outcome.decisionId, receipt('applied'))).reasonCode, 'NOT_PLANNED');
  const entry = await e.entry(outcome.decisionId);
  const back = await e.journal.transition(entry, 'planned', {});
  assert.equal(back.reasonCode, 'ILLEGAL_TRANSITION');

  const other = await decide(request(), e);
  const advisory = await e.markApplied(other.decisionId, receipt('advisory'));
  assert.equal(advisory.ok, true);
  assert.equal(advisory.record.outcome, 'refused', 'an advisory receipt is not evidence of an applied action');
});

test('DEC-04: a crash at any in-flight state reconciles at the next start', async (t) => {
  const { engine: e, budget } = engine(t);
  const states = ['received', 'validated', 'evidence-ready', 'reserved', 'evaluating', 'evaluated'];
  const ids = [];
  for (const state of states) {
    const id = `d-${crypto.randomUUID()}`;
    const reserved = ['reserved', 'evaluating', 'evaluated'].includes(state) ? await budget.reserve({ decisionId: id, workspaceId: 'w-test', microUsd: 10 }) : null;
    const created = await e.journal.create(id, {
      specId: 'task-profile', specVersion: 'v1', workspaceId: 'w-test', taskId: null, evidenceRevision: 'rev-1', lane: 'interactive', mode: 'observe',
      receivedAt: new Date().toISOString(), questionHash: contracts.questionHash(QUESTIONS), packetHash: null,
      reservationId: reserved?.reservation.id ?? null, reservedMicroUsd: reserved === null ? 0 : 10, sent: false, usage: null, modelResolved: null,
    });
    let entry = created.entry;
    for (const next of states.slice(1, states.indexOf(state) + 1)) {
      entry = (await e.journal.transition(entry, next, { draft: next === 'evaluating' ? { sent: true } : {} })).entry;
    }
    ids.push([id, state]);
  }
  const restarted = createDecisionEngine({ transport: null, journalDir: e.journal.dir, budget });
  assert.equal((await restarted.recover()).recovered, states.length);
  for (const [id, state] of ids) {
    const record = await restarted.lookup(id);
    assert.equal(record.outcome, 'abstained', state);
    assert.ok(record.reasonCodes.includes('CRASH_RECOVERED'));
  }
  const snap = await budget.snapshot();
  assert.equal(snap.reservedMicroUsd, 0, 'a reservation whose request was never sent is released');
  assert.equal(snap.holds, 2, 'sent requests without usage are held for reconciliation');
  assert.equal((await restarted.recover()).recovered, 0, 'recovery is idempotent');
});

test('DEC-11: createSidecarEngine without a key is rules-only with exactly one diagnostic', async (t) => {
  const home = temp(t);
  const lines = [];
  const e = await createSidecarEngine({ home, credential: null, log: (line) => lines.push(line) });
  assert.equal(e.providerConfigured, false);
  assert.deepEqual(lines, [RULES_ONLY_DIAGNOSTIC]);
  const outcome = await decide(request(), e);
  assert.equal(outcome.reasonCode, 'PROVIDER_NOT_CONFIGURED');
});

test('DEC-11: createSidecarEngine with a key uses the production SDK port; the key never reaches disk', async (t) => {
  const home = temp(t);
  const fetch = createMockFetch();
  const e = await createSidecarEngine({ home, credential: KEY, fetch });
  assert.equal(e.providerConfigured, true);
  assert.equal(e.route, 'typesafe-sdk');
  const outcome = await decide(request(), e);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  assert.equal(fetch.calls, 1);
  const found = await lookupDecision(outcome.decisionId, { home });
  assert.equal(found.decisionId, outcome.decisionId);
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else assert.equal(readFileSync(path, 'utf8').includes(KEY), false, path);
    }
  };
  scan(home);
});

function ctx(op, body, e, workspaceId = 'w-test', home = '/nonexistent') {
  const deadline = createDeadline(900);
  return {
    op, client: 'cli', scopes: ['status', 'advice'], workspace: { id: workspaceId, root: null }, body, home,
    signal: new AbortController().signal, deadline, store: undefined, killSwitchStopped: false, engine: e, trace() {},
  };
}

test('sidecar ops: explain, decision.get, plan, cost.report and calibration.status answer in contract shape', async (t) => {
  const { engine: e } = engine(t);
  const outcome = await decide(request(), e);
  const ops = Object.fromEntries(sidecarOps.map((def) => [def.op, def]));
  assert.deepEqual(Object.keys(ops).sort(), ['calibration.export', 'calibration.status', 'cost.report', 'decision.feedback', 'decision.get', 'explain', 'plan', 'route']);
  assert.equal(ops.decide, undefined, 'decide is never an IPC op');

  const explained = await ops.explain.handle(ctx('explain', { decisionId: outcome.decisionId }, e));
  assert.equal(explained.ok, true);
  assert.equal(contracts.surfacePayloadContract('explain').validate(explained.body).ok, true);
  assert.equal(explained.body.found, true);
  assert.equal(explained.body.trace.applied, false);
  const foreign = await ops.explain.handle(ctx('explain', { decisionId: outcome.decisionId }, e, 'w-other'));
  assert.equal(foreign.body.found, false, 'another workspace cannot read this decision');
  const unknown = await ops.explain.handle(ctx('explain', { decisionId: 'd-legacy-1' }, e));
  assert.equal(unknown.body.found, false);
  assert.equal((await ops.explain.handle(ctx('explain', { decisionId: 1 }, e))).reasonCode, 'INVALID_REQUEST');
  assert.equal((await ops.explain.handle(ctx('explain', { decisionId: outcome.decisionId, extra: 1 }, e))).reasonCode, 'INVALID_REQUEST');

  const got = await ops['decision.get'].handle(ctx('decision.get', { decisionId: outcome.decisionId }, e));
  assert.equal(got.body.found, true);
  assert.equal(contracts.DecisionRecordContract.validate(got.body.record).ok, true);

  const node = (id, deps = [], scope = `src/${id}`) => ({
    id, schemaVersion: '1.0', workspaceId: 'w-test', revision: 'r1', state: 'proposed', requirementIds: ['REQ-1'], dependencyIds: deps,
    writeScopes: [scope], acceptanceCheckIds: ['unit'], rootBudgetId: 'budget-1',
  });
  const planned = await ops.plan.handle(ctx('plan', { tasks: [node('a'), node('b', ['a']), node('c', ['a'])] }, e));
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.body.valid, true);
  assert.deepEqual(planned.body.waves, [['a'], ['b', 'c']]);
  assert.deepEqual(planned.body.ready, ['a']);
  const overlap = await ops.plan.handle(ctx('plan', { tasks: [node('a'), node('b', ['a'], 'src/shared'), node('c', ['a'], 'src/shared/x')] }, e));
  assert.deepEqual(overlap.body.issues, [{ taskId: 'b', code: 'WRITE_OVERLAP' }, { taskId: 'c', code: 'WRITE_OVERLAP' }]);
  const cyclic = await ops.plan.handle(ctx('plan', { tasks: [node('a', ['b']), node('b', ['a'])] }, e));
  assert.equal(cyclic.ok, true);
  assert.equal(cyclic.body.valid, false);
  assert.ok(cyclic.body.issues.some((issue) => issue.code === 'CYCLE' || issue.code === 'INVALID_TASK'));
  assert.equal((await ops.plan.handle(ctx('plan', { tasks: 'x' }, e))).reasonCode, 'INVALID_REQUEST');

  const cost = await ops['cost.report'].handle(ctx('cost.report', {}, e));
  assert.equal(cost.ok, true);
  assert.equal(cost.body.decisions.total, 1);
  assert.equal(cost.body.decisions.providerCalls, 1);
  assert.ok(cost.body.budget.committedMicroUsd > 0);
  const calibration = await ops['calibration.status'].handle(ctx('calibration.status', {}, e));
  assert.equal(calibration.body.applies, false);
});
