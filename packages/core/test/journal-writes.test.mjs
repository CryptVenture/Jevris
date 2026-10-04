import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The decision journal writes where a crash must be able to settle a decision, not at every state.
// `begin` and `advance` move an entry in memory with the checks `transition` makes; `persist` writes
// it, history and all. A write no longer lists the folder for stale temps (that costs time in
// proportion to the journal), so `sweepStaleTemps` clears them once at start. The circuit breaker
// writes its file only when something the file records changed.
const core = await import('@jevris/core');
const { DecisionJournal, CircuitBreaker } = core;

const NOW = Date.parse('2026-10-04T10:00:00Z'); // pinned-clock: the journal's clock
const id = (n) => `d-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function draft(extra = {}) {
  return {
    specId: 'task-profile', specVersion: 'v1', workspaceId: 'w-journal', taskId: null, evidenceRevision: 'rev-1', lane: 'interactive', mode: 'observe',
    receivedAt: new Date(NOW).toISOString(), questionHash: `sha256:${'a'.repeat(64)}`, packetHash: null, reservationId: null, reservedMicroUsd: 0,
    sent: false, usage: null, modelResolved: null, ...extra,
  };
}

function planned(decisionId) {
  return {
    schemaVersion: '1.0', decisionId, specId: 'task-profile', modelResolved: null, mode: 'observe', evidenceRevision: 'rev-1', outcome: 'advisory',
    reasonCodes: ['DECISION_ADVISORY'], proposedAction: { kind: 'advise', templateId: 'task-profile', evidenceIds: [] }, appliedAction: null, usage: null,
    billingBasis: 'no-provider-call', actualTaskOutcome: 'not-yet-observed',
  };
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-journal-writes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Counts every fsync made through a file handle while `fn` runs (each durable write is one). */
async function countFsyncs(fn) {
  const probe = await open(join(tmpdir(), `.journal-writes-probe-${process.pid}`), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  rmSync(join(tmpdir(), `.journal-writes-probe-${process.pid}`), { force: true });
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

test('begin and advance write nothing; persist writes the entry once, with its whole history', async (t) => {
  const dir = temp(t);
  const journal = new DecisionJournal(dir, () => NOW);
  let entry;
  const writes = await countFsyncs(async () => {
    const begun = journal.begin(id(1), draft());
    assert.equal(begun.ok, true);
    entry = begun.entry;
    for (const to of ['validated', 'evidence-ready', 'reserved', 'evaluating']) {
      const moved = journal.advance(entry, to, { draft: to === 'evaluating' ? { sent: true } : {} });
      assert.equal(moved.ok, true, to);
      entry = moved.entry;
    }
  });
  assert.equal(writes, 0, 'moving through states in memory makes no durable write');
  assert.equal(existsSync(join(dir, `${id(1)}.json`)), false, 'and no file');
  assert.equal(await journal.read(id(1)), null);

  const written = await countFsyncs(async () => {
    assert.equal((await journal.persist(entry)).ok, true);
  });
  assert.equal(written, 1, 'one write');
  const back = await journal.read(id(1));
  assert.deepEqual(back.history.map((h) => h.state), ['received', 'validated', 'evidence-ready', 'reserved', 'evaluating'], 'the history still names every state');
  assert.equal(back.state, 'evaluating');
  assert.equal(back.draft.sent, true);
});

test('transition and create still write each step, exactly as before', async (t) => {
  const dir = temp(t);
  const journal = new DecisionJournal(dir, () => NOW);
  let entry;
  const writes = await countFsyncs(async () => {
    entry = (await journal.create(id(2), draft())).entry;
    entry = (await journal.transition(entry, 'validated')).entry;
    entry = (await journal.transition(entry, 'planned', { record: planned(id(2)) })).entry;
  });
  assert.equal(writes, 3);
  assert.deepEqual((await journal.read(id(2))).history.map((h) => h.state), ['received', 'validated', 'planned']);
});

test('advance makes the checks transition makes: an illegal step, an invalid record and a replaced record are refused', async (t) => {
  const journal = new DecisionJournal(temp(t), () => NOW);
  const begun = journal.begin(id(3), draft()).entry;
  assert.equal(journal.advance(begun, 'planned').reasonCode, 'ILLEGAL_TRANSITION', 'received cannot go straight to planned');
  assert.equal(journal.advance(begun, 'validated', { record: { not: 'a record' } }).reasonCode, 'INVALID_RECORD');
  assert.equal(journal.begin('not-a-decision-id', draft()).reasonCode, 'INVALID_DECISION_ID');
  const validated = journal.advance(begun, 'validated').entry;
  const done = journal.advance(validated, 'planned', { record: planned(id(3)) });
  assert.equal(done.ok, true);
  const again = journal.advance({ ...done.entry, state: 'validated' }, 'planned', { record: planned(id(3)) });
  assert.equal(again.reasonCode, 'RECORD_IMMUTABLE', 'a record already there is not replaced');
});

test('a failed persist is JOURNAL_WRITE, and the in-memory entry is unchanged', async (t) => {
  const dir = temp(t);
  const journal = new DecisionJournal(join(dir, 'blocked', 'decisions'), () => NOW);
  writeFileSync(join(dir, 'blocked'), 'a file where the folder should be'); // test-hygiene: not product source
  const begun = journal.begin(id(4), draft());
  const result = await journal.persist(begun.entry);
  assert.deepEqual([result.ok, result.reasonCode], [false, 'JOURNAL_WRITE']);
  assert.equal(begun.entry.state, 'received');
});

test('a write does not list the folder, and sweepStaleTemps removes what a killed write left, once', async (t) => {
  const dir = temp(t);
  const journal = new DecisionJournal(dir, () => NOW);
  const stale = join(dir, `.${id(9)}.json.4242.abcdef012345.jtmp`);
  const fresh = join(dir, `.${id(8)}.json.4343.abcdef012345.jtmp`);
  const other = join(dir, 'notes.txt');
  for (const path of [stale, fresh, other]) writeFileSync(path, 'partial'); // test-hygiene: not product source
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, old, old);
  utimesSync(other, old, old);
  // A write of another decision leaves every temp as it found it: it no longer sweeps.
  assert.equal((await journal.create(id(5), draft())).ok, true);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.jtmp')).sort(), [`.${id(8)}.json.4343.abcdef012345.jtmp`, `.${id(9)}.json.4242.abcdef012345.jtmp`]);
  assert.equal(await journal.sweepStaleTemps(), 1);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.jtmp')), [`.${id(8)}.json.4343.abcdef012345.jtmp`], 'the stale temp is gone; a fresh one may belong to a writer that is running');
  assert.equal(existsSync(other), true, 'a file that is not a temp is never touched');
  assert.equal(await new DecisionJournal(join(dir, 'missing'), () => NOW).sweepStaleTemps(), 0, 'a folder that does not exist is nothing to sweep');
});

test('the circuit breaker writes its file when something it records changed, not on every success', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'jev-circuit.json');
  let at = NOW;
  const breaker = await CircuitBreaker.load(file, { now: () => at });
  const key = 'typesafe:primary';
  const succeed = async () => {
    at += 1000;
    breaker.recordSuccess(key, 'jev-1.13.0');
    return breaker.persist();
  };
  assert.equal(await countFsyncs(succeed), 1, 'the first success records the model: one write');
  const first = readFileSync(file, 'utf8');
  assert.equal(await countFsyncs(succeed), 0, 'a second success on a closed circuit records nothing new');
  assert.equal(await countFsyncs(succeed), 0);
  assert.equal(readFileSync(file, 'utf8'), first, 'the file is as it was');
  at += 1000;
  breaker.recordFailure(key, 'timeout', null);
  assert.equal(await countFsyncs(() => breaker.persist()), 1, 'a failure is a change');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries[key].consecutiveFailures, 1);
  assert.equal(await countFsyncs(succeed), 1, 'the success that resets the failures is a change too');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries[key].consecutiveFailures, 0);
  // Opening the circuit and a restart: the state the file holds is what the next process loads.
  for (let i = 0; i < 5; i += 1) breaker.recordFailure(key, 'server', null);
  assert.equal(await breaker.persist(), true);
  const restarted = await CircuitBreaker.load(file, { now: () => at });
  assert.equal(restarted.snapshot(key).state, 'open');
  // A write that failed is not remembered as done.
  const blocked = await CircuitBreaker.load(join(dir, 'no-folder', 'x', 'circuit.json'), { now: () => at });
  blocked.recordFailure(key, 'server', null);
  writeFileSync(join(dir, 'no-folder'), 'a file where the folder should be'); // test-hygiene: not product source
  assert.equal(await blocked.persist(), false);
  assert.equal(await blocked.persist(), false, 'asked again, it tries again');
});
