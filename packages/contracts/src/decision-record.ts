/**
 * The §23.4 decision record (DEC-07): what one decision saw, asked, spent and did. It never
 * invents a success probability, claims savings or marks a task verified. Unknown usage is
 * `null`, never zero, and a terminal record changes only by later usage reconciliation (§7.1).
 */
import { ActionSchema } from './actions.js';
import { defineContract, timestampMs } from './contract.js';
import { ModeSchema } from './domain.js';
import { MAX_QUESTIONS, QUESTION_ID_PATTERN } from './decision.js';
import { Hash, Id, ModelId, NonNegativeInteger, Probability, ReasonCode, Timestamp } from './primitives.js';
import * as S from './schema.js';

/** §7.1 finite-state machine. `applied`, `refused`, `stale` and `abstained` are terminal. */
export const DECISION_STATES = [
  'received',
  'validated',
  'evidence-ready',
  'reserved',
  'evaluating',
  'evaluated',
  'planned',
  'applied',
  'refused',
  'stale',
  'abstained',
  'quarantined',
  'reconciled',
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];
export const TERMINAL_DECISION_STATES: readonly DecisionState[] = Object.freeze(['applied', 'refused', 'stale', 'abstained', 'quarantined']);

export const DECISION_OUTCOMES = ['applied', 'advisory', 'refused', 'stale', 'abstained', 'quarantined'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const BILLING_BASES = [
  'provider-reported-usage',
  'estimate-pending-reconcile',
  'reconciled-billing-export',
  'no-provider-call',
  'synthetic-example-not-a-live-call',
] as const;
export type BillingBasis = (typeof BILLING_BASES)[number];

export const TASK_OUTCOMES = ['not-yet-observed', 'verified-success', 'verified-failure', 'abandoned', 'unknown'] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const DECISION_LANES = ['interactive', 'background'] as const;

const Usage = S.object({ inputTokens: NonNegativeInteger, outputTokens: NonNegativeInteger });

/** Where an observed worker model came from (US12, RTE-11). */
export const MODEL_OBSERVATION_SOURCES = ['sdk', 'harness', 'session', 'unknown'] as const;
export const COST_PRECISIONS = ['provider-reported', 'estimate', 'unknown'] as const;

/**
 * The model that did the work, kept apart from the one requested (US12). A missing observation
 * is `observed: null` with `source: 'unknown'` and `costPrecision: 'unknown'`, never a guess.
 */
export const WorkerModelSchema = S.object({
  requested: S.nullable(ModelId),
  observed: S.nullable(ModelId),
  source: S.enumOf(MODEL_OBSERVATION_SOURCES),
  /** True when the observed model differs from the requested one; null when either is unknown. */
  substituted: S.nullable(S.boolean()),
  costPrecision: S.enumOf(COST_PRECISIONS),
});
export type WorkerModel = S.Static<typeof WorkerModelSchema>;

/**
 * Where a refused packet's screening findings are (W06, GOV-08): a field pointer of packet
 * field names and indexes only, the rule id, and UTF-16 offsets. Never the matched text.
 */
export const EgressFindingSchema = S.object({
  field: S.string({ maxLength: 200, pattern: '^(?:/[A-Za-z0-9*]{1,32}){0,8}$' }),
  ruleId: S.string({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  start: S.nullable(NonNegativeInteger),
  length: S.nullable(NonNegativeInteger),
});
export type EgressFinding = S.Static<typeof EgressFindingSchema>;

export const DecisionRecordSchema = S.object(
  {
    schemaVersion: S.literal('1.0'),
    decisionId: Id,
    specId: Id,
    modelResolved: S.nullable(ModelId),
    mode: ModeSchema,
    evidenceRevision: Id,
    outcome: S.enumOf(DECISION_OUTCOMES),
    reasonCodes: S.array(ReasonCode, { minItems: 1, maxItems: 32, uniqueItems: true }),
    proposedAction: ActionSchema,
    appliedAction: S.nullable(ActionSchema),
    usage: S.nullable(Usage),
    billingBasis: S.enumOf(BILLING_BASES),
    actualTaskOutcome: S.enumOf(TASK_OUTCOMES),
  },
  {
    specVersion: Id,
    workspaceId: Id,
    taskId: Id,
    state: S.enumOf(DECISION_STATES),
    lane: S.enumOf(DECISION_LANES),
    hashes: S.object(
      { questionHash: Hash, packetHash: S.nullable(Hash) },
      { policyHash: Hash, requestHash: Hash, responseHash: Hash },
    ),
    timestamps: S.object({ receivedAt: Timestamp, decidedAt: Timestamp }, { reconciledAt: Timestamp }),
    durationMs: NonNegativeInteger,
    route: Id,
    providerCalls: NonNegativeInteger,
    policyVersion: Id,
    calibration: S.nullable(S.object({ id: Id, version: Id })),
    cost: S.object({
      reservedMicroUsd: NonNegativeInteger,
      actualMicroUsd: S.nullable(NonNegativeInteger),
    }),
    actionReceiptId: S.nullable(Id),
    failureKind: Id,
    /** The harness session the decision was made in, when known. */
    sessionId: Id,
    /** Requested versus observed worker model, when the decision ran or routed a worker. */
    workerModel: WorkerModelSchema,
    /** SECRET_BLOCKED: where the findings were, without their text. */
    egressFindings: S.array(EgressFindingSchema, { maxItems: 16 }),
    /**
     * The conservative input-token estimate of the request sent, and the encoder that made it
     * (P7): compared with the provider-reported input tokens, it calibrates the estimator
     * passively. A calibration report never changes the estimator; only a release does.
     */
    estimate: S.object({ inputTokens: NonNegativeInteger, encoderId: Id }),
    /**
     * The provider's per-question probability, numbers and codes only (P4 calibration cases,
     * owner decision 7922ee3): a Noul's probability, or a choice's or score's confidence. Joined
     * later with the task's verified outcome, it becomes a local calibration case that a person
     * reviews and only a signed release can use. It is not a success probability of the task.
     */
    answerProbabilities: S.array(
      S.object({
        questionId: S.string({ pattern: QUESTION_ID_PATTERN }),
        type: S.enumOf(['noul', 'choice', 'score'] as const),
        probability: Probability,
      }),
      { maxItems: MAX_QUESTIONS },
    ),
  },
  { description: 'The §23.4 decision record. Unknown usage is null; the record never claims verification or savings.' },
);
export type DecisionRecord = S.Static<typeof DecisionRecordSchema>;

export const DecisionRecordContract = defineContract<DecisionRecord>({
  name: 'DecisionRecord',
  description: 'One decision: spec, mode, reason codes, proposed and applied action, usage, billing basis and outcome (§23.4).',
  schema: DecisionRecordSchema,
  refine: (value, issue) => {
    if (value.appliedAction !== null && value.outcome !== 'applied') issue('/appliedAction', 'APPLIED_WITHOUT_APPLIED_OUTCOME');
    if (value.outcome === 'applied' && value.appliedAction === null) issue('/appliedAction', 'APPLIED_OUTCOME_WITHOUT_ACTION');
    if (value.outcome === 'applied' && (value.actionReceiptId === undefined || value.actionReceiptId === null)) {
      issue('/actionReceiptId', 'APPLIED_WITHOUT_RECEIPT');
    }
    if (value.billingBasis === 'provider-reported-usage' && value.usage === null) issue('/usage', 'REPORTED_USAGE_MISSING');
    if (value.billingBasis === 'no-provider-call' && value.providerCalls !== undefined && value.providerCalls > 0) {
      issue('/billingBasis', 'CALL_WITHOUT_BILLING');
    }
    if (value.timestamps !== undefined && timestampMs(value.timestamps.decidedAt) < timestampMs(value.timestamps.receivedAt)) {
      issue('/timestamps/decidedAt', 'DECIDED_BEFORE_RECEIVED');
    }
    if (value.cost !== undefined && value.cost.actualMicroUsd !== null && value.billingBasis === 'estimate-pending-reconcile') {
      issue('/cost/actualMicroUsd', 'ACTUAL_BEFORE_RECONCILE');
    }
  },
});
