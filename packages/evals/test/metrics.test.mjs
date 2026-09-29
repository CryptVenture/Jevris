import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../dist/index.js');
const close = (actual, expected, tol = 1e-4, label = '') => assert.ok(Math.abs(actual - expected) <= tol, `${label} ${actual} vs ${expected}`);

const P = (probability, outcome) => ({ probability, outcome });

test('EVL-03: Brier score, log loss and reliability match closed-form values', () => {
  const rows = [P(0.9, true), P(0.8, true), P(0.3, false), P(0.6, false), P(null, true)];
  // (0.01 + 0.04 + 0.09 + 0.36) / 4
  close(m.brierScore(rows), 0.125, 1e-12, 'brier');
  const expected = -(Math.log(0.9) + Math.log(0.8) + Math.log(0.7) + Math.log(0.4)) / 4;
  close(m.logLoss(rows), expected, 1e-12, 'logloss');
  assert.equal(m.brierScore([P(null, true)]), null);
  const bins = m.reliabilityBins(rows, 2);
  assert.deepEqual(bins.map((b) => b.count), [1, 3]);
  close(bins[1].meanPredicted, (0.9 + 0.8 + 0.6) / 3, 1e-12);
  close(bins[1].observedRate, 2 / 3, 1e-12);
  const perfect = [P(1, true), P(0, false)];
  assert.equal(m.brierScore(perfect), 0);
  assert.equal(m.expectedCalibrationError(perfect), 0);
  assert.throws(() => m.brierScore([P(1.2, true)]), /PROBABILITY_RANGE/);
});

test('EVL-03: precision, recall and abstention coverage at a threshold', () => {
  const rows = [P(0.9, true), P(0.8, false), P(0.7, true), P(0.2, true), P(0.1, false), P(null, false)];
  const at = m.precisionRecallAt(rows, 0.5);
  assert.deepEqual([at.truePositive, at.falsePositive, at.falseNegative, at.trueNegative], [2, 1, 1, 1]);
  close(at.precision, 2 / 3, 1e-12);
  close(at.recall, 2 / 3, 1e-12);
  close(at.coverage, 5 / 6, 1e-12);
  assert.equal(m.precisionRecallAt([P(0.1, false)], 0.5).precision, null);
});

test('EVL-03: per-class confusion, top-choice accuracy, none rate and ordinal error', () => {
  const rows = [
    { predicted: 'a', actual: 'a' },
    { predicted: 'b', actual: 'a' },
    { predicted: 'unknown', actual: 'b' },
    { predicted: null, actual: 'b' },
  ];
  assert.deepEqual(m.confusionMatrix(rows), { a: { a: 1, b: 1 }, b: { unknown: 1, abstain: 1 } });
  close(m.topChoiceAccuracy(rows), 1 / 3, 1e-12);
  close(m.noneRate(rows), 0.5, 1e-12);
  const scores = [{ predicted: 7, actual: 5 }, { predicted: 3, actual: 4 }, { predicted: 6, actual: 6 }];
  const ordinal = m.ordinalError(scores, 5);
  close(ordinal.meanAbsoluteError, 1, 1e-12);
  close(ordinal.thresholdCrossingRate, 0, 1e-12);
  close(m.ordinalError([{ predicted: 6, actual: 4 }], 5).thresholdCrossingRate, 1, 1e-12);
});

test('EVL-03: Wilson and Clopper-Pearson intervals match published values', () => {
  close(m.normalQuantile(0.975), 1.959963985, 1e-7, 'z');
  const w = m.wilsonInterval(81, 263);
  close(w.lower, 0.2553, 5e-4, 'wilson lower');
  close(w.upper, 0.3662, 5e-4, 'wilson upper');
  const cp = m.clopperPearsonInterval(3, 10);
  close(cp.lower, 0.06674, 1e-4, 'cp lower');
  close(cp.upper, 0.65245, 1e-4, 'cp upper');
  // Zero failures in 300 trials: the one-sided 95 % upper bound is 1 - 0.05^(1/300), about 1 % (§18.3).
  const zero = m.clopperPearsonInterval(0, 300, 0.95, 1);
  close(zero.upper, 1 - 0.05 ** (1 / 300), 1e-6, 'zero of 300');
  assert.ok(zero.upper > 0.0099 && zero.upper < 0.01);
  close(m.clopperPearsonInterval(10, 10).lower, 0.025 ** (1 / 10), 1e-6, 'all successes');
  assert.throws(() => m.wilsonInterval(5, 3), /COUNTS/);
});

test('EVL-03: the bootstrap is seeded and brackets the statistic; the ratio interval is finite at zero counts', () => {
  const sample = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 1 : 0));
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const a = m.bootstrapInterval(sample, mean, { seed: 7, resamples: 500 });
  const b = m.bootstrapInterval(sample, mean, { seed: 7, resamples: 500 });
  assert.deepEqual(a, b, 'deterministic for a seed');
  assert.ok(a.lower < 0.25 && a.upper > 0.25);
  const ratio = m.proportionRatio({ successes: 90, n: 100 }, { successes: 90, n: 100 });
  close(ratio.point, 1, 1e-12);
  assert.ok(ratio.lower < 1 && ratio.upper > 1);
  const edge = m.proportionRatio({ successes: 100, n: 100 }, { successes: 0, n: 100 });
  assert.ok(Number.isFinite(edge.lower) && Number.isFinite(edge.upper));
});
