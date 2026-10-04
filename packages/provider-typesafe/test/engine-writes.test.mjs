import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

// The decision engine writes its journal where a crash must be able to settle the decision, and not
// at every state. Each durable write is an fsync, the cost that does not shrink with a faster CPU:
// a cold decision made 9 writes of the journal and the budget, a cached one 3 and the advice record
// of a classification 3; they make 4, 1 and 1. These tests pin the counts, and pin what the writes
// that remain guarantee: the reservation and the entry that says `sent` are on disk before the
// request leaves, the final record is on disk before the answer is returned, and a crash at any
// point is settled by `recover()` with the budget and the record agreeing.
const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST } = provider;
const { createDecisionEngine, compileDecisionSpec, DecisionBudget, CircuitBreaker } = core;

const QUESTIONS = CONFORMANCE_REQUEST.questions;
const KEY = 'test-key-not-a-secret';
const TEST_DEADLINE_MS = 60_000;

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-engine-writes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spec() {
  const compiled = compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: QUESTIONS, evidenceRequirements: ['e1'], deadlineMs: TEST_DEADLINE_MS, fallback: 'rules-only' });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  return compiled.spec;
}

function request(overrides = {}) {
  return {
    spec: spec(),
    questions: QUESTIONS,
    workspaceId: 'w-writes',
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

function build(t, { scenario = 'valid', onRequest, breaker = null, killSwitch, limit = 1_000_000 } = {}) {
  const dir = temp(t);
  const mock = createMockFetch({ scenario, ...(onRequest === undefined ? {} : { onRequest }) });
  const port = createSdkTransport({ apiKey: KEY, fetch: mock });
  const budgetFile = join(dir, 'budget.json');
  const budget = DecisionBudget.open(budgetFile, { limitMicroUsd: limit });
  const engine = createDecisionEngine({ transport: port, journalDir: join(dir, 'decisions'), budget, ...(breaker === null ? {} : { breaker }), ...(killSwitch === undefined ? {} : { killSwitch }) });
  return { engine, dir, mock, port, budget, budgetFile, journalDir: join(dir, 'decisions') };
}

/** Counts every fsync made through a file handle while `fn` runs (each durable write is one). */
async function countFsyncs(fn) {
  const probe = await open(join(tmpdir(), `.engine-writes-probe-${process.pid}`), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  rmSync(join(tmpdir(), `.engine-writes-probe-${process.pid}`), { force: true });
  const original = proto.sync;
  let count = 0;
  proto.sync = function counted(...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    proto.sync = original;
  }
  return count;
}

test('a cold decision makes 4 durable writes (the reservation, the entry before the send, the commit, the record) and keeps every state in its history', async (t) => {
  const { engine, journalDir } = build(t);
  let outcome;
  const writes = await countFsyncs(async () => {
    outcome = await engine.decide(request());
  });
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  assert.equal(writes, 4, 'budget reserve, journal before the send, budget commit, journal record');
  const entry = JSON.parse(readFileSync(join(journalDir, `${outcome.decisionId}.json`), 'utf8'));
  assert.deepEqual(entry.history.map((h) => h.state), ['received', 'validated', 'evidence-ready', 'reserved', 'evaluating', 'evaluated', 'planned']);
  assert.equal(entry.record.billingBasis, 'provider-reported-usage');
  assert.equal(entry.record.providerCalls, 1);
});

test('a cached decision, a rules answer, a refusal and recorded advice are one write each', async (t) => {
  const { engine } = build(t);
  assert.equal((await engine.decide(request())).abstained, false);
  let hit;
  assert.equal(await countFsyncs(async () => { hit = await engine.decide(request()); }), 1, 'a cache hit');
  assert.equal((await engine.lookup(hit.decisionId)).reasonCodes.includes('CACHE_HIT'), true);
  assert.deepEqual((await engine.entry(hit.decisionId)).history.map((h) => h.state), ['received', 'validated', 'evidence-ready', 'planned']);

  const rules = () => ({ answers: { compatibilityEvidenceMissing: { type: 'noul', noul: 1 } }, reasonCode: 'CONSUMER_TEST_ABSENT' });
  let answered;
  assert.equal(await countFsyncs(async () => { answered = await engine.decide(request({ rules })); }), 1, 'a rules answer');
  assert.deepEqual((await engine.entry(answered.decisionId)).history.map((h) => h.state), ['received', 'validated', 'planned']);

  let refused;
  assert.equal(await countFsyncs(async () => { refused = await engine.decide(request({ packet: { ...request().packet, evidence: [] } })); }), 1, 'a refusal before any call');
  assert.equal(refused.reasonCode, 'MISSING_EVIDENCE');
  assert.equal((await engine.lookup(refused.decisionId)).outcome, 'abstained');

  let advice;
  const input = { specId: 'main-route', workspaceId: 'w-writes', evidenceRevision: 'rev-1', action: { kind: 'advise', templateId: 'main-route', evidenceIds: [] }, reasonCodes: ['KEEP_CURRENT'] };
  assert.equal(await countFsyncs(async () => { advice = await engine.recordAdvice(input); }), 1, 'recorded advice');
  assert.equal(advice.ok, true);
  const adviceEntry = await engine.entry(advice.decisionId);
  assert.deepEqual(adviceEntry.history.map((h) => h.state), ['received', 'validated', 'planned']);
  assert.equal(contracts.DecisionRecordContract.validate(adviceEntry.record).ok, true);
});

test('the kill switch and an exhausted budget are one write, and the exhausted budget sends nothing', async (t) => {
  const stopped = build(t, { killSwitch: () => true });
  assert.equal(await countFsyncs(async () => { assert.equal((await stopped.engine.decide(request())).reasonCode, 'KILL_SWITCH'); }), 1);
  const poor = build(t, { limit: 1 });
  let outcome;
  assert.equal(await countFsyncs(async () => { outcome = await poor.engine.decide(request()); }), 1, 'the refused reservation writes nothing; the record is the one write');
  assert.equal(outcome.reasonCode, 'BUDGET');
  assert.equal(poor.port.calls, 0);
});

test('with the circuit breaker, a steady-state cold decision is 4 writes: a success that changes nothing writes no circuit file', async (t) => {
  const dir = temp(t);
  const breaker = await CircuitBreaker.load(join(dir, 'jev-circuit.json'));
  const built = build(t, { breaker });
  assert.equal((await built.engine.decide(request())).abstained, false, 'the first success records the model');
  const another = request({ packet: { ...request().packet, facts: { publicApiChanged: false, migrationPresent: false } } });
  let outcome;
  const writes = await countFsyncs(async () => {
    outcome = await built.engine.decide(another);
  });
  assert.equal(outcome.abstained, false);
  assert.equal(writes, 4, 'the circuit file is not rewritten for a success that records nothing new');
});

test('before the request leaves, the reservation and the entry that says sent are on disk, and they name each other', async (t) => {
  let seen = null;
  let built;
  const onRequest = () => {
    // The mock reports the request as it arrives; what is on disk now is what a crash now would find.
    const files = readdirSync(built.journalDir).filter((name) => name.endsWith('.json'));
    const journal = files.map((name) => JSON.parse(readFileSync(join(built.journalDir, name), 'utf8')));
    const budget = JSON.parse(readFileSync(built.budgetFile, 'utf8'));
    seen = { journal, budget };
  };
  built = build(t, { onRequest });
  const outcome = await built.engine.decide(request());
  assert.equal(outcome.abstained, false);
  assert.ok(seen !== null, 'the request arrived');
  assert.equal(seen.journal.length, 1);
  const [entry] = seen.journal;
  assert.equal(entry.state, 'evaluating');
  assert.equal(entry.draft.sent, true);
  assert.equal(typeof entry.draft.reservationId, 'string');
  assert.deepEqual(entry.history.map((h) => h.state), ['received', 'validated', 'evidence-ready', 'reserved', 'evaluating']);
  assert.equal(entry.record, null, 'no final record yet');
  const reservation = seen.budget.reservations.find((r) => r.id === entry.draft.reservationId);
  assert.ok(reservation !== undefined, 'the reservation is in the budget file');
  assert.equal(reservation.state, 'reserved');
  assert.equal(reservation.decisionId, entry.decisionId);
  assert.equal(reservation.reservedMicroUsd, entry.draft.reservedMicroUsd);
});

test('a write before the send that fails sends nothing, releases the reservation and records the refusal as not sent', async (t) => {
  const built = build(t);
  const original = built.engine.journal.persist.bind(built.engine.journal);
  let calls = 0;
  built.engine.journal.persist = async (entry) => {
    calls += 1;
    return calls === 1 ? { ok: false, reasonCode: 'JOURNAL_WRITE' } : original(entry);
  };
  const outcome = await built.engine.decide(request());
  assert.equal(outcome.abstained, true);
  assert.equal(outcome.reasonCode, 'JOURNAL_UNAVAILABLE');
  assert.equal(built.port.calls, 0, 'the request never left');
  assert.equal(built.mock.calls, 0);
  const snapshot = await built.budget.snapshot();
  assert.deepEqual([snapshot.reservedMicroUsd, snapshot.heldMicroUsd, snapshot.committedMicroUsd], [0, 0, 0], 'the reservation was released');
  const entry = await built.engine.entry(outcome.decisionId);
  assert.equal(entry.draft.sent, false, 'the record that is ended says nothing was sent');
  assert.equal(entry.record.billingBasis, 'no-provider-call');
  assert.equal(entry.record.providerCalls, 0);
  assert.equal(entry.state, 'abstained');
});

test('a crash after the budget commit and before the final record is settled from the budget: the usage is not lost, nothing is held', async (t) => {
  const built = build(t);
  const original = built.engine.journal.persist.bind(built.engine.journal);
  let calls = 0;
  built.engine.journal.persist = async (entry) => {
    calls += 1;
    if (calls === 2) throw new Error('process died'); // the final write of the decision: the process is gone
    return original(entry);
  };
  await assert.rejects(built.engine.decide(request()), /process died/);
  assert.equal(built.port.calls, 1, 'the request was sent and answered');
  const crashed = (await Promise.all(readdirSync(built.journalDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(built.journalDir, n), 'utf8')))))[0];
  assert.equal(crashed.state, 'evaluating');
  assert.equal(crashed.draft.usage, null, 'the entry on disk does not know the usage yet');
  const committed = await built.budget.get(crashed.draft.reservationId);
  assert.equal(committed.state, 'committed', 'the budget already holds it');

  const restarted = createDecisionEngine({ transport: null, journalDir: built.journalDir, budget: built.budget });
  assert.equal((await restarted.recover()).recovered, 1);
  const record = await restarted.lookup(crashed.decisionId);
  assert.equal(record.outcome, 'abstained');
  assert.deepEqual(record.reasonCodes.slice(0, 2), ['CRASH_RECOVERED', 'INTERRUPTED_EVALUATING']);
  assert.equal(record.billingBasis, 'provider-reported-usage', 'the usage is the budget\'s, not an estimate');
  assert.deepEqual(record.usage, committed.usage);
  assert.equal(record.cost.actualMicroUsd, committed.actualMicroUsd);
  const snapshot = await built.budget.snapshot();
  assert.equal(snapshot.holds, 0, 'a settled reservation is not held');
  assert.equal(snapshot.committedMicroUsd, committed.actualMicroUsd, 'and the money is counted once');
  assert.equal((await restarted.recover()).recovered, 0, 'recovery is idempotent');
});

test('a crash while the request is in flight (the entry before the send is the last write) is held for reconciliation, as before', async (t) => {
  let arrive;
  const arrived = new Promise((resolve) => {
    arrive = resolve;
  });
  // The stub answers late, so the call is in flight, with the entry before the send as the last write, when the process "dies".
  const built = build(t, { scenario: 'late', lateMs: 60_000, onRequest: () => arrive() });
  const tracker = trackEngine(built.engine);
  const controller = new AbortController();
  const pending = built.engine.decide(request(), { signal: controller.signal });
  pending.catch(() => undefined);
  await arrived;
  const files = readdirSync(built.journalDir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  const inFlight = JSON.parse(readFileSync(join(built.journalDir, files[0]), 'utf8'));
  assert.equal(inFlight.state, 'evaluating');
  assert.equal(inFlight.draft.sent, true);
  const restarted = createDecisionEngine({ transport: null, journalDir: built.journalDir, budget: built.budget });
  assert.equal((await restarted.recover()).recovered, 1);
  const record = await restarted.lookup(inFlight.decisionId);
  assert.equal(record.billingBasis, 'estimate-pending-reconcile');
  assert.equal((await built.budget.snapshot()).holds, 1, 'the reservation is held: the request may have been billed');
  controller.abort();
  await tracker.settled();
});

test('recover clears the temps a killed write left in the journal folder', async (t) => {
  const built = build(t);
  assert.equal((await built.engine.decide(request())).abstained, false);
  const stale = join(built.journalDir, '.d-00000009-0000-4000-8000-000000000000.json.4242.abcdef012345.jtmp');
  writeFileSync(stale, 'partial'); // test-hygiene: not product source
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, old, old);
  const restarted = createDecisionEngine({ transport: null, journalDir: built.journalDir, budget: built.budget });
  await restarted.recover();
  assert.equal(existsSync(stale), false);
});

test('four decisions at once each keep their own entry and record', async (t) => {
  const { engine, journalDir } = build(t);
  const variants = [0, 1, 2, 3].map((n) => request({ packet: { ...request().packet, facts: { publicApiChanged: n % 2 === 0, migrationPresent: n >= 2 } } }));
  const outcomes = await Promise.all(variants.map((v) => engine.decide(v)));
  assert.equal(outcomes.every((o) => o.abstained === false), true, JSON.stringify(outcomes));
  assert.equal(new Set(outcomes.map((o) => o.decisionId)).size, 4);
  for (const outcome of outcomes) {
    const entry = JSON.parse(readFileSync(join(journalDir, `${outcome.decisionId}.json`), 'utf8'));
    assert.equal(entry.state, 'planned');
    assert.equal(entry.record.providerCalls, 1);
    assert.equal(entry.history.length, 7);
  }
});
