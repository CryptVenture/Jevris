// A run publishes its end (its task leaves `running`) and only afterwards releases its lease, in a
// second ledger transaction. A submit that lands between the two used to count the finished run
// against `maxConcurrentWorkers` and grant one lease fewer than there were free slots ("1 lease
// where 2 were free"; the queued task then started late, from the run-end drain). The test fixes
// the order: the release is held open until the submit has answered, so no timing decides it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, approveManifests, drainBackgroundWorkers, getTask, leaseAuthorityFor, manifestHash, openWorkspace, parseManifest, setTaskOpDeps, sidecarOps } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function until(check, what) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const outcome = (input) => ({ status: 'completed', reason: 'done', sessionId: 's-' + input.model, requestedModel: input.model, actualModel: input.model, costUsd: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, turns: 0, durationMs: 1 });

test('a run that has published its end but not released its lease does not take a slot from a submit (1 lease where 2 are free)', async () => {
  const dir = tempDir('jv-ls-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  for (const d of ['z', 'a', 'b', 'c']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'a', 'x.txt'), 'x\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true, maxConcurrentWorkers: 2 } }));
  // Every run ends at once, except that its lease release waits for the test.
  let releaseGate = () => {};
  const gate = new Promise((resolve) => (releaseGate = resolve));
  let releaseReached = false;
  const heldRelease = { on: true };
  setTaskOpDeps({
    workerPort: async () => ({ run: async (input) => outcome(input) }),
    authority: (w) => {
      const real = leaseAuthorityFor(w);
      return {
        ...real,
        release: async (...args) => {
          if (heldRelease.on) {
            releaseReached = true;
            await gate;
          }
          return real.release(...args);
        },
      };
    },
  });
  const call = (op, body) => sidecarOps.find((o) => o.op === op).handle({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
  });
  const task = (id, scope) => ({ id, requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: [scope], models: ['claude-sonnet-4-5'] });
  try {
    const first = await call('plan.submit', { plan: { tasks: [task('T0', 'z')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b0', limitMicroUsd: 5_000_000 } });
    assert.equal(first.body.leaseIds.length, 1);
    // T0's end is published (its task has left `running`); its lease release is held open.
    await until(() => releaseReached && !['leased', 'running'].includes(getTask(ws, 'T0').node.state), 'T0 to end with its release held');
    const second = await call('plan.submit', { plan: { tasks: [task('H1', 'a'), task('H2', 'b'), task('H3', 'c')] }, ownerId: 'alice', channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    assert.equal(second.body.leaseIds.length, 2, 'two slots are free: T0 no longer runs, only its lease record is still open');
    assert.equal(getTask(ws, 'H3').node.state, 'ready', 'the third waits for a slot');
  } finally {
    heldRelease.on = false;
    releaseGate();
    await drainBackgroundWorkers();
    setTaskOpDeps({});
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});
