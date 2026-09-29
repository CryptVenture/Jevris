// Owner decision 2026-09-29: the Jev decision budget's limit is a setting read at every
// reservation, and a workspace may have its own cap inside it. Integer micro-USD throughout;
// temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const core = await import('../dist/index.js');
const { DecisionBudget, budgetReasonCodes, budgetResetsAt, budgetStatusView } = core;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-budget-limits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = Date.parse('2026-09-25T10:00:00Z')) {
  let now = start;
  return { now: () => now, set: (ms) => (now = ms) };
}

test('a settings change applies to the next reservation and keeps the month\'s spent amount', async (t) => {
  const c = clock();
  let limit = 100;
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 5_000_000, currentLimit: () => limit, now: c.now });
  const r1 = await budget.reserve({ decisionId: 'd1', workspaceId: 'w', microUsd: 60 });
  assert.equal(r1.ok, true);
  await budget.commit(r1.reservation.id, { usage: { inputTokens: 10, outputTokens: 1 }, actualMicroUsd: 60 });
  const refused = await budget.reserve({ decisionId: 'd2', workspaceId: 'w', microUsd: 50 });
  assert.deepEqual([refused.ok, refused.reasonCode, refused.cap, refused.capLimitMicroUsd, refused.availableMicroUsd], [false, 'BUDGET', 'machine', 100, 40]);
  // Raised in the settings: the same budget admits it, and the 60 already spent still counts.
  limit = 200;
  assert.equal(budget.limitMicroUsd, 200);
  assert.equal((await budget.reserve({ decisionId: 'd3', workspaceId: 'w', microUsd: 50 })).ok, true);
  const snap = await budget.snapshot();
  assert.deepEqual([snap.limitMicroUsd, snap.committedMicroUsd, snap.reservedMicroUsd, snap.availableMicroUsd], [200, 60, 50, 90]);
  // Lowered below what is spent: nothing more is admitted, and nothing already spent is lost.
  limit = 80;
  const lowered = await budget.snapshot();
  assert.deepEqual([lowered.committedMicroUsd, lowered.reservedMicroUsd, lowered.availableMicroUsd], [60, 50, 0]);
  assert.equal((await budget.reserve({ decisionId: 'd4', workspaceId: 'w', microUsd: 1 })).cap, 'machine');
});

test('a limit reader that throws or answers something that is not money falls back to the fixed limit', async (t) => {
  for (const reader of [() => { throw new Error('unreadable'); }, () => 1.5, () => -1, () => '100']) {
    const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 30, currentLimit: reader });
    assert.equal(budget.limitMicroUsd, 30);
    assert.equal((await budget.reserve({ decisionId: 'd', workspaceId: 'w', microUsd: 31 })).reasonCode, 'BUDGET');
  }
});

test('0 means no Jev calls: every reservation is refused, and the reason says it is set to 0', async (t) => {
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 5_000_000, currentLimit: () => 0 });
  const r = await budget.reserve({ decisionId: 'd', workspaceId: 'w', microUsd: 1 });
  assert.deepEqual([r.ok, r.reasonCode, r.cap, r.capLimitMicroUsd], [false, 'BUDGET', 'machine', 0]);
  assert.deepEqual(budgetReasonCodes(r), ['BUDGET_MACHINE_LIMIT', 'BUDGET_ZERO', 'RULES_ONLY']);
  const view = budgetStatusView(await budget.snapshot());
  assert.deepEqual([view.state, view.limitMicroUsd, view.exhaustedBy], ['exhausted', 0, 'machine']);
});

test('a workspace cap stops that workspace only; another workspace keeps working inside the machine-wide limit', async (t) => {
  const caps = { a: 30 };
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, workspaceLimit: (id) => caps[id] ?? null });
  assert.equal((await budget.reserve({ decisionId: 'a1', workspaceId: 'a', microUsd: 20 })).ok, true);
  const capped = await budget.reserve({ decisionId: 'a2', workspaceId: 'a', microUsd: 20 });
  assert.deepEqual([capped.ok, capped.reasonCode, capped.cap, capped.capLimitMicroUsd, capped.availableMicroUsd], [false, 'BUDGET', 'workspace', 30, 10]);
  assert.deepEqual(budgetReasonCodes(capped), ['BUDGET_WORKSPACE_CAP', 'RULES_ONLY']);
  // Workspace b has no cap: it goes on until the machine-wide limit.
  assert.equal((await budget.reserve({ decisionId: 'b1', workspaceId: 'b', microUsd: 70 })).ok, true);
  const machine = await budget.reserve({ decisionId: 'b2', workspaceId: 'b', microUsd: 20 });
  assert.deepEqual([machine.ok, machine.cap], [false, 'machine'], 'the machine-wide limit still binds a workspace without a cap');
  // Snapshots: the machine-wide totals, and a's own use against its cap; b has none.
  const a = await budget.snapshot('a');
  assert.deepEqual(a.workspace, { workspaceId: 'a', limitMicroUsd: 30, committedMicroUsd: 0, reservedMicroUsd: 20, heldMicroUsd: 0, availableMicroUsd: 10 });
  assert.equal((await budget.snapshot('b')).workspace, null);
  assert.equal((await budget.snapshot()).workspace, undefined);
  // A hold counts against the workspace's cap like a reservation.
  const a3 = await budget.reserve({ decisionId: 'a3', workspaceId: 'a', microUsd: 10 });
  assert.equal(a3.ok, true);
  await budget.hold(a3.reservation.id);
  const held = (await budget.snapshot('a')).workspace;
  assert.deepEqual([held.heldMicroUsd, held.availableMicroUsd], [10, 0]);
  const view = budgetStatusView(await budget.snapshot('a'), 'cap');
  assert.deepEqual([view.state, view.exhaustedBy, view.workspace.source], ['exhausted', 'machine', 'cap']);
});

test('a workspace cap of 0, or a cap reader that fails, is rules-only for that workspace (fail closed)', async (t) => {
  const zero = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, workspaceLimit: () => 0 });
  const r = await zero.reserve({ decisionId: 'd', workspaceId: 'w', microUsd: 1 });
  assert.deepEqual(budgetReasonCodes(r), ['BUDGET_WORKSPACE_CAP', 'BUDGET_ZERO', 'RULES_ONLY']);
  const broken = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, workspaceLimit: () => { throw new Error('ledger'); } });
  assert.equal((await broken.reserve({ decisionId: 'd', workspaceId: 'w', microUsd: 1 })).cap, 'workspace');
});

test('a month rollover resets both the machine-wide limit and the workspace cap', async (t) => {
  const c = clock(Date.parse('2026-09-30T23:59:00Z'));
  const budget = DecisionBudget.open(join(tempDir(t), 'budget.json'), { limitMicroUsd: 100, workspaceLimit: (id) => (id === 'a' ? 40 : null), now: c.now });
  const a = await budget.reserve({ decisionId: 'a1', workspaceId: 'a', microUsd: 40 });
  await budget.commit(a.reservation.id, { usage: { inputTokens: 1, outputTokens: 1 }, actualMicroUsd: 40 });
  const b = await budget.reserve({ decisionId: 'b1', workspaceId: 'b', microUsd: 60 });
  await budget.commit(b.reservation.id, { usage: { inputTokens: 1, outputTokens: 1 }, actualMicroUsd: 60 });
  assert.equal((await budget.reserve({ decisionId: 'a2', workspaceId: 'a', microUsd: 1 })).ok, false);
  const september = await budget.snapshot('a');
  assert.deepEqual([september.period, september.resetsAt, september.availableMicroUsd, september.workspace.availableMicroUsd], ['2026-09', '2026-10-01T00:00:00.000Z', 0, 0]);
  c.set(Date.parse('2026-10-01T00:00:01Z'));
  const october = await budget.snapshot('a');
  assert.deepEqual([october.period, october.resetsAt, october.committedMicroUsd, october.workspace.committedMicroUsd, october.workspace.availableMicroUsd], ['2026-10', '2026-11-01T00:00:00.000Z', 0, 0, 40]);
  assert.equal((await budget.reserve({ decisionId: 'a3', workspaceId: 'a', microUsd: 40 })).ok, true);
  assert.equal((await budget.reserve({ decisionId: 'b2', workspaceId: 'b', microUsd: 60 })).ok, true);
});

test('the reset date is the start of the next UTC month (or day), and none without periods', () => {
  assert.equal(budgetResetsAt('month', Date.parse('2026-12-31T23:00:00Z')), '2027-01-01T00:00:00.000Z');
  assert.equal(budgetResetsAt('day', Date.parse('2026-09-29T08:00:00Z')), '2026-09-30T00:00:00.000Z');
  assert.equal(budgetResetsAt('none', 0), null);
});

test('several processes on one budget file with a workspace cap: both caps reserve atomically, no double-spend', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'budget.json');
  const url = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'index.js')).href;
  // The machine-wide limit is 500; workspace "capped" may use 120 of it; "free" has no cap and
  // asks for exactly the other 380 (two processes of 19), so every outcome is determined.
  const script = (workspaceId, attempts) => `
    const { DecisionBudget } = await import(${JSON.stringify(url)});
    const budget = DecisionBudget.open(${JSON.stringify(file)}, { limitMicroUsd: 500, lockTimeoutMs: 20000, workspaceLimit: (id) => (id === 'capped' ? 120 : null) });
    let ok = 0;
    for (let i = 0; i < ${attempts}; i += 1) {
      const r = await budget.reserve({ decisionId: 'd' + process.pid + '-' + i, workspaceId: ${JSON.stringify(workspaceId)}, microUsd: 10 });
      if (r.ok) ok += 1; else if (r.reasonCode !== 'BUDGET') { console.log('ERR ' + r.reasonCode); process.exit(3); }
    }
    console.log('OK ' + ok);
  `;
  const run = (workspaceId, attempts) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(workspaceId, attempts)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child ${code}: ${out}`))));
    });
  const outputs = await Promise.all([run('capped', 40), run('capped', 40), run('capped', 40), run('free', 19), run('free', 19)]);
  const admitted = outputs.map((out) => Number(/OK (\d+)/.exec(out)?.[1] ?? NaN));
  const capped = admitted.slice(0, 3).reduce((a, b) => a + b, 0);
  const free = admitted.slice(3).reduce((a, b) => a + b, 0);
  assert.equal(capped, 12, `the capped workspace got exactly its cap: ${admitted}`);
  assert.equal(free, 38, `the free workspace got all it asked for: ${admitted}`);
  assert.equal(capped + free, 50, `together exactly the machine-wide limit: ${admitted}`);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.reservations.length, 50, 'no lost update');
  assert.equal(stored.reservations.filter((r) => r.workspaceId === 'capped').reduce((sum, r) => sum + r.reservedMicroUsd, 0), 120);
  for (const r of stored.reservations) assert.ok(Number.isSafeInteger(r.reservedMicroUsd), 'integer micro-USD');
});
