/**
 * Advise-only result types. applied is the literal false.
 * These are not a provider response and not a runtime validator.
 */

export type AdviceMode = 'off' | 'observe' | 'advise';

export type AdviceHealth = 'recorded' | 'off' | 'refused' | 'stale' | 'budget-bound';

export type StatusReason = 'REFUSED' | 'STALE' | 'BUDGET';

export interface AdviceRecord {
  readonly policyVersion: string;
  readonly evidenceRevision: string;
  readonly pinnedModel: string;
  readonly predictedModel: string;
  readonly text: string;
  readonly prompted: boolean;
  readonly applied: false;
  readonly ignored: boolean;
}

export interface AdviceResult {
  readonly applied: false;
  readonly toolPermission: false;
  readonly authorityGranted: false;
  readonly consentFabricated: false;
  readonly verified: false;
  readonly providerCalls: 0;
  readonly prompted: boolean;
  readonly ignored: boolean;
  readonly text: string;
  readonly pinnedModel: string;
  readonly records: readonly AdviceRecord[];
  readonly fileWritten: boolean;
}

export interface StatusInput {
  readonly mode: string;
  readonly pinnedModel?: string;
  readonly freshDecision: 'scheduled' | 'not-scheduled' | string;
  readonly health: string;
  readonly reasonCode?: StatusReason;
  readonly reservationMicroUsd?: string;
}
