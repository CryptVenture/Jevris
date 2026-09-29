import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const core = await import('../dist/index.js');
const { DecisionBudget, jevCostMicroUsd } = core;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = Date.parse('2026-09-25T10:00:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('R11: cost is integer micro-USD from the dated Jev tariff, rounded up', () => {
  assert.equal(jevCostMicroUsd(1000, 50, core.JEV_TARIFF), 42);
  assert.equal(jevCostMicroUsd(1, 0, core.JEV_TARIFF), 1);
  assert.equal(jevCostMicroUsd(1_000_000, 0, core.JEV_TARIFF), 42_000);
});

test('reserve, commit, release: only admitted work counts, and a release frees the amount', async (t) => {
  const c = clock();
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, now: c.now });
  const a = await budget.reserve({ decisionId: 'd1', workspaceId: 'w', microUsd: 60 });
  assert.equal(a.ok, true);
  const refused = await budget.reserve({ decisionId: 'd2', workspaceId: 'w', microUsd: 50 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, 'BUDGET');
  assert.equal(refused.availableMicroUsd, 40);
  assert.equal((await budget.release(a.reservation.id)).ok, true);
  const b = await budget.reserve({ decisionId: 'd2', workspaceId: 'w', microUsd: 50 });
  assert.equal(b.ok, true);
  assert.equal((await budget.commit(b.reservation.id, { usage: { inputTokens: 300, outputTokens: 9 }, actualMicroUsd: 13 })).ok, true);
  const snap = await budget.snapshot();
  assert.equal(snap.committedMicroUsd, 13);
  assert.equal(snap.availableMicroUsd, 87, 'commit settles at the actual cost, not the reservation');
  assert.equal((await budget.commit(b.reservation.id, { usage: { inputTokens: 1, outputTokens: 1 }, actualMicroUsd: 1 })).reasonCode, 'ALREADY_SETTLED');
});

test('an unknown-usage timeout holds its reservation but never locks the budget permanently', async (t) => {
  const c = clock();
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, now: c.now, holdExpiryMs: 60_000 });
  const a = await budget.reserve({ decisionId: 'd1', workspaceId: 'w', microUsd: 30 });
  assert.equal((await budget.hold(a.reservation.id)).ok, true);
  const next = await budget.reserve({ decisionId: 'd2', workspaceId: 'w', microUsd: 70 });
  assert.equal(next.ok, true, 'later decisions are admitted against what remains (old ledger refused all)');
  assert.equal((await budget.reserve({ decisionId: 'd3', workspaceId: 'w', microUsd: 1 })).ok, false, 'the hold stays counted: conservative');
  const reconciled = await budget.reconcile(a.reservation.id, { actualMicroUsd: 12, source: 'billing-export' });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reservation.state, 'reconciled');
  assert.equal((await budget.snapshot()).heldMicroUsd, 0, 'the hold clears on reconcile');
  assert.equal((await budget.reserve({ decisionId: 'd3', workspaceId: 'w', microUsd: 18 })).ok, true);
});

test('a hold that is never reconciled is settled at the reserved amount after the expiry', async (t) => {
  const c = clock();
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, now: c.now, holdExpiryMs: 60_000 });
  const a = await budget.reserve({ decisionId: 'd1', workspaceId: 'w', microUsd: 30 });
  await budget.hold(a.reservation.id);
  c.advance(61_000);
  const snap = await budget.snapshot();
  assert.equal(snap.holds, 0);
  assert.equal(snap.committedMicroUsd, 30, 'settled conservatively as an estimate');
  assert.equal((await budget.reconcile(a.reservation.id, { actualMicroUsd: 5, source: 'billing-export' })).ok, true, 'a late export still reconciles it');
  assert.equal((await budget.snapshot()).committedMicroUsd, 5);
});

test('a new period starts fresh; open holds from the previous period still count', async (t) => {
  const c = clock(Date.parse('2026-09-30T23:59:00Z'));
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, now: c.now, holdExpiryMs: 30 * 24 * 3600 * 1000 });
  const a = await budget.reserve({ decisionId: 'd1', workspaceId: 'w', microUsd: 50 });
  await budget.commit(a.reservation.id, { usage: { inputTokens: 1, outputTokens: 0 }, actualMicroUsd: 50 });
  const h = await budget.reserve({ decisionId: 'd2', workspaceId: 'w', microUsd: 20 });
  await budget.hold(h.reservation.id);
  c.advance(120_000);
  const snap = await budget.snapshot();
  assert.equal(snap.period, '2026-10');
  assert.equal(snap.committedMicroUsd, 0);
  assert.equal(snap.heldMicroUsd, 20);
  assert.equal(snap.availableMicroUsd, 80);
});

test('an abandoned lock from a crashed process is taken over after the stale window', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'budget.json');
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  const budget = DecisionBudget.open(file, { limitMicroUsd: 10, staleLockMs: 5_000 });
  assert.equal((await budget.reserve({ decisionId: 'd1', workspaceId: 'w', microUsd: 1 })).ok, true);
  mkdirSync(`${file}.lock`);
  const blocked = DecisionBudget.open(file, { limitMicroUsd: 10, lockTimeoutMs: 100, staleLockMs: 60_000 });
  const result = await blocked.reserve({ decisionId: 'd2', workspaceId: 'w', microUsd: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'BUDGET_LOCKED', 'a live lock refuses rather than racing');
});

test('several processes sharing one budget file never over-admit and never lose an update', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'budget.json');
  const url = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'index.js')).href;
  const script = `
    const { DecisionBudget } = await import(${JSON.stringify(url)});
    const budget = DecisionBudget.open(${JSON.stringify(file)}, { limitMicroUsd: 500, lockTimeoutMs: 20000 });
    let ok = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = await budget.reserve({ decisionId: 'd' + process.pid + '-' + i, workspaceId: 'w', microUsd: 10 });
      if (r.ok) ok += 1; else if (r.reasonCode !== 'BUDGET') { console.log('ERR ' + r.reasonCode); process.exit(3); }
    }
    console.log('OK ' + ok);
  `;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child ${code}: ${out}`))));
    });
  const outputs = await Promise.all([run(), run(), run(), run()]);
  const admitted = outputs.map((out) => Number(/OK (\d+)/.exec(out)?.[1] ?? NaN));
  assert.equal(admitted.reduce((a, b) => a + b, 0), 50, `exactly limit/amount admitted: ${admitted}`);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.reservations.length, 50, 'no lost update');
  assert.equal(stored.reservations.reduce((sum, r) => sum + r.reservedMicroUsd, 0), 500);
});
