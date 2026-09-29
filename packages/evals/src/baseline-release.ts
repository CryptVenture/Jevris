/**
 * The signed baseline release (C16; SSOT §18.3 and §18.5 as amended at 6d7222a).
 *
 * The baseline is a calibration release whose interval method is `beta-posterior`. Each model
 * quality is a prior: the pooled success rate and the real number of outcomes behind it. Route
 * learning counts it for at most `priorWeight` pseudo-outcomes (route-learning.ts). The release
 * is built from two kinds of source, which it lists as its holdout report (`baselineSources`):
 * - published benchmark rows (`BUNDLED_PUBLIC_PRIORS`), only at the effort the model runs at
 *   by default, because a row at another effort is not evidence for the default arm;
 * - the owner's seed run (`seed-priors.json` from `seed-run.mjs priors`), at the effort each arm
 *   ran at, named by the seed's selection hash and run-records hash.
 *
 * `threshold.value` is 1: outside the §18.5 posterior gate the release never routes (the router's
 * quality floor then eliminates every candidate). The output is a draft: only `releaseProposal`
 * with a named reviewer and the calibration signing key produces the released artifact.
 */
import { CalibrationArtifactContract, contentHash, type BaselineSource, type CalibrationArtifact, type ModelQuality } from '@jevris/contracts';

/** A published benchmark row (the `PublicPrior` shape in route-learning.ts). */
export interface BaselinePublishedRow {
  readonly priorSliceId: string;
  readonly modelId: string;
  readonly effort: string;
  readonly successRate: number;
  readonly trials: number;
  readonly benchmark: string;
  readonly sourceId: string;
  readonly url: string;
  readonly publishedOn: string;
  readonly fetchedOn: string;
}

/** One arm of the seed (an entry of seed-priors.json). */
export interface BaselineSeedRow extends BaselinePublishedRow {
  readonly successes?: number;
  readonly selectionHash?: string | null;
  readonly runsHash?: string | null;
  readonly meanTokens?: number | null;
  readonly meanApiEquivalentUsd?: number | null;
}

export interface BaselineInput {
  readonly id: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** The worker-readiness decision (core's `workerCalibrationContext`). */
  readonly context: {
    readonly decisionSpecId: string;
    readonly decisionSpecVersion: string;
    readonly questionHash: string;
    readonly model: { readonly modelId: string; readonly revisionHash: string };
    readonly encoderHash: string;
  };
  readonly published: readonly BaselinePublishedRow[];
  readonly seed: readonly BaselineSeedRow[];
  /** The model's default effort (the model registry), or null when it has none. */
  readonly defaultEffort: (modelId: string) => string | null;
  /** Benchmark slice to the release's slice id; identity when absent. */
  readonly sliceMap?: { readonly [priorSliceId: string]: string };
  /** The owner-locked activation threshold, recorded as the error budget. Default 0.10. */
  readonly activationThreshold?: number;
}

export interface BaselineReport {
  readonly included: readonly BaselineSource[];
  readonly excluded: readonly { readonly sourceId: string; readonly modelId: string; readonly effort: string; readonly priorSliceId: string; readonly reasonCode: string }[];
}

export type BaselineProposalResult =
  | { readonly ok: true; readonly proposal: Omit<CalibrationArtifact, 'signature' | 'reviewer'>; readonly report: BaselineReport }
  | { readonly ok: false; readonly reasonCode: 'NO_SEED' | 'SEED_HASHES_MISSING' | 'SEED_HASH_MISMATCH' | 'INVALID_ROW' | `INVALID_PROPOSAL:${string}` };

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0] as number;
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += (c[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the regularized incomplete beta (Numerical Recipes, betacf). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return h;
}

/** The regularized incomplete beta I_x(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The Jeffreys interval: the Beta(½ + s, ½ + f) posterior's central quantiles, with the lower end
 * 0 at no successes and the upper end 1 at no failures. Rounded outward to four places.
 */
export function jeffreysInterval(successes: number, trials: number, confidence = 0.95): { readonly lower: number; readonly upper: number } {
  const tail = (1 - confidence) / 2;
  const lower = successes === 0 ? 0 : betaQuantile(tail, successes + 0.5, trials - successes + 0.5);
  const upper = successes === trials ? 1 : betaQuantile(1 - tail, successes + 0.5, trials - successes + 0.5);
  return { lower: Math.floor(lower * 10_000) / 10_000, upper: Math.ceil(upper * 10_000) / 10_000 };
}

function validRow(row: BaselinePublishedRow): boolean {
  return (
    typeof row.modelId === 'string' &&
    typeof row.priorSliceId === 'string' &&
    EFFORTS.has(row.effort) &&
    Number.isInteger(row.trials) &&
    row.trials > 0 &&
    Number.isFinite(row.successRate) &&
    row.successRate >= 0 &&
    row.successRate <= 1 &&
    DATE.test(row.publishedOn) &&
    DATE.test(row.fetchedOn)
  );
}

/** Builds the draft baseline release. Nothing is signed or published here. */
export function proposeBaselineRelease(input: BaselineInput): BaselineProposalResult {
  if (input.seed.length === 0) return { ok: false, reasonCode: 'NO_SEED' };
  if ([...input.published, ...input.seed].some((row) => !validRow(row))) return { ok: false, reasonCode: 'INVALID_ROW' };
  const selectionHash = input.seed[0]?.selectionHash;
  const runsHash = input.seed[0]?.runsHash;
  if (typeof selectionHash !== 'string' || typeof runsHash !== 'string') return { ok: false, reasonCode: 'SEED_HASHES_MISSING' };
  if (input.seed.some((row) => row.selectionHash !== selectionHash || row.runsHash !== runsHash)) return { ok: false, reasonCode: 'SEED_HASH_MISMATCH' };
  const sliceOf = (priorSliceId: string): string => input.sliceMap?.[priorSliceId] ?? priorSliceId;
  const source = (row: BaselinePublishedRow, kind: 'published' | 'seed', successes: number): BaselineSource => ({
    kind,
    sourceId: row.sourceId,
    priorSliceId: row.priorSliceId,
    sliceId: sliceOf(row.priorSliceId),
    modelId: row.modelId,
    effort: row.effort as BaselineSource['effort'],
    successes,
    trials: row.trials,
    benchmark: row.benchmark.slice(0, 200),
    url: row.url,
    publishedOn: row.publishedOn,
    fetchedOn: row.fetchedOn,
    ...(kind === 'seed' ? { selectionHash, runsHash } : {}),
  });
  const included: BaselineSource[] = [];
  const excluded: BaselineReport['excluded'][number][] = [];
  for (const row of input.published) {
    if (row.effort !== input.defaultEffort(row.modelId)) {
      excluded.push({ sourceId: row.sourceId, modelId: row.modelId, effort: row.effort, priorSliceId: row.priorSliceId, reasonCode: 'EFFORT_NOT_DEFAULT' });
      continue;
    }
    included.push(source(row, 'published', Math.round(row.successRate * row.trials)));
  }
  const seedCost = new Map<string, { readonly usd: number | null; readonly tokens: number | null }>();
  for (const row of input.seed) {
    const successes = Number.isInteger(row.successes) ? (row.successes as number) : Math.round(row.successRate * row.trials);
    const s = source(row, 'seed', Math.min(successes, row.trials));
    included.push(s);
    seedCost.set(`${s.sliceId}\u0000${s.modelId}\u0000${s.effort}`, { usd: row.meanApiEquivalentUsd ?? null, tokens: row.meanTokens ?? null });
  }
  const groups = new Map<string, { sliceId: string; modelId: string; effort: BaselineSource['effort']; successes: number; trials: number }>();
  for (const s of included) {
    const key = `${s.sliceId}\u0000${s.modelId}\u0000${s.effort}`;
    const g = groups.get(key) ?? { sliceId: s.sliceId, modelId: s.modelId, effort: s.effort, successes: 0, trials: 0 };
    g.successes += s.successes;
    g.trials += s.trials;
    groups.set(key, g);
  }
  const qualities: ModelQuality[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, g]) => {
      const interval = jeffreysInterval(g.successes, g.trials);
      const cost = seedCost.get(key);
      return {
        modelId: g.modelId,
        sliceId: g.sliceId,
        effort: g.effort,
        lower: interval.lower,
        point: Math.round((g.successes / g.trials) * 10_000) / 10_000,
        upper: interval.upper,
        sampleSize: g.trials,
        ...(cost?.usd === null || cost?.usd === undefined ? {} : { meanCostMicroUsd: Math.round(cost.usd * 1_000_000) }),
        ...(cost?.tokens === null || cost?.tokens === undefined ? {} : { meanTokens: Math.round(cost.tokens) }),
      };
    });
  const slices = [...new Set(qualities.map((q) => q.sliceId))].sort();
  const permittedSlices = slices.map((sliceId) => {
    const n = qualities.filter((q) => q.sliceId === sliceId).reduce((sum, q) => sum + q.sampleSize, 0);
    return { sliceId, calibrationSampleSize: n, holdoutSampleSize: n };
  });
  const pooled = jeffreysInterval(
    [...groups.values()].reduce((sum, g) => sum + g.successes, 0),
    [...groups.values()].reduce((sum, g) => sum + g.trials, 0),
  );
  const proposal: Omit<CalibrationArtifact, 'signature' | 'reviewer'> = {
    id: input.id,
    schemaVersion: '1.0',
    releaseState: 'draft',
    decisionSpecId: input.context.decisionSpecId,
    decisionSpecVersion: input.context.decisionSpecVersion,
    dataset: { id: 'jevris-baseline', version: input.issuedAt.slice(0, 10), contentHash: contentHash(included) },
    questionHash: input.context.questionHash,
    model: input.context.model,
    encoderHash: input.context.encoderHash,
    threshold: { metric: 'noul-probability', value: 1, errorBudget: input.activationThreshold ?? 0.1 },
    permittedSlices,
    uncertaintyInterval: { lower: pooled.lower, upper: pooled.upper, confidenceLevel: 0.95, method: 'beta-posterior' },
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    expiryConditions: ['model-revision-changed', 'encoder-changed', 'question-changed', 'drift-detected', 'policy-changed'],
    modelQualities: qualities,
    baselineSources: included,
  };
  // The contract's checks (sources back every quality) run on the draft with a placeholder signature.
  const checked = CalibrationArtifactContract.validate({ ...proposal, reviewer: { id: 'draft-check', reviewedAt: input.issuedAt }, signature: { algorithm: 'ed25519', keyId: 'draft-check', value: `${'A'.repeat(86)}==` } });
  if (!checked.ok) return { ok: false, reasonCode: `INVALID_PROPOSAL:${checked.issues[0]?.path ?? ''}:${checked.issues[0]?.code ?? ''}` };
  return { ok: true, proposal, report: { included, excluded } };
}
