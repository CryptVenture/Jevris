/**
 * Advise-only failure-loop record. Not a provider response and not a runtime validator.
 * The builder assigns the false and zero literals. Callers cannot supply them.
 */

export interface LoopAdviceResult {
  readonly disposition: 'advice' | 'abstained' | 'refused';
  readonly reasonCode: 'LOOP_ADVICE' | 'LOOP_CAPPED' | 'NOT_A_LOOP' | 'INVALID_REQUEST';
  readonly nextStep: 'request-environment-evidence' | 'stop-with-report' | 'abstain';
  readonly escalated: false;
  readonly applied: false;
  readonly verified: false;
  readonly testsPassed: false;
  readonly authorityGranted: false;
  readonly consentFabricated: false;
  readonly providerCalls: 0;
  readonly text: string;
  readonly rejectedApproaches: readonly string[];
  readonly hypothesis: string | null;
}
