/**
 * Production route decision. Outcome is abstain until a release exists.
 * A draft, a chapter 22 record, and a workspace file are not this type.
 */

export const UNKNOWN_SLICE_ID = 'unknown-slice';
export const OBSERVED_MODEL_UNKNOWN = 'unknown';
export const PINNED_REQUESTED_MODEL = 'jev-1.13.0';
export const APPROVED_BASELINE = 'approved-baseline';

export interface RouteDecision {
  readonly outcome: 'abstain';
  readonly sliceId: string;
  readonly routeClaimed: false;
  readonly pinHeld: true;
  readonly requestedModel: string;
  readonly observedModel: string;
  readonly published: false;
  readonly threshold: null;
  /** True only when a Kilo or OpenCode turn was switched (OD-8, route.turn); this legacy frame always abstains, so false here. */
  readonly mainSessionSwitched: boolean;
  readonly fileWritten: false;
  readonly toolPermission: false;
  readonly authorityGranted: false;
  readonly baseline: typeof APPROVED_BASELINE;
}
