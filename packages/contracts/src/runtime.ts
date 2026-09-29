/**
 * Fail-closed local runtime contracts. The fallback file is not a decision record.
 * No source, token, body, or message field belongs on this document.
 */

export const FALLBACK_SCHEMA_VERSION = '1.0' as const;

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
] as const;

export type FallbackMode = 'off' | 'unavailable';

export type FallbackErrorClass = null | 'timeout' | 'overload' | 'prohibited';

export type FallbackRestore = 'none' | 'observation';

export interface FallbackFile {
  readonly schemaVersion: typeof FALLBACK_SCHEMA_VERSION;
  readonly mode: FallbackMode;
  readonly errorClass: FallbackErrorClass;
  readonly applied: false;
  readonly toolPermission: false;
  readonly approvedModel: string;
  readonly explanation: string;
  readonly interrupt: boolean;
  readonly providerRoute: string;
  readonly policyVersion: string;
  readonly cacheReused: boolean;
  readonly actuationResumed: false;
  readonly restore: FallbackRestore;
  readonly cachedChoice: string | null;
}

export type LocalCallerRejectReason =
  | 'LOCALHOST_ONLY'
  | 'MISSING_USER'
  | 'USER_MISMATCH'
  | 'MISSING_PID'
  | 'PID_MISMATCH'
  | 'MISSING_TOKEN'
  | 'STALE_TOKEN'
  | 'REPLAYED_TOKEN'
  | 'TOKEN_MISMATCH'
  | 'MALFORMED';

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
] as const;

export type ValidityKeyName = (typeof VALIDITY_KEY_NAMES)[number];
