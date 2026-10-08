/**
 * The decision engine (DEC-04..DEC-07, §7.1): one persisted state machine per decision.
 *
 *   received -> validated -> (rules sufficient: planned, no provider call)
 *            -> evidence-ready -> reserved -> evaluating -> evaluated -> recheck -> planned
 *   any step -> refused | abstained | stale | quarantined, with the declared fallback
 *
 * - Spec, questions and packet are validated before anything is reserved or sent.
 * - Budget is reserved from the conservative estimate; a call that never left is released, a
 *   call with reported usage is committed, an ambiguous one is held until reconciled.
 * - A malformed provider answer is quarantined with a redacted failure note (kind, question id
 *   and response hash; never the body). The declared fallback runs.
 * - Provider usage and the resolved model are persisted with the decision (DEC-06).
 * - After evaluation the revision, deadline and kill switch are rechecked; a stale decision is
 *   never planned.
 * - Nothing reaches `applied` without an adapter receipt whose status is `applied`.
 * - A crash leaves a journal entry that `recover()` settles at the next start.
 * - The journal is written where a crash must be able to settle the decision, not at every state:
 *   the entry moves through its states in memory (its `history` still names each one), is written
 *   once before a request may leave (it names the reservation and says `sent`), and once for the
 *   final record. A decision that sends nothing (a cache hit, a rules answer, a refusal, advice
 *   recorded without a call) is one write. Each write is an fsync, the cost that does not shrink
 *   with a faster CPU: a cold decision made nine writes of the journal and the budget and a cached
 *   one three; they make four and one.
 */
import { sliceAssistLines } from './slice-explain.js';
import { checkRelevanceLines } from './check-relevance-explain.js';
import { subagentRiskLines } from './subagent-risk-explain.js';
import { liveAdviceLines } from './live-advice-explain.js';
import { adviceJevUse } from './advice-jev-use.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ManagedRouteRequest } from './route-evaluate.js';
import type { ManagedWorkerResult } from './route-worker.js';
import {
  ActionContract,
  ActionReceiptContract,
  DecisionResultContract,
  DecisionSpecContract,
  PINNED_MODEL,
  actionApplied,
  decisionSpecMatches,
  type Action,
  type ActionReceipt,
  type BillingBasis,
  type DecisionOutcome,
  type DecisionRecord,
  type DecisionResult,
  type DecisionSpec,
  type DecisionState,
  type JevAnswer,
  type JevQuestions,
  type JevTransport,
  type JevWireRequest,
  type Mode,
  type Risk,
} from '@jevris/contracts';
import { createDeadline, jevrisPaths } from '@jevris/platform';
import { jevCostMicroUsd, type DecisionBudget } from './decision-budget.js';
import { DecisionCache, cacheable, type CacheValidity } from './decision-cache.js';
import type { CircuitBreaker, CircuitClearResult, CircuitSnapshot, CircuitState } from './decision-circuit.js';
import { DecisionJournal, IN_FLIGHT_STATES, isDecisionId, type DecisionDraft, type JournalEntry } from './decision-journal.js';
import { JevClient, type AskResult, type DeadlineLike, type JevClientOptions } from './decision-provider.js';
import { lintQuestions, questionOrderHash } from './decision-question-lint.js';
import type { DecisionLane } from './decision-retry.js';
import { ENCODER_ID, estimateRequest } from './decision-tokens.js';
import type { ValidatedAnswer, ValidationPolicy } from './decision-validate.js';
import { DEFAULT_PACKET_LIMITS, buildPacket, type PacketInput, type PacketOptions, type PacketResult, type PacketSourceEgress, type SecretLocation } from './packet.js';
import { decideEgress } from './egress.js';

/** Answers decided by deterministic rules, with no provider call (§7.2). */
export interface RulesVerdict {
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly reasonCode: string;
}

export interface DecideRequest {
  readonly spec: DecisionSpec;
  readonly questions: JevQuestions;
  readonly packet: PacketInput;
  readonly workspaceId: string;
  readonly evidenceRevision: string;
  readonly lane?: DecisionLane;
  readonly taskId?: string;
  /** The harness session the trigger came from; recorded so explain can show its models (US12). */
  readonly sessionId?: string;
  readonly risk?: Risk;
  /** Operating mode for the record; default the engine's mode. */
  readonly mode?: Mode;
  /** Deterministic rules run first; a verdict means no provider call. */
  readonly rules?: (packet: PacketInput) => RulesVerdict | null;
}

export interface DecideOptions {
  readonly signal?: AbortSignal;
  /** The caller's absolute deadline (e.g. the sidecar's, measured from event receipt). */
  readonly deadline?: DeadlineLike;
  /** Returns the current evidence revision for the post-evaluation recheck. */
  readonly currentRevision?: () => string | null;
  /** Observation-only work may use an observe-only provider route. */
  readonly observation?: boolean;
}

export type DecideOutcome =
  | {
      readonly abstained: false;
      readonly result: DecisionResult;
      readonly decisionId: string;
      /** False while the provider route is observe-only or hides its model. */
      readonly automation: boolean;
      readonly rulesOnly: boolean;
    }
  | { readonly abstained: true; readonly reasonCode: string; readonly decisionId: string; readonly fallback: DecisionSpec['fallback'] | null };

export interface TariffLike {
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
}

/** The dated Jev tariff (fetched 2026-09-24): 0.042 USD per million input tokens, output free. */
export const JEV_TARIFF: TariffLike = Object.freeze({ inputMicroUsdPerMillion: 42_000, outputMicroUsdPerMillion: 0 });

export interface DecisionEngineOptions {
  /** The provider port, or null for rules-only. */
  readonly transport: JevTransport | null;
  readonly journalDir: string;
  readonly budget: DecisionBudget | null;
  readonly breaker?: CircuitBreaker | null;
  /** Wall clock (ms). */
  readonly clock?: { now(): number };
  readonly credentialFingerprint?: string | null;
  readonly validation?: ValidationPolicy;
  readonly mode?: Mode;
  readonly policyVersion?: string;
  readonly tariff?: TariffLike;
  /** Output tokens reserved per question. */
  readonly outputTokensPerQuestion?: number;
  /** How long a planned decision stays actionable. */
  readonly actionableForMs?: number;
  readonly killSwitch?: () => boolean;
  /**
   * The administrator's source-egress setting (`{ provenance: 'administrator', sourceEgress }`),
   * read per decision and judged by `decideEgress`. Absent, unreadable or not approved: no
   * evidence text leaves the machine (the packet carries structured features only).
   */
  readonly sourceEgress?: () => unknown;
  /** Decision cache (DEC-09); null disables it. Default: a per-engine in-memory cache. */
  readonly cache?: DecisionCache | null;
  /** Extra JevClient options (tests: sleep, random, settle margin). */
  readonly client?: Partial<Omit<JevClientOptions, 'transport' | 'breaker' | 'credentialFingerprint' | 'validation'>>;
  /**
   * PRV-08: the least time between two health probes (default 30 s, the breaker's cooldown).
   * While the breaker is half-open, or observe-only with an unchanged model, a decision starts
   * at most one background probe per interval.
   */
  readonly probeIntervalMs?: number;
}

/** One health probe (PRV-08, W07). A probe never carries workspace content. */
export interface ProbeOutcome {
  readonly probed: boolean;
  /** Breaker state after the probe; null without a provider or breaker. */
  readonly state: CircuitState | null;
  readonly reasonCode: string;
}

/** The fixed, harmless probe question: no workspace content, one Noul. */
const PROBE_QUESTIONS = Object.freeze({
  healthCheck: {
    type: 'noul',
    instructions: 'Is this a readable health-check request with no task content?',
    criteria: { true: 'The request is a readable health check.', false: 'The request cannot be read as a health check.' },
  },
}) as unknown as JevWireRequest['questions'];

export interface ReconcileInput {
  readonly actualMicroUsd: number;
  readonly source: 'provider-usage' | 'billing-export';
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface EngineCircuit {
  snapshot(): CircuitSnapshot;
  /** Clears a BILLING or ACCOUNT disable and persists it; `persisted: false` when the write failed. */
  clearDisabled(): Promise<CircuitClearResult & { readonly persisted: boolean }>;
}

export type EngineActionResult = { readonly ok: true; readonly record: DecisionRecord } | { readonly ok: false; readonly reasonCode: string };

export interface DecisionEngine {
  readonly providerConfigured: boolean;
  readonly route: string | null;
  readonly journal: DecisionJournal;
  readonly budget: DecisionBudget | null;
  readonly breaker: CircuitBreaker | null;
  readonly mode: Mode;
  readonly cache: DecisionCache | null;
  /**
   * The engine's wall clock (ms): the injected `clock`, else the real one. Ops on the decision
   * path (route, calibration status) read the time from it, so one clock decides every route.
   * An own arrow property, so a Proxy around the engine can call it.
   */
  readonly now?: () => number;
  decide(request: DecideRequest, options?: DecideOptions): Promise<DecideOutcome>;
  lookup(decisionId: string): Promise<DecisionRecord | null>;
  entry(decisionId: string): Promise<JournalEntry | null>;
  /** Records an adapter receipt. Only status `applied` moves a planned decision to applied. */
  markApplied(decisionId: string, receipt: ActionReceipt): Promise<EngineActionResult>;
  reconcileUsage(decisionId: string, input: ReconcileInput): Promise<EngineActionResult>;
  /** Settles decisions a crash left in flight. Run once at start. */
  recover(): Promise<{ readonly recovered: number }>;
  /** Whether evidence text may leave right now (the administrator setting, GOV-01). */
  sourceEgress?(): PacketSourceEgress;
  /**
   * PRV-08: one bounded health probe when the breaker waits for one (half-open, or observe-only
   * with the same model). Single-flight and rate-limited; a sidecar timer may call it too.
   */
  probeProvider?(options?: { readonly signal?: AbortSignal; readonly deadline?: DeadlineLike }): Promise<ProbeOutcome>;
  /**
   * The engine's own Jev circuit, keyed by its configured credential (coordinator decision
   * ea2af91a): what status and doctor show, and the one place a person's `jevris credential
   * reenable` clears a billing or account disable. Absent with no provider or no breaker. The
   * caller never names a key or an account, and nothing here calls Jev.
   */
  readonly circuit?: EngineCircuit;
  /**
   * Records advice decided without a provider call (a counterfactual route in observe mode, a
   * main-session recommendation) as a planned advisory record with the policy version. It is
   * never applied: only an adapter receipt applies a decision.
   */
  recordAdvice?(input: AdviceRecordInput): Promise<{ readonly ok: true; readonly decisionId: string } | { readonly ok: false; readonly reasonCode: string }>;
  /**
   * RTE-12, C09: routes one owned worker from the home's registry, routing policy and signed
   * calibration release, then records (observe, advise) or reserves, launches and settles
   * (bounded-auto). Attached by the sidecar engine; absent on a bare engine.
   */
  routeManagedWorker?(input: ManagedRouteRequest): Promise<ManagedWorkerResult>;
  /**
   * The calibration keys this home trusts (the shipped `calibration` role, plus the marked test
   * sandbox's override). Signed calibration-authority records (a learned-router review, C66) are
   * checked against them. Attached by the sidecar engine; absent on a bare engine.
   */
  calibrationKeys?(): Promise<ReadonlyMap<string, string>>;
}

export interface AdviceRecordInput {
  readonly specId: string;
  readonly specVersion?: string;
  readonly workspaceId: string;
  readonly evidenceRevision: string;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  readonly mode?: Mode;
  readonly action: Action;
  readonly reasonCodes: readonly string[];
  /** The calibration release the advice rests on (route advice); the record names it. */
  readonly calibration?: { readonly id: string; readonly version: string } | null;
  /** How long the advice took to compute, in ms (default 0). */
  readonly durationMs?: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function abstain(reasonCode: string): Action {
  return { kind: 'abstain', reasonCode };
}

/** The machine-wide monthly Jev decision limit is spent: this decision runs rules-only. */
export const BUDGET_MACHINE_LIMIT = 'BUDGET_MACHINE_LIMIT';
/** This workspace's own monthly cap is spent: its decisions run rules-only; other workspaces go on. */
export const BUDGET_WORKSPACE_CAP = 'BUDGET_WORKSPACE_CAP';
/** The cap that refused is set to 0: no Jev calls by setting, rules-only. */
export const BUDGET_ZERO = 'BUDGET_ZERO';

/**
 * The reason codes after `BUDGET` on a decision the budget refused (owner decision 2026-09-29):
 * which cap ran out, whether it is set to 0, and that the decision fell back to rules-only.
 */
export function budgetReasonCodes(refusal: { readonly cap?: 'machine' | 'workspace'; readonly capLimitMicroUsd?: number }): string[] {
  return [refusal.cap === 'workspace' ? BUDGET_WORKSPACE_CAP : BUDGET_MACHINE_LIMIT, ...(refusal.capLimitMicroUsd === 0 ? [BUDGET_ZERO] : []), 'RULES_ONLY'];
}

function renormalize(distribution: Readonly<Record<string, number>>): Record<string, number> {
  let sum = 0;
  for (const value of Object.values(distribution)) sum += value;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(distribution)) out[key] = sum > 0 ? value / sum : value;
  return out;
}

/** Converts validated answers to the contract's typed answers. */
export function toJevAnswers(answers: Readonly<Record<string, ValidatedAnswer>>): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === 'choice') {
      out[id] = { type: 'choice', choice: answer.choice, probabilities: renormalize(answer.probabilities), confidence: answer.providerConfidence };
    } else if (answer.type === 'score') {
      out[id] = {
        type: 'score',
        score: answer.score,
        probabilities: renormalize(answer.probabilities),
        legend: { ...answer.legend },
        confidence: answer.providerConfidence,
      };
    } else {
      out[id] = { type: 'noul', noul: answer.noul };
    }
  }
  return out;
}

function singleConfidence(answers: Readonly<Record<string, JevAnswer>>): number | null {
  const values = Object.values(answers);
  if (values.length !== 1) return null;
  const only = values[0];
  return only !== undefined && only.type !== 'noul' ? only.confidence : null;
}

/**
 * P4 calibration cases: the provider's per-question probability, numbers and codes only (a Noul's
 * probability, a choice's or score's confidence). Rules answers are not provider probabilities.
 */
export function answerProbabilities(answers: Readonly<Record<string, JevAnswer>>): { questionId: string; type: JevAnswer['type']; probability: number }[] {
  const out: { questionId: string; type: JevAnswer['type']; probability: number }[] = [];
  for (const [questionId, answer] of Object.entries(answers)) {
    if (!QUESTION_KEY.test(questionId)) continue;
    const p = answer.type === 'noul' ? answer.noul : answer.confidence;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) continue;
    out.push({ questionId, type: answer.type, probability: p });
  }
  return out.slice(0, 12);
}
const QUESTION_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

class Engine implements DecisionEngine {
  readonly providerConfigured: boolean;
  readonly route: string | null;
  readonly journal: DecisionJournal;
  readonly budget: DecisionBudget | null;
  readonly breaker: CircuitBreaker | null;
  readonly mode: Mode;
  readonly cache: DecisionCache | null;
  readonly now: () => number;
  readonly circuit?: EngineCircuit;
  readonly #client: JevClient | null;
  readonly #now: () => number;
  readonly #policyVersion: string;
  readonly #tariff: TariffLike;
  readonly #outputPerQuestion: number;
  readonly #actionableForMs: number;
  readonly #killSwitch: () => boolean;
  readonly #egressSetting: (() => unknown) | null;
  /** Per-engine secret salt for withheld-evidence digests; never persisted or sent. */
  readonly #egressSalt = randomUUID();
  readonly #probeIntervalMs: number;
  #probing: Promise<ProbeOutcome> | null = null;
  #lastProbeAtMs: number | null = null;
  readonly #pinnedModel: string;

  constructor(options: DecisionEngineOptions) {
    const clock = options.clock ?? { now: () => Date.now() };
    this.#now = () => clock.now();
    this.now = () => clock.now();
    this.journal = new DecisionJournal(options.journalDir, this.#now);
    this.budget = options.budget;
    this.breaker = options.breaker ?? null;
    this.#probeIntervalMs = Math.max(1000, options.probeIntervalMs ?? 30_000);
    this.mode = options.mode ?? 'observe';
    this.#policyVersion = options.policyVersion ?? 'jevris-policy-1';
    this.#tariff = options.tariff ?? JEV_TARIFF;
    this.#outputPerQuestion = options.outputTokensPerQuestion ?? 64;
    this.#actionableForMs = options.actionableForMs ?? 120_000;
    this.#killSwitch = options.killSwitch ?? (() => false);
    this.#egressSetting = options.sourceEgress ?? null;
    this.#pinnedModel = options.validation?.pinnedModel ?? PINNED_MODEL;
    this.cache = options.cache === undefined ? new DecisionCache({ now: this.#now }) : options.cache;
    this.providerConfigured = options.transport !== null;
    this.route = options.transport?.route ?? null;
    if (options.transport === null) {
      this.#client = null;
    } else {
      const clientOptions: JevClientOptions = {
        ...(options.client ?? {}),
        transport: options.transport,
        ...(this.breaker === null ? {} : { breaker: this.breaker }),
        ...(options.credentialFingerprint === undefined ? {} : { credentialFingerprint: options.credentialFingerprint }),
        ...(options.validation === undefined ? {} : { validation: options.validation }),
      };
      this.#client = new JevClient(clientOptions);
      const breaker = this.breaker;
      if (breaker !== null) {
        const key = this.#client.breakerKey;
        const fingerprint = options.credentialFingerprint ?? null;
        this.circuit = {
          snapshot: () => breaker.snapshot(key, fingerprint),
          clearDisabled: async () => {
            const result = breaker.clearDisabled(key);
            return { ...result, persisted: result.ok ? await breaker.persist() : true };
          },
        };
      }
    }
  }

  #record(
    entry: JournalEntry,
    state: DecisionState,
    fields: {
      readonly outcome: DecisionOutcome;
      readonly reasonCodes: readonly string[];
      readonly proposedAction: Action;
      readonly billingBasis: BillingBasis;
      readonly providerCalls: number;
      readonly durationMs: number;
      readonly actualMicroUsd?: number | null;
      readonly failureKind?: string;
      readonly hashes?: { readonly requestHash?: string | null; readonly responseHash?: string | null };
      readonly egressFindings?: readonly SecretLocation[];
      readonly calibration?: { readonly id: string; readonly version: string } | null;
      readonly answerProbabilities?: readonly { readonly questionId: string; readonly type: JevAnswer['type']; readonly probability: number }[];
    },
  ): DecisionRecord {
    const d = entry.draft;
    const reasonCodes = [...new Set(fields.reasonCodes)].slice(0, 32);
    const hashes: Record<string, string | null> = { questionHash: d.questionHash, packetHash: d.packetHash };
    if (typeof fields.hashes?.requestHash === 'string') hashes['requestHash'] = fields.hashes.requestHash;
    if (typeof fields.hashes?.responseHash === 'string') hashes['responseHash'] = fields.hashes.responseHash;
    const record: Record<string, unknown> = {
      schemaVersion: '1.0',
      decisionId: entry.decisionId,
      specId: d.specId,
      modelResolved: d.modelResolved,
      mode: d.mode,
      evidenceRevision: d.evidenceRevision,
      outcome: fields.outcome,
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ['UNSPECIFIED'],
      proposedAction: fields.proposedAction,
      appliedAction: null,
      usage: d.usage,
      billingBasis: fields.billingBasis,
      actualTaskOutcome: 'not-yet-observed',
      specVersion: d.specVersion,
      workspaceId: d.workspaceId,
      state,
      lane: d.lane,
      hashes,
      timestamps: { receivedAt: d.receivedAt, decidedAt: isoAt(Math.max(this.#now(), Date.parse(d.receivedAt))) },
      durationMs: Math.max(0, Math.round(fields.durationMs)),
      providerCalls: fields.providerCalls,
      policyVersion: this.#policyVersion,
      calibration: fields.calibration ?? null,
      cost: { reservedMicroUsd: d.reservedMicroUsd, actualMicroUsd: fields.actualMicroUsd ?? null },
      actionReceiptId: null,
    };
    if (this.route !== null && ID.test(this.route)) record['route'] = this.route;
    if (d.taskId !== null) record['taskId'] = d.taskId;
    if (typeof d.sessionId === 'string') record['sessionId'] = d.sessionId;
    if (fields.failureKind !== undefined && ID.test(fields.failureKind)) record['failureKind'] = fields.failureKind;
    // P7: the estimate beside the reported usage, so the estimator can be calibrated passively.
    if (d.estimate !== undefined && d.estimate !== null && Number.isSafeInteger(d.estimate.inputTokens) && d.estimate.inputTokens >= 0 && ID.test(d.estimate.encoderId)) record['estimate'] = { inputTokens: d.estimate.inputTokens, encoderId: d.estimate.encoderId };
    if (fields.answerProbabilities !== undefined && fields.answerProbabilities.length > 0) record['answerProbabilities'] = fields.answerProbabilities.slice(0, 12).map((a) => ({ questionId: a.questionId, type: a.type, probability: a.probability }));
    if (fields.egressFindings !== undefined && fields.egressFindings.length > 0) record['egressFindings'] = fields.egressFindings.slice(0, 16).map((f) => ({ field: f.field, ruleId: f.ruleId, start: f.start, length: f.length }));
    return record as unknown as DecisionRecord;
  }

  sourceEgress(): PacketSourceEgress {
    return this.#packetOptions().sourceEgress;
  }

  async recordAdvice(input: AdviceRecordInput): Promise<{ readonly ok: true; readonly decisionId: string } | { readonly ok: false; readonly reasonCode: string }> {
    const action = ActionContract.validate(input.action);
    if (!action.ok || !ID.test(input.specId) || !ID.test(input.workspaceId) || !ID.test(input.evidenceRevision)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
    const decisionId = `d-${randomUUID()}`;
    const draft: DecisionDraft = {
      specId: input.specId,
      specVersion: input.specVersion !== undefined && ID.test(input.specVersion) ? input.specVersion : 'v1',
      workspaceId: input.workspaceId,
      taskId: typeof input.taskId === 'string' && ID.test(input.taskId) ? input.taskId : null,
      sessionId: typeof input.sessionId === 'string' && ID.test(input.sessionId) ? input.sessionId : null,
      evidenceRevision: input.evidenceRevision,
      lane: 'background',
      mode: input.mode ?? this.mode,
      receivedAt: isoAt(this.#now()),
      questionHash: `sha256:${'0'.repeat(64)}`,
      packetHash: null,
      reservationId: null,
      reservedMicroUsd: 0,
      sent: false,
      usage: null,
      modelResolved: null,
    };
    // Advice makes no call and settles nothing, so there is nothing for a crash to recover: one write.
    const created = this.journal.begin(decisionId, draft);
    if (!created.ok) return { ok: false, reasonCode: 'JOURNAL_UNAVAILABLE' };
    const validated = this.journal.advance(created.entry, 'validated', { draft: {} });
    if (!validated.ok) return { ok: false, reasonCode: 'JOURNAL_UNAVAILABLE' };
    const codes = input.reasonCodes.filter((code) => /^[A-Z][A-Z0-9_]{0,63}$/.test(code));
    const record = this.#record(validated.entry, 'planned', {
      outcome: 'advisory',
      reasonCodes: [...codes, 'DECISION_ADVISORY'],
      proposedAction: action.value,
      billingBasis: 'no-provider-call',
      providerCalls: 0,
      durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : 0,
      calibration: input.calibration !== undefined && input.calibration !== null && ID.test(input.calibration.id) && ID.test(input.calibration.version) ? { id: input.calibration.id, version: input.calibration.version } : null,
    });
    const planned = await this.journal.transition(validated.entry, 'planned', { record });
    return planned.ok ? { ok: true, decisionId } : { ok: false, reasonCode: 'JOURNAL_UNAVAILABLE' };
  }

  /** Whether the breaker is waiting for a probe (half-open, or observe-only on the same model). */
  #probeWanted(): { readonly wanted: boolean; readonly state: CircuitState | null; readonly reasonCode: string } {
    if (this.#client === null) return { wanted: false, state: null, reasonCode: 'PROVIDER_NOT_CONFIGURED' };
    if (this.breaker === null) return { wanted: false, state: null, reasonCode: 'NO_BREAKER' };
    const key = this.#client.breakerKey;
    const state = this.breaker.snapshot(key).state;
    if (state === 'half-open') return { wanted: true, state, reasonCode: 'HALF_OPEN' };
    if (state === 'observe-only') return this.breaker.entry(key).modelChanged ? { wanted: false, state, reasonCode: 'MODEL_CHANGED' } : { wanted: true, state, reasonCode: 'OBSERVE_ONLY' };
    return { wanted: false, state, reasonCode: state === 'closed' ? 'NOT_NEEDED' : state === 'open' ? 'COOLDOWN' : 'PROVIDER_DISABLED' };
  }

  probeProvider(options: { readonly signal?: AbortSignal; readonly deadline?: DeadlineLike } = {}): Promise<ProbeOutcome> {
    if (this.#probing !== null) return this.#probing;
    const want = this.#probeWanted();
    if (!want.wanted) return Promise.resolve({ probed: false, state: want.state, reasonCode: want.reasonCode });
    if (this.#killSwitch()) return Promise.resolve({ probed: false, state: want.state, reasonCode: 'KILL_SWITCH' });
    const nowMs = this.#now();
    if (this.#lastProbeAtMs !== null && nowMs - this.#lastProbeAtMs < this.#probeIntervalMs) return Promise.resolve({ probed: false, state: want.state, reasonCode: 'PROBE_RATE_LIMITED' });
    this.#lastProbeAtMs = nowMs;
    const run = this.#probe(options).finally(() => {
      this.#probing = null;
    });
    this.#probing = run;
    return run;
  }

  async #probe(options: { readonly signal?: AbortSignal; readonly deadline?: DeadlineLike }): Promise<ProbeOutcome> {
    const client = this.#client;
    if (client === null) return { probed: false, state: null, reasonCode: 'PROVIDER_NOT_CONFIGURED' };
    const packet = buildPacket({ objective: 'Health check.', trustedPolicy: {}, facts: {}, evidence: [], missingEvidence: [] }, DEFAULT_PACKET_LIMITS, { sourceEgress: 'denied' });
    if (!packet.ok) return { probed: false, state: this.#probeWanted().state, reasonCode: 'PROBE_INVALID' };
    const request = { model: this.#pinnedModel, state: packet.state, questions: PROBE_QUESTIONS } as unknown as JevWireRequest;
    const estimate = estimateRequest(request);
    const amount = jevCostMicroUsd(estimate.totalTokens, this.#outputPerQuestion, this.#tariff);
    let reservationId: string | null = null;
    if (this.budget !== null) {
      const reserved = await this.budget.reserve({ decisionId: `probe-${randomUUID()}`, workspaceId: 'jevris-probe', microUsd: amount });
      if (!reserved.ok) return { probed: false, state: this.#probeWanted().state, reasonCode: 'BUDGET' };
      reservationId = reserved.reservation.id;
    }
    const ask = await client.ask({
      request,
      lane: 'background',
      deadline: options.deadline ?? createDeadline(5000),
      probe: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (reservationId !== null) {
      if (!(ask.ok || ask.sent)) await this.budget?.release(reservationId);
      else if (ask.usage !== null) await this.budget?.commit(reservationId, { usage: ask.usage, actualMicroUsd: jevCostMicroUsd(ask.usage.inputTokens, ask.usage.outputTokens, this.#tariff) });
      else await this.budget?.hold(reservationId);
    }
    const after = this.breaker === null ? null : this.breaker.snapshot(client.breakerKey).state;
    return { probed: true, state: after, reasonCode: ask.ok ? 'PROBE_OK' : ask.reasonCode };
  }

  /** Egress for this decision: approved only by the administrator setting (GOV-01, US02). */
  #packetOptions(): PacketOptions {
    let setting: unknown;
    try {
      setting = this.#egressSetting?.();
    } catch {
      setting = undefined;
    }
    return { sourceEgress: decideEgress({ setting }).decision === 'allow' ? 'approved' : 'denied', salt: this.#egressSalt };
  }

  async decide(request: DecideRequest, options: DecideOptions = {}): Promise<DecideOutcome> {
    const decisionId = `d-${randomUUID()}`;
    const started = performance.now();
    const elapsed = (): number => performance.now() - started;
    const spec = request.spec;
    const specOk = DecisionSpecContract.validate(spec);
    const fallback = specOk.ok ? spec.fallback : null;
    const lane: DecisionLane = request.lane === 'background' ? 'background' : 'interactive';
    const deadline: DeadlineLike = options.deadline ?? createDeadline(specOk.ok ? spec.deadlineMs : 900);
    const draft: DecisionDraft = {
      specId: specOk.ok ? spec.id : 'invalid-spec',
      specVersion: specOk.ok ? spec.version : 'invalid',
      workspaceId: typeof request.workspaceId === 'string' && ID.test(request.workspaceId) ? request.workspaceId : 'invalid-workspace',
      taskId: typeof request.taskId === 'string' && ID.test(request.taskId) ? request.taskId : null,
      sessionId: typeof request.sessionId === 'string' && ID.test(request.sessionId) ? request.sessionId : null,
      evidenceRevision: typeof request.evidenceRevision === 'string' && ID.test(request.evidenceRevision) ? request.evidenceRevision : 'invalid-revision',
      lane,
      mode: request.mode ?? this.mode,
      receivedAt: isoAt(this.#now()),
      questionHash: specOk.ok ? spec.questionHash : `sha256:${'0'.repeat(64)}`,
      packetHash: null,
      reservationId: null,
      reservedMicroUsd: 0,
      sent: false,
      usage: null,
      modelResolved: null,
    };
    // The entry moves through its states in memory; `persist` and `transition` write it (see the header).
    const created = this.journal.begin(decisionId, draft);
    if (!created.ok) return { abstained: true, reasonCode: 'JOURNAL_UNAVAILABLE', decisionId, fallback };
    let entry = created.entry;

    const end = async (
      state: 'refused' | 'abstained' | 'stale' | 'quarantined',
      reasonCode: string,
      extra: {
        readonly billingBasis?: BillingBasis;
        readonly providerCalls?: number;
        readonly actualMicroUsd?: number | null;
        readonly failureKind?: string;
        readonly draft?: Partial<DecisionDraft>;
        readonly schemaFailure?: { kind: string; questionId: string | null; responseHash: string | null; applied: false };
        readonly hashes?: { readonly requestHash?: string | null; readonly responseHash?: string | null };
        readonly more?: readonly string[];
        readonly egressFindings?: readonly SecretLocation[];
      } = {},
    ): Promise<DecideOutcome> => {
      const next = extra.draft === undefined ? entry : { ...entry, draft: { ...entry.draft, ...extra.draft } };
      const outcome: DecisionOutcome = state === 'refused' ? 'refused' : state === 'stale' ? 'stale' : state === 'quarantined' ? 'quarantined' : 'abstained';
      const record = this.#record(next, state, {
        outcome,
        reasonCodes: [reasonCode, ...(extra.more ?? [])],
        proposedAction: abstain(reasonCode),
        billingBasis: extra.billingBasis ?? 'no-provider-call',
        providerCalls: extra.providerCalls ?? 0,
        durationMs: elapsed(),
        ...(extra.actualMicroUsd === undefined ? {} : { actualMicroUsd: extra.actualMicroUsd }),
        ...(extra.failureKind === undefined ? {} : { failureKind: extra.failureKind }),
        ...(extra.hashes === undefined ? {} : { hashes: extra.hashes }),
        ...(extra.egressFindings === undefined ? {} : { egressFindings: extra.egressFindings }),
      });
      await this.journal.transition(entry, state, {
        ...(extra.draft === undefined ? {} : { draft: extra.draft }),
        record,
        ...(extra.schemaFailure === undefined ? {} : { schemaFailure: extra.schemaFailure }),
      });
      return { abstained: true, reasonCode, decisionId, fallback };
    };

    /** Moves the entry to the next state in memory. Nothing is written. */
    const step = (to: DecisionState, patch: Partial<DecisionDraft> = {}): boolean => {
      const moved = this.journal.advance(entry, to, { draft: patch });
      if (!moved.ok) return false;
      entry = moved.entry;
      return true;
    };

    // received -> validated
    if (this.#killSwitch()) return end('abstained', 'KILL_SWITCH');
    if (!specOk.ok) return end('refused', 'INVALID_SPEC');
    if (draft.workspaceId === 'invalid-workspace' || draft.evidenceRevision === 'invalid-revision') return end('refused', 'INVALID_REQUEST');
    const lint = lintQuestions(request.questions);
    if (!lint.ok) return end('refused', 'QUESTION_LINT', { more: lint.errors.slice(0, 8).map((error) => `LINT_${error.code}`) });
    if (!decisionSpecMatches(spec, request.questions)) return end('refused', 'SPEC_QUESTION_MISMATCH');
    if (!step('validated')) return end('abstained', 'JOURNAL_UNAVAILABLE');

    // Deterministic rules first: a verdict means no provider call.
    if (request.rules !== undefined) {
      let verdict: RulesVerdict | null = null;
      try {
        verdict = request.rules(request.packet);
      } catch {
        verdict = null;
      }
      if (verdict !== null) return this.#planRules(entry, verdict, elapsed, fallback);
    }

    // validated -> evidence-ready
    const packetOptions = this.#packetOptions();
    const packet = buildPacket(request.packet, DEFAULT_PACKET_LIMITS, packetOptions);
    if (!packet.ok) return end(packet.reasonCode === 'SECRET_BLOCKED' ? 'refused' : 'abstained', packet.reasonCode, packet.findings === undefined ? {} : { egressFindings: packet.findings });
    const present = new Set(request.packet.evidence.map((item) => item.id));
    const missing = spec.evidenceRequirements.filter((id) => !present.has(id));
    if (missing.length > 0) return end('abstained', 'MISSING_EVIDENCE', { draft: { packetHash: packet.packetHash } });
    const dropped = spec.evidenceRequirements.filter((id) => packet.omittedIds.includes(id));
    if (dropped.length > 0) return end('abstained', 'REQUIRED_EVIDENCE_OMITTED', { draft: { packetHash: packet.packetHash } });
    if (!step('evidence-ready', { packetHash: packet.packetHash })) return end('abstained', 'JOURNAL_UNAVAILABLE');

    if (this.#client === null) return end('abstained', 'PROVIDER_NOT_CONFIGURED', { more: ['RULES_ONLY'] });
    if (deadline.expired()) return end('abstained', 'DEADLINE');
    // PRV-08: after an outage, a decision starts the bounded health probe in the background; this
    // decision is not delayed by it and keeps its own fallback.
    if (this.#probeWanted().wanted) void this.probeProvider().catch(() => undefined);

    // Decision cache (DEC-09): an identical packet under identical policy replaces the call.
    const useCache = this.cache !== null && this.route !== null && cacheable({ risk: request.risk, specId: spec.id });
    const validity: CacheValidity | null = useCache
      ? {
          workspaceId: draft.workspaceId,
          packetHash: packet.packetHash,
          questionHash: spec.questionHash,
          questionOrderHash: questionOrderHash(request.questions),
          encoderId: ENCODER_ID,
          route: this.route ?? 'none',
          model: this.#pinnedModel,
          policyVersion: this.#policyVersion,
          calibrationVersion: spec.calibrationId,
        }
      : null;
    const hit = validity === null ? null : (this.cache?.get(validity) ?? null);
    if (hit !== null) return this.#planCached(entry, hit.result, elapsed, fallback);

    // evidence-ready -> reserved
    let current: PacketResult & { ok: true } = packet;
    const wire = (state: unknown): JevWireRequest => ({ model: this.#pinnedModel, state, questions: request.questions }) as JevWireRequest;
    const firstRequest = wire(current.state);
    const estimate = estimateRequest(firstRequest);
    const reserveAmount = jevCostMicroUsd(estimate.totalTokens, this.#outputPerQuestion * estimate.questionCount, this.#tariff);
    let reservationId: string | null = null;
    if (this.budget !== null) {
      const reserved = await this.budget.reserve({ decisionId, workspaceId: draft.workspaceId, microUsd: reserveAmount });
      if (!reserved.ok) return end('abstained', reserved.reasonCode, reserved.reasonCode === 'BUDGET' ? { more: budgetReasonCodes(reserved) } : {});
      reservationId = reserved.reservation.id;
    }
    if (!step('reserved', { reservationId, reservedMicroUsd: reserveAmount })) {
      if (reservationId !== null) await this.budget?.release(reservationId);
      return end('abstained', 'JOURNAL_UNAVAILABLE');
    }

    // reserved -> evaluating (from here the request may be billed). The one write before the request
    // may leave: the entry names the reservation and says `sent`, so a crash from here on is settled
    // by `recover()` (a reservation whose request never left is released, one that may have been
    // billed is held). The states before it, and `reserved` itself, wait for this write; a crash
    // before it leaves a reservation no entry names, exactly as a crash between the budget write
    // and the `reserved` write did.
    const unsent = entry;
    if (!step('evaluating', { sent: true }) || !(await this.journal.persist(entry)).ok) {
      // Nothing left: the entry that is ended says so (`sent` false) and the reservation is released.
      entry = unsent;
      if (reservationId !== null) await this.budget?.release(reservationId);
      return end('abstained', 'JOURNAL_UNAVAILABLE');
    }
    const ask: AskResult = await this.#client.ask({
      request: firstRequest,
      lane,
      deadline,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.observation === true ? { observation: true } : {}),
      repack: (over: number) => {
        const smaller = buildPacket(request.packet, { ...DEFAULT_PACKET_LIMITS, maxStateTokens: Math.max(256, current.stateTokens - over - 64) }, packetOptions);
        if (!smaller.ok) return null;
        if (spec.evidenceRequirements.some((id) => smaller.omittedIds.includes(id))) return null;
        current = smaller;
        return wire(smaller.state);
      },
    });
    const packetHash = current.packetHash;
    const usage = ask.usage;
    const cost = usage === null ? null : jevCostMicroUsd(usage.inputTokens, usage.outputTokens, this.#tariff);
    const settle = async (): Promise<BillingBasis> => {
      const sent = ask.ok || ask.sent;
      if (!sent) {
        if (reservationId !== null) await this.budget?.release(reservationId);
        return 'no-provider-call';
      }
      if (usage !== null && cost !== null) {
        if (reservationId !== null) await this.budget?.commit(reservationId, { usage, actualMicroUsd: cost });
        return 'provider-reported-usage';
      }
      if (reservationId !== null) await this.budget?.hold(reservationId);
      return 'estimate-pending-reconcile';
    };
    const billingBasis = await settle();
    const calls = ask.attempts;
    const common = {
      billingBasis,
      providerCalls: billingBasis === 'no-provider-call' ? 0 : Math.max(1, calls),
      actualMicroUsd: billingBasis === 'provider-reported-usage' ? cost : null,
      hashes: { requestHash: ask.requestHash, responseHash: ask.responseHash },
      draft: { packetHash, usage, modelResolved: ask.model, sent: billingBasis !== 'no-provider-call', ...(ask.ok ? { estimate: { inputTokens: ask.estimate.totalTokens, encoderId: ask.estimate.encoderId } } : {}) } as Partial<DecisionDraft>,
    };

    if (!ask.ok) {
      // The host's egress guard refused it locally: the same terminal refusal as the packet
      // builder's, with nothing sent, nothing billed and nothing counted against the provider.
      if (ask.reasonCode === 'SECRET_BLOCKED' || ask.reasonCode === 'EGRESS_NOT_APPROVED') return end('refused', ask.reasonCode, common);
      if (ask.schemaFailure !== null) {
        return end('quarantined', ask.reasonCode, {
          ...common,
          failureKind: ask.schemaFailure.kind,
          schemaFailure: { kind: ask.schemaFailure.kind, questionId: ask.schemaFailure.questionId, responseHash: ask.responseHash, applied: false },
          more: [`FALLBACK_${(fallback ?? 'abstain').toUpperCase().replace(/-/g, '_')}`],
        });
      }
      return end('abstained', ask.reasonCode, { ...common, ...(ask.failure === null ? {} : { failureKind: ask.failure }) });
    }

    // evaluating -> evaluated, in memory: the budget already holds the committed usage (settle above),
    // and the final record below carries it, so this state needs no write of its own.
    if (!step('evaluated', common.draft)) return end('abstained', 'JOURNAL_UNAVAILABLE', common);

    // Post-evaluation recheck: revision, deadline and kill switch.
    if (this.#killSwitch()) return end('abstained', 'KILL_SWITCH', common);
    const revision = options.currentRevision?.() ?? draft.evidenceRevision;
    if (revision !== draft.evidenceRevision) return end('stale', 'STALE_REVISION', common);
    if (deadline.expired()) return end('stale', 'DEADLINE', common);
    // A tied Choice has no winner and is never used. When every answer of the request tied, the decision
    // abstains. When others are sound, only the tied ones are dropped and the record says so
    // (CHOICE_TIE_DROPPED): one tie (about 1 in 100 live answers) must not throw away the answers that
    // were paid for, such as a request's workflow family at confidence 1 beside a tied secondary question.
    const tiedIds = Object.entries(ask.answers).filter(([, answer]) => answer.type === 'choice' && answer.tie).map(([id]) => id);
    if (tiedIds.length > 0 && tiedIds.length === Object.keys(ask.answers).length) return end('abstained', 'CHOICE_TIE', common);
    const answers = Object.fromEntries(Object.entries(toJevAnswers(ask.answers)).filter(([id]) => !tiedIds.includes(id)));

    const nowMs = this.#now();
    const evidenceIds = current.includedIds.filter((id) => ID.test(id)).slice(0, 256);
    const candidate = {
      id: decisionId,
      specId: spec.id,
      resolvedModelId: ask.model,
      answers,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      elapsedMs: Math.max(0, Math.round(ask.elapsedMs)),
      providerConfidence: singleConfidence(answers),
      empiricalSuccessEstimate: null,
      evidenceIds,
      actionableUntil: isoAt(nowMs + this.#actionableForMs),
      error: null,
    };
    const checked = DecisionResultContract.validate(candidate);
    if (!checked.ok) {
      return end('quarantined', 'RESULT_INVALID', {
        ...common,
        failureKind: 'result-contract',
        schemaFailure: { kind: 'result-contract', questionId: null, responseHash: ask.responseHash, applied: false },
      });
    }

    // evaluated -> planned (advisory; applied only with an adapter receipt)
    const reasons = ['DECISION_ADVISORY'];
    if (!ask.automation) reasons.push('OBSERVE_ONLY_ROUTE');
    if (current.truncated) reasons.push('PACKET_TRUNCATED');
    if (ask.repacked) reasons.push('PACKET_REPACKED');
    if (tiedIds.length > 0) reasons.push('CHOICE_TIE_DROPPED');
    const templateId = ID.test(spec.id) ? spec.id : 'decision';
    const record = this.#record(entry, 'planned', {
      outcome: 'advisory',
      reasonCodes: reasons,
      proposedAction: { kind: 'advise', templateId, evidenceIds: evidenceIds.slice(0, 64) },
      billingBasis: common.billingBasis,
      providerCalls: common.providerCalls,
      durationMs: elapsed(),
      actualMicroUsd: common.actualMicroUsd,
      hashes: common.hashes,
      answerProbabilities: answerProbabilities(answers),
    });
    const planned = await this.journal.transition(entry, 'planned', { record });
    if (!planned.ok) return { abstained: true, reasonCode: 'JOURNAL_UNAVAILABLE', decisionId, fallback };
    if (validity !== null && ask.automation && !ask.repacked) this.cache?.set(validity, checked.value, decisionId);
    return { abstained: false, result: checked.value, decisionId, automation: ask.automation, rulesOnly: false };
  }

  async #planCached(entry: JournalEntry, cached: DecisionResult, elapsed: () => number, fallback: DecisionSpec['fallback'] | null): Promise<DecideOutcome> {
    const result: DecisionResult = {
      ...cached,
      id: entry.decisionId,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: Math.max(0, Math.round(elapsed())),
      actionableUntil: isoAt(this.#now() + this.#actionableForMs),
    };
    const withModel: JournalEntry = { ...entry, draft: { ...entry.draft, modelResolved: cached.resolvedModelId } };
    const record = this.#record(withModel, 'planned', {
      outcome: 'advisory',
      reasonCodes: ['DECISION_ADVISORY', 'CACHE_HIT'],
      proposedAction: { kind: 'advise', templateId: ID.test(entry.draft.specId) ? entry.draft.specId : 'decision', evidenceIds: result.evidenceIds.slice(0, 64) },
      billingBasis: 'no-provider-call',
      providerCalls: 0,
      durationMs: elapsed(),
      answerProbabilities: answerProbabilities(result.answers),
    });
    const planned = await this.journal.transition(entry, 'planned', { draft: { modelResolved: cached.resolvedModelId }, record });
    if (!planned.ok) return { abstained: true, reasonCode: 'JOURNAL_UNAVAILABLE', decisionId: entry.decisionId, fallback };
    return { abstained: false, result, decisionId: entry.decisionId, automation: true, rulesOnly: false };
  }

  async #planRules(entry: JournalEntry, verdict: RulesVerdict, elapsed: () => number, fallback: DecisionSpec['fallback'] | null): Promise<DecideOutcome> {
    const candidate = {
      id: entry.decisionId,
      specId: entry.draft.specId,
      resolvedModelId: 'jevris-rules',
      answers: verdict.answers,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: Math.max(0, Math.round(elapsed())),
      providerConfidence: null,
      empiricalSuccessEstimate: null,
      evidenceIds: [],
      actionableUntil: isoAt(this.#now() + this.#actionableForMs),
      error: null,
    };
    const checked = DecisionResultContract.validate(candidate);
    const reason = /^[A-Z][A-Z0-9_]{0,63}$/.test(verdict.reasonCode) ? verdict.reasonCode : 'RULES_SUFFICIENT';
    if (!checked.ok) {
      const record = this.#record(entry, 'abstained', {
        outcome: 'abstained',
        reasonCodes: ['RULES_RESULT_INVALID'],
        proposedAction: abstain('RULES_RESULT_INVALID'),
        billingBasis: 'no-provider-call',
        providerCalls: 0,
        durationMs: elapsed(),
      });
      await this.journal.transition(entry, 'abstained', { record });
      return { abstained: true, reasonCode: 'RULES_RESULT_INVALID', decisionId: entry.decisionId, fallback };
    }
    const record = this.#record(entry, 'planned', {
      outcome: 'advisory',
      reasonCodes: ['RULES_SUFFICIENT', reason],
      proposedAction: { kind: 'advise', templateId: ID.test(entry.draft.specId) ? entry.draft.specId : 'decision', evidenceIds: [] },
      billingBasis: 'no-provider-call',
      providerCalls: 0,
      durationMs: elapsed(),
    });
    const planned = await this.journal.transition(entry, 'planned', { record });
    if (!planned.ok) return { abstained: true, reasonCode: 'JOURNAL_UNAVAILABLE', decisionId: entry.decisionId, fallback };
    return { abstained: false, result: checked.value, decisionId: entry.decisionId, automation: false, rulesOnly: true };
  }

  async lookup(decisionId: string): Promise<DecisionRecord | null> {
    return (await this.journal.read(decisionId))?.record ?? null;
  }

  entry(decisionId: string): Promise<JournalEntry | null> {
    return this.journal.read(decisionId);
  }

  async markApplied(decisionId: string, receipt: ActionReceipt): Promise<EngineActionResult> {
    const entry = await this.journal.read(decisionId);
    if (entry === null || entry.record === null) return { ok: false, reasonCode: 'UNKNOWN_DECISION' };
    if (entry.state !== 'planned') return { ok: false, reasonCode: 'NOT_PLANNED' };
    const checked = ActionReceiptContract.validate(receipt);
    if (!checked.ok) return { ok: false, reasonCode: 'INVALID_RECEIPT' };
    const r = entry.record;
    if (!actionApplied(checked.value)) {
      const to = checked.value.status === 'stale' ? 'stale' : 'refused';
      const record: DecisionRecord = { ...r, outcome: to, state: to, actionReceiptId: checked.value.id, reasonCodes: [...new Set([...r.reasonCodes, checked.value.reasonCode])].slice(0, 32) };
      const moved = await this.journal.transition(entry, to, { record });
      return moved.ok ? { ok: true, record } : { ok: false, reasonCode: moved.reasonCode };
    }
    const record: DecisionRecord = { ...r, outcome: 'applied', state: 'applied', appliedAction: r.proposedAction, actionReceiptId: checked.value.id };
    const moved = await this.journal.transition(entry, 'applied', { record });
    return moved.ok ? { ok: true, record } : { ok: false, reasonCode: moved.reasonCode };
  }

  async reconcileUsage(decisionId: string, input: ReconcileInput): Promise<EngineActionResult> {
    const entry = await this.journal.read(decisionId);
    if (entry === null || entry.record === null) return { ok: false, reasonCode: 'UNKNOWN_DECISION' };
    if (entry.state === 'reconciled') return { ok: false, reasonCode: 'ALREADY_RECONCILED' };
    if (!Number.isSafeInteger(input.actualMicroUsd) || input.actualMicroUsd < 0) return { ok: false, reasonCode: 'INVALID_AMOUNT' };
    if (entry.draft.reservationId !== null && this.budget !== null) {
      const settled = await this.budget.reconcile(entry.draft.reservationId, input);
      // A reservation whose cost was final long ago (committed, or released) may have been folded into the budget's
      // summary of the month: it is no longer a row of its own, and it was already settled, as ALREADY_SETTLED says.
      // A decision still waiting for its usage (`estimate-pending-reconcile`) is a hold, which is never folded.
      const folded = settled.ok === false && settled.reasonCode === 'UNKNOWN_RESERVATION' && entry.record.billingBasis !== 'estimate-pending-reconcile';
      if (!settled.ok && settled.reasonCode !== 'ALREADY_SETTLED' && !folded) return { ok: false, reasonCode: settled.reasonCode };
    }
    const r = entry.record;
    const record: DecisionRecord = {
      ...r,
      state: 'reconciled',
      usage: input.usage === undefined ? r.usage : { ...input.usage },
      billingBasis: input.source === 'billing-export' ? 'reconciled-billing-export' : 'provider-reported-usage',
      cost: { reservedMicroUsd: r.cost?.reservedMicroUsd ?? entry.draft.reservedMicroUsd, actualMicroUsd: input.actualMicroUsd },
      ...(r.timestamps === undefined ? {} : { timestamps: { ...r.timestamps, reconciledAt: isoAt(this.#now()) } }),
    };
    const moved = await this.journal.transition(entry, 'reconciled', { record });
    return moved.ok ? { ok: true, record } : { ok: false, reasonCode: moved.reasonCode };
  }

  async recover(): Promise<{ readonly recovered: number }> {
    let recovered = 0;
    // The temps a killed write left, cleared with one listing (a write no longer lists the folder).
    await this.journal.sweepStaleTemps().catch(() => 0);
    for (const id of await this.journal.list()) {
      const read = await this.journal.read(id);
      if (read === null || !IN_FLIGHT_STATES.includes(read.state)) continue;
      let entry = read;
      const sent = entry.draft.sent;
      let settledCost: number | null = null;
      if (entry.draft.reservationId !== null && this.budget !== null) {
        if (sent && entry.draft.usage === null) {
          // The usage is written to the budget (commit) before the entry's final write, so a crash between
          // the two leaves a committed reservation and an entry that does not know it yet: the budget's
          // own record is the usage, and holding a settled reservation would do nothing.
          const reservation = await this.budget.get(entry.draft.reservationId);
          if (reservation !== null && (reservation.state === 'committed' || reservation.state === 'reconciled') && reservation.usage !== null) {
            entry = { ...entry, draft: { ...entry.draft, usage: { inputTokens: reservation.usage.inputTokens, outputTokens: reservation.usage.outputTokens } } };
            settledCost = reservation.actualMicroUsd;
          } else await this.budget.hold(entry.draft.reservationId);
        } else if (!sent) await this.budget.release(entry.draft.reservationId);
      }
      const billingBasis: BillingBasis = !sent ? 'no-provider-call' : entry.draft.usage !== null ? 'provider-reported-usage' : 'estimate-pending-reconcile';
      const record = this.#record(entry, 'abstained', {
        outcome: 'abstained',
        reasonCodes: ['CRASH_RECOVERED', `INTERRUPTED_${entry.state.toUpperCase().replace(/-/g, '_')}`],
        proposedAction: abstain('CRASH_RECOVERED'),
        billingBasis,
        providerCalls: sent ? 1 : 0,
        durationMs: Math.max(0, this.#now() - Date.parse(entry.draft.receivedAt)),
        ...(settledCost === null ? {} : { actualMicroUsd: settledCost }),
      });
      const moved = await this.journal.transition(entry, 'abstained', { record });
      if (moved.ok) recovered += 1;
    }
    return { recovered };
  }
}

/** Builds the single decision engine a process uses (the sidecar builds it once). */
export function createDecisionEngine(options: DecisionEngineOptions): DecisionEngine {
  return new Engine(options);
}

/** Runs one decision through the engine. */
export function decide(request: DecideRequest, engine: DecisionEngine, options?: DecideOptions): Promise<DecideOutcome> {
  return engine.decide(request, options);
}

/** The journal directory for a Jevris home: `<data>/decisions`. */
export function decisionJournalDir(home?: string): string {
  return join(jevrisPaths(home === undefined ? {} : { home }).data, 'decisions');
}

/** Reads a persisted decision record without a running engine. */
export async function lookupDecision(decisionId: string, options: { readonly home?: string; readonly journalDir?: string } = {}): Promise<DecisionRecord | null> {
  if (!isDecisionId(decisionId)) return null;
  const journal = new DecisionJournal(options.journalDir ?? decisionJournalDir(options.home));
  return (await journal.read(decisionId))?.record ?? null;
}

const OUTCOME_TEXT: Readonly<Record<DecisionOutcome, string>> = {
  applied: 'applied through the harness adapter (a receipt is linked)',
  advisory: 'advice only; nothing was changed',
  refused: 'refused',
  stale: 'discarded as stale',
  abstained: 'abstained; the declared fallback ran',
  quarantined: 'quarantined: the provider answer was invalid and was not used',
};

const BILLING_TEXT: Readonly<Record<BillingBasis, string>> = {
  'provider-reported-usage': 'usage as reported by the provider',
  'estimate-pending-reconcile': 'usage unknown; the reserved estimate is held until billing is reconciled',
  'reconciled-billing-export': 'usage reconciled from a billing export',
  'no-provider-call': 'no provider call was made',
  'synthetic-example-not-a-live-call': 'synthetic example, not a live call',
};

/**
 * The Provider line. A record that shows a provider call names the model and the usage (or says the
 * usage is unknown). An adviser's summary of a run (see `advice-jev-use.ts`) makes no call of its own
 * and says so only when no question was asked: when Jev was asked, the question is its own decision
 * record with the model and the usage, and the line says that instead of "no provider call was made",
 * which the same text's "(asked Jev, ...)" would contradict.
 */
function providerLine(record: DecisionRecord): string {
  const showsCall = record.modelResolved !== null || record.usage !== null || record.billingBasis !== 'no-provider-call' || (record.providerCalls ?? 0) > 0;
  const use = showsCall ? null : adviceJevUse(record);
  if (use === 'asked') return 'Provider: none on this record, which is the summary of a run. Jev was asked, and each question is its own decision record, which shows whether a call went out, the model and the usage.';
  if (use === 'cache-hit') return 'Provider: no provider call was made; the decision cache answered. The call that filled the cache is its own decision record.';
  const model = record.modelResolved === null ? 'no model answered' : `model ${record.modelResolved}`;
  const usage = record.usage === null ? '' : `, ${record.usage.inputTokens} input and ${record.usage.outputTokens} output tokens`;
  return `Provider: ${model}${usage}; ${BILLING_TEXT[record.billingBasis]}.`;
}

/**
 * A plain explanation of one decision. It states what was decided and why, and never claims a
 * success probability, savings or verification.
 */
export function explainDecision(record: DecisionRecord): string {
  const lines: string[] = [];
  lines.push(`Decision ${record.decisionId} (${record.specId}${record.specVersion === undefined ? '' : `, version ${record.specVersion}`}) in ${record.mode} mode: ${OUTCOME_TEXT[record.outcome]}.`);
  lines.push(`Reasons: ${record.reasonCodes.join(', ')}.`);
  if (record.proposedAction.kind === 'abstain') lines.push(`Proposed action: none (abstain, ${record.proposedAction.reasonCode}).`);
  else if (record.proposedAction.kind === 'route-worker') lines.push(`Proposed action: route-worker (model ${record.proposedAction.modelId} for task ${record.proposedAction.taskId}).`);
  else lines.push(`Proposed action: ${record.proposedAction.kind}.`);
  lines.push(providerLine(record));
  if (record.failureKind !== undefined) lines.push(`Failure kind: ${record.failureKind}.`);
  if (record.egressFindings !== undefined && record.egressFindings.length > 0) {
    const where = record.egressFindings.slice(0, 4).map((f) => `${f.ruleId} in ${f.field === '' ? 'the packet' : f.field}${f.start === null ? '' : ` at offset ${f.start}, length ${f.length ?? 0}`}`);
    lines.push(`Blocked before sending: ${where.join('; ')}${record.egressFindings.length > 4 ? `; and ${record.egressFindings.length - 4} more` : ''}. The matched text is not stored.`);
  }
  if (record.policyVersion !== undefined) lines.push(`Policy version ${record.policyVersion}.`);
  const slice = sliceAssistLines(record);
  if (slice !== null) lines.push(...slice);
  const ranking = checkRelevanceLines(record);
  if (ranking !== null) lines.push(...ranking);
  const risk = subagentRiskLines(record);
  if (risk !== null) lines.push(...risk);
  const live = liveAdviceLines(record);
  if (live !== null) lines.push(...live);
  lines.push(`Evidence revision ${record.evidenceRevision}. Task outcome: ${record.actualTaskOutcome.replace(/-/g, ' ')}.`);
  lines.push('This record is not a success probability and does not mark the task verified.');
  return lines.join('\n');
}
