/**
 * Fail-closed local runtime contracts. The fallback file is not a decision record.
 * No source, token, body, or message field belongs on this document.
 */
export const FALLBACK_SCHEMA_VERSION = '1.0';
export const FALLBACK_KEYS = [
    'schemaVersion',
    'mode',
    'errorClass',
    'applied',
    'toolPermission',
    'approvedModel',
    'explanation',
    'interrupt',
    'providerRoute',
    'policyVersion',
    'cacheReused',
    'actuationResumed',
    'restore',
    'cachedChoice',
];
export const VALIDITY_KEY_NAMES = [
    'workspaceIsolation',
    'evidenceHashes',
    'questionSetVersion',
    'criteriaOrdering',
    'stateEncoder',
    'providerRoute',
    'resolvedModel',
    'policyVersion',
    'calibrationVersion',
];
