// The test budget scale (docs/testing.md "slow machines"): one function reads JEVRIS_TEST_BUDGET_SCALE,
// and only under JEVRIS_TEST=1. Outside a test run the product's budgets are exactly 900 ms hot and
// 5 s background.
import test from 'node:test';
import assert from 'node:assert/strict';

const { SIDECAR_BUDGET_MS, TEST_BUDGET_SCALE_MAX, sidecarBudgetsMs, testBudgetScale, testScaledMs } = await import('../dist/index.js');

const under = (value) => ({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: value });

test('the product budgets are 900 ms hot and 5 s background, and a scale of 1 leaves them alone', () => {
  assert.deepEqual({ ...SIDECAR_BUDGET_MS }, { hot: 900, background: 5000 });
  assert.deepEqual({ ...sidecarBudgetsMs({}) }, { hot: 900, background: 5000 });
  assert.deepEqual({ ...sidecarBudgetsMs(under('1')) }, { hot: 900, background: 5000 });
});

test('the scale is read only under JEVRIS_TEST=1: without it the variable does nothing', () => {
  for (const env of [{ JEVRIS_TEST_BUDGET_SCALE: '6' }, { JEVRIS_TEST: '', JEVRIS_TEST_BUDGET_SCALE: '6' }, { JEVRIS_TEST: '0', JEVRIS_TEST_BUDGET_SCALE: '6' }, { JEVRIS_TEST: 'true', JEVRIS_TEST_BUDGET_SCALE: '6' }]) {
    assert.equal(testBudgetScale(env), 1, JSON.stringify(env));
    assert.deepEqual({ ...sidecarBudgetsMs(env) }, { hot: 900, background: 5000 }, JSON.stringify(env));
    assert.equal(testScaledMs(4000, env), 4000, JSON.stringify(env));
  }
  assert.equal(testBudgetScale(under('6')), 6);
});

test('a scale from 1 to 20 (up to two decimals) multiplies the budgets; anything else is 1', () => {
  assert.equal(TEST_BUDGET_SCALE_MAX, 20);
  assert.deepEqual({ ...sidecarBudgetsMs(under('6')) }, { hot: 5400, background: 30_000 });
  assert.deepEqual({ ...sidecarBudgetsMs(under('20')) }, { hot: 18_000, background: 100_000 });
  assert.deepEqual({ ...sidecarBudgetsMs(under('2.5')) }, { hot: 2250, background: 12_500 });
  assert.equal(testScaledMs(4000, under('6')), 24_000, 'the hook deadline ceiling scales with it');
  for (const bad of ['', '0', '0.5', '21', '100', '-3', '6x', ' 6', '6 ', 'six', '1e1', '6.123', '.5', 'NaN', 'Infinity', '0x10']) {
    assert.equal(testBudgetScale(under(bad)), 1, JSON.stringify(bad));
  }
  assert.equal(testBudgetScale({ JEVRIS_TEST: '1' }), 1, 'no variable is a scale of 1');
});
