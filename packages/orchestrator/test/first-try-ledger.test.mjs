// C16 route learning in use (owner decision "baseline, then learn in use"): D keeps the router's
// learning note with each routed owned run and gives C's learnFromOutcome the route's first
// deterministic outcome. Offline: the router is a fake engine method, the worker is the scripted
// port, and the learner is captured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { BUNDLED_MODEL_REGISTRY, accessScopeOf, classifyAccessSignal, recordAccessLimit } from '@jevris/core';
import { PROVIDER_CONSENT_TEXT } from '@jevris/contracts';
import { grantProviderConsent } from '@jevris/store';
import {
  approveManifests,
  DEFAULT_CONFIG,
  drainBackgroundWorkers,
  getTask,
  learningRow,
  manifestHash,
  openWorkspace,
  ownedSessions,
  parseManifest,
  pendingLearningProposals,
  relaunchEscalated,
  routeTakesLabel,
  runIncomplete,
  withModelSignal,
  certificationGateFrom,
  certifiedWorkerRoute,
  engineNow,
  setCertificationGate,
  WORKER_ROUTE_FEATURE,
  runServingHost,
  scriptedWorkerPort,
  setRouteLearner,
  setTaskOpDeps,
  sidecarOps,
  workerRuns,
  closeUnhandled,
  firstTryHistory,
  firstTryReports,
  firstTryRow,
  keepFirstTryRoute,
  recordFirstTryOutcome,
  drainRouteLearning,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** Pauses one model's scope on the machine record, as an owned run's 429 would (a model-scoped rate limit, 60 s). */
async function pauseModel(home, harness, model, authMode = 'unknown') {
  const nowMs = Date.now();
  const scope = accessScopeOf(BUNDLED_MODEL_REGISTRY, harness, model, authMode);
  const classification = classifyAccessSignal({ port: 'claude-api', channel: 'structured', status: 429, certified: false }, authMode, nowMs);
  const recorded = await recordAccessLimit({ home, scope, classification, source: 'owned-run', nowMs });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
}


const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

function firstTryNote(arm = 'first-try', extra = {}) {
  return {
    policyVersion: 3,
    sliceMode: 'auto',
    exploration: null,
    authMode: 'api-key',
    usageLimit: null,
    baselineModelId: OPUS,
    eligibleModelIds: [SONNET, OPUS],
    firstTry: { arm, reasonCode: arm === 'control' ? 'FIRST_TRY_CONTROL' : 'FIRST_TRY', propensity: arm === 'control' ? 0.1 : 0.9, firstTryModelId: SONNET, baselineModelId: OPUS, stepUpModelIds: [OPUS], breakEven: 0.5, breakEvenBasis: 'estimated', overheadMicroUsd: 1000, verdictReason: 'DAY_1_PRIOR', ...extra },
  };
}

/** An owned plan whose router assigns the first-try (or control) arm; runs are scripted, nothing is billed. */
async function fixture({ runs, arm = 'first-try', check = '0', firstTrySetting }) {
  const dir = tempDir('jv-ft-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', check], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto', ...(firstTrySetting === undefined ? {} : { firstTry: firstTrySetting }) }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  setRouteLearner(async () => ({ recorded: true, reasonCode: null, regression: 'ok', promotion: null, proposalId: null, version: 3, saved: true }));
  const routed = [];
  const engine = {
    async routeManagedWorker(input) {
      routed.push(input);
      if (input.mode !== 'bounded-auto') return { launched: false, reasonCode: 'RECORDED' };
      await input.launch({ model: arm === 'control' ? OPUS : SONNET, maxBudgetUsd: 1, reservationId: 'rsv-1' });
      return { launched: true, learning: firstTryNote(arm) };
    },
  };
  const traces = [];
  const ctx = (op, body) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine, trace: (t) => traces.push(t),
  });
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle(ctx(op, body));
  const task = (id) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}`], models: [SONNET, OPUS], sliceId: 'issue-fix' });
  const submit = async (id) => {
    const sub = await call('plan.submit', { plan: { tasks: [task(id)] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    await drainRouteLearning();
  };
  return { dir, ws, routed, traces, call, submit, done: () => {
      setTaskOpDeps({});
      setRouteLearner(null);
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const WRITE = [{ path: 'mod/T1/x.txt', text: 'x\n' }];
const HIST = { baselineModelId: OPUS, firstTryModelId: SONNET };

test('the route request carries routing.firstTry and this workspace\'s history reader; baseline in the file turns it off', async () => {
  for (const setting of [undefined, 'baseline']) {
    const f = await fixture({ runs: [{ writes: WRITE, status: 'completed', costUsd: 0.01 }], ...(setting === undefined ? {} : { firstTrySetting: setting }) });
    try {
      await f.submit('T1');
      const ft = f.routed[0].firstTry;
      assert.equal(ft.setting, setting ?? 'auto');
      const h = ft.history(HIST);
      assert.equal(h.firstTry.tasks, 0);
      assert.equal(h.state, null);
    } finally {
      f.done();
    }
  }
});

test('a first try that passes is one verified task in the ledger, with its cost; no hand-off', async () => {
  const f = await fixture({ runs: [{ writes: WRITE, status: 'completed', costUsd: 0.02 }] });
  try {
    await f.submit('T1');
    const kept = firstTryRow(f.ws, 'T1');
    assert.deepEqual([kept.arm, kept.propensity, kept.firstTryModelId, kept.baselineModelId, kept.state], ['first-try', 0.9, SONNET, OPUS, 'open']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    await drainRouteLearning();
    const row = firstTryRow(f.ws, 'T1');
    assert.deepEqual([row.state, row.handedOffTo, row.attempts.length, row.attempts[0].label, row.attempts[0].costMicroUsd], ['verified', null, 1, 'pass', 20_000]);
    const h = firstTryHistory(f.ws, { sliceId: 'issue-fix', ...HIST });
    assert.deepEqual([h.firstTry.tasks, h.firstTry.verified, h.firstTry.firstAttemptPass, h.firstTry.escalated, h.firstTry.costMicroUsd], [1, 1, 1, 0, 20_000]);
    assert.equal(h.control.tasks, 0);
  } finally {
    f.done();
  }
});

test('a first try that ends with no receipt is handed off once to the next rung; the hand-off passes, and the task costs both attempts', async () => {
  const f = await fixture({ runs: [{ writes: [], status: 'timeout', reason: 'stub', costUsd: 0.03 }, { writes: WRITE, status: 'completed', costUsd: 0.05 }] });
  try {
    await f.submit('T1');
    const runs = workerRuns(f.ws, 'T1');
    assert.deepEqual(runs.map((r) => r.requestedModel), [SONNET, OPUS], 'the one hand-off goes to the next rung');
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    await drainRouteLearning();
    const row = firstTryRow(f.ws, 'T1');
    assert.deepEqual([row.state, row.handedOffTo, row.attempts.map((a) => a.role), row.attempts.map((a) => a.label), row.attempts.map((a) => a.costMicroUsd)], ['verified', OPUS, ['first', 'hand-off'], ['incomplete', 'pass'], [30_000, 50_000]]);
    const h = firstTryHistory(f.ws, { sliceId: 'issue-fix', ...HIST });
    assert.deepEqual([h.firstTry.tasks, h.firstTry.verified, h.firstTry.firstAttemptFail, h.firstTry.escalated, h.firstTry.costMicroUsd, h.firstTry.costKnownTasks], [1, 1, 1, 1, 80_000, 1]);
  } finally {
    f.done();
  }
});

test('a failing check hands a first try off once (through task.complete); the hand-off then passes and no second hand-off follows', async () => {
  const check = "process.exit(require('fs').existsSync('mod/T1/x.txt') ? 0 : 1)";
  const f = await fixture({ check, runs: [{ writes: [], status: 'completed', costUsd: 0.02 }, { writes: WRITE, status: 'completed', costUsd: 0.04 }] });
  try {
    await f.submit('T1');
    assert.equal(workerRuns(f.ws, 'T1').length, 1);
    await f.call('task.complete', { taskId: 'T1' });
    await drainBackgroundWorkers();
    await drainRouteLearning();
    assert.deepEqual(workerRuns(f.ws, 'T1').map((r) => r.requestedModel), [SONNET, OPUS]);
    const mid = firstTryRow(f.ws, 'T1');
    assert.deepEqual([mid.attempts[0].label, mid.handedOffTo], ['fail', OPUS]);
    await f.call('task.complete', { taskId: 'T1' });
    await drainBackgroundWorkers();
    await drainRouteLearning();
    const row = firstTryRow(f.ws, 'T1');
    assert.deepEqual([row.state, row.attempts.map((a) => a.label)], ['verified', ['fail', 'pass']]);
    assert.equal(workerRuns(f.ws, 'T1').length, 2, 'one hand-off only');
  } finally {
    f.done();
  }
});

test('a control task (baseline first) that fails has no hand-off and is a finished control sample', async () => {
  const f = await fixture({ arm: 'control', runs: [{ writes: [], status: 'timeout', reason: 'stub', costUsd: 0.06 }] });
  try {
    await f.submit('T1');
    assert.equal(workerRuns(f.ws, 'T1').length, 1);
    const row = firstTryRow(f.ws, 'T1');
    assert.deepEqual([row.arm, row.propensity, row.state, row.handedOffTo], ['control', 0.1, 'failed', null]);
    const h = firstTryHistory(f.ws, { sliceId: 'issue-fix', ...HIST });
    assert.deepEqual([h.control.tasks, h.control.verified, h.firstTry.tasks], [1, 0, 0]);
  } finally {
    f.done();
  }
});

test('a run on a model other than the assigned arm\'s is not a first-try sample', async () => {
  const f = await fixture({ runs: [{ writes: WRITE, status: 'completed', costUsd: 0.01 }] });
  try {
    await f.submit('T1');
    const run = workerRuns(f.ws, 'T1')[0];
    assert.equal(await keepFirstTryRoute(f.ws, { taskId: 'T9', sliceId: 'issue-fix', run: { leaseId: run.leaseId, requestedModel: OPUS }, note: firstTryNote('first-try'), nowMs: 1 }), null);
    assert.equal(firstTryRow(f.ws, 'T9'), undefined);
  } finally {
    f.done();
  }
});

test('the slice goes back to baseline-first by itself when the first try does not pay (5 failed first tries), and the verdict is kept', async () => {
  const f = await fixture({ runs: [{ writes: WRITE, status: 'completed', costUsd: 0.01 }] });
  try {
    await f.submit('T1');
    const base = workerRuns(f.ws, 'T1')[0];
    for (let i = 0; i < 5; i += 1) {
      const leaseId = `lease-x${i}`;
      await keepFirstTryRoute(f.ws, { taskId: `X${i}`, sliceId: 'issue-fix', run: { leaseId, requestedModel: SONNET }, note: firstTryNote('first-try'), nowMs: 10 + i });
      await recordFirstTryOutcome(f.ws, `X${i}`, 'verified-fail', { run: { ...base, leaseId, requestedModel: SONNET, actualModel: SONNET, costUsd: 0.02, authMode: 'api-key', durationMs: 1000 }, nowMs: 20 + i });
      await closeUnhandled(f.ws, `X${i}`, 30 + i);
    }
    const h = firstTryHistory(f.ws, { sliceId: 'issue-fix', ...HIST });
    assert.deepEqual([h.firstTry.tasks, h.firstTry.verified, h.state?.mode], [5, 0, 'baseline']);
    const [report] = firstTryReports(f.ws).filter((r) => r.sliceId === 'issue-fix');
    assert.equal(report.mode, 'baseline');
  } finally {
    f.done();
  }
});
