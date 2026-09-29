import { APPROVED_BASELINE, OBSERVED_MODEL_UNKNOWN, PINNED_MODEL, UNKNOWN_SLICE_ID } from '@jevris/contracts';
import type { RouteDecision } from '@jevris/contracts';

/**
 * The legacy sidecar `optimize` frame's calibration answer. It always abstains; it names the
 * slice and never claims a route. Real routing is `loadCalibration` (validate, then signature,
 * then applies) followed by `routeTask` (RTE-03, RTE-04). The former in-memory test selector
 * and its model-id deny list are removed.
 */

const SLICE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export async function loadReleasedCalibration(home: string, sliceHint?: unknown): Promise<RouteDecision> {
  void home;
  return productionAbstain(safeSliceId(sliceHint));
}

function productionAbstain(sliceId: string): RouteDecision {
  return {
    outcome: 'abstain',
    sliceId,
    routeClaimed: false,
    pinHeld: true,
    requestedModel: PINNED_MODEL,
    observedModel: OBSERVED_MODEL_UNKNOWN,
    published: false,
    threshold: null,
    mainSessionSwitched: false,
    fileWritten: false,
    toolPermission: false,
    authorityGranted: false,
    baseline: APPROVED_BASELINE,
  };
}

function safeSliceId(value: unknown): string {
  if (typeof value !== 'string' || !SLICE_PATTERN.test(value)) return UNKNOWN_SLICE_ID;
  return value;
}
