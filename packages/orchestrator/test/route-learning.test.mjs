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
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_KEYS = ['eventId', 'routeId', 'sliceId', 'modelId', 'rulesModelId', 'policyVersion', 'kind', 'labelSource', 'receiptId', 'explored', 'propensity', 'risk', 'costMicroUsd', 'latencyMs', 'at', 'authMode', 'tokens', 'apiEquivalentMicroUsd', 'effort', 'limitResetAt', 'servingHost'];

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

const NOTE = { policyVersion: 3, sliceMode: 'auto', exploration: { modelId: 'claude-sonnet-4-5', explored: true, propensity: 0.1, reasonCode: 'EXPLORED' }, authMode: 'subscription', usageLimit: null };

/**
 * An owned plan whose runs go through a fake router. `router(input)` decides: by default it
 * launches the task's first model and answers the learning note.
 */
async function fixture({ runs, check = '0', router, learner, certified, harnessOf = () => 'claude', wrap = (p) => p, models = ['claude-sonnet-4-5', 'claude-opus-4-5'], now }) {
  const dir = tempDir('jv-rl-');
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
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath };
  // `certified` (per harness) turns on the worker.route gate; the scripted port then answers
  // which harness a model runs on, as the real dispatching port does.
  const ported = async () => {
    const p = scriptedWorkerPort(env, home);
    return p === null || certified === undefined ? p : wrap({ run: (input) => p.run(input), harnessFor: (model) => harnessOf(model) });
  };
  setTaskOpDeps({ workerPort: ported, ...(certified === undefined ? {} : { workerRouteCertified: async (harness, nowMs) => certified(harness, nowMs) }) });
  const events = [];
  setRouteLearner(
    learner ??
      (async (input) => {
        events.push(input);
        return { recorded: true, reasonCode: null, regression: 'ok', promotion: 'proposed', proposalId: 'prop-1', version: 3, saved: true };
      }),
  );
  const routed = [];
  // `now`: the engine's injected clock (C 930f425); absent, the engine has none.
  const engine = {
    ...(now === undefined ? {} : { now }),
    async routeManagedWorker(input) {
      routed.push(input);
      if (router !== undefined) return router(input);
      // observe and advise only record the router's choice (C's router never launches there).
      if (input.mode !== 'bounded-auto') return { launched: false, reasonCode: 'RECORDED' };
      await input.launch({ model: input.eligibleModels[0], maxBudgetUsd: 1, reservationId: 'rsv-1' });
      return { launched: true, learning: NOTE };
    },
  };
  const traces = [];
  const ctx = (op, body, extra = {}) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine, trace: (t) => traces.push(t), ...extra,
  });
  const call = (op, body, extra = {}) => sidecarOps.find((o) => o.op === op).handle(ctx(op, body, extra));
  const task = (id) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [`mod/${id}`], models, sliceId: 'issue-fix' });
  const submit = async (ids, drain = true) => {
    for (const [i, id] of ids.entries()) {
      const sub = i === 0
        ? await call('plan.submit', { plan: { tasks: [task(id)] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } })
        : await call('task.submit', { task: { ...task(id), rootBudgetId: 'b1' } });
      assert.equal(sub.ok, true, JSON.stringify(sub));
      if (drain) await drainBackgroundWorkers();
    }
  };
  return { dir, ws, events, routed, traces, call, ctx, submit, done: () => {
      setTaskOpDeps({});
      setRouteLearner(null);
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('a routed owned run keeps the router note; verification labels its route with the receipt, ids only, once (C16)', async () => {
  const f = await fixture({ runs: [{ writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed', costUsd: 0.02 }] });
  try {
    await f.submit(['T1']);
    assert.equal(f.routed[0].sliceId, 'issue-fix');
    assert.ok(['api-key', 'subscription'].includes(f.routed[0].authMode), 'the auth mode goes to the router');
    const row = learningRow(f.ws, 'T1');
    // P3: the outcome reconciles against the router's baseline (the registry's, when the note
    // does not name one), never the task's first approved model.
    assert.deepEqual([row.sliceId, row.policyVersion, row.explored, row.propensity, row.authMode, row.baselineModelId], ['issue-fix', 3, true, 0.1, 'subscription', BUNDLED_MODEL_REGISTRY.baselineModelId]);
    // P1: the task's rules-only class (its scope does not exist yet and has no extension: unbounded).
    assert.deepEqual([row.risk, f.routed[0].risk], ['medium', 'medium']);
    const v = await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(getTask(f.ws, 'T1').node.state, 'verified', JSON.stringify(v.body));
    assert.equal(f.events.length, 1);
    const { event, baselineModelId, eligibleModelIds, workspaceId } = f.events[0];
    assert.deepEqual([event.kind, event.labelSource, event.sliceId, event.policyVersion, event.explored, event.propensity], ['verified-pass', 'verification-receipt', 'issue-fix', 3, true, 0.1]);
    assert.ok(ID.test(event.eventId) && ID.test(event.routeId) && ID.test(event.receiptId), JSON.stringify(event));
    assert.equal(event.eventId, `${event.routeId}:verified-pass:${event.receiptId}`);
    assert.equal(event.costMicroUsd, 20_000);
    assert.equal(event.modelId, 'claude-sonnet-4-5');
    assert.deepEqual([baselineModelId, eligibleModelIds, workspaceId], [BUNDLED_MODEL_REGISTRY.baselineModelId, ['claude-sonnet-4-5', 'claude-opus-4-5'], f.ws.workspaceId]);
    assert.deepEqual([event.risk, event.rulesModelId], ['medium', null]);
    // No task or workspace text: only the known id, number and enum fields.
    assert.deepEqual(Object.keys(event).filter((k) => !EVENT_KEYS.includes(k)), []);
    assert.doesNotMatch(JSON.stringify(f.events[0]), /mod\/T1|x\.txt|alice/);
    // One label per route: verifying again sends nothing more; a promotion proposal is kept for status.
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(f.events.length, 1);
    assert.deepEqual(pendingLearningProposals(f.ws), [{ taskId: 'T1', sliceId: 'issue-fix', proposalId: 'prop-1' }]);
  } finally {
    f.done();
  }
});

test('a failing receipt labels verified-fail; a person\'s cancel labels cancelled, a duplicate cancel labels nothing (C16)', async () => {
  const f = await fixture({ check: 'process.exit(1)', runs: [{ writes: [], status: 'completed' }, { writes: [], status: 'completed', waitForFile: '/nonexistent-wait' }, { writes: [], status: 'completed', waitForFile: '/nonexistent-wait' }] });
  try {
    await f.submit(['T1']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.deepEqual(f.events.map((e) => [e.event.kind, e.event.receiptId !== null]), [['verified-fail', true]]);
    assert.equal(learningRow(f.ws, 'T1').outcome, 'verified-fail');
  } finally {
    f.done();
  }
  const never = join(tmpdir(), `jv-rl-never-${String(process.pid)}-${String(Date.now())}`);
  for (const duplicate of [false, true]) {
    // Task-keyed runs: the two parallel workers start in either order, and the cancelled task
    // must be the one still waiting.
    const waiting = { writes: [], status: 'completed', waitForFile: never };
    const g = await fixture({ runs: duplicate ? [{ ...waiting, taskId: 'T0' }, { writes: [], status: 'completed', taskId: 'T1' }] : [waiting, { writes: [], status: 'completed' }] });
    try {
      await g.submit(duplicate ? ['T0', 'T1'] : ['T1'], false);
      // Cancel once the waiting task's session is running, however long setup took (bounded poll).
      const waitingId = duplicate ? 'T0' : 'T1';
      for (let i = 0; i < 400 && !ownedSessions(g.ws).some((o) => o.taskId === waitingId && o.state === 'running'); i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.ok(ownedSessions(g.ws).some((o) => o.taskId === waitingId && o.state === 'running'), 'the waiting task is running');
      const cancelled = await g.call('task.cancel', duplicate ? { taskId: 'T0', duplicateOf: 'T1' } : { taskId: 'T1' });
      assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
      await drainBackgroundWorkers();
      const id = duplicate ? 'T0' : 'T1';
      assert.equal(getTask(g.ws, id).node.state, 'cancelled');
      assert.deepEqual(g.events.filter((e) => e.event.kind === 'cancelled').length, duplicate ? 0 : 1, duplicate ? 'a duplicate cancellation is no route outcome' : 'a person cancelled the running route');
    } finally {
      g.done();
    }
  }
});

test('a harness usage limit labels usage-limited with the reset time; R74 (E3): a baseline paused on the machine record launches nothing and the task blocks with the pause (C16)', async () => {
  const f = await fixture({ runs: [{ writes: [], status: 'usage-limit', reason: 'session limit (429)', resetAt: '2026-09-26T20:00:00.000Z' }] });
  try {
    await f.submit(['T1']);
    const [{ event }] = f.events;
    assert.deepEqual([event.kind, event.labelSource, event.receiptId, event.limitResetAt], ['usage-limited', 'harness-limit', null, '2026-09-26T20:00:00.000Z']);
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked');
  } finally {
    f.done();
  }
  // The router refuses a paused choice and the baseline is paused too: the approved model goes to
  // runLeasedTask, whose launch check (E9) starts nothing; the scripted worker never runs.
  const g = await fixture({ runs: [{ writes: [], status: 'failed', reason: 'this run must never start' }], certified: async () => true, router: async () => ({ launched: false, reasonCode: 'ACCESS_LIMITED', learning: NOTE }) });
  try {
    await pauseModel(g.ws.home, 'claude', 'claude-sonnet-4-5');
    await g.submit(['T1']);
    assert.deepEqual(workerRuns(g.ws, 'T1'), []);
    assert.equal(getTask(g.ws, 'T1').node.state, 'blocked');
    assert.match(getTask(g.ws, 'T1').stateReason, /^ACCESS_LIMITED: rate-limit on claude /);
  } finally {
    g.done();
  }
});

test('the port switch: an access-limit run with a limit class labels usage-limited with its classified reset; an overloaded run labels nothing and is no run-incomplete (R63-R67, OP-7)', async () => {
  const reset = Date.now() + 3 * 3_600_000;
  const withSignal = (status, accessSignal) => ({
    runs: [{ writes: [], status, reason: status }],
    certified: async () => true,
    wrap: (p) => ({ ...p, run: async (input) => ({ ...(await p.run(input)), harness: 'claude', authMode: 'subscription', accessSignal }) }),
  });
  const f = await fixture(withSignal('access-limit', { port: 'claude', channel: 'structured', errorType: 'rate_limit_event', rateLimitType: 'five_hour', resetAtMs: reset }));
  try {
    await f.submit(['T1']);
    const [run] = workerRuns(f.ws, 'T1');
    assert.deepEqual([run.status, run.accessLimit?.class], ['access-limit', 'usage-window']);
    assert.deepEqual(f.events.map((e) => [e.event.kind, e.event.labelSource, e.event.limitResetAt]), [['usage-limited', 'harness-limit', new Date(reset).toISOString()]]);
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked');
  } finally {
    f.done();
  }
  const g = await fixture(withSignal('overloaded', { port: 'claude', channel: 'structured', errorType: 'overloaded' }));
  try {
    await g.submit(['T1']);
    const [run] = workerRuns(g.ws, 'T1');
    assert.deepEqual([run.status, run.accessLimit?.class], ['overloaded', 'overloaded']);
    assert.equal(runIncomplete(run), false);
    assert.deepEqual(g.events.map((e) => e.event.kind), [], 'an overload is no route outcome: the bounded retry handles it');
    assert.match(getTask(g.ws, 'T1').stateReason, /^PROVIDER_OVERLOADED/);
  } finally {
    g.done();
  }
});

test('a learner failure or a route without a note never changes the task path (C16)', async () => {
  const f = await fixture({
    runs: [{ writes: [], status: 'completed' }],
    learner: async () => {
      throw new Error('learner down');
    },
  });
  try {
    await f.submit(['T1']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(getTask(f.ws, 'T1').node.state, 'verified');
  } finally {
    f.done();
  }
  const g = await fixture({
    runs: [{ writes: [], status: 'completed' }],
    router: async (input) => {
      await input.launch({ model: input.eligibleModels[0], maxBudgetUsd: 1, reservationId: 'rsv-1' });
      return { launched: true };
    },
  });
  try {
    await g.submit(['T1']);
    await g.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(getTask(g.ws, 'T1').node.state, 'verified');
    assert.equal(learningRow(g.ws, 'T1'), undefined);
    assert.deepEqual(g.events, []);
  } finally {
    g.done();
  }
});

test('worker.route gate: an uncertified harness only advises and the approved model runs; a certified one routes, never onto an uncertified harness (DOMAINS 72ff950)', async () => {
  // Uncertified: the router is asked in advise mode (its counterfactual), never to launch.
  const f = await fixture({ runs: [{ writes: [], status: 'completed' }], certified: () => false });
  try {
    await f.submit(['T1']);
    assert.deepEqual(f.routed.map((r) => r.mode), ['advise']);
    const [run] = workerRuns(f.ws, 'T1');
    assert.deepEqual([run.requestedModel, run.effort ?? null], ['claude-sonnet-4-5', null]);
    assert.ok(f.traces.some((t) => t.event === 'orchestrator.worker-route' && t.reasonCode === 'ACTUATOR_UNCERTIFIED'), JSON.stringify(f.traces));
    assert.ok(f.traces.some((t) => t.event === 'orchestrator.route-counterfactual' && t.reasonCode === 'ACTUATOR_UNCERTIFIED'));
    assert.equal(learningRow(f.ws, 'T1'), undefined);
  } finally {
    f.done();
  }
  // Certified for the baseline's harness only: the other harness's model is named out before routing
  // (so nothing is reserved for it), a pick of it anyway is refused by the launch's last guard, and
  // the baseline runs.
  const g = await fixture({
    runs: [{ writes: [], status: 'completed' }],
    certified: (harness) => harness === 'claude',
    harnessOf: (model) => (model === 'claude-opus-4-5' ? 'opencode' : 'claude'),
    router: async (input) => {
      try {
        await input.launch({ model: 'claude-opus-4-5', maxBudgetUsd: 1, reservationId: 'rsv-1', effort: 'high' });
        return { launched: true, learning: NOTE };
      } catch (error) {
        return { launched: false, reasonCode: error.message, learning: NOTE };
      }
    },
  });
  try {
    await g.submit(['T1']);
    assert.deepEqual(g.routed.map((r) => r.mode), ['bounded-auto']);
    const runs = workerRuns(g.ws, 'T1');
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].requestedModel, runs[0].effort ?? null], ['claude-sonnet-4-5', null], 'the fallback baseline runs with no effort');
    assert.equal(g.routed[0].eligibleModels.includes('claude-opus-4-5'), false);
    assert.equal(g.routed[0].candidateExclusions['claude-opus-4-5'], 'ACTUATOR_UNCERTIFIED');
    assert.ok(g.traces.some((t) => t.event === 'orchestrator.worker-route' && t.reasonCode === 'BASELINE_MODEL_NOT_ELIGIBLE'), JSON.stringify(g.traces));
  } finally {
    g.done();
  }
});

test('the router effort reaches the worker, its run record and the learning event; the default arm sends none (C 1fc41b9)', async () => {
  const f = await fixture({
    runs: [{ writes: [], status: 'completed', costUsd: 0.01 }],
    certified: () => true,
    router: async (input) => {
      await input.launch({ model: 'claude-opus-4-5', maxBudgetUsd: 1, reservationId: 'rsv-1', effort: 'high' });
      return { launched: true, learning: { ...NOTE, effort: 'high' } };
    },
  });
  try {
    await f.submit(['T1']);
    const [run] = workerRuns(f.ws, 'T1');
    assert.deepEqual([run.requestedModel, run.effort ?? null], ['claude-opus-4-5', 'high']);
    assert.equal(learningRow(f.ws, 'T1').effort, 'high');
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    const [{ event }] = f.events;
    assert.deepEqual([event.kind, event.modelId, event.effort], ['verified-pass', 'claude-opus-4-5', 'high']);
    assert.deepEqual(Object.keys(event).filter((k) => !EVENT_KEYS.includes(k)), []);
    assert.deepEqual(learningRow(f.ws, 'T1').learned, { recorded: true, reasonCode: null, regression: 'ok', promotion: 'proposed' });
  } finally {
    f.done();
  }
  // The model's default arm: no effort on the run, none in the event.
  const g = await fixture({ runs: [{ writes: [], status: 'completed' }], certified: () => true });
  try {
    await g.submit(['T1']);
    assert.equal(workerRuns(g.ws, 'T1')[0].effort ?? null, null);
    await g.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(Object.hasOwn(g.events[0].event, 'effort'), false);
  } finally {
    g.done();
  }
});

test('a learner refusal (EVENT_EXPIRED) is kept with the route and never retried (C 1fc41b9)', async () => {
  const f = await fixture({
    runs: [{ writes: [], status: 'completed' }],
    learner: async () => ({ recorded: false, reasonCode: 'EVENT_EXPIRED', regression: null, promotion: null, proposalId: null, version: 3, saved: false }),
  });
  try {
    await f.submit(['T1']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    const row = learningRow(f.ws, 'T1');
    assert.deepEqual([row.outcome, row.proposalId, row.learned], ['verified-pass', null, { recorded: false, reasonCode: 'EVENT_EXPIRED', regression: null, promotion: null }]);
    assert.deepEqual(pendingLearningProposals(f.ws), []);
  } finally {
    f.done();
  }
});

test('the dispatching port\'s resolved auth mode goes to the router, and the run records the mode and its source (a stored key is api-key, never a subscription; F 17beb82)', async () => {
  const f = await fixture({
    runs: [{ writes: [], status: 'completed', costUsd: 0.01 }],
    certified: () => true,
    harnessOf: () => 'opencode',
    wrap: (p) => ({ ...p, authFor: async () => ({ mode: 'api-key', source: 'stored-key' }), run: async (input) => ({ ...(await p.run(input)), authMode: 'api-key', authSource: 'stored-key' }) }),
  });
  try {
    await f.submit(['T1']);
    assert.equal(f.routed[0].authMode, 'api-key');
    const [run] = workerRuns(f.ws, 'T1');
    assert.deepEqual([run.authMode, run.authSource], ['api-key', 'stored-key']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(f.events[0].event.authMode, 'api-key');
  } finally {
    f.done();
  }
});

test('worker-run changed paths and reasons, and host project memory, never reach the learning event or the kept route (coordinator, machine-wide learning)', async () => {
  const f = await fixture({ check: 'process.exit(1)', runs: [{ writes: [{ path: 'mod/T1/zz-private-file-name.txt', text: 'secret body\n' }], status: 'completed', reason: 'PRIVATE-REASON-TEXT about zz-private', costUsd: 0.01 }] });
  try {
    await f.ws.host.transact((tx) => tx.put('project-memory', 'pm-1', { id: 'pm-1', text: 'PRIVATE-PROJECT-MEMORY about the billing module', scope: 'host' }));
    await f.submit(['T1']);
    const [run] = workerRuns(f.ws, 'T1');
    assert.ok(run.changedPaths.some((p) => /zz-private-file-name/.test(p)), 'the run record keeps its paths locally');
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(f.events.length, 1);
    const sent = JSON.stringify(f.events[0]);
    for (const text of [/zz-private/, /PRIVATE-REASON-TEXT/, /PRIVATE-PROJECT-MEMORY/, /billing module/, /secret body/, /mod\/T1/]) assert.doesNotMatch(sent, text);
    assert.deepEqual(Object.keys(f.events[0].event).filter((k) => !EVENT_KEYS.includes(k)), []);
    assert.doesNotMatch(JSON.stringify(learningRow(f.ws, 'T1')), /zz-private|PRIVATE-|billing module/);
  } finally {
    f.done();
  }
});

test('a route with usage carries its API-equivalent cost at the registry tariff, so a subscription route has dollars to learn from; no usage or an unpriced model gives null (C machine-wide learning)', async () => {
  const { BUNDLED_MODEL_REGISTRY, apiEquivalentCostMicroUsd } = await import('@jevris/core');
  const usage = { inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 100 };
  const withUsage = (p) => ({ ...p, run: async (input) => ({ ...(await p.run(input)), usage, costUsd: null, authMode: 'subscription' }) });
  const priced = 'claude-opus-5-5';
  const expected = apiEquivalentCostMicroUsd(BUNDLED_MODEL_REGISTRY, priced, { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 2_000, cacheWriteTokens: 100 });
  assert.ok(typeof expected === 'number' && expected > 0, 'the bundled registry prices the model');
  for (const [model, wrap, want] of [[priced, withUsage, expected], ['claude-sonnet-4-5', withUsage, null], [priced, (p) => p, null]]) {
    const f = await fixture({
      runs: [{ writes: [], status: 'completed' }],
      certified: () => true,
      wrap,
      models: [model],
      router: async (input) => {
        await input.launch({ model, maxBudgetUsd: 1, reservationId: 'rsv-1' });
        return { launched: true, learning: NOTE };
      },
    });
    try {
      await f.submit(['T1']);
      await f.call('verify', { taskId: 'T1', checkIds: [] });
      await drainBackgroundWorkers();
      const [{ event }] = f.events;
      assert.deepEqual([event.modelId, event.costMicroUsd, event.apiEquivalentMicroUsd], [model, null, want], `${model} ${String(want)}`);
      assert.equal(event.servingHost, model === priced ? 'anthropic' : undefined, 'R49: the host that served the run (the maker for a maker route); none for a model the registry does not know');
      assert.equal(event.tokens, wrap === withUsage ? 3_600 : null);
    } finally {
      f.done();
    }
  }
});

test('R49: the outcome names the host that served the run, from the spelling the harness reported, or a clean run\'s requested spelling; otherwise none', async () => {
  const { BUNDLED_MODEL_REGISTRY: registry } = await import('@jevris/core');
  const run = (extra) => ({ harness: 'claude', actualModel: null, requestedModel: 'claude-opus-5-5', status: 'completed', ...extra });
  assert.equal(runServingHost(registry, run({ actualModel: 'claude-opus-5-5[1m]' })), 'anthropic');
  assert.equal(runServingHost(registry, run({ harness: 'kilo', actualModel: 'openrouter/moonshotai/kimi-k3' })), 'openrouter', 'a gateway route is priced at its host');
  assert.equal(runServingHost(registry, run({})), 'anthropic', 'a clean run with no report: its requested spelling');
  assert.equal(runServingHost(registry, run({ status: 'failed' })), null, 'a run that did not finish clean and reported nothing names no host');
  assert.equal(runServingHost(registry, run({ harness: undefined, actualModel: 'claude-opus-5-5' })), null, 'no harness, no host');
  assert.equal(runServingHost(registry, run({ harness: 'kilo', actualModel: 'nowhere/unknown-model' })), null, 'an unresolved spelling names no host');
});

// A pinned engine clock, far from the real one: a route decision that read the real clock would
// show up as a different time (and `npm run test:future` moves the real clock, never this one).
const PINNED = Date.UTC(2026, 2, 1, 12, 0, 0);

test('route learning and the worker.route gate run on the engine clock, not the real one (C 930f425; pair: an engine without a clock uses the real one)', async () => {
  const asked = [];
  const f = await fixture({
    runs: [{ writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed' }],
    now: () => PINNED,
    certified: (harness, nowMs) => (asked.push([harness, nowMs]), true),
  });
  try {
    await f.submit(['T1']);
    assert.ok(asked.length > 0, 'the worker.route gate was asked');
    assert.ok(asked.every(([, at]) => at === PINNED), 'the gate is asked at the engine time');
    assert.equal(learningRow(f.ws, 'T1').atMs, PINNED, 'the route note is kept at the engine time');
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].now, new Date(PINNED).toISOString());
    assert.equal(f.events[0].event.at, new Date(PINNED).toISOString(), 'the verified outcome is labelled at the engine time');
  } finally {
    f.done();
  }
  const g = await fixture({ runs: [{ writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed' }] });
  try {
    const before = Date.now();
    await g.submit(['T1']);
    const at = learningRow(g.ws, 'T1').atMs;
    assert.ok(at >= before && at !== PINNED, 'without an engine clock, the real clock');
  } finally {
    g.done();
  }
});

test('engineNow reads the engine clock and falls back to the real clock when there is none or it fails (pair)', () => {
  assert.equal(engineNow({ now: () => PINNED }), PINNED);
  const before = Date.now();
  for (const engine of [undefined, null, {}, { now: 5 }, { now: () => Number.NaN }, { now: () => -1 }, { now: () => 'x' }, { now: () => { throw new Error('no clock'); } }]) {
    assert.ok(engineNow(engine) >= before, JSON.stringify(engine ?? null));
  }
});

test('the worker.route certification is decided at the time it is given: certified at the pinned time, not after the record expired (pair)', async () => {
  const dir = tempDir('jv-rl-cert-');
  const record = {
    id: 'cert-route',
    schemaVersion: '1.0',
    harness: 'claude',
    actuatorId: 'worker',
    harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'],
    models: [],
    tools: [],
    limitations: [],
    fixtureSuiteHash: `sha256:${'b'.repeat(64)}`,
    features: [{ featureId: WORKER_ROUTE_FEATURE, status: 'certified', reasonCode: null }],
    certifiedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-06-01T00:00:00Z',
    signature: { algorithm: 'ed25519', keyId: 'k', value: 'AAAA' },
  };
  setCertificationGate(certificationGateFrom(async () => [record], () => '2.1.0'));
  try {
    assert.equal(await certifiedWorkerRoute(dir, 'claude', PINNED), true, 'inside the record window at the engine time');
    assert.equal(await certifiedWorkerRoute(dir, 'claude', Date.UTC(2026, 6, 1)), false, 'after the record expired');
  } finally {
    setCertificationGate(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ models found gone (C f5b19ab)

const SONNET = 'claude-sonnet-4-5';
const OPUS = 'claude-opus-4-5';
const GONE_RUN = { writes: [], status: 'model-unavailable', reason: 'stub', modelUnavailable: { reasonCode: 'MODEL_GONE', port: 'claude', authMode: 'subscription' } };

async function availability(home) {
  const core = await import('@jevris/core');
  const registry = (await core.loadModelRegistry({ home }).catch(() => null)) ?? core.BUNDLED_MODEL_REGISTRY;
  return core.loadModelAvailability(home, registry);
}

test('a launch that finds its model gone is recorded on the machine (requested model, launch, engine clock) and fails the task; that model is never launched again; another model runs (pair)', async () => {
  // The fake router launches the task's first model, except T3, which it routes to Opus.
  const router = async (input) => {
    if (input.mode !== 'bounded-auto') return { launched: false, reasonCode: 'RECORDED' };
    await input.launch({ model: input.taskId === 'T3' ? OPUS : input.eligibleModels[0], maxBudgetUsd: 1, reservationId: 'rsv-1' });
    return { launched: true, learning: NOTE };
  };
  const f = await fixture({ runs: [GONE_RUN, { writes: [{ path: 'mod/T3/x.txt', text: 'x\n' }], status: 'completed' }], router, now: () => PINNED, models: [SONNET, OPUS] });
  try {
    await f.submit(['T1']);
    assert.equal(f.routed[0].harness, 'claude', 'the route request names the harness');
    const t1 = getTask(f.ws, 'T1');
    assert.equal(t1.node.state, 'failed');
    assert.match(t1.stateReason, /model claude-sonnet-4-5 is not available here \(MODEL_GONE via claude\)/);
    const [run] = workerRuns(f.ws, 'T1');
    assert.deepEqual(run.modelUnavailable, { reasonCode: 'MODEL_GONE', port: 'claude', authMode: 'subscription', recorded: 'RECORDED' });
    const entries = await availability(f.ws.home);
    assert.deepEqual(entries.map((e) => [e.modelId, e.reasonCode, e.port, e.authMode, e.source, e.lastSeenAt]), [[SONNET, 'MODEL_GONE', 'claude', 'subscription', 'launch', new Date(PINNED).toISOString()]]);
    assert.ok(f.traces.some((t) => t.event === 'orchestrator.model-unavailable' && t.reasonCode === 'MODEL_GONE'));
    // T2 is routed onto the same model: it is refused before launch, and no run is made or spent.
    await f.submit(['T2']);
    assert.equal(getTask(f.ws, 'T2').node.state, 'failed');
    assert.match(getTask(f.ws, 'T2').stateReason, /not launched again/);
    assert.equal(workerRuns(f.ws, 'T2').length, 0, 'the gone model never ran again');
    assert.ok(f.traces.some((t) => t.event === 'orchestrator.model-unavailable' && t.reasonCode === 'NOT_LAUNCHED'));
    // Pair: another model runs (the script's second run).
    await f.submit(['T3']);
    const t3 = workerRuns(f.ws, 'T3');
    assert.deepEqual(t3.map((r) => [r.requestedModel, r.status]), [[OPUS, 'completed']]);
    assert.equal((await availability(f.ws.home)).length, 1, 'nothing else was recorded');
  } finally {
    f.done();
  }
});

test('a model not accessible on one harness and sign-in is refused only there: a run on another harness launches it (C scope; pair)', async () => {
  const core = await import('@jevris/core');
  const f = await fixture({ runs: [{ writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed' }], certified: () => true, harnessOf: () => 'claude' });
  try {
    const registry = (await core.loadModelRegistry({ home: f.ws.home }).catch(() => null)) ?? core.BUNDLED_MODEL_REGISTRY;
    const put = await core.recordModelUnavailable({ home: f.ws.home, modelId: SONNET, reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'codex', authMode: 'subscription', source: 'launch', nowMs: PINNED, registry });
    assert.equal(put.ok, true);
    await f.submit(['T1']);
    assert.deepEqual(workerRuns(f.ws, 'T1').map((r) => [r.requestedModel, r.status]), [[SONNET, 'completed']], 'not accessible on Codex does not stop Claude Code');
  } finally {
    f.done();
  }
  // Pair: the same entry refuses the model on Codex with a subscription sign-in.
  const subscription = (p) => ({ ...p, authFor: async () => ({ mode: 'subscription', source: 'declared' }) });
  const g = await fixture({ runs: [{ writes: [], status: 'completed' }], certified: () => true, harnessOf: () => 'codex', wrap: subscription });
  try {
    const registry = (await core.loadModelRegistry({ home: g.ws.home }).catch(() => null)) ?? core.BUNDLED_MODEL_REGISTRY;
    await core.recordModelUnavailable({ home: g.ws.home, modelId: SONNET, reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'codex', authMode: 'subscription', source: 'launch', nowMs: PINNED, registry });
    await g.submit(['T1']);
    assert.equal(workerRuns(g.ws, 'T1').length, 0, 'not launched on the harness and sign-in it is not accessible from');
    assert.match(getTask(g.ws, 'T1').stateReason, /MODEL_NOT_ACCESSIBLE/);
  } finally {
    g.done();
  }
});

test('withModelSignal classifies a port signal through C\'s table: the Claude API 404 is MODEL_GONE; unknown, uncertified text and Jev signals change nothing (pair)', () => {
  const base = { status: 'failed', reason: 'x', requestedModel: SONNET };
  const gone = withModelSignal({ ...base, modelSignal: { port: 'claude-api', signal: 'http-404-not-found-error' } }, 'api-key');
  assert.equal(gone.status, 'model-unavailable');
  assert.deepEqual(gone.modelUnavailable, { reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key' });
  assert.equal(gone.reason, 'model claude-sonnet-4-5 is not available here (MODEL_GONE via claude-api)');
  for (const modelSignal of [{ port: 'claude-api', signal: 'http-500' }, { port: 'claude', signal: 'selected-model-issue' }, { port: 'typesafe', signal: 'http-400-bad-request' }]) {
    assert.equal(withModelSignal({ ...base, modelSignal }, 'api-key').status, 'failed', JSON.stringify(modelSignal));
  }
  assert.equal(withModelSignal({ ...base, modelSignal: { port: 'claude', signal: 'selected-model-issue' } }, 'subscription', true).modelUnavailable.reasonCode, 'MODEL_NOT_ACCESSIBLE', 'a certified binary\'s text signal counts');
  assert.equal(withModelSignal({ ...base, status: 'completed', modelSignal: { port: 'claude-api', signal: 'http-404-not-found-error' } }, 'api-key').status, 'completed');
});

test('P3: the router note\'s baseline, eligible list and rules-only choice are kept and sent with the outcome', async () => {
  const note = { ...NOTE, baselineModelId: 'claude-opus-4-5', eligibleModelIds: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'], rulesModelId: 'claude-opus-4-5' };
  const f = await fixture({
    runs: [{ writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed', costUsd: 0.02 }],
    router: async (input) => {
      await input.launch({ model: input.eligibleModels[0], maxBudgetUsd: 1, reservationId: 'rsv-1' });
      return { launched: true, learning: note };
    },
  });
  try {
    await f.submit(['T1']);
    const row = learningRow(f.ws, 'T1');
    assert.deepEqual([row.baselineModelId, row.eligibleModelIds, row.rulesModelId], ['claude-opus-4-5', ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'], 'claude-opus-4-5']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    const [{ event, baselineModelId, eligibleModelIds }] = f.events;
    // The same baseline the route reconciled against, not the task's first model (claude-sonnet-4-5).
    assert.deepEqual([baselineModelId, eligibleModelIds, event.rulesModelId, event.modelId], ['claude-opus-4-5', ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'], 'claude-opus-4-5', 'claude-sonnet-4-5']);
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------------------------ P2

test('P2: a run that ends with no receipt labels its route run-incomplete (a failure, with its spend); the escalation retries it at no second cost, and the escalated run is its own unrandomized route', async () => {
  const f = await fixture({ runs: [{ writes: [], status: 'timeout', reason: 'stub', costUsd: 0.03 }, { writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed', costUsd: 0.05 }] });
  try {
    await f.submit(['T1']);
    assert.equal(getTask(f.ws, 'T1').node.state, 'failed');
    const [first] = workerRuns(f.ws, 'T1');
    const [incomplete] = f.events.map((e) => e.event);
    assert.deepEqual([incomplete.kind, incomplete.labelSource, incomplete.receiptId, incomplete.costMicroUsd, incomplete.explored], ['run-incomplete', 'run-incomplete', null, 30_000, true]);
    assert.equal(incomplete.eventId, `${incomplete.routeId}:run-incomplete:${first.leaseId}`);
    const relaunch = await relaunchEscalated(f.ctx('recover', {}), f.ws, 'T1', { failures: [], rejectedApproaches: [] });
    assert.equal(relaunch.state, 'launched', JSON.stringify(relaunch));
    await drainBackgroundWorkers();
    const retried = f.events[1].event;
    // A follow-up overturns the label; the run's spend went with the first label.
    assert.deepEqual([retried.kind, retried.routeId, retried.costMicroUsd, retried.tokens, retried.latencyMs, retried.apiEquivalentMicroUsd], ['retried', incomplete.routeId, null, null, null, null]);
    assert.equal(f.routed.length, 1, 'the router never picks the escalated model');
    const second = workerRuns(f.ws, 'T1')[1];
    const row = learningRow(f.ws, 'T1');
    assert.deepEqual([row.routeId, row.explored, row.propensity, row.risk, row.outcome], [`gen-${second.leaseId}`, false, null, 'medium', null]);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    const pass = f.events[2].event;
    assert.deepEqual([pass.kind, pass.routeId, pass.modelId, pass.explored, pass.propensity, pass.costMicroUsd], ['verified-pass', `gen-${second.leaseId}`, 'claude-opus-4-5', false, null, 50_000]);
    assert.equal(f.events.length, 3);
  } finally {
    f.done();
  }
});

test('B\'s security review INFO 14: the bounded escalation never picks a stronger model whose provider has no consent; a grant makes it eligible', async () => {
  for (const granted of [false, true]) {
    const f = await fixture({ models: ['claude-sonnet-4-5', 'kimi-k3', 'claude-opus-4-5'], runs: [{ writes: [], status: 'timeout', reason: 'stub', costUsd: 0.01 }, { writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed', costUsd: 0.02 }] });
    try {
      if (granted) assert.equal(grantProviderConsent(f.ws.store, { provider: 'moonshot', textVersion: PROVIDER_CONSENT_TEXT.moonshot.version, atMs: 1_000, actor: 'cli', channel: 'terminal' }).ok, true);
      await f.submit(['T1']);
      assert.equal(getTask(f.ws, 'T1').node.state, 'failed');
      const relaunch = await relaunchEscalated(f.ctx('recover', {}), f.ws, 'T1', { failures: [], rejectedApproaches: [] });
      assert.deepEqual([relaunch.state, relaunch.fromModel, relaunch.toModel], ['launched', 'claude-sonnet-4-5', granted ? 'kimi-k3' : 'claude-opus-4-5'], `moonshot granted=${granted}`);
      await drainBackgroundWorkers();
    } finally {
      f.done();
    }
  }
});

test('R74 (E7): the bounded escalation never picks a stronger model an access limit pauses here; an escalated run that ends on an access limit labels its own route usage-limited', async () => {
  const signal = { port: 'claude', channel: 'structured', errorType: 'rate_limit_event', rateLimitType: 'five_hour', resetAtMs: Date.now() + 3_600_000 };
  const f = await fixture({
    models: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
    runs: [{ writes: [], status: 'timeout', reason: 'stub', costUsd: 0.01 }, { writes: [], status: 'access-limit', reason: 'limit' }],
    certified: async () => true,
    // The port reports the signal only for the run that hit the limit.
    wrap: (p) => ({ ...p, run: async (input) => { const out = await p.run(input); return out.status === 'access-limit' ? { ...out, harness: 'claude', authMode: 'subscription', accessSignal: signal } : out; } }),
  });
  try {
    await f.submit(['T1']);
    assert.equal(getTask(f.ws, 'T1').node.state, 'failed');
    await pauseModel(f.ws.home, 'claude', 'claude-opus-4-5');
    const relaunch = await relaunchEscalated(f.ctx('recover', {}), f.ws, 'T1', { failures: [], rejectedApproaches: [] });
    assert.deepEqual([relaunch.state, relaunch.fromModel, relaunch.toModel], ['launched', 'claude-sonnet-4-5', 'claude-haiku-4-5'], 'the paused opus is skipped');
    await drainBackgroundWorkers();
    const second = workerRuns(f.ws, 'T1')[1];
    assert.deepEqual([second.requestedModel, second.status], ['claude-haiku-4-5', 'access-limit']);
    const last = f.events.at(-1).event;
    assert.deepEqual([last.kind, last.routeId], ['usage-limited', `gen-${second.leaseId}`]);
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked', 'an access limit blocks; it never exhausts the escalation');
  } finally {
    f.done();
  }
});

test('P2: a verified pass that does not hold (the task reopened and its checks now fail) is reverted once, at no second cost; a plain failure stays verified-fail', async () => {
  const flag = join(tempDir('jv-rl-flag-'), 'fail');
  const f = await fixture({ check: `process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 1 : 0)`, runs: [{ writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed', costUsd: 0.02 }] });
  try {
    await f.submit(['T1']);
    await f.call('verify', { taskId: 'T1', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(getTask(f.ws, 'T1').node.state, 'verified');
    const ids = f.ws.receipts.list(f.ws.workspaceId, { taskId: 'T1' }).map((r) => r.receipt.id);
    assert.equal(await f.ws.receipts.invalidate(f.ws.workspaceId, ids, 'inputs-changed'), ids.length);
    assert.equal(getTask(f.ws, 'T1').node.state, 'awaiting-evidence');
    writeFileSync(flag, 'x');
    for (let i = 0; i < 2; i += 1) {
      await f.call('verify', { taskId: 'T1', checkIds: [] });
      await drainBackgroundWorkers();
    }
    const [pass, reverted] = f.events.map((e) => e.event);
    assert.equal(f.events.length, 2, 'reverted once');
    assert.deepEqual([pass.kind, reverted.kind, reverted.labelSource, reverted.routeId, reverted.receiptId, reverted.costMicroUsd, reverted.latencyMs], ['verified-pass', 'reverted', 'revert', pass.routeId, null, null, null]);
    assert.equal(reverted.eventId, `${pass.routeId}:reverted:${pass.routeId.slice(4)}`);
    assert.deepEqual(learningRow(f.ws, 'T1').labels, ['verified-pass', 'reverted']);
  } finally {
    f.done();
  }
});

test('P2: which runs end with no receipt, and which later labels a route takes (pairs)', () => {
  const run = (status, extra = {}) => ({ status, pathViolations: [], ...extra });
  for (const s of ['failed', 'timeout', 'max-turns', 'budget-exceeded', 'refused']) assert.equal(runIncomplete(run(s)), true, s);
  for (const s of ['usage-limit', 'aborted', 'model-unavailable', 'unsupported', 'completed']) assert.equal(runIncomplete(run(s)), false, s);
  assert.equal(runIncomplete(run('completed', { pathViolations: ['x'] })), true, 'a write outside its paths');
  assert.equal(runIncomplete(run('timeout', { stale: true })), false, 'a stale result labels stale');
  assert.equal(runIncomplete(null), false);
  const row = (labels) => ({ outcome: labels.at(-1) ?? null, labels });
  const cases = [
    [[], 'verified-pass', true],
    [['verified-pass'], 'reverted', true],
    [['verified-fail'], 'reverted', false],
    [['verified-pass'], 'verified-fail', false],
    [['run-incomplete'], 'verified-pass', true],
    [['run-incomplete', 'verified-pass'], 'verified-fail', false],
    [['run-incomplete'], 'retried', true],
    [['run-incomplete', 'retried'], 'retried', false],
    [['cancelled'], 'retried', false],
    [['usage-limited'], 'run-incomplete', false],
  ];
  for (const [labels, kind, takes] of cases) assert.equal(routeTakesLabel(row(labels), kind), takes, `${labels.join(',')} + ${kind}`);
  // A row kept before labels existed: its outcome alone.
  assert.equal(routeTakesLabel({ outcome: 'verified-pass' }, 'reverted'), true);
  assert.equal(routeTakesLabel({ outcome: 'verified-pass' }, 'verified-pass'), false);
});

test('P11: the route request carries the slice task volume once enough of its runs finished here; before that none (C taskVolume)', async () => {
  const f = await fixture({ runs: [{ writes: [], status: 'completed', costUsd: 0.01 }] });
  try {
    await f.submit(['T1']);
    assert.equal(f.routed[0].taskVolume, undefined, 'no measured volume yet');
    await f.ws.state.transact((tx) => tx.put('task-estimates', 'seed', { workspaceId: f.ws.workspaceId, taskId: 'S1', sliceId: 'issue-fix', estimateMicroUsd: 1, actualMicroUsd: 1, runs: 5, wallMs: 5, inputTokens: 1, outputTokens: 1, state: 'verified', atMs: 1 }));
    await f.ws.host.transact((tx) => {
      for (let i = 1; i <= 5; i += 1) tx.put('worker-runs', `seed-${String(i)}`, { workspaceId: f.ws.workspaceId, taskId: 'S1', leaseId: `s${String(i)}`, status: 'completed', durationMs: 1, endedAtMs: i, usage: { inputTokens: i * 1000, outputTokens: i * 100, cacheReadInputTokens: i, cacheCreationInputTokens: 0 } });
    });
    await f.submit(['T2']);
    assert.deepEqual(f.routed.at(-1).taskVolume, { inputTokens: 5005, outputTokens: 500, n: 5 });
    // The learning report and the plan's budget view carry the estimates (ids and counts only).
    const report = await f.call('learning.report', {});
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(Object.keys(report.body).sort(), ['estimates', 'evidence', 'reminders', 'restores', 'subagents']);
    assert.ok(report.body.estimates.tasks >= 2, JSON.stringify(report.body.estimates));
    assert.equal((await f.call('learning.report', { rootBudgetId: '../x' })).reasonCode, 'INVALID_REQUEST');
    assert.equal((await f.call('budget.get', { budgetId: 'b1' })).body.estimates.tasks, 2);
  } finally {
    f.done();
  }
});
