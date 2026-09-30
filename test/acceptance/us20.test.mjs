import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load, story } from './lib.mjs';

// A worker's lease expires while the worker is still running (its host stalled past the lease),
// a new fenced lease is issued, and then the old worker returns. Everything runs through the
// built sidecar ops and the scripted worker port (test mode plus the sandbox's test-home marker),
// in this process. One step is a test-only arrangement, named here: the lease sweep's liveness
// probe reports the first worker's holder dead while that worker still runs. A real crash kills
// the worker with its holder (W04 drives that through the CLI), and a live holder keeps its lease
// by heartbeat, so this is the only way to make the old worker return after a newer lease.
const OLD = 'export const rate = 0.1; // the stale worker\n';
const NEW = 'export const rate = 0.2; // the current lease\n';

story('US20', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/lib/rate.mjs', 'export const rate = 0;\n');
  box.gitInit();
  const go = join(box.dir, 'old-worker-may-return');
  await box.workerScript([
    { writes: [{ path: 'lib/rate.mjs', text: OLD }], status: 'completed', costUsd: 0.01, reason: 'the old worker', waitForFile: go },
    { writes: [{ path: 'lib/rate.mjs', text: NEW }], status: 'completed', costUsd: 0.01, reason: 'the current worker' },
  ]);
  const orchestrator = await load('orchestrator');
  const { openStore, closeStore } = await load('store');
  const { jevrisPaths } = await load('platform');
  const store = openStore({ path: join(box.dir, 'jevris-us20.db'), role: 'in-process-test', workspaceId: 'us20', hostScope: 'us20' });
  assert.ok(store.ok, `store: ${store.reason}`);
  let holderDead = false;
  try {
    const ws = orchestrator.openWorkspace({ home: box.home, workspaceRoot: box.work, env: { HOME: box.home }, store });
    const manifest = orchestrator.parseManifest({ id: 'unit', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['RATE-1'] }).manifest;
    await orchestrator.approveManifests(ws, [manifest], { unit: orchestrator.manifestHash(manifest) }, 'acceptance');
    const settings = join(jevrisPaths({ home: box.home }).config, 'jevris.config.json');
    const { DEFAULT_CONFIG } = orchestrator;
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }, null, 2)}\n`);
    orchestrator.setTaskOpDeps({
      workerPort: async () => orchestrator.scriptedWorkerPort(box.env, box.home),
      // The test-only arrangement: the sweep sees the first holder as dead.
      authority: (w) => {
        const authority = orchestrator.leaseAuthorityFor(w);
        return { ...authority, sweep: (id, now) => authority.sweep(id, now, () => (holderDead ? 'dead' : 'alive')) };
      },
    });
    const op = async (name, body) => {
      const ctx = {
        op: name, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home: box.home,
        signal: new AbortController().signal, deadline: { budgetMs: 10_000, remainingMs: () => 10_000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
      };
      const answer = await orchestrator.sidecarOps.find((o) => o.op === name).handle(ctx);
      assert.equal(answer.ok, true, `${name}: ${JSON.stringify(answer)}`);
      return answer.body;
    };
    const submitted = await op('plan.submit', {
      plan: { tasks: [{ id: 'T1', title: 'Raise the rate', requirementIds: ['RATE-1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['lib'], models: ['claude-sonnet-4-5'] }] },
      ownerId: 'acceptance',
      // The request the CLI sends after a person answers y at a terminal (SR-1: a new root budget needs a person).
      channel: 'terminal',
      rootBudget: { id: 'us20', limitMicroUsd: 5_000_000 },
    });
    assert.equal(submitted.leaseIds.length, 1);
    const first = submitted.leaseIds[0];
    for (let i = 0; i < 1_200 && !orchestrator.ownedSessions(ws).some((s) => s.taskId === 'T1' && s.state === 'running'); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    // The old lease expires into reconciliation; a person reconciles and a new fenced lease runs.
    holderDead = true;
    const reconciled = await op('task.reconcile', { taskId: 'T1', resolution: 'abandoned' });
    holderDead = false;
    evidence(reconciled);
    assert.deepEqual([reconciled.reconciled, reconciled.reasonCode, reconciled.taskState], [true, 'LEASE_RECONCILED', 'leased']);
    for (let i = 0; i < 1_200 && orchestrator.getTask(ws, 'T1')?.node.state !== 'awaiting-evidence'; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(orchestrator.getTask(ws, 'T1').node.state, 'awaiting-evidence', 'the new lease\'s worker did not finish');
    assert.notEqual(orchestrator.getTask(ws, 'T1').leaseId ?? null, first);
    // Now the old worker returns.
    writeFileSync(go, '');
    await orchestrator.drainBackgroundWorkers();

    await then('The result is retained as stale evidence but cannot update the current task or write through the controlled integration path', async () => {
      const runs = orchestrator.workerRuns(ws, 'T1');
      evidence(runs);
      assert.equal(runs.length, 2);
      assert.equal(runs.filter((run) => run.stale === true).length, 1, 'the late result was not kept as stale history');
      const view = await op('task.get', { taskId: 'T1' });
      evidence(view);
      assert.equal(view.task.state, 'awaiting-evidence');
      assert.equal(view.worker.status, 'completed');
      assert.equal(view.lateResults, 1, 'the late result is not counted');
      // The integration takes the task's current change, never the stale worker's.
      const done = await op('task.complete', { taskId: 'T1' });
      assert.equal(done.task.state, 'verified', `task.complete: ${JSON.stringify(done)}`);
      const integration = await op('integration.run', { taskIds: ['T1'] });
      evidence(integration);
      assert.equal(integration.report?.state ?? integration.state, 'ready', JSON.stringify(integration));
      const report = integration.report ?? integration;
      assert.equal(readFileSync(join(report.worktreePath, 'lib', 'rate.mjs'), 'utf8'), NEW, 'the integration carries the stale worker\'s change');
      const approved = await op('integration.approve', { integrationId: report.id, actor: 'acceptance' });
      evidence(approved);
      assert.equal(approved.merged, true, JSON.stringify(approved));
      assert.equal(box.read('work/lib/rate.mjs'), NEW);
    });
  } finally {
    orchestrator.setTaskOpDeps({});
    closeStore(store);
  }
});
