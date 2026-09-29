/** Valid fixtures, one per catalogued contract. Each call returns a fresh mutable copy. */
import { readFileSync } from 'node:fs';

export const H1 = `sha256:${'a'.repeat(64)}`;
export const H2 = `sha256:${'0123456789abcdef'.repeat(4)}`;
export const T0 = '2026-09-25T10:00:00Z';
export const T1 = '2026-09-25T10:05:00.250Z';
export const T2 = '2026-10-25T10:00:00+01:00';

export const evidenceRef = () => ({
  id: 'ev-1',
  workspaceId: 'ws-1',
  contentHash: H1,
  sourceKind: 'file',
  trust: 'untrusted-content',
  observedAt: T0,
  revision: 'rev-7',
  span: { start: 10, end: 42 },
});

export const eventEnvelope = () => ({
  schemaVersion: '1.0',
  eventId: 'evt-1',
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  taskId: 'task-1',
  sequence: 3,
  occurredAt: T0,
  kind: 'tool.finished',
  expectedRevision: 'rev-7',
  deadlineAt: T1,
  payload: { exitCode: 0, nested: [1, 'two', null, { ok: true }] },
  evidence: [evidenceRef()],
  provenance: { harness: 'claude', nativeEventName: 'PostToolUse', transportEventId: 'tr-9', toolUseId: 'toolu_01', dedupKey: H2 },
});

export const actions = () => [
  { kind: 'advise', templateId: 'review-evidence', evidenceIds: ['ev-1'] },
  { kind: 'route-worker', taskId: 'task-1', modelId: 'claude-sonnet-4-5', profileId: 'implementer' },
  { kind: 'request-checkpoint', capsuleId: 'cap-1' },
  { kind: 'select-evidence', evidenceIds: ['ev-1', 'ev-2'] },
  { kind: 'request-verification', checkIds: ['unit-response'] },
  { kind: 'cancel-owned-worker', leaseId: 'lease-1' },
  { kind: 'abstain', reasonCode: 'INSUFFICIENT_EVIDENCE' },
];

export const actionIntent = () => ({
  id: 'intent-1',
  decisionId: 'dec-1',
  expectedRevision: 'rev-7',
  expiresAt: T1,
  capabilityId: 'cap-route',
  reservationId: 'res-1',
  action: { kind: 'route-worker', taskId: 'task-1', modelId: 'us.anthropic.claude-sonnet-4-v1:0', profileId: 'implementer' },
});

export const capability = () => ({
  id: 'cap-route',
  adapterId: 'claude-sdk',
  adapterVersion: '1.2.0',
  actionKind: 'route-worker',
  authority: 'actuate',
  status: 'certified',
  constraints: ['owned-workers-only'],
  fixtureSuiteHash: H1,
});

export const sessionSnapshot = () => ({
  sessionId: 'sess-1',
  workspaceId: 'ws-1',
  revision: 'rev-7',
  mode: 'observe',
  requestedModelId: null,
  actualModelId: 'claude-opus-4-1',
  contextTokensEstimate: null,
  activeTaskIds: ['task-1'],
  observedAt: T0,
});

export const decisionSpec = () => ({
  id: 'task-profile',
  version: 'v1',
  questionHash: H1,
  evidenceRequirements: ['diff-summary'],
  deadlineMs: 900,
  fallback: 'abstain',
  calibrationId: null,
});

export const decisionResult = () => ({
  id: 'dec-1',
  specId: 'task-profile',
  resolvedModelId: 'jev-1.13.0',
  answers: {
    family: { type: 'choice', choice: 'test', probabilities: { test: 0.8, unknown: 0.2 }, confidence: 0.6 },
    scope: {
      type: 'score',
      score: 1.05,
      probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
      legend: { 0: 'None', 1: 'Partial', 2: 'Complete' },
      confidence: 0.92,
    },
    repeated: { type: 'noul', noul: 0.3 },
  },
  inputTokens: 426,
  outputTokens: 73,
  elapsedMs: 812,
  providerConfidence: null,
  empiricalSuccessEstimate: null,
  evidenceIds: ['ev-1'],
  actionableUntil: T1,
  error: null,
});

export const modelRegistryEntry = () => ({
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  capabilities: ['code-edit', 'tool-use'],
  eligibilityPolicyId: 'account-default',
  evaluationSliceIds: ['ts-small-edit'],
  evaluationVersion: 'eval-2026-09',
  tariff: {
    version: 'tariff-2026-09-01',
    currency: 'USD',
    effectiveAt: T0,
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: null,
    sourceId: 'anthropic-pricing-page',
  },
});

export const taskNode = (id = 'task-1', dependencyIds = []) => ({
  id,
  schemaVersion: '1.0',
  workspaceId: 'ws-1',
  revision: 'rev-1',
  state: 'ready',
  requirementIds: ['CTR-01'],
  dependencyIds,
  writeScopes: ['packages/contracts/src/**', 'README.md'],
  acceptanceCheckIds: ['unit-contracts'],
  rootBudgetId: 'budget-1',
});

export const agentLease = () => ({
  id: 'lease-1',
  taskId: 'task-1',
  ownerId: 'worker-a',
  workspaceId: 'ws-1',
  worktreeId: 'wt-1',
  fencingToken: 4,
  heartbeatAt: T0,
  expiresAt: T1,
});

export const budgetReservation = (overrides = {}) => ({
  id: 'res-1',
  budgetId: 'budget-1',
  ownerId: 'task-1',
  currency: 'USD',
  reservedMicroUsd: 250_000,
  actualMicroUsd: null,
  state: 'reserved',
  revision: 'rev-1',
  ...overrides,
});

export const verificationReceipt = (outcome = 'passed') => ({
  id: 'vr-1',
  checkId: 'unit-response',
  workspaceId: 'ws-1',
  revision: 'rev-7',
  environmentHash: H1,
  commandManifestId: 'npm-test',
  outcome,
  rawOutputHash: H2,
  executedAt: T0,
  issuerId: 'jevris-runner',
  signatureRef: 'sig-1',
});

export const memoryCapsule = () => ({
  id: 'capsule-1',
  schemaVersion: '1.0',
  workspaceId: 'ws-1',
  revision: 'rev-7',
  objective: 'Add an optional display label to an existing response.',
  pinnedEvidence: [evidenceRef()],
  optionalEvidence: [],
  taskIds: ['task-1'],
  unresolvedItems: ['Consumer compatibility test has not run.'],
  hypotheses: ['Existing consumers ignore unknown fields.'],
  authorizationHistoryRefs: [],
  validUntil: T2,
});

export const authorizationReceipt = () => ({
  id: 'auth-1',
  principalId: 'user-1',
  workspaceId: 'ws-1',
  actionKinds: ['route-worker', 'cancel-owned-worker'],
  resourceIds: ['task-1'],
  issuedBy: 'host-policy.managed',
  issuedAt: T0,
  expiresAt: T1,
  signatureRef: 'sig-2',
});

export const actionReceipt = () => ({
  id: 'ar-1',
  intentId: 'intent-1',
  status: 'advisory',
  resultingRevision: 'rev-7',
  observedModelId: null,
  reasonCode: 'ADVISORY_ONLY',
  occurredAt: T0,
});

export const recommendationTemplate = () => ({
  id: 'review-evidence',
  version: '1.0.0',
  text: 'Review {evidenceCount} evidence item(s) before continuing: {evidenceIds}.',
});

export const durableEnvelope = () => ({
  schemaVersion: '1.0',
  contract: 'Json',
  id: 'x-1',
  workspaceId: 'ws-1',
  revision: 'rev-1',
  contentHash: H1,
  body: { a: 1 },
});

/** One valid value for each catalogued contract name. */
export const VALID = {
  Mode: () => 'bounded-auto',
  Authority: () => 'advise',
  Risk: () => 'sensitive',
  Json: () => ({ a: [1, 2, { b: null }], c: 'd', e: false }),
  EvidenceRef: evidenceRef,
  EventEnvelope: eventEnvelope,
  Action: () => actions()[0],
  ActionIntent: actionIntent,
  Capability: capability,
  SessionSnapshot: sessionSnapshot,
  DecisionSpec: decisionSpec,
  DecisionResult: decisionResult,
  ModelRegistryEntry: modelRegistryEntry,
  TaskNode: () => taskNode(),
  AgentLease: agentLease,
  BudgetReservation: () => budgetReservation(),
  VerificationReceipt: () => verificationReceipt(),
  MemoryCapsule: memoryCapsule,
  AuthorizationReceipt: authorizationReceipt,
  ActionReceipt: actionReceipt,
  RecommendationTemplate: recommendationTemplate,
  DurableEnvelope: durableEnvelope,
  CalibrationArtifact: () => calibrationArtifact(),
  CertificationRecord: () => certificationRecord(),
  JevrisConfig: () => ssotExample('jevris.config.json'),
  PackManifest: () => ssotExample('routing.pack.json'),
  JevRequest: () => ssotExample('jev-request.json'),
  HookOutcome: () => ({ kind: 'route', model: 'claude-haiku-4-5' }),
};

/** A parsed `fixtures/ssot/examples` fixture. */
export function ssotExample(name) {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/ssot/examples/${name}`, import.meta.url), 'utf8'));
}

/** A structurally valid Ed25519 signature (64 zero bytes). Verification is a separate step. */
export const dummySignature = () => ({ algorithm: 'ed25519', keyId: 'release-2026', value: `${'A'.repeat(86)}==` });

export function calibrationArtifact() {
  return {
    id: 'cal-task-profile-1',
    schemaVersion: '1.0',
    releaseState: 'released',
    decisionSpecId: 'task-profile',
    decisionSpecVersion: 'v1',
    dataset: { id: 'task-profile-corpus', version: '2026-09', contentHash: H1 },
    questionHash: H2,
    model: { modelId: 'jev-1.13.0', revisionHash: H1 },
    encoderHash: H2,
    threshold: { metric: 'choice-probability', value: 0.85, errorBudget: 0.05 },
    permittedSlices: [
      { sliceId: 'ts-small-edit', calibrationSampleSize: 400, holdoutSampleSize: 300 },
      { sliceId: 'py-small-edit', calibrationSampleSize: 120, holdoutSampleSize: 80 },
    ],
    uncertaintyInterval: { lower: 0.81, upper: 0.9, confidenceLevel: 0.95, method: 'wilson' },
    reviewer: { id: 'reviewer-1', reviewedAt: '2026-09-24T12:00:00Z' },
    issuedAt: T0,
    expiresAt: T2,
    expiryConditions: ['model-revision-changed', 'encoder-changed', 'question-changed'],
    signature: dummySignature(),
  };
}

export function certificationRecord() {
  return {
    id: 'cert-claude-compaction-1',
    schemaVersion: '1.0',
    harness: 'claude',
    actuatorId: 'compaction-defer',
    harnessVersionRange: { minimum: '2.1.0', maximumExclusive: '2.3.0' },
    operatingSystems: ['darwin', 'linux'],
    models: [
      { modelId: 'claude-opus-4-1', available: true },
      { modelId: 'claude-haiku-4-5', available: null },
    ],
    tools: [{ toolId: 'Bash', available: true }],
    limitations: ['Managed installations that disallow hooks are reported, not bypassed.'],
    fixtureSuiteHash: H1,
    features: [
      { featureId: 'pre-compact-context', status: 'certified', reasonCode: null },
      { featureId: 'worker-routing', status: 'unsupported', reasonCode: 'NO_NATIVE_ACTUATOR' },
    ],
    certifiedAt: T0,
    expiresAt: T2,
    signature: dummySignature(),
  };
}
