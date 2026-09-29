// ORC-07 (W04, D06, E29): controlled integration of verified owned tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import {
  approveManifests,
  DEFAULT_CONFIG,
  drainBackgroundWorkers,
  getTask,
  listWorktrees,
  manifestHash,
  nodeGit,
  openWorkspace,
  runIntegration,
  parseManifest,
  scriptedWorkerPort,
  setTaskOpDeps,
  sidecarOps,
  detectIntegrationReverts,
  revertWindowMs,
  setConfigValue,
  drainIntegrationReverts,
  drainRouteLearning,
  keepLearningNote,
  learningRow,
  setRouteLearner,
  workerRuns,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/**
 * Two owned tasks, each run by the scripted port in its own worktree and verified there.
 * `writes` gives each task's scripted writes; `check` is the shared check's script.
 */
async function fixture({ writes, check = '0', scopes = ['mod', 'lib'] }) {
  const dir = tempDir('jv-int-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'lib', 'b.txt'), 'b\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'shared', argv: [process.execPath, '-e', check], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { shared: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: writes.map((w) => ({ writes: w, status: 'completed', costUsd: 0.01 })) }));
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath };
  setTaskOpDeps({ workerPort: async () => scriptedWorkerPort(env, home) });
  const traces = [];
  const call = (op, body, client = 'cli') => sidecarOps.find((o) => o.op === op).handle({
    op, client, scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: (e) => traces.push(e),
  });
  // Tasks one at a time, so the scripted runs map to tasks in order.
  for (const [i, scope] of scopes.entries()) {
    const id = `T${String(i + 1)}`;
    const task = { id, requirementIds: ['R1'], acceptanceCheckIds: ['shared'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'] };
    const sub = i === 0
      ? await call('plan.submit', { plan: { tasks: [task] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } })
      : await call('task.submit', { task: { ...task, rootBudgetId: 'b1' } });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    assert.equal(sub.body.leaseIds.length, 1, JSON.stringify(sub.body));
    await drainBackgroundWorkers();
    const v = await call('verify', { taskId: id, checkIds: [] });
    assert.equal(getTask(ws, id).node.state, 'verified', JSON.stringify(v.body));
  }
  return { dir, repo, ws, call, traces, done: () => {
      setTaskOpDeps({});
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('P2: a git revert of a task integrated commit labels that task route reverted, once; a message that only mentions a commit labels nothing', async () => {
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'a2\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }]] });
  const events = [];
  setRouteLearner(async (input) => {
    events.push(input.event);
    return { recorded: true, reasonCode: null, regression: null, promotion: null, proposalId: null, version: 1, saved: true };
  });
  try {
    const report = (await f.call('integration.run', { taskIds: ['T1', 'T2'] })).body;
    assert.equal(report.state, 'ready', JSON.stringify(report));
    const [c1, c2] = report.tasks.map((t) => t.integratedCommit);
    assert.match(c1, /^[0-9a-f]{40,64}$/);
    assert.equal((await f.call('integration.approve', { integrationId: report.id, actor: 'alice' })).body.merged, true);
    // T1's route passed verification (a kept route with its verified label).
    const leaseId = workerRuns(f.ws, 'T1')[0].leaseId;
    const kept = await keepLearningNote(f.ws, { taskId: 'T1', leaseId, sliceId: 'issue-fix', baselineModelId: 'claude-opus-5-5', eligibleModelIds: [], risk: 'low', note: { policyVersion: 1 }, nowMs: Date.now() });
    await f.ws.state.transact((tx) => tx.put('route-learning', [f.ws.workspaceId, 'T1'].join('/'), { ...kept, outcome: 'verified-pass', labels: ['verified-pass'] }));
    assert.deepEqual(await detectIntegrationReverts(f.ws), [], 'nothing reverted yet');
    git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'Note', '-m', `Mentions This reverts commit ${c2}. inline only`);
    git(f.repo, 'revert', '--no-edit', c1);
    assert.deepEqual(await detectIntegrationReverts(f.ws), ['T1']);
    await drainRouteLearning();
    assert.deepEqual(events.map((e) => [e.kind, e.routeId, e.receiptId, e.costMicroUsd]), [['reverted', `gen-${leaseId}`, null, null]]);
    assert.deepEqual(learningRow(f.ws, 'T1').labels, ['verified-pass', 'reverted']);
    // Once: a later scan finds nothing new.
    git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'later');
    assert.deepEqual(await detectIntegrationReverts(f.ws), []);
    // Only commit ids are kept.
    assert.deepEqual(Object.keys(f.ws.state.list('integration-reverts')[0]).sort(), ['atMs', 'integratedCommit', 'revertCommit', 'taskId', 'workspaceId']);
    // A shorter decision retention shortens the window: once the record could have aged out, the
    // merge is no longer scanned, so it is never labelled twice (B 4d62ed8).
    assert.equal(revertWindowMs(f.ws), 30 * 86_400_000);
    assert.equal((await setConfigValue({ home: f.ws.home, key: 'privacy.decisionRetentionDays', value: '7', dryRun: false })).changed.length, 1);
    assert.equal(revertWindowMs(f.ws), 7 * 86_400_000);
    await f.ws.state.transact((tx) => tx.delete('integration-reverts', f.ws.state.list('integration-reverts').map((r) => [r.workspaceId, r.taskId, r.integratedCommit].join('/'))[0]));
    assert.deepEqual(await detectIntegrationReverts(f.ws, { nowMs: Date.now() + 8 * 86_400_000 }), []);
  } finally {
    await drainIntegrationReverts();
    await drainRouteLearning();
    setRouteLearner(null);
    f.done();
  }
});

test('integration.run applies verified tasks in an integration worktree, reruns the shared checks and reports ready; approval fast-forwards the main checkout (ORC-07)', async () => {
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'a2\n' }, { path: 'mod/new.txt', text: 'new\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }, { path: 'lib/auth.js', text: "const password = process.env.X;\n" }]] });
  try {
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const run = await f.call('integration.run', { taskIds: ['T1', 'T2'] });
    assert.equal(run.ok, true, JSON.stringify(run));
    const report = run.body;
    assert.equal(report.state, 'ready', JSON.stringify(report));
    assert.equal(report.baseCommit, before);
    assert.deepEqual(report.tasks.map((t) => [t.taskId, t.outcome]), [['T1', 'applied'], ['T2', 'applied']]);
    assert.deepEqual([...report.tasks[0].paths].sort(), ['mod/a.txt', 'mod/new.txt'], 'untracked worker files are part of the patch');
    assert.deepEqual([...report.tasks[1].paths].sort(), ['lib/auth.js', 'lib/b.txt']);
    assert.equal(report.checks.verified, true);
    // Review advice on the combined change (VER-12, VER-14): advice only, grants nothing.
    assert.equal(report.triage, null);
    assert.equal(report.review.areas.capabilityId, 'C44');
    assert.equal(report.review.security.capabilityId, 'C47');
    assert.ok(report.review.security.ranked.some((m) => m.label === 'lib/auth.js'), JSON.stringify(report.review.security.ranked));
    assert.equal(report.review.security.guards.applied ?? false, false);
    assert.deepEqual(report.checks.mandatoryCheckIds, ['shared']);
    // Nothing reached the main checkout yet, and the task worktrees are untouched.
    assert.equal(readFileSync(join(f.repo, 'mod', 'a.txt'), 'utf8'), 'a\n');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
    const t1 = listWorktrees(f.ws).find((t) => t.taskId === 'T1');
    assert.match(git(t1.path, 'status', '--porcelain'), /new\.txt/, 'the task worktree keeps its own index and files');
    // integration.get finds it.
    const got = await f.call('integration.get', { integrationId: report.id });
    assert.equal(got.body.found, true);
    // Approval only from the CLI.
    const viaMcp = await f.call('integration.approve', { integrationId: report.id }, 'mcp');
    assert.equal(viaMcp.ok, false);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
    const approved = await f.call('integration.approve', { integrationId: report.id, actor: 'alice' });
    assert.equal(approved.body.merged, true, JSON.stringify(approved.body));
    assert.equal(readFileSync(join(f.repo, 'mod', 'a.txt'), 'utf8'), 'a2\n');
    assert.equal(readFileSync(join(f.repo, 'lib', 'b.txt'), 'utf8'), 'b2\n');
    assert.equal(existsSync(join(f.repo, 'mod', 'new.txt')), true);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), approved.body.report.mergedCommit);
    assert.equal(git(f.repo, 'rev-list', '--count', `${before}..HEAD`), '2', 'one commit per task');
    assert.equal(approved.body.report.approvedBy, 'alice');
    // A merged report is not merged again.
    assert.equal((await f.call('integration.approve', { integrationId: report.id })).body.reasonCode, 'NOT_READY');
  } finally {
    f.done();
  }
});

test('a task patch that conflicts with the expected base is reported with its paths and rolled back; nothing is ready to merge', async () => {
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'one\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }]] });
  try {
    // The user moved on in the main checkout, changing the same line T1 changed.
    writeFileSync(join(f.repo, 'mod', 'a.txt'), 'mine\n');
    git(f.repo, 'commit', '-q', '-am', 'user edit');
    const report = (await f.call('integration.run', { taskIds: ['T1', 'T2'] })).body;
    assert.equal(report.state, 'conflicts', JSON.stringify(report));
    assert.deepEqual(report.tasks.map((t) => t.outcome), ['conflict', 'applied']);
    assert.deepEqual(report.tasks[0].conflictPaths, ['mod/a.txt']);
    assert.equal(report.checks, null, 'no checks on a conflicted integration');
    assert.equal(git(report.worktreePath, 'status', '--porcelain'), '', 'the conflict was rolled back');
    assert.equal((await f.call('integration.approve', { integrationId: report.id })).body.reasonCode, 'NOT_READY');
  } finally {
    f.done();
  }
});

test('integration refuses an unverified task, and approval refuses a moved base or a dirty checkout', async () => {
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'a2\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }]] });
  try {
    const unknown = (await f.call('integration.run', { taskIds: ['T1', 'T9'] })).body;
    assert.equal(unknown.state, 'blocked');
    assert.equal(unknown.reasonCode, 'TASK_NOT_VERIFIED');
    assert.equal(unknown.worktreeId, null, 'no integration worktree for a refused run');
    const ready = (await f.call('integration.run', { taskIds: ['T1'] })).body;
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    writeFileSync(join(f.repo, 'lib', 'b.txt'), 'local edit\n');
    assert.equal((await f.call('integration.approve', { integrationId: ready.id })).body.reasonCode, 'CHECKOUT_DIRTY');
    git(f.repo, 'commit', '-q', '-am', 'user moved on');
    assert.equal((await f.call('integration.approve', { integrationId: ready.id })).body.reasonCode, 'BASE_MOVED');
    assert.equal(readFileSync(join(f.repo, 'mod', 'a.txt'), 'utf8'), 'a\n', 'nothing merged');
  } finally {
    f.done();
  }
});

test('failing shared checks in the integration worktree leave it checks-failed, never ready', async () => {
  // The shared check passes in each task worktree alone but fails once both patches meet.
  const check = "const fs=require('fs');process.exit(fs.readFileSync('mod/a.txt','utf8')==='a2\\n'&&fs.readFileSync('lib/b.txt','utf8')==='b2\\n'?1:0)";
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'a2\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }]], check });
  try {
    const report = (await f.call('integration.run', { taskIds: ['T1', 'T2'] })).body;
    assert.equal(report.state, 'checks-failed', JSON.stringify(report));
    assert.deepEqual(report.checks.failing, ['shared']);
    assert.equal(report.triage.capabilityId, 'C42', 'failing shared checks come with failure clusters (VER-10)');
    assert.ok(report.triage.ranked.length >= 1, JSON.stringify(report.triage));
    assert.equal((await f.call('integration.approve', { integrationId: report.id })).body.reasonCode, 'NOT_READY');
  } finally {
    f.done();
  }
});

/** Git with no identity anywhere: an empty HOME, no system or global config, and no guessing from the host name. */
function identitylessGit(dir) {
  const bare = join(dir, 'bare-home');
  mkdirSync(bare, { recursive: true });
  const emptyConfig = join(bare, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const inner = nodeGit(30_000, {
    HOME: bare,
    USERPROFILE: bare,
    XDG_CONFIG_HOME: bare,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    // user.useConfigOnly makes every git refuse a guessed identity, as git 2.39 does on a host
    // with no domain, so the regression shows on any git and any OS.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true',
  });
  const calls = [];
  return { calls, run: (args, cwd) => (calls.push(args), inner.run(args, cwd)) };
}

test('integration works with no git identity configured: the merge gets the same fallback identity as the commit (ORC-07)', async () => {
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'a2\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }]] });
  try {
    const git = identitylessGit(f.dir);
    const report = await runIntegration(f.ws, ['T1', 'T2'], { git });
    assert.equal(report.state, 'ready', JSON.stringify(report.tasks));
    assert.deepEqual(report.tasks.map((t) => t.outcome), ['applied', 'applied']);
    const merges = git.calls.filter((a) => a.includes('merge') && a.includes('--squash'));
    assert.equal(merges.length, 2);
    for (const args of merges) assert.ok(args.includes('user.email=jevris@localhost.invalid'), JSON.stringify(args));
  } finally {
    f.done();
  }
});

test('a git failure during integration is reported as a git error with git\'s message, never as a conflict (ORC-07)', async () => {
  const f = await fixture({ writes: [[{ path: 'mod/a.txt', text: 'a2\n' }], [{ path: 'lib/b.txt', text: 'b2\n' }]] });
  try {
    const real = nodeGit();
    let merges = 0;
    const git = {
      run(args, cwd) {
        if (args.includes('merge') && args.includes('--squash') && ++merges === 2) {
          return { ok: false, stdout: '', stderr: 'Committer identity unknown\n\n*** Please tell me who you are.\nfatal: unable to auto-detect email address (got token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789)' };
        }
        return real.run(args, cwd);
      },
    };
    const report = await runIntegration(f.ws, ['T1', 'T2'], { git });
    assert.equal(report.state, 'blocked');
    assert.equal(report.reasonCode, 'GIT_ERROR');
    assert.deepEqual(report.tasks.map((t) => t.outcome), ['applied', 'git-error']);
    assert.deepEqual(report.tasks[1].conflictPaths, []);
    assert.match(report.tasks[1].error, /Committer identity unknown \| \*\*\* Please tell me who you are\. \| fatal: unable to auto-detect email address/);
    assert.doesNotMatch(report.tasks[1].error, /sk-ant-abcdefghij/, 'secrets in git output are redacted');
  } finally {
    f.done();
  }
});
