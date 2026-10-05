// The test budget scale in the sidecar (docs/testing.md "slow machines"): under JEVRIS_TEST=1 the
// runner may scale the op budgets with JEVRIS_TEST_BUDGET_SCALE, so a runner that stalls for seconds
// does not turn a correct DEADLINE into a red test. A sidecar outside a test run ignores the
// variable completely, and a test about a deadline keeps the exact budgets.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { EXACT_BUDGET_LIMITS, exactBudgets } from '../../../test/budget-scale.mjs';

const { defaultRequestTimeoutMs, startDaemon, sidecarRequest, probeSidecar, stopSidecarProcess } = await import('../dist/index.js');
const { effectiveLimits: effective } = await import('../dist/service.js');
const { SIDECAR_BUDGET_MS } = await import('@jevris/contracts');

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js');
const EXACT = { hot: 900, background: 5000, answer: 4000, scale: 1 };

const under = (value) => ({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: value });
const budgetsOf = (resolved) => ({ ...resolved.budgets });

test('the product budgets are 900 ms hot, 5 s background and 4 s on the answer lane, and the defaults are not changed', () => {
  assert.deepEqual({ ...SIDECAR_BUDGET_MS }, { hot: 900, background: 5000 });
  assert.deepEqual(budgetsOf(effective(undefined, {})), EXACT);
});

test('a test run scales the budgets it did not set, and a run without JEVRIS_TEST=1 ignores the variable', () => {
  assert.deepEqual(budgetsOf(effective(undefined, under('6'))), { hot: 5400, background: 30_000, answer: 24_000, scale: 6 });
  assert.deepEqual(effective(undefined, under('6')).limits.budgetMs, { hot: 5400, background: 30_000 });
  // The hello and frame timers scale with them: a stall of the loop must not close a connection whose client did send its frame.
  const timers = (resolved) => [resolved.limits.helloMs, resolved.limits.frameMs, resolved.limits.idleMs];
  assert.deepEqual(timers(effective(undefined, {})), [2000, 2000, 10_000]);
  assert.deepEqual(timers(effective(undefined, under('6'))), [12_000, 12_000, 10_000], 'the idle timer is not a deadline and is left alone');
  assert.deepEqual(timers(effective({ helloMs: 150, frameMs: 150 }, under('6'))), [150, 150, 10_000], 'explicit timers pin themselves');
  for (const env of [{ JEVRIS_TEST_BUDGET_SCALE: '6' }, { JEVRIS_TEST: '0', JEVRIS_TEST_BUDGET_SCALE: '6' }, { JEVRIS_TEST: '', JEVRIS_TEST_BUDGET_SCALE: '6' }]) {
    assert.deepEqual(budgetsOf(effective(undefined, env)), EXACT, JSON.stringify(env));
  }
  assert.deepEqual(budgetsOf(effective(undefined, under('nonsense'))), EXACT, 'an invalid scale is 1');
  // Limits that name other things still get the scaled budgets.
  assert.deepEqual(budgetsOf(effective({ maxConnections: 4 }, under('6'))), { hot: 5400, background: 30_000, answer: 24_000, scale: 6 });
});

test('explicit limits pin the budgets exactly: the scale is not applied, and the answer lane follows the hot budget as it always did', () => {
  const pinned = effective({ budgetMs: { hot: 250, background: 750 } }, under('6'));
  assert.deepEqual(budgetsOf(pinned), { hot: 250, background: 750, answer: 250, scale: 1 });
  assert.deepEqual(budgetsOf(effective({ budgetMs: { hot: 250, background: 750 }, answerBudgetMs: 400 }, under('6'))), { hot: 250, background: 750, answer: 400, scale: 1 });
  assert.deepEqual(budgetsOf(effective({ answerBudgetMs: 400 }, under('6'))), { hot: 5400, background: 30_000, answer: 400, scale: 6 });
  // The shared helper's limits are the product's exact budgets, whatever the runner set.
  assert.deepEqual(budgetsOf(effective(EXACT_BUDGET_LIMITS, under('6'))), EXACT);
  assert.equal(effective(EXACT_BUDGET_LIMITS, under('6')).limits.helloMs, 2000);
  assert.equal(effective(EXACT_BUDGET_LIMITS, under('6')).limits.frameMs, 2000);
});

test('a request that names no timeout waits 900 ms (hook), 5 s (mcp) or 5 s (cli), times the scale in a test run only', () => {
  assert.deepEqual(['hook', 'mcp', 'cli'].map((kind) => defaultRequestTimeoutMs(kind, {})), [900, 5000, 5000]);
  assert.deepEqual(['hook', 'mcp', 'cli'].map((kind) => defaultRequestTimeoutMs(kind, under('6'))), [5400, 30_000, 30_000]);
  assert.deepEqual(['hook', 'mcp', 'cli'].map((kind) => defaultRequestTimeoutMs(kind, { JEVRIS_TEST_BUDGET_SCALE: '6' })), [900, 5000, 5000], 'no JEVRIS_TEST: the variable is ignored');
});

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'jbs-')));
}

/** Runs `fn` with these variables set (undefined removes one) in this process, then restores them. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function healthOf(home) {
  const answer = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {}, timeoutMs: 30_000 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer.result;
}

/** An in-process daemon under `vars`, its health, then stopped. */
async function inProcessHealth(vars, options = {}) {
  const home = tempHome();
  try {
    return await withEnv(vars, async () => {
      const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification: false, modelOffer: false, ...options });
      assert.equal(started.ok, true, started.ok ? '' : started.message);
      try {
        return await healthOf(home);
      } finally {
        await started.daemon.stop('test');
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('a daemon reports the budgets it runs with: scaled only under JEVRIS_TEST=1, exact outside a test run or with pinned limits', async () => {
  const scaled = await inProcessHealth({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' });
  assert.deepEqual(scaled.budgetMs, { hot: 5400, background: 30_000, answer: 24_000 });
  assert.equal(scaled.budgetScale, 6);
  const outside = await inProcessHealth({ JEVRIS_TEST: undefined, JEVRIS_TEST_BUDGET_SCALE: '6' });
  assert.deepEqual(outside.budgetMs, { hot: 900, background: 5000, answer: 4000 }, 'no JEVRIS_TEST: the variable is ignored');
  assert.equal(outside.budgetScale, 1);
  const pinned = await inProcessHealth({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' }, { limits: EXACT_BUDGET_LIMITS });
  assert.deepEqual(pinned.budgetMs, { hot: 900, background: 5000, answer: 4000 });
  assert.equal(pinned.budgetScale, 1);
});

const children = new Set();
after(async () => {
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

/** A real sidecar process of `home` (main.js), started with exactly this environment. */
async function spawnSidecar(home, env) {
  const child = spawn(process.execPath, [MAIN, 'run', '--home', home, '--idle-ms', '120000'], { stdio: 'ignore', env, windowsHide: true });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const until = Date.now() + 60_000;
  while (Date.now() < until && !(await probeSidecar(home)).running) await new Promise((resolve) => setTimeout(resolve, 100));
  return child;
}

test('a spawned sidecar started without JEVRIS_TEST=1 ignores JEVRIS_TEST_BUDGET_SCALE; one started under it scales', async () => {
  // The product reads JEVRIS_TEST only for 1. The sidecar with no JEVRIS_TEST at all is the product's own case; the node test
  // context the child inherits (NODE_TEST_CONTEXT) and the runner's JEVRIS_NO_LIVE_HARNESS keep the keychain block and the
  // no-live-harness guard on for it, and it lives for a second. JEVRIS_TEST=0 is the same case with the marker present.
  const base = { ...process.env, JEVRIS_TEST_BUDGET_SCALE: '6' };
  const noMarker = { ...base };
  delete noMarker.JEVRIS_TEST;
  for (const [label, env, expected, scale] of [
    ['no JEVRIS_TEST', noMarker, { hot: 900, background: 5000, answer: 4000 }, 1],
    ['JEVRIS_TEST=0', { ...base, JEVRIS_TEST: '0' }, { hot: 900, background: 5000, answer: 4000 }, 1],
    ['JEVRIS_TEST=1', { ...base, JEVRIS_TEST: '1' }, { hot: 5400, background: 30_000, answer: 24_000 }, 6],
    ['JEVRIS_TEST=1, no scale', { ...exactBudgets(base), JEVRIS_TEST: '1' }, { hot: 900, background: 5000, answer: 4000 }, 1],
  ]) {
    const home = tempHome();
    const childEnv = { ...env, JEVRIS_HOME: home };
    try {
      const child = await withEnv({ JEVRIS_HOME: home }, () => spawnSidecar(home, childEnv));
      const health = await healthOf(home);
      assert.deepEqual(health.budgetMs, expected, label);
      assert.equal(health.budgetScale, scale, label);
      assert.equal(health.pid, child.pid, label);
    } finally {
      await stopSidecarProcess(home, 10_000).catch(() => undefined);
      for (const child of [...children]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('jevris sidecar status shows the scaled budgets only in a test run that scales, and a sandbox can pin them', { timeout: 240_000 }, async (t) => {
  await withEnv({ JEVRIS_TEST_BUDGET_SCALE: '6' }, async () => {
    const scaled = await sandbox(t);
    assert.equal(scaled.startSidecar().code, 0, 'the sidecar did not start');
    const text = scaled.jevris(['sidecar', 'status']);
    assert.match(text.stdout, /budgets: hot 5400 ms, background 30000 ms, answer lane 24000 ms \(test run: budgets scaled by 6\)/, text.stdout + text.stderr);
    const json = scaled.jevris(['sidecar', 'status'], { json: true }).json;
    assert.deepEqual(json.budgetMs, { hot: 5400, background: 30_000, answer: 24_000 });
    assert.equal(json.budgetScale, 6);

    const exact = await sandbox(t, { exactBudgets: true });
    assert.equal(exact.env.JEVRIS_TEST_BUDGET_SCALE, undefined, 'the pinned sandbox has no scale');
    assert.equal(exact.startSidecar().code, 0, 'the sidecar did not start');
    const plain = exact.jevris(['sidecar', 'status']);
    assert.match(plain.stdout, /budgets: hot 900 ms, background 5000 ms, answer lane 4000 ms\n/, plain.stdout + plain.stderr);
    assert.doesNotMatch(plain.stdout, /scaled/);
    assert.deepEqual(exact.jevris(['sidecar', 'status'], { json: true }).json.budgetMs, { hot: 900, background: 5000, answer: 4000 });
  });
});
