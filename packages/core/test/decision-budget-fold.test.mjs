import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The budget file is rewritten whole, with an fsync, on every reserve and settlement, so its size is the cost of each
// (27 ms at 3 KiB, 108 ms at 5.8 MiB). Settled entries of the current period are folded into one summary entry per
// workspace once more than `foldSettledAbove` are held. Totals, limits and caps must be exactly what they were, holds
// and open reservations must never be folded, and the file must stay one atomic write that another process can load.
const core = await import('@jevris/core');
const { DecisionBudget, createDecisionEngine } = core;

const NOW = Date.parse('2026-10-04T12:00:00Z'); // pinned-clock: the budget's period
// Small thresholds keep the number of fsyncs (each an entry in a slow runner's queue) low.
const FOLDING = { foldSettledAbove: 6, keepSettled: 2 };
const NEVER = { foldSettledAbove: 1_000_000, keepSettled: 1_000_000 };

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-budget-fold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const open = (file, extra = {}) => DecisionBudget.open(file, { limitMicroUsd: 1_000_000, now: () => NOW, ...extra });
const USAGE = (i) => ({ inputTokens: 500 + i, outputTokens: 20 });
const entries = (file) => JSON.parse(readFileSync(file, 'utf8')).reservations;

/** The same operations on two budgets: the one that folds and the one that never does. */
async function drive(budgets, steps) {
  const ids = [];
  for (let i = 0; i < steps; i += 1) {
    const workspaceId = i % 3 === 0 ? 'w-a' : 'w-b';
    const results = [];
    for (const budget of budgets) results.push(await budget.reserve({ decisionId: `d-${i}`, workspaceId, microUsd: 40 + (i % 5) }));
    assert.deepEqual(results.map((r) => r.ok), budgets.map(() => true));
    const kind = i % 7 === 0 ? 'release' : 'commit';
    for (let b = 0; b < budgets.length; b += 1) {
      const id = results[b].reservation.id;
      if (kind === 'release') await budgets[b].release(id);
      else await budgets[b].commit(id, { usage: USAGE(i), actualMicroUsd: 21 + (i % 4) });
    }
    ids.push(results.map((r) => r.reservation.id));
  }
  return ids;
}

test('folding changes no total: the machine and each workspace see exactly what an unfolded budget sees', async (t) => {
  const dir = temp(t);
  const folding = open(join(dir, 'folding.json'), FOLDING);
  const plain = open(join(dir, 'plain.json'), NEVER);
  await drive([folding, plain], 24);
  const a = await folding.snapshot('w-a');
  const b = await plain.snapshot('w-a');
  const strip = ({ reservations: _count, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(strip(await folding.snapshot('w-b')), strip(await plain.snapshot('w-b')));
  assert.ok(a.committedMicroUsd > 0);
  assert.ok(a.reservations < b.reservations, 'the file holds fewer entries');
  assert.ok(entries(join(dir, 'folding.json')).length <= FOLDING.foldSettledAbove + 3, 'and stays near the threshold');
});

test('the file is bounded however many decisions are made, and a summary is one committed entry per workspace with the sums', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'b.json');
  const budget = open(file, { limitMicroUsd: 1_000_000_000, ...FOLDING });
  let spent = 0;
  let input = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: i % 2 === 0 ? 'w-a' : 'w-b', microUsd: 50 });
    assert.equal(r.ok, true);
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 21 });
    spent += 21;
    input += USAGE(i).inputTokens;
  }
  const rows = entries(file);
  assert.ok(rows.length <= FOLDING.foldSettledAbove + 3, `${rows.length} entries after 30 decisions`);
  const summaries = rows.filter((r) => r.id.startsWith('r-fold-'));
  assert.deepEqual(summaries.map((r) => r.workspaceId).sort(), ['w-a', 'w-b']);
  for (const row of summaries) assert.deepEqual([row.state, row.decisionId, row.source, row.actualMicroUsd, row.reservedMicroUsd], ['committed', 'folded', 'provider-usage', row.actualMicroUsd, row.actualMicroUsd]);
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.committedMicroUsd, spent);
  const tokens = rows.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0);
  assert.equal(tokens, input, 'usage is summed too');
});

test('holds and open reservations are never folded and can still be settled afterwards', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'b.json');
  const budget = open(file, FOLDING);
  const held = await budget.reserve({ decisionId: 'd-held', workspaceId: 'w-a', microUsd: 70 });
  await budget.hold(held.reservation.id);
  const open1 = await budget.reserve({ decisionId: 'd-open', workspaceId: 'w-a', microUsd: 60 });
  for (let i = 0; i < 16; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  const ids = entries(file).map((r) => r.id);
  assert.ok(ids.includes(held.reservation.id) && ids.includes(open1.reservation.id), 'both are still rows of their own');
  const snap = await budget.snapshot();
  assert.deepEqual([snap.heldMicroUsd, snap.reservedMicroUsd, snap.holds], [70, 60, 1]);
  assert.equal((await budget.reconcile(held.reservation.id, { actualMicroUsd: 33, source: 'billing-export' })).ok, true, 'the hold reconciles');
  assert.equal((await budget.commit(open1.reservation.id, { usage: USAGE(1), actualMicroUsd: 44 })).ok, true, 'the open reservation commits');
  const after = await budget.snapshot();
  assert.deepEqual([after.heldMicroUsd, after.reservedMicroUsd, after.committedMicroUsd], [0, 0, 16 * 20 + 33 + 44]);
});

test('an entry that was folded is no longer a row (UNKNOWN_RESERVATION); one that was kept is still ALREADY_SETTLED', async (t) => {
  const dir = temp(t);
  const budget = open(join(dir, 'b.json'), FOLDING);
  const first = await budget.reserve({ decisionId: 'd-first', workspaceId: 'w-a', microUsd: 30 });
  await budget.commit(first.reservation.id, { usage: USAGE(0), actualMicroUsd: 20 });
  let last;
  for (let i = 0; i < 14; i += 1) {
    last = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await budget.commit(last.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  assert.equal(await budget.get(first.reservation.id), null);
  assert.equal((await budget.commit(first.reservation.id, { usage: USAGE(0), actualMicroUsd: 99 })).reasonCode, 'UNKNOWN_RESERVATION');
  assert.equal((await budget.commit(last.reservation.id, { usage: USAGE(0), actualMicroUsd: 99 })).reasonCode, 'ALREADY_SETTLED');
  assert.equal((await budget.snapshot()).committedMicroUsd, 15 * 20, 'and the money of the folded one is still counted, once');
});

test('the machine limit and a workspace cap still hold over folded spend', async (t) => {
  const dir = temp(t);
  const budget = open(join(dir, 'b.json'), { limitMicroUsd: 400, workspaceLimit: (id) => (id === 'w-a' ? 200 : null), ...FOLDING });
  for (let i = 0; i < 10; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 20 });
    assert.equal(r.ok, true, `reservation ${i}`);
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  // 10 x 20 = 200: w-a is at its cap, most of that spend is a summary now.
  const capped = await budget.reserve({ decisionId: 'd-over', workspaceId: 'w-a', microUsd: 1 });
  assert.deepEqual([capped.ok, capped.reasonCode, capped.cap, capped.capLimitMicroUsd], [false, 'BUDGET', 'workspace', 200]);
  for (let i = 0; i < 10; i += 1) {
    const r = await budget.reserve({ decisionId: `d-b${i}`, workspaceId: 'w-b', microUsd: 20 });
    assert.equal(r.ok, true, `w-b ${i}`);
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  const machine = await budget.reserve({ decisionId: 'd-machine', workspaceId: 'w-b', microUsd: 1 });
  assert.deepEqual([machine.ok, machine.reasonCode, machine.cap], [false, 'BUDGET', 'machine']);
});

test('released entries cost nothing: a summary of releases only is not kept', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'b.json');
  const budget = open(file, FOLDING);
  for (let i = 0; i < 14; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await budget.release(r.reservation.id);
  }
  const rows = entries(file);
  assert.equal(rows.some((r) => r.id.startsWith('r-fold-')), false);
  assert.ok(rows.length <= FOLDING.foldSettledAbove + 2);
  assert.equal((await budget.snapshot()).committedMicroUsd, 0);
});

test('a new period starts clean: last month\'s summary stops counting and is dropped', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'b.json');
  let now = NOW;
  const budget = DecisionBudget.open(file, { limitMicroUsd: 1_000_000, now: () => now, ...FOLDING });
  for (let i = 0; i < 14; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  assert.equal((await budget.snapshot()).committedMicroUsd, 280);
  now = Date.parse('2026-11-02T00:00:00Z'); // pinned-clock: next month
  assert.equal((await budget.snapshot()).committedMicroUsd, 0);
  const r = await budget.reserve({ decisionId: 'd-new', workspaceId: 'w-a', microUsd: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(entries(file).map((row) => row.period), ['2026-11'], 'the closed month is gone from the file');
});

test('a second budget on the same file sees the folded totals and the file is valid JSON of the same version', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'b.json');
  const a = open(file, FOLDING);
  for (let i = 0; i < 14; i += 1) {
    const r = await a.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await a.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  const b = open(file, NEVER);
  assert.equal((await b.snapshot()).committedMicroUsd, 280);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 'jevris-decision-budget-1');
  assert.ok(statSync(file).size < 10_000, 'a few KiB');
});

test('an in-memory budget (no file) folds the same way', async () => {
  const budget = DecisionBudget.open(null, { limitMicroUsd: 1_000_000, now: () => NOW, ...FOLDING });
  for (let i = 0; i < 40; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.committedMicroUsd, 800);
  assert.ok(snapshot.reservations <= FOLDING.foldSettledAbove + 2);
});

test('bad thresholds fall back to the defaults, and the fold threshold is never below what is kept', async (t) => {
  const dir = temp(t);
  const budget = open(join(dir, 'b.json'), { foldSettledAbove: -1, keepSettled: Number.NaN });
  for (let i = 0; i < 30; i += 1) {
    const r = await budget.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await budget.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  assert.equal((await budget.snapshot()).reservations, 30, 'nothing is folded at the defaults for 30 entries');
  const tight = open(join(dir, 't.json'), { foldSettledAbove: 2, keepSettled: 8 });
  for (let i = 0; i < 12; i += 1) {
    const r = await tight.reserve({ decisionId: `d-${i}`, workspaceId: 'w-a', microUsd: 30 });
    await tight.commit(r.reservation.id, { usage: USAGE(i), actualMicroUsd: 20 });
  }
  assert.equal((await tight.snapshot()).committedMicroUsd, 240);
});

test('engine.reconcileUsage on a decision whose settled reservation was folded still reconciles the record', async (t) => {
  const dir = temp(t);
  const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST } = await import('@jevris/provider-typesafe');
  const budget = open(join(dir, 'b.json'), { ...FOLDING, limitMicroUsd: 10_000_000 });
  const transport = createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: createMockFetch({ scenario: 'valid' }) });
  const engine = createDecisionEngine({ transport, journalDir: join(dir, 'decisions'), budget });
  const compiled = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: [], deadlineMs: 60_000, fallback: 'rules-only' });
  const ask = (n) => engine.decide({ spec: compiled.spec, questions: CONFORMANCE_REQUEST.questions, workspaceId: 'w-fold', evidenceRevision: 'rev-1', packet: { objective: 'Classify.', trustedPolicy: {}, facts: { n }, evidence: [], missingEvidence: [] } });
  const first = await ask(0);
  assert.equal(first.abstained, false, JSON.stringify(first));
  const reservationId = (await engine.entry(first.decisionId)).draft.reservationId;
  for (let n = 1; n < 12; n += 1) assert.equal((await ask(n)).abstained, false);
  assert.equal(await budget.get(reservationId), null, 'the first decision\'s reservation was folded');
  const before = (await budget.snapshot()).committedMicroUsd;
  const reconciled = await engine.reconcileUsage(first.decisionId, { actualMicroUsd: 5, source: 'billing-export' });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.record.state, 'reconciled');
  assert.equal(reconciled.record.cost.actualMicroUsd, 5);
  assert.equal((await budget.snapshot()).committedMicroUsd, before, 'the budget was already settled and is not changed, as for an unfolded committed entry');
});
