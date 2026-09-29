import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const {
  openStore,
  commitOwned,
  readCommitted,
  closeStore,
  admitOwned,
  reconcileOnOpen,
  effectDisposition,
  noteMissingProcess,
  publishCurrent,
  markStale,
  billingReport,
  reconcileOwnedUsage,
} = await import('../dist/index.js');

const UNSAFE = 9007199254740993n;

function tempDir() {
  return makeTempDir('jevris-store-budget-');
}

function openTest(path) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
  });
}

function owned(decisionId, operationId, extra) {
  return {
    decisionId,
    operationId,
    reservationMicroUsd: 1n,
    remainingMicroUsd: 100n,
    questions: 1,
    attempts: 1,
    usage: { known: true, inputTokens: 2, outputTokens: 3 },
    consumedMicroUsd: 1n,
    ...extra,
  };
}

test('unknown usage is null tokens and a conservative hold that reconciliation clears, never a lock (DATA-07)', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'unknown.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const first = commitOwned(opened, {
      decisionId: 'decUnknown',
      operationId: 'opUnknown',
      reservationMicroUsd: 7n,
      remainingMicroUsd: 10n,
      questions: 1,
      attempts: 1,
      usage: { known: false },
    });
    assert.equal(first.ok, true);
    const stored = readCommitted(opened, 'decUnknown');
    assert.ok(stored);
    assert.equal(stored.usageKnown, false);
    assert.equal(stored.inputTokens, null);
    assert.equal(stored.outputTokens, null);
    assert.notEqual(stored.inputTokens, 0);
    assert.notEqual(stored.inputTokens, 0n);
    assert.notEqual(stored.outputTokens, 0n);
    assert.equal(stored.reservationMicroUsd, 7n);

    const contradicted = commitOwned(opened, {
      decisionId: 'decTokens',
      operationId: 'opTokens',
      reservationMicroUsd: 1n,
      remainingMicroUsd: 100n,
      questions: 1,
      attempts: 1,
      usage: { known: false, inputTokens: 4, outputTokens: 5 },
    });
    assert.equal(contradicted.ok, false);
    assert.equal(readCommitted(opened, 'decTokens'), undefined);

    const next = commitOwned(opened, {
      decisionId: 'decNext',
      operationId: 'opNext',
      reservationMicroUsd: 1n,
      remainingMicroUsd: 100n,
      questions: 1,
      attempts: 1,
      usage: { known: true, inputTokens: 1, outputTokens: 1 },
      consumedMicroUsd: 1n,
    });
    // The unknown usage holds its 7 of 100: a write that still fits is admitted.
    assert.equal(next.ok, true);
    assert.equal(readCommitted(opened, 'decUnknown').reservationMicroUsd, 7n);
    // 10 remaining minus the 7 hold and 1 consumed does not cover 4: refused.
    const tight = { decisionId: 'decTight', operationId: 'opTight', reservationMicroUsd: 4n, remainingMicroUsd: 10n, questions: 1, attempts: 1, usage: { known: false } };
    const refused = commitOwned(opened, tight);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'BUDGET');
    // Reconciliation records the billed usage; the hold now counts 2 instead of 7.
    const reconciled = reconcileOwnedUsage(opened, { decisionId: 'decUnknown', inputTokens: 4, outputTokens: 1, consumedMicroUsd: 2n });
    assert.deepEqual(reconciled, { ok: true, releasedMicroUsd: 5n });
    const settled = readCommitted(opened, 'decUnknown');
    assert.equal(settled.usageKnown, true);
    assert.equal(settled.inputTokens, 4n);
    assert.equal(reconcileOwnedUsage(opened, { decisionId: 'decUnknown', inputTokens: 4, outputTokens: 1, consumedMicroUsd: 2n }).reason, 'not-held');
    assert.equal(commitOwned(opened, tight).ok, true);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a short budget, a missing remaining value, and a missing consumed value insert nothing', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'short.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const covered = commitOwned(
      opened,
      owned('decCovered', 'opCovered', {
        reservationMicroUsd: 7n,
        remainingMicroUsd: 10n,
        // Settled usage counts its consumed cost (DATA-06); here it used the whole reservation.
        consumedMicroUsd: 7n,
      }),
    );
    assert.equal(covered.ok, true);
    const unaffordable = commitOwned(
      opened,
      owned('decShort', 'opShort', {
        reservationMicroUsd: 4n,
        remainingMicroUsd: 10n,
      }),
    );
    assert.equal(unaffordable.ok, false);
    if (!unaffordable.ok) assert.equal(unaffordable.reason, 'BUDGET');
    assert.equal(readCommitted(opened, 'decShort'), undefined);
    assert.equal(readCommitted(opened, 'decCovered').reservationMicroUsd, 7n);

    const missingRemaining = admitOwned(
      opened,
      owned('decMissing', 'opMissing', { remainingMicroUsd: undefined }),
    );
    assert.equal(missingRemaining.ok, false);
    if (!missingRemaining.ok) assert.equal(missingRemaining.reason, 'BUDGET');
    assert.notEqual(missingRemaining.reason, undefined);
    assert.equal(readCommitted(opened, 'decMissing'), undefined);

    const omitted = commitOwned(opened, {
      decisionId: 'decOmitted',
      operationId: 'opOmitted',
      reservationMicroUsd: 1n,
      questions: 1,
      attempts: 1,
      usage: { known: true, inputTokens: 1, outputTokens: 1 },
      consumedMicroUsd: 1n,
    });
    assert.equal(omitted.ok, false);
    if (!omitted.ok) assert.equal(omitted.reason, 'BUDGET');
    assert.equal(readCommitted(opened, 'decOmitted'), undefined);

    const missingConsumed = commitOwned(opened, {
      decisionId: 'decConsumed',
      operationId: 'opConsumed',
      reservationMicroUsd: 1n,
      remainingMicroUsd: 100n,
      questions: 1,
      attempts: 1,
      usage: { known: true, inputTokens: 1, outputTokens: 1 },
    });
    assert.equal(missingConsumed.ok, false);
    assert.equal(readCommitted(opened, 'decConsumed'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('zero is admitted when remaining covers it, and a number is not money', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'edges.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const zero = commitOwned(
      opened,
      owned('decZero', 'opZero', { reservationMicroUsd: 0n, remainingMicroUsd: 10n, consumedMicroUsd: 0n }),
    );
    assert.equal(zero.ok, true);
    assert.equal(readCommitted(opened, 'decZero').reservationMicroUsd, 0n);

    const unsafe = commitOwned(
      opened,
      owned('decUnsafe', 'opUnsafe', {
        reservationMicroUsd: UNSAFE,
        remainingMicroUsd: UNSAFE,
        consumedMicroUsd: 0n,
      }),
    );
    assert.equal(unsafe.ok, true);
    const unsafeRow = readCommitted(opened, 'decUnsafe');
    assert.equal(typeof unsafeRow.reservationMicroUsd, 'bigint');
    assert.notEqual(typeof unsafeRow.reservationMicroUsd, 'number');
    assert.equal(unsafeRow.reservationMicroUsd, UNSAFE);

    const numbered = commitOwned(
      opened,
      owned('decNumber', 'opNumber', { reservationMicroUsd: 1 }),
    );
    assert.equal(numbered.ok, false);
    if (!numbered.ok) assert.equal(numbered.reason, 'money-refused');
    assert.equal(readCommitted(opened, 'decNumber'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('questions, attempts, and a met caller-supplied cap each stop the write', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'cap.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const questions = commitOwned(opened, owned('decQ', 'opQ', { questions: 2 }));
    assert.equal(questions.ok, false);
    if (!questions.ok) assert.equal(questions.reason, 'BUDGET');
    assert.equal(readCommitted(opened, 'decQ'), undefined);

    const attempts = commitOwned(opened, owned('decA', 'opA', { attempts: 0 }));
    assert.equal(attempts.ok, false);
    if (!attempts.ok) assert.equal(attempts.reason, 'BUDGET');
    assert.equal(readCommitted(opened, 'decA'), undefined);

    const firstCap = commitOwned(opened, owned('decCap', 'opCap', { maxOwnedDecisions: 1 }));
    assert.equal(firstCap.ok, true);
    const met = commitOwned(opened, owned('decCap2', 'opCap2', { maxOwnedDecisions: 1 }));
    assert.equal(met.ok, false);
    if (!met.ok) assert.equal(met.reason, 'BUDGET');
    assert.equal(readCommitted(opened, 'decCap2'), undefined);
    closeStore(opened);

    const wide = openTest(join(dir, 'wide.sqlite'));
    assert.equal(wide.ok, true);
    if (!wide.ok) return;
    for (let i = 0; i < 13; i += 1) {
      const admitted = commitOwned(
        wide,
        owned(`decWide${i}`, `opWide${i}`, { remainingMicroUsd: 100n, reservationMicroUsd: 1n }),
      );
      assert.equal(admitted.ok, true, `write ${i} was refused`);
    }
    assert.ok(readCommitted(wide, 'decWide12'));
    closeStore(wide);
  } finally {
    removeTempDir(dir);
  }
});

test('an unknown effect stays needs-reconciliation across restart and is not repeatable', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'effect.sqlite');
  const childPath = join(dir, 'child.mjs');
  const storeUrl = new URL('../dist/index.js', import.meta.url).href;
  writeFileSync(
    childPath,
    `import { openStore, commitOwned, closeStore } from ${JSON.stringify(storeUrl)};
const opened = openStore({
  path: process.argv[2],
  role: 'in-process-test',
  workspaceId: 'wsA',
  hostScope: 'host-a',
});
if (!opened.ok) process.exit(2);
const committed = commitOwned(opened, {
  decisionId: 'decEffect',
  operationId: 'opEffect',
  reservationMicroUsd: 1n,
});
if (!committed.ok) process.exit(3);
closeStore(opened);
process.exit(0);
`,
  );
  try {
    const child = spawnSync(process.execPath, [childPath, dbPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(typeof reconcileOnOpen, 'function');
    const disposition = effectDisposition(opened, 'opEffect');
    assert.ok(disposition);
    assert.equal(disposition.effectStatus, 'needs-reconciliation');
    assert.equal(disposition.repeatable, false);
    assert.equal(disposition.outboxCount, 1);
    const noted = noteMissingProcess(opened, 'opEffect');
    assert.equal(noted.ok, true);
    const afterNote = effectDisposition(opened, 'opEffect');
    assert.equal(afterNote.effectStatus, 'needs-reconciliation');
    assert.equal(afterNote.processObserved, 'missing');
    assert.equal(afterNote.repeatable, false);
    assert.equal(afterNote.outboxCount, 1);
    assert.ok(readCommitted(opened, 'decEffect'));

    const published = publishCurrent(opened, 'decEffect');
    assert.equal(published.ok, false);
    if (!published.ok) assert.equal(published.reason, 'refused');
    markStale(opened, 'decEffect');
    const stale = publishCurrent(opened, 'decEffect');
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, 'refused');
    const retained = readCommitted(opened, 'decEffect');
    assert.ok(retained);
    assert.equal(retained.applied, false);

    const replay = commitOwned(opened, {
      decisionId: 'decOther',
      operationId: 'opEffect',
      reservationMicroUsd: 1n,
    });
    assert.equal(replay.ok, true);
    assert.equal(readCommitted(opened, 'decOther'), undefined);
    const still = effectDisposition(opened, 'opEffect');
    assert.equal(still.effectStatus, 'needs-reconciliation');
    assert.equal(still.repeatable, false);
    assert.equal(still.outboxCount, 1);

    const report = billingReport(opened);
    assert.equal(report.nonOwnedBilling, 'unknown');
    assert.equal(report.savingMicroUsd, null);
    assert.notEqual(report.savingMicroUsd, 0n);
    assert.equal(report.applied, false);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
