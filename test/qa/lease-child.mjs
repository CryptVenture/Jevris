/**
 * Child process for the concurrent reservation test (QA-03). Each child is one writer process:
 * it opens its own on-disk store (DATA-09 allows one writer per store file, as in production
 * where each sidecar owns its store) with its own workspace and tasks, and all children share
 * one host ledger, which holds the global cap, the budget, the fences and the reservations.
 * They race for leases against that shared state. After each grant the child reads the ledger
 * inside a transaction (under the ledger lock) and reports a violation: more active leases
 * than the cap, two active leases on one task, or a budget held above its limit less the
 * shutdown reserve. Within a child, every round races three concurrent acquires for the same
 * task (same-task contention lives inside one writer), and at most one may be granted.
 * Not a test file; test/qa/concurrency.test.mjs spawns it.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetUse, getTask, leaseAuthorityFor, openWorkspace, promoteReady, submitPlan, taskTransition } from '@jevris/orchestrator';
import { closeStore, openStore } from '@jevris/store';

const [home, repo, dir, indexText, childrenText, seedText, roundsText, capText] = process.argv.slice(2);
let state = Number(seedText) >>> 0;
const next = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const int = (min, max) => min + Math.floor(next() * (max - min + 1));
const cap = Number(capText);
const index = Number(indexText);
const workspaceId = `wsrace${index}`;
const store = openStore({ path: join(dir, `store-${index}.db`), role: 'in-process-test', workspaceId, hostScope: 'qarace' });
if (!store.ok) {
  process.stdout.write(`${JSON.stringify({ granted: 0, violations: [`store refused: ${store.reason}`] })}\n`);
  process.exit(0);
}
const ws = openWorkspace({ home, workspaceRoot: repo, workspaceId, env: { HOME: home }, store });
const authority = leaseAuthorityFor(ws);
const holder = { hostId: 'h-qa', pid: process.pid, startedAtMs: null, sessionId: null };
const violations = [];
let now = 1_760_000_000_000;

const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 1}`, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`mod/t${i + 1}`] }));
const submitted = await submitPlan(ws, { tasks, ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 20_000, shutdownReserveMicroUsd: 1_000 }, requireApprovedChecks: false }, now);
if (!submitted.ok) violations.push(`plan refused: ${JSON.stringify(submitted.issues)}`);
if ((await promoteReady(ws, now)).length !== 8) violations.push('not every task became ready');

// Start barrier: every child has its store and tasks before any child races (no timing window
// is asserted; the barrier only makes the race overlap).
writeFileSync(join(dir, `ready-${index}`), '');
const all = Array.from({ length: Number(childrenText) }, (_, i) => join(dir, `ready-${i}`));
let spins = 0;
for (; !all.every((f) => existsSync(f)) && spins < 3000; spins += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!all.every((f) => existsSync(f))) violations.push(`start barrier timed out after ${spins} spins: the processes did not overlap`);

let granted = 0;
for (let round = 0; round < Number(roundsText); round += 1) {
  now += int(1, 50);
  const taskId = `t${int(1, 8)}`;
  // Same-task contention inside this writer: three concurrent acquires for one task.
  const results = await Promise.all(
    [0, 1, 2].map(() => authority.acquire(workspaceId, [{ taskId, ownerId: 'alice', worktreeId: `wt-${taskId}`, reserveMicroUsd: int(0, 400), holder, ttlMs: 600_000 }], { cap, nowMs: now })),
  );
  const grants = results.flatMap((r) => r.granted);
  if (grants.length > 1) violations.push(`${grants.length} concurrent acquires granted ${taskId}`);
  for (const grant of grants) {
    granted += 1;
    const seen = await ws.host.transact((tx) => {
      const active = tx.list('leases').filter((l) => l.state === 'active');
      return { active: active.length, onTask: active.filter((l) => l.lease.workspaceId === workspaceId && l.lease.taskId === taskId).length };
    });
    const use = budgetUse(ws.host, grant.reservation.budgetId);
    const budget = ws.host.get('budgets', grant.reservation.budgetId);
    if (seen.active > cap) violations.push(`active ${seen.active} > cap ${cap}`);
    if (seen.onTask > 1) violations.push(`${seen.onTask} active leases on ${taskId}`);
    if (use.heldMicroUsd > budget.limitMicroUsd - budget.shutdownReserveMicroUsd) violations.push(`held ${use.heldMicroUsd} over ${budget.limitMicroUsd - budget.shutdownReserveMicroUsd}`);
    const leasedState = getTask(ws, taskId)?.node.state;
    if (leasedState !== 'leased') violations.push(`granted ${taskId} is ${leasedState} in the store, not leased`);
    const spend = int(0, grant.reservation.reservedMicroUsd);
    await authority.release(workspaceId, grant.lease.id, grant.lease.fencingToken, { actualMicroUsd: spend }, now);
    const back = taskTransition(ws, taskId, 'ready', 'RELEASED_FOR_NEXT_ROUND', { actor: 'scheduler', nowMs: now });
    if (!back.ok) violations.push(`${taskId} could not return to ready: ${back.reasonCode}`);
  }
}
closeStore(store);
process.stdout.write(`${JSON.stringify({ granted, violations })}\n`);
