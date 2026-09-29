/**
 * Observe-mode counterfactual. Not a fallback file and not a decision ledger row.
 * No source, sourceText, token, body, or message field belongs on this document.
 */
export const OBSERVATION_SCHEMA_VERSION = '1.0';
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
];
export const OBSERVE_RECORDED_EXPLANATION = 'Counterfactual recorded. The worker and model were not changed.';
