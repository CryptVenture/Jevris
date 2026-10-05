// The test budget scale from the runner's side (docs/testing.md "slow machines"): the runner sets it on
// Windows under CI and nowhere else by default, a caller's own value wins, the scripts that measure the
// product's real budgets never see it, and a test pins its budgets through one shared helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WINDOWS_CI_BUDGET_SCALE, budgetScaleFor, testEnvironment } from '../scripts/test.mjs';
import { BUDGET_SCALE_VARIABLE, EXACT_BUDGET_LIMITS, SIDECAR_WAIT_VARIABLE, budgetScaleOf, exactBudgets, latencyBound, slowHostSettings, startWaitMs, withExactBudgets } from './budget-scale.mjs';

const { defaultRequestTimeoutMs, sidecarWaitMs } = await import('@jevris/sidecar');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const text = (...parts) => readFileSync(join(root, ...parts), 'utf8');

test('Windows under CI gets a scale of 6 by default, and macOS, Linux and a Windows developer machine get none', () => {
  assert.equal(DEFAULT_WINDOWS_CI_BUDGET_SCALE, '6');
  assert.equal(budgetScaleFor({ CI: 'true' }, 'win32'), '6');
  assert.equal(budgetScaleFor({ CI: '1' }, 'win32'), '6');
  for (const platform of ['darwin', 'linux']) assert.equal(budgetScaleFor({ CI: 'true' }, platform), undefined, `${platform} under CI keeps the real budgets`);
  assert.equal(budgetScaleFor({}, 'win32'), undefined, 'a Windows machine that is not CI keeps the real budgets');
  assert.equal(budgetScaleFor({ CI: '' }, 'win32'), undefined);
});

test('a caller\'s own JEVRIS_TEST_BUDGET_SCALE always wins: 1 turns the Windows default off, and a number forces a scale anywhere', () => {
  assert.equal(budgetScaleFor({ CI: 'true', [BUDGET_SCALE_VARIABLE]: '1' }, 'win32'), '1');
  assert.equal(budgetScaleFor({ CI: 'true', [BUDGET_SCALE_VARIABLE]: '12' }, 'win32'), '12');
  assert.equal(budgetScaleFor({ [BUDGET_SCALE_VARIABLE]: '6' }, 'darwin'), '6');
  assert.equal(budgetScaleFor({ [BUDGET_SCALE_VARIABLE]: '6' }, 'linux'), '6');
  assert.equal(budgetScaleFor({ CI: 'true', [BUDGET_SCALE_VARIABLE]: '' }, 'win32'), '6', 'an empty value is no value');
  assert.equal(budgetScaleFor({ [BUDGET_SCALE_VARIABLE]: '' }, 'darwin'), undefined);
});

test('the suite run sets the scale for its test processes; the environment the scripts build their children from never carries it', () => {
  const before = process.env[BUDGET_SCALE_VARIABLE];
  process.env[BUDGET_SCALE_VARIABLE] = '6';
  try {
    const env = testEnvironment('/h', '/real');
    assert.equal(Object.hasOwn(env, BUDGET_SCALE_VARIABLE), false, 'a script that measures the real budgets would inherit the scale');
    assert.equal(env.JEVRIS_TEST, '1');
  } finally {
    if (before === undefined) delete process.env[BUDGET_SCALE_VARIABLE];
    else process.env[BUDGET_SCALE_VARIABLE] = before;
  }
  assert.match(text('scripts', 'test.mjs'), /JEVRIS_TEST_BUDGET_SCALE: budgetScaleFor\(process\.env\)/, 'the runner puts the scale in its own test processes');
});

test('the scripts that measure or drive the real budgets start their products without the scale', () => {
  // The benchmark, the load script, the drills and the threat-model suite build their child environments with testEnvironment, which strips it.
  for (const script of ['bench.mjs', 'load.mjs', 'ops-drills.mjs', 'threat-model-suite.mjs']) {
    assert.match(text('apps', 'sidecar', 'scripts', script), /testEnvironment\(/, `${script} builds its child environment with testEnvironment`);
    assert.equal(text('apps', 'sidecar', 'scripts', script).includes(BUDGET_SCALE_VARIABLE), false, `${script} reads no scale`);
  }
  // The Jev feature suite scales nothing on its hot path: it clears the variable before it starts that sidecar.
  const features = text('apps', 'sidecar', 'scripts', 'jev-features.mjs');
  const clear = features.indexOf(`delete process.env.${BUDGET_SCALE_VARIABLE}`);
  const hotBoot = features.indexOf("startSidecar('hot', hotMicroUsd)");
  assert.ok(clear > 0 && hotBoot > clear, 'the hot-path sidecar starts after the scale is cleared');
  // The engine-overhead script starts no sidecar and reads no scale.
  const overhead = text('apps', 'sidecar', 'scripts', 'engine-overhead.mjs');
  assert.equal(overhead.includes(BUDGET_SCALE_VARIABLE), false);
  assert.equal(/ensureSidecar|startDaemon|spawnSidecar/.test(overhead), false);
});

test('exactBudgets gives a child an environment with no scale, and EXACT_BUDGET_LIMITS are the product\'s own', () => {
  const scaled = { JEVRIS_TEST: '1', [BUDGET_SCALE_VARIABLE]: '6', PATH: '/bin' };
  assert.equal(budgetScaleOf(scaled), 6);
  const pinned = exactBudgets(scaled);
  assert.equal(budgetScaleOf(pinned), 1);
  assert.deepEqual(pinned, { JEVRIS_TEST: '1', PATH: '/bin' });
  assert.equal(scaled[BUDGET_SCALE_VARIABLE], '6', 'the caller\'s environment is not changed');
  assert.deepEqual(JSON.parse(JSON.stringify(EXACT_BUDGET_LIMITS)), { budgetMs: { hot: 900, background: 5000 }, answerBudgetMs: 4000, helloMs: 2000, frameMs: 2000 });
});

test('withExactBudgets takes the scale out of this process for the call, and puts it back, also when the call throws', async () => {
  const before = process.env[BUDGET_SCALE_VARIABLE];
  process.env[BUDGET_SCALE_VARIABLE] = '6';
  try {
    assert.equal(await withExactBudgets(async () => process.env[BUDGET_SCALE_VARIABLE]), undefined, 'no scale inside the call');
    assert.equal(process.env[BUDGET_SCALE_VARIABLE], '6', 'the scale is back after it');
    await assert.rejects(() => withExactBudgets(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(process.env[BUDGET_SCALE_VARIABLE], '6', 'the scale is back after a throw');
    delete process.env[BUDGET_SCALE_VARIABLE];
    assert.equal(await withExactBudgets(async () => 'ok'), 'ok');
    assert.equal(Object.hasOwn(process.env, BUDGET_SCALE_VARIABLE), false, 'a run with no scale stays without one');
  } finally {
    if (before === undefined) delete process.env[BUDGET_SCALE_VARIABLE];
    else process.env[BUDGET_SCALE_VARIABLE] = before;
  }
});

test('slowHostSettings gives a child whose environment a test builds by hand the runner\'s own: the test marker, the start wait and the scale, and nothing else of this process', () => {
  assert.deepEqual(slowHostSettings({}), { JEVRIS_TEST: '1', [SIDECAR_WAIT_VARIABLE]: '60000' }, 'no runner: the 60 s wait, no scale');
  assert.deepEqual(
    slowHostSettings({ [SIDECAR_WAIT_VARIABLE]: '45000', [BUDGET_SCALE_VARIABLE]: '6', PATH: '/bin', HOME: '/h', JEVRIS_HOME: '/h' }),
    { JEVRIS_TEST: '1', [SIDECAR_WAIT_VARIABLE]: '45000', [BUDGET_SCALE_VARIABLE]: '6' },
    'the runner\'s wait and scale pass through; no other variable does',
  );
  assert.deepEqual(slowHostSettings({ [SIDECAR_WAIT_VARIABLE]: 'soon', [BUDGET_SCALE_VARIABLE]: '' }), { JEVRIS_TEST: '1', [SIDECAR_WAIT_VARIABLE]: '60000' }, 'a malformed wait and an empty scale are no value');
  assert.deepEqual(slowHostSettings(), slowHostSettings(process.env), 'it reads this process by default');
});

test('what slowHostSettings gives is what the product honors: a 60 s sidecar start wait and the scaled request wait, where the same child with nothing, or with the wait variable alone, gets the product\'s 5 s', () => {
  const settings = slowHostSettings({ [BUDGET_SCALE_VARIABLE]: '6' });
  assert.equal(sidecarWaitMs(5000, {}), 5000, 'a bare environment: the product\'s own wait');
  assert.equal(sidecarWaitMs(5000, { [SIDECAR_WAIT_VARIABLE]: '60000' }), 5000, 'the wait variable alone does nothing: the product reads it only under JEVRIS_TEST=1');
  assert.equal(sidecarWaitMs(5000, settings), 60_000);
  assert.equal(defaultRequestTimeoutMs('cli', {}), 5000);
  assert.equal(defaultRequestTimeoutMs('cli', settings), 30_000, 'a `sidecar status` request waits 5 s times the scale');
  assert.equal(defaultRequestTimeoutMs('cli', exactBudgets(settings)), 5000, 'a deadline test pins it');
  for (const wait of ['2000', '45000', '60000', '999999999']) {
    const own = slowHostSettings({ [SIDECAR_WAIT_VARIABLE]: wait });
    assert.equal(startWaitMs(own), sidecarWaitMs(5000, own), `startWaitMs mirrors the product's wait for ${wait}`);
  }
  assert.equal(startWaitMs(), startWaitMs(slowHostSettings()));
});

test('latencyBound is the quiet bound plus ten of this run\'s own quiet measurements, times the run\'s scale, never past its cap', () => {
  const quiet = { JEVRIS_TEST: '1' };
  const scaled = { JEVRIS_TEST: '1', [BUDGET_SCALE_VARIABLE]: '6' };
  // A developer machine: the plain bound, and the host's own commit time added.
  assert.equal(latencyBound(400, { env: quiet }), 400);
  assert.equal(latencyBound(400, { quietMs: 2.5, env: quiet }), 425);
  assert.equal(latencyBound(50, { quietMs: 1, quietMultiple: 2, env: quiet }), 52);
  // The Windows runner and test:slow (scale 6): six times longer, and the cap keeps it far under what it excludes.
  assert.equal(latencyBound(400, { env: scaled }), 2400);
  assert.equal(latencyBound(400, { quietMs: 2.5, capMs: 1500, env: scaled }), 1500);
  assert.equal(latencyBound(50, { capMs: 100, env: scaled }), 100, 'the cap of a small bound');
  assert.equal(latencyBound(50, { capMs: 100, env: quiet }), 50, 'a cap above the bound changes nothing');
  // The scale is read the product\'s way: only under JEVRIS_TEST=1, and a bad value is no scale.
  assert.equal(latencyBound(400, { env: { [BUDGET_SCALE_VARIABLE]: '6' } }), 400, 'no JEVRIS_TEST, no scale');
  assert.equal(latencyBound(400, { env: { JEVRIS_TEST: '1', [BUDGET_SCALE_VARIABLE]: 'fast' } }), 400);
  assert.equal(latencyBound(400, { quietMs: -5, env: quiet }), 400, 'a negative measurement adds nothing');
  assert.throws(() => latencyBound(0), RangeError);
  assert.throws(() => latencyBound(Number.NaN), RangeError);
});
