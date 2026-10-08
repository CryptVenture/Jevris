/**
 * The tier side of a subagent route (owner decisions 2026-10-08, tiered routing, step 2b; every harness, provider-neutral).
 *
 * A subagent launch that no learned route or signed prior covers is decided by the shared model tier, with no new Jev
 * call (the hook is on the hot path):
 *
 * - DOWN, by the launch's own risk (`subagent-risk.ts`): low risk goes to the session model's provider's cheapest rung,
 *   medium to its step-down rung when that is a different, dearer rung than the cheapest (a Sonnet session has only
 *   Haiku below it, so medium changes nothing; an Opus session has Haiku and Sonnet). Never to another provider.
 * - UP, by the session's tier: a write-capable launch goes to the step-up rung only when the shared tier rule judged the
 *   session's own work step-up (a protected path other than a lockfile, a migration, a wide change, repeated failures, ...) and a
 *   fresh memo of that judgement exists (`session-tier-memo.ts`, ten minutes). A read-only launch (Explore, Plan) never
 *   goes up. This is a rules default, never a learned route or a signed prior.
 *
 * The ladder is the one `buildTierLadder` builds from the models eligible for the session on this harness and sign-in
 * (local evidence, or Claude Code's alias proof), so a harness with no such evidence has no ladder and the route stays
 * dormant there. Pure: no I/O.
 */
import type { ModelTier, TierLadder, TierLadderNone } from './model-tier.js';
import type { SessionTierMemo } from './session-tier-memo.js';

/** What a subagent route reads of the session's ladder and tier. Ids and codes only. */
export interface SubagentTierInput {
  /** The session model's id (the baseline the ladder is built around). */
  readonly baselineModelId: string;
  /** Low risk: the provider's cheapest rung below the baseline, or null when there is none. */
  readonly lowModelId: string | null;
  /** Medium risk: the step-down rung, only when it is not also the cheapest rung; else null. */
  readonly midModelId: string | null;
  /** A write-capable launch under a step-up session: the step-up rung, or null (no memo, or the tier is not step-up). */
  readonly upModelId: string | null;
  /** The session's tier from a fresh memo, or null when there is none. */
  readonly sessionTier: ModelTier | null;
  /** The memo's `TIER_*` reason codes (why the session was judged step-up). */
  readonly tierReasonCodes: readonly string[];
}

/** The subagent tier input from a ladder and the session's memo (null when no ladder). */
export function subagentTierOf(ladder: TierLadder | TierLadderNone, memo: SessionTierMemo | null): SubagentTierInput | null {
  if ('none' in ladder) return null;
  const below = ladder.candidates.slice(0, ladder.baselineIndex);
  const cheapest = below[0] ?? null;
  const down = ladder.stepDownIndex === null ? null : (ladder.candidates[ladder.stepDownIndex] ?? null);
  const fresh = memo !== null && memo.baselineModelId === ladder.baselineModelId ? memo : null;
  let up: string | null = null;
  if (fresh !== null && fresh.tier === 'step-up') {
    const above = ladder.candidates.slice(ladder.baselineIndex + 1).map((c) => c.modelId);
    up = above.includes(fresh.targetModelId) ? fresh.targetModelId : (above[0] ?? null);
  }
  return {
    baselineModelId: ladder.baselineModelId,
    lowModelId: cheapest === null ? null : cheapest.modelId,
    midModelId: down === null || cheapest === null || down.modelId === cheapest.modelId ? null : down.modelId,
    upModelId: up,
    sessionTier: fresh === null ? null : fresh.tier,
    tierReasonCodes: fresh === null ? [] : fresh.reasonCodes.slice(0, 4),
  };
}
