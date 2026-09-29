import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// DATA-06 and DATA-07: the decision ledger reserves against C's shared DecisionBudget and
// settles every outcome (commit, release, hold); unknown usage never blocks a later decision.

const { recordDecision } = await import('../dist/ledger.js');
const { DecisionBudget } = await import('../dist/decision-budget.js');

const spec = JSON.parse(readFileSync(new URL('../../../fixtures/choice/failure-family.json', import.meta.url), 'utf8'));
const LEDGER_URL = new URL('../dist/ledger.js', import.meta.url).href;
const BUDGET_URL = new URL('../dist/decision-budget.js', import.meta.url).href;
const SPEC_PATH = fileURLToPath(new URL('../../../fixtures/choice/failure-family.json', import.meta.url));

function answerBytes() {
  return new TextEncoder().encode(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: { failureFamily: { type: 'choice', choice: 'type_error', confidence: 0.4, probabilities: { type_error: 0.7, assertion: 0.1, environment: 0.1, unknown: 0.1 } } },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  );
}

function port(behaviour = 'answer') {
  return {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      if (behaviour === 'throw') throw new Error('provider 400');
      return { receivedAtMs: 500, body: answerBytes() };
    },
  };
}

function sequence(values) {
  let at = 0;
  return () => values[Math.min(at++, values.length - 1)];
}

function args(destination, budget, p, extras = {}) {
  return {
    destination,
    decisionId: 'decisionOne',
    policyVersion: 'policyV1',
    evidenceRevision: 'revisionA',
    revision: { expected: 'revisionA', read: () => 'revisionA' },
    clock: { read: () => 400 },
    deadlineAtMs: 1000,
    remainingMicroUsd: '0',
    reservationMicroUsd: '1000',
    attempts: 1,
    questions: 1,
    stillUseful: false,
    spec,
    input: { kind: 'ambiguous-failure' },
    port: p,
    signal: new AbortController().signal,
    usage: { inputTokens: 10, outputTokens: 2 },
    budget,
    workspaceId: 'wsA',
    ...extras,
  };
}

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-ledger-budget-'));
  return { dir, destination: join(dir, 'ledger.json'), budgetPath: join(dir, 'decision-budget.json') };
}

test('known usage commits its actual cost from the tariff; the envelope is the shared budget, not the caller remaining (DATA-06)', async () => {
  const { dir, destination, budgetPath } = temp();
  try {
    const budget = DecisionBudget.open(budgetPath, { limitMicroUsd: 1000 });
    const p = port();
    const tariff = { inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 };
    const result = await recordDecision(args(destination, budget, p, { tariff }));
    assert.equal(p.calls, 1);
    assert.equal(result.outcome, 'advisory');
    const snap = await budget.snapshot();
    assert.equal(snap.committedMicroUsd, 14, '10 input + 2x2 output micro-USD');
    assert.equal(snap.reservedMicroUsd, 0);
    assert.equal(snap.heldMicroUsd, 0);
    // A second call no longer fits the 1,000 envelope (986 left): refused before the port.
    const second = port();
    const refused = await recordDecision(args(destination, budget, second, { decisionId: 'decisionTwo' }));
    assert.equal(second.calls, 0);
    assert.equal(refused.reasonCode, 'BUDGET');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed provider call releases its reservation, and the next decision is admitted (DATA-06)', async () => {
  const { dir, destination, budgetPath } = temp();
  try {
    const budget = DecisionBudget.open(budgetPath, { limitMicroUsd: 1000 });
    const failing = port('throw');
    const failed = await recordDecision(args(destination, budget, failing, { decisionId: 'decisionFails' }));
    assert.equal(failing.calls, 1);
    assert.equal(failed.reasonCode, 'KNOWN_FAILURE');
    const snap = await budget.snapshot();
    assert.equal(snap.reservedMicroUsd + snap.heldMicroUsd + snap.committedMicroUsd, 0);
    assert.equal((await budget.open()).length, 0);
    const next = port();
    const admitted = await recordDecision(args(destination, budget, next, { decisionId: 'decisionAfter' }));
    assert.equal(next.calls, 1);
    assert.equal(admitted.outcome, 'advisory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a DEADLINE after the call holds the reservation; later decisions are still admitted, and reconciliation clears the hold (DATA-07)', async () => {
  const { dir, destination, budgetPath } = temp();
  try {
    const budget = DecisionBudget.open(budgetPath, { limitMicroUsd: 3000 });
    const slow = port();
    const late = await recordDecision(args(destination, budget, slow, { decisionId: 'decisionLate', clock: { read: sequence([400, 1000]) } }));
    assert.equal(slow.calls, 1);
    assert.equal(late.reasonCode, 'DEADLINE');
    let snap = await budget.snapshot();
    assert.equal(snap.heldMicroUsd, 1000);
    assert.equal(snap.holds, 1);
    // One DEADLINE does not block: the next decision that fits is admitted.
    const next = port();
    const admitted = await recordDecision(args(destination, budget, next, { decisionId: 'decisionNext' }));
    assert.equal(next.calls, 1);
    assert.equal(admitted.outcome, 'advisory');
    // Unknown usage on an answered call is also a hold, not a lock.
    const unknown = args(destination, budget, port(), { decisionId: 'decisionUnknown' });
    delete unknown.usage;
    await recordDecision(unknown);
    snap = await budget.snapshot();
    assert.equal(snap.holds, 2);
    assert.equal(snap.availableMicroUsd, 0);
    // Reconciliation clears both holds at the billed amounts.
    for (const reservation of await budget.open()) {
      assert.equal(reservation.state, 'held');
      const settled = await budget.reconcile(reservation.id, { actualMicroUsd: 5, source: 'billing-export' });
      assert.equal(settled.ok, true);
    }
    snap = await budget.snapshot();
    assert.equal(snap.holds, 0);
    assert.equal(snap.heldMicroUsd, 0);
    assert.equal(snap.availableMicroUsd, 3000 - 1000 - 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STALE and BUDGET refusals before the call reserve nothing and do not block later decisions (DATA-07)', async () => {
  const { dir, destination, budgetPath } = temp();
  try {
    const budget = DecisionBudget.open(budgetPath, { limitMicroUsd: 1000 });
    const stale = port();
    const staleResult = await recordDecision(args(destination, budget, stale, { decisionId: 'decisionStale', revision: { expected: 'revisionA', read: () => 'revisionB' } }));
    assert.equal(staleResult.reasonCode, 'STALE');
    assert.equal(stale.calls, 0);
    const big = port();
    const bigResult = await recordDecision(args(destination, budget, big, { decisionId: 'decisionBig', reservationMicroUsd: '5000' }));
    assert.equal(bigResult.reasonCode, 'BUDGET');
    assert.equal(big.calls, 0);
    assert.equal((await budget.open()).length, 0);
    const ok = port();
    const admitted = await recordDecision(args(destination, budget, ok, { decisionId: 'decisionFits' }));
    assert.equal(ok.calls, 1);
    assert.equal(admitted.outcome, 'advisory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WORKER = `
const { recordDecision } = await import(process.env.LEDGER_URL);
const { DecisionBudget } = await import(process.env.BUDGET_URL);
const { readFileSync } = await import('node:fs');
const spec = JSON.parse(readFileSync(process.env.SPEC_PATH, 'utf8'));
const budget = DecisionBudget.open(process.env.BUDGET_PATH, { limitMicroUsd: 3000, lockTimeoutMs: 20000 });
let calls = 0;
const body = new TextEncoder().encode(JSON.stringify({ model: 'jev-1.13.0', answers: { failureFamily: { type: 'choice', choice: 'type_error', confidence: 0.4, probabilities: { type_error: 0.7, assertion: 0.1, environment: 0.1, unknown: 0.1 } } }, usage: { input_tokens: 10, output_tokens: 2 } }));
const port = { async evaluate() { calls += 1; return { receivedAtMs: 500, body }; } };
const results = [];
for (let i = 0; i < 3; i += 1) {
  const r = await recordDecision({
    destination: process.env.LEDGER_PATH, decisionId: 'd' + process.env.WORKER + 'n' + i, policyVersion: 'policyV1', evidenceRevision: 'revisionA',
    revision: { expected: 'revisionA', read: () => 'revisionA' }, clock: { read: () => 400 }, deadlineAtMs: 1000,
    remainingMicroUsd: '0', reservationMicroUsd: '1000', attempts: 1, questions: 1, stillUseful: false, spec,
    input: { kind: 'ambiguous-failure' }, port, signal: new AbortController().signal, usage: { inputTokens: 10, outputTokens: 2 },
    budget, workspaceId: 'w' + process.env.WORKER,
  });
  results.push(r.reasonCode);
}
process.stdout.write(JSON.stringify({ calls, results }));
`;

function runWorker(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exit ${code}: ${err}`))));
  });
}

test('four processes sharing one budget file never exceed the envelope (DATA-06)', async () => {
  const { dir, budgetPath } = temp();
  try {
    const workers = await Promise.all(
      [0, 1, 2, 3].map((worker) =>
        runWorker({ LEDGER_URL, BUDGET_URL, SPEC_PATH, BUDGET_PATH: budgetPath, LEDGER_PATH: join(dir, `ledger-${worker}.json`), WORKER: String(worker) }),
      ),
    );
    const calls = workers.reduce((sum, w) => sum + w.calls, 0);
    // 12 attempts at 1,000 each against a 3,000 envelope: exactly three reach the provider.
    assert.equal(calls, 3, JSON.stringify(workers));
    assert.equal(workers.flatMap((w) => w.results).filter((code) => code === 'BUDGET').length, 9);
    const budget = DecisionBudget.open(budgetPath, { limitMicroUsd: 3000 });
    const snap = await budget.snapshot();
    assert.ok(snap.committedMicroUsd + snap.reservedMicroUsd + snap.heldMicroUsd <= 3000);
    assert.equal(snap.reservedMicroUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
