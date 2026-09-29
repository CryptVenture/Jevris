/**
 * Three-arm shadow comparison. Not an observe file and not a decision row.
 * No source field. No vendor-ratio field. The agent is not changed.
 */

export const SHADOW_COMPARISON_SCHEMA_VERSION = '1.0' as const;

export const SHADOW_COMPARISON_KEYS = [
  'schemaVersion',
  'mode',
  'policyVersion',
  'rulesRecommendation',
  'nativeRecommendation',
  'jevRecommendation',
  'actualModel',
  'actualWorker',
  'applied',
  'appliedAction',
  'actuationCount',
  'sent',
  'explanation',
] as const;

export const SHADOW_RECORDED_EXPLANATION =
  'Shadow comparison recorded. The agent was not changed.' as const;

export interface ShadowComparisonFile {
  readonly schemaVersion: typeof SHADOW_COMPARISON_SCHEMA_VERSION;
  readonly mode: 'shadow';
  readonly policyVersion: string;
  readonly rulesRecommendation: string | null;
  readonly nativeRecommendation: string;
  readonly jevRecommendation: string | null;
  readonly actualModel: string;
  readonly actualWorker: null;
  readonly applied: false;
  readonly appliedAction: null;
  readonly actuationCount: 0;
  readonly sent: false;
  readonly explanation: typeof SHADOW_RECORDED_EXPLANATION;
}

/**
 * Rejection feedback. Not a comparison file and not a policy release.
 * Reason tokens are the section 18.5 labels plus unspecified. No free text.
 */
export const FEEDBACK_REASONS = [
  'preference',
  'unavailable-context',
  'error',
  'unspecified',
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_KEYS = [
  'schemaVersion',
  'kind',
  'policyVersion',
  'recommendationId',
  'decision',
  'reason',
  'published',
  'policyChanged',
] as const;

export interface RecommendationFeedbackFile {
  readonly schemaVersion: typeof SHADOW_COMPARISON_SCHEMA_VERSION;
  readonly kind: 'recommendation-feedback';
  readonly policyVersion: string;
  readonly recommendationId: string;
  readonly decision: 'rejected';
  readonly reason: FeedbackReason;
  readonly published: false;
  readonly policyChanged: false;
}

/**
 * Offline calibration proposal. Unpublished and unread.
 * No threshold. No loader. Publish is a later gate.
 */
export const DRAFT_KEYS = [
  'schemaVersion',
  'kind',
  'policyVersion',
  'published',
  'loaded',
] as const;

export interface CalibrationDraftFile {
  readonly schemaVersion: typeof SHADOW_COMPARISON_SCHEMA_VERSION;
  readonly kind: 'calibration-proposal';
  readonly policyVersion: string;
  readonly published: false;
  readonly loaded: false;
}

/**
 * Shadow report. Measured ratios stay null. Vendor claims are not results.
 * No speedup, savings, or costRatio field. No micro-USD amount.
 */
export const NOT_A_JEVRIS_RESULT = 'not-a-jevris-result' as const;
export const FULL_COST_UNMEASURED = 'unmeasured' as const;
export const SHADOW_REPORT_KIND = 'shadow-report' as const;

export const SHADOW_BASELINES = ['rules-only', 'native', 'jev'] as const;

export const SHADOW_REPORT_KEYS = [
  'schemaVersion',
  'kind',
  'baselines',
  'recordCount',
  'actuationCount',
  'measuredSpeedRatio',
  'measuredCostRatio',
  'vendorSpeedClaim',
  'vendorCostClaim',
  'fullCostPerVerifiedTask',
] as const;

export interface ShadowReport {
  readonly schemaVersion: typeof SHADOW_COMPARISON_SCHEMA_VERSION;
  readonly kind: typeof SHADOW_REPORT_KIND;
  readonly baselines: typeof SHADOW_BASELINES;
  readonly recordCount: number;
  readonly actuationCount: 0;
  readonly measuredSpeedRatio: null;
  readonly measuredCostRatio: null;
  readonly vendorSpeedClaim: typeof NOT_A_JEVRIS_RESULT;
  readonly vendorCostClaim: typeof NOT_A_JEVRIS_RESULT;
  readonly fullCostPerVerifiedTask: typeof FULL_COST_UNMEASURED;
}
