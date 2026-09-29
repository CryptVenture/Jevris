import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  approveManifests,
  cancelTask,
  completeTask,
  getTask,
  getWorktree,
  leaseAuthorityFor,
  manifestHash,
  openWorkspace,
  parseManifest,
  runLeasedTask,
  scheduleTasks,
  selfIdentity,
  submitPlan,
  workerRuns,
  ownedSessions,
  effectOperationId,
  heldTaskEffects,
  reconcileOwnedEffect,
  recordRouteOutcome,
  drainRouteLearning,
  estimateAccuracy,
  sliceVolume,
  taskEstimates,
  SLICE_VOLUME_MIN_RUNS,
  cleanRunSpelling,
  resolveRunSpelling,
} from '../dist/index.js';
import { holdPendingEffects, readAudit, readDecisionOutcomes, recordDecisionRow } from '@jevris/store';
import { BUNDLED_MODEL_REGISTRY, LABEL_SOURCE_OF, modelRegistryFile, readModelOffer, validateModelRegistry } from '@jevris/core';

/** The bundled registry plus OpenRouter serving Kimi K3 on Kilo (C's R39 fixture shape). */
function gatewayRegistry() {
  const R = BUNDLED_MODEL_REGISTRY;
  const tariff = { ...R.entries.find((e) => e.modelId === 'kimi-k3').tariff, version: 'openrouter-2026-09-27', sourceId: 'MODELSDEV-TEST' };
  return {
    ...R,
    harnessHosts: [{ harness: 'kilocode', host: 'openrouter', segment: 'openrouter', signIns: ['api-key'], sourceIds: ['MODELSDEV-TEST'] }],
    servings: [{ host: 'openrouter', provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'] }],
  };
}

function placeRegistry(home, registry) {
  const file = modelRegistryFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(registry));
}
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function fixture() {
  const dir = tempDir('jv-work-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  // The acceptance check passes only when the worker wrote mod/fixed.txt.
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('mod/fixed.txt') ? 0 : 1)"], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  await submitPlan(ws, {
    tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], estimateMicroUsd: 500_000 }],
    ownerId: 'alice',
    rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
  });
  const authority = leaseAuthorityFor(ws);
  const [grant] = (await scheduleTasks(ws, { authority, holder: selfIdentity() })).leased;
  return { ws, store, authority, grant, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const port = (behaviour) => ({
  async run(input) {
    return behaviour(input);
  },
});

const completed = (input, extra = {}) => ({
  status: 'completed',
  reason: 'success',
  sessionId: 'sess-9',
  requestedModel: input.model,
  actualModel: `${input.model}-20260101`,
  costUsd: 0.25,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  turns: 2,
  durationMs: 5,
  ...extra,
});

test('a leased task runs in its own worktree, reports model and cost, and verifies only from receipts (ORC-05)', async () => {
  const f = await fixture();
  try {
    let cwd;
    const result = await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port((input) => {
        cwd = input.cwd;
        assert.notEqual(input.cwd, f.ws.workspaceRoot);
        writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
        return completed(input);
      }),
      model: 'claude-sonnet-4-5',
      allowedTools: ['Read', 'Edit'],
      prompt: 'fix it',
    });
    assert.equal(result.finalState, 'awaiting-evidence');
    const run = workerRuns(f.ws, 'T1')[0];
    assert.equal(run.actualModel, 'claude-sonnet-4-5-20260101');
    assert.equal(run.costUsd, 0.25);
    assert.deepEqual(run.changedPaths, ['mod/fixed.txt']);
    assert.equal(run.effectOperationId, effectOperationId(f.grant.lease.id));
    assert.equal(run.effectState, 'acknowledged', 'a normal run settles its owned effect');
    assert.deepEqual(heldTaskEffects(f.ws), []);
    const rsv = f.ws.host.list('reservations').find((r) => r.leaseId === f.grant.lease.id);
    assert.equal(rsv.reservation.state, 'committed');
    assert.equal(rsv.reservation.actualMicroUsd, 250_000);
    // The user's checkout is untouched.
    assert.equal(existsSync(join(f.ws.workspaceRoot, 'mod', 'fixed.txt')), false);
    assert.ok(existsSync(join(cwd, 'mod', 'fixed.txt')));
    const done = await completeTask(f.ws, 'T1');
    assert.equal(done.verified, true, JSON.stringify(done.completion));
    const verified = getTask(f.ws, 'T1');
    assert.equal(verified.node.state, 'verified');
    assert.equal(verified.verifiedBy, 'checks');
    assert.equal(verified.leaseId, null, 'no lease id outlives the lease');
    assert.ok(verified.history.some((h) => h.state === 'verifying' && h.actor === 'runner'));
    // Invalidating the receipt in the store demotes the task: a stale pass is no pass.
    const ids = f.ws.receipts.list(f.ws.workspaceId, { taskId: 'T1' }).map((r) => r.receipt.id);
    assert.ok(ids.length > 0);
    assert.equal(await f.ws.receipts.invalidate(f.ws.workspaceId, ids, 'inputs-changed'), ids.length);
    assert.equal(getTask(f.ws, 'T1').node.state, 'awaiting-evidence');
    assert.equal(f.ws.receipts.get(f.ws.workspaceId, ids[0]).invalidatedReason, 'inputs-changed');
    assert.equal(await f.ws.receipts.invalidate(f.ws.workspaceId, ids, 'again'), 0, 'an invalidated receipt stays invalidated');
  } finally {
    f.done();
  }
});

test('P11: each run and the completion keep the task estimate against its committed actual, wall time and tokens; the slice volume needs enough runs', async () => {
  const f = await fixture();
  try {
    await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port((input) => {
        writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
        return completed(input);
      }),
      model: 'claude-sonnet-4-5',
      allowedTools: ['Read', 'Edit'],
      prompt: 'fix it',
      now: () => Date.parse('2026-09-27T10:00:00Z'),
    });
    const [row] = taskEstimates(f.ws);
    assert.deepEqual(
      [row.taskId, row.estimateMicroUsd, row.actualMicroUsd, row.runs, row.wallMs, row.inputTokens, row.outputTokens, row.state, row.rootBudgetId],
      ['T1', 500_000, 250_000, 1, 5, 10, 5, 'awaiting-evidence', 'b1'],
    );
    assert.equal((await completeTask(f.ws, 'T1', { nowMs: Date.parse('2026-09-27T10:05:00Z') })).verified, true);
    assert.deepEqual(taskEstimates(f.ws).map((r) => [r.state, r.atMs]), [['verified', Date.parse('2026-09-27T10:05:00Z')]]);
    assert.deepEqual(estimateAccuracy(f.ws), { tasks: 1, compared: 1, estimateMicroUsd: 500_000, actualMicroUsd: 250_000, medianRatio: 0.5, underEstimated: 0 });
    assert.equal(estimateAccuracy(f.ws, { rootBudgetId: 'other' }).tasks, 0);
    // The task has no slice here; a slice with fewer runs than the floor gives no volume.
    assert.equal(sliceVolume(f.ws, 'issue-fix'), null);
    // Enough finished runs of a slice: the nearest-rank p90 of their tokens.
    await f.ws.state.transact((tx) => tx.put('task-estimates', 'x', { ...taskEstimates(f.ws)[0], taskId: 'S1', sliceId: 'issue-fix' }));
    await f.ws.host.transact((tx) => {
      for (let i = 1; i <= SLICE_VOLUME_MIN_RUNS * 2; i += 1) {
        tx.put('worker-runs', `s-${String(i)}`, { workspaceId: f.ws.workspaceId, taskId: 'S1', leaseId: `l${String(i)}`, status: 'completed', durationMs: 1, endedAtMs: i, usage: { inputTokens: i * 100, outputTokens: i * 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
      }
    });
    assert.deepEqual(sliceVolume(f.ws, 'issue-fix'), { n: 10, p90InputTokens: 900, p90OutputTokens: 90 });
  } finally {
    f.done();
  }
});

test('a task verified label joins the decisions made for it, with its receipt, and a later retry overturns it (P4)', async () => {
  const f = await fixture();
  try {
    // The workspace's store view, as the sidecar's decision journal writes it.
    const decision = { workspaceId: f.ws.workspaceId, decisionId: 'd1', taskId: 'T1', kind: 'route', specVersion: 'spec-2', model: 'jev-1.13.0', encoderVersion: 'packet-1', calibrationVersion: 'cal-3', policyVersion: 'policy-7', state: 'applied', outcome: 'advisory', reasonCodes: ['ROUTE_ADVICE'], latencyMs: 41, providerCalls: 1, usage: { inputTokens: 10, outputTokens: 2 }, reservedMicroUsd: 90, costMicroUsd: 51, billingBasis: 'provider-usage', processRole: 'sidecar', source: 'journal', record: { decisionId: 'd1' }, createdAtMs: 1_000 };
    assert.equal(recordDecisionRow(f.ws.store, decision).ok, true);
    await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port((input) => {
        writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
        return completed(input);
      }),
      model: 'claude-sonnet-4-5',
      allowedTools: ['Read', 'Edit'],
      prompt: 'fix it',
    });
    assert.equal((await completeTask(f.ws, 'T1')).verified, true);
    const [row] = readDecisionOutcomes(f.ws.store);
    const receipt = f.ws.receipts.list(f.ws.workspaceId, { taskId: 'T1' })[0].receipt.id;
    assert.deepEqual([row.decisionId, row.taskId, row.label, row.labelSource, row.receiptId, row.joinBasis], ['d1', 'T1', 'verified-pass', LABEL_SOURCE_OF['verified-pass'], receipt, 'task']);
    recordRouteOutcome(f.ws, 'T1', 'retried', { run: null, nowMs: Date.now() });
    const [again] = readDecisionOutcomes(f.ws.store);
    assert.deepEqual([again.label, again.previousLabel, again.receiptId], ['retried', 'verified-pass', null]);
  } finally {
    await drainRouteLearning();
    f.done();
  }
});

test('a run that reports its model is local proof under its harness and sign-in, with its raw spelling and serving host (R42); an unmapped spelling, no model or no harness records nothing (DOMAINS 3f090fa)', async () => {
  const f = await fixture();
  try {
    await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port((input) => {
        writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
        return completed(input, { harness: 'codex', authMode: 'subscription', actualModel: 'gpt-6-sol' });
      }),
      model: 'gpt-6-sol',
      allowedTools: ['Read', 'Edit'],
      prompt: 'fix it',
      decisionNow: () => Date.parse('2026-09-27T10:00:00Z'),
    });
    const offer = await readModelOffer(f.ws.home);
    assert.deepEqual(
      offer.runs.map((r) => [r.harness, r.authMode, r.modelId, r.raw, r.servingHost, r.source, r.lastAt]),
      [['codex', 'subscription', 'gpt-6-sol', 'gpt-6-sol', 'openai', 'reported', '2026-09-27T10:00:00.000Z']],
    );
  } finally {
    f.done();
  }
  for (const extra of [{ harness: 'codex', actualModel: 'gpt-6-20260101' }, { actualModel: null, harness: 'claude', status: 'failed', reason: 'boom' }, {}]) {
    const g = await fixture();
    try {
      await runLeasedTask(g.ws, g.grant, { authority: g.authority, port: port((input) => completed(input, extra)), model: 'claude-sonnet-5', allowedTools: ['Read'], prompt: 'fix it' });
      assert.equal((await readModelOffer(g.ws.home))?.runs.length ?? 0, 0, JSON.stringify(extra));
    } finally {
      g.done();
    }
  }
});

test('R42, C\'s clean-run rule: a run that completed with no reported model counts as requested-clean-run only for its maker\'s exact id, never an alias, an effort token or a gateway spelling', async () => {
  const ran = async (model, { registry, ...extra }) => {
    const g = await fixture();
    try {
      if (registry !== undefined) placeRegistry(g.ws.home, registry);
      await runLeasedTask(g.ws, g.grant, { authority: g.authority, port: port((input) => completed(input, { actualModel: null, ...extra })), model, allowedTools: ['Read'], prompt: 'fix it' });
      return ((await readModelOffer(g.ws.home))?.runs ?? []).map((r) => [r.harness, r.modelId, r.raw, r.servingHost, r.source]);
    } finally {
      g.done();
    }
  };
  // The registry id, spelled as OpenCode's port spells it: the maker's endpoint, the exact id.
  assert.deepEqual(await ran('glm-5.3', { harness: 'opencode' }), [['opencode', 'glm-5.3', 'zai/glm-5.3', 'zai', 'requested-clean-run']]);
  // The harness's own spelling as given.
  assert.deepEqual(await ran('moonshotai/kimi-k3', { harness: 'kilo' }), [['kilocode', 'kimi-k3', 'moonshotai/kimi-k3', 'moonshot', 'requested-clean-run']]);
  assert.deepEqual(await ran('claude-sonnet-5', { harness: 'claude' }), [['claude', 'claude-sonnet-5', 'claude-sonnet-5', 'anthropic', 'requested-clean-run']]);
  // An effort-token spelling (Antigravity's gemini-3.8-flash-medium) is not the model's exact id.
  assert.deepEqual(await ran('gemini-3.8-flash', { harness: 'antigravity' }), []);
  // A gateway spelling never counts: a gateway can fall back to another model. Unregistered here,
  // and through a registry that pins OpenRouter's serving it resolves via the host, still refused.
  assert.deepEqual(await ran('openrouter/moonshotai/kimi-k3', { harness: 'kilo' }), []);
  assert.equal(validateModelRegistry(gatewayRegistry()).ok, true);
  assert.deepEqual(await ran('openrouter/moonshotai/kimi-k3', { harness: 'kilo', registry: gatewayRegistry() }), []);
  // The same gateway spelling reported back by the harness is recorded, served by OpenRouter.
  assert.deepEqual(await ran('kimi-k3', { harness: 'kilo', actualModel: 'openrouter/moonshotai/kimi-k3', registry: gatewayRegistry() }), [['kilocode', 'kimi-k3', 'openrouter/moonshotai/kimi-k3', 'openrouter', 'reported']]);
  // Only a clean completion counts.
  assert.deepEqual(await ran('glm-5.3', { harness: 'opencode', status: 'max-turns', reason: 'turns' }), []);
});

test('R42 cleanRunSpelling: a host spelling or a provider the harness reaches through a gateway access row never counts; resolveRunSpelling keeps the raw spelling and names the serving host', () => {
  const registry = structuredClone(BUNDLED_MODEL_REGISTRY);
  assert.deepEqual(resolveRunSpelling(registry, 'opencode', 'zai-coding-plan/glm-5.3'), { raw: 'zai-coding-plan/glm-5.3', provider: 'zai', modelId: 'glm-5.3', servingHost: 'zai', via: 'maker' });
  assert.deepEqual(resolveRunSpelling(registry, 'claude', 'claude-opus-5-5[1m]'), { raw: 'claude-opus-5-5[1m]', provider: 'anthropic', modelId: 'claude-opus-5-5', servingHost: 'anthropic', via: 'maker' });
  // With no serving pinned for it, a gateway spelling resolves to nothing (the bundled snapshot pins this one, R38).
  assert.equal(resolveRunSpelling({ ...registry, servings: [] }, 'kilocode', 'openrouter/moonshotai/kimi-k3'), null);
  assert.deepEqual(resolveRunSpelling(gatewayRegistry(), 'kilocode', 'openrouter/moonshotai/kimi-k3'), { raw: 'openrouter/moonshotai/kimi-k3', provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter', via: 'host' });
  assert.equal(cleanRunSpelling(gatewayRegistry(), 'kilocode', 'openrouter/moonshotai/kimi-k3'), null, 'never a clean run through a host');
  assert.equal(cleanRunSpelling(gatewayRegistry(), 'kilocode', 'kimi-k3')?.servingHost, 'moonshot', 'a registry id is spelled through its maker');
  assert.equal(resolveRunSpelling(registry, 'opencode', 'not a model id'), null);
  assert.equal(cleanRunSpelling(registry, 'opencode', 'zai/glm-5.3')?.servingHost, 'zai');
  assert.equal(cleanRunSpelling(registry, 'opencode', 'nobody-knows'), null);
  for (const row of registry.harnessAccess) if (row.harness === 'opencode' && row.provider === 'zai') row.access = 'gateway';
  assert.equal(cleanRunSpelling(registry, 'opencode', 'zai/glm-5.3'), null);
  assert.equal(cleanRunSpelling(registry, 'opencode', 'glm-5.3'), null);
});

test('an owned run is a pending effect the kill switch holds; the task stays blocked until a person reconciles it after clear (GOV-03, US40)', async () => {
  const f = await fixture();
  try {
    const operationId = effectOperationId(f.grant.lease.id);
    let heldDuring;
    const result = await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port((input) => {
        writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
        // kill-switch activate while the worker runs: every pending owned effect is held.
        heldDuring = holdPendingEffects(f.store, { nowMs: Date.now(), actor: 'tester', channel: 'cli', reason: 'incident' }).held;
        return completed(input);
      }),
      model: 'claude-sonnet-4-5',
      allowedTools: ['Read', 'Edit'],
      prompt: 'fix it',
    });
    assert.deepEqual(heldDuring, [operationId], 'the running worker was a pending owned effect');
    assert.equal(result.finalState, 'blocked');
    assert.equal(result.reasonCode, 'OWNED_EFFECT_HELD');
    assert.equal(result.run.effectState, 'held', 'a held effect is never settled by the worker');
    assert.deepEqual(heldTaskEffects(f.ws).map((e) => [e.operationId, e.taskId, e.leaseId]), [[operationId, 'T1', f.grant.lease.id]]);
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked');
    assert.equal(getTask(f.ws, 'T1').leaseId, null);
    const rsv = f.ws.host.list('reservations').find((r) => r.leaseId === f.grant.lease.id);
    assert.equal(rsv.reservation.state, 'uncertain', 'held spend stays uncertain until reconciled, never settled as the reported cost');
    // While the kill switch is stopped, nothing is reconciled.
    const early = reconcileOwnedEffect(f.ws, { taskId: 'T1', resolution: 'applied', actor: 'alice', channel: 'cli', killSwitchStopped: true });
    assert.deepEqual(early, { ok: false, reasonCode: 'KILL_SWITCH', detail: 'clear the kill switch first' });
    assert.equal(heldTaskEffects(f.ws).length, 1);
    // After clear a person reconciles it once; it is audited and the task is ready again.
    const done = reconcileOwnedEffect(f.ws, { taskId: 'T1', resolution: 'applied', actor: 'alice', channel: 'cli', killSwitchStopped: false });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.state, 'acknowledged');
    assert.equal(typeof done.auditSeq, 'number');
    assert.equal(done.taskState, 'ready');
    assert.deepEqual(heldTaskEffects(f.ws), []);
    const audit = readAudit(f.store, { kinds: ['owned-effect.reconcile'] });
    assert.deepEqual(audit.map((a) => [a.actor, a.detail.operationId, a.detail.resolution]), [['alice', operationId, 'applied']]);
    assert.equal(reconcileOwnedEffect(f.ws, { taskId: 'T1', resolution: 'abandoned', actor: 'alice', channel: 'cli', killSwitchStopped: false }).reasonCode, 'NOT_HELD');
  } finally {
    f.done();
  }
});

test('writing outside allowed paths fails the task and keeps the worktree (ORC-04, ORC-05)', async () => {
  const f = await fixture();
  try {
    const result = await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port((input) => {
        writeFileSync(join(input.cwd, 'outside.txt'), 'x\n');
        return completed(input);
      }),
      model: 'm',
      allowedTools: ['Edit'],
      prompt: 'p',
    });
    assert.equal(result.finalState, 'failed');
    assert.match(getTask(f.ws, 'T1').stateReason, /outside allowed paths: outside.txt/);
    const session = ownedSessions(f.ws)[0];
    assert.equal(getWorktree(f.ws, session.worktreeId).state, 'retained');
  } finally {
    f.done();
  }
});

test('no SDK: the task is blocked with the install hint and the lease is released (ORC-05)', async () => {
  const f = await fixture();
  try {
    const result = await runLeasedTask(f.ws, f.grant, { authority: f.authority, port: null, model: 'm', allowedTools: [], prompt: 'p' });
    assert.equal(result.reasonCode, 'WORKER_UNSUPPORTED');
    assert.match(getTask(f.ws, 'T1').stateReason, /install @anthropic-ai\/claude-agent-sdk/);
    assert.equal(f.authority.activeLeases(f.ws.workspaceId).length, 0);
  } finally {
    f.done();
  }
});

test('cancel signals the running session, releases the lease as uncertain spend, and keeps the dirty tree (ORC-06)', async () => {
  const f = await fixture();
  try {
    let started;
    const ready = new Promise((r) => (started = r));
    const running = runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      heartbeatMs: 1_000,
      port: port(
        (input) =>
          new Promise((resolve) => {
            writeFileSync(join(input.cwd, 'mod', 'wip.txt'), 'half\n');
            started();
            input.signal.addEventListener('abort', () => resolve(completed(input, { status: 'aborted', reason: 'aborted', costUsd: null })), { once: true });
          }),
      ),
      model: 'm',
      allowedTools: ['Edit'],
      prompt: 'p',
    });
    await ready;
    const cancel = await cancelTask(f.ws, f.authority, 'T1');
    assert.equal(cancel.signalled, 'in-process');
    assert.equal(cancel.worktree.status, 'dirty');
    assert.equal(cancel.worktree.deleted, false);
    const result = await running;
    assert.equal(result.finalState, 'cancelled');
    const tree = getWorktree(f.ws, cancel.worktree.id);
    assert.ok(existsSync(join(tree.path, 'mod', 'wip.txt')));
    const rsv = f.ws.host.list('reservations').find((r) => r.leaseId === f.grant.lease.id);
    assert.equal(rsv.reservation.state, 'uncertain');
    // A cancelled task is never scheduled again.
    assert.equal((await scheduleTasks(f.ws, { authority: f.authority, holder: selfIdentity() })).leased.length, 0);
  } finally {
    f.done();
  }
});

test('K6 (sidecar concurrency audit): an older run that ends after its task was re-leased leaves the newer run cancellable in process', async () => {
  const f = await fixture();
  try {
    let second;
    let secondStarted;
    const ready = new Promise((r) => (secondStarted = r));
    const first = await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port(async (input) => {
        // The first run's lease expires and the task is re-leased and started again in this process.
        await f.authority.sweep(f.ws.workspaceId, Date.now() + 10 * 60_000, () => 'alive');
        await f.authority.reconcile(f.ws.workspaceId, 'T1', { spentMicroUsd: null, resume: true }, Date.now());
        const [grant] = (await scheduleTasks(f.ws, { authority: f.authority, holder: selfIdentity() })).leased;
        second = runLeasedTask(f.ws, grant, {
          authority: f.authority,
          heartbeatMs: 1_000,
          port: port(
            (next) =>
              new Promise((resolve) => {
                secondStarted();
                next.signal.addEventListener('abort', () => resolve(completed(next, { status: 'aborted', reason: 'aborted', costUsd: null })), { once: true });
              }),
          ),
          model: 'm',
          allowedTools: [],
          prompt: 'p',
        });
        await ready;
        return completed(input);
      }),
      model: 'm',
      allowedTools: [],
      prompt: 'p',
    });
    assert.equal(first.finalState, 'unchanged', 'the first result is stale');
    // The first run ended after the second registered its handle: the second is still signalled in process.
    const cancel = await cancelTask(f.ws, f.authority, 'T1');
    assert.equal(cancel.signalled, 'in-process');
    assert.equal((await second).finalState, 'cancelled');
  } finally {
    f.done();
  }
});

test('a stale worker result cannot overwrite a newer lease (fencing, ORC-03)', async () => {
  const f = await fixture();
  try {
    const result = await runLeasedTask(f.ws, f.grant, {
      authority: f.authority,
      port: port(async (input) => {
        // While the worker runs, its lease expires and the task is reconciled and re-leased.
        await f.authority.sweep(f.ws.workspaceId, Date.now() + 10 * 60_000, () => 'alive');
        await f.authority.reconcile(f.ws.workspaceId, 'T1', { spentMicroUsd: null, resume: true }, Date.now());
        await scheduleTasks(f.ws, { authority: f.authority, holder: selfIdentity() });
        return completed(input);
      }),
      model: 'm',
      allowedTools: [],
      prompt: 'p',
    });
    assert.equal(result.finalState, 'unchanged');
    assert.equal(getTask(f.ws, 'T1').node.state, 'leased');
    assert.match(workerRuns(f.ws, 'T1')[0].reason, /^stale result/);
    assert.equal(workerRuns(f.ws, 'T1')[0].stale, true, 'the late result is kept, marked stale');
  } finally {
    f.done();
  }
});
