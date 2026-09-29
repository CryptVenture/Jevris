/** Jevris domain proposals. These are not vendor SDK types or runtime validators. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Mode = 'off' | 'observe' | 'advise' | 'bounded-auto';
export type Authority = 'observe' | 'advise' | 'actuate';
export type Risk = 'routine' | 'material' | 'sensitive';
export interface EvidenceRef {
  readonly id: string; readonly workspaceId: string; readonly contentHash: string;
  readonly sourceKind: 'user' | 'file' | 'tool' | 'policy' | 'receipt';
  readonly trust: 'verified-policy' | 'human-input' | 'untrusted-content';
  readonly observedAt: string; readonly revision: string;
  readonly span?: { readonly start: number; readonly end: number };
}
export interface EventEnvelope<T extends Json = Json> {
  readonly schemaVersion: '1.0'; readonly eventId: string; readonly workspaceId: string;
  readonly sessionId: string; readonly agentId?: string; readonly taskId?: string;
  readonly causationId?: string; readonly sequence: number; readonly occurredAt: string;
  readonly kind: string; readonly expectedRevision: string; readonly deadlineAt: string;
  readonly payload: T; readonly evidence: readonly EvidenceRef[];
}
export type Action =
  | { readonly kind: 'advise'; readonly templateId: string; readonly evidenceIds: readonly string[] }
  | { readonly kind: 'route-worker'; readonly taskId: string; readonly modelId: string; readonly profileId: string }
  | { readonly kind: 'request-checkpoint'; readonly capsuleId: string }
  | { readonly kind: 'select-evidence'; readonly evidenceIds: readonly string[] }
  | { readonly kind: 'request-verification'; readonly checkIds: readonly string[] }
  | { readonly kind: 'cancel-owned-worker'; readonly leaseId: string }
  | { readonly kind: 'abstain'; readonly reasonCode: string };
export interface ActionIntent {
  readonly id: string; readonly decisionId: string; readonly expectedRevision: string;
  readonly expiresAt: string; readonly capabilityId: string; readonly reservationId?: string;
  readonly action: Action;
}
export interface Capability {
  readonly id: string; readonly adapterId: string; readonly adapterVersion: string;
  readonly actionKind: Action['kind']; readonly authority: Authority;
  readonly status: 'certified' | 'experimental' | 'unsupported';
  readonly constraints: readonly string[]; readonly fixtureSuiteHash: string;
}
export interface SessionSnapshot {
  readonly sessionId: string; readonly workspaceId: string; readonly revision: string;
  readonly mode: Mode; readonly requestedModelId: string | null; readonly actualModelId: string | null;
  readonly contextTokensEstimate: number | null; readonly activeTaskIds: readonly string[];
  readonly observedAt: string;
}
export interface ActionReceipt {
  readonly id: string; readonly intentId: string; readonly status: 'applied' | 'refused' | 'stale' | 'advisory';
  readonly resultingRevision: string; readonly observedModelId: string | null;
  readonly reasonCode: string; readonly occurredAt: string;
}
export interface HarnessAdapter {
  capabilities(): Promise<readonly Capability[]>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  apply(intent: ActionIntent, signal: AbortSignal): Promise<ActionReceipt>;
}
export interface DecisionSpec {
  readonly id: string; readonly version: string; readonly questionHash: string;
  readonly evidenceRequirements: readonly string[]; readonly deadlineMs: number;
  readonly fallback: 'rules-only' | 'advice' | 'abstain'; readonly calibrationId: string | null;
}
export interface DecisionResult {
  readonly id: string; readonly specId: string; readonly resolvedModelId: string;
  readonly answers: Json; readonly inputTokens: number; readonly outputTokens: number;
  readonly elapsedMs: number; readonly providerConfidence: number | null;
  /** A separately estimated outcome metric; never populated from confidence or a Score directly. */
  readonly empiricalSuccessEstimate: { readonly value: number; readonly calibrationId: string } | null;
  readonly evidenceIds: readonly string[]; readonly actionableUntil: string;
}
export interface ModelRegistryEntry {
  readonly provider: string; readonly modelId: string; readonly capabilities: readonly string[];
  readonly eligibilityPolicyId: string; readonly evaluationSliceIds: readonly string[];
  readonly tariff: {
    readonly version: string; readonly currency: 'USD'; readonly effectiveAt: string;
    readonly inputPerMillion: number; readonly outputPerMillion: number;
    readonly cacheReadPerMillion: number | null; readonly sourceId: string;
  };
}
export type TaskState = 'proposed' | 'ready' | 'leased' | 'running' | 'awaiting-evidence' |
  'verifying' | 'verified' | 'failed' | 'blocked' | 'cancelled';
export interface TaskNode {
  readonly id: string; readonly schemaVersion: '1.0'; readonly workspaceId: string;
  readonly revision: string; readonly state: TaskState; readonly requirementIds: readonly string[];
  readonly dependencyIds: readonly string[]; readonly writeScopes: readonly string[];
  readonly acceptanceCheckIds: readonly string[]; readonly rootBudgetId: string;
}
export interface AgentLease {
  readonly id: string; readonly taskId: string; readonly ownerId: string;
  readonly workspaceId: string; readonly worktreeId: string; readonly fencingToken: number;
  readonly heartbeatAt: string; readonly expiresAt: string;
}
export interface BudgetReservation {
  readonly id: string; readonly budgetId: string; readonly ownerId: string;
  readonly currency: 'USD';
  /** Fixed-point integer micro-USD. Production must check safe integer bounds. */
  readonly reservedMicroUsd: number; readonly actualMicroUsd: number | null;
  readonly state: 'reserved' | 'committed' | 'released' | 'uncertain'; readonly revision: string;
}
export interface VerificationReceipt {
  readonly id: string; readonly checkId: string; readonly workspaceId: string;
  readonly revision: string; readonly environmentHash: string; readonly commandManifestId: string;
  readonly outcome: 'passed' | 'failed' | 'unknown' | 'not-run'; readonly rawOutputHash: string;
  readonly executedAt: string; readonly issuerId: string; readonly signatureRef: string;
}
export interface MemoryCapsule {
  readonly id: string; readonly schemaVersion: '1.0'; readonly workspaceId: string;
  readonly revision: string; readonly objective: string; readonly pinnedEvidence: readonly EvidenceRef[];
  readonly optionalEvidence: readonly EvidenceRef[]; readonly taskIds: readonly string[];
  readonly unresolvedItems: readonly string[]; readonly hypotheses: readonly string[];
  readonly authorizationHistoryRefs: readonly string[]; readonly validUntil: string;
}
export interface AuthorizationReceipt {
  readonly id: string; readonly principalId: string; readonly workspaceId: string;
  readonly actionKinds: readonly Action['kind'][]; readonly resourceIds: readonly string[];
  readonly issuedBy: string; readonly issuedAt: string; readonly expiresAt: string;
  readonly signatureRef: string;
}
