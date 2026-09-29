/**
 * Calibration metrics (EVL-03, §18.3, C16).
 *
 * Binary: Brier score, log loss, reliability bins, precision and recall at a threshold,
 * abstention coverage. Choice: per-class confusion, top-choice accuracy and the rate at which
 * none/unknown is needed. Score: ordinal error and threshold-crossing error. Intervals: Wilson,
 * Clopper-Pearson (exact, by bisection on the binomial tail) and a seeded percentile bootstrap.
 *
 * No statistic here is a proof: zero failures in 300 independent trials still leaves about a
 * 1 % one-sided 95 % upper bound, under sampling assumptions adversarial behaviour rarely meets.
 */

export interface BinaryPrediction {
  /** Predicted probability of the positive outcome, or null when the decision abstained. */
  readonly probability: number | null;
  readonly outcome: boolean;
}

function assertProbability(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('PROBABILITY_RANGE');
  return p;
}

function answered(predictions: readonly BinaryPrediction[]): readonly { readonly p: number; readonly y: number }[] {
  return predictions.filter((x) => x.probability !== null).map((x) => ({ p: assertProbability(x.probability as number), y: x.outcome ? 1 : 0 }));
}

/** Mean squared error of the probability against the 0/1 outcome, over answered cases. */
export function brierScore(predictions: readonly BinaryPrediction[]): number | null {
  const rows = answered(predictions);
  if (rows.length === 0) return null;
  return rows.reduce((sum, r) => sum + (r.p - r.y) ** 2, 0) / rows.length;
}

/** Mean negative log likelihood (natural log), probabilities clipped to [eps, 1 - eps]. */
export function logLoss(predictions: readonly BinaryPrediction[], eps = 1e-15): number | null {
  const rows = answered(predictions);
  if (rows.length === 0) return null;
  return rows.reduce((sum, r) => {
    const p = Math.min(1 - eps, Math.max(eps, r.p));
    return sum - (r.y === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0) / rows.length;
}

export interface ReliabilityBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanPredicted: number | null;
  readonly observedRate: number | null;
}

/** Equal-width reliability bins; the last bin includes 1. */
export function reliabilityBins(predictions: readonly BinaryPrediction[], bins = 10): readonly ReliabilityBin[] {
  const rows = answered(predictions);
  const out: { lower: number; upper: number; count: number; sumP: number; sumY: number }[] = [];
  for (let i = 0; i < bins; i += 1) out.push({ lower: i / bins, upper: (i + 1) / bins, count: 0, sumP: 0, sumY: 0 });
  for (const r of rows) {
    const index = Math.min(bins - 1, Math.floor(r.p * bins));
    const bin = out[index] as (typeof out)[number];
    bin.count += 1;
    bin.sumP += r.p;
    bin.sumY += r.y;
  }
  return out.map((b) => ({ lower: b.lower, upper: b.upper, count: b.count, meanPredicted: b.count === 0 ? null : b.sumP / b.count, observedRate: b.count === 0 ? null : b.sumY / b.count }));
}

/** Expected calibration error: bin-weighted |mean predicted - observed rate|. */
export function expectedCalibrationError(predictions: readonly BinaryPrediction[], bins = 10): number | null {
  const total = answered(predictions).length;
  if (total === 0) return null;
  return reliabilityBins(predictions, bins).reduce((sum, b) => (b.count === 0 ? sum : sum + (b.count / total) * Math.abs((b.meanPredicted as number) - (b.observedRate as number))), 0);
}

export interface ThresholdStats {
  readonly threshold: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
  readonly precision: number | null;
  readonly recall: number | null;
  /** Share of all cases that received an answer (abstentions excluded). */
  readonly coverage: number;
}

/** Precision and recall when predicting positive at probability >= threshold. */
export function precisionRecallAt(predictions: readonly BinaryPrediction[], threshold: number): ThresholdStats {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of answered(predictions)) {
    const positive = r.p >= threshold;
    if (positive && r.y === 1) tp += 1;
    else if (positive) fp += 1;
    else if (r.y === 1) fn += 1;
    else tn += 1;
  }
  return {
    threshold,
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    coverage: abstentionCoverage(predictions),
  };
}

/** Fraction of cases the decision answered (did not abstain). */
export function abstentionCoverage(predictions: readonly BinaryPrediction[]): number {
  if (predictions.length === 0) return 0;
  return predictions.filter((x) => x.probability !== null).length / predictions.length;
}

export interface ChoicePrediction {
  /** The chosen option, or null when abstained. */
  readonly predicted: string | null;
  readonly actual: string;
}

/** Per-class confusion counts: confusion[actual][predicted]. Abstentions are under `abstain`. */
export function confusionMatrix(predictions: readonly ChoicePrediction[]): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const p of predictions) {
    const row = (out[p.actual] ??= {});
    const key = p.predicted ?? 'abstain';
    row[key] = (row[key] ?? 0) + 1;
  }
  return out;
}

/** Accuracy of the top choice over answered cases. */
export function topChoiceAccuracy(predictions: readonly ChoicePrediction[]): number | null {
  const rows = predictions.filter((p) => p.predicted !== null);
  if (rows.length === 0) return null;
  return rows.filter((p) => p.predicted === p.actual).length / rows.length;
}

/** How often the answer was the none/unknown option (or an abstention). */
export function noneRate(predictions: readonly ChoicePrediction[], noneKeys: readonly string[] = ['none', 'unknown', 'unclear']): number | null {
  if (predictions.length === 0) return null;
  return predictions.filter((p) => p.predicted === null || noneKeys.includes(p.predicted)).length / predictions.length;
}

export interface ScorePrediction {
  readonly predicted: number;
  readonly actual: number;
}

/** Mean absolute ordinal error, and how often the prediction lands on the wrong side of a threshold. */
export function ordinalError(predictions: readonly ScorePrediction[], threshold?: number): { readonly meanAbsoluteError: number | null; readonly thresholdCrossingRate: number | null } {
  if (predictions.length === 0) return { meanAbsoluteError: null, thresholdCrossingRate: null };
  const mae = predictions.reduce((sum, p) => sum + Math.abs(p.predicted - p.actual), 0) / predictions.length;
  const crossing = threshold === undefined ? null : predictions.filter((p) => p.predicted >= threshold !== p.actual >= threshold).length / predictions.length;
  return { meanAbsoluteError: mae, thresholdCrossingRate: crossing };
}

export interface ProportionInterval {
  readonly successes: number;
  readonly n: number;
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  readonly confidence: number;
  readonly method: 'wilson' | 'clopper-pearson' | 'bootstrap';
}

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9 after one Newton step). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('QUANTILE_RANGE');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // One Newton refinement against the normal CDF.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

function checkCounts(successes: number, n: number, confidence: number): void {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n <= 0 || successes < 0 || successes > n) throw new Error('COUNTS');
  if (!(confidence > 0 && confidence < 1)) throw new Error('CONFIDENCE');
}

/** Wilson score interval (two-sided). */
export function wilsonInterval(successes: number, n: number, confidence = 0.95): ProportionInterval {
  checkCounts(successes, n, confidence);
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { successes, n, point: p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), confidence, method: 'wilson' };
}

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i += 1) sum += Math.log((n - k + i) / i);
  return sum;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let total = 0;
  for (let i = 0; i <= k; i += 1) total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, total);
}

function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200; i += 1) {
    const m = (a + b) / 2;
    if (f(m) > 0) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/**
 * Clopper-Pearson exact interval. `sides` 2 splits alpha; 1 gives a one-sided upper bound
 * (lower 0) as used for "zero failures in n trials".
 */
export function clopperPearsonInterval(successes: number, n: number, confidence = 0.95, sides: 1 | 2 = 2): ProportionInterval {
  checkCounts(successes, n, confidence);
  const alpha = sides === 2 ? (1 - confidence) / 2 : 1 - confidence;
  // Lower: smallest p with P(X >= x | p) >= alpha. Upper: largest p with P(X <= x | p) >= alpha.
  const lower = sides === 1 || successes === 0 ? 0 : bisect((p) => alpha - (1 - binomialCdf(successes - 1, n, p)), 0, 1);
  const upper = successes === n ? 1 : bisect((p) => binomialCdf(successes, n, p) - alpha, 0, 1);
  return { successes, n, point: successes / n, lower, upper, confidence, method: 'clopper-pearson' };
}

/** Deterministic PRNG (mulberry32) for reproducible bootstrap intervals. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval for any statistic of a sample. */
export function bootstrapInterval<T>(sample: readonly T[], statistic: (resample: readonly T[]) => number, options: { readonly resamples?: number; readonly confidence?: number; readonly seed?: number } = {}): { readonly point: number; readonly lower: number; readonly upper: number; readonly confidence: number; readonly method: 'bootstrap' } {
  if (sample.length === 0) throw new Error('EMPTY_SAMPLE');
  const resamples = options.resamples ?? 2000;
  const confidence = options.confidence ?? 0.95;
  const random = seededRandom(options.seed ?? 1);
  const values: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const drawn: T[] = [];
    for (let i = 0; i < sample.length; i += 1) drawn.push(sample[Math.floor(random() * sample.length)] as T);
    values.push(statistic(drawn));
  }
  values.sort((x, y) => x - y);
  const at = (q: number): number => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))] as number;
  const alpha = (1 - confidence) / 2;
  return { point: statistic(sample), lower: at(alpha), upper: at(1 - alpha), confidence, method: 'bootstrap' };
}

/**
 * Ratio of two success proportions (treatment / baseline) with a Katz log interval. Used for
 * the verified-success ratio the quality gate reads.
 */
export function proportionRatio(treatment: { readonly successes: number; readonly n: number }, baseline: { readonly successes: number; readonly n: number }, confidence = 0.95): { readonly point: number; readonly lower: number; readonly upper: number } {
  // A 0.5 continuity correction keeps the interval finite when a count is zero.
  const a = treatment.successes === 0 || treatment.successes === treatment.n ? treatment.successes + 0.5 : treatment.successes;
  const b = baseline.successes === 0 || baseline.successes === baseline.n ? baseline.successes + 0.5 : baseline.successes;
  const n1 = a === treatment.successes ? treatment.n : treatment.n + 1;
  const n2 = b === baseline.successes ? baseline.n : baseline.n + 1;
  const ratio = a / n1 / (b / n2);
  const se = Math.sqrt(1 / a - 1 / n1 + 1 / b - 1 / n2);
  const z = normalQuantile(1 - (1 - confidence) / 2);
  return { point: treatment.successes / treatment.n / (baseline.successes / baseline.n || Number.NaN), lower: ratio * Math.exp(-z * se), upper: ratio * Math.exp(z * se) };
}
