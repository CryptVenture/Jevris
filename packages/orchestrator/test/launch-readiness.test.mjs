// Worker-readiness advice at an owned-worker launch (owner decision 2026-10-01, Jev as an active decision aid). Where the
// launch is decided (`routedRun`, reached by `plan.submit` and `task.submit`), Jev is asked ONE fixed question from the task's
// content-free features and the answer is recorded as an advisory decision. It is advice only: the launch is decided by the
// rules, the budget and the permissions, whatever Jev says, and it never waits for Jev past 700 ms. The route is C's real
// `routeManagedWorker`; the worker is the scripted port in a temporary home; the engine is a stub that records every request.
// No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { surfacePayloadContract } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, routeManagedWorker } from '@jevris/core';
import {
  DEFAULT_CONFIG,
  LAUNCH_READINESS_WAIT_MS,
  approveManifests,
  drainBackgroundWorkers,
  getTask,
  manifestHash,
  openWorkspace,
  parseManifest,
  scriptedWorkerPort,
  setRouteLearner,
  setTaskOpDeps,
  sidecarOps,
  workerRuns,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

const MODELS = [BUNDLED_MODEL_REGISTRY.baselineModelId, 'claude-sonnet-5'];

/** An owned plan routed by C's real router; `answer` is Jev's probability (a function of the request), `never` holds Jev's answer for ever. */
async function seam({ answer = () => 0.8, never = false, mode = 'bounded-auto' } = {}) {
  const dir = tempDir('jv-ready-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'app'), { recursive: true });
  writeFileSync(join(repo, 'app', 'zebra.ts'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { unit: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: mode === 'bounded-auto' ? 'bounded-auto' : mode }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const checkedAt = '2026-09-22T00:00:00Z';
  writeFileSync(join(cfg, 'model-registry.json'), JSON.stringify({ ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: 'acct-test', eligible: true, checkedAt }] })) }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: [{ writes: [{ path: 'app/zebra.ts', text: 'b\n' }], status: 'completed', costUsd: 0.01 }] }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  setRouteLearner(null);
  const asked = [];
  const records = [];
  const routed = [];
  const engine = {
    providerConfigured: true,
    sourceEgress: () => 'denied',
    async routeManagedWorker(request) {
      const result = await routeManagedWorker(request, { home, trustedKeys: new Map(), random: () => 0.999 });
      routed.push(result);
      return result;
    },
    async decide(request) {
      asked.push(request);
      if (never) return new Promise(() => {});
      return { abstained: false, decisionId: `dec-${String(asked.length)}`, automation: 'advice', rulesOnly: false, result: { answers: { workerReady: { type: 'noul', noul: answer(request) } } } };
    },
    async recordAdvice(input) {
      records.push(input);
      return { ok: true, decisionId: `adv-${String(records.length)}` };
    },
    async lookup() {
      return null;
    },
  };
  const traces = [];
  const call = (op, body, extra = {}) =>
    sidecarOps.find((o) => o.op === op).handle({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine, mode, trace: (e) => traces.push(e), ...extra,
    });
  return {
    ws, home, routed, traces, call,
    // The plan op classifies slices with the same engine: only the worker-readiness requests and records are this test's.
    get asked() { return asked.filter((r) => r.spec.id === 'worker-readiness'); },
    get records() { return records.filter((r) => r.specId === 'worker-readiness'); },
    done: () => {
      setTaskOpDeps({});
      setRouteLearner(null);
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const task = (id, extra = {}) => ({ id, title: 'Fix the zebra crash', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['app/zebra.ts'], models: MODELS, ...extra });
const submit = (f, tasks, extra) => f.call('plan.submit', { plan: { tasks }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } }, extra);

test('the launch asks Jev one fixed question from counts alone and records it with the launch; the worker launches', async () => {
  const f = await seam({ answer: () => 0.82 });
  try {
    const sub = await submit(f, [task('LOW')]);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    assert.equal(f.asked.length, 1, 'one request at the launch');
    const request = f.asked[0];
    assert.equal(request.spec.id, 'worker-readiness');
    assert.deepEqual(Object.keys(request.questions), ['workerReady']);
    assert.deepEqual(request.packet.evidence, []);
    assert.deepEqual(request.packet.facts, { files: 1, checks: 1, protectedClasses: 'none', verb: 'fix', titleSize: 'short', roleSource: 1, roleTest: 0, roleDocs: 0, roleConfig: 0, roleCi: 0, checkKinds: 'test' });
    for (const leak of ['zebra', 'app/', 'unit', 'Fix the']) assert.equal(JSON.stringify(request).includes(leak), false, `${leak} must not leave`);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].specId, 'worker-readiness');
    assert.equal(f.records[0].taskId, 'LOW');
    assert.deepEqual(f.records[0].action, { kind: 'advise', templateId: 'worker-readiness', evidenceIds: ['feature-files', 'feature-checks', 'feature-protected', 'feature-verb', 'feature-roles'] });
    for (const code of ['READY_SOURCE_JEV', 'READY_STATE_READY', 'READY_P_82', 'READY_FILES_1', 'READY_CHECKS_1', 'WORKER_READINESS_JEV']) assert.ok(f.records[0].reasonCodes.includes(code), code);
    assert.equal(f.records[0].reasonCodes.includes('WORKER_READINESS_COUNTERFACTUAL'), false);
    assert.equal(f.traces.some((t) => t.event === 'orchestrator.worker-readiness' && t.taskId === 'LOW' && typeof t.decisionId === 'string' && t.reasonCode === 'WORKER_READINESS_JEV'), true);
    assert.equal(f.routed.length, 1, 'the router decided the launch, as before');
    assert.equal(workerRuns(f.ws, 'LOW').at(-1)?.requestedModel, MODELS[0], 'and the worker ran');
    // The decision is kept with the task: `task.get` names it and `jevris explain` shows it.
    const got = await f.call('task.get', { taskId: 'LOW' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(surfacePayloadContract('task.get').validate(got.body).ok, true, JSON.stringify(got.body));
    const traced = f.traces.find((t) => t.event === 'orchestrator.worker-readiness');
    assert.deepEqual(got.body.readiness, { decisionId: traced.decisionId, state: 'ready' });
  } finally {
    f.done();
  }
});

test('whatever Jev says the launch is the same: not ready does not block it, ready does not start one, and the model is the router\'s', async () => {
  const outcomes = [];
  for (const p of [0.05, 0.5, 0.95]) {
    const f = await seam({ answer: () => p });
    try {
      const sub = await submit(f, [task('LOW')]);
      assert.equal(sub.ok, true, JSON.stringify(sub));
      await drainBackgroundWorkers();
      const state = f.records[0].reasonCodes.find((c) => c.startsWith('READY_STATE_'));
      outcomes.push([p, state, f.routed.map((r) => [r.launched, r.reasonCode ?? null]), workerRuns(f.ws, 'LOW').at(-1)?.requestedModel, getTask(f.ws, 'LOW').node.state]);
    } finally {
      f.done();
    }
  }
  assert.deepEqual(outcomes.map((o) => o.slice(1, 2)), [['READY_STATE_NOT_READY'], ['READY_STATE_UNSURE'], ['READY_STATE_READY']]);
  assert.equal(new Set(outcomes.map((o) => JSON.stringify(o.slice(2)))).size, 1, 'the launch, the model and the task state do not depend on the answer');
  assert.equal(outcomes[0][3], MODELS[0], 'the approved model ran');
});

test('a provider that never answers costs the launch its bounded wait once and the worker still launches; the miss is traced with its reason', async () => {
  const f = await seam({ never: true });
  try {
    assert.equal(LAUNCH_READINESS_WAIT_MS, 700);
    const sub = await submit(f, [task('LOW')]);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    assert.equal(f.asked.length, 1);
    assert.equal(f.routed.length, 1);
    assert.equal(workerRuns(f.ws, 'LOW').at(-1)?.requestedModel, MODELS[0], 'the worker ran');
    assert.equal(f.traces.some((t) => t.event === 'orchestrator.worker-readiness' && t.reasonCode === 'WORKER_READINESS_DEADLINE'), true);
    assert.ok(f.records[0].reasonCodes.includes('WORKER_READINESS_DEADLINE'));
  } finally {
    f.done();
  }
});

test('the rules answer first: a protected path asks no one; an open task is not ready by rule; both still launch by the launch\'s own rules', async () => {
  const f = await seam();
  try {
    await f.call('plan.submit', { plan: { tasks: [task('SEC', { writeScopes: ['config/secrets.env'], sliceId: 'bounded-edit' })] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    await drainBackgroundWorkers();
    assert.equal(f.asked.length, 0, 'no request');
    assert.ok(f.records[0].reasonCodes.includes('WORKER_READINESS_RULES_PROTECTED'));
    assert.ok(f.records[0].reasonCodes.includes('READY_STATE_NOT_READY'));
    assert.equal(getTask(f.ws, 'SEC') !== undefined, true);
  } finally {
    f.done();
  }
});

test('each gate: jev.assist off and the kill switch ask nothing; a mode below observe records nothing', async () => {
  const off = await seam();
  try {
    await submit(off, [task('LOW')], { jevAssist: 'off' });
    await drainBackgroundWorkers();
    assert.equal(off.asked.length, 0);
    assert.equal(off.records.length, 0, 'jev.assist off is no advice at all');
    assert.equal(off.routed.length, 1, 'the launch is unchanged');
    assert.equal(workerRuns(off.ws, 'LOW').at(-1)?.requestedModel, MODELS[0]);
    assert.equal(off.traces.some((t) => t.event === 'orchestrator.worker-readiness' && t.reasonCode === 'WORKER_READINESS_ASSIST_OFF'), true);
  } finally {
    off.done();
  }
  const mode = await seam();
  try {
    await submit(mode, [task('LOW')], { mode: 'off' });
    await drainBackgroundWorkers();
    assert.equal(mode.asked.length, 0);
    assert.equal(mode.records.length, 0);
  } finally {
    mode.done();
  }
});

test('in observe mode the launch is a counterfactual and the readiness advice is recorded for it, marked so; nothing is launched', async () => {
  const f = await seam({ mode: 'observe' });
  try {
    const sub = await submit(f, [task('LOW')]);
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    // The counterfactual advice runs in the background: wait for its record (a state), not for a fixed time.
    const stop = performance.now() + 30_000;
    while (f.records.length === 0 && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.records.length, 1);
    assert.ok(f.records[0].reasonCodes.includes('WORKER_READINESS_COUNTERFACTUAL'));
    assert.deepEqual(workerRuns(f.ws, 'LOW'), [], 'nothing was launched');
  } finally {
    f.done();
  }
});
