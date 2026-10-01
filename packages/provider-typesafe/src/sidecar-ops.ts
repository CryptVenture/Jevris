/**
 * Decision-engine ops the sidecar registers from `@jevris/provider-typesafe` (IPC op registry).
 *
 * Every handler treats its body as untrusted, answers only for the caller's workspace, and
 * validates surface results against E's payload contracts (`surfacePayloadContract`) before they
 * leave the sidecar. `decide` is deliberately not an op: decisions run in process only.
 *
 *   route              advice   hot         main-session and managed-worker route advice (RoutePayload)
 *   explain            status   hot         a decision's factual trace (ExplainPayload)
 *   decision.get       status   hot         the §23.4 record
 *   plan               advice   hot         deterministic plan analysis (PlanPayload)
 *   cost.report        status   background  decision-call budget and usage
 *   calibration.status status   hot         which calibration artifacts apply
 */
import {
  AUTH_MODES,
  DecisionRecordContract,
  HARNESS_IDS,
  modeAllows,
  surfacePayloadContract,
  type DecisionRecord,
  type ExplainPayload,
  type RoutePayload,
  type SidecarEventSubscriber,
  type SidecarOpContext,
  type SidecarOpDefinition,
  type SidecarOpOutcome,
  type SurfaceOperation,
  type CalibrationArtifact,
  type HarnessId,
  type ModelRegistry,
  type RouteServing,
  type TaskNode,
  type WorkerModel,
} from '@jevris/contracts';
import {
  BUNDLED_MODEL_REGISTRY,
  routeServingOf,
  sessionSignedInParties,
  seenSpellings,
  adviseMainRoute,
  auditDecomposition,
  evaluateRoute,
  providerConsentGate,
  sessionSignedInProviders,
  explainSliceLearning,
  isEffortLevel,
  loadModelAvailability,
  modelAvailabilityLines,
  modelEligibility,
  modelEligibilityLines,
  estimatorCalibration,
  estimatorCalibrationLines,
  decisionOutcomeLines,
  decisionOutcomeReport,
  buildLocalCalibrationCases,
  feedbackLines,
  feedbackReport,
  GIVEN_FEEDBACK_REASONS,
  type FeedbackReport,
  type FeedbackRow,
  sliceTaskVolume,
  sliceTaskVolumeLine,
  localCalibrationLines,
  writeLocalCalibrationCases,
  taskOutcomeOfLabels,
  type DecisionOutcomeReport,
  type EstimatorSample,
  readModelOffer,
  loadRoutingPolicy,
  unavailableModels,
  loadLearningState,
  explainDecision,
  isDecisionId,
  calibrationFileFor,
  DecisionBudget,
  DEFAULT_GENERATION_BUDGET_MICRO_USD,
  generationBudgetFile,
  loadCalibration,
  loadModelRegistry,
  loadModelRegistryChecked,
  registryModel,
  workerCalibrationContext,
  type RouteEvaluation,
  type RouteEvaluationInput,
  type SwitchContext,
  type TokenVolume,
  lookupDecision,
  planTaskGraph,
  rankPlanCandidates,
  type IntentContext,
  AdviceOnce,
  WORKSPACE_REVISIONS,
  HARNESS_MODEL_ID,
  harnessModelRef,
  classifyTaskSlice,
  type SliceClassification,
  type SliceTaskHints,
} from '@jevris/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerOverrideDiagnostic } from './provider-override.js';
import { bundledCalibrationPath, trustedCalibrationKeys } from './calibration-trust.js';
import { ROUTE_KEYS, routeFactsOf, taskHintsOf } from './route-request.js';
import { consentReaderOf, engineOf } from './engine-of.js';
import { turnMainSessionOf, turnServingOf, turnSessionLinkOf } from './route-turn-op.js';
import { DEFAULT_TRIGGER_HANDLERS } from './trigger-handlers.js';
import { adviceIgnored, openAdvice } from './advice-adherence.js';
import { createDecisionSubscriber } from './sidecar-subscribers.js';

function fail(reasonCode: string, message?: string): SidecarOpOutcome {
  return message === undefined ? { ok: false, reasonCode } : { ok: false, reasonCode, message: message.slice(0, 300) };
}

function respond(ctx: Pick<SidecarOpContext, 'op' | 'trace'>, surface: SurfaceOperation, body: unknown): SidecarOpOutcome {
  const checked = surfacePayloadContract(surface).validate(body);
  if (!checked.ok) {
    ctx.trace({ event: 'decision.payload-invalid', reasonCode: 'PAYLOAD_INVALID', op: ctx.op, path: checked.issues[0]?.path ?? '' });
    return fail('PAYLOAD_INVALID', `the ${ctx.op} result did not match its contract`);
  }
  return { ok: true, body: checked.value };
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}


async function findRecord(ctx: SidecarOpContext, decisionId: string): Promise<DecisionRecord | null> {
  const engine = engineOf(ctx);
  let record: DecisionRecord | null = null;
  try {
    record = engine !== null ? await engine.lookup(decisionId) : await lookupDecision(decisionId, { home: ctx.home });
  } catch {
    record = null;
  }
  if (record === null) return null;
  // Workspace isolation: another workspace's decision is not found here.
  if (record.workspaceId !== undefined && record.workspaceId !== ctx.workspace.id) return null;
  // P4: the journal record stays immutable; explain and decision.get show the task's outcome as a view.
  const outcome = await taskOutcomeFrom(ctx.store, decisionId, ctx.workspace.id);
  return outcome === null || outcome === record.actualTaskOutcome ? record : { ...record, actualTaskOutcome: outcome };
}

/** P4: a decision's task outcome from the store's join (B's decision_outcome), or null without a store or row. */
export async function taskOutcomeFrom(store: unknown, decisionId: string, workspaceId: string): Promise<DecisionRecord['actualTaskOutcome'] | null> {
  if (store === undefined || store === null) return null;
  try {
    const { decisionOutcomeFor } = await import('@jevris/store');
    const rows = decisionOutcomeFor(store, decisionId, workspaceId);
    return rows.length === 0 ? null : taskOutcomeOfLabels(rows);
  } catch {
    return null;
  }
}

/** P4: the local report over the store's joined outcomes; null without a store. Never leaves the machine. */
async function outcomeReportFrom(store: unknown, workspaceId: string): Promise<(DecisionOutcomeReport & { readonly lines: readonly string[] }) | null> {
  if (store === undefined || store === null) return null;
  try {
    const { readDecisionOutcomes } = await import('@jevris/store');
    const report = decisionOutcomeReport(readDecisionOutcomes(store, { workspaceId, limit: 10_000 }));
    return { ...report, lines: decisionOutcomeLines(report) };
  } catch {
    return null;
  }
}

function decisionIdOf(ctx: SidecarOpContext, keys: readonly string[] = ['decisionId']): string | null {
  const body = ctx.body;
  if (!plain(body) || !onlyKeys(body, [...keys])) return null;
  const id = body['decisionId'];
  return typeof id === 'string' ? id : null;
}

/**
 * Account eligibility for explain: one line saying the administrator's registry decides, or one
 * line per model on the local evidence from any harness on this machine. Never names the account.
 */
async function eligibilityLines(home: string, registry: ModelRegistry, unavailable: ReturnType<typeof unavailableModels>): Promise<string[]> {
  const policy = await loadRoutingPolicy({ home, registry }).catch(() => null);
  if (policy === null) return [];
  if (policy.accountId !== null) return ["Account eligibility comes from the administrator's registry account checks; local evidence is not used."];
  const offer = await readModelOffer(home).catch(() => null);
  const scope = { harness: null, authMode: null };
  // A model found gone has its own line (modelAvailabilityLines).
  return modelEligibilityLines(modelEligibility({ registry, accountId: null, offer, unavailable, scope }).filter((e) => unavailable[e.modelId] === undefined), scope);
}

/**
 * C16: how route learning stands for a slice in this workspace, for the explain trace. No state
 * file means advice only, version 0.
 */
async function learningTrace(ctx: SidecarOpContext, sliceId: string): Promise<NonNullable<ExplainPayload['trace']>['learning']> {
  // C's found-gone record (f5b19ab): a model found gone on this machine is never routed, so explain says so.
  const registry = (await loadModelRegistry({ home: ctx.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const entries = await loadModelAvailability(ctx.home, registry).catch(() => []);
  // Why each model is or is not account-eligible (DOMAINS 3f090fa): the administrator's check, or local evidence.
  const gone = [...(await eligibilityLines(ctx.home, registry, unavailableModels(entries))), ...modelAvailabilityLines(entries)];
  const state = await loadLearningState({ home: ctx.home, workspaceId: ctx.workspace.id }).catch(() => null);
  if (state === null) return { sliceId, mode: 'advise', version: 0, lines: ['advice only; no local outcomes yet', ...gone].slice(0, 64).map((line) => line.slice(0, 1000)) };
  const x = explainSliceLearning(state, sliceId, undefined, { registry });
  // The baseline prior and the local evidence as numbers, apart (E's trace.learning contract).
  const baseline = x.baseline === null ? null : { releaseId: x.baseline.releaseId.slice(0, 200), priors: x.baseline.priors.slice(0, 16).map((p) => ({ modelId: p.modelId, rate: p.rate, pseudoCount: p.pseudoCount, sampleSize: Math.round(p.sampleSize), sourceId: p.sourceId.slice(0, 200), ...(isEffortLevel(p.effort) ? { effort: p.effort } : {}) })) };
  // An arm is a model at an effort (1fc41b9): `armId` tells two efforts of one model apart.
  const posteriors = x.posteriors.slice(0, 16).map((p) => ({
    modelId: p.modelId,
    armId: p.armId,
    effort: isEffortLevel(p.effort) ? p.effort : null,
    alpha: p.alpha,
    beta: p.beta,
    mean: p.mean,
    prior: { rate: p.prior.rate, pseudoCount: p.prior.pseudoCount, sourceId: p.prior.sourceId === null ? null : p.prior.sourceId.slice(0, 200) },
    local: { successes: p.local.successes, failures: p.local.failures },
    harmVsBaseline: p.harmVsBaseline,
    // The other workspaces' part on this machine (7bea448); null when they have no outcomes for the arm.
    machine: p.machine === undefined ? null : { successes: p.machine.successes, failures: p.machine.failures, rate: p.machine.rate, pseudoCount: p.machine.pseudoCount, contributors: p.machine.contributors },
  }));
  // §22.2 in use (6750120): each arm's economics per verified task against the default, in micro-USD.
  const economics = {
    defaultArmId: x.economics.defaultArmId,
    minVerified: x.economics.minVerified,
    arms: x.economics.arms.slice(0, 16).map((a) => ({
      armId: a.armId,
      modelId: a.modelId,
      effort: isEffortLevel(a.effort) ? a.effort : null,
      isDefault: a.isDefault,
      routes: a.routes,
      verified: a.verified,
      costPerVerifiedMicroUsd: a.costPerVerifiedMicroUsd,
      apiEquivalentPerVerifiedMicroUsd: a.apiEquivalentPerVerifiedMicroUsd,
      tokensPerVerified: a.tokensPerVerified,
      usagePerVerified: a.usagePerVerified,
      wallMsPerVerified: a.wallMsPerVerified,
      costRatioVsDefault: a.costRatioVsDefault,
      usageRatioVsDefault: a.usageRatioVsDefault,
      wallRatioVsDefault: a.wallRatioVsDefault,
    })),
  };
  // P11: the task size the router assumes for this slice (the default, or the larger measured p90).
  const policy = await loadRoutingPolicy({ home: ctx.home, registry }).catch(() => null);
  const volume = policy === null ? [] : [sliceTaskVolumeLine(sliceId, sliceTaskVolume(state, sliceId, policy.defaultTaskVolume))];
  return { sliceId, mode: x.policy.mode, version: x.version, lines: [...x.lines.slice(0, Math.max(0, 64 - gone.length - volume.length)), ...volume, ...gone].slice(0, 64).map((line) => line.slice(0, 1000)), baseline, posteriors, economics };
}

const WORKER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;

/** A session's requested and actual model as the store holds them (labels, untrusted). */
export interface SessionModels {
  readonly requested: string | null;
  readonly actual: string | null;
}

/**
 * US12: requested versus observed worker model. A record's own observation wins; otherwise the
 * session's; otherwise unknown. Jevris does not meter a session's worker, so a session-sourced
 * observation never claims cost precision.
 */
export function workerModelOf(record: DecisionRecord | null, session: SessionModels | null): WorkerModel {
  if (record?.workerModel !== undefined) return record.workerModel;
  const clean = (value: string | null): string | null => (typeof value === 'string' && WORKER_MODEL_ID.test(value) ? value : null);
  const requested = session === null ? null : clean(session.requested);
  const observed = session === null ? null : clean(session.actual);
  return {
    requested,
    observed,
    source: observed === null ? 'unknown' : 'session',
    substituted: requested === null || observed === null ? null : requested !== observed,
    costPrecision: 'unknown',
  };
}

function modelLine(models: WorkerModel): string {
  const requested = models.requested ?? 'unknown';
  if (models.observed === null) return `Worker model: requested ${requested}; observed unknown (nothing reported it). Cost precision: unknown.`;
  const substituted = models.substituted === true ? ' (substituted)' : '';
  return `Worker model: requested ${requested}; observed ${models.observed}${substituted}, from the ${models.source}. Cost precision: ${models.costPrecision}.`;
}

/** The session's models from the sidecar's store, or null when there is no store or row. */
export async function sessionModelsFrom(store: unknown, sessionId: string | undefined): Promise<SessionModels | null> {
  if (store === undefined || store === null || sessionId === undefined) return null;
  try {
    const { getSession } = await import('@jevris/store');
    const row = getSession(store, sessionId);
    return row === undefined ? null : { requested: row.requestedModel, actual: row.actualModel };
  } catch {
    return null;
  }
}

/** Maps a record to the explain payload. The text never claims success or savings. */
export function explainPayload(decisionId: string, record: DecisionRecord | null, session: SessionModels | null = null): ExplainPayload {
  if (record === null) return { decisionId, found: false, trace: null };
  const usage = record.usage;
  const models = workerModelOf(record, session);
  return {
    decisionId,
    found: true,
    trace: {
      outcome: record.outcome,
      reasonCodes: record.reasonCodes.slice(0, 16),
      resolvedModel: record.modelResolved,
      usage: usage === null ? { known: false, inputTokens: null, outputTokens: null } : { known: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      uncertainty:
        record.calibration === undefined || record.calibration === null
          ? 'No calibration applies to this decision; treat it as advice, not a measured prediction.'
          : `Calibrated by ${record.calibration.id} version ${record.calibration.version}; the provider's confidence is not accuracy.`,
      policyVersion: record.policyVersion ?? null,
      applied: record.outcome === 'applied',
      rendered: [explainDecision(record).slice(0, 3700), modelLine(models)].join('\n'),
      models,
    },
  };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const routeOnce = new AdviceOnce();
/** Main-route advice already recorded, per workspace and advice key. */
const routeRecorded = new AdviceOnce();

interface RouteRequest {
  /** The model as the harness reports it (`provider/model` and `[1m]` allowed); resolved per request. */
  readonly currentModel: string | null;
  readonly modelPin: string | null;
  /** G20: the harness and sign-in the session runs on, when the caller knows them. */
  readonly harness: string | null;
  readonly authMode: string | null;
  readonly effortPin: string | null;
  readonly taskId: string | null;
  readonly sliceId: string | null;
  /** What the caller knows of the task, for the slice classifier when no sliceId is given. */
  readonly task?: SliceTaskHints | null;
  /** The harness session the request came from, when the caller supplies one. */
  readonly sessionId: string | null;
  /** The remaining work, tokens; the routing policy's default task size when absent. */
  readonly remaining: TokenVolume | null;
  /** Context the task needs, tokens. */
  readonly contextTokens: number | null;
  /** The running session's switch facts (warm prefix, boundary, dwell), when reported. */
  readonly switchContext: SwitchContext | null;
  /**
   * The current model exactly as the harness spelled it, kept after resolution (8c1f85d): the
   * session's signed-in provider is read from this spelling, never from a bare id that a gateway's
   * spelling happens to share.
   */
  readonly reportedModel?: string | null;
}

function routeRequest(body: unknown): RouteRequest | null {
  if (!plain(body) || !onlyKeys(body, ROUTE_KEYS)) return null;
  const read = (key: string, pattern: RegExp): string | null | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return null;
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
  };
  const currentModel = read('currentModel', HARNESS_MODEL_ID);
  const modelPin = read('modelPin', HARNESS_MODEL_ID);
  const harness = body['harness'] === undefined || body['harness'] === null ? null : (HARNESS_IDS as readonly unknown[]).includes(body['harness']) ? (body['harness'] as string) : undefined;
  const rawAuth = body['authMode'] === undefined || body['authMode'] === null ? null : (AUTH_MODES as readonly unknown[]).includes(body['authMode']) ? (body['authMode'] as string) : undefined;
  if (harness === undefined || rawAuth === undefined) return null;
  const effortPin = read('effortPin', ID);
  const taskId = read('taskId', ID);
  const sliceId = read('sliceId', ID);
  const sessionId = read('sessionId', ID);
  if (currentModel === undefined || modelPin === undefined || effortPin === undefined || taskId === undefined || sliceId === undefined || sessionId === undefined) return null;
  const facts = routeFactsOf(body);
  if (facts === undefined) return null;
  const task = taskHintsOf(body['task']);
  if (task === undefined) return null;
  // The sign-in scope: the top-level field, else the session's; `unknown` scopes nothing.
  const auth = rawAuth ?? facts.switchContext?.authMode ?? null;
  return { currentModel, modelPin, effortPin, taskId, sliceId, sessionId, harness, authMode: auth === 'unknown' ? null : auth, task, ...facts };
}

/** A provider id RoutePayload.main.consentedProviders can carry (E 7dc96df). */
const CONSENTED_PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

/** The decision path's clock: the engine's (its injected clock), else the real one. */
function nowOf(ctx: Pick<SidecarOpContext, 'engine'>): number {
  return engineOf(ctx)?.now?.() ?? Date.now();
}

function evaluationInput(ctx: SidecarOpContext, input: RouteRequest, registry: ModelRegistry, trustedKeys: ReadonlyMap<string, string>, role: 'main' | 'worker', nowMs: number): RouteEvaluationInput {
  return {
    role,
    nowMs,
    home: ctx.home,
    registry,
    trustedKeys,
    bundledCalibration: bundledCalibrationPath(ctx.home),
    killSwitchStopped: ctx.killSwitchStopped,
    sliceId: input.sliceId,
    currentModel: input.currentModel,
    pins: { modelPin: input.modelPin, effortPin: input.effortPin },
    volume: input.remaining,
    requiredContextTokens: input.contextTokens ?? 0,
    switchContext: input.switchContext,
    // G20: the main session's eligibility is scoped to its harness and sign-in, so it is never
    // told to switch to a model it cannot run there. A new worker is not: Jevris dispatches an
    // owned worker to whichever harness runs its provider (worker-auth.ts), so any harness on
    // this machine counts for it.
    ...(role === 'main' ? { harness: input.harness, authMode: input.authMode } : {}),
    // MEDIUM 9 (B's security review): advice passes the same consent gate as actuation. The
    // session is signed in to its harness's own provider and its current model's; any other
    // provider needs its stored consent. Never taken from the request body.
    providerConsent: consentReaderOf(ctx),
    signedInProviders: sessionSignedInProviders(registry, input.harness, input.reportedModel ?? input.currentModel),
  };
}

const WORKER_TEXT: Record<string, string> = {
  KILL_SWITCH: 'No managed-worker recommendation: the kill switch is on.',
  UNKNOWN_SLICE: 'No managed-worker recommendation: the task slice is unknown, so no calibration can apply.',
  NO_CALIBRATION: 'No managed-worker recommendation: there is no signed baseline release in this package and no calibration release in the config folder.',
  NO_EVALUATED_QUALITY: 'The calibration applies, but it carries no evaluated worker quality for this slice, so the approved baseline stays.',
  ROUTING_POLICY_INVALID: 'No managed-worker recommendation: routing-policy.json in the Jevris config folder is invalid.',
  REGISTRY_INVALID: 'No managed-worker recommendation: the model registry file is invalid.',
};

/** Why the placed model registry was refused, in words (B's reason codes; routing is then unavailable). */
const REGISTRY_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  MODEL_REGISTRY_TOO_LARGE: 'is larger than 1 MiB',
  MODEL_REGISTRY_NOT_JSON: 'is not JSON',
  MODEL_REGISTRY_INVALID: 'does not match the registry schema',
  MODEL_REGISTRY_UNREADABLE: 'cannot be read',
};
function registryRefusedText(reasonCode: string): string {
  return `model-registry.json in the Jevris config folder ${REGISTRY_REFUSAL_TEXT[reasonCode] ?? 'is invalid'} (${reasonCode}); fix or remove it`;
}

function workerAdvice(evaluation: RouteEvaluation | null, registry: ModelRegistry | null, refusal: string | null = null): RoutePayload['worker'] {
  const abstain = (reasonCode: string, text: string): RoutePayload['worker'] => ({ outcome: 'abstain', recommendedModel: null, reasonCode, text });
  if (registry === null && refusal !== null) return abstain(refusal, `No managed-worker recommendation: ${registryRefusedText(refusal)}.`);
  if (evaluation === null || registry === null) return abstain('REGISTRY_INVALID', WORKER_TEXT['REGISTRY_INVALID'] as string);
  const selection = evaluation.selection;
  if (selection === null) {
    const reason = evaluation.reasonCode ?? 'NO_ROUTE_DECISION';
    return abstain(reason, WORKER_TEXT[reason] ?? `No managed-worker recommendation: the calibration release does not apply (${reason}).`);
  }
  if (selection.outcome === 'pinned') {
    return { outcome: 'recommend', recommendedModel: selection.modelId, reasonCode: selection.reasonCode, text: selection.reasonCode === 'MODEL_PINNED' ? `Use the pinned ${selection.modelId}; Jevris never overrides a pin.` : `The pinned ${selection.modelId} is not allowed here (${selection.reasonCode}); it is not replaced. Pick an allowed model.` };
  }
  const name = registryModel(registry, selection.modelId)?.displayName ?? selection.modelId;
  const size = evaluation.assumedVolume ? ' The task size is the routing policy default; send the remaining tokens for a sharper estimate.' : '';
  if (selection.outcome === 'keep-baseline') {
    return { outcome: 'recommend', recommendedModel: selection.modelId, reasonCode: selection.reasonCode, text: `Keep the approved baseline ${name} for this ${selection.sliceId} task (${selection.reasonCode}).${size}` };
  }
  const saving = selection.saving;
  const range = saving === null ? '' : ` Estimated saving $${(saving.lower / 1e6).toFixed(4)} to $${(saving.upper / 1e6).toFixed(4)} per task against the baseline, at API list prices; an estimate, not a measured saving.`;
  return { outcome: 'recommend', recommendedModel: selection.modelId, reasonCode: selection.reasonCode, text: `Use ${name} for a new worker on this ${selection.sliceId} task: its released quality meets the calibrated floor at the lowest expected total cost (release ${evaluation.calibrationId ?? 'unknown'}).${range}${size}`.slice(0, 1000) };
}

/** Slices route requests named that no released calibration covers (RTE-10), newest last. */
const UNKNOWN_SLICES = new Set<string>();
const UNKNOWN_SLICE_REASONS = new Set(['NO_CALIBRATION', 'NO_EVALUATED_QUALITY', 'CALIBRATION_SLICE_NOT_PERMITTED', 'CALIBRATION_SLICE_TOO_SMALL']);

function noteSlice(sliceId: string | null, evaluation: RouteEvaluation | null): void {
  if (sliceId === null || evaluation === null) return;
  if (evaluation.reasonCode !== null && UNKNOWN_SLICE_REASONS.has(evaluation.reasonCode)) {
    UNKNOWN_SLICES.delete(sliceId);
    UNKNOWN_SLICES.add(sliceId);
    if (UNKNOWN_SLICES.size > 64) UNKNOWN_SLICES.delete(UNKNOWN_SLICES.values().next().value as string);
  } else if (evaluation.selection !== null) {
    UNKNOWN_SLICES.delete(sliceId);
  }
}

/**
 * RTE-10: the task slices this sidecar was asked to route that no released calibration covers
 * (no release, no model quality, not permitted or too small). Status shows them as unknown slices.
 */
export function unknownRouteSlices(): readonly string[] {
  return [...UNKNOWN_SLICES];
}

/**
 * G20: the request's model ids as registry ids (`anthropic/claude-opus-5-5[1m]` is
 * `claude-opus-5-5`), resolved on the request's harness when it names one (the one resolver,
 * 8c1f85d), or the bare model id when the registry has no entry. `unregistered` is the reported
 * current model the registry does not hold: a gateway or third-party id (`openrouter/...`) is one,
 * and its signed-in provider is read from `reportedModel`, so it is never gated as the maker.
 */
function resolveRouteModels(input: RouteRequest, registry: ModelRegistry | null): { readonly input: RouteRequest; readonly unregistered: string | null } {
  const current = input.currentModel === null ? null : harnessModelRef(registry, input.currentModel, input.harness);
  const pin = input.modelPin === null ? null : harnessModelRef(registry, input.modelPin, input.harness);
  return {
    input: { ...input, currentModel: current?.modelId ?? null, modelPin: pin?.modelId ?? null, reportedModel: input.currentModel },
    unregistered: registry !== null && current !== null && !current.registered ? current.raw : null,
  };
}

/**
 * Serving hosts R55: the main-session route's serving view, when the request names its harness and
 * the session's spelling resolves there. A recommendation is spelled on the session's host by the
 * route rules (host consent from B's reader; the spellings the model offer saw here).
 */
async function mainServing(ctx: SidecarOpContext, input: RouteRequest, registry: ModelRegistry, recommended: string | null): Promise<RouteServing | null> {
  const harness = input.harness;
  const raw = input.reportedModel ?? null;
  if (harness === null || raw === null || !(HARNESS_IDS as readonly string[]).includes(harness)) return null;
  try {
    const target = recommended === null ? null : registryModel(registry, recommended);
    const offer = await readModelOffer(ctx.home).catch(() => null);
    const read = consentReaderOf(ctx);
    const signedIn = [...new Set([...sessionSignedInProviders(registry, harness, raw), ...sessionSignedInParties(registry, harness as HarnessId, raw, null)])].sort();
    return routeServingOf({
      registry,
      harness: harness as HarnessId,
      sessionSpelling: raw,
      target: target === null ? null : { provider: target.provider, modelId: target.modelId },
      seen: target === null ? [] : seenSpellings(offer, { harness }, target.modelId),
      ...(read === undefined ? {} : { read }),
      signedIn,
    });
  } catch {
    return null;
  }
}

/** Jev's wait for a slice classification inside a route request: the rest of the 900 ms budget, less the route's own work. */
const SLICE_DEADLINE_MS = 700;

async function classifyRouteSlice(ctx: SidecarOpContext, hints: SliceTaskHints): Promise<SliceClassification> {
  const mode = ctx.mode ?? 'observe';
  const jev = ctx.jevAssist !== 'off' && modeAllows(mode, 'record');
  const intent: IntentContext = { workspaceId: ctx.workspace.id, evidenceRevision: WORKSPACE_REVISIONS.current(ctx.workspace.id), deadlineMs: SLICE_DEADLINE_MS };
  const engine = engineOf(ctx);
  const run = classifyTaskSlice(engine, hints, intent, { assist: jev ? 'classify' : 'off', record: modeAllows(mode, 'record') });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), SLICE_DEADLINE_MS + 50);
  });
  try {
    const first = await Promise.race([run.catch(() => 'failed' as const), late]);
    if (first !== 'late' && first !== 'failed') return first;
    // Abandoned at the deadline (or failed): the rules answer, no model, no record.
    const rules = await classifyTaskSlice(null, hints, intent, { assist: 'off', record: false });
    return { ...rules, reasonCode: first === 'late' ? 'SLICE_DEADLINE' : 'SLICE_ERROR' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What the caller can supply to turn a keep-because-unknown route into a reasoned one: the reason a
 * request that gave too little names, as short text for the answer (`needs`) and a sentence for the
 * advice. Owner decision 2026-10-01: a reason code alone sent a caller away empty-handed.
 */
function routeNeeds(reasonCode: string, input: RouteRequest): { readonly needs: string[]; readonly hint: string } {
  const needs: string[] = [];
  if (reasonCode === 'UNKNOWN_SLICE') needs.push('sliceId (for example bounded-edit), or task { paths, checkIds, title } so Jevris classifies the slice');
  if ((reasonCode === 'UNKNOWN_SLICE' || reasonCode === 'TRANSITION_COST_UNKNOWN') && input.switchContext === null) needs.push('session.warmPrefixTokens (jevris route --warm-prefix), to price a switch');
  if (needs.length === 0) return { needs, hint: '' };
  return { needs, hint: ` To get a reasoned answer, pass: ${needs.join('; and ')}.` };
}

function needsField(main: RoutePayload['main'], input: RouteRequest): { readonly needs?: string[] } {
  const needs = main.pinState === 'pinned' ? [] : routeNeeds(main.reasonCode, input).needs;
  return needs.length === 0 ? {} : { needs: needs.map((n) => n.slice(0, 300)) };
}

/** The route payload's `slice` part: how the task's slice was classified; absent when none was. */
function sliceField(c: SliceClassification | null): { readonly slice?: NonNullable<RoutePayload['slice']> } {
  if (c === null) return {};
  const used = c.sliceId === null ? 'No slice was classified, so the route keeps the approved baseline.' : `Slice ${c.sliceId} (${c.source === 'jev' ? 'classified by Jev' : 'classified by rules'}; advice only).`;
  return {
    slice: {
      sliceId: c.sliceId,
      source: c.source,
      risk: c.risk,
      confidencePercent: c.confidence === null ? null : Math.round(c.confidence * 100),
      reasonCode: c.reasonCode,
      decisionId: c.decisionId,
      asked: c.asked,
      cacheHit: c.cacheHit,
      latencyMs: c.latencyMs,
      text: `${used} Risk ${c.risk}; reason ${c.reasonCode}.`.slice(0, 300),
    },
  };
}


async function handleRoute(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const request = routeRequest(ctx.body);
  if (request === null) return fail('INVALID_REQUEST', 'send { currentModel, modelPin, effortPin, taskId, sliceId, task { title, paths, checkIds }, sessionId } (strings or null; a model may be provider/model), optional harness, authMode, remaining { inputTokens, outputTokens }, contextTokens and session { warmPrefixTokens, cacheWarm, atBoundary, unitsSinceLastSwitch, switchesThisTask, cacheTtl, authMode }');
  // Owner decision 2026-10-01: a request that names no slice but describes its task has the slice
  // classified (Jev from structured features, rules as the fallback), in parallel with the registry load.
  const classifying = request.sliceId === null && request.task !== undefined && request.task !== null ? classifyRouteSlice(ctx, request.task) : null;
  const loadedRegistry = await loadModelRegistryChecked({ home: ctx.home });
  const registry = loadedRegistry.registry;
  const refusal = loadedRegistry.registry === null ? loadedRegistry.reasonCode : null;
  const classified = classifying === null ? null : await classifying;
  const resolved = resolveRouteModels(request, registry);
  const input: RouteRequest = classified?.sliceId != null ? { ...resolved.input, sliceId: classified.sliceId } : resolved.input;
  const unregistered = resolved.unregistered;
  const pinned = input.modelPin !== null;
  let main: RoutePayload['main'];
  let workerEvaluation: RouteEvaluation | null = null;
  let mainCalibration: { readonly id: string; readonly version: string } | null = null;
  if (registry === null) {
    main = {
      currentModel: input.currentModel,
      modelPin: input.modelPin,
      pinState: pinned ? 'pinned' : 'unpinned',
      outcome: pinned ? 'keep' : 'abstain',
      recommendedModel: null,
      reasonCode: pinned ? 'PIN_RESPECTED' : (refusal ?? 'REGISTRY_INVALID'),
      costBasis: 'unknown',
      text: pinned ? `Keep ${input.modelPin}. It is pinned, and Jevris never changes a pinned model.` : `The ${registryRefusedText(refusal ?? 'MODEL_REGISTRY_INVALID')}, so Jevris gives no route advice. Keep the current model.`,
      adviceKey: null,
    };
  } else {
    const trustedKeys = await trustedCalibrationKeys(ctx.home);
    // RTE-03, C09, C10: the same evidence routes the main session and a new worker. A pin is kept
    // before any evaluation (routeTask returns it as pinned), and nothing here switches a model.
    // One clock for both evaluations and the advice: the engine's.
    const nowMs = nowOf(ctx);
    // G20: a current model outside the registry is never replaced by the registry baseline (a
    // Codex or Antigravity session must not be told to switch to a model it cannot run).
    if (!pinned && unregistered !== null) {
      workerEvaluation = await evaluateRoute(evaluationInput(ctx, input, registry, trustedKeys, 'worker', nowMs));
      noteSlice(input.sliceId, workerEvaluation);
      main = {
        currentModel: input.currentModel,
        modelPin: null,
        pinState: 'unpinned',
        outcome: 'abstain',
        recommendedModel: null,
        reasonCode: 'CURRENT_MODEL_UNREGISTERED',
        costBasis: 'unknown',
        text: `Jevris gives no route advice for ${unregistered}: it is not in the model registry, so there is no evaluated model to compare it with. Keep the current model.`.slice(0, 1000),
        adviceKey: null,
        ...(input.switchContext?.authMode === undefined ? {} : { authMode: input.switchContext.authMode }),
      };
      // R55: a pinned gateway or host spelling still shows the host it goes through.
      const serving = await mainServing(ctx, input, registry, null);
      if (serving !== null) main = { ...main, serving };
      return respond(ctx, 'route', { main, worker: workerAdvice(workerEvaluation, registry, refusal), applied: false, ...sliceField(classified) });
    }
    const mainEvaluation = pinned ? null : await evaluateRoute(evaluationInput(ctx, input, registry, trustedKeys, 'main', nowMs));
    workerEvaluation = await evaluateRoute(evaluationInput(ctx, input, registry, trustedKeys, 'worker', nowMs));
    if (mainEvaluation !== null && mainEvaluation.calibrationId !== null && mainEvaluation.calibrationVersion !== null) mainCalibration = { id: mainEvaluation.calibrationId, version: mainEvaluation.calibrationVersion };
    noteSlice(input.sliceId, workerEvaluation);
    const selection = mainEvaluation?.selection ?? null;
    const advice = adviseMainRoute(
      {
        sessionId: input.sessionId ?? input.taskId ?? 'session',
        workspaceId: ctx.workspace.id,
        revision: WORKSPACE_REVISIONS.current(ctx.workspace.id),
        mode: 'observe',
        requestedModelId: input.currentModel,
        actualModelId: input.currentModel,
        contextTokensEstimate: null,
        activeTaskIds: input.taskId === null ? [] : [input.taskId],
        observedAt: new Date(nowMs).toISOString(),
      },
      registry,
      { modelPin: input.modelPin, effortPin: input.effortPin },
      {
        once: routeOnce,
        selection,
        switchDecision: mainEvaluation?.switchDecision ?? null,
        costBasis: selection === null ? 'unknown' : (selection.costEstimates?.length ?? 0) > 0 ? 'maker-price-estimate' : 'api-list-price',
      },
    );
    const noSelection = mainEvaluation !== null && mainEvaluation.selection === null && mainEvaluation.reasonCode !== null;
    // P5: advice this session did not follow twice (overridden or left unchanged) is not repeated.
    if (advice.outcome === 'recommend' && advice.recommendedModelId !== null && adviceIgnored(ctx, 'main-route', input.sessionId, input.sliceId, advice.recommendedModelId)) {
      main = {
        currentModel: input.currentModel,
        modelPin: input.modelPin,
        pinState: 'unpinned',
        outcome: 'abstain',
        recommendedModel: null,
        reasonCode: 'ADVICE_NOT_FOLLOWED',
        costBasis: advice.costBasis,
        text: `Jevris does not repeat its advice to switch to ${advice.recommendedModelId} in this session: it was not followed twice. Keep the current model or switch yourself.`,
        adviceKey: null,
      };
      return respond(ctx, 'route', { main, worker: workerAdvice(workerEvaluation, registry, refusal), applied: false, ...sliceField(classified) });
    }
    main = {
      currentModel: input.currentModel,
      modelPin: input.modelPin,
      pinState: pinned ? 'pinned' : 'unpinned',
      outcome: advice.outcome,
      recommendedModel: advice.recommendedModelId,
      reasonCode: pinned ? 'PIN_RESPECTED' : noSelection ? (mainEvaluation.reasonCode as string) : advice.reasonCode,
      costBasis: advice.costBasis,
      text: ((noSelection ? advice.text.replace('(NO_ROUTE_DECISION)', `(${mainEvaluation.reasonCode as string})`) : advice.text) + (pinned ? '' : routeNeeds(noSelection ? (mainEvaluation.reasonCode as string) : advice.reasonCode, input).hint)).slice(0, 1000),
      adviceKey: advice.adviceKey,
      // The session's auth mode, echoed so the cost-basis line matches the text's label.
      ...(input.switchContext?.authMode === undefined ? {} : { authMode: input.switchContext.authMode }),
      // MEDIUM 9 (E 7dc96df): the providers the advice was limited to, from the same gate
      // evaluationInput applies (stored consent plus the session's signed-in providers).
      consentedProviders: providerConsentGate(registry, sessionSignedInProviders(registry, input.harness, input.reportedModel ?? input.currentModel), consentReaderOf(ctx)).consentedProviders.filter((p) => CONSENTED_PROVIDER.test(p)).slice(0, 64),
    };
    // Serving hosts R55: the host the session's model goes through and, for a recommendation, the
    // host the target would be written through on this harness; absent when either is unknown.
    const serving = await mainServing(ctx, input, registry, main.outcome === 'recommend' ? main.recommendedModel : null);
    if (serving !== null) main = { ...main, serving };
  }
  // US04, US03: the main-session advice is recorded once per advice key (no provider call, the
  // policy version on the record); repeating the request neither prompts nor records again.
  const engine = engineOf(ctx);
  const delivered = main.outcome === 'recommend' && main.recommendedModel !== null && main.adviceKey !== null;
  let deliveryId: string | null = null;
  if (engine?.recordAdvice !== undefined && main.adviceKey !== null && routeRecorded.first(`${ctx.workspace.id}:${main.adviceKey}`)) {
    const reasons = [main.reasonCode, ...(pinned ? ['MODEL_PINNED'] : [])];
    const recommended = main.outcome === 'recommend' && main.recommendedModel !== null;
    const recorded = await engine.recordAdvice({
      specId: 'main-route',
      workspaceId: ctx.workspace.id,
      evidenceRevision: WORKSPACE_REVISIONS.current(ctx.workspace.id),
      taskId: input.taskId,
      sessionId: input.sessionId,
      // The recommendation is recorded as the proposed action; it is never applied here.
      action: recommended && input.taskId !== null ? { kind: 'route-worker', taskId: input.taskId, modelId: main.recommendedModel as string, profileId: 'main-session' } : { kind: 'advise', templateId: 'main-route', evidenceIds: [] },
      reasonCodes: recommended ? [...reasons, 'COUNTERFACTUAL'] : reasons,
      calibration: mainCalibration,
    });
    if (recommended && recorded.ok) deliveryId = recorded.decisionId;
  }
  // P5: every delivery of a recommendation is opened for adherence (followed, overridden or
  // no-change, resolved by the sidecar), so advice shown again and not followed counts each time.
  // The first delivery carries its decision; a repeat, recorded once only, gets a delivery id from
  // its advice key and time. Across a sidecar restart the time keeps the ids distinct.
  if (delivered) {
    const nowMs = nowOf(ctx);
    const id = deliveryId ?? `advice-${(main.adviceKey as string).replace(/^sha256:/, '').slice(0, 32)}-${nowMs.toString(36)}`;
    openAdvice(ctx, { decisionId: id, adviceKind: 'main-route', sessionId: input.sessionId, slice: input.sliceId, advisedModel: main.recommendedModel as string, currentModel: input.currentModel, atMs: nowMs });
  }
  return respond(ctx, 'route', { main, worker: workerAdvice(workerEvaluation, registry, refusal), applied: false, ...sliceField(classified), ...needsField(main, input) });
}

async function handleExplain(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const decisionId = decisionIdOf(ctx, ['decisionId', 'sliceId']);
  if (decisionId === null) return fail('INVALID_REQUEST', 'send { decisionId, sliceId? }');
  const rawSlice = plain(ctx.body) ? ctx.body['sliceId'] : undefined;
  if (rawSlice !== undefined && rawSlice !== null && (typeof rawSlice !== 'string' || !ID.test(rawSlice))) return fail('INVALID_REQUEST', 'sliceId must be an id');
  const sliceId = typeof rawSlice === 'string' ? rawSlice : null;
  if (!isDecisionId(decisionId)) {
    // A syntactically foreign id cannot name a decision; answer not-found in the contract shape.
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decisionId) ? respond(ctx, 'explain', explainPayload(decisionId, null)) : fail('INVALID_REQUEST');
  }
  const record = await findRecord(ctx, decisionId);
  const base = explainPayload(decisionId, record, await sessionModelsFrom(ctx.store, record?.sessionId));
  // OD-8 and owner decision 29423b6: a main-session turn decision shows its harness, mode and
  // whether it was switched, and the session's link to its task. Absent for any other decision.
  const mainSession = turnMainSessionOf(record);
  const link = base.trace === null || mainSession === null ? undefined : await turnSessionLinkOf(ctx.store, record);
  // Serving hosts R55: the hosts as route.turn saw them, while this sidecar still holds the view.
  const serving = base.trace === null || mainSession === null ? undefined : turnServingOf(record);
  const payload: ExplainPayload =
    base.trace === null || mainSession === null ? base : { ...base, trace: { ...base.trace, mainSession, ...(link === undefined ? {} : { sessionLink: link }), ...(serving === undefined ? {} : { serving }) } };
  // C16: with a slice, the trace says how route learning stands for it in this workspace.
  if (payload.trace === null || sliceId === null) return respond(ctx, 'explain', payload);
  return respond(ctx, 'explain', { ...payload, trace: { ...payload.trace, learning: await learningTrace(ctx, sliceId) } });
}

async function handleDecisionGet(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const decisionId = decisionIdOf(ctx);
  if (decisionId === null) return fail('INVALID_REQUEST', 'send { decisionId }');
  const record = isDecisionId(decisionId) ? await findRecord(ctx, decisionId) : null;
  if (record !== null && !DecisionRecordContract.validate(record).ok) return fail('RECORD_INVALID');
  const models = record === null ? null : workerModelOf(record, await sessionModelsFrom(ctx.store, record.sessionId));
  return { ok: true, body: { decisionId, found: record !== null, record, models } };
}

const PLAN_ITEM_ID = /^[#A-Za-z0-9][A-Za-z0-9._-]{0,129}$/;

function planStrings(value: unknown, maxItems: number, max: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  return value.every((v) => typeof v === 'string' && v.length <= max) ? (value as string[]) : null;
}

function planRequirements(value: unknown): { id: string; text: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) return null;
  const out: { id: string; text: string }[] = [];
  for (const r of value) {
    if (!plain(r) || typeof r['id'] !== 'string' || !PLAN_ITEM_ID.test(r['id']) || typeof r['text'] !== 'string' || r['text'].length === 0 || r['text'].length > 1500) return null;
    out.push({ id: r['id'], text: r['text'] });
  }
  return out;
}

function planCandidates(value: unknown): { id: string; summary: string; constraints: string[]; tradeoffs: string[] }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) return null;
  const out: { id: string; summary: string; constraints: string[]; tradeoffs: string[] }[] = [];
  for (const c of value) {
    if (!plain(c) || typeof c['id'] !== 'string' || !PLAN_ITEM_ID.test(c['id']) || typeof c['summary'] !== 'string' || c['summary'].length === 0 || c['summary'].length > 2000) return null;
    const constraints = planStrings(c['constraints'], 16, 300);
    const tradeoffs = planStrings(c['tradeoffs'], 16, 300);
    if (constraints === null || tradeoffs === null) return null;
    out.push({ id: c['id'], summary: c['summary'], constraints, tradeoffs });
  }
  return out;
}

async function handlePlan(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const body = ctx.body;
  if (!plain(body) || !onlyKeys(body, ['tasks', 'requirements', 'candidates', 'sessionId', 'revision']) || !Array.isArray(body['tasks']) || body['tasks'].length > 1024) {
    return fail('INVALID_REQUEST', 'send { tasks: TaskNode[], requirements?, candidates? } with at most 1024 tasks');
  }
  const requirements = planRequirements(body['requirements']);
  const candidates = planCandidates(body['candidates']);
  if (requirements === null || candidates === null) return fail('INVALID_REQUEST', 'requirements are { id, text }[] (at most 64); candidates are { id, summary, constraints?, tradeoffs? }[] (at most 12)');
  const graph = planTaskGraph(body['tasks']);
  if (requirements.length === 0 && candidates.length === 0) return respond(ctx, 'plan', graph);
  const engine = engineOf(ctx);
  // DEC-12: the review starts on the workspace revision the sidecar tracks (a caller's revision
  // resets it); a write reported while Jev evaluates makes the result stale.
  const workspaceId = ctx.workspace.id;
  const revision = WORKSPACE_REVISIONS.observe(workspaceId, { revision: typeof body['revision'] === 'string' ? body['revision'] : null, wrote: false });
  const intent: IntentContext = {
    workspaceId,
    evidenceRevision: revision,
    currentRevision: () => WORKSPACE_REVISIONS.current(workspaceId),
    ...(typeof body['sessionId'] === 'string' ? { sessionId: body['sessionId'] } : {}),
    deadlineMs: Math.max(1, Math.min(2000, ctx.deadline.remainingMs())),
    options: { signal: ctx.signal, deadline: ctx.deadline },
  };
  let decomposition = null;
  if (requirements.length > 0) {
    const audit = await auditDecomposition(engine, { requirements, tasks: graph.valid ? (body['tasks'] as TaskNode[]) : [] }, intent);
    decomposition = graph.valid
      ? { label: audit.label, isFeasibility: audit.isFeasibility, issues: audit.issues.slice(0, 1024), coverage: audit.coverageReview.map((c) => ({ requirementId: c.requirementId, score: c.score })), reasonCode: audit.reasonCode, decisionId: audit.decisionId }
      : { label: audit.label, isFeasibility: audit.isFeasibility, issues: [], coverage: [], reasonCode: 'GRAPH_INVALID', decisionId: null };
  }
  let plans = null;
  if (candidates.length > 0) {
    const ranked = await rankPlanCandidates(engine, { plans: candidates }, intent);
    plans = { label: ranked.label, isFeasibility: ranked.isFeasibility, reviewRequired: ranked.reviewRequired, ranking: ranked.ranking.map((r) => ({ planId: r.planId, rank: r.rank, score: r.score })), note: ranked.note, reasonCode: ranked.reasonCode, decisionId: ranked.decisionId };
  }
  return respond(ctx, 'plan', { ...graph, review: { decomposition, plans } });
}

/**
 * EVL-08: the labelled measures beyond the decision calls (E's `jevris cost-report` renders them).
 * `apiEquivalentEstimate` is what owned workers' observed usage cost at API list prices (the
 * generation envelope's committed amount), or `unmeasured` when no owned worker settled. The
 * counterfactual is never measured. The actual is left to the decision counts (the Jev calls);
 * a subscription's credits are not observable here. No field is a saving.
 */
async function billingBlock(home: string, now: () => number): Promise<{ readonly apiEquivalentEstimate: number | 'unmeasured'; readonly counterfactualHypothetical: 'hypothetical'; readonly savingMicroUsd: null; readonly apiEquivalentBasis: string }> {
  let committed: number | null = null;
  try {
    await readFile(generationBudgetFile(home));
    const snapshot = await DecisionBudget.open(generationBudgetFile(home), { limitMicroUsd: DEFAULT_GENERATION_BUDGET_MICRO_USD, period: 'month', now }).snapshot();
    committed = snapshot === null ? null : snapshot.committedMicroUsd;
  } catch {
    committed = null;
  }
  return {
    apiEquivalentEstimate: committed === null || committed === 0 ? 'unmeasured' : committed,
    counterfactualHypothetical: 'hypothetical',
    savingMicroUsd: null,
    apiEquivalentBasis: 'owned-worker usage this month at API list prices from the model registry (an estimate, not a bill)',
  };
}

async function handleCostReport(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const engine = engineOf(ctx);
  if (engine === null) {
    return { ok: true, body: { schemaVersion: 'jevris-cost-report-1', providerConfigured: false, budget: null, decisions: null, note: 'No decision engine: rules-only.' } };
  }
  // The machine-wide limit and, with its own cap, this workspace's (owner decision 2026-09-29).
  const budget = engine.budget === null ? null : await engine.budget.snapshot(ctx.workspace.id === 'global' ? undefined : ctx.workspace.id);
  const ids = await engine.journal.list();
  const counts = { total: 0, providerCalls: 0, inputTokens: 0, outputTokens: 0, usageUnknown: 0, actualMicroUsd: 0, byOutcome: {} as Record<string, number>, byBillingBasis: {} as Record<string, number> };
  const limit = 2000;
  const samples: EstimatorSample[] = [];
  for (const id of ids.slice(-limit)) {
    if (ctx.deadline.expired()) break;
    const entry = await engine.journal.read(id);
    const record = entry?.record;
    if (record === undefined || record === null) continue;
    if (record.workspaceId !== undefined && record.workspaceId !== ctx.workspace.id) continue;
    samples.push({ estimate: record.estimate ?? null, usage: record.usage, reasonCodes: record.reasonCodes });
    counts.total += 1;
    counts.providerCalls += record.providerCalls ?? 0;
    if (record.usage === null) {
      if (record.billingBasis === 'estimate-pending-reconcile') counts.usageUnknown += 1;
    } else {
      counts.inputTokens += record.usage.inputTokens;
      counts.outputTokens += record.usage.outputTokens;
    }
    counts.actualMicroUsd += record.cost?.actualMicroUsd ?? 0;
    counts.byOutcome[record.outcome] = (counts.byOutcome[record.outcome] ?? 0) + 1;
    counts.byBillingBasis[record.billingBasis] = (counts.byBillingBasis[record.billingBasis] ?? 0) + 1;
  }
  return {
    ok: true,
    body: {
      schemaVersion: 'jevris-cost-report-1',
      providerConfigured: engine.providerConfigured,
      route: engine.route,
      budget,
      decisions: { ...counts, scanned: Math.min(ids.length, limit), truncated: ids.length > limit },
      billing: await billingBlock(ctx.home, () => nowOf(ctx)),
      // P7: the token estimator against reported usage, passive (no extra call); it never changes the estimator.
      estimator: (() => {
        const report = estimatorCalibration(samples);
        return { ...report, lines: estimatorCalibrationLines(report) };
      })(),
      // P4: decisions joined to their task's verified outcome (local only; never tunes a threshold).
      outcomes: await outcomeReportFrom(ctx.store, ctx.workspace.id),
      // P12: feedback on advice with reasons (hypotheses only; never changes a policy).
      feedback: await feedbackReportFrom(ctx.store, ctx.workspace.id),
      note: 'Decision-call cost only (Jev). Unknown usage stays unknown until reconciled; no savings are claimed.',
      diagnostics: [providerOverrideDiagnostic()].filter((line): line is string => line !== null),
    },
  };
}

/**
 * P12 (owner decision 7922ee3): a person's feedback on one decision's advice, with a reason.
 * Body `{ decisionId, accepted, reason? }`; a reason only on a rejection, `unspecified` when none
 * was given. The latest feedback on a decision wins. It never changes a policy, a threshold or a
 * route: the report gives hypotheses for a reviewed release.
 */
async function handleDecisionFeedback(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const body = ctx.body;
  if (!plain(body) || !onlyKeys(body, ['decisionId', 'accepted', 'reason'])) return fail('INVALID_REQUEST', 'send { decisionId, accepted, reason? }');
  const decisionId = body['decisionId'];
  const accepted = body['accepted'];
  const given = body['reason'];
  if (!isDecisionId(decisionId) || typeof accepted !== 'boolean') return fail('INVALID_REQUEST', 'send { decisionId, accepted, reason? }');
  if (given !== undefined && given !== null && (accepted || typeof given !== 'string' || !GIVEN_FEEDBACK_REASONS.includes(given as never))) {
    return fail('INVALID_REQUEST', `a reason is given only on a rejection: ${GIVEN_FEEDBACK_REASONS.join(', ')}`);
  }
  if (ctx.store === undefined || ctx.store === null) return fail('STORE_UNAVAILABLE', 'The Jevris store is not open.');
  const record = await findRecord(ctx, decisionId);
  if (record === null) return fail('DECISION_NOT_FOUND');
  const reason = accepted ? null : typeof given === 'string' ? given : 'unspecified';
  try {
    const { recordDecisionFeedback } = await import('@jevris/store');
    const written = recordDecisionFeedback(ctx.store, { workspaceId: ctx.workspace.id, decisionId, kind: record.specId, accepted, reason, atMs: nowOf(ctx) });
    if (!written.ok) return fail('STORE_REFUSED', `The store refused the feedback (${written.reason}).`);
    const line = accepted ? 'Recorded: the advice was accepted.' : `Recorded: the advice was rejected (${reason}).`;
    return { ok: true, body: { schemaVersion: 'jevris-decision-feedback-1', recorded: true, result: written.result, policyChanged: false, lines: [line, 'Feedback never changes a policy by itself; it gives hypotheses for a reviewed release.'] } };
  } catch {
    return fail('STORE_UNAVAILABLE', 'The Jevris store could not be written.');
  }
}

/** P12: the report over this workspace's feedback; null without a store. */
async function feedbackReportFrom(store: unknown, workspaceId: string): Promise<(FeedbackReport & { readonly lines: readonly string[] }) | null> {
  if (store === undefined || store === null) return null;
  try {
    const { readDecisionFeedback } = await import('@jevris/store');
    const report = feedbackReport(readDecisionFeedback(store, { workspaceId, limit: 5000 }).map((r) => ({ decisionId: r.decisionId, kind: r.kind, accepted: r.accepted, reason: r.reason as FeedbackRow['reason'] })));
    return { ...report, lines: feedbackLines(report) };
  } catch {
    return null;
  }
}

/**
 * P4 (owner decision 7922ee3): writes this workspace's local calibration cases, the provider's
 * per-question probabilities joined with the task's verified outcome, for a person to review.
 * Nothing loads or applies the file, and no op sends it anywhere; only a reviewer-signed release
 * can use its cases. Body: `{}`.
 */
async function handleCalibrationExport(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const body = plain(ctx.body) ? ctx.body : {};
  if (Object.keys(body).length > 0) return fail('INVALID_REQUEST', 'send {}');
  const engine = engineOf(ctx);
  if (engine === null) return fail('NO_DECISION_ENGINE', 'No decision engine: nothing to export.');
  if (ctx.store === undefined || ctx.store === null) return fail('STORE_UNAVAILABLE', 'The Jevris store is not open.');
  let rows: Awaited<ReturnType<typeof import('@jevris/store')['readDecisionOutcomes']>>;
  try {
    const { readDecisionOutcomes } = await import('@jevris/store');
    rows = readDecisionOutcomes(ctx.store, { workspaceId: ctx.workspace.id, limit: 10_000 });
  } catch {
    return fail('STORE_UNAVAILABLE', 'The Jevris store could not be read.');
  }
  const exported = await buildLocalCalibrationCases({
    workspaceId: ctx.workspace.id,
    nowMs: nowOf(ctx),
    rows,
    readRecord: async (decisionId) => (await engine.journal.read(decisionId))?.record ?? null,
  });
  const written = await writeLocalCalibrationCases(ctx.home, exported);
  if (!written.ok) return fail(written.reasonCode);
  return {
    ok: true,
    body: {
      schemaVersion: 'jevris-calibration-export-1',
      file: written.file,
      totals: exported.totals,
      groups: exported.groups.length,
      excluded: exported.excluded,
      lines: localCalibrationLines(exported, written.file),
    },
  };
}

/**
 * RTE-04: the installed calibration release and whether it applies to a slice (`{ sliceId? }`).
 * Without a slice, `applies` answers for every permitted slice's context; reasons are the
 * loader's (NO_CALIBRATION, CALIBRATION_<reason>).
 */
async function handleCalibrationStatus(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
  const engine = engineOf(ctx);
  const body = plain(ctx.body) ? ctx.body : {};
  if (!onlyKeys(body, ['sliceId'])) return fail('INVALID_REQUEST', 'send {} or { sliceId }');
  const requested = body['sliceId'];
  if (requested !== undefined && requested !== null && (typeof requested !== 'string' || !ID.test(requested))) return fail('INVALID_REQUEST', 'sliceId must be an id');
  const trustedKeys = await trustedCalibrationKeys(ctx.home);
  const bundled = bundledCalibrationPath(ctx.home);
  const nowMs = nowOf(ctx);
  const probe = await loadCalibration({ home: ctx.home, trustedKeys, bundled, killSwitchStopped: ctx.killSwitchStopped, context: workerCalibrationContext({ sliceId: typeof requested === 'string' ? requested : '-', nowMs }) });
  const where = probe.source === 'bundled' ? 'The signed baseline release in this package' : 'The calibration release in the config folder';
  const base = { schemaVersion: 'jevris-calibration-status-1', providerConfigured: engine?.providerConfigured ?? false, source: probe.source ?? null };
  if (!probe.eligible && (probe.stage === 'read' || probe.stage === 'validate' || probe.stage === 'signature')) {
    const reasonCode = probe.reasonCode === 'NO_RELEASE' ? 'NO_CALIBRATION' : `CALIBRATION_${probe.reasonCode}`;
    return { ok: true, body: { ...base, artifacts: [], applies: false, reasonCode, note: reasonCode === 'NO_CALIBRATION' ? 'There is no signed baseline release in this package and no calibration release in the config folder; worker routing keeps the approved baseline and provider confidence is advice only.' : `${where} is not usable (${probe.reasonCode}).` } };
  }
  // The file validated and is signed by a trusted key: report it, and whether it applies.
  const artifact = probe.eligible ? probe.artifact : (JSON.parse(new TextDecoder().decode(await readFile(probe.path ?? calibrationFileFor(ctx.home))).replace(/^\uFEFF/, '')) as CalibrationArtifact);
  const slices = artifact.permittedSlices.map((slice) => slice.sliceId);
  const checks = await Promise.all(
    (typeof requested === 'string' ? [requested] : slices).map(async (sliceId) => {
      const decision = await loadCalibration({ home: ctx.home, trustedKeys, bundled, killSwitchStopped: ctx.killSwitchStopped, context: workerCalibrationContext({ sliceId, nowMs }) });
      return { sliceId, applies: decision.eligible, reasonCode: decision.eligible ? 'CALIBRATION_APPLIES' : `CALIBRATION_${decision.reasonCode}` };
    }),
  );
  const applies = checks.some((c) => c.applies);
  return {
    ok: true,
    body: {
      ...base,
      artifacts: [{ id: artifact.id, releaseState: artifact.releaseState, threshold: artifact.threshold.value, slices, modelQualities: (artifact.modelQualities ?? []).length, issuedAt: artifact.issuedAt, expiresAt: artifact.expiresAt }],
      applies,
      reasonCode: applies ? 'CALIBRATION_APPLIES' : (checks[0]?.reasonCode ?? 'CALIBRATION_SLICE_NOT_PERMITTED'),
      slices: checks,
      note: applies ? `${where} applies; worker routing uses its floor and model qualities.` : `${where} does not apply now; worker routing keeps the approved baseline.`,
    },
  };
}

export { engineOf };

export const sidecarOps: readonly SidecarOpDefinition[] = Object.freeze([
  { op: 'route', scope: 'advice', budget: 'hot', handle: handleRoute },
  { op: 'explain', scope: 'status', budget: 'hot', handle: handleExplain },
  { op: 'decision.get', scope: 'status', budget: 'hot', handle: handleDecisionGet },
  { op: 'plan', scope: 'advice', budget: 'hot', handle: handlePlan },
  { op: 'cost.report', scope: 'status', budget: 'background', handle: handleCostReport },
  { op: 'calibration.status', scope: 'status', budget: 'hot', workspace: 'optional', handle: handleCalibrationStatus },
  { op: 'calibration.export', scope: 'admin', budget: 'background', handle: handleCalibrationExport },
  { op: 'decision.feedback', scope: 'submit', budget: 'hot', stoppedByKillSwitch: true, handle: handleDecisionFeedback },
] satisfies SidecarOpDefinition[]);

export const sidecarEventSubscribers: readonly SidecarEventSubscriber[] = Object.freeze([createDecisionSubscriber({ handlers: DEFAULT_TRIGGER_HANDLERS, revisions: WORKSPACE_REVISIONS })]);
