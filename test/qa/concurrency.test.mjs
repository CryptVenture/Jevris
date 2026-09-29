/**
 * Concurrent reservations across processes (QA-03; SSOT §10.2, D05). Four processes race for
 * leases on one host ledger. Each process is a store writer with its own on-disk store and
 * workspace (one writer per store file, DATA-09); the cap, the budget, the fences and the
 * reservations they contend for are host-wide. The ledger lock and the lease authority's single
 * transaction must keep the global cap and the budget whatever the interleaving: no process may
 * ever observe more active leases than the cap, two active leases on one task, or a budget held
 * above its limit less the shutdown reserve; the final ledger holds only non-negative money
 * with one fencing token per grant, and every store agrees with the ledger (no task is left
 * leased, verified or orphaned).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetUse, listTasks, openWorkspace } from '@jevris/orchestrator';
import { closeStore, openStore } from '@jevris/store';
import { baseSeed } from './prng.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PROCESSES = 4;
const ROUNDS = 15;
const CAP = 2;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'lease-child.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test(`${PROCESSES} processes racing for leases never exceed the cap or the budget (QA-03)`, async (t) => {
  const seed = baseSeed();
  t.diagnostic(`seed ${seed}`);
  const dir = mkdtempSync(join(tmpdir(), 'jevris-qa-race-'));
  try {
    const home = join(dir, 'home');
    const repo = join(dir, 'repo');
    mkdirSync(home);
    mkdirSync(repo);
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, (_, i) => run([home, repo, dir, String(i), String(PROCESSES), String((seed + i * 7919) >>> 0), String(ROUNDS), String(CAP)])),
    );
    let granted = 0;
    for (const result of results) {
      assert.equal(result.code, 0, `child failed (seed ${seed}): ${result.err}`);
      const report = JSON.parse(result.out.trim().split('\n').at(-1));
      assert.deepEqual(report.violations, [], `seed ${seed}`);
      granted += report.granted;
    }
    assert.ok(granted > 0, 'the processes were granted leases');
    const ws = openWorkspace({ home, workspaceRoot: repo, workspaceId: 'wsrace0', env: { HOME: home } });
    const reservations = ws.host.list('reservations').map((r) => r.reservation);
    assert.equal(reservations.length, granted, 'one reservation per grant');
    for (const r of reservations) {
      assert.ok(r.reservedMicroUsd >= 0 && (r.actualMicroUsd === null || r.actualMicroUsd >= 0));
    }
    const use = budgetUse(ws.host, 'b1');
    assert.ok(use.heldMicroUsd <= 20_000 - 1_000, `final held ${use.heldMicroUsd}`);
    const leases = ws.host.list('leases');
    assert.equal(leases.filter((l) => l.state === 'active').length, 0, 'every grant was released');
    for (const key of new Set(leases.map((l) => `${l.lease.workspaceId}/${l.lease.taskId}`))) {
      const tokens = leases.filter((l) => `${l.lease.workspaceId}/${l.lease.taskId}` === key).map((l) => l.lease.fencingToken).sort((a, b) => a - b);
      assert.deepEqual(tokens, tokens.map((_, i) => i + 1), `fencing tokens of ${key} are 1..n with no reuse`);
    }
    // Each store agrees with the ledger: every task is back to ready, none verified or orphaned.
    for (let i = 0; i < PROCESSES; i += 1) {
      const store = openStore({ path: join(dir, `store-${i}.db`), role: 'in-process-test', workspaceId: `wsrace${i}`, hostScope: 'qarace' });
      assert.equal(store.ok, true, `store ${i} reopens after its writer exited`);
      try {
        const tasks = listTasks(openWorkspace({ home, workspaceRoot: repo, workspaceId: `wsrace${i}`, env: { HOME: home }, store }));
        assert.equal(tasks.length, 8);
        for (const t of tasks) assert.deepEqual([t.node.id, t.node.state, t.leaseId, t.verifiedBy], [t.node.id, 'ready', null, null], `seed ${seed}`);
      } finally {
        closeStore(store);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
