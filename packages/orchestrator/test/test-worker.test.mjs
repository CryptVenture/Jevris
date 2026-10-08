// The scripted worker port (JEVRIS_TEST=1 only) that lets the sandboxed acceptance suite drive
// owned workers end to end without the Agent SDK or a real harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beginOwnedEffect, holdPendingEffects, linkSession, listSessionLinks, mintAuthorization, readAudit, recordSession, sessionLinkFor, workspaceView } from '@jevris/store';
import { jevrisPaths } from '@jevris/platform';
import {
  approveManifests,
  approvedScopeFor,
  turnTierSignals,
  linkPlannedSession,
  mainSessionView,
  hostRouteCertified,
  turnRouteCertified,
  certificationGateFrom,
  setCertificationGate,
  linkedSessionRead,
  HOST_ROUTE_FEATURE,
  ownedSessions,
  ownedWorktreeWorkspaces,
  OWNED_WORKTREE_WORKSPACES_MAX,
  ADMIN_VALUES,
  DEFAULT_CONFIG,
  setConfigValue,
  declare,
  writeCapsule,
  drainBackgroundWorkers,
  effectOperationId,
  getTask,
  heldTaskEffects,
  leaseAuthorityFor,
  listWorktrees,
  loadWorkerPort as loadRealWorkerPort,
  harnessWorkerPort,
  loadAntigravityWorkerPort,
  loadClaudeCliWorkerPort,
  loadCodexWorkerPort,
  loadKiloWorkerPort,
  loadOpencodeWorkerPort,
  loadStoredCredentials,
  CLAUDE_CLI_PORT_MISSING,
  CODEX_PORT_MISSING,
  manifestHash,
  openWorkspace,
  parseManifest,
  runsFromInstalledRuntime,
  scheduleTasks,
  selfIdentity,
  scriptedWorkerPort,
  setTaskOpDeps,
  sidecarOps,
  testWorkerPortStatus,
  workerRuns,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

// Every harness loader a test does not name answers null, so no test ever runs one of F's
// real ports (they spawn the harness binary). The stub ports name any model on OpenCode and Kilo
// unless a test passes its own `harnessModelId` (R29 tests F's naming rule on its own).
const noPort = async () => null;
const loadWorkerPort = (loaders = {}, options = {}) =>
  loadRealWorkerPort({ sdk: noPort, claude: noPort, codex: noPort, opencode: noPort, kilo: noPort, antigravity: noPort, ...loaders }, { harnessModelId: (model) => model, ...options });

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function script(dir, runs) {
  const path = join(dir, 'worker-script.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs }));
  return path;
}

function markHome(home, mode = 0o600) {
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  const file = join(state, 'test-home.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode });
  chmodSync(file, mode);
  return file;
}

test('the scripted port needs JEVRIS_TEST=1, a test-home marker and an absolute, existing, valid script', () => {
  const dir = tempDir('jv-tw-');
  try {
    const home = join(dir, 'home');
    const path = script(dir, [{ writes: [], status: 'completed' }]);
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: path };
    const outside = { entry: join(dir, 'repo', 'bin', 'jevris.mjs'), osHome: join(dir, 'user') };
    // Env vars alone: refused, with a diagnostic line, and no port.
    assert.equal(testWorkerPortStatus({ JEVRIS_TEST_WORKER_SCRIPT: path }, home, outside).reason, 'NOT_TEST_MODE');
    const alone = testWorkerPortStatus(env, home, outside);
    assert.equal(alone.reason, 'NO_TEST_HOME_MARKER');
    assert.match(alone.diagnostic, /test worker port refused \(NO_TEST_HOME_MARKER\)/);
    assert.equal(scriptedWorkerPort(env, home, outside), null, 'never from the environment alone');
    assert.equal(testWorkerPortStatus({}, home, outside).diagnostic, null, 'no line when nothing asks for it');
    const marker = markHome(home);
    if (process.platform !== 'win32') {
      chmodSync(marker, 0o666);
      assert.equal(testWorkerPortStatus(env, home, outside).reason, 'NO_TEST_HOME_MARKER', 'a writable-by-others marker does not count');
      chmodSync(marker, 0o600);
    }
    assert.equal(testWorkerPortStatus({ JEVRIS_TEST: '1' }, home, outside).reason, 'NO_SCRIPT');
    assert.equal(testWorkerPortStatus({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: 'rel.json' }, home, outside).reason, 'SCRIPT_NOT_ABSOLUTE');
    assert.equal(testWorkerPortStatus({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: join(dir, 'none.json') }, home, outside).reason, 'SCRIPT_MISSING');
    writeFileSync(join(dir, 'bad.json'), '{"schemaVersion":"x"}');
    assert.equal(testWorkerPortStatus({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: join(dir, 'bad.json') }, home, outside).reason, 'SCRIPT_INVALID');
    // The script is data: a run naming a command or argv makes the whole script invalid; nothing is spawned.
    const cmd = script(dir, [{ writes: [], status: 'completed', argv: [process.execPath, '-e', '0'] }]);
    assert.equal(testWorkerPortStatus({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: cmd }, home, outside).reason, 'SCRIPT_INVALID');
    // Marker plus env in a sandbox: honoured, and status and doctor get an ACTIVE line.
    const active = testWorkerPortStatus({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed' }]) }, home, outside);
    assert.equal(active.active, true);
    assert.equal(active.reason, 'ACTIVE');
    assert.match(active.diagnostic, /test worker port ACTIVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('from the user\'s installed runtime copy the scripted port is refused, even with the marker and env vars', () => {
  const dir = tempDir('jv-tw-');
  try {
    const osHome = join(dir, 'user');
    const installed = join(jevrisPaths({ home: undefined, env: {}, osHome }).data, 'runtime', '1.2.0', 'bin', 'jevris.mjs');
    mkdirSync(join(installed, '..'), { recursive: true });
    writeFileSync(installed, '');
    const home = join(dir, 'home');
    markHome(home);
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed' }]) };
    assert.equal(runsFromInstalledRuntime({ entry: installed, osHome, env: {} }), true);
    const status = testWorkerPortStatus(env, home, { entry: installed, osHome });
    assert.equal(status.reason, 'INSTALLED_RUNTIME');
    assert.match(status.diagnostic, /refused \(INSTALLED_RUNTIME\)/);
    assert.equal(scriptedWorkerPort(env, home, { entry: installed, osHome }), null);
    assert.equal(runsFromInstalledRuntime({ entry: join(dir, 'repo', 'bin', 'jevris.mjs'), osHome, env: {} }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripted runs write only inside the worktree, replay in order, and honour abort', async () => {
  const dir = tempDir('jv-tw-');
  try {
    const cwd = join(dir, 'wt');
    mkdirSync(cwd);
    const path = script(dir, [
      { writes: [{ path: 'mod/a.txt', text: 'one\n' }], status: 'completed', costUsd: 0.01 },
      { writes: [{ path: '../escape.txt', text: 'no' }], status: 'completed' },
      { writes: [], status: 'failed', reason: 'TypeError at mod/a.txt:1' },
    ]);
    const home = join(dir, 'home');
    markHome(home);
    const port = scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: path }, home);
    const input = { prompt: 'p', model: 'claude-sonnet-4-5', cwd, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
    const first = await port.run(input);
    assert.equal(first.status, 'completed');
    assert.equal(first.costUsd, 0.01);
    assert.equal(readFileSync(join(cwd, 'mod', 'a.txt'), 'utf8'), 'one\n');
    const second = await port.run(input);
    assert.equal(second.status, 'refused');
    assert.equal(existsSync(join(dir, 'escape.txt')), false, 'nothing is written outside the worktree');
    const third = await port.run(input);
    assert.equal(third.status, 'failed');
    assert.equal((await port.run(input)).status, 'failed', 'the last run repeats');
    const waiting = scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed', waitForFile: join(dir, 'go') }]) }, home);
    const ac = new AbortController();
    const pending = waiting.run({ ...input, signal: ac.signal });
    ac.abort();
    assert.equal((await pending).status, 'aborted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('through task.submit with bounded-auto workers, a scripted run is a held owned effect when the kill switch activates mid-run (US40)', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  let restoreEnv = () => {};
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [{ path: 'mod/fixed.txt', text: 'ok\n' }], status: 'completed', costUsd: 0.02, waitForFile: join(dir, 'go') }]) };
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    const cfg = jevrisPaths({ home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
    // The product wiring: no test seam, only the sidecar's environment names the script.
    setTaskOpDeps({});
    const saved = { t: process.env.JEVRIS_TEST, s: process.env.JEVRIS_TEST_WORKER_SCRIPT };
    Object.assign(process.env, env);
    restoreEnv = () => {
      for (const [k, v] of [['JEVRIS_TEST', saved.t], ['JEVRIS_TEST_WORKER_SCRIPT', saved.s]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    const traces = [];
    const ctx = (op, body) => ({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: (e) => traces.push(e),
    });
    const plan = await sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx('plan.submit', {
      plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] }] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    }));
    assert.equal(plan.body.accepted, true, JSON.stringify(plan.body));
    assert.equal(plan.body.leaseIds.length, 1, 'the scripted worker was leased');
    assert.ok(traces.some((e) => e.event === 'orchestrator.test-worker-port'), 'the scripted port is traced');
    const held = holdPendingEffects(store, { nowMs: Date.now(), actor: 'tester', channel: 'cli' }).held;
    assert.deepEqual(held, [effectOperationId(plan.body.leaseIds[0])]);
    writeFileSync(join(dir, 'go'), '');
    await drainBackgroundWorkers();
    assert.equal(getTask(ws, 'T1').node.state, 'blocked');
    assert.equal(heldTaskEffects(ws).length, 1);
    const rec = await sidecarOps.find((o) => o.op === 'task.reconcile').handle(ctx('task.reconcile', { taskId: 'T1', resolution: 'applied' }));
    assert.equal(rec.body.reconciled, true, JSON.stringify(rec.body));
    // Ready again after the person's reconcile, and bounded-auto resumes it under a new lease.
    assert.equal(getTask(ws, 'T1').node.state, 'leased');
    await drainBackgroundWorkers();
  } finally {
    restoreEnv();
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crashed worker: the dead holder\'s lease is swept, the task blocks (LEASE_EXPIRED), task.reconcile resumes it under a new lease, and the late result is kept without replacing state (ORC-03, W04)', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  let holderDead = false;
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    const cfg = jevrisPaths({ home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed', waitForFile: join(dir, 'go') }]) };
    // The worker's holder "dies" (a sidecar killed mid-run), seen through the sweep's liveness probe.
    setTaskOpDeps({
      workerPort: async () => scriptedWorkerPort(env, home),
      authority: (w) => {
        const a = leaseAuthorityFor(w);
        return { ...a, sweep: (id, now) => a.sweep(id, now, () => (holderDead ? 'dead' : 'alive')) };
      },
    });
    const ctx = (op, body) => ({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
    });
    const plan = await sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx('plan.submit', {
      plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] }] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    }));
    assert.equal(plan.body.leaseIds.length, 1);
    // The first worker is mid-run (waiting) when its holder dies.
    for (let i = 0; i < 1_200 && !ownedSessions(ws).some((o) => o.taskId === 'T1' && o.state === 'running'); i += 1) await new Promise((r) => setTimeout(r, 25));
    holderDead = true;
    const rec = await sidecarOps.find((o) => o.op === 'task.reconcile').handle(ctx('task.reconcile', { taskId: 'T1', resolution: 'abandoned' }));
    // Reconciled to ready, then leased again at once (the plan continues).
    assert.deepEqual([rec.body.reconciled, rec.body.reasonCode, rec.body.taskState], [true, 'LEASE_RECONCILED', 'leased'], JSON.stringify(rec.body));
    holderDead = false;
    writeFileSync(join(dir, 'go'), '');
    await drainBackgroundWorkers();
    assert.notEqual(getTask(ws, 'T1').node.state, 'verified', 'the swept run never completes the task');
    const runs = workerRuns(ws, 'T1');
    assert.equal(runs.length, 2);
    assert.equal(runs.filter((r) => r.stale === true).length, 1, 'the late result is kept as history, marked stale');
    assert.equal(getTask(ws, 'T1').node.state, 'awaiting-evidence', 'the current lease\'s result stands');
    const view = await sidecarOps.find((o) => o.op === 'task.get').handle(ctx('task.get', { taskId: 'T1' }));
    assert.equal(view.body.worker.status, 'completed');
    assert.equal(view.body.lateResults, 1, 'the late result is observable, and counted');
  } finally {
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A\'s bug 1: task.reconcile answers within its deadline when leasing the next wave is slow; the decision is applied and the lease follows in the background', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  let holderDead = false;
  let slow = false;
  let release = () => undefined;
  const gate = new Promise((r) => (release = r));
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    const cfg = jevrisPaths({ home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed', waitForFile: join(dir, 'go') }]) };
    // Loading the worker port stands for the slow part of leasing the next wave under load.
    setTaskOpDeps({
      workerPort: async () => (slow ? (await gate, scriptedWorkerPort(env, home)) : scriptedWorkerPort(env, home)),
      authority: (w) => {
        const a = leaseAuthorityFor(w);
        return { ...a, sweep: (id, now) => a.sweep(id, now, () => (holderDead ? 'dead' : 'alive')) };
      },
    });
    const ctx = (op, body, budgetMs = 5000) => {
      const startedAt = Date.now();
      return {
        op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
        signal: new AbortController().signal, deadline: { budgetMs, remainingMs: () => budgetMs - (Date.now() - startedAt), expired: () => Date.now() - startedAt >= budgetMs }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
      };
    };
    const plan = await sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx('plan.submit', {
      plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] }] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    }));
    assert.equal(plan.body.leaseIds.length, 1);
    for (let i = 0; i < 1_200 && !ownedSessions(ws).some((o) => o.taskId === 'T1' && o.state === 'running'); i += 1) await new Promise((r) => setTimeout(r, 25));
    holderDead = true;
    slow = true;
    // The continuation is held at the port load until released below, so this answer can only
    // come from the op's own deadline bound (before the fix it waited, and this await never ended).
    const rec = await sidecarOps.find((o) => o.op === 'task.reconcile').handle(ctx('task.reconcile', { taskId: 'T1', resolution: 'abandoned' }, 600));
    // The decision is applied and answered as it stands: the next lease has not been taken yet.
    assert.deepEqual([rec.body.reconciled, rec.body.reasonCode, rec.body.taskState], [true, 'LEASE_RECONCILED', 'ready'], JSON.stringify(rec.body));
    holderDead = false;
    release();
    for (let i = 0; i < 1_200 && getTask(ws, 'T1').node.state === 'ready'; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.notEqual(getTask(ws, 'T1').node.state, 'ready', 'the continuation leased the task after the answer');
    writeFileSync(join(dir, 'go'), '');
    await drainBackgroundWorkers();
    assert.equal(workerRuns(ws, 'T1').length, 2);
    assert.equal(getTask(ws, 'T1').node.state, 'awaiting-evidence');
  } finally {
    release();
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify with an owned task id checks the task\'s worktree and, on a pass, moves it to verified with fresh receipts (W01)', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    // The check passes only where the worker's patch is.
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', "require('fs').accessSync('mod/fixed.txt')"], resultFormat: 'exit-code', inputScopes: ['mod'], requirementIds: ['R1'] }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    const cfg = jevrisPaths({ home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [{ path: 'mod/fixed.txt', text: 'ok\n' }], status: 'completed', costUsd: 0.02 }, { writes: [{ path: 'lib/other.txt', text: 'no\n' }], status: 'completed', costUsd: 0.01 }]) };
    setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
    const ctx = (op, body) => ({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
    });
    const plan = await sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx('plan.submit', {
      plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] }] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    }));
    assert.equal(plan.body.leaseIds.length, 1);
    await drainBackgroundWorkers();
    assert.equal(getTask(ws, 'T1').node.state, 'awaiting-evidence');
    assert.equal(existsSync(join(repo, 'mod', 'fixed.txt')), false, 'the patch is in the worktree, not the main checkout');
    const out = await sidecarOps.find((o) => o.op === 'verify').handle(ctx('verify', { taskId: 'T1', checkIds: [] }));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.body.readiness, 'verified', JSON.stringify(out.body));
    assert.equal(getTask(ws, 'T1').node.state, 'verified');
    // A second task with the same check fails in its own worktree; that never demotes T1 or
    // makes T1's receipt stale, and T2's own receipt is fresh right after its run.
    const t2 = await sidecarOps.find((o) => o.op === 'task.submit').handle(ctx('task.submit', { task: { id: 'T2', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['lib'], rootBudgetId: 'b1', models: ['claude-sonnet-4-5'] } }));
    assert.equal(t2.body.leaseIds.length, 1, JSON.stringify(t2.body));
    await drainBackgroundWorkers();
    const second = await sidecarOps.find((o) => o.op === 'verify').handle(ctx('verify', { taskId: 'T2', checkIds: [] }));
    assert.notEqual(second.body.readiness, 'verified');
    assert.deepEqual(second.body.checks.map((c) => [c.outcome, c.fresh]), [['failed', true]], JSON.stringify(second.body));
    assert.equal(getTask(ws, 'T1').node.state, 'verified', 'T2 does not demote T1');
    const t1 = await sidecarOps.find((o) => o.op === 'task.get').handle(ctx('task.get', { taskId: 'T1' }));
    assert.ok(t1.body.receipts.every((r) => r.fresh), JSON.stringify(t1.body.receipts));
    // The final report's worker line: requested and actual model apart, the reported cost.
    assert.deepEqual(t1.body.worker, { requestedModel: 'claude-sonnet-4-5', actualModel: 'claude-sonnet-4-5', status: 'completed', costMicroUsd: 20_000, costBasis: 'reported', durationMs: t1.body.worker.durationMs });
    // An edit inside T1's own check scope, in T1's worktree, does make T1's receipt stale.
    const tree = listWorktrees(ws).find((t) => t.taskId === 'T1');
    writeFileSync(join(tree.path, 'mod', 'fixed.txt'), 'edited\n');
    const t1Status = await sidecarOps.find((o) => o.op === 'verify.status').handle(ctx('verify.status', { taskId: 'T1', checkIds: [] }));
    assert.deepEqual(t1Status.body.checks.map((c) => [c.checkId, c.fresh]), [['fixed', false]], JSON.stringify(t1Status.body));
    // Plain workspace verification still runs in the main checkout, where the check fails.
    const main = await sidecarOps.find((o) => o.op === 'verify').handle(ctx('verify', { taskId: null, checkIds: ['fixed'] }));
    assert.notEqual(main.body.readiness, 'verified');
  } finally {
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function routedFixture(mode) {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: mode }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed', costUsd: 0.01 }]) };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  const calls = [];
  const traces = [];
  const engineWith = (answer) => ({
    async routeManagedWorker(input) {
      calls.push(input);
      return answer(input);
    },
  });
  const ctx = (engine) => (op, body) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine, trace: (e) => traces.push(e),
  });
  const submit = (engine) => sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx(engine)('plan.submit', {
    plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5', 'claude-haiku-4-5'], sliceId: 'bounded-edit' }] },
    ownerId: 'alice',
    channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
  }));
  return { ws, store, calls, traces, engineWith, submit, done: () => {
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('bounded-auto owned launch goes through C\'s routeManagedWorker: the routed model runs, within the task\'s eligible models (RTE-12)', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    const engine = f.engineWith(async (input) => {
      const receipt = await input.launch({ model: 'claude-haiku-4-5', maxBudgetUsd: 0.5, reservationId: 'r1' });
      return { launched: true, receipt };
    });
    const plan = await f.submit(engine);
    assert.equal(plan.body.leaseIds.length, 1);
    await drainBackgroundWorkers();
    assert.deepEqual(f.calls[0].eligibleModels, ['claude-sonnet-4-5', 'claude-haiku-4-5']);
    assert.equal(f.calls[0].sliceId, 'bounded-edit', 'the planner-declared slice reaches the router');
    assert.equal(f.calls[0].mode, 'bounded-auto');
    const run = workerRuns(f.ws, 'T1').at(-1);
    assert.equal(run.requestedModel, 'claude-haiku-4-5', 'the routed model ran');
    assert.ok(f.traces.some((e) => e.event === 'orchestrator.worker-route' && e.reasonCode === 'ROUTED'));
  } finally {
    f.done();
  }
});

/**
 * R52: a routed fixture whose task T1 (Kimi K3, then Sonnet 5) is linked to a Kilo session that runs
 * through OpenRouter, with a port that reaches `hostModels` through a host and records each run.
 */
async function hostRoutedFixture(hostModels, { harnessThrows = false } = {}) {
  const f = await routedFixture('bounded-auto');
  const atMs = Date.now();
  assert.equal(recordSession(f.ws.store, { sessionId: 'kilo-1', harness: 'kilocode', state: 'active', actualModel: 'openrouter/moonshotai/kimi-k3', atMs }).ok, true);
  assert.equal(linkSession(f.ws.store, { sessionId: 'kilo-1', harness: 'kilocode', taskId: 'T1', via: 'route', actor: 'tester', channel: 'terminal', atMs }).ok, true);
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dirname(f.ws.home), [{ writes: [], status: 'completed', costUsd: 0.01 }]) };
  const base = scriptedWorkerPort(env, f.ws.home);
  const runs = [];
  const port = {
    ...base,
    run: (input) => (runs.push({ model: input.model, servingHost: input.servingHost }), base.run(input)),
    harnessFor: (model, servingHost) => {
      if (harnessThrows) throw new Error('the port could not read its settings');
      return servingHost === undefined || hostModels.includes(model) ? 'kilo' : null;
    },
    authFor: async () => ({ mode: 'api-key', source: 'declared' }),
  };
  setTaskOpDeps({ workerPort: async () => port });
  const submit = (engine) => sidecarOps.find((o) => o.op === 'plan.submit').handle({
    op: 'plan.submit', client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: f.ws.workspaceId, root: f.ws.workspaceRoot }, home: f.ws.home,
    body: { plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['kimi-k3', 'claude-sonnet-5'], sliceId: 'bounded-edit' }] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } },
    signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store: f.store, killSwitchStopped: false, engine, trace: (e) => f.traces.push(e),
  });
  /** C's router, reduced: it launches `model`, or answers why not; a launch that throws is LAUNCH_FAILED. */
  const router = (model, notLaunched = null) => f.engineWith(async (input) => {
    if (notLaunched !== null) return { launched: false, reasonCode: notLaunched, selection: null };
    try {
      return { launched: true, receipt: await input.launch({ model, maxBudgetUsd: 0.5, reservationId: 'r1' }) };
    } catch {
      return { launched: false, reasonCode: 'LAUNCH_FAILED', selection: null };
    }
  });
  return { ...f, runs, submit, router };
}

test('R52: a task linked to a session through a pinned host routes with that host and its route.host answer, and every launch goes through the host', async () => {
  setCertificationGate(async (q) => ({ certified: q.harness === 'kilocode' && q.featureId === 'route.host', reasonCode: null }));
  const f = await hostRoutedFixture(['kimi-k3', 'claude-sonnet-5']);
  try {
    const plan = await f.submit(f.router('claude-sonnet-5'));
    assert.equal(plan.body.leaseIds.length, 1);
    await drainBackgroundWorkers();
    assert.deepEqual([f.calls[0].servingHost, f.calls[0].hostRouteCertified], ['openrouter', true]);
    assert.deepEqual(f.runs, [{ model: 'claude-sonnet-5', servingHost: 'openrouter' }], 'the routed pick runs through the session\'s host');
  } finally {
    f.done();
  }
  // C's MEDIUM, B's LOW 43: a model the host cannot run is named out before routing, so it is never picked or reserved.
  const g = await hostRoutedFixture(['kimi-k3']);
  try {
    await g.submit(g.router('kimi-k3'));
    await drainBackgroundWorkers();
    assert.deepEqual([g.calls[0].eligibleModels, g.calls[0].candidateExclusions], [['kimi-k3'], { 'claude-sonnet-5': 'NOT_ON_SESSION_HOST' }]);
    assert.deepEqual(g.runs, [{ model: 'kimi-k3', servingHost: 'openrouter' }]);
  } finally {
    setCertificationGate(null);
    g.done();
  }
});

test('R52: a route through the session\'s host that does not launch launches nothing and never runs direct at the maker', async () => {
  for (const why of ['ROUTE_HOST_NOT_CERTIFIED', 'HOST_TARIFF_UNKNOWN']) {
    const f = await hostRoutedFixture(['kimi-k3', 'claude-sonnet-5']);
    try {
      await f.submit(f.router('kimi-k3', why));
      await drainBackgroundWorkers();
      assert.deepEqual([f.calls[0].servingHost, f.calls[0].hostRouteCertified], ['openrouter', false], why);
      assert.deepEqual(f.runs, [], `${why}: nothing ran, through the host or direct`);
      assert.equal(workerRuns(f.ws, 'T1').length, 0, why);
      const task = getTask(f.ws, 'T1');
      assert.equal(task.node.state, 'blocked', why);
      assert.match(task.stateReason, new RegExp(`^HOST_ROUTE_NOT_LAUNCHED: the linked session runs through openrouter.*\\(${why}\\); nothing ran direct at the maker$`), why);
      assert.ok(f.traces.some((e) => e.event === 'orchestrator.worker-route' && e.reasonCode === `BASELINE_${why}`), why);
    } finally {
      f.done();
    }
  }
});

test('R52 (B\'s LOW 44, C\'s MEDIUM): a linked session that cannot be read, or a host that cannot run the approved model or any model, routes nothing, reserves nothing and runs nothing', async () => {
  for (const [label, hostModels, harnessThrows, why] of [
    // The port cannot say which harness runs the model: the host read fails, and fails closed.
    ['an unreadable host', ['kimi-k3', 'claude-sonnet-5'], true, /could not be read \(HOST_READ_FAILED\)/],
    ['the approved model off the host', ['claude-sonnet-5'], false, /cannot run the task's approved model or its models here \(NOT_ON_SESSION_HOST\)/],
    ['no model on the host', [], false, /cannot run the task's approved model or its models here \(NOT_ON_SESSION_HOST\)/],
  ]) {
    const f = await hostRoutedFixture(hostModels, { harnessThrows });
    try {
      await f.submit(f.router('kimi-k3'));
      await drainBackgroundWorkers();
      assert.deepEqual([f.calls.length, f.runs.length, workerRuns(f.ws, 'T1').length], [0, 0, 0], `${label}: not routed, nothing ran`);
      const task = getTask(f.ws, 'T1');
      assert.equal(task.node.state, 'blocked', label);
      assert.match(task.stateReason, /^HOST_ROUTE_NOT_LAUNCHED: /, label);
      assert.match(task.stateReason, why, label);
      assert.match(task.stateReason, /nothing ran direct at the maker$/, label);
    } finally {
      f.done();
    }
  }
});

test('R52 (B\'s LOW 44): the linked-session read tells a failed read from no link', () => {
  const dir = tempDir('jv-r52-read-');
  const store = testStore(dir);
  try {
    assert.deepEqual(linkedSessionRead(store, 'T1', 'kilo'), { ok: true, model: null });
    assert.deepEqual(linkedSessionRead(undefined, 'T1', 'kilo'), { ok: true, model: null }, 'no store (rules-only) is no link');
  } finally {
    closeTestStore(store);
  }
  assert.deepEqual(linkedSessionRead(store, 'T1', 'kilo'), { ok: false }, 'a closed store is a failed read');
  rmSync(dir, { recursive: true, force: true });
});

test('R52: with no linked session, or one direct at the maker, the route carries no host and the approved model runs as before', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    await f.submit(f.engineWith(async () => ({ launched: false, reasonCode: 'CALIBRATION_NO_RELEASE', selection: null })));
    await drainBackgroundWorkers();
    assert.equal(Object.hasOwn(f.calls[0], 'servingHost'), false);
    assert.equal(workerRuns(f.ws, 'T1').at(-1).requestedModel, 'claude-sonnet-4-5', 'the baseline ran direct');
  } finally {
    f.done();
  }
});

test('when the router does not launch (no calibration release) or picks an ineligible model, the approved model runs and the reason is traced', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    await f.submit(f.engineWith(async () => ({ launched: false, reasonCode: 'CALIBRATION_NO_RELEASE' })));
    await drainBackgroundWorkers();
    assert.equal(workerRuns(f.ws, 'T1').at(-1).requestedModel, 'claude-sonnet-4-5');
    assert.ok(f.traces.some((e) => e.event === 'orchestrator.worker-route' && e.reasonCode === 'BASELINE_CALIBRATION_NO_RELEASE'), JSON.stringify(f.traces));
  } finally {
    f.done();
  }
  const g = await routedFixture('bounded-auto');
  try {
    await g.submit(g.engineWith(async (input) => {
      try {
        await input.launch({ model: 'claude-opus-4-5', maxBudgetUsd: 1, reservationId: 'r1' });
      } catch {
        return { launched: false, reasonCode: 'LAUNCH_FAILED' };
      }
      return { launched: true };
    }));
    await drainBackgroundWorkers();
    assert.equal(workerRuns(g.ws, 'T1').at(-1).requestedModel, 'claude-sonnet-4-5', 'never a model outside the task\'s list');
  } finally {
    g.done();
  }
});

test('in observe mode nothing launches: the router records its counterfactual and the task stays queued (US03)', async () => {
  const f = await routedFixture('observe');
  try {
    const plan = await f.submit(f.engineWith(async (input) => {
      await assert.rejects(input.launch({ model: 'claude-haiku-4-5', maxBudgetUsd: 1, reservationId: 'r' }));
      return { launched: false, reasonCode: 'OBSERVE_MODE' };
    }));
    assert.equal(plan.body.leaseIds.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].mode, 'observe');
    assert.equal(workerRuns(f.ws, 'T1').length, 0);
    assert.ok(f.traces.some((e) => e.event === 'orchestrator.route-counterfactual' && e.reasonCode === 'OBSERVE_MODE'));
  } finally {
    f.done();
  }
});

test('the owned worker prompt carries the rehydrated capsule, mandatory items first and bounded (W03)', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    await declare(f.ws, null, { objective: 'Refactor the parser across modules', constraints: ['C4: keep the public parse() signature'] });
    await writeCapsule(f.ws, { taskId: null });
    const prompts = [];
    setTaskOpDeps({
      workerPort: async () => ({
        async run(input) {
          prompts.push(input.prompt);
          return { status: 'completed', reason: 'success', sessionId: 's', requestedModel: input.model, actualModel: input.model, costUsd: null, usage: null, turns: 1, durationMs: 1 };
        },
      }),
    });
    await f.submit(undefined);
    await drainBackgroundWorkers();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /C4: keep the public parse\(\) signature/);
    assert.match(prompts[0], /advice only/);
    assert.ok(prompts[0].length < 6_000);
  } finally {
    f.done();
  }
});

test('approvedScopeFor: the leased task\'s write scopes are the approved paths; a session maps through its owned-session record; none is invented; only a linked session switches a turn (INT-05, OD-8, 29423b6)', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    assert.equal(approvedScopeFor(f.ws, null), null, 'no active task, no approved scope');
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(join(f.ws.home, '..'), [{ writes: [], status: 'completed', waitForFile: join(f.ws.home, '..', 'go') }]) };
    setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, f.ws.home) });
    await f.submit(undefined);
    // Read the scope once T1's session is running, however long setup took (bounded poll).
    for (let i = 0; i < 1_200 && !ownedSessions(f.ws).some((o) => o.taskId === 'T1' && o.state === 'running'); i += 1) await new Promise((r) => setTimeout(r, 25));
    const scope = approvedScopeFor(f.ws, null);
    assert.deepEqual([scope.taskId, scope.paths, scope.effects], ['T1', ['mod'], []]);
    // OD-8: the task's risk and D's per-turn switch gate. No harness named: advice only.
    assert.equal(scope.risk, 'low');
    assert.deepEqual([scope.turnActuation, scope.turnReasonCode], ['advise', 'HARNESS_ADVICE_ONLY']);
    const all = { harness: 'opencode', killSwitchStopped: false, turnCertified: true };
    // Owner decision 29423b6: an unlinked session with one active low-risk task gets that task's
    // scope for advice, never a turn switch, whatever else holds.
    for (const unlinked of [null, 'kilo-interactive-1']) {
      const advice = approvedScopeFor(f.ws, unlinked, all);
      assert.deepEqual([advice.taskId, advice.paths, advice.risk, advice.turnActuation, advice.turnReasonCode], ['T1', ['mod'], 'low', 'advise', 'SESSION_NOT_LINKED'], `unlinked session ${unlinked}`);
    }
    // The session started for the task is linked: the port reports its session id at start
    // (onSessionId, F 5bb12a6) and the runner binds it to the running owned session, so the
    // session's own hook events find the task while the run is live (bounded poll).
    let running;
    for (let i = 0; i < 1_200; i += 1) {
      running = ownedSessions(f.ws).find((o) => o.taskId === 'T1' && o.state === 'running');
      if (running?.sessionId) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const linked = running.sessionId;
    assert.match(linked, /^scripted-/, 'the reported session id is bound while the run is live');
    assert.deepEqual([approvedScopeFor(f.ws, linked, all).turnActuation, approvedScopeFor(f.ws, linked, all).turnReasonCode], ['bounded-auto', null], 'the default mode switches a low-risk turn of a linked session on a certified Kilo or OpenCode');
    assert.equal(approvedScopeFor(f.ws, linked, { ...all, harness: 'kilocode' }).turnActuation, 'bounded-auto');
    // B's session link (`jevris route --task T1 --link`): a recorded Kilo session linked to the
    // running task switches on Kilo; the same session id reported by another harness does not.
    const atMs = Date.now();
    assert.equal(recordSession(f.ws.store, { sessionId: 'kilo-term-1', harness: 'kilocode', state: 'active', atMs }).ok, true);
    assert.equal(linkSession(f.ws.store, { sessionId: 'kilo-term-1', harness: 'kilocode', taskId: 'T1', via: 'route', actor: 'tester', channel: 'terminal', atMs }).ok, true);
    const viaLink = (harness) => approvedScopeFor(f.ws, 'kilo-term-1', { ...all, harness });
    assert.deepEqual([viaLink('kilocode').taskId, viaLink('kilocode').turnActuation, viaLink('kilocode').turnReasonCode], ['T1', 'bounded-auto', null]);
    assert.deepEqual([viaLink('opencode').turnActuation, viaLink('opencode').turnReasonCode], ['advise', 'SESSION_NOT_LINKED']);
    assert.equal(approvedScopeFor(f.ws, 'kilo-term-1', { ...all, harness: null }).turnReasonCode, 'HARNESS_ADVICE_ONLY');
    const reasonWith = (options) => approvedScopeFor(f.ws, linked, { ...all, ...options }).turnReasonCode;
    assert.deepEqual(
      [reasonWith({ harness: 'claude' }), reasonWith({ harness: 'codex' }), reasonWith({ killSwitchStopped: true }), reasonWith({ killSwitchStopped: undefined }), reasonWith({ turnCertified: false })],
      ['HARNESS_ADVICE_ONLY', 'HARNESS_ADVICE_ONLY', 'KILL_SWITCH', 'KILL_SWITCH', 'TURN_ROUTE_UNCERTIFIED'],
    );
    // `jevris configure set routing.mainSession advice-only` turns it off.
    assert.deepEqual((await setConfigValue({ home: f.ws.home, key: 'routing.mainSession', value: 'advice-only', dryRun: false, sourceEgress: async () => 'not-approved' })).changed, [{ key: 'routing.mainSession', from: 'plugin-bounded-auto', to: 'advice-only' }]);
    assert.equal(reasonWith({}), 'MAIN_SESSION_ADVICE_ONLY');
    // An administrator's value is refused by configure with its reason; the setting is unchanged.
    const admin = await setConfigValue({ home: f.ws.home, key: 'routing.mainSession', value: 'owned-sdk-approved', dryRun: false, sourceEgress: async () => 'not-approved' });
    assert.deepEqual([admin.ok, admin.message], [false, ADMIN_VALUES['routing.mainSession'].message]);
    // Raising it back needs a person at a terminal (SR-19): refused without, written with.
    assert.equal((await setConfigValue({ home: f.ws.home, key: 'routing.mainSession', value: 'plugin-bounded-auto', dryRun: false, sourceEgress: async () => 'not-approved' })).reasonCode, 'CHANNEL_REFUSED');
    assert.equal(reasonWith({}), 'MAIN_SESSION_ADVICE_ONLY');
    assert.deepEqual((await setConfigValue({ home: f.ws.home, key: 'routing.mainSession', value: 'plugin-bounded-auto', dryRun: false, confirmed: true, sourceEgress: async () => 'not-approved' })).changed, [{ key: 'routing.mainSession', from: 'advice-only', to: 'plugin-bounded-auto' }]);
    assert.equal(reasonWith({}), null);
    // An open budget exhaustion in the workspace keeps turns advice only.
    await f.ws.state.transact((tx) => tx.put('budget-exhaustions', 'b-x', { workspaceId: f.ws.workspaceId, open: true }));
    assert.equal(reasonWith({}), 'BUDGET_EXHAUSTED');
    // Tiered routing, step 2b (2026-10-08): the gate for a turn the tier rule moves UP leaves out only the low-risk condition.
    assert.equal(reasonWith({ ignoreRisk: true }), 'BUDGET_EXHAUSTED', 'the budget still holds');
    await f.ws.state.transact((tx) => tx.delete('budget-exhaustions', 'b-x'));
    assert.equal(reasonWith({ ignoreRisk: true }), null, 'a linked session on a certified Kilo or OpenCode');
    assert.equal(approvedScopeFor(f.ws, 'kilo-interactive-1', { ...all, ignoreRisk: true }).turnReasonCode, 'SESSION_NOT_LINKED', 'the link is still required');
    assert.equal(reasonWith({ ignoreRisk: true, turnCertified: false }), 'TURN_ROUTE_UNCERTIFIED');
    assert.equal(reasonWith({ ignoreRisk: true, killSwitchStopped: true }), 'KILL_SWITCH');
    // The tier signals of the task: counts and codes, no title and no path.
    const signals = turnTierSignals(f.ws, 'T1');
    assert.deepEqual([signals.sliceId, signals.files, signals.checks, signals.risk], ['bounded-edit', 1, 1, 'low']);
    assert.equal(JSON.stringify(signals).includes('mod'), false, 'no path name');
    assert.equal(turnTierSignals(f.ws, 'nope'), null);
    writeFileSync(join(f.ws.home, '..', 'go'), '');
    await drainBackgroundWorkers();
    const session = ownedSessions(f.ws).find((s) => s.taskId === 'T1');
    assert.deepEqual(approvedScopeFor(f.ws, session.sessionId)?.paths, ['mod'], 'the owned session maps to its task');
    assert.equal(approvedScopeFor(f.ws, 'someone-else'), null);
    // A link to a task that is no longer leased or running links nothing.
    assert.equal(approvedScopeFor(f.ws, 'kilo-term-1', { ...all, harness: 'kilocode' }), null);
  } finally {
    f.done();
  }
});

test('mainSessionView: the per-harness half of the turn gate, pure, for status (E\'s mainSessions); the same reason codes and order as the turn gate', () => {
  const on = { certified: true, killSwitchStopped: false };
  const view = (mode, harness, facts = on) => Object.values(mainSessionView(mode, harness, facts));
  assert.deepEqual(view('plugin-bounded-auto', 'kilocode'), ['plugin-bounded-auto', 'possible', null]);
  assert.deepEqual(view('plugin-bounded-auto', 'opencode', { certified: false, killSwitchStopped: false }), ['plugin-bounded-auto', 'advice-only', 'TURN_ROUTE_UNCERTIFIED']);
  assert.deepEqual(view('plugin-bounded-auto', 'opencode', { certified: true, killSwitchStopped: true }), ['plugin-bounded-auto', 'advice-only', 'KILL_SWITCH']);
  assert.deepEqual(view('plugin-bounded-auto', 'opencode', { certified: true, killSwitchStopped: undefined }), ['plugin-bounded-auto', 'advice-only', 'KILL_SWITCH'], 'an unknown kill switch is not clear');
  assert.deepEqual(view('advice-only', 'kilocode'), ['advice-only', 'advice-only', 'MAIN_SESSION_ADVICE_ONLY']);
  for (const harness of ['claude', 'codex', 'antigravity', '']) assert.deepEqual(view('plugin-bounded-auto', harness), ['advice-only', 'advice-only', 'HARNESS_ADVICE_ONLY'], harness);
  // owned-sdk-approved is Claude's (an administrator's value): Claude shows it; its turns are not switched here.
  assert.deepEqual(view('owned-sdk-approved', 'claude'), ['owned-sdk-approved', 'advice-only', 'MAIN_SESSION_ADVICE_ONLY']);
  assert.deepEqual(view('owned-sdk-approved', 'kilocode'), ['advice-only', 'advice-only', 'MAIN_SESSION_ADVICE_ONLY']);
  assert.deepEqual(view('something-else', 'kilocode'), ['advice-only', 'advice-only', 'CONFIG_UNREADABLE']);
});

/** Starts T1 on a scripted OpenCode worker that waits, and returns its bound owned session and its worktree's workspace. */
test('hostRouteCertified: a route through a serving host needs F\'s route.host case for the installed version (serving hosts R50); turnRouteCertified reads session.route; neither applies off Kilo and OpenCode', async () => {
  const cert = (harness, features) => ({
    id: `cert-${harness}`,
    schemaVersion: '1.0',
    harness,
    actuatorId: 'route',
    harnessVersionRange: { minimum: '1.18.0', maximumExclusive: '2.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'],
    models: [],
    tools: [],
    limitations: [],
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: null })),
    certifiedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    signature: { algorithm: 'ed25519', keyId: 'k', value: 'AAAA' },
  });
  const home = tempDir('jevris-host-route-');
  const at = (harness, harnessVersion = '1.18.32') => ({ home, harness, nowMs: Date.parse('2026-09-28T00:00:00Z'), harnessVersion });
  assert.equal(HOST_ROUTE_FEATURE, 'route.host');
  setCertificationGate(certificationGateFrom(async () => [cert('opencode', ['session.route', 'route.host']), cert('kilocode', ['session.route'])], () => '1.18.32'));
  try {
    assert.deepEqual([await hostRouteCertified(at('opencode')), await turnRouteCertified(at('opencode'))], [true, true]);
    // Kilo passed session.route but not route.host: its turns may switch, never through a host.
    assert.deepEqual([await hostRouteCertified(at('kilocode')), await turnRouteCertified(at('kilocode'))], [false, true]);
    // Another version, or a harness whose main session is advice only, is never certified.
    assert.equal(await hostRouteCertified(at('opencode', '2.0.1')), false);
    assert.equal(await hostRouteCertified(at('claude', '2.1.0')), false);
  } finally {
    setCertificationGate(null);
  }
});

async function runningOpencodeWorker(f) {
  const go = join(f.ws.home, '..', 'go');
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(join(f.ws.home, '..'), [{ writes: [], status: 'completed', harness: 'opencode', waitForFile: go }]) };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, f.ws.home) });
  await f.submit(undefined);
  let running;
  for (let i = 0; i < 1_200; i += 1) {
    running = ownedSessions(f.ws).find((o) => o.taskId === 'T1' && o.state === 'running' && o.sessionId !== null && o.harness !== undefined);
    if (running !== undefined) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(running, 'the owned session was bound with its harness');
  const tree = listWorktrees(f.ws).find((w) => w.id === running.worktreeId);
  // The worker's hook events come from its worktree, which the sidecar resolves as a workspace of its own.
  const wt = openWorkspace({ home: f.ws.home, workspaceRoot: tree.path, env: { HOME: f.ws.home }, store: f.store });
  assert.notEqual(wt.workspaceId, f.ws.workspaceId);
  // Another reader sees the binding once its commit is on disk (bounded poll).
  for (let i = 0; i < 1_200 && !wt.host.list('owned-sessions').some((o) => o.sessionId === running.sessionId); i += 1) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
  return { running, wt, finish: async () => { writeFileSync(go, ''); await drainBackgroundWorkers(); } };
}

test('owner decision 29423b6: an owned worker\'s OpenCode session, seen from its own worktree, is linked to its task: by its owned-session record, and in B\'s store via plan on its first event', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    const { running, wt, finish } = await runningOpencodeWorker(f);
    const sessionId = running.sessionId;
    assert.equal(running.harness, 'opencode');
    const all = { harness: 'opencode', killSwitchStopped: false, turnCertified: true };
    const scope = approvedScopeFor(wt, sessionId, all);
    assert.deepEqual([scope.taskId, scope.paths, scope.turnActuation, scope.turnReasonCode], ['T1', ['mod'], 'bounded-auto', null], 'the worktree event reads as the task\'s workspace');
    assert.equal(approvedScopeFor(wt, 'someone-else', all), null, 'another session in the worktree is not linked');
    const event = (harness, agentId = null) => linkPlannedSession(wt, { harness, sessionId, agentId }, Date.now());
    assert.equal(event('opencode', 'child-1'), null, 'a child session makes no plan link');
    assert.equal(event('kilocode'), null, 'another harness makes no plan link');
    // Before the sidecar has recorded the session, the link waits for its next event.
    assert.equal(event('opencode'), 'UNKNOWN_SESSION');
    assert.equal(recordSession(wt.store, { sessionId, harness: 'opencode', state: 'active', atMs: Date.now() }).ok, true);
    assert.equal(event('opencode'), 'LINKED');
    assert.equal(event('opencode'), null, 'made once');
    const link = sessionLinkFor(wt.store, sessionId);
    assert.deepEqual([link.taskId, link.harness, link.via], ['T1', 'opencode', 'plan']);
    const audit = readAudit(f.store, { kinds: ['session.link'] }).map((row) => [row.actor, row.channel, row.detail.task, row.detail.via]);
    assert.deepEqual(audit, [['sidecar', 'sidecar', 'T1', 'plan']]);
    await finish();
    // The task is no longer running: neither its owned session nor its link switches a turn.
    assert.deepEqual([approvedScopeFor(wt, sessionId, all).taskId, approvedScopeFor(wt, sessionId, all).turnActuation, approvedScopeFor(wt, sessionId, all).turnReasonCode], ['T1', 'advise', 'SESSION_NOT_LINKED']);
  } finally {
    f.done();
  }
});

test('owner decision 29423b6: a plan link never replaces a person\'s link', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    const { running, wt, finish } = await runningOpencodeWorker(f);
    const sessionId = running.sessionId;
    const atMs = Date.now();
    assert.equal(recordSession(wt.store, { sessionId, harness: 'opencode', state: 'active', atMs }).ok, true);
    assert.equal(linkSession(wt.store, { sessionId, harness: 'opencode', taskId: 'T9', via: 'route', actor: 'tester', channel: 'terminal', atMs }).ok, true);
    assert.equal(linkPlannedSession(wt, { harness: 'opencode', sessionId, agentId: null }, Date.now()), 'LINKED_BY_PERSON');
    assert.deepEqual([sessionLinkFor(wt.store, sessionId).taskId, sessionLinkFor(wt.store, sessionId).via], ['T9', 'route']);
    await finish();
  } finally {
    f.done();
  }
});

test('owner decision 29423b6: no plan link is made once the owned run has ended', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    const { running, wt, finish } = await runningOpencodeWorker(f);
    const sessionId = running.sessionId;
    assert.equal(recordSession(wt.store, { sessionId, harness: 'opencode', state: 'active', atMs: Date.now() }).ok, true);
    await finish();
    assert.equal(linkPlannedSession(wt, { harness: 'opencode', sessionId, agentId: null }, Date.now()), null, 'the ended run left no plan link waiting');
    assert.equal(sessionLinkFor(wt.store, sessionId), undefined);
  } finally {
    f.done();
  }
});

test('status sees a worker link: ownedWorktreeWorkspaces names each in-use worktree of this workspace with the id its hook events arrive under, only inside the worktree directory and only for a task here (B\'s status op)', async () => {
  const f = await routedFixture('bounded-auto');
  try {
    const { running, wt, finish } = await runningOpencodeWorker(f);
    assert.equal(OWNED_WORKTREE_WORKSPACES_MAX, 16);
    const base = dirname(listWorktrees(f.ws).find((w) => w.id === running.worktreeId).path);
    const row = (id, taskId, path, state = 'active') => ({ id, workspaceId: f.ws.workspaceId, taskId, path, branch: `b-${id}`, baseCommit: 'x', allowedPaths: [], resourceKeys: [], port: 0, owner: running.holder, state, createdAtMs: Date.now() + 1000, note: null });
    const outside = tempDir('jevris-wt-outside-');
    const unknownTask = join(base, 'wt-unknown-task');
    mkdirSync(unknownTask, { recursive: true });
    const removed = join(base, 'wt-removed');
    mkdirSync(removed, { recursive: true });
    const linked = join(base, 'wt-link');
    let symlinked = true;
    try {
      symlinkSync(outside, linked, 'junction');
    } catch {
      symlinked = false; // Windows without the right to make a link: the outside-path row still covers the rule.
    }
    await f.ws.host.transact((tx) => {
      tx.put('worktrees', 'wt-outside', row('wt-outside', 'T1', outside));
      tx.put('worktrees', 'wt-unknown-task', row('wt-unknown-task', 'NOPE', unknownTask));
      tx.put('worktrees', 'wt-removed', row('wt-removed', 'T1', removed, 'removed'));
      tx.put('worktrees', 'wt-gone', row('wt-gone', 'T1', join(base, 'wt-gone')));
      if (symlinked) tx.put('worktrees', 'wt-link', row('wt-link', 'T1', linked));
    });
    const seen = ownedWorktreeWorkspaces(f.ws);
    assert.deepEqual(seen, [{ worktreeId: running.worktreeId, taskId: 'T1', workspaceId: wt.workspaceId }], 'only the real worker worktree, under the id its events use');
    // Another workspace (the worktree itself) has no owned worktrees of its own.
    assert.deepEqual(ownedWorktreeWorkspaces(wt), []);
    // The plan link lands under that id, where status reads it.
    assert.equal(recordSession(wt.store, { sessionId: running.sessionId, harness: 'opencode', state: 'active', atMs: Date.now() }).ok, true);
    assert.equal(linkPlannedSession(wt, { harness: 'opencode', sessionId: running.sessionId, agentId: null }, Date.now()), 'LINKED');
    assert.equal(sessionLinkFor(wt.store, running.sessionId)?.taskId, 'T1');
    // B's read: the view of the id ownedWorktreeWorkspaces names holds the worker's link; the parent's view does not.
    assert.deepEqual(listSessionLinks(workspaceView(f.store, seen[0].workspaceId)).map((l) => [l.sessionId, l.taskId, l.via]), [[running.sessionId, 'T1', 'plan']]);
    assert.deepEqual(listSessionLinks(workspaceView(f.store, f.ws.workspaceId)), []);
    await finish();
  } finally {
    f.done();
  }
});

test('a scripted run records its prompt with promptTo, only beside the script', async () => {
  const dir = tempDir('jv-tw-');
  try {
    const cwd = join(dir, 'wt');
    mkdirSync(cwd, { recursive: true });
    const home = join(dir, 'home');
    markHome(home);
    const record = join(dir, 'prompt.txt');
    const path = script(dir, [{ writes: [], status: 'completed', promptTo: record }]);
    const port = scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: path }, home);
    const input = { prompt: 'task head\ncapsule text', model: 'claude-sonnet-4-5', cwd, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
    assert.equal((await port.run(input)).status, 'completed');
    assert.equal(readFileSync(record, 'utf8'), 'task head\ncapsule text');
    for (const elsewhere of [join(cwd, 'prompt.txt'), join(dir, '..', 'prompt.txt'), 'prompt.txt']) {
      const bad = script(dir, [{ writes: [], status: 'completed', promptTo: elsewhere }]);
      assert.equal(scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: bad }, home), null, `refused: ${elsewhere}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the owned-worker port picks the harness by model and the worker by auth mode: a subscription runs only the harness CLI, a key may run the Agent SDK; each run records its auth mode', async () => {
  const seen = [];
  const stub = (name, extra = {}) => async () => ({ run: async (input) => { seen.push(`${name}:${input.model}:${input.auth ?? '-'}`); return { status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0, ...extra }; } });
  const input = { prompt: 'p', model: 'gpt-5-codex', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const keyEnv = { ANTHROPIC_API_KEY: 'k-not-real', OPENAI_API_KEY: 'k-not-real' };
  const all = { sdk: stub('sdk'), codex: stub('codex'), claude: stub('claude') };
  // auto with keys: the SDK for Claude, Codex in api-key mode.
  const withKeys = await loadWorkerPort(all, { env: keyEnv });
  const r1 = await withKeys.run(input);
  const r2 = await withKeys.run({ ...input, model: 'claude-sonnet-4-5' });
  await withKeys.run({ ...input, model: 'o3' });
  assert.deepEqual(seen.splice(0), ['codex:gpt-5-codex:api-key', 'sdk:claude-sonnet-4-5:-', 'codex:o3:api-key']);
  assert.deepEqual([r1.authMode, r2.authMode], ['api-key', 'api-key']);
  // auto without keys: a subscription login runs only the harness CLIs, never the SDK.
  const noKeys = await loadWorkerPort(all, { env: {} });
  const sub = await noKeys.run({ ...input, model: 'claude-sonnet-4-5' });
  await noKeys.run(input);
  assert.deepEqual(seen.splice(0), ['claude:claude-sonnet-4-5:subscription', 'codex:gpt-5-codex:subscription']);
  assert.equal(sub.authMode, 'subscription');
  // A subscription with no Claude CLI worker is unsupported, even though the SDK is installed.
  const noCli = await loadWorkerPort({ sdk: stub('sdk'), codex: stub('codex'), claude: async () => null }, { env: {} });
  const missingCli = await noCli.run({ ...input, model: 'claude-sonnet-4-5' });
  assert.deepEqual([missingCli.status, missingCli.reason, missingCli.authMode], ['unsupported', CLAUDE_CLI_PORT_MISSING, 'subscription']);
  assert.deepEqual(seen.splice(0), []);
  // With a key and no SDK, the CLI worker runs with the key.
  const cliKey = await loadWorkerPort({ sdk: async () => null, codex: async () => null, claude: stub('claude') }, { env: keyEnv });
  assert.equal((await cliKey.run({ ...input, model: 'claude-haiku-4-5' })).authMode, 'api-key');
  assert.deepEqual(seen.splice(0), ['claude:claude-haiku-4-5:api-key']);
  // A declared mode wins over detection; a port that reports what actually ran is recorded as such.
  const dir = tempDir('jv-auth-');
  try {
    writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { claude: 'subscription', codex: 'api-key' } }));
    const declared = await loadWorkerPort({ ...all, claude: stub('claude', { authMode: 'unknown' }) }, { configDir: dir, env: keyEnv });
    assert.equal((await declared.run({ ...input, model: 'claude-sonnet-4-5' })).authMode, 'subscription');
    await declared.run(input);
    assert.deepEqual(seen.splice(0), ['claude:claude-sonnet-4-5:subscription', 'codex:gpt-5-codex:api-key']);
    writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { claude: 'sometimes' } }));
    const bad = await declared.run({ ...input, model: 'claude-sonnet-4-5' });
    assert.equal(bad.status, 'refused');
    assert.deepEqual(seen.splice(0), [], 'unusable settings run nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Codex missing never blocks Claude, and the reverse.
  const noCodex = await loadWorkerPort({ ...all, codex: async () => null }, { env: keyEnv });
  const missing = await noCodex.run(input);
  assert.deepEqual([missing.status, missing.costUsd], ['unsupported', null]);
  assert.ok(missing.reason.includes(CODEX_PORT_MISSING.replace(/^unsupported: /, '')), missing.reason);
  assert.equal((await noCodex.run({ ...input, model: 'claude-haiku-4-5' })).status, 'completed');
  assert.equal(await loadWorkerPort({ sdk: async () => null, codex: async () => null, claude: async () => null }), null);
});

test('an owned worker on an xAI model runs on the harness own SuperGrok login or on XAI_API_KEY: a subscription run never sees the key, api-key mode needs it, and a 403 or 401 is named (DOMAINS 72ff950)', async () => {
  const { workerProvider, ownedWorkerAuth, providerEnv, xaiAuthFailure, OPENCODE_PORT_MISSING, KILO_PORT_MISSING, PROVIDER_KEY_VARS } = await import('../dist/index.js');
  assert.deepEqual(['grok-4.7', 'xai/grok-4.6-fast', 'x-ai/grok-code', 'GROK-4', 'gpt-5-codex', 'openai/o3', 'claude-sonnet-4-5', 'sonnet[1m]'].map((m) => workerProvider(m)), ['xai', 'xai', 'xai', 'xai', 'openai', 'openai', 'anthropic', 'anthropic']);
  // R5: an id no family or registry names has no provider (refused, never run on Claude).
  assert.deepEqual(['groking-model', 'zai/glm-5.3', 'kimi-k3'].map((m) => workerProvider(m)), [null, null, null]);
  assert.deepEqual(PROVIDER_KEY_VARS.xai, ['XAI_API_KEY']);
  const key = { XAI_API_KEY: 'xai-not-real' };
  // The rule: a declared subscription runs on the harness login, api-key needs the key, auto follows the key.
  assert.deepEqual(ownedWorkerAuth('xai', 'subscription', undefined, {}), { ok: true, mode: 'subscription' });
  assert.deepEqual(ownedWorkerAuth('xai', 'subscription', 'subscription', key), { ok: true, mode: 'subscription' }, 'a declared subscription stays a subscription even with a key');
  assert.equal(ownedWorkerAuth('xai', 'api-key', 'api-key', {}).reasonCode, 'XAI_API_KEY_MISSING');
  assert.deepEqual(ownedWorkerAuth('xai', 'subscription', 'auto', key), { ok: true, mode: 'api-key' });
  assert.deepEqual(ownedWorkerAuth('anthropic', 'subscription', undefined, {}), { ok: true, mode: 'subscription' }, 'other providers keep their harness rule');
  // The environment: a subscription run carries no provider key; a key run keeps it.
  const both = { XAI_API_KEY: 'xai-not-real', PATH: '/bin' };
  assert.deepEqual(providerEnv('xai', 'subscription', both), { PATH: '/bin' });
  assert.deepEqual(providerEnv('xai', 'api-key', both), both);
  // Naming: 403 or a plan refusal, 401 or no login; anything else is not an auth failure.
  assert.equal(xaiAuthFailure('provider error: HTTP 403 Forbidden'), 'XAI_PLAN_NOT_ELIGIBLE');
  assert.equal(xaiAuthFailure('this model is not included in your plan'), 'XAI_PLAN_NOT_ELIGIBLE');
  assert.equal(xaiAuthFailure('HTTP 401 Unauthorized'), 'XAI_AUTH_FAILED');
  assert.equal(xaiAuthFailure('refused: not signed in to xai; run opencode auth login'), 'XAI_AUTH_FAILED');
  assert.equal(xaiAuthFailure('the tests failed'), null);

  const seen = [];
  let answer = { status: 'completed', reason: 'ok' };
  const stub = (name) => async () => ({
    run: async (input) => (seen.push({ name, auth: input.auth, keys: Object.keys(input.env ?? {}).filter((k) => k.endsWith('_API_KEY')).sort() }), { ...answer, sessionId: null, requestedModel: input.model, actualModel: input.model, costUsd: null, usage: null, turns: 0, durationMs: 0 }),
  });
  const input = { prompt: 'p', model: 'grok-4.7', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const env = { ANTHROPIC_API_KEY: 'k-not-real', OPENAI_API_KEY: 'k-not-real' };
  const dir = tempDir('jv-xai-');
  try {
    // Every xAI-capable harness, in every auth mode.
    for (const harness of ['opencode', 'kilo']) {
      const all = { sdk: stub('sdk'), claude: stub('claude'), codex: stub('codex'), opencode: stub('opencode'), kilo: stub('kilo'), antigravity: stub('antigravity') };
      for (const [setting, runEnv, mode] of [['subscription', { ...env, ...key }, 'subscription'], ['auto', env, 'subscription'], ['auto', { ...env, ...key }, 'api-key'], ['api-key', { ...env, ...key }, 'api-key']]) {
        writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { [harness]: setting }, harness: { xai: harness } }));
        const out = await (await loadWorkerPort(all, { configDir: dir, env: runEnv })).run(input);
        assert.deepEqual([out.status, out.authMode, out.harness], ['completed', mode, harness], `${harness} ${setting}`);
        const run = seen.pop();
        assert.deepEqual([run.name, run.auth], [harness, mode]);
        if (mode === 'subscription') assert.ok(!run.keys.includes('XAI_API_KEY'), 'a subscription run never sees XAI_API_KEY');
        else assert.ok(run.keys.includes('XAI_API_KEY'), 'a key run has its key');
      }
      writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { [harness]: 'api-key' }, harness: { xai: harness } }));
      const keyless = await (await loadWorkerPort(all, { configDir: dir, env })).run(input);
      assert.deepEqual([keyless.status, keyless.authMode], ['refused', 'api-key']);
      assert.match(keyless.reason, /^XAI_API_KEY_MISSING/);
      // A harness's 403 and 401 come back named.
      writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', harness: { xai: harness } }));
      answer = { status: 'failed', reason: 'xai: HTTP 403 Forbidden' };
      const plan = await (await loadWorkerPort(all, { configDir: dir, env })).run(input);
      assert.deepEqual([plan.status, plan.authMode], ['refused', 'subscription']);
      assert.match(plan.reason, new RegExp(`^XAI_PLAN_NOT_ELIGIBLE: ${harness} was refused by xAI \\(HTTP 403\\).*unconfirmed`));
      answer = { status: 'refused', reason: 'refused: not signed in to xai' };
      assert.match((await (await loadWorkerPort(all, { configDir: dir, env })).run(input)).reason, /^XAI_AUTH_FAILED: /);
      answer = { status: 'failed', reason: 'the tests failed' };
      assert.equal((await (await loadWorkerPort(all, { configDir: dir, env })).run(input)).reason, 'the tests failed', 'other failures keep their reason');
      answer = { status: 'completed', reason: 'ok' };
      seen.splice(0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Without an OpenCode or Kilo worker, the run says which to install; nothing else starts.
  const bare = { sdk: stub('sdk'), codex: stub('codex'), claude: stub('claude'), opencode: async () => null, kilo: async () => null, antigravity: async () => null };
  const missing = await (await loadWorkerPort(bare, { env })).run({ ...input, model: 'xai/grok-4.6-fast' });
  assert.deepEqual([missing.status, missing.authMode], ['unsupported', 'subscription']);
  for (const hint of [OPENCODE_PORT_MISSING, KILO_PORT_MISSING]) assert.ok(missing.reason.includes(hint.replace(/^unsupported: /, '')), missing.reason);
  assert.deepEqual(seen, [], 'no other harness runs an xAI model');
  // A Claude model is unaffected by an xAI key.
  assert.equal((await (await loadWorkerPort(bare, { env: key })).run({ ...input, model: 'claude-sonnet-4-5' })).authMode, 'subscription');
});

test('the owned-worker port chooses the harness per task: workers.json prefers one per provider, else native first, then OpenCode, then Kilo; every harness runs in either auth mode through its own port', async () => {
  const { ANTHROPIC_LOGIN_THIRD_PARTY, ANTIGRAVITY_PORT_MISSING, KILO_PORT_MISSING, OPENCODE_PORT_MISSING, readWorkerAuthSettings } = await import('../dist/index.js');
  const seen = [];
  const stub = (name) => async () => ({ run: async (input) => (seen.push(`${name}:${input.model}:${input.auth ?? '-'}`), { status: 'completed', reason: 'ok', sessionId: null, requestedModel: input.model, actualModel: input.model, costUsd: null, usage: null, turns: 0, durationMs: 0 }) });
  const all = { sdk: stub('sdk'), claude: stub('claude'), codex: stub('codex'), opencode: stub('opencode'), kilo: stub('kilo'), antigravity: stub('antigravity') };
  const input = { prompt: 'p', model: 'claude-sonnet-4-5', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const keys = { ANTHROPIC_API_KEY: 'k-not-real', OPENAI_API_KEY: 'k-not-real', GEMINI_API_KEY: 'k-not-real', XAI_API_KEY: 'k-not-real' };
  const dir = tempDir('jv-harness-');
  const settings = (body) => writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', ...body }));
  try {
    // Native harness first, in each auth mode.
    for (const [env, mode] of [[{}, 'subscription'], [keys, 'api-key']]) {
      const port = await loadWorkerPort(all, { env });
      for (const model of ['claude-sonnet-4-5', 'gpt-5-codex', 'gemini-3-pro', 'grok-4.7']) {
        const out = await port.run({ ...input, model });
        // Antigravity has only its Google sign-in: `auto` is its subscription even with a Gemini key.
        assert.equal(out.authMode, model === 'gemini-3-pro' ? 'subscription' : mode, model);
      }
    }
    assert.deepEqual(seen.splice(0), [
      'claude:claude-sonnet-4-5:subscription', 'codex:gpt-5-codex:subscription', 'antigravity:gemini-3-pro:subscription', 'opencode:grok-4.7:subscription',
      'sdk:claude-sonnet-4-5:-', 'codex:gpt-5-codex:api-key', 'antigravity:gemini-3-pro:subscription', 'opencode:grok-4.7:api-key',
    ]);
    // A declared preference per provider, in each declared auth mode.
    for (const harness of ['opencode', 'kilo']) {
      for (const mode of ['api-key', 'subscription']) {
        settings({ auth: { [harness]: mode }, harness: { openai: harness, google: harness, anthropic: harness } });
        const port = await loadWorkerPort(all, { configDir: dir, env: keys });
        await port.run({ ...input, model: 'gpt-5' });
        await port.run({ ...input, model: 'gemini-3-pro' });
        const anthropic = await port.run(input);
        if (mode === 'subscription') assert.match(anthropic.reason, new RegExp(`^${ANTHROPIC_LOGIN_THIRD_PARTY}`), 'a claude.ai login never runs in a third-party harness');
        assert.equal(anthropic.harness ?? harness, harness);
      }
    }
    assert.deepEqual(seen.splice(0), [
      'opencode:gpt-5:api-key', 'opencode:gemini-3-pro:api-key', 'opencode:claude-sonnet-4-5:api-key',
      'opencode:gpt-5:subscription', 'opencode:gemini-3-pro:subscription',
      'kilo:gpt-5:api-key', 'kilo:gemini-3-pro:api-key', 'kilo:claude-sonnet-4-5:api-key',
      'kilo:gpt-5:subscription', 'kilo:gemini-3-pro:subscription',
    ]);
    // xAI with a key: Kilo when it is preferred, else whichever of OpenCode or Kilo is installed.
    settings({ harness: { xai: 'kilo' } });
    assert.equal((await (await loadWorkerPort(all, { configDir: dir, env: keys })).run({ ...input, model: 'grok-4.7' })).harness, 'kilo');
    assert.equal((await (await loadWorkerPort({ ...all, opencode: async () => null }, { env: keys })).run({ ...input, model: 'xai/grok-4.6-fast' })).harness, 'kilo');
    seen.splice(0);
    // A missing preferred harness says to install it; nothing else starts in its place.
    settings({ harness: { google: 'antigravity' } });
    const missing = await (await loadWorkerPort({ ...all, antigravity: async () => null }, { configDir: dir, env: keys })).run({ ...input, model: 'gemini-3-pro' });
    assert.deepEqual([missing.status, missing.reason], ['unsupported', ANTIGRAVITY_PORT_MISSING]);
    // A harness that is not usable here (not installed or not certified) is skipped.
    const skip = await (await loadWorkerPort(all, { env: keys, usable: (h) => h !== 'codex' })).run({ ...input, model: 'gpt-5' });
    assert.equal(skip.harness, 'opencode');
    const none = await (await loadWorkerPort(all, { env: keys, usable: () => false })).run({ ...input, model: 'gpt-5' });
    for (const hint of [OPENCODE_PORT_MISSING, KILO_PORT_MISSING]) assert.ok(none.reason.includes(hint.replace(/^unsupported: /, '')), none.reason);
    assert.deepEqual(seen.splice(0), ['opencode:gpt-5:api-key']);
    // Bad preferences are refused before any run.
    settings({ harness: { xai: 'claude' } });
    assert.equal(readWorkerAuthSettings(dir).ok, false);
    settings({ harness: { mistral: 'opencode' } });
    assert.equal(readWorkerAuthSettings(dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function escalationFixture(runs, models = ['claude-haiku-4-5', 'claude-sonnet-4-5']) {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, runs(dir)) };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  const traces = [];
  const ctx = (op, body) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine: null, trace: (e) => traces.push(e),
  });
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle(ctx(op, body));
  await call('plan.submit', {
    plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models }] },
    ownerId: 'alice',
    channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
  });
  await drainBackgroundWorkers();
  const recover = async () => {
    const out = await call('recover', { taskId: 'T1', signals: { fingerprints: Array(3).fill('E1 AssertionError mod/a.txt:1') }, rejectedApproaches: ['Tried reverting mod/a.txt'] });
    await drainBackgroundWorkers();
    return out.body;
  };
  return { dir, ws, traces, recover, done: () => {
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('a harness usage limit blocks the task with the reset time, is not a failure, and is never escalated (owner decision)', async () => {
  const f = await escalationFixture(() => [{ writes: [], status: 'usage-limit', reason: 'session limit reached (429)', resetAt: '2026-09-26T18:00:00.000Z' }]);
  try {
    const task = getTask(f.ws, 'T1');
    assert.equal(task.node.state, 'blocked');
    assert.match(task.stateReason, /harness usage limit reached; it resets at 2026-09-26T18:00:00.000Z/);
    const [run] = workerRuns(f.ws, 'T1');
    assert.deepEqual([run.status, run.resetAt], ['usage-limit', '2026-09-26T18:00:00.000Z']);
    const recovered = await f.recover();
    assert.doesNotMatch(recovered.advice ?? '', /stronger owned worker was launched/);
    assert.equal(workerRuns(f.ws, 'T1').length, 1, 'no escalation on a usage limit');
  } finally {
    f.done();
  }
});

test('W02: a failed owned task past its repair budget is relaunched once with the next stronger approved model and the compact history; a second failure ends blocked', async () => {
  const f = await escalationFixture((dir) => [
    { writes: [], status: 'failed', reason: 'AssertionError at mod/a.txt:1' },
    { writes: [], status: 'failed', reason: 'still failing', promptTo: join(dir, 'escalated-prompt.txt') },
  ]);
  try {
    assert.equal(getTask(f.ws, 'T1').node.state, 'failed');
    const first = await f.recover();
    assert.match(first.advice, /stronger owned worker was launched once/);
    assert.doesNotMatch(first.advice, /No worker was launched/);
    const runs = workerRuns(f.ws, 'T1');
    assert.deepEqual(runs.map((r) => r.requestedModel), ['claude-haiku-4-5', 'claude-sonnet-4-5'], 'the next approved model, never outside the list');
    const prompt = readFileSync(join(f.dir, 'escalated-prompt.txt'), 'utf8');
    assert.match(prompt, /Bounded escalation \(one attempt\) after claude-haiku-4-5 failed/);
    assert.match(prompt, /E1 AssertionError mod\/a\.txt:1/);
    assert.match(prompt, /Tried reverting mod\/a\.txt/);
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked', 'further failure ends blocked');
    assert.ok(f.traces.some((e) => e.event === 'orchestrator.worker-route' && e.reasonCode === 'ESCALATED'));
    const second = await f.recover();
    assert.match(second.advice, /Blocked report/);
    assert.equal(workerRuns(f.ws, 'T1').length, 2, 'one escalation only');
  } finally {
    f.done();
  }
});

test('W02: the escalated worker completes only from a new receipt, and a task on its strongest model is not relaunched', async () => {
  const f = await escalationFixture(() => [
    { writes: [], status: 'failed', reason: 'AssertionError at mod/a.txt:1' },
    { writes: [{ path: 'mod/a.txt', text: 'fixed\n' }], status: 'completed' },
  ]);
  try {
    await f.recover();
    const task = getTask(f.ws, 'T1');
    assert.equal(task.node.state, 'awaiting-evidence', 'a completed worker is not verified: it needs a new receipt');
    assert.deepEqual(workerRuns(f.ws, 'T1').map((r) => r.status), ['failed', 'completed']);
  } finally {
    f.done();
  }
  const g = await escalationFixture(() => [{ writes: [], status: 'failed', reason: 'boom' }], ['claude-sonnet-4-5']);
  try {
    // The only approved model already failed: nothing stronger to launch.
    const first = await g.recover();
    assert.match(first.advice, /No stronger approved model remains/);
    assert.equal(workerRuns(g.ws, 'T1').length, 1);
    assert.equal(getTask(g.ws, 'T1').node.state, 'failed');
    assert.match((await g.recover()).advice, /Blocked report/);
  } finally {
    g.done();
  }
});

test('W04: verifying a task starts its dependents (the next wave); a reconciled crash resumes too', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    const cfg = jevrisPaths({ home }).config;
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [{ path: 'mod/a.txt', text: 'a2\n' }], status: 'completed' }, { writes: [{ path: 'lock/package-lock.json', text: '{}\n' }], status: 'completed' }]) };
    setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
    const traces = [];
    const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: (e) => traces.push(e),
    });
    const plan = await call('plan.submit', {
      plan: { tasks: [
        { id: 'A', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] },
        { id: 'L', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['lock'], dependencyIds: ['A'], models: ['claude-sonnet-4-5'] },
      ] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    });
    assert.equal(plan.body.leaseIds.length, 1, 'only the first wave starts');
    await drainBackgroundWorkers();
    assert.notEqual(getTask(ws, 'L').node.state, 'leased');
    const v = await call('verify', { taskId: 'A', checkIds: [] });
    assert.equal(v.body.readiness, 'verified', JSON.stringify(v.body));
    await drainBackgroundWorkers();
    assert.equal(getTask(ws, 'L').node.state, 'awaiting-evidence', 'the dependent ran once A was verified');
    assert.ok(traces.some((e) => e.event === 'orchestrator.plan-continued'));
    assert.deepEqual(workerRuns(ws, 'L').map((r) => r.changedPaths), [['lock/package-lock.json']]);
  } finally {
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-keyed scripted runs go to their own task whatever order parallel workers start in; unkeyed runs serve any task', async () => {
  const dir = tempDir('jv-tw-');
  try {
    const home = join(dir, 'home');
    markHome(home);
    const path = script(dir, [
      { taskId: 'A', writes: [{ path: 'a.txt', text: 'A\n' }], status: 'completed' },
      { taskId: 'B', writes: [{ path: 'b.txt', text: 'B\n' }], status: 'completed' },
      { writes: [], status: 'failed', reason: 'any task' },
    ]);
    const port = scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: path }, home);
    const input = (taskId, cwd) => ({ taskId, prompt: 'p', model: 'claude-sonnet-4-5', cwd, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal });
    const wtB = join(dir, 'wtB');
    const wtA = join(dir, 'wtA');
    mkdirSync(wtB);
    mkdirSync(wtA);
    assert.equal((await port.run(input('B', wtB))).status, 'completed');
    assert.equal((await port.run(input('A', wtA))).status, 'completed');
    assert.equal(readFileSync(join(wtB, 'b.txt'), 'utf8'), 'B\n', 'B started first and still got its own run');
    assert.equal(readFileSync(join(wtA, 'a.txt'), 'utf8'), 'A\n');
    assert.equal((await port.run(input('C', wtA))).reason, 'any task');
    assert.equal((await port.run(input('A', wtA))).reason, 'any task', 'once used up, the last run the task can take repeats');
    const bad = script(dir, [{ taskId: '../x', writes: [], status: 'completed' }]);
    assert.equal(scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: bad }, home), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Owned workers are automatic from install; these tests schedule by hand, so they turn orchestration off. */
function workersNotAutomatic(home) {
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: false } }));
}

test('a worker killed with its process (a held effect and no run record) reconciles through its lease: the effect settles, the reservation counts in full, the task is ready (ORC-03, W04)', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  let holderDead = false;
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    // Workers are not automatic here, so nothing restarts the task after the reconcile.
    workersNotAutomatic(home);
    const ctx = (op, body) => ({
      op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
    });
    const plan = await sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx('plan.submit', {
      plan: { tasks: [{ id: 'C', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models: ['claude-sonnet-4-5'] }] },
      ownerId: 'alice',
      channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
    }));
    const base = leaseAuthorityFor(ws);
    const authority = { ...base, sweep: (id, now) => base.sweep(id, now, () => (holderDead ? 'dead' : 'alive')) };
    setTaskOpDeps({ authority: () => authority });
    assert.equal(plan.body.accepted, true, JSON.stringify(plan.body));
    const scheduled = await scheduleTasks(ws, { authority, holder: selfIdentity() });
    const [grant] = scheduled.leased;
    assert.ok(grant !== undefined, JSON.stringify(scheduled.skipped));
    // The worker began its owned effect, then its process was killed: no run record, and the
    // store's recovery holds the pending effect for a person.
    assert.equal(beginOwnedEffect(ws.store, { operationId: effectOperationId(grant.lease.id), kind: 'owned-worker', reservationMicroUsd: 10_000n, nowMs: Date.now() }).ok, true);
    holdPendingEffects(ws.store, { nowMs: Date.now(), actor: 'recovery', channel: 'cli' });
    holderDead = true;
    assert.deepEqual(heldTaskEffects(ws).map((e) => [e.taskId, e.leaseId]), [['C', grant.lease.id]], 'the held effect is found through its lease');
    const rec = await sidecarOps.find((o) => o.op === 'task.reconcile').handle(ctx('task.reconcile', { taskId: 'C', resolution: 'abandoned' }));
    assert.deepEqual([rec.body.reconciled, rec.body.reasonCode, rec.body.taskState, rec.body.held], [true, 'RECONCILED', 'ready', 0], JSON.stringify(rec.body));
    const rsv = ws.host.list('reservations').find((r) => r.leaseId === grant.lease.id);
    assert.equal(rsv.reservation.state, 'committed', 'the unknown spend counts in full');
  } finally {
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function budgetFixture(policy, { registry } = {}) {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  markHome(home);
  for (const d of ['a', 'b', 'c']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 3 } }));
  if (registry !== undefined) writeFileSync(join(cfg, 'model-registry.json'), JSON.stringify(registry));
  // Running workers wait until released; their vendor usage is unknown (no costUsd).
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script(dir, [{ writes: [], status: 'completed', waitForFile: join(dir, 'go') }]) };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  const traces = [];
  const call = (op, body, client = 'cli') => sidecarOps.find((o) => o.op === op).handle({
    op, client, scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: (e) => traces.push(e),
  });
  const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-opus-5', 'claude-sonnet-5'], estimateMicroUsd: 10_000 });
  // Two workers fit the envelope (limit minus the shutdown reserve); the third does not.
  const plan = await call('plan.submit', { plan: { tasks: [task('A', 'a'), task('B', 'b'), task('C', 'c')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 30_000, shutdownReserveMicroUsd: 5_000, policy } });
  return { dir, ws, call, traces, plan, release: async () => {
      writeFileSync(join(dir, 'go'), '');
      await drainBackgroundWorkers();
    }, done: async () => {
      writeFileSync(join(dir, 'go'), '');
      await drainBackgroundWorkers();
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('W09/ORC-10: the cheaper-profile suggestion prices models from the model registry in use (a refresh in the Jevris home), not only the bundled one', async () => {
  const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');
  // The refresh makes claude-sonnet-5 dearer than claude-opus-5: no approved model is cheaper now.
  const opus = BUNDLED_MODEL_REGISTRY.entries.find((e) => e.modelId === 'claude-opus-5');
  const dearer = { ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => (e.modelId === 'claude-sonnet-5' ? { ...e, tariff: { ...e.tariff, outputPerMillion: opus.tariff.outputPerMillion * 2, outputMicroUsdPerMillion: opus.tariff.outputMicroUsdPerMillion * 2, scheduled: [] } } : e)) };
  const f = await budgetFixture('finish-running', { registry: dearer });
  try {
    const report = (await f.call('budget.get', { budgetId: 'b1' })).body.exhaustion;
    const cheaper = report.suggestions.find((s) => s.kind === 'cheaper-profile');
    assert.deepEqual([cheaper.model, cheaper.text], [null, "No cheaper qualified profile among C's approved models."]);
  } finally {
    await f.done();
  }
});

test('W09/ORC-10: a reservation past the owned envelope is refused with the suggestion set; the reserve is never admitted; finish-running keeps running work', async () => {
  const f = await budgetFixture('finish-running');
  try {
    assert.equal(f.plan.body.leaseIds.length, 2, JSON.stringify(f.plan.body));
    const got = (await f.call('budget.get', { budgetId: 'b1' })).body;
    // A run that ends before it launches (a blocked worktree or effect record) releases its
    // reservation with nothing spent; name the tasks' states so such a failure says which.
    const states = () => JSON.stringify(['A', 'B'].map((id) => [id, getTask(f.ws, id)?.node.state, getTask(f.ws, id)?.stateReason ?? null]));
    assert.deepEqual([got.budget.limitMicroUsd, got.budget.shutdownReserveMicroUsd, got.use.heldMicroUsd, got.use.availableMicroUsd], [30_000, 5_000, 20_000, 5_000], states());
    const report = got.exhaustion;
    assert.deepEqual(report.refused.map((r) => [r.taskId, r.reasonCode]), [['C', 'OVER_BUDGET']]);
    assert.deepEqual(report.actions.map((a) => a.action), ['continue', 'continue']);
    assert.deepEqual(report.suggestions.map((s) => s.kind), ['narrow', 'cheaper-profile', 'pause', 'increase']);
    assert.equal(report.suggestions.find((s) => s.kind === 'cheaper-profile').model, 'claude-sonnet-5', 'an approved model with a lower registry price');
    assert.equal(report.suggestions.find((s) => s.kind === 'increase').increaseToMicroUsd, 35_000);
    assert.equal(report.mandatoryChecksKept, true);
    assert.ok(!report.suggestions.some((s) => /skip/i.test(s.text)), 'never skip verification to fit');
    assert.equal(getTask(f.ws, 'C').node.state, 'ready');
    // An increase without the person's terminal authorization is refused; nothing changes.
    const refused = (await f.call('budget.update', { budgetId: 'b1', limitMicroUsd: 40_000, actor: 'alice' })).body;
    assert.deepEqual([refused.updated, refused.reasonCode, refused.budget.limitMicroUsd], [false, 'AUTHORIZATION_REFUSED', 30_000]);
    assert.equal((await f.call('budget.update', { budgetId: 'b1', limitMicroUsd: 40_000, actor: 'alice', authorizationId: 'auth-forged' })).body.reasonCode, 'AUTHORIZATION_REFUSED');
    assert.equal((await f.call('budget.update', { budgetId: 'b1', resume: true, actor: 'alice' }, 'mcp')).reasonCode, 'CLI_ONLY');
    // The person's terminal authorization for exactly this budget admits the increase, once.
    const minted = mintAuthorization(f.ws.store, { principal: 'alice', actionClass: 'budget.increase', scope: 'b1', ttlMs: 60_000, channel: 'terminal', nowMs: Date.now() });
    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.equal((await f.call('budget.update', { budgetId: 'b1', limitMicroUsd: 40_000, actor: 'mallory', authorizationId: minted.authorizationId })).body.reasonCode, 'AUTHORIZATION_REFUSED', 'another principal cannot use it');
    const raised = (await f.call('budget.update', { budgetId: 'b1', limitMicroUsd: 40_000, actor: 'alice', authorizationId: minted.authorizationId })).body;
    assert.deepEqual([raised.updated, raised.budget.limitMicroUsd], [true, 40_000], JSON.stringify(raised));
    assert.equal(getTask(f.ws, 'C').node.state, 'leased', 'after the approved increase the third task is admitted');
    assert.equal((await f.call('budget.update', { budgetId: 'b1', limitMicroUsd: 50_000, actor: 'alice', authorizationId: minted.authorizationId })).body.reasonCode, 'AUTHORIZATION_REFUSED', 'single use');
    // Unknown vendor usage stays held in full once the runs end.
    await f.release();
    const after = (await f.call('budget.get', { budgetId: 'b1' })).body;
    assert.equal(after.use.heldMicroUsd >= 30_000, true, JSON.stringify(after.use));
  } finally {
    await f.done();
  }
});

test('ORC-10 policies: cancel-newest cancels the newest running task once per episode; pause-all pauses the budget until a person resumes it', async () => {
  const f = await budgetFixture('cancel-newest');
  try {
    const report = (await f.call('budget.get', { budgetId: 'b1' })).body.exhaustion;
    assert.deepEqual(report.actions.filter((a) => a.action === 'cancelled').length, 1, JSON.stringify(report.actions));
    const cancelled = report.actions.find((a) => a.action === 'cancelled').taskId;
    assert.equal(getTask(f.ws, cancelled).node.state, 'cancelled');
  } finally {
    await f.done();
  }
  const g = await budgetFixture('pause-all');
  try {
    const got = (await g.call('budget.get', { budgetId: 'b1' })).body;
    assert.equal(got.budget.paused, true);
    assert.deepEqual(got.exhaustion.actions.map((a) => a.action), ['paused', 'paused']);
    const resumed = (await g.call('budget.update', { budgetId: 'b1', resume: true, actor: 'alice' })).body;
    // Resumed; C is still over the envelope, so it is reported again, but the budget is not re-paused.
    assert.deepEqual([resumed.updated, resumed.budget.paused], [true, false], JSON.stringify(resumed));
    assert.deepEqual(resumed.exhaustion.refused.map((r) => [r.taskId, r.reasonCode]), [['C', 'OVER_BUDGET']]);
  } finally {
    await g.done();
  }
});

test('ORC-08: C28 finds duplicated work; the user cancels the duplicate naming its survivor; only a user revert of that cancellation is recorded as a false cancellation', async () => {
  const dir = tempDir('jv-tw-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'mod', 'a'), { recursive: true });
  mkdirSync(join(repo, 'mod', 'b'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a', 'x.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
    await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
    workersNotAutomatic(home);
    const call = (op, body, client = 'cli') => sidecarOps.find((o) => o.op === op).handle({
      op, client, scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
    });
    const task = (id, scope) => ({ id, title: 'Fix the importer date parsing', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'] });
    const plan = await call('plan.submit', { plan: { tasks: [task('T1', 'mod/a'), task('T2', 'mod/b')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(plan.body.accepted, true, JSON.stringify(plan.body));
    // Both are in progress (leased), as duplicated work would be.
    assert.equal((await scheduleTasks(ws, { authority: leaseAuthorityFor(ws), holder: selfIdentity() })).leased.length, 2);
    const advice = (await call('capability.advise', { capabilityId: 'C28' })).body;
    assert.deepEqual(advice.kept, ['T1'], JSON.stringify(advice));
    assert.equal(advice.guards.applied, false, 'advice cancels nothing');
    assert.equal(getTask(ws, 'T2').node.state, 'leased');
    // The user approves: cancel T2 as a duplicate of T1.
    const cancelled = await call('task.cancel', { taskId: 'T2', duplicateOf: 'T1' });
    assert.equal(cancelled.body.task.state, 'cancelled', JSON.stringify(cancelled.body));
    assert.equal((await call('task.revert-duplicate', { taskId: 'T2', actor: 'alice' }, 'mcp')).reasonCode, 'CLI_ONLY');
    const reverted = (await call('task.revert-duplicate', { taskId: 'T2', actor: 'alice' })).body;
    assert.deepEqual([reverted.recorded, reverted.reasonCode], [true, 'FALSE_CANCELLATION_RECORDED']);
    assert.equal(ws.state.get('duplicate-feedback', `${ws.workspaceId}/T2`).falseCancellation, true);
    assert.equal((await call('task.revert-duplicate', { taskId: 'T1', actor: 'alice' })).body.reasonCode, 'NOT_A_DUPLICATE_CANCELLATION', 'nothing is recorded without a duplicate cancellation');
  } finally {
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the routed effort reaches the harness CLI worker and the Agent SDK; the port-reported effort is recorded (C 1fc41b9, F f501ceb, harness parity audit G21)', async () => {
  const seen = [];
  const stub = (name, reported) => async () => ({ run: async (input) => { seen.push(`${name}:${input.model}:${input.effort ?? '-'}`); return { status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0, ...(reported === undefined ? {} : { effort: reported }) }; } });
  const input = { prompt: 'p', model: 'claude-sonnet-4-5', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const keyEnv = { ANTHROPIC_API_KEY: 'k-not-real', OPENAI_API_KEY: 'k-not-real' };
  // G21: with a key the Agent SDK runs the Claude model, with the routed effort as its option.
  const both = await loadWorkerPort({ sdk: stub('sdk'), claude: stub('claude'), codex: stub('codex', 'xhigh') }, { env: keyEnv });
  assert.equal((await both.run({ ...input, effort: 'high' })).effort, 'high');
  // Without an effort it runs at the model's default (null).
  assert.equal((await both.run(input)).effort, null);
  // The port reports what it actually passed (Codex max runs as xhigh; the SDK gives Haiku none).
  assert.equal((await both.run({ ...input, model: 'gpt-5-codex', effort: 'max' })).effort, 'xhigh');
  assert.deepEqual(seen.splice(0), ['sdk:claude-sonnet-4-5:high', 'sdk:claude-sonnet-4-5:-', 'codex:gpt-5-codex:max']);
  const haiku = await loadWorkerPort({ sdk: stub('sdk', null), claude: stub('claude') }, { env: keyEnv });
  assert.equal((await haiku.run({ ...input, model: 'claude-haiku-4-5-20251001', effort: 'high' })).effort, null);
  // Without a key the Claude Code CLI runs it on the subscription, with the effort.
  const login = await loadWorkerPort({ sdk: stub('sdk'), claude: stub('claude') }, { env: {} });
  assert.equal((await login.run({ ...input, effort: 'low' })).effort, 'low');
  assert.deepEqual(seen.splice(0), ['sdk:claude-haiku-4-5-20251001:high', 'claude:claude-sonnet-4-5:low']);
});

test('the real OpenCode, Kilo and Antigravity ports load from F\'s exports beside Claude Code and Codex; a harness port gets F\'s effort level, the environment and never the task id (F f501ceb)', async () => {
  // Loading imports F's module only: nothing is spawned until a run.
  for (const load of [loadClaudeCliWorkerPort, loadCodexWorkerPort, loadOpencodeWorkerPort, loadKiloWorkerPort, loadAntigravityWorkerPort]) {
    const port = await load();
    assert.notEqual(port, null, load.name);
    assert.equal(typeof port.run, 'function', load.name);
  }
  const seen = [];
  const port = harnessWorkerPort({ run: async (input) => { seen.push(input); return { status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0 }; } });
  const input = { prompt: 'p', model: 'grok-4.7', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal, taskId: 'T1', auth: 'subscription', env: { HOME: '/h' } };
  await port.run({ ...input, effort: 'high' });
  await port.run({ ...input, effort: 'turbo' });
  await port.run(input);
  assert.deepEqual(seen.map((s) => [s.effort, 'taskId' in s, s.env?.HOME, s.auth]), [['high', false, '/h', 'subscription'], [undefined, false, '/h', 'subscription'], [undefined, false, '/h', 'subscription']]);
});

test('a failed first-use check that stopped the run names its reason code; a check that did not stop the run changes nothing (F 9534911)', async () => {
  const outcome = (extra) => async () => ({ run: async (input) => ({ status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0, ...extra }) });
  const input = { prompt: 'p', model: 'claude-sonnet-4-5', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const cases = [
    // Claude Code: a model mismatch at init stops the run before any tool.
    ['claude', 'claude-sonnet-4-5', { status: 'refused', reason: "refused: the session's init failed the first-use check (WORKER_INIT_MODEL)", initCheck: { ok: false, reasonCode: 'WORKER_INIT_MODEL' } }, 'refused', /^WORKER_INIT_MODEL: the session's init failed/],
    // Antigravity: a bypass mode at init.
    ['antigravity', 'gemini-3-pro', { status: 'refused', reason: 'refused: bypass', initCheck: { ok: false, reasonCode: 'WORKER_INIT_BYPASS' } }, 'refused', /^WORKER_INIT_BYPASS: bypass$/],
    // OpenCode: the Jevris agent did not load (F already names the config).
    ['opencode', 'grok-4.7', { status: 'refused', reason: 'refused: the Jevris agent did not load', initCheck: { ok: false, reasonCode: 'WORKER_AGENT_NOT_LOADED' } }, 'refused', /^WORKER_AGENT_NOT_LOADED: the Jevris agent did not load$/],
    // Codex reports a shape mismatch but does not stop the run: the outcome is as reported.
    ['codex', 'gpt-5-codex', { initCheck: { ok: false, reasonCode: 'WORKER_INIT_SHAPE' } }, 'completed', /^$/],
    // A reason that already leads with the code, or a malformed code, is kept as is.
    ['kilo', 'grok-4.7', { status: 'refused', reason: 'WORKER_INIT_SHAPE: odd', initCheck: { ok: false, reasonCode: 'WORKER_INIT_SHAPE' } }, 'refused', /^WORKER_INIT_SHAPE: odd$/],
    ['kilo', 'grok-4.7', { status: 'refused', reason: 'refused: x', initCheck: { ok: false, reasonCode: 'not a code' } }, 'refused', /^refused: x$/],
  ];
  const dir = tempDir('jv-init-');
  for (const [harness, model, extra, status, reason] of cases) {
    writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', harness: { xai: harness === 'kilo' ? 'kilo' : 'opencode' } }));
    const none = async () => null;
    const loaders = { sdk: none, claude: none, codex: none, opencode: none, kilo: none, antigravity: none, [harness]: outcome(extra) };
    const port = await loadWorkerPort(loaders, { env: {}, configDir: dir });
    const r = await port.run({ ...input, model });
    assert.deepEqual([r.harness, r.status], [harness, status], JSON.stringify(r));
    assert.match(r.reason, reason);
    assert.deepEqual(r.initCheck, extra.initCheck);
  }
});

test('auto on OpenCode and Kilo follows what the harness holds for the model provider: a stored login is a subscription, a stored or environment key is api-key, nothing is <PROVIDER>_NO_LOGIN (F 17beb82, billing correctness)', async () => {
  const { resolveMultiProviderAuth, credentialProvider, noLoginCode, XAI_API_KEY_MISSING, ANTHROPIC_LOGIN_THIRD_PARTY } = await import('../dist/index.js');
  const oauth = (provider) => ({ provider, type: 'oauth' });
  const api = (provider) => ({ provider, type: 'api' });
  assert.deepEqual(['Anthropic', 'OpenAI', 'xAI', 'x-ai', 'Google', 'Gemini', 'OpenRouter'].map(credentialProvider), ['anthropic', 'openai', 'xai', 'xai', 'google', 'google', null]);
  assert.equal(noLoginCode('xai'), 'XAI_NO_LOGIN');
  const r = (provider, setting, envKey, stored) => {
    const out = resolveMultiProviderAuth(provider, setting, envKey ? { XAI_API_KEY: 'k', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' } : {}, stored);
    return out.ok ? `${out.mode}/${out.source}` : `${out.reasonCode}/${out.mode}`;
  };
  const cases = [
    // auto, per provider: 1 environment key, 2 unreadable list, 3 stored key, 4 stored login, 5 nothing
    ['xai', 'auto', true, [oauth('xAI')], 'api-key/environment'],
    ['xai', 'auto', true, [], 'api-key/environment'],
    ['xai', 'auto', true, null, 'api-key/environment'],
    ['xai', 'auto', false, null, 'subscription/undetected'],
    ['xai', 'auto', false, [api('xAI')], 'api-key/stored-key'],
    ['xai', 'auto', false, [api('xAI'), oauth('xAI')], 'api-key/stored-key'],
    ['xai', 'auto', false, [oauth('xAI')], 'subscription/stored-login'],
    ['xai', 'auto', false, [], 'XAI_NO_LOGIN/subscription'],
    ['xai', 'auto', false, [oauth('OpenAI'), api('Google')], 'XAI_NO_LOGIN/subscription'],
    ['openai', 'auto', false, [oauth('OpenAI'), api('xAI')], 'subscription/stored-login'],
    ['openai', 'auto', false, [api('xAI')], 'OPENAI_NO_LOGIN/subscription'],
    ['google', 'auto', false, [{ provider: 'Google', type: 'wellknown' }], 'api-key/stored-key'],
    ['google', 'auto', false, [], 'GOOGLE_NO_LOGIN/subscription'],
    // Anthropic: a claude.ai login is a subscription the caller refuses; a key is api-key.
    ['anthropic', 'auto', false, [oauth('Anthropic')], 'subscription/stored-login'],
    ['anthropic', 'auto', true, [oauth('Anthropic')], 'api-key/environment'],
    ['anthropic', 'auto', false, [api('Anthropic')], 'api-key/stored-key'],
    ['anthropic', 'auto', false, [], 'ANTHROPIC_NO_LOGIN/subscription'],
    // a mode declared in workers.json always wins; XAI_API_KEY_MISSING only for a declared api-key
    ['xai', 'subscription', true, [api('xAI')], 'subscription/declared'],
    ['xai', 'subscription', false, [], 'subscription/declared'],
    ['xai', 'subscription', false, null, 'subscription/declared'],
    ['xai', 'api-key', false, [api('xAI')], 'api-key/declared'],
    ['xai', 'api-key', true, [], 'api-key/declared'],
    ['xai', 'api-key', false, [oauth('xAI')], `${XAI_API_KEY_MISSING}/api-key`],
    ['xai', 'api-key', false, null, `${XAI_API_KEY_MISSING}/api-key`],
    ['openai', 'api-key', false, [], 'api-key/declared'],
    ['anthropic', 'subscription', false, [], 'subscription/declared'],
  ];
  for (const [provider, setting, envKey, stored, want] of cases) assert.equal(r(provider, setting, envKey, stored), want, `${provider} ${setting} env=${envKey} ${JSON.stringify(stored)}`);

  // Through the dispatching port, on both harnesses: the mode, its source, the key the run sees,
  // one credential read per harness, none for a harness that is not installed.
  const seen = [];
  const stub = (name) => async () => ({ run: async (input) => { seen.push(`${name}:${input.auth}:${input.env?.XAI_API_KEY ?? '-'}`); return { status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0 }; } });
  const input = { prompt: 'p', model: 'grok-4.7', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const dir = tempDir('jv-cred-');
  for (const harness of ['opencode', 'kilo']) {
    writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', harness: { xai: harness, anthropic: harness } }));
    for (const [stored, env, want, sees] of [
      // the billing case: only a stored key, none in the environment, is api-key
      [[api('xAI')], {}, ['completed', 'api-key', 'stored-key'], `${harness}:api-key:-`],
      [[oauth('xAI')], {}, ['completed', 'subscription', 'stored-login'], `${harness}:subscription:-`],
      [[oauth('xAI')], { XAI_API_KEY: 'k-not-real' }, ['completed', 'api-key', 'environment'], `${harness}:api-key:k-not-real`],
      [[], {}, ['refused', 'subscription', 'nothing-stored'], null],
      [null, {}, ['completed', 'subscription', 'undetected'], `${harness}:subscription:-`],
    ]) {
      const reads = [];
      const port = await loadWorkerPort({ [harness]: stub(harness) }, { env, configDir: dir, credentials: async (h) => { reads.push(h); return stored; } });
      const a = await port.run(input);
      const b = await port.run(input);
      assert.deepEqual([a.status, a.authMode, a.authSource], want, `${harness} ${JSON.stringify(stored)} ${JSON.stringify(env)}`);
      assert.deepEqual([b.status, b.authMode, b.authSource], want);
      if (want[0] === 'refused') assert.match(a.reason, /^XAI_NO_LOGIN: the harness holds no xai login or key and XAI_API_KEY is not set; sign in to xai/);
      assert.deepEqual(seen.splice(0), sees === null ? [] : [sees, sees], 'a subscription run never sees XAI_API_KEY');
      assert.deepEqual(reads, [harness], 'one credential read per harness');
      const authFor = await port.authFor('grok-4.7');
      assert.deepEqual(authFor, want[0] === 'refused' ? null : { mode: want[1], source: want[2] });
    }
    // An Anthropic model with only a claude.ai login stored: refused, never billed to the login.
    const claude = await loadWorkerPort({ [harness]: stub(harness) }, { env: {}, configDir: dir, credentials: async () => [oauth('Anthropic')] });
    const refused = await claude.run({ ...input, model: 'claude-sonnet-4-5' });
    assert.deepEqual([refused.status, refused.authSource], ['refused', 'stored-login']);
    assert.match(refused.reason, new RegExp(`^${ANTHROPIC_LOGIN_THIRD_PARTY}:`));
    // Not installed: nothing is read, and the install hint is the answer.
    const reads = [];
    const missing = await loadWorkerPort({ claude: stub('claude') }, { env: {}, configDir: dir, credentials: async (h) => { reads.push(h); return []; } });
    assert.equal((await missing.run(input)).status, 'unsupported');
    assert.deepEqual(reads, []);
  }
  // Claude Code and Codex keep the environment rule, and say so. With no key and nothing
  // declared the subscription is assumed, not seen: `undetected` (B's security review, finding 8).
  const native = await loadWorkerPort({ claude: stub('claude'), codex: stub('codex') }, { env: { OPENAI_API_KEY: 'k-not-real' } });
  assert.deepEqual([(await native.run({ ...input, model: 'gpt-5-codex' })).authSource, (await native.run({ ...input, model: 'claude-sonnet-4-5' })).authSource], ['environment', 'undetected']);
  seen.splice(0);
  // Finding 8: an undetected sign-in is not the signed-in consent default. With the store's
  // consent reader (nothing granted) the run is refused before any port; a declared mode, a key in
  // the environment or a grant lets it run.
  const missing = () => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' });
  const nativeDir = tempDir('jv-f8-');
  const runClaude = async (env, providerConsent = missing) => (await loadWorkerPort({ claude: stub('claude') }, { env, configDir: nativeDir, providerConsent })).run({ ...input, model: 'claude-sonnet-4-5' });
  const undetected = await runClaude({});
  assert.deepEqual([undetected.status, undetected.authMode, undetected.authSource], ['refused', 'subscription', 'undetected']);
  assert.match(undetected.reason, /^PROVIDER_CONSENT_REQUIRED: anthropic has no current consent/);
  assert.deepEqual(seen.splice(0), [], 'nothing ran');
  const keyed = await runClaude({ ANTHROPIC_API_KEY: 'k-not-real' });
  assert.deepEqual([keyed.status, keyed.authSource], ['completed', 'environment']);
  const grantedRun = await runClaude({}, (provider) => (provider === 'anthropic' ? { granted: true } : missing()));
  assert.deepEqual([grantedRun.status, grantedRun.authSource], ['completed', 'undetected']);
  writeFileSync(join(nativeDir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', auth: { claude: 'subscription' } }));
  const declared = await runClaude({});
  assert.deepEqual([declared.status, declared.authMode, declared.authSource], ['completed', 'subscription', 'declared']);
  seen.splice(0);
  // Owner decision c065d52 (RAN_HERE): a Claude Code subscription user with no key is refused
  // before any observed session, and allowed once a harness here has run an Anthropic model.
  const { recordModelRun } = await import('@jevris/core');
  const seenHome = tempDir('jv-ranhere-');
  const runSeen = async () => (await loadWorkerPort({ claude: stub('claude') }, { env: {}, configDir: tempDir('jv-ranhere-cfg-'), providerConsent: missing, home: seenHome })).run({ ...input, model: 'claude-sonnet-5' });
  const before = await runSeen();
  assert.deepEqual([before.status, before.authSource], ['refused', 'undetected']);
  assert.match(before.reason, /^PROVIDER_CONSENT_REQUIRED: anthropic has no current consent/);
  assert.equal(await recordModelRun(seenHome, { harness: 'claude', authMode: 'unknown', modelId: 'claude-opus-5-5', nowMs: Date.now() }), true);
  const after = await runSeen();
  assert.deepEqual([after.status, after.authMode, after.authSource], ['completed', 'subscription', 'undetected']);
  seen.splice(0);
});

test('the default credential reader is F\'s harness-auth export, and it never asks a harness in a test run or under a foreign HOME (F 865ffa1)', async () => {
  const home = tempDir('jv-noprobe-');
  for (const harness of ['opencode', 'kilo']) assert.equal(await loadStoredCredentials(harness, { HOME: home, USERPROFILE: home, JEVRIS_TEST: '1' }), null, harness);
});

test('R5: the model registry names an owned worker\'s provider; an id no registry entry or model family names is refused and never run on Claude', async () => {
  const { WORKER_PROVIDER_UNKNOWN, workerProvider } = await import('../dist/index.js');
  const seen = [];
  const stub = (name) => async () => ({ run: async (input) => { seen.push(`${name}:${input.model}`); return { status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0 }; } });
  const registry = { entries: [{ modelId: 'house-model', provider: 'openai' }, { modelId: 'acme-1', provider: 'acme' }, { modelId: 'twin', provider: 'openai' }, { modelId: 'twin', provider: 'xai' }] };
  assert.deepEqual(['house-model', 'openai/house-model', 'acme-1', 'acme/acme-1', 'twin', 'xai/twin', 'claude-opus-5-5', 'mystery'].map((m) => workerProvider(m, registry)), ['openai', 'openai', null, null, null, 'xai', 'anthropic', null]);
  const port = await loadWorkerPort({ sdk: stub('sdk'), claude: stub('claude'), codex: stub('codex') }, { env: { ANTHROPIC_API_KEY: 'k-not-real' }, registry });
  const input = { prompt: 'p', model: 'mystery', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  for (const model of ['mystery', 'acme-1', 'twin']) {
    const outcome = await port.run({ ...input, model });
    assert.equal(outcome.status, 'refused', model);
    assert.ok(outcome.reason.startsWith(`${WORKER_PROVIDER_UNKNOWN}:`), outcome.reason);
    assert.equal(port.harnessFor(model), null);
    assert.equal(await port.authFor(model), null);
  }
  assert.deepEqual(seen.splice(0), [], 'nothing ran, on Claude or anywhere else');
  // A registry id takes its provider's harness.
  assert.equal(port.harnessFor('house-model'), 'codex');
  await port.run({ ...input, model: 'house-model' });
  assert.deepEqual(seen.splice(0), ['codex:house-model']);
});

test('R29: GLM, Kimi and DeepSeek workers run on OpenCode from the registry\'s harness rows; Kimi and DeepSeek need the provider\'s consent, and Kilo is skipped where it cannot name the model', async () => {
  const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');
  const { PROVIDER_CONSENT_REQUIRED, WORKER_MODEL_UNNAMED, WORKER_PROVIDERS, providerHarnesses, workerProvider } = await import('../dist/index.js');
  const registry = BUNDLED_MODEL_REGISTRY;
  for (const provider of ['zai', 'moonshot', 'deepseek']) assert.ok(WORKER_PROVIDERS.includes(provider), provider);
  assert.deepEqual(['glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'moonshotai/kimi-k3', 'deepseek/deepseek-flash'].map((m) => workerProvider(m, registry)), ['zai', 'moonshot', 'deepseek', 'moonshot', 'deepseek']);
  // The registry's rows: OpenCode first for all three, then Kilo where the registry has a row.
  for (const provider of ['zai', 'moonshot', 'deepseek']) assert.equal(providerHarnesses(provider, registry)[0], 'opencode', provider);
  const rows = { harnessAccess: [{ harness: 'kilocode', provider: 'deepseek', access: 'provider-config' }, { harness: 'opencode', provider: 'deepseek', access: 'provider-config', idTemplate: '{provider}/{id}' }, { harness: 'mystery', provider: 'deepseek' }] };
  assert.deepEqual(providerHarnesses('deepseek', rows), ['opencode', 'kilo'], 'native, then OpenCode, then Kilo; an unknown harness is skipped');
  assert.deepEqual(providerHarnesses('zai', rows), [], 'no row, no harness');
  assert.deepEqual(providerHarnesses('zai', {}), ['opencode', 'kilo'], 'a registry without rows uses the static list');
  const seen = [];
  const stub = (name) => async () => ({ run: async (input) => { seen.push(`${name}:${input.model}:${input.registry === registry}`); return { status: 'completed', reason: '', sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0 }; } });
  const input = { prompt: 'p', model: 'glm-5.3', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
  const env = { ZHIPU_API_KEY: 'k-not-real', MOONSHOT_API_KEY: 'k-not-real', DEEPSEEK_API_KEY: 'k-not-real' };
  const asked = [];
  const namer = (model, harness) => {
    asked.push(harness);
    return harness === 'kilocode' ? null : `x/${model}`;
  };
  // No consent reader (no store): GLM runs; Kimi and DeepSeek are refused before any harness starts.
  const bare = await loadWorkerPort({ opencode: stub('opencode'), kilo: stub('kilo') }, { env, registry, credentials: async () => [], harnessModelId: namer });
  assert.equal(bare.harnessFor('glm-5.3'), 'opencode');
  const glm = await bare.run(input);
  assert.deepEqual([glm.status, glm.authMode], ['completed', 'api-key']);
  assert.deepEqual(seen.splice(0), ['opencode:glm-5.3:true'], 'the port gets the loaded registry');
  for (const model of ['kimi-k3', 'deepseek-v4-pro']) {
    const refused = await bare.run({ ...input, model });
    assert.equal(refused.status, 'refused', model);
    assert.match(refused.reason, new RegExp(`^${PROVIDER_CONSENT_REQUIRED}: \\w+ has no current consent .*jevris consent provider \\w+ --grant$`));
  }
  assert.deepEqual(seen.splice(0), []);
  // With C's gate over the stored consent: a current grant runs; a missing or stale one is refused with its code.
  const grants = { deepseek: { granted: true, provider: 'deepseek', textVersion: 'v', grantedAtMs: 1 }, moonshot: { granted: false, provider: 'moonshot', reasonCode: 'PROVIDER_CONSENT_STALE' } };
  const consented = await loadWorkerPort({ opencode: stub('opencode'), kilo: stub('kilo') }, { env, registry, credentials: async () => [], harnessModelId: namer, providerConsent: (p) => grants[p] ?? { granted: false, provider: p, reasonCode: 'PROVIDER_CONSENT_MISSING' } });
  assert.equal((await consented.run({ ...input, model: 'deepseek-v4-pro' })).status, 'completed');
  const stale = await consented.run({ ...input, model: 'kimi-k3' });
  assert.equal(stale.status, 'refused');
  assert.match(stale.reason, /^PROVIDER_CONSENT_STALE: moonshot /);
  assert.equal((await consented.run(input)).status, 'completed', 'GLM needs no stored grant while the harness holds its key');
  assert.deepEqual(seen.splice(0), ['opencode:deepseek-v4-pro:true', 'opencode:glm-5.3:true']);
  // A preferred Kilo that cannot name the model leaves no candidate: refused, and nothing runs.
  const dir = tempDir('jv-r29-');
  writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', harness: { deepseek: 'kilo' } }));
  asked.splice(0);
  const kiloOnly = await loadWorkerPort({ opencode: stub('opencode'), kilo: stub('kilo') }, { env, registry, configDir: dir, credentials: async () => [], harnessModelId: namer, providerConsent: (p) => grants[p] ?? { granted: false, provider: p, reasonCode: 'PROVIDER_CONSENT_MISSING' } });
  assert.equal(kiloOnly.harnessFor('deepseek-v4-pro'), null);
  const skipped = await kiloOnly.run({ ...input, model: 'deepseek-v4-pro' });
  assert.equal(skipped.status, 'refused');
  assert.match(skipped.reason, new RegExp(`^${WORKER_MODEL_UNNAMED}: no harness that runs deepseek can name deepseek-v4-pro$`));
  assert.ok(asked.includes('kilocode'));
  assert.deepEqual(seen.splice(0), []);
  // By default the port asks F's opencodeModel: DeepSeek runs on OpenCode first; an id no harness can spell runs nowhere.
  const real = (loaders) => loadRealWorkerPort({ sdk: noPort, claude: noPort, codex: noPort, opencode: noPort, kilo: noPort, antigravity: noPort, ...loaders }, { env, registry, credentials: async () => [] });
  assert.equal((await real({ opencode: stub('opencode'), kilo: stub('kilo') })).harnessFor('deepseek-v4-pro'), 'opencode');
  assert.equal((await real({ kilo: stub('kilo') })).harnessFor('grok-4.7'), 'kilo');
  assert.equal((await real({ opencode: stub('opencode'), kilo: stub('kilo') })).harnessFor('claude-unlisted-9'), null, 'a bare id the registry does not list is not spelled for OpenCode or Kilo');
});
