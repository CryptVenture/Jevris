/**
 * Observe-mode counterfactual. Not a fallback file and not a decision ledger row.
 * No source, sourceText, token, body, or message field belongs on this document.
 */

export const OBSERVATION_SCHEMA_VERSION = '1.0' as const;

export const OBSERVATION_KEYS = [
  'schemaVersion',
  'mode',
  'policyVersion',
  'recommendedModel',
  'actualModel',
  'actualWorker',
  'requestedModel',
  'applied',
  'appliedAction',
  'toolPermission',
  'sent',
  'explanation',
] as const;

export const OBSERVE_RECORDED_EXPLANATION =
  'Counterfactual recorded. The worker and model were not changed.';

export interface ObservationFile {
  readonly schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  readonly mode: 'observe';
  readonly policyVersion: string;
  readonly recommendedModel: string | null;
  readonly actualModel: string;
  readonly actualWorker: null;
  readonly requestedModel: string | null;
  readonly applied: false;
  readonly appliedAction: null;
  readonly toolPermission: false;
  readonly sent: false;
  readonly explanation: string;
}

/**
 * No-decision hook result. The function that returns it is not this module.
 */
export interface HookResult {
  readonly exitCode: 0;
  readonly stdout: '';
}
