/**
 * Versioned decision file. applied is the literal false.
 * STALE and BUDGET live here so ReasonCode and KernelRecord stay unchanged.
 */

export type LedgerReasonCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'MODEL_MISMATCH'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'DEADLINE'
  | 'CANCELLED'
  | 'INELIGIBLE'
  | 'KNOWN_FAILURE'
  | 'INTEGER_COUNT'
  | 'CHOICE_RECORDED'
  | 'STALE'
  | 'BUDGET';

export type LedgerOutcome = 'advisory' | 'refused' | 'stale';

export type FreshDecision = 'scheduled' | 'not-scheduled';

export type DecisionUsage =
  | {
      readonly known: true;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly known: false;
    };

export interface DecisionFileRecord {
  readonly schemaVersion: '1.0';
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly evidenceRevision: string;
  readonly resolvedModel: string | null;
  readonly outcome: LedgerOutcome;
  readonly reasonCode: LedgerReasonCode;
  readonly usage: DecisionUsage;
  readonly applied: false;
  readonly explanation: string;
  readonly nonOwnedBilling: 'unknown';
  readonly freshDecision: FreshDecision;
  readonly reservationMicroUsd: string;
}

export interface DecisionLedgerFile {
  readonly schemaVersion: '1.0';
  readonly records: readonly DecisionFileRecord[];
}
