// Tiered routing on owned workers, the orchestrator's half (owner decision 2026-10-08): the launch sends the router the task's
// content-free tier signals, keeps the tier note the router answers with (ids and codes), and the one bounded escalation of a
// failed task with no stronger approved model goes to the next rung above the model that failed, from the ladder that note
// named, on every harness's own models. Offline: the router is a fake engine method, the worker is the scripted port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { BUNDLED_MODEL_REGISTRY, accessScopeOf, classifyAccessSignal, recordAccessLimit } from '@jevris/core';
import {
  approveManifests,
  DEFAULT_CONFIG,
  drainBackgroundWorkers,
  getTask,
  manifestHash,
  openWorkspace,
  parseManifest,
  relaunchEscalated,
  scriptedWorkerPort,
  setRouteLearner,
  setTaskOpDeps,
  sidecarOps,
  workerRuns,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const { tierRow, escalationRungs, learningRow } = await import('../dist/index.js');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

const NOTE = { policyVersion: 3, sliceMode: 'auto', exploration: null, authMode: 'api-key', usageLimit: null };

/** The tier note the router answers with: the rung above the baseline, nearest first. */
const tierNote = (baseline, up, over = {}) => ({
  tier: up.length === 0 ? 'baseline' : 'step-up',
  targetModelId: up[0] ?? baseline,
  baselineModelId: baseline,
  basis: 'tier-rule',
  label: 'Rules-based default - not a learned route, not a signed prior',
  reasonCodes: ['TIER_PROTECTED_PATH'],
  candidates: [baseline, ...up],
  stepUpModelIds: up,
  decisionId: 'd-tier-1',
  ...over,
});

async function fixture({ runs, models, note, writeScopes = ['mod/T1'], certified, harnessOf = () => 'claude', wrap = (p) => p }) {
  const dir = tempDir('jv-tier-');
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
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath };
  const ported = async () => {
    const p = scriptedWorkerPort(env, home);
    return p === null || certified === undefined ? p : wrap({ run: (input) => p.run(input), harnessFor: (model) => harnessOf(model) });
  };
  setTaskOpDeps({ workerPort: ported, ...(certified === undefined ? {} : { workerRouteCertified: async (harness, nowMs) => certified(harness, nowMs) }) });
  setRouteLearner(async () => ({ recorded: true, reasonCode: null, regression: 'ok', promotion: 'none', proposalId: null, version: 3, saved: true }));
  const routed = [];
  const engine = {
    async routeManagedWorker(input) {
      routed.push(input);
      if (input.mode !== 'bounded-auto') return { launched: false, reasonCode: 'RECORDED' };
      await input.launch({ model: input.eligibleModels[0], maxBudgetUsd: 1, reservationId: 'rsv-1' });
      return { launched: true, learning: NOTE, ...(note === undefined ? {} : { tier: note }) };
    },
  };
  const traces = [];
  const ctx = (op, body, extra = {}) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine, trace: (t) => traces.push(t), ...extra,
  });
  const call = (op, body, extra = {}) => sidecarOps.find((o) => o.op === op).handle(ctx(op, body, extra));
  const task = (id) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes, models, sliceId: 'issue-fix', title: 'fix the ZZSECRETTITLEZZ crash' });
  const submit = async (id) => {
    const sub = await call('plan.submit', { plan: { tasks: [task(id)] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
  };
  return { dir, ws, home, routed, traces, call, ctx, submit, done: () => {
      setTaskOpDeps({});
      setRouteLearner(null);
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

const FAIL_THEN_PASS = [{ writes: [], status: 'timeout', reason: 'stub', costUsd: 0.01 }, { writes: [{ path: 'mod/T1/x.txt', text: 'x\n' }], status: 'completed', costUsd: 0.02 }];

test('the launch sends the router the task\'s content-free tier signals and keeps the tier note it answers with, ids and codes only', async () => {
  const f = await fixture({ runs: FAIL_THEN_PASS, models: ['claude-sonnet-5-5'], note: tierNote('claude-sonnet-5-5', ['claude-opus-5-5']), writeScopes: ['mod/T1', 'src/auth/login.ts'] });
  try {
    await f.submit('T1');
    const request = f.routed[0].tier;
    assert.ok(request !== undefined, 'the route carries a tier request');
    const wire = JSON.stringify(request.signals);
    for (const leak of ['mod/T1', 'login.ts', 'ZZSECRETTITLEZZ', 'alice']) assert.equal(wire.includes(leak), false, `${leak} must not be in the signals`);
    assert.deepEqual([request.signals.files, request.signals.checks, request.signals.verb], [2, 1, 'fix']);
    assert.ok(request.signals.protectedClasses.includes('PROTECTED_AUTH'));
    assert.equal(request.signals.sliceId, 'issue-fix');
    assert.equal(request.jevAssist, 'classify');
    assert.equal(request.text, 'fix the ZZSECRETTITLEZZ crash', 'the title travels as the optional span; core sends it to Jev only with egress approved');
    const row = tierRow(f.ws, 'T1');
    assert.deepEqual([row.tier, row.targetModelId, row.baselineModelId, row.basis, [...row.stepUpModelIds], row.decisionId], ['step-up', 'claude-opus-5-5', 'claude-sonnet-5-5', 'tier-rule', ['claude-opus-5-5'], 'd-tier-1']);
    assert.doesNotMatch(JSON.stringify(row), /ZZSECRET|mod\/T1|alice/);
    assert.equal(f.traces.some((t) => t.event === 'orchestrator.worker-tier' && t.taskId === 'T1' && t.reasonCode === 'TIER_STEP_UP' && t.decisionId === 'd-tier-1'), true);
  } finally {
    f.done();
  }
});

test('jev.assist off is passed to the router; a router that answers no tier keeps none', async () => {
  const f = await fixture({ runs: FAIL_THEN_PASS, models: ['claude-sonnet-5-5'] });
  try {
    const sub = await f.call('plan.submit', { plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod/T1'], models: ['claude-sonnet-5-5'], sliceId: 'issue-fix', title: 'fix it' }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } }, { jevAssist: 'off' });
    assert.equal(sub.ok, true);
    await drainBackgroundWorkers();
    assert.equal(f.routed[0].tier.jevAssist, 'off');
    assert.equal(tierRow(f.ws, 'T1'), undefined, 'no tier note, no row');
    // With no ladder, the bounded escalation has no stronger worker to go to (as before this feature).
    assert.equal(getTask(f.ws, 'T1').node.state, 'failed');
    const relaunch = await relaunchEscalated(f.ctx('recover', {}), f.ws, 'T1', { failures: [], rejectedApproaches: [] });
    assert.deepEqual([relaunch.state, relaunch.toModel], ['no-stronger-worker', null]);
  } finally {
    f.done();
  }
});

/** One failed baseline run, then the bounded escalation, on one harness's own models. */
const HARNESS_LADDERS = [
  // [label, approved model, the ladder above it, expected escalation target (null: none)]
  ['claude: Sonnet 5.5 escalates to Opus 5.5', 'claude-sonnet-5-5', ['claude-opus-5-5'], 'claude-opus-5-5'],
  ['codex: GPT-6.1 Sol escalates to GPT-5.6 Sol, the first rung above it, not GPT-6 Astra', 'gpt-6.1-sol', ['gpt-5.6-sol', 'gpt-6-astra'], 'gpt-5.6-sol'],
  ['kilocode and opencode on a GPT session: the same OpenAI ladder, never a Claude model', 'gpt-6-sol', ['gpt-5.6-sol', 'gpt-6-astra'], 'gpt-5.6-sol'],
  ['antigravity: Google has no rung above Gemini 3.8 Flash, so there is no stronger worker', 'gemini-3.8-flash', [], null],
];
for (const [label, baseline, ladder, expected] of HARNESS_LADDERS) {
  test(`the bounded escalation of a failed baseline run goes to the step-up rung: ${label}`, async () => {
    const f = await fixture({ runs: FAIL_THEN_PASS, models: [baseline], note: tierNote(baseline, ladder) });
    try {
      await f.submit('T1');
      assert.equal(getTask(f.ws, 'T1').node.state, 'failed');
      const relaunch = await relaunchEscalated(f.ctx('recover', {}), f.ws, 'T1', { failures: [], rejectedApproaches: [] });
      assert.deepEqual([relaunch.state, relaunch.fromModel, relaunch.toModel], expected === null ? ['no-stronger-worker', baseline, null] : ['launched', baseline, expected]);
      await drainBackgroundWorkers();
      if (expected !== null) {
        const second = workerRuns(f.ws, 'T1')[1];
        assert.equal(second.requestedModel, expected, 'the escalated run ran the rung');
        assert.equal(f.routed.length, 1, 'the router never picks the escalated model');
        const row = learningRow(f.ws, 'T1');
        assert.deepEqual([row.routeId, row.explored, row.propensity], [`gen-${second.leaseId}`, false, null], 'its own route, not randomized, never a learned arm');
      }
    } finally {
      f.done();
    }
  });
}

test('an escalation never goes outside what the launch could use: a paused rung is skipped, and a failed rung escalates to the one above it', () => {
  const row = { stepUpModelIds: ['gpt-5.6-sol', 'gpt-6-astra'] };
  assert.deepEqual([...escalationRungs(row, 'gpt-6.1-sol')], ['gpt-5.6-sol', 'gpt-6-astra'], 'the baseline failed: the whole ladder');
  assert.deepEqual([...escalationRungs(row, 'gpt-5.6-sol')], ['gpt-6-astra'], 'the step-up rung failed: the one above it');
  assert.deepEqual([...escalationRungs(row, 'gpt-6-astra')], [], 'the dearest failed: nothing above');
  assert.deepEqual([...escalationRungs(row, null)], ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.deepEqual([...escalationRungs(undefined, 'x')], [], 'no row, no ladder');
});

test('R74: a rung an access limit pauses here is skipped by the escalation, which then has no stronger worker', async () => {
  const f = await fixture({ runs: FAIL_THEN_PASS, models: ['claude-sonnet-5-5'], note: tierNote('claude-sonnet-5-5', ['claude-opus-5-5']), certified: async () => true });
  try {
    await f.submit('T1');
    const nowMs = Date.now();
    const scope = accessScopeOf(BUNDLED_MODEL_REGISTRY, 'claude', 'claude-opus-5-5', 'unknown');
    const classification = classifyAccessSignal({ port: 'claude-api', channel: 'structured', status: 429, certified: false }, 'unknown', nowMs);
    assert.equal((await recordAccessLimit({ home: f.ws.home, scope, classification, source: 'owned-run', nowMs })).ok, true);
    const relaunch = await relaunchEscalated(f.ctx('recover', {}), f.ws, 'T1', { failures: [], rejectedApproaches: [] });
    assert.deepEqual([relaunch.state, relaunch.toModel], ['no-stronger-worker', null]);
  } finally {
    f.done();
  }
});
