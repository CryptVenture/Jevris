/**
 * Seeded state-machine tests of the orchestration ledger (QA-03, QA-05; SSOT §18.1, §10.2).
 *
 * Each run drives the real lease authority, plan and task code through a random sequence of
 * plan submissions, task submissions, promotions, lease acquisitions, heartbeats, releases,
 * sweeps, reconciliations, fenced publishes, "prose" state changes and replays, on an injected
 * clock (no wall-clock waits). After every step the invariants below are checked against an
 * independent oracle:
 *
 * - no negative money: every reservation and every recorded spend is a non-negative integer;
 * - no oversubscription: a grant never leaves a budget's held amount above its limit less the
 *   shutdown reserve, and a cap is never exceeded by active leases;
 * - no cyclic active DAG: the tasks in the ledger always form an acyclic graph, and a plan is
 *   accepted only when the oracle finds no cycle;
 * - no expired authority: a heartbeat or fenced publish succeeds only for the newest token of
 *   an active, unexpired lease;
 * - prose never moves a task to verified: no transition request reaches `verified`, and every
 *   accepted transition is an edge of TRANSITIONS;
 * - replay idempotence: replaying a release, heartbeat-after-release or reconcile changes
 *   nothing.
 *
 * - verified only through the completion path or a human exception: with no receipts in the
 *   model, a task is verified only when a waive with a terminal authorization succeeded, and
 *   then it shows `verifiedBy: 'exception'`, never a pass; a waive without one is refused;
 * - leased only from ready: every granted task was `ready` just before the grant;
 * - an agent never moves a task past `verifying`.
 *
 * Tasks live in B's store (DATA-03): every run uses a real on-disk store (one store file per
 * test, one workspace view per run). The 1,000-run pass keeps the host ledger (leases, fences,
 * budgets, reservations) in an in-memory RecordLedger with the same transact semantics
 * (all-or-nothing, JSON values); a shorter pass runs the same model on the real file ledger
 * with a store per run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRANSITIONS,
  budgetUse,
  getTask,
  leaseAuthorityFor,
  listTasks,
  openWorkspace,
  promoteReady,
  storeReceiptLedger,
  submitPlan,
  submitTask,
  transitionTask,
  validatePlan,
  waiveTask,
} from '@jevris/orchestrator';
import { closeStore, mintAuthorization, openStore, workspaceView } from '@jevris/store';
import { forAll, RUNS } from './prng.mjs';

const STATES = Object.keys(TRANSITIONS);
const T0 = 1_760_000_000_000;
const HOLDER = { hostId: 'h-qa', pid: 1, startedAtMs: null, sessionId: null };
const MAX_CAP = 3;
const AGENT_MOVES = new Set(['leased>running', 'running>awaiting-evidence', 'running>verifying', 'awaiting-evidence>running', 'awaiting-evidence>verifying']);

/** A real on-disk store for one test file; each run takes its own workspace view of it. */
function onDiskStore(dir) {
  const store = openStore({ path: join(dir, 'qa-orchestration.db'), role: 'in-process-test', workspaceId: 'qaorchestration', hostScope: 'qaorchestration' });
  assert.equal(store.ok, true, `store: ${store.reason}`);
  return store;
}

/** The workspace stand-in for the in-memory host ledger: host and state in memory, tasks in the store view. */
function memoryWorkspace(store, workspaceId) {
  const host = memoryLedger();
  const view = workspaceView(store, workspaceId);
  assert.ok(view !== undefined, 'a workspace view of the store');
  return { workspaceId, host, state: host, store: view, receipts: storeReceiptLedger(view, host) };
}

/** An in-memory RecordLedger: JSON values, all-or-nothing transactions. */
export function memoryLedger() {
  let data = new Map();
  const read = (source, collection, id) => {
    const text = source.get(collection)?.get(id);
    return text === undefined ? undefined : JSON.parse(text);
  };
  const all = (source, collection) => [...(source.get(collection)?.values() ?? [])].map((text) => JSON.parse(text));
  return {
    root: 'memory',
    get: (collection, id) => read(data, collection, id),
    list: (collection) => all(data, collection),
    snapshot: () => JSON.stringify([...data].map(([c, m]) => [c, [...m].sort()]).sort()),
    async transact(fn) {
      const draft = new Map([...data].map(([c, m]) => [c, new Map(m)]));
      const tx = {
        get: (collection, id) => read(draft, collection, id),
        list: (collection) => all(draft, collection),
        put(collection, id, value) {
          if (!draft.has(collection)) draft.set(collection, new Map());
          draft.get(collection).set(id, JSON.stringify(value));
        },
        delete(collection, id) {
          draft.get(collection)?.delete(id);
        },
      };
      const result = fn(tx);
      data = draft;
      return result;
    },
  };
}

function hasCycle(nodes) {
  const deps = new Map(nodes.map((n) => [n.id, n.dependencyIds.filter((d) => nodes.some((m) => m.id === d))]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const d of deps.get(id) ?? []) if (visit(d)) return true;
    state.set(id, 'done');
    return false;
  };
  return [...deps.keys()].some((id) => visit(id));
}

const taskInput = (id, extra = {}) => ({
  id,
  requirementIds: ['R1'],
  acceptanceCheckIds: ['unit'],
  expectedOutputs: ['patch'],
  writeScopes: [`mod/${id}`],
  ...extra,
});

function snapshotOf(ws) {
  const host = typeof ws.host.snapshot === 'function' ? ws.host.snapshot() : JSON.stringify(['leases', 'reservations', 'fences', 'budgets'].map((c) => ws.host.list(c)));
  return `${host}\n${JSON.stringify(listTasks(ws).map((t) => [t.node.id, t.node.state, t.node.revision, t.leaseId]))}`;
}

/** Checks the ledger-wide invariants; `waived` holds the tasks a human exception verified. */
function checkInvariants(ws, log, waived = new Set()) {
  const say = (text) => `${text}\nlast steps:\n  ${log.slice(-8).join('\n  ')}`;
  const tasks = listTasks(ws);
  assert.equal(hasCycle(tasks.map((t) => t.node)), false, say('the active task graph has a cycle'));
  for (const t of tasks) {
    if (t.node.state !== 'verified') continue;
    assert.ok(waived.has(t.node.id), say(`${t.node.id} reached verified without the completion path`));
    assert.equal(t.verifiedBy, 'exception', say(`${t.node.id} was waived but shows ${t.verifiedBy}`));
  }
  for (const row of ws.host.list('reservations')) {
    const r = row.reservation;
    assert.ok(Number.isSafeInteger(r.reservedMicroUsd) && r.reservedMicroUsd >= 0, say(`negative or non-integer reservation ${r.reservedMicroUsd}`));
    assert.ok(r.actualMicroUsd === null || (Number.isSafeInteger(r.actualMicroUsd) && r.actualMicroUsd >= 0), say(`negative spend ${r.actualMicroUsd}`));
  }
  const active = ws.host.list('leases').filter((l) => l.state === 'active' && l.lease.workspaceId === ws.workspaceId);
  assert.ok(active.length <= MAX_CAP, say(`${active.length} active leases exceed the largest cap ${MAX_CAP}`));
  const perTask = new Set();
  const held = new Set();
  for (const l of active) {
    assert.equal(perTask.has(l.lease.taskId), false, say(`two active leases on ${l.lease.taskId}`));
    perTask.add(l.lease.taskId);
    for (const key of l.resourceKeys) {
      assert.equal(held.has(key), false, say(`resource ${key} held twice`));
      held.add(key);
    }
  }
}

/** One random model run against `ws` (a WorkspaceServices or its in-memory stand-in). */
async function runModel(rand, ws, stats = new Map()) {
  const count = (key) => stats.set(key, (stats.get(key) ?? 0) + 1);
  const authority = leaseAuthorityFor(ws);
  const log = [];
  const waived = new Set();
  let now = T0;
  let serial = 0;
  const leases = [];
  const limit = rand.int(1_000, 50_000);
  const reserve = rand.int(0, Math.floor(limit / 4));
  const budget = { id: 'b1', limitMicroUsd: limit, shutdownReserveMicroUsd: reserve };

  const seedTasks = Array.from({ length: rand.int(1, 3) }, () => taskInput(`t${(serial += 1)}`, rand.bool(0.4) ? { resourceKeys: [rand.pick(['gpu', 'db'])] } : {}));
  const seeded = await submitPlan(ws, { tasks: seedTasks, ownerId: 'alice', rootBudget: budget, requireApprovedChecks: false }, now);
  assert.equal(seeded.ok, true, 'the seed plan is valid');
  log.push(`plan ${seedTasks.map((t) => t.id).join(',')} limit=${limit} reserve=${reserve}`);

  const steps = rand.int(15, 40);
  for (let step = 0; step < steps; step += 1) {
    now += rand.int(0, 90_000);
    const ids = listTasks(ws).map((t) => t.node.id);
    const op = rand.pick(['submit', 'submit', 'plan', 'promote', 'promote', 'acquire', 'acquire', 'heartbeat', 'release', 'sweep', 'reconcile', 'publish', 'prose', 'prose', 'waive', 'waive']);
    if (op === 'submit') {
      const id = rand.bool(0.1) && ids.length > 0 ? rand.pick(ids) : `t${(serial += 1)}`;
      const deps = rand.subset(ids, 2);
      if (rand.bool(0.1)) deps.push(id);
      if (rand.bool(0.05)) deps.push('missing');
      const extra = { dependencyIds: deps, ...(rand.bool(0.3) ? { resourceKeys: [rand.pick(['gpu', 'db'])] } : {}) };
      const result = await submitTask(ws, taskInput(id, extra), 'b1', 'alice', now);
      log.push(`submit ${id} deps=${deps.join('|')} -> ${result.ok ? 'ok' : result.issues.map((i) => i.code).join(',')}`);
    } else if (op === 'plan') {
      const fresh = Array.from({ length: rand.int(2, 4) }, () => `t${(serial += 1)}`);
      // Forward edges only (acyclic), plus a back edge in about a third of the plans.
      const edges = fresh.map((id, index) => rand.subset(fresh.slice(0, index), 1));
      if (rand.bool(0.35)) {
        const from = rand.int(0, fresh.length - 2);
        edges[from].push(fresh[rand.int(from + 1, fresh.length - 1)]);
      }
      const tasks = fresh.map((id, index) => taskInput(id, { dependencyIds: [...new Set(edges[index])] }));
      const oracleCycle = hasCycle(tasks.map((t) => ({ id: t.id, dependencyIds: t.dependencyIds })));
      const checked = validatePlan({ workspaceId: ws.workspaceId, tasks, ownerId: 'alice', rootBudget: { id: 'b2', limitMicroUsd: limit } }, now);
      if (oracleCycle) assert.ok(!checked.ok && checked.issues.some((i) => i.code === 'CYCLE'), `a cyclic plan was not refused as CYCLE: ${JSON.stringify(tasks.map((t) => [t.id, t.dependencyIds]))}`);
      else {
        assert.equal(checked.ok, true, `an acyclic plan was refused: ${checked.ok ? '' : JSON.stringify(checked.issues)}`);
        const position = new Map(checked.order.map((id, index) => [id, index]));
        for (const t of tasks) for (const d of t.dependencyIds) assert.ok(position.get(d) < position.get(t.id), 'the plan order is not topological');
      }
      const result = await submitPlan(ws, { tasks, ownerId: 'alice', rootBudget: { ...budget, id: `b${step + 10}` }, requireApprovedChecks: false }, now);
      assert.equal(result.ok, !oracleCycle, 'submitPlan agrees with the cycle oracle');
      count(oracleCycle ? 'cyclic-plan' : 'acyclic-plan');
      log.push(`plan ${fresh.join(',')} cycle=${oracleCycle} -> ${result.ok}`);
    } else if (op === 'promote') {
      const promoted = await promoteReady(ws, now);
      log.push(`promote -> ${promoted.join(',')}`);
    } else if (op === 'acquire') {
      const candidates = rand.subset(ids, 3);
      const cap = rand.int(1, MAX_CAP);
      const requests = candidates.map((taskId) => ({
        taskId,
        ownerId: 'alice',
        worktreeId: `wt-${taskId}`,
        reserveMicroUsd: rand.bool(0.1) ? -rand.int(1, 1_000) : rand.int(0, Math.floor(limit / 2)),
        holder: HOLDER,
        ttlMs: rand.int(1_000, 200_000),
      }));
      const before = new Map(listTasks(ws).map((t) => [t.node.id, t.node.state]));
      const result = await authority.acquire(ws.workspaceId, requests, { cap, nowMs: now });
      for (const grant of result.granted) {
        count('granted');
        assert.equal(before.get(grant.lease.taskId), 'ready', `${grant.lease.taskId} was leased from ${before.get(grant.lease.taskId)}`);
        assert.equal(getTask(ws, grant.lease.taskId).node.state, 'leased', 'the store shows the grant');
        leases.push({ id: grant.lease.id, taskId: grant.lease.taskId, token: grant.lease.fencingToken, budgetId: grant.reservation.budgetId });
        const use = budgetUse(ws.host, grant.reservation.budgetId);
        const record = ws.host.get('budgets', grant.reservation.budgetId);
        assert.ok(use.heldMicroUsd <= record.limitMicroUsd - record.shutdownReserveMicroUsd, `grant oversubscribed ${grant.reservation.budgetId}: held ${use.heldMicroUsd}`);
      }
      const active = ws.host.list('leases').filter((l) => l.state === 'active');
      if (result.granted.length > 0) assert.ok(active.length <= cap, `cap ${cap} exceeded by ${active.length} active leases`);
      log.push(`acquire cap=${cap} ${candidates.join(',')} -> granted ${result.granted.map((g) => g.lease.taskId).join(',')}`);
    } else if (op === 'heartbeat' || op === 'publish') {
      if (leases.length === 0) continue;
      const lease = rand.pick(leases);
      const token = rand.bool(0.8) ? lease.token : lease.token - 1;
      const row = ws.host.list('leases').find((l) => l.lease.id === lease.id);
      const fence = Math.max(0, ...ws.host.list('leases').filter((l) => l.lease.workspaceId === ws.workspaceId && l.lease.taskId === lease.taskId).map((l) => l.lease.fencingToken));
      const valid = row !== undefined && row.state === 'active' && token === row.lease.fencingToken && Date.parse(row.lease.expiresAt) > now;
      if (op === 'heartbeat') {
        const result = await authority.heartbeat(ws.workspaceId, lease.id, token, now);
        assert.equal(result.ok, valid, `heartbeat on ${lease.id} token ${token} at +${now - T0}ms: expected ${valid}, got ${JSON.stringify(result)}`);
        count(`heartbeat-${result.ok}`);
        log.push(`heartbeat ${lease.taskId}#${token} -> ${result.ok}`);
      } else {
        const marker = `m${step}`;
        const result = await authority.publishFenced(ws.workspaceId, lease.taskId, token, (tx) => tx.put('published', marker, { token }), now);
        const expected = valid && token === fence;
        assert.equal(result.ok, expected, `fenced publish on ${lease.taskId} token ${token} (fence ${fence}) at +${now - T0}ms: expected ${expected}, got ${JSON.stringify(result)}`);
        assert.equal(ws.host.get('published', marker) !== undefined, expected, 'a refused publish wrote nothing');
        count(`publish-${result.ok}`);
        log.push(`publish ${lease.taskId}#${token} -> ${result.ok}`);
      }
    } else if (op === 'release') {
      if (leases.length === 0) continue;
      const lease = rand.pick(leases);
      const spend = rand.pick([null, rand.int(0, limit), -rand.int(1, 500)]);
      const first = await authority.release(ws.workspaceId, lease.id, lease.token, { actualMicroUsd: spend }, now);
      const after = snapshotOf(ws);
      const replay = await authority.release(ws.workspaceId, lease.id, lease.token, { actualMicroUsd: spend }, now);
      assert.equal(replay.ok, false, 'a replayed release is refused');
      assert.equal(snapshotOf(ws), after, 'a replayed release changes nothing');
      const beat = await authority.heartbeat(ws.workspaceId, lease.id, lease.token, now);
      assert.equal(beat.ok, false, 'a released lease cannot heartbeat');
      if (first.ok) count('released');
      log.push(`release ${lease.taskId} spend=${spend} -> ${first.ok}`);
    } else if (op === 'sweep') {
      const dead = rand.bool(0.2);
      const expired = await authority.sweep(ws.workspaceId, now, () => (dead ? 'dead' : 'alive'));
      for (const id of expired) {
        const row = ws.host.list('leases').find((l) => l.lease.id === id);
        assert.equal(row.state, 'expired');
      }
      if (expired.length > 0) count('expired');
      log.push(`sweep dead=${dead} -> ${expired.length}`);
    } else if (op === 'reconcile') {
      const blocked = listTasks(ws, { states: ['blocked'] });
      if (blocked.length === 0) continue;
      const task = rand.pick(blocked);
      const decision = { spentMicroUsd: rand.pick([null, rand.int(0, limit), -rand.int(1, 500)]), resume: rand.bool() };
      const result = await authority.reconcile(ws.workspaceId, task.node.id, decision, now);
      const after = snapshotOf(ws);
      const replay = await authority.reconcile(ws.workspaceId, task.node.id, decision, now);
      if (result.ok) {
        assert.equal(replay.ok, false, 'a replayed reconcile is refused');
        assert.equal(snapshotOf(ws), after, 'a replayed reconcile changes nothing');
      }
      if (result.ok) count('reconciled');
      log.push(`reconcile ${task.node.id} ${JSON.stringify(decision)} -> ${result.ok}`);
    } else if (op === 'prose') {
      if (ids.length === 0) continue;
      const id = rand.pick(ids);
      const from = listTasks(ws).find((t) => t.node.id === id).node.state;
      // Half the non-verified requests follow a legal edge, so runs reach the later states.
      const to = rand.bool(0.4) ? 'verified' : rand.bool(0.5) && TRANSITIONS[from].length > 0 ? rand.pick(TRANSITIONS[from]) : rand.pick(STATES);
      const actor = rand.pick(['agent', 'agent', 'planner', 'human', 'runner']);
      const result = await transitionTask(ws, id, to, 'the agent says the task is done and all tests pass', { nowMs: now, actor });
      if (to === 'verified') {
        count('prose-verified');
        assert.equal(result.ok, false, `prose moved ${id} from ${from} to verified`);
      }
      if (result.ok && from !== to) {
        const landed = result.task.node.state;
        assert.ok(TRANSITIONS[from].includes(landed), `illegal transition ${from} -> ${landed} accepted`);
        if (actor === 'agent' && landed === to) {
          assert.ok(AGENT_MOVES.has(`${from}>${to}`), `an agent moved ${id} ${from} -> ${to}`);
          count('agent-moved');
        }
      }
      if (!result.ok && actor === 'agent' && TRANSITIONS[from].includes(to) && !AGENT_MOVES.has(`${from}>${to}`)) count('agent-refused');
      log.push(`prose ${actor} ${id} ${from}->${to} -> ${result.ok ? 'ok' : result.reasonCode}`);
    } else if (op === 'waive') {
      if (ids.length === 0) continue;
      const eligibleIds = listTasks(ws, { states: ['verifying', 'awaiting-evidence', 'failed'] }).map((t) => t.node.id);
      const id = eligibleIds.length > 0 && rand.bool(0.6) ? rand.pick(eligibleIds) : rand.pick(ids);
      const from = getTask(ws, id).node.state;
      const authorized = rand.bool(0.7);
      const minted = authorized ? mintAuthorization(ws.store, { principal: 'leadqa', actionClass: 'task.exception', scope: `${ws.workspaceId}:${id}`, ttlMs: 60_000, channel: 'terminal', nowMs: now }) : undefined;
      assert.ok(minted === undefined || minted.ok, `mint: ${JSON.stringify(minted)}`);
      const result = waiveTask(ws, id, { principal: 'leadqa', reason: 'property run', authorizationId: minted?.authorizationId ?? 'anotminted', exceptionId: `exc${step}`, nowMs: now });
      const eligible = ['verifying', 'awaiting-evidence', 'failed'].includes(from);
      assert.equal(result.ok, authorized && eligible, `waive ${id} from ${from} authorized=${authorized}: ${JSON.stringify(result.ok ? 'ok' : result.reasonCode)}`);
      if (result.ok) {
        waived.add(id);
        assert.equal(result.task.verifiedBy, 'exception');
        count('waived');
      } else count('waive-refused');
      log.push(`waive ${id} from ${from} authorized=${authorized} -> ${result.ok ? 'ok' : result.reasonCode}`);
    }
    checkInvariants(ws, log, waived);
  }
}

test(`orchestration ledger invariants hold over ${RUNS} seeded state-machine runs (QA-03, QA-05)`, async (t) => {
  const stats = new Map();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-qa-orcmem-'));
  const store = onDiskStore(dir);
  let result;
  try {
    result = await forAll('orchestration state machine', async (rand, run) => {
      await runModel(rand, memoryWorkspace(store, `wsqa${run}`), stats);
    });
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
  const { seed, runs } = result;
  t.diagnostic(`seed ${seed}, ${runs} runs, ${JSON.stringify(Object.fromEntries([...stats].sort()))}`);
  // The generator must reach the interesting states, or the invariants are checked on nothing.
  if (runs >= 200) {
    for (const key of ['granted', 'expired', 'released', 'reconciled', 'heartbeat-true', 'heartbeat-false', 'publish-true', 'publish-false', 'cyclic-plan', 'acyclic-plan', 'prose-verified', 'agent-moved', 'agent-refused', 'waived', 'waive-refused']) {
      assert.ok((stats.get(key) ?? 0) > 0, `the model never reached ${key}`);
    }
  }
});

test('the same model holds on the real file ledger (QA-03)', async (t) => {
  const { seed } = await forAll(
    'orchestration state machine on the file ledger',
    async (rand, run) => {
      const dir = mkdtempSync(join(tmpdir(), 'jevris-qa-orc-'));
      try {
        const home = join(dir, 'home');
        const repo = join(dir, 'repo');
        mkdirSync(home);
        mkdirSync(repo);
        const store = onDiskStore(dir);
        try {
          const ws = openWorkspace({ home, workspaceRoot: repo, workspaceId: `wsfile${run}`, env: { HOME: home }, store });
          await runModel(rand, ws);
        } finally {
          closeStore(store);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { runs: Math.min(RUNS, 10) },
  );
  t.diagnostic(`seed ${seed}`);
});

test('the oracle and the model catch a broken invariant (QA-03 self-check)', async () => {
  assert.equal(hasCycle([{ id: 'a', dependencyIds: ['b'] }, { id: 'b', dependencyIds: ['a'] }]), true);
  assert.equal(hasCycle([{ id: 'a', dependencyIds: [] }, { id: 'b', dependencyIds: ['a'] }]), false);
  const dir = mkdtempSync(join(tmpdir(), 'jevris-qa-self-'));
  const store = onDiskStore(dir);
  try {
    const ws = memoryWorkspace(store, 'wsself');
    const planned = await submitPlan(ws, { tasks: [taskInput('x')], ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 10_000 }, requireApprovedChecks: false }, T0);
    assert.equal(planned.ok, true);
    await promoteReady(ws, T0);
    for (const [to, actor] of [['leased', 'scheduler'], ['running', 'runner'], ['awaiting-evidence', 'runner']]) assert.equal((await transitionTask(ws, 'x', to, 'SELF_CHECK', { actor, nowMs: T0 })).ok, true);
    const minted = mintAuthorization(ws.store, { principal: 'leadqa', actionClass: 'task.exception', scope: 'wsself:x', ttlMs: 60_000, channel: 'terminal', nowMs: T0 });
    assert.equal(waiveTask(ws, 'x', { principal: 'leadqa', reason: 'self-check', authorizationId: minted.authorizationId, nowMs: T0 }).ok, true);
    // A verified task the model did not waive is caught; the same task, known as waived, passes.
    assert.throws(() => checkInvariants(ws, []), /reached verified/);
    checkInvariants(ws, [], new Set(['x']));
    await ws.host.transact((tx) => tx.put('reservations', 'r', { reservation: { reservedMicroUsd: -1, actualMicroUsd: null } }));
    assert.throws(() => checkInvariants(ws, [], new Set(['x'])), /negative/);
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});
