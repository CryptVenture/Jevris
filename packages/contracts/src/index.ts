/**
 * Product Choice contracts. Not vendor SDK types and not a runtime validator.
 * The phase fixture question id is failureFamily. Validation uses ChoiceSpec.id.
 * The port is not hardcoded to that id.
 */

declare global {
  interface AbortSignal {
    readonly aborted: boolean;
  }
}

export const PINNED_MODEL = 'jev-1.13.0';
export const MAX_REQUEST_BYTES = 131_072;
export const MAX_RESPONSE_BYTES = 1_048_576;
/** 1e-6 is not certified provider precision. */
export const PROBABILITY_EPSILON = 1e-6;

export type ReasonCode =
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
  | 'CHOICE_RECORDED';

export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface ChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ChoiceSpec {
  readonly id: string;
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export type EvaluationInput =
  | { readonly kind: 'known-failure'; readonly family: 'type_error' | 'assertion' | 'environment' }
  | { readonly kind: 'count'; readonly items: readonly unknown[] }
  | { readonly kind: 'authority-request'; readonly asked: 'permission' | 'consent' | 'verified' }
  | { readonly kind: 'ambiguous-failure' };

export interface ProviderDelivery {
  readonly receivedAtMs: number;
  readonly body: Uint8Array | null;
}

export interface ProviderPort {
  calls: number;
  evaluate(requestBytes: Uint8Array, signal: AbortSignal, deadlineAtMs: number): Promise<ProviderDelivery>;
}

export interface PlannedAction {
  readonly kind: 'abstain';
  readonly reasonCode: string;
}

export interface KernelRecord {
  readonly disposition: 'rules' | 'abstained' | 'refused';
  readonly reasonCode: ReasonCode;
  readonly classification: string | null;
  readonly count: number | null;
  readonly plannedAction: PlannedAction;
  readonly appliedAction: null;
  readonly authorityGranted: false;
  readonly consentFabricated: false;
  readonly verified: false;
  readonly persisted: false;
  readonly providerCalls: number;
  readonly retainedBody: Uint8Array | null;
  readonly resolvedModel?: string;
  readonly providerConfidence?: number;
}

export type {
  CredentialDiagnostic,
  EgressAllow,
  EgressDecision,
  EgressDeny,
  EgressLogLine,
  EgressReasonCode,
  EgressSetting,
} from './egress.js';

export type {
  DecisionFileRecord,
  DecisionLedgerFile,
  DecisionUsage,
  FreshDecision,
  LedgerOutcome,
  LedgerReasonCode,
} from './ledger.js';

export type {
  FallbackErrorClass,
  FallbackFile,
  FallbackMode,
  FallbackRestore,
  LocalCallerRejectReason,
  ValidityKeyName,
} from './runtime.js';

export { FALLBACK_KEYS, FALLBACK_SCHEMA_VERSION, VALIDITY_KEY_NAMES } from './runtime.js';

export type { HookResult, ObservationFile } from './observe.js';

export type {
  AdviceHealth,
  AdviceMode,
  AdviceRecord,
  AdviceResult,
  StatusInput,
  StatusReason,
} from './advice.js';

export type {
  ActuatorRow,
  ActuatorStatus,
  DoctorEnvironmentStatus,
  DoctorInstallStatus,
  DoctorReport,
  PackDisposition,
  PackReport,
} from './doctor.js';

export {
  OBSERVATION_KEYS,
  OBSERVATION_SCHEMA_VERSION,
  OBSERVE_RECORDED_EXPLANATION,
} from './observe.js';

export type { ShadowComparisonFile } from './shadow.js';

export type { ShadowReport } from './shadow.js';

export type { FeedbackReason, RecommendationFeedbackFile } from './shadow.js';

export type { CalibrationDraftFile } from './shadow.js';

export {
  FULL_COST_UNMEASURED,
  NOT_A_JEVRIS_RESULT,
  SHADOW_BASELINES,
  SHADOW_COMPARISON_KEYS,
  SHADOW_COMPARISON_SCHEMA_VERSION,
  SHADOW_RECORDED_EXPLANATION,
  SHADOW_REPORT_KEYS,
  SHADOW_REPORT_KIND,
} from './shadow.js';

export { DRAFT_KEYS, FEEDBACK_KEYS, FEEDBACK_REASONS } from './shadow.js';

export type { LoopAdviceResult } from './loop-advice.js';

export type {
  CapsuleApproval,
  CapsuleConstraint,
  CapsuleFile,
  CapsuleHash,
  CapsuleOpenCheck,
  CheckpointReasonCode,
  ConstraintKind,
  OpenCheckState,
} from './checkpoint.js';

export type {
  EvidencePrefix,
  EvidenceReader,
  EvidenceShortlistResult,
  EvidenceSpan,
  MissingEvidence,
  SkillDirectoryReader,
  SkillInventoryEntry,
  SkillShortlistResult,
} from './shortlist.js';

export {
  EXPLICIT_BASE_URL,
  EXPLICIT_LOG_LEVEL,
  HOST_SECRET_ACCOUNT,
  HOST_SECRET_REF,
  HOST_SECRET_SERVICE,
  assertNoProviderKey,
  hookCredentialCarry,
  mcpCredentialArguments,
  toHarnessView,
} from './credential-broker.js';

export type {
  CredentialPresence,
  CredentialStatus,
  ExplicitClientFields,
  HarnessCredentialView,
  HookCredentialCarry,
  McpCredentialArguments,
} from './credential-broker.js';

export {
  applyProjectNarrowing,
  copyHostDocument,
  hasRawKeyProperty,
  hostPolicySchema,
  mergeOrganization,
  validateHostDocument,
} from './host-policy.js';

export type {
  HostDocument,
  HostEgress,
  HostMode,
  PolicyMerge,
  ProjectNarrow,
} from './host-policy.js';

export { roundTripCheckedSchema } from './schema-round-trip.js';
export type { SchemaRoundTrip } from './schema-round-trip.js';

export {
  APPROVED_BASELINE,
  OBSERVED_MODEL_UNKNOWN,
  PINNED_REQUESTED_MODEL,
  UNKNOWN_SLICE_ID,
} from './route-gate.js';
export type { RouteDecision } from './route-gate.js';

export { TARIFF_FETCHED_ON, accountQuota, tariffRows, tariffSnapshot } from './tariff-snapshot.js';
export type { TariffRow } from './tariff-snapshot.js';

export type { EvidenceOffset, EvidenceView } from './evidence-view.js';

// ---------------------------------------------------------------------------------------------
// Chapter 6 domain contracts (phase 27). One source yields the TypeScript type, the runtime
// validator and the generated JSON Schema.

export * as schema from './schema.js';
export type { Static, TSchema, JsonSchemaObject } from './schema.js';
export { jsonSchemaOf } from './schema.js';

export type { Json, JsonIssue, JsonParseResult } from './json.js';
export {
  DEFAULT_MAX_JSON_BYTES,
  FORBIDDEN_KEYS,
  MAX_JSON_DEPTH,
  canonicalJson,
  frozenCopy,
  isJson,
  jsonIssue,
  parseJson,
} from './json.js';

export type { ContentHash } from './hash.js';
export { HASH_PATTERN, contentHash, isContentHash, sha256Hex } from './hash.js';

export type { Contract, ContractDefinition, ContractIssue, Refinement, ValidationResult } from './contract.js';
export { CONTRACT_SCHEMA_VERSION, ContractError, contractAjv, defineContract, isTimestamp, timestampMs } from './contract.js';

export type { HarnessId, OperatingSystem, Signature } from './primitives.js';
export {
  HARNESS_IDS,
  HARNESS_MODEL_ID_PATTERN,
  ID_PATTERN,
  JEV_MODEL_PATTERN,
  MODEL_ID_PATTERN,
  OPERATING_SYSTEMS,
  REASON_CODE_PATTERN,
  SECRET_PATTERNS,
  SEMVER_PATTERN,
  URL_PATTERNS,
  containsSecret,
} from './primitives.js';

export type { Authority, DomainEventKind, EventEnvelope, EventProvenance, EvidenceRef, Mode, Risk, SessionObservation, SessionSnapshot } from './domain.js';
export {
  AUTHORITIES,
  AuthorityContract,
  DOMAIN_EVENT_KINDS,
  EVIDENCE_SOURCE_KINDS,
  EVIDENCE_TRUST,
  EventEnvelopeContract,
  EvidenceRefContract,
  JsonContract,
  MODES,
  MODE_ACTIONS,
  MODE_OFF_REASON,
  MODE_OFF_REFUSED_OPS,
  MODE_SOURCES,
  modeOffMessage,
  type ModeAction,
  type ModeSource,
  ModeContract,
  lowerMode,
  modeAllows,
  RISKS,
  RiskContract,
  SessionSnapshotContract,
  snapshotFromObservation,
} from './domain.js';

export type {
  Action,
  ActionIntent,
  ActionKind,
  ActionReceipt,
  AuthorizationReceipt,
  Capability,
  RecommendationTemplate,
  RenderResult,
  RenderedRecommendation,
  TemplateSlot,
} from './actions.js';
export {
  ACTION_KINDS,
  ACTION_RECEIPT_STATUSES,
  AUTHORIZATION_ISSUER_PATTERN,
  ActionContract,
  ActionIntentContract,
  ActionReceiptContract,
  AuthorizationReceiptContract,
  CAPABILITY_STATUSES,
  CapabilityContract,
  RecommendationTemplateContract,
  TEMPLATE_SLOTS,
  actionApplied,
  renderRecommendation,
} from './actions.js';

export type { DecisionResult, DecisionSpec, JevAnswer, JevQuestion, JevQuestions } from './decision.js';
export {
  DECISION_FALLBACKS,
  DecisionResultContract,
  DecisionSpecContract,
  MAX_QUESTIONS,
  PROBABILITY_SUM_TOLERANCE,
  decisionSpecMatches,
  questionHash,
} from './decision.js';

export type { ModelRegistryEntry, PriceTier, ScheduledPrice, Tariff } from './registry.js';
export { ModelRegistryEntryContract } from './registry.js';

export type { AgentLease, BudgetCheck, BudgetReservation, TaskGraphIssue, TaskGraphResult, TaskNode, TaskState } from './orchestration.js';
export {
  AgentLeaseContract,
  BudgetReservationContract,
  RESERVATION_STATES,
  TASK_STATES,
  TaskNodeContract,
  heldMicroUsd,
  reservationsWithinBudget,
  validateTaskGraph,
} from './orchestration.js';

export type { MemoryCapsule, VerificationReceipt } from './receipts.js';
export { MemoryCapsuleContract, VERIFICATION_OUTCOMES, VerificationReceiptContract, receiptPassed } from './receipts.js';

export type { HarnessAdapter } from './adapter.js';
export { guardHarnessAdapter } from './adapter.js';

export type { ContractLookup, Durable, DurableIdentity } from './durable.js';
export { DurableEnvelopeContract, openDurable, sealDurable } from './durable.js';

export { CONTRACTS, DURABLE_CONTRACT_NAMES, openCataloguedDurable, schemaFileStem } from './catalogue.js';

export { JSON_SCHEMA_DIALECT, schemaDocuments, schemaId } from './catalogue.js';

export type { JevRequest, JevrisConfig, PackManifest } from './boundary.js';
export {
  JevRequestContract,
  JevrisConfigContract,
  MODEL_LISTING_DEFAULT,
  MODEL_LISTING_VALUES,
  PACK_DATA_SCOPES,
  PackManifestContract,
  type ModelListingSetting,
} from './boundary.js';

export type { BaselineSource, CalibrationArtifact, CalibrationCheck, CalibrationContext, ModelQuality } from './calibration.js';
export {
  BASELINE_SOURCE_KINDS,
  CALIBRATION_RELEASE_STATES,
  CalibrationArtifactContract,
  EXPIRY_CONDITIONS,
  INTERVAL_METHODS,
  THRESHOLD_METRICS,
  calibrationApplies,
} from './calibration.js';

export type { CertificationCheck, CertificationContext, CertificationFeature, CertificationRecord } from './certification.js';
export { ACCESS_USAGE_ISOLATION_UNAVAILABLE, CERTIFICATION_FEATURES, CertificationRecordContract, FEATURE_STATUSES, certificationCovers, compareSemver } from './certification.js';

export type { SignatureCheck } from './signing.js';
export { base64Decode, base64Encode, signRecord, signingPayload, verifyRecordSignature } from './signing.js';
export * from './sidecar.js';
export * from './harness-event.js';
export * from './commands.js';
export * from './jev-provider.js';
export * from './decision-record.js';
export * from './routing.js';
export * from './release-evidence.js';
export * from './evaluation.js';
export * from './provider-consent.js';
export * from './route-turn.js';
export * from './session-link.js';
export * from './serving-hosts.js';
export * from './access-limits.js';
