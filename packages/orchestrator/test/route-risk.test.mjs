// P1 (owner decision 7922ee3): the rules-only risk class of an owned-worker route, computed by D,
// and its path across the D-to-C seam. The end-to-end tests use C's real routeManagedWorker and
// learnFromOutcome (not a fake router), so a class that never reaches C's learning fails here.
// Offline: the worker is the scripted port in a temporary home; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { BUNDLED_MODEL_REGISTRY, DecisionBudget, generationBudgetFile, loadLearningState, routeManagedWorker } from '@jevris/core';
import {
  approveManifests,
  DEFAULT_CONFIG,
  DEFAULT_LOW_RISK_SLICE,
  drainBackgroundWorkers,
  getTask,
  learningRow,
  LOW_RISK_MAX_FILES,
  manifestHash,
  openWorkspace,
  parseManifest,
  protectedClasses,
  scriptedWorkerPort,
  setRouteLearner,
  setTaskOpDeps,
  sidecarOps,
  taskRisk,
  workerRuns,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const BASE = { acceptanceCheckIds: ['unit'], writeScopes: ['src/a.ts'] };

function repoWith(files) {
  const root = tempDir('jv-risk-');
  for (const f of files) {
    mkdirSync(join(root, ...f.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...f.split('/')), 'x\n');
  }
  return root;
}

test('a task is low only with checks, a few in-workspace files, nothing protected and no security label', () => {
  const root = repoWith(['src/a.ts', 'src/b.ts', 'docs/guide.md']);
  try {
    assert.deepEqual(taskRisk(BASE, root), { risk: 'low', reasons: [] });
    // A new file (not there yet, with an extension) counts as one file; so does an existing directory's content.
    assert.equal(taskRisk({ ...BASE, writeScopes: ['src/new-module.ts', 'docs'] }, root).risk, 'low');
    // Each rule on its own makes it not low (paired with the low case above).
    assert.deepEqual(taskRisk({ ...BASE, acceptanceCheckIds: [] }, root), { risk: 'medium', reasons: ['NO_ACCEPTANCE_CHECKS'] });
    assert.deepEqual(taskRisk({ ...BASE, writeScopes: [] }, root), { risk: 'medium', reasons: ['NO_WRITE_SCOPES'] });
    assert.deepEqual(taskRisk({ ...BASE, labels: ['Security'] }, root), { risk: 'high', reasons: ['SECURITY_LABEL'] });
    for (const outside of ['../other/a.ts', '/etc/passwd', 'C:\\x\\a.ts', '~/a.ts']) assert.equal(taskRisk({ ...BASE, writeScopes: [outside] }, root).risk, 'high', outside);
    for (const unbounded of ['src/**', 'src/*.ts', '.', 'src/newdir']) assert.deepEqual(taskRisk({ ...BASE, writeScopes: [unbounded] }, root).reasons, ['SCOPE_UNBOUNDED'], unbounded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`the file limit is ${String(LOW_RISK_MAX_FILES)}: at the limit low, one over medium (TOO_MANY_FILES)`, () => {
  const files = Array.from({ length: LOW_RISK_MAX_FILES + 1 }, (_, i) => `lib/f${String(i)}.ts`);
  const root = repoWith(files);
  try {
    assert.equal(taskRisk({ ...BASE, writeScopes: files.slice(0, LOW_RISK_MAX_FILES) }, root).risk, 'low');
    assert.deepEqual(taskRisk({ ...BASE, writeScopes: files }, root), { risk: 'medium', reasons: ['TOO_MANY_FILES'] });
    // A directory holding one more file than the limit is over it too.
    assert.deepEqual(taskRisk({ ...BASE, writeScopes: ['lib'] }, root), { risk: 'medium', reasons: ['TOO_MANY_FILES'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected paths make a task high: auth, secrets, CI, deploy, migrations, lockfiles, git internals', () => {
  const cases = {
    'src/auth/session.ts': 'PROTECTED_AUTH',
    'lib/oauth-client.ts': 'PROTECTED_AUTH',
    '.env.local': 'PROTECTED_SECRETS',
    'config/secrets.json': 'PROTECTED_SECRETS',
    'certs/server.pem': 'PROTECTED_SECRETS',
    '.github/workflows/ci.yml': 'PROTECTED_CI',
    '.gitlab-ci.yml': 'PROTECTED_CI',
    'Dockerfile': 'PROTECTED_DEPLOY',
    'infra/main.tf': 'PROTECTED_DEPLOY',
    'db/migrations/001.sql': 'PROTECTED_MIGRATIONS',
    'package-lock.json': 'PROTECTED_LOCKFILE',
    'Cargo.lock': 'PROTECTED_LOCKFILE',
    '.git/config': 'PROTECTED_GIT',
  };
  const root = repoWith([]);
  try {
    for (const [path, reason] of Object.entries(cases)) {
      assert.ok(protectedClasses(path).includes(reason), `${path} is ${reason}`);
      const cls = taskRisk({ ...BASE, writeScopes: [path] }, root);
      assert.equal(cls.risk, 'high', path);
      assert.ok(cls.reasons.includes(reason), `${path}: ${cls.reasons.join(',')}`);
    }
    // Paired: ordinary names that only look close stay unprotected.
    for (const path of ['src/author.ts', 'src/tokenize.ts', 'docs/deploying-notes.md', 'src/lockstep.ts']) assert.deepEqual(protectedClasses(path), [], path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file under a directory scope is checked too, and a symlinked scope is never low', (t) => {
  const root = repoWith(['pkg/index.ts', 'pkg/auth/token.ts']);
  try {
    const cls = taskRisk({ ...BASE, writeScopes: ['pkg'] }, root);
    assert.deepEqual([cls.risk, cls.reasons.includes('PROTECTED_AUTH')], ['high', true]);
    try {
      symlinkSync(join(root, 'pkg'), join(root, 'link'), 'dir');
    } catch {
      t.diagnostic('this host cannot create a directory symlink; the symlink case is skipped');
      return;
    }
    assert.deepEqual(taskRisk({ ...BASE, writeScopes: ['link/index.ts'] }, root), { risk: 'high', reasons: ['SCOPE_SYMLINK'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a workspace root the scopes cannot be checked, so a task is never low; the other rules still apply', () => {
  assert.deepEqual(taskRisk(BASE, undefined), { risk: 'medium', reasons: ['WORKSPACE_UNKNOWN'] });
  assert.deepEqual(taskRisk({ ...BASE, writeScopes: ['.github/workflows/ci.yml'] }, ''), { risk: 'high', reasons: ['PROTECTED_CI', 'WORKSPACE_UNKNOWN'] });
});

test('a plan may lower the class but never raise it to low', () => {
  const root = repoWith(['src/a.ts']);
  try {
    assert.deepEqual(taskRisk({ ...BASE, declaredRisk: 'medium' }, root), { risk: 'medium', reasons: ['PLAN_DECLARED_MEDIUM'] });
    assert.deepEqual(taskRisk({ ...BASE, declaredRisk: 'high' }, root), { risk: 'high', reasons: ['PLAN_DECLARED_HIGH'] });
    assert.deepEqual(taskRisk({ ...BASE, declaredRisk: 'low' }, root), { risk: 'low', reasons: [] });
    // Declaring low on a task the rules class high changes nothing.
    assert.equal(taskRisk({ ...BASE, writeScopes: ['.github/workflows/ci.yml'], declaredRisk: 'low' }, root).risk, 'high');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ across the D-to-C seam

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** An owned plan routed by C's real router, with exploration forced (random 0), learned by C's real learner. */
async function seam(runs, random = () => 0) {
  const dir = tempDir('jv-risk-seam-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'app'), { recursive: true });
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, 'app', 'a.ts'), 'a\n');
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { unit: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  // A refreshed registry whose account check passed (a placeholder account): the router's
  // account gate keeps every model out without one (the bundled snapshot has no check).
  const checkedAt = '2026-09-22T00:00:00Z';
  writeFileSync(join(cfg, 'model-registry.json'), JSON.stringify({ ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: 'acct-test', eligible: true, checkedAt }] })) }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  setRouteLearner(null);
  const requests = [];
  const results = [];
  const engine = {
    async routeManagedWorker(request) {
      requests.push(request);
      const result = await routeManagedWorker(request, { home, trustedKeys: new Map(), random });
      results.push(result);
      return result;
    },
  };
  const call = (op, body) =>
    sidecarOps.find((o) => o.op === op).handle({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine, trace: () => {},
    });
  return {
    ws, home, requests, results, call,
    done: () => {
      setTaskOpDeps({});
      setRouteLearner(null);
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MODELS = [BUNDLED_MODEL_REGISTRY.baselineModelId, 'claude-sonnet-5'];

test('P1 end to end: a low-risk task reaches C as low, explores, and its verified outcome counts as randomized; a high-risk one never explores', async () => {
  const f = await seam([{ writes: [{ path: 'app/a.ts', text: 'b\n' }], status: 'completed', costUsd: 0.01 }, { writes: [{ path: '.github/workflows/ci.yml', text: 'on: pull_request\n' }], status: 'completed', costUsd: 0.01 }]);
  try {
    const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [scope], models: MODELS });
    const sub = await f.call('plan.submit', { plan: { tasks: [task('LOW', 'app/a.ts')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    const low = getTask(f.ws, 'LOW');
    // D's class and default slice, and what C was sent.
    assert.deepEqual([low.risk, low.riskReasons, low.sliceId], ['low', [], DEFAULT_LOW_RISK_SLICE]);
    assert.deepEqual([f.requests[0].risk, f.requests[0].sliceId, f.requests[0].mode], ['low', DEFAULT_LOW_RISK_SLICE, 'bounded-auto']);
    const lowRow = learningRow(f.ws, 'LOW');
    assert.ok(lowRow !== undefined, 'the router answered a learning note');
    assert.deepEqual([lowRow.risk, lowRow.explored, typeof lowRow.propensity], ['low', true, 'number']);
    // The explored arm ran (random 0 always explores at the capped rate).
    assert.notEqual(workerRuns(f.ws, 'LOW').at(-1)?.requestedModel, undefined);
    await f.call('verify', { taskId: 'LOW', checkIds: [] });
    await drainBackgroundWorkers();
    assert.equal(getTask(f.ws, 'LOW').node.state, 'verified');
    const learned = await loadLearningState({ home: f.home, workspaceId: f.ws.workspaceId });
    const events = learned.events.filter((e) => e.routeId === lowRow.routeId);
    assert.deepEqual(events.map((e) => [e.kind, e.risk, e.explored, e.propensity !== null]), [['verified-pass', 'low', true, true]]);

    // Paired: the same plan shape on a protected path is high, sent as high, and never explores.
    const added = await f.call('task.submit', { task: { ...task('HIGH', '.github/workflows/ci.yml'), rootBudgetId: 'b1' } });
    assert.equal(added.ok, true, JSON.stringify(added));
    await drainBackgroundWorkers();
    const high = getTask(f.ws, 'HIGH');
    assert.deepEqual([high.risk, high.riskReasons, high.sliceId], ['high', ['PROTECTED_CI'], null]);
    assert.equal(f.requests.find((r) => r.taskId === 'HIGH')?.risk, 'high');
    // No slice: the router abstains (UNKNOWN_SLICE), the approved model runs, nothing is learned.
    assert.equal(learningRow(f.ws, 'HIGH'), undefined);
    assert.equal(workerRuns(f.ws, 'HIGH').at(-1)?.requestedModel, MODELS[0]);
  } finally {
    f.done();
  }
});

test('P1 end to end: a high-risk task with a declared slice is routed with its class and never explores, even with random 0', async () => {
  const f = await seam([{ writes: [{ path: '.github/workflows/ci.yml', text: 'on: pull_request\n' }], status: 'completed', costUsd: 0.01 }]);
  try {
    const sub = await f.call('plan.submit', {
      plan: { tasks: [{ id: 'CI', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['.github/workflows/ci.yml'], models: MODELS, sliceId: 'bounded-edit' }] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    assert.equal(f.requests[0].risk, 'high');
    const row = learningRow(f.ws, 'CI');
    assert.ok(row !== undefined, 'the router answered a learning note');
    assert.deepEqual([row.risk, row.explored, row.propensity], ['high', false, null]);
    assert.equal(workerRuns(f.ws, 'CI').at(-1)?.requestedModel, MODELS[0]);
  } finally {
    f.done();
  }
});

test('C\'s MEDIUM (gateway review): a model the launch would refuse is named out before C\'s real router picks, so no budget is held for a run that never started', async () => {
  // Explore (the first draw), and pick the last arm in sort order (Sonnet 5, after Opus's effort arms).
  let draws = 0;
  const f = await seam([{ writes: [{ path: 'app/a.ts', text: 'b\n' }], status: 'completed', costUsd: 0.01 }], () => (draws++ === 0 ? 0 : 0.999));
  try {
    // Sonnet 5 runs on a harness not certified for worker.route; the baseline's harness is.
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: join(f.home, '..', 'worker-script.json') };
    const base = scriptedWorkerPort(env, f.home);
    setTaskOpDeps({
      workerPort: async () => ({ ...base, run: (input) => base.run(input), harnessFor: (model) => (model === 'claude-sonnet-5' ? 'codex' : 'claude'), authFor: async () => ({ mode: 'subscription', source: 'declared' }) }),
      workerRouteCertified: async (harness) => harness === 'claude',
    });
    // Low risk: the router would explore into Sonnet 5 if it were a candidate.
    const sub = await f.call('plan.submit', { plan: { tasks: [{ id: 'LOW', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['app/a.ts'], models: MODELS }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    await drainBackgroundWorkers();
    const budget = await DecisionBudget.open(generationBudgetFile(f.home), { limitMicroUsd: 50_000_000 }).snapshot();
    // Every reservation still held is a route that launched (a scripted run reports no usage, so
    // its own reservation stays held); a pick the launch refused would hold one more (LAUNCH_FAILED).
    assert.deepEqual(f.results.map((r) => [r.launched, r.reasonCode ?? null]), [[true, null]]);
    assert.equal(budget?.holds ?? 0, 1, 'no reservation is held for a refused pick');
    assert.deepEqual([f.requests[0].eligibleModels, f.requests[0].candidateExclusions], [[MODELS[0]], { 'claude-sonnet-5': 'ACTUATOR_UNCERTIFIED' }]);
    assert.equal(workerRuns(f.ws, 'LOW').at(-1)?.requestedModel, MODELS[0], 'the certified baseline ran');
  } finally {
    f.done();
  }
});

test("the pre-spawn release: a port refusal before any child starts releases the route's reservation and settles the lease at 0; a refusal after the child started keeps both held", async () => {
  const refusal = (input, extra) => ({ status: 'refused', reason: 'HOST_NO_LOGIN: set OPENROUTER_API_KEY', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: null, durationMs: 0, ...extra });
  const outcomes = [];
  for (const spawned of [false, true]) {
    const f = await seam([]);
    try {
      const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: join(f.home, '..', 'worker-script.json') };
      const base = scriptedWorkerPort(env, f.home);
      setTaskOpDeps({
        workerPort: async () => ({
          ...base,
          // Paired: the same refusal, before any child (the dispatching port's own) or after one started.
          run: async (input) => {
            if (!spawned) return refusal(input, { spawned: false });
            input.onStart?.({});
            return refusal(input, {});
          },
          harnessFor: () => 'claude',
          authFor: async () => ({ mode: 'subscription', source: 'declared' }),
        }),
        workerRouteCertified: async () => true,
      });
      const sub = await f.call('plan.submit', { plan: { tasks: [{ id: 'LOW', requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: ['app/a.ts'], models: MODELS }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
      assert.equal(sub.ok, true, JSON.stringify(sub));
      await drainBackgroundWorkers();
      const generation = await DecisionBudget.open(generationBudgetFile(f.home), { limitMicroUsd: 50_000_000 }).snapshot();
      const root = (await f.call('budget.get', { budgetId: 'b1' })).body;
      const run = workerRuns(f.ws, 'LOW').at(-1);
      outcomes.push({
        spawned,
        route: f.results.map((r) => [r.launched, r.reasonCode ?? null]),
        holds: generation?.holds ?? 0,
        routeHeld: generation?.heldMicroUsd ?? 0,
        rootHeld: root.use.heldMicroUsd,
        // The lease's own reservation on the root budget: committed at a known spend, or uncertain.
        lease: f.ws.host.list('reservations').filter((r) => r.taskId === 'LOW').map((r) => [r.reservation.state, r.reservation.actualMicroUsd]),
        marked: run?.spawned ?? null,
        effect: run?.effectState ?? null,
        reason: getTask(f.ws, 'LOW')?.stateReason ?? null,
      });
    } finally {
      f.done();
    }
  }
  const [before, after] = outcomes;
  // Before any child: core releases (LAUNCH_NOT_STARTED); the root budget holds nothing; the run says so.
  assert.deepEqual(before.route, [[false, 'LAUNCH_NOT_STARTED']], JSON.stringify(before));
  assert.deepEqual([before.holds, before.routeHeld, before.rootHeld, before.marked], [0, 0, 0, false], JSON.stringify(before));
  assert.deepEqual(before.lease, [['committed', 0]], JSON.stringify(before));
  assert.equal(before.reason, 'worker refused before starting (HOST_NO_LOGIN)', 'the task names the port\'s refusal code');
  // After a child started: the same refusal is unknown spend, held on both budgets for reconciliation.
  assert.deepEqual(after.route, [[true, null]], JSON.stringify(after));
  assert.equal(after.holds, 1, JSON.stringify(after));
  assert.deepEqual(after.lease, [['uncertain', null]], JSON.stringify(after));
  assert.equal(after.marked, null);
  assert.equal(after.reason, 'worker refused');
});
