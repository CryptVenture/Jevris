/**
 * P12 (learning-coverage audit; owner decision DOMAINS 7922ee3): a person's feedback on a
 * decision's advice, with a reason (SPEC §18.5: "collect a reason where practical and distinguish
 * these labels"). The product counterpart of the evals package's `analyzeFeedback` (EVL-11).
 *
 * - A rejection is a preference, unavailable context or an actual error; they are counted apart, and
 *   only `error` counts against a decision's accuracy.
 * - The output is hypotheses for the release pipeline. Feedback never changes a policy, a
 *   threshold or a route (`policyChanged: false`).
 * - Text-free: ids, codes and counts. The rows live in the store and follow the decision window.
 */
import { FEEDBACK_REASONS, type FeedbackReason } from '@jevris/contracts';
import { wilsonInterval } from './route-learning.js';

/**
 * A reason a person may give: the §18.5 labels of the contracts' FEEDBACK_REASONS. `unspecified`
 * is only what a rejection without one records.
 */
export const GIVEN_FEEDBACK_REASONS: readonly FeedbackReason[] = Object.freeze(FEEDBACK_REASONS.filter((r) => r !== 'unspecified'));

export interface FeedbackRow {
  readonly decisionId: string;
  /** The decision's spec id. */
  readonly kind: string;
  readonly accepted: boolean;
  readonly reason: FeedbackReason | null;
}

export interface FeedbackKindReport {
  readonly kind: string;
  readonly total: number;
  readonly accepted: number;
  readonly rejectedBy: Readonly<Record<FeedbackReason, number>>;
  /** Rejections given as `error`, over all feedback of the kind (Wilson, 95%); null with none. */
  readonly errorRate: { readonly point: number; readonly lower: number; readonly upper: number } | null;
  /** Share of rejections without a reason; null without rejections. */
  readonly unlabelledShare: number | null;
  readonly hypotheses: readonly { readonly kind: 'possible-error' | 'unavailable-context' | 'preference-only'; readonly action: 'review-through-release-pipeline' }[];
}

export interface FeedbackReport {
  readonly schemaVersion: 'jevris-feedback-report-1';
  readonly total: number;
  readonly byKind: readonly FeedbackKindReport[];
  /** Always false: feedback never changes a policy by itself. */
  readonly policyChanged: false;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** The report over feedback rows. A decision counts once (its latest row is the caller's). */
export function feedbackReport(rows: readonly FeedbackRow[]): FeedbackReport {
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const byKind = kinds.map((kind): FeedbackKindReport => {
    const own = rows.filter((r) => r.kind === kind);
    const rejectedBy: Record<FeedbackReason, number> = { preference: 0, 'unavailable-context': 0, error: 0, unspecified: 0 };
    for (const r of own) if (!r.accepted) rejectedBy[r.reason !== null && FEEDBACK_REASONS.includes(r.reason) ? r.reason : 'unspecified'] += 1;
    const accepted = own.filter((r) => r.accepted).length;
    const rejected = own.length - accepted;
    const interval = own.length === 0 ? null : wilsonInterval(rejectedBy.error, own.length);
    const point = own.length === 0 ? 0 : rejectedBy.error / own.length;
    const hypotheses: FeedbackKindReport['hypotheses'][number][] = [];
    if (rejectedBy.error > 0) hypotheses.push({ kind: 'possible-error', action: 'review-through-release-pipeline' });
    if (rejectedBy['unavailable-context'] > 0) hypotheses.push({ kind: 'unavailable-context', action: 'review-through-release-pipeline' });
    if (rejected > 0 && rejectedBy.error === 0 && rejectedBy['unavailable-context'] === 0 && rejectedBy.preference > 0) hypotheses.push({ kind: 'preference-only', action: 'review-through-release-pipeline' });
    return {
      kind,
      total: own.length,
      accepted,
      rejectedBy,
      errorRate: interval === null ? null : { point: round4(point), lower: round4(Math.min(interval.lower, point)), upper: round4(Math.max(interval.upper, point)) },
      unlabelledShare: rejected === 0 ? null : round4(rejectedBy.unspecified / rejected),
      hypotheses,
    };
  });
  return { schemaVersion: 'jevris-feedback-report-1', total: rows.length, byKind, policyChanged: false };
}

/** Plain-text lines for cost-report and status. */
export function feedbackLines(report: FeedbackReport): string[] {
  if (report.total === 0) return ['Feedback on advice: none yet.'];
  return [
    `Feedback on advice: ${report.total} decision(s). Feedback never changes a policy; it gives hypotheses for a reviewed release.`,
    ...report.byKind.map((k) => {
      const r = k.rejectedBy;
      const rate = k.errorRate === null ? '' : `; error rate ${k.errorRate.point} (95% ${k.errorRate.lower} to ${k.errorRate.upper})`;
      return `${k.kind}: ${k.accepted} accepted, ${k.total - k.accepted} rejected (${r.error} error, ${r['unavailable-context']} unavailable context, ${r.preference} preference, ${r.unspecified} no reason)${rate}.`;
    }),
  ];
}
