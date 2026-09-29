/**
 * Feedback analysis, sandboxed replay and logged-propensity exploration (EVL-11, §18.5).
 *
 * - A rejected recommendation may reflect preference, missing context or an actual error; the
 *   three are counted separately, and only errors count against a decision's accuracy.
 * - Production feedback yields hypotheses for the release pipeline; it never changes a policy.
 * - A logged success under one model says nothing measured about another. Alternatives are
 *   evaluated by sandboxed replay (measured in the sandbox, labelled as such) or by narrowly
 *   randomized exploration with logged propensities, and only for low-risk actions. No function
 *   here reports a saving from an unobserved alternative.
 */
import { seededRandom, wilsonInterval } from './metrics.js';

export const FEEDBACK_REASONS = ['preference', 'missing-context', 'error', 'unspecified'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export interface FeedbackRecord {
  readonly recommendationId: string;
  readonly decisionSpecId: string;
  readonly accepted: boolean;
  /** Present on rejections when the person gave a reason. */
  readonly reason?: FeedbackReason;
}

export interface FeedbackAnalysis {
  readonly decisionSpecId: string;
  readonly total: number;
  readonly accepted: number;
  readonly rejectedBy: Readonly<Record<FeedbackReason, number>>;
  /** Rejections labelled `error`, over all feedback, with a Wilson interval. */
  readonly errorRate: { readonly point: number; readonly lower: number; readonly upper: number } | null;
  /** Share of rejections without a reason; a high share weakens every conclusion. */
  readonly unlabelledShare: number | null;
  readonly hypotheses: readonly { readonly kind: 'possible-error' | 'missing-context' | 'preference-only'; readonly detail: string; readonly action: 'review-through-release-pipeline' }[];
  /** Always false: feedback never changes a policy by itself. */
  readonly policyChanged: false;
}

export function analyzeFeedback(records: readonly FeedbackRecord[]): readonly FeedbackAnalysis[] {
  const specs = [...new Set(records.map((r) => r.decisionSpecId))].sort();
  return specs.map((decisionSpecId) => {
    const own = records.filter((r) => r.decisionSpecId === decisionSpecId);
    const rejectedBy: Record<FeedbackReason, number> = { preference: 0, 'missing-context': 0, error: 0, unspecified: 0 };
    for (const r of own) if (!r.accepted) rejectedBy[r.reason ?? 'unspecified'] += 1;
    const rejected = own.length - own.filter((r) => r.accepted).length;
    const errorRate = own.length === 0 ? null : wilsonInterval(rejectedBy.error, own.length);
    const hypotheses: FeedbackAnalysis['hypotheses'][number][] = [];
    if (rejectedBy.error > 0) hypotheses.push({ kind: 'possible-error', detail: `${rejectedBy.error} of ${own.length} recommendations rejected as wrong`, action: 'review-through-release-pipeline' });
    if (rejectedBy['missing-context'] > 0) hypotheses.push({ kind: 'missing-context', detail: `${rejectedBy['missing-context']} rejections cite context the decision did not have`, action: 'review-through-release-pipeline' });
    if (rejected > 0 && rejectedBy.error === 0 && rejectedBy['missing-context'] === 0 && rejectedBy.preference > 0) hypotheses.push({ kind: 'preference-only', detail: 'rejections are preferences, not errors', action: 'review-through-release-pipeline' });
    return {
      decisionSpecId,
      total: own.length,
      accepted: own.length - rejected,
      rejectedBy,
      errorRate: errorRate === null ? null : { point: errorRate.point, lower: errorRate.lower, upper: errorRate.upper },
      unlabelledShare: rejected === 0 ? null : rejectedBy.unspecified / rejected,
      hypotheses,
      policyChanged: false,
    };
  });
}

export interface ReplayCase<I> {
  readonly caseId: string;
  readonly input: I;
  readonly loggedPolicy: string;
  readonly loggedSucceeded: boolean;
}

export interface ReplayResult {
  readonly caseId: string;
  readonly policy: string;
  readonly succeeded: boolean;
  /** Replay outcomes are measured in the sandbox, not observed in production. */
  readonly measuredIn: 'sandbox';
}

/**
 * Runs an alternative policy on recorded inputs, each in a fresh sandbox the runner provides.
 * The result is a sandbox measurement; it is never presented as a production saving.
 */
export async function sandboxedReplay<I>(cases: readonly ReplayCase<I>[], policy: string, runner: { run(input: I, policy: string): Promise<{ readonly succeeded: boolean; readonly sandboxed: boolean }> }): Promise<{ readonly results: readonly ReplayResult[]; readonly refused: readonly string[]; readonly savingClaim: null }> {
  const results: ReplayResult[] = [];
  const refused: string[] = [];
  for (const c of cases) {
    const out = await runner.run(c.input, policy);
    // A run outside a sandbox is refused rather than counted.
    if (!out.sandboxed) {
      refused.push(c.caseId);
      continue;
    }
    results.push({ caseId: c.caseId, policy, succeeded: out.succeeded, measuredIn: 'sandbox' });
  }
  return { results, refused, savingClaim: null };
}

export interface ExplorationChoice {
  readonly action: string;
  readonly propensity: number;
  readonly explored: boolean;
  readonly reasonCode: 'EXPLORED' | 'DEFAULT' | 'RISK_NOT_LOW' | 'EXPLORATION_DISABLED';
}

/**
 * Narrow exploration: with probability `epsilon`, a low-risk decision picks uniformly among the
 * safe alternatives; otherwise the default. The propensity of the chosen action is returned so
 * it can be logged. Any risk other than `low` never explores.
 */
export function exploreSafely(input: { readonly defaultAction: string; readonly alternatives: readonly string[]; readonly risk: 'low' | 'medium' | 'high'; readonly epsilon: number; readonly random: () => number }): ExplorationChoice {
  if (input.risk !== 'low') return { action: input.defaultAction, propensity: 1, explored: false, reasonCode: 'RISK_NOT_LOW' };
  const alternatives = input.alternatives.filter((a) => a !== input.defaultAction);
  const epsilon = Math.min(0.2, Math.max(0, input.epsilon));
  if (epsilon === 0 || alternatives.length === 0) return { action: input.defaultAction, propensity: 1, explored: false, reasonCode: 'EXPLORATION_DISABLED' };
  const each = epsilon / alternatives.length;
  if (input.random() < epsilon) {
    const pick = alternatives[Math.min(alternatives.length - 1, Math.floor(input.random() * alternatives.length))] as string;
    return { action: pick, propensity: each, explored: true, reasonCode: 'EXPLORED' };
  }
  return { action: input.defaultAction, propensity: 1 - epsilon, explored: false, reasonCode: 'DEFAULT' };
}

export interface LoggedDecision {
  readonly action: string;
  readonly propensity: number;
  readonly reward: number;
}

/**
 * Self-normalized inverse-propensity estimate of a target policy's mean reward from logged
 * decisions, with a seeded bootstrap interval. It is labelled an estimate: never a measured saving.
 */
export function inversePropensityEstimate(logs: readonly LoggedDecision[], target: (action: string) => number, options: { readonly seed?: number; readonly resamples?: number } = {}): { readonly estimate: number | null; readonly lower: number | null; readonly upper: number | null; readonly effectiveSamples: number; readonly label: 'off-policy-estimate'; readonly savingClaim: null } {
  const valid = logs.filter((l) => l.propensity > 0 && l.propensity <= 1);
  const snips = (sample: readonly LoggedDecision[]) => {
    let num = 0;
    let den = 0;
    for (const l of sample) {
      const w = target(l.action) / l.propensity;
      num += w * l.reward;
      den += w;
    }
    return den === 0 ? Number.NaN : num / den;
  };
  const point = valid.length === 0 ? Number.NaN : snips(valid);
  let weightSum = 0;
  let weightSq = 0;
  for (const l of valid) {
    const w = target(l.action) / l.propensity;
    weightSum += w;
    weightSq += w * w;
  }
  const effectiveSamples = weightSq === 0 ? 0 : weightSum ** 2 / weightSq;
  if (!Number.isFinite(point)) return { estimate: null, lower: null, upper: null, effectiveSamples, label: 'off-policy-estimate', savingClaim: null };
  const random = seededRandom(options.seed ?? 23);
  const values: number[] = [];
  for (let r = 0; r < (options.resamples ?? 1000); r += 1) {
    const drawn: LoggedDecision[] = [];
    for (let i = 0; i < valid.length; i += 1) drawn.push(valid[Math.floor(random() * valid.length)] as LoggedDecision);
    const v = snips(drawn);
    if (Number.isFinite(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  const at = (q: number) => (values.length === 0 ? null : (values[Math.min(values.length - 1, Math.floor(q * values.length))] as number));
  return { estimate: point, lower: at(0.025), upper: at(0.975), effectiveSamples, label: 'off-policy-estimate', savingClaim: null };
}
