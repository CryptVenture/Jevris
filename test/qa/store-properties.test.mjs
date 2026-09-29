/**
 * Seeded property tests of the owned store (QA-03; SSOT §18.1).
 *
 * - no negative money: random reservation, envelope and spend values (negative, fractional,
 *   number instead of bigint, above the signed 64-bit range) never land in the store, and the
 *   reserved sum never passes the envelope;
 * - replay idempotence: re-committing an operation id, with the same or a different body, is
 *   `existing` and leaves every row as it was;
 * - crash-point injection between store writes: a failure at a random point inside a commit
 *   (the in-transaction callback) leaves no decision, proposed action or outbox row, and a
 *   process killed at a random commit leaves every decision with all three rows on reopen;
 * - no stale-receipt verification: a receipt that is not produced by a declared runner, or
 *   that names another source revision, is never accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptRunnerReceipt,
  admitJobReservation,
  closeStore,
  commitOwned,
  listCurrent,
  openStore,
  readCommitted,
  readJobReservations,
  runDeclaredCheck,
} from '@jevris/store';
import { forAll, RUNS } from './prng.mjs';

const require = createRequire(import.meta.url);
const SIGNED_MAX = 2n ** 63n - 1n;
const here = fileURLToPath(new URL('.', import.meta.url));

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-qa-store-'));
  const path = join(dir, 'store.sqlite');
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function open(path, workspaceId) {
  const opened = openStore({ path, role: 'in-process-test', workspaceId, hostScope: 'host-qa' });
  assert.equal(opened.ok, true, `the store opens: ${JSON.stringify(opened)}`);
  return opened;
}

/** A money-shaped value: valid bigints most of the time, hostile values otherwise. */
function money(rand, max) {
  return rand.pick([
    () => BigInt(rand.int(0, max)),
    () => BigInt(rand.int(0, max)),
    () => BigInt(rand.int(0, max)),
    () => -BigInt(rand.int(1, max)),
    () => rand.int(0, max),
    () => rand.int(0, max) + 0.5,
    () => SIGNED_MAX + BigInt(rand.int(1, 9)),
    () => String(rand.int(0, max)),
    () => null,
  ])();
}

test(`job reservations never store negative money or exceed the envelope over ${RUNS} runs (QA-03)`, () =>
  withStore(async (path) => {
    const store = open(path, 'wsMoney');
    try {
      let admittedTotal = 0;
      await forAll('reservation money', (rand, run) => {
        const held = readJobReservations(store)
          .filter((r) => r.state === 'reserved' || r.state === 'committed')
          .reduce((sum, r) => sum + r.reservedMicroUsd, 0n);
        // The envelope covers everything already held plus some room, so admissions stay possible.
        const envelope = held + BigInt(rand.int(0, 5_000));
        const jobs = Array.from({ length: rand.int(1, 4) }, (_, i) => ({
          reservationId: `r${run}x${i}`,
          ownerId: rand.pick(['ownerA', 'ownerB']),
          reservedMicroUsd: money(rand, 3_000),
          revision: 'rev1',
        }));
        const envelopeValue = rand.bool(0.1) ? money(rand, 5_000) : envelope;
        const before = readJobReservations(store).length;
        const result = admitJobReservation(store, { envelopeMicroUsd: envelopeValue, revision: 'rev1', mandatoryCheckIds: ['c'], jobs });
        const rows = readJobReservations(store);
        const validJobs = jobs.every((j) => typeof j.reservedMicroUsd === 'bigint' && j.reservedMicroUsd >= 0n && j.reservedMicroUsd <= SIGNED_MAX);
        const validEnvelope = typeof envelopeValue === 'bigint' && envelopeValue >= 0n && envelopeValue <= SIGNED_MAX;
        if (!validJobs || !validEnvelope) {
          assert.equal(result.ok, false, 'hostile money is refused');
          assert.equal(result.reason, 'money-refused');
          assert.equal(rows.length, before, 'a refused admission writes nothing');
        }
        for (const row of rows) {
          assert.equal(typeof row.reservedMicroUsd, 'bigint');
          assert.ok(row.reservedMicroUsd >= 0n, `negative reservation ${row.reservedMicroUsd}`);
        }
        const active = rows.filter((r) => r.state === 'reserved' || r.state === 'committed').reduce((sum, r) => sum + r.reservedMicroUsd, 0n);
        if (result.ok) {
          assert.ok(active <= envelopeValue, `reserved ${active} exceeds the envelope ${envelopeValue}`);
          admittedTotal += result.admitted.length;
        } else {
          assert.equal(rows.length, before, 'a refused admission writes nothing');
        }
      });
      assert.ok(admittedTotal > 0, 'some admissions succeed');
    } finally {
      closeStore(store);
    }
  }));

test(`replayed commits are idempotent over ${RUNS} runs (QA-03)`, () =>
  withStore(async (path) => {
    const store = open(path, 'wsReplay');
    try {
      await forAll('commit replay', (rand, run) => {
        const operationId = `op${run}`;
        const body = { decisionId: `dec${run}`, operationId, reservationMicroUsd: BigInt(rand.int(0, 100)), acknowledgment: rand.pick(['absent', 'present']) };
        const first = commitOwned(store, body);
        assert.deepEqual(first, { ok: true });
        const stored = readCommitted(store, body.decisionId);
        const replays = rand.int(1, 3);
        for (let i = 0; i < replays; i += 1) {
          const variant = rand.pick([body, { ...body, reservationMicroUsd: BigInt(rand.int(0, 100)) }, { ...body, decisionId: `other${run}x${i}` }]);
          assert.deepEqual(commitOwned(store, variant), { ok: true, existing: true }, 'a replayed operation id is existing');
          if (variant.decisionId !== body.decisionId) assert.equal(readCommitted(store, variant.decisionId), undefined, 'a replay under a new decision id writes nothing');
        }
        assert.deepEqual(readCommitted(store, body.decisionId), stored, 'the committed row is unchanged by replays');
      });
    } finally {
      closeStore(store);
    }
  }));

test(`a failure at a random point inside a commit leaves nothing behind over ${RUNS} runs (QA-03)`, () =>
  withStore(async (path) => {
    const store = open(path, 'wsCrash');
    try {
      await forAll('in-transaction failure', (rand, run) => {
        const body = { decisionId: `dec${run}`, operationId: `op${run}`, reservationMicroUsd: BigInt(rand.int(0, 100)) };
        const fail = rand.bool(0.5);
        if (fail) {
          assert.throws(() =>
            commitOwned(store, body, () => {
              throw new Error('injected crash');
            }),
          /injected crash/);
          assert.equal(readCommitted(store, body.decisionId), undefined, 'no partial decision survives');
          // The operation id is free again: the retry commits once.
          assert.deepEqual(commitOwned(store, body), { ok: true });
        } else {
          assert.deepEqual(commitOwned(store, body), { ok: true });
        }
        assert.ok(readCommitted(store, body.decisionId), 'the committed decision has all three rows');
      });
    } finally {
      closeStore(store);
    }
  }));

test('a process killed at a random commit leaves only whole decisions (QA-03 crash-point)', async (t) => {
  const Database = require('better-sqlite3');
  const { seed } = await forAll(
    'kill mid-commit',
    (rand) =>
      withStore((path) => {
        const killAt = rand.int(0, 30);
        const child = spawnSync(process.execPath, [join(here, 'store-crash-child.mjs'), path, String(killAt)], {
          encoding: 'utf8',
          timeout: 60_000,
          env: process.env,
        });
        assert.equal(child.signal, 'SIGKILL', `the child dies inside commit ${killAt}: ${child.stderr}`);
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
          assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
          const counts = ['decision_row', 'proposed_action', 'outbox_entry'].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
          assert.equal(new Set(counts).size, 1, `rows split across tables after a crash: ${counts.join('/')}`);
          assert.equal(counts[0], killAt, `exactly the ${killAt} commits before the crash survive`);
        } finally {
          db.close();
        }
        const reopened = open(path, 'wsKill');
        try {
          for (let i = 0; i < killAt; i += 1) assert.ok(readCommitted(reopened, `dec${i}`), `dec${i} is whole after reopen`);
          assert.equal(readCommitted(reopened, `dec${killAt}`), undefined, 'the interrupted commit is absent');
          assert.deepEqual(commitOwned(reopened, { decisionId: `dec${killAt}`, operationId: `op${killAt}`, reservationMicroUsd: 1n }), { ok: true });
        } finally {
          closeStore(reopened);
        }
      }),
    { runs: Math.min(RUNS, 12) },
  );
  t.diagnostic(`seed ${seed}`);
});

/** The declared runner's bound in QA-03: wide, since the property is the binding, not a start time. */
const DECLARED_TIMEOUT_MS = 60_000;

test(`only a declared runner's receipt for the current revision is accepted over ${RUNS} runs (QA-03)`, () =>
  withStore(async (path) => {
    const store = open(path, 'wsReceipt');
    const command = process.execPath;
    const commandHash = createHash('sha256').update(command).digest('hex');
    let accepted = 0;
    try {
      await forAll('stale receipts', (rand, run) => {
        const current = rand.pick(['rev-a', 'rev-b', 'rev-c']);
        const claimed = rand.pick(['rev-a', 'rev-b', 'rev-c']);
        const receipt = { workspaceId: 'wsReceipt', receiptId: `rc${run}`, sourceRevision: claimed, evidenceId: `ev${run}`, runnerId: 'runnerA', commandHash };
        const forged = rand.pick([receipt, JSON.stringify(receipt), { ...receipt, passed: true }, { ...receipt, status: 'passed' }]);
        assert.equal(acceptRunnerReceipt(store, forged, current).ok, false, 'a receipt not produced by a runner is refused');
        // A declared runner binds it; spawn only when the revisions agree, as the gate does.
        // The property is the binding, not how fast `node -e 0` starts: on a host loaded by
        // parallel suites a start can pass the 2 s default, so the runner gets a wide bound.
        if (claimed !== current && rand.bool(0.9)) {
          const result = runDeclaredCheck(store, { ...receipt, command, args: ['-e', '0'], currentRevision: current }, undefined, { timeoutMs: DECLARED_TIMEOUT_MS });
          assert.equal(result.ok, false, 'a receipt for another revision is refused before the runner starts');
        } else if (rand.bool(0.05)) {
          const result = runDeclaredCheck(store, { ...receipt, command, args: ['-e', '0'], currentRevision: current }, undefined, { timeoutMs: DECLARED_TIMEOUT_MS });
          assert.equal(result.ok, claimed === current, `declared runner at ${claimed} vs ${current}: ${JSON.stringify(result)}`);
          if (result.ok) accepted += 1;
        }
      });
      const current = listCurrent(store, { workspaceId: 'wsReceipt' });
      if (current.ok) for (const row of current.rows.filter((r) => r.kind === 'receipt')) assert.ok(['rev-a', 'rev-b', 'rev-c'].includes(row.sourceRevision));
      if (RUNS >= 200) assert.ok(accepted > 0, 'the runner path accepts at least one receipt');
    } finally {
      closeStore(store);
    }
  }));
