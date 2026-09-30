/**
 * Task ops for the sidecar (ORC-01..06): `task.get`, `task.submit`, `task.complete`,
 * `task.cancel`. Result bodies validate against E's payload contracts: `task.submit` answers
 * with the task.submit payload and reports only lease ids that really exist; `task.get`,
 * `task.complete` and `task.cancel` answer with the task.get payload (the task after the
 * change, with its receipts).
 */
import { ID_PATTERN, MODEL_ID_PATTERN, PROVIDER_CONSENT_TEXT, modeAllows, type HarnessId, type ModelRegistry, type SidecarOpContext, type SidecarOpOutcome } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, loadModelRegistry, providerConsentGate, readModelOffer, routeBaseline, sessionHost, signedInProvidersOf, type ModelOffer, type ProviderConsentReader, type RouteRisk } from '@jevris/core';
import { readProviderConsent, useAuthorization, type AuthorizationAction } from '@jevris/store';
import type { WorkspaceServices } from '../workspace.js';
import { readEffectiveConfig } from '../settings/config.js';
import { leaseAuthorityFor, type BudgetPolicy, type BudgetRecord, type LeaseAuthority } from '../orchestration/leases.js';
import { selfIdentity } from '../orchestration/liveness.js';
import { submitPlan, submitTask, type PlanSubmission } from '../orchestration/plans.js';
import { scheduleTasks } from '../orchestration/scheduler.js';
import { TASK_ID, checkTaskInput, getTask, listTasks, parseTaskInput, taskTransition, type TaskInput, type TaskInputProblem } from '../orchestration/tasks.js';
import { scriptedWorkerPort } from '../orchestration/test-worker.js';
import { onBudgetExhausted } from '../orchestration/budget.js';
import { recordDuplicateRevert } from '../capabilities/orchestration.js';
import { latestCapsule } from '../memory/capsule.js';
import { restoreText } from '../memory/audit.js';
import { sliceVolume } from '../orchestration/estimates.js';
import { drainIntegrationReverts } from '../orchestration/integration-reverts.js';
import { drainRouteLearning, keepEscalatedRoute, keepLearningNote, recordRouteOutcome, runAccessLimited, runIncomplete } from '../orchestration/learning.js';
import { PROVIDER_HARNESSES, harnessAuthMode, readWorkerAuthSettings, signedInSource, workerProvider, type WorkerAuthMode, type WorkerHarness } from '../orchestration/worker-auth.js';
import { isCertified } from '../hooks/certification.js';
import { accessPausedModels } from '../orchestration/access-limits.js';
import { hostHarnessId, linkedSessionRead } from '../orchestration/worker-hosts.js';
import { hostRouteCertified } from '../orchestration/approved-scope.js';
import { refuseLeasedTask } from '../orchestration/workers.js';
import { MODEL_PORT_OF, cancelPending, cancelTask, completeTask, heldTaskEffects, loadWorkerPort, modelUnavailableHere, reconcileOwnedEffect, runLeasedTask, workerRuns, type RunLeasedTaskResult, type WorkerPort, type WorkerRunRecord } from '../orchestration/workers.js';
import { isPlain, own, recordKey, safeText } from '../util.js';

const CONTRACT_ID = new RegExp(ID_PATTERN);

export type Respond = (ctx: SidecarOpContext, surface: 'task.get' | 'task.submit', body: unknown) => SidecarOpOutcome;
export type WorkspaceOf = (ctx: SidecarOpContext) => WorkspaceServices | undefined;

export function taskView(ws: WorkspaceServices, taskId: string) {
  const task = getTask(ws, taskId);
  const receipts = ws.receipts
    .list(ws.workspaceId, { taskId })
    .filter((r) => CONTRACT_ID.test(r.receipt.id) && CONTRACT_ID.test(r.receipt.checkId))
    .slice(-512)
    .map((r) => ({ receiptId: r.receipt.id, checkId: r.receipt.checkId, outcome: r.receipt.outcome, fresh: r.validity === 'current' }));
  return {
    taskId,
    found: task !== undefined,
    task:
      task === undefined
        ? null
        : {
            id: task.node.id,
            state: task.node.state,
            revision: task.node.revision,
            requirementIds: [...task.node.requirementIds],
            dependencyIds: [...task.node.dependencyIds],
            acceptanceCheckIds: [...task.node.acceptanceCheckIds],
            // Why a blocked task waits (DEPENDENCY_CANCELLED, LEASE_EXPIRED ...); only a reason code, never free text.
            ...(task.node.state === 'blocked' && task.stateReason !== null && /^[A-Z][A-Z0-9_]{0,63}$/.test(task.stateReason) ? { stateReason: task.stateReason } : {}),
          },
    receipts,
    worker: workerView(ws, taskId),
    // Worker runs that ended after a newer lease owned the task: history only (W04).
    lateResults: workerRuns(ws, taskId).filter((r) => r.stale === true).length,
    // A cancel that was delivered but whose run has not published its end yet.
    ...(cancelPending(ws, taskId) ? { cancelRequested: true as const } : {}),
  };
}

const MODEL = new RegExp(MODEL_ID_PATTERN);

/** The latest owned run of the task (W01): requested and actual model kept apart, reported cost only. */
function workerView(ws: WorkspaceServices, taskId: string) {
  // A late result is history only: it never becomes the task's worker line (W04).
  const runs = workerRuns(ws, taskId).filter((r) => r.stale !== true);
  const run = runs.reduce<WorkerRunRecord | undefined>((a, b) => (a === undefined || b.endedAtMs >= a.endedAtMs ? b : a), undefined);
  if (run === undefined) return null;
  const model = (m: string | null) => (m !== null && MODEL.test(m) ? m : null);
  const cost = run.costUsd === null || !Number.isFinite(run.costUsd) || run.costUsd < 0 ? null : Math.round(run.costUsd * 1_000_000);
  return {
    requestedModel: model(run.requestedModel),
    actualModel: model(run.actualModel),
    status: run.status,
    costMicroUsd: cost,
    costBasis: cost === null ? ('unknown' as const) : ('reported' as const),
    durationMs: Number.isFinite(run.durationMs) && run.durationMs >= 0 ? Math.round(run.durationMs) : null,
  };
}

function taskIdOf(ctx: SidecarOpContext): string | undefined {
  const body = ctx.body;
  if (!isPlain(body)) return undefined;
  const id = own(body, 'taskId');
  return typeof id === 'string' && CONTRACT_ID.test(id) ? id : undefined;
}

/** Test seam: the worker port and authority the ops use. */
export interface TaskOpDeps {
  readonly authority?: (ws: WorkspaceServices) => LeaseAuthority;
  readonly workerPort?: () => Promise<WorkerPort | null>;
  /**
   * Whether `worker.route` is certified for a harness here (test seam). Default: the harness's
   * certification record, for a real harness port; a scripted or injected port is not a harness
   * and is not gated.
   */
  readonly workerRouteCertified?: (harness: WorkerHarness, nowMs: number) => Promise<boolean>;
}

/** The feature an owned worker's routing (model and effort chosen by the router) needs (§15.4, DOMAINS 72ff950). */
export const WORKER_ROUTE_FEATURE = 'worker.route';

const HARNESS_ID: { readonly [H in WorkerHarness]: HarnessId } = { claude: 'claude', codex: 'codex', opencode: 'opencode', kilo: 'kilocode', antigravity: 'antigravity' };

/**
 * The time a route decision is made at: the engine's injected clock (`engine.now`, C 930f425),
 * so a certification window, a learning record and the router all see one clock. Without an
 * engine, or when its clock fails or answers nonsense, the real clock.
 */
export function engineNow(engine: unknown): number {
  if (engine !== null && typeof engine === 'object') {
    try {
      const now = (engine as { now?: unknown }).now;
      if (typeof now === 'function') {
        const value: unknown = now.call(engine);
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
      }
    } catch {
      // an engine wrapper that cannot hand out its clock: the real one
    }
  }
  return Date.now();
}

/** The harness certification answer for worker.route at `nowMs` (fails closed: uncertified on any error). */
export async function certifiedWorkerRoute(home: string, harness: WorkerHarness, nowMs: number): Promise<boolean> {
  try {
    return (await isCertified({ home, harness: HARNESS_ID[harness], featureId: WORKER_ROUTE_FEATURE, nowMs })).certified;
  } catch {
    return false;
  }
}

let deps: TaskOpDeps = {};

export function setTaskOpDeps(next: TaskOpDeps): void {
  deps = next;
}

const background = new Set<Promise<unknown>>();

/** Resolves when every background worker started by `task.submit` has finished (tests, shutdown). */
export async function drainBackgroundWorkers(): Promise<void> {
  while (background.size > 0) await Promise.allSettled([...background]);
  // A revert scan queues route labels, so it drains first.
  await drainIntegrationReverts();
  await drainRouteLearning();
}

/** Expires dead or late leases in this workspace; their tasks become blocked (LEASE_EXPIRED). */
async function sweepLeases(ctx: SidecarOpContext, ws: WorkspaceServices): Promise<readonly string[]> {
  try {
    const expired = await (deps.authority ?? leaseAuthorityFor)(ws).sweep(ws.workspaceId, Date.now());
    if (expired.length > 0) ctx.trace({ event: 'orchestrator.lease-expired', reasonCode: `EXPIRED_${String(Math.min(expired.length, 999))}` });
    return expired;
  } catch {
    return [];
  }
}

/** What C's engine exposes for managed-worker routing (`runManagedWorker` inside it). */
interface ManagedRouteLaunch {
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly reservationId: string;
  /** The effort arm, only when it is not the model's default (C 1fc41b9). */
  readonly effort?: string;
}
interface ManagedRouteReceipt {
  readonly status: string;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly usage: WorkerRunRecord['usage'];
  readonly costUsd: number | null;
}
type RouteManagedWorker = (input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sliceId: string | null;
  readonly eligibleModels?: readonly string[];
  readonly mode: 'observe' | 'advise' | 'bounded-auto';
  /** The task's rules-only risk class (risk.ts): only `low` explores or follows a learned slice. */
  readonly risk: RouteRisk;
  readonly killSwitchStopped: () => boolean;
  readonly launch: (input: ManagedRouteLaunch) => Promise<ManagedRouteReceipt>;
  /** How the worker's harness is billed (C16 prices it). */
  readonly authMode?: WorkerAuthMode;
  /** The harness the worker runs on (C's HARNESS_IDS value): with authMode it scopes a MODEL_NOT_ACCESSIBLE entry. */
  readonly harness?: string;
  /** The slice's measured p90 tokens per run in this workspace (P11); the router only raises its volume with it. */
  readonly taskVolume?: { readonly inputTokens: number; readonly outputTokens: number; readonly n: number } | null;
  /** OD-3 (C 586a520): the plan's approved model, the route's baseline when registered; null for a task naming none. */
  readonly approvedModelId?: string | null;
  /** R11 (C 586a520): each candidate model's harness and sign-in; null for a model no installed harness reaches. */
  readonly candidateScopes?: { readonly [modelId: string]: CandidateScope };
  /** f17a3bc: why each registry model is out of a no-model task's set (C shows it in explain). */
  readonly candidateExclusions?: { readonly [modelId: string]: string };
  /** R52: the pinned host the task's linked session goes through; every candidate is priced and launched there. */
  readonly servingHost?: string | null;
  /** R52: route.host certified for the worker's harness (the certify record). */
  readonly hostRouteCertified?: boolean;
}) => Promise<{ readonly launched: boolean; readonly reasonCode?: string; readonly learning?: unknown; readonly effort?: string | null }>;

/** The slice's measured task volume for the route request (P11, C's `taskVolume`), when there is enough of it. */
function volumeOf(ws: WorkspaceServices, sliceId: string | null): { readonly taskVolume?: { readonly inputTokens: number; readonly outputTokens: number; readonly n: number } } {
  if (sliceId === null) return {};
  const v = sliceVolume(ws, sliceId);
  return v === null ? {} : { taskVolume: { inputTokens: v.p90InputTokens, outputTokens: v.p90OutputTokens, n: v.n } };
}

function routerOf(engine: unknown): RouteManagedWorker | null {
  if (engine === null || typeof engine !== 'object') return null;
  try {
    const fn = (engine as { routeManagedWorker?: unknown }).routeManagedWorker;
    return typeof fn === 'function' ? (fn.bind(engine) as RouteManagedWorker) : null;
  } catch {
    // An engine wrapper that cannot hand the method out (a proxy invariant, say): no routing,
    // the approved model runs; it never fails the submission.
    return null;
  }
}

/**
 * The counterfactual in observe and advise (US03, RTE-12): C's router records what it would
 * pick for each queued task; nothing is reserved or launched and the task keeps its model.
 */
async function recordCounterfactuals(ctx: SidecarOpContext, ws: WorkspaceServices, mode: 'observe' | 'advise', ids: readonly string[], why?: string): Promise<void> {
  const route = routerOf(ctx.engine);
  if (route === null || ctx.killSwitchStopped) return;
  for (const id of ids.slice(0, 32)) {
    const task = getTask(ws, id);
    if (task === undefined) continue;
    try {
      const result = await route({
        taskId: id,
        workspaceId: ws.workspaceId,
        sliceId: task.sliceId,
        ...(task.models.length === 0 ? {} : { eligibleModels: task.models }),
        mode,
        risk: task.risk,
        ...volumeOf(ws, task.sliceId),
        killSwitchStopped: () => ctx.killSwitchStopped,
        launch: () => Promise.reject(new Error('observe and advise never launch')),
      });
      ctx.trace({ event: 'orchestrator.route-counterfactual', taskId: id, reasonCode: (why ?? result.reasonCode ?? 'RECORDED').slice(0, 64) });
    } catch {
      // Advice only: a failed record changes nothing.
    }
  }
}

/**
 * Schedules the given tasks and runs each granted lease in the background, when owned workers
 * are automatic (`routing.managedWorkers: bounded-auto`, orchestration enabled, kill switch
 * clear) and the worker port loads. Otherwise the tasks stay queued (and, in observe or
 * advise, C's router records its counterfactual choice). In bounded-auto each run goes through
 * C's `routeManagedWorker` when the engine has it: the router picks among the task's eligible
 * models, reserves the generation budget and launches the leased run with that model; when it
 * does not launch, the task's approved model runs and the reason is traced.
 */
async function startOwnedWork(
  ctx: SidecarOpContext,
  ws: WorkspaceServices,
  only: readonly string[],
  escalation?: EscalationLaunch,
): Promise<{ readonly leaseIds: readonly string[]; readonly reasonCodes: ReadonlyMap<string, string>; readonly fallback: string }> {
  const config = readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config;
  // Crash recovery first (ORC-03): a lease whose holder died or stopped heartbeating blocks its
  // task for reconciliation before anything new is scheduled.
  await sweepLeases(ctx, ws);
  // routing.managedWorkers never exceeds the mode (readEffectiveConfig caps it, owner decision 0eb319de).
  const auto = config.orchestration.enabled && modeAllows(config.routing.managedWorkers, 'actuate') && !ctx.killSwitchStopped;
  const withModel = only.filter((id) => getTask(ws, id)?.models[0] !== undefined);
  // f17a3bc: a task that names no models routes among every eligible, consented model.
  const unnamed = only.filter((id) => { const t = getTask(ws, id); return t !== undefined && t.models.length === 0; });
  if (!auto || (withModel.length === 0 && unnamed.length === 0)) {
    const mode = config.routing.managedWorkers;
    if (config.orchestration.enabled && (mode === 'observe' || mode === 'advise')) await recordCounterfactuals(ctx, ws, mode, withModel);
    const code = auto ? 'QUEUED_NO_MODEL' : 'QUEUED';
    for (const id of only) ctx.trace({ event: 'orchestrator.task-queued', taskId: id, reasonCode: auto ? 'NO_WORKER_MODEL' : 'WORKERS_NOT_AUTOMATIC' });
    return { leaseIds: [], reasonCodes: new Map(), fallback: code };
  }
  // JEVRIS_TEST=1 with a worker script replaces the SDK session (acceptance suites only);
  // doctor reports it through testWorkerPortStatus.
  const scripted = deps.workerPort === undefined ? scriptedWorkerPort(process.env, ctx.home) : null;
  if (scripted !== null) ctx.trace({ event: 'orchestrator.test-worker-port', reasonCode: 'ACTIVE' });
  const consent = providerConsentOf(ws);
  const port = scripted ?? (await (deps.workerPort ?? (() => loadWorkerPort({}, { configDir: ws.configDir, home: ws.home, ...(consent === undefined ? {} : { providerConsent: consent }) })))());
  if (port === null) return { leaseIds: [], reasonCodes: new Map(), fallback: 'QUEUED_WORKER_UNSUPPORTED' };
  const defaultRegistry = unnamed.length === 0 ? null : ((await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY);
  // R74 (E10): a model an access limit pauses here is out of the default set, so its baseline is one that can run.
  const defaults =
    defaultRegistry === null
      ? null
      : await defaultCandidates(port, defaultRegistry, consent, await readModelOffer(ws.home).catch(() => null), await accessPausedModels({ home: ws.home, registry: defaultRegistry, port, models: defaultRegistry.entries.map((e) => e.modelId), nowMs: engineNow(ctx.engine) }));
  const noModel = defaults === null || defaults.models.length === 0 ? unnamed : [];
  for (const id of noModel) ctx.trace({ event: 'orchestrator.task-queued', taskId: id, reasonCode: 'NO_WORKER_MODEL' });
  const runnable = [...withModel, ...unnamed.filter((id) => !noModel.includes(id))];
  if (runnable.length === 0) return { leaseIds: [], reasonCodes: new Map(noModel.map((id) => [id, 'QUEUED_NO_MODEL'] as const)), fallback: 'QUEUED_NO_MODEL' };
  const authority = (deps.authority ?? leaseAuthorityFor)(ws);
  const scheduled = await scheduleTasks(ws, { authority, holder: selfIdentity(), cap: config.orchestration.maxConcurrentWorkers, only: runnable });
  const reasonCodes = new Map<string, string>(noModel.map((id) => [id, 'QUEUED_NO_MODEL'] as const));
  for (const skip of scheduled.skipped) reasonCodes.set(skip.taskId, skip.reason);
  // Budget exhaustion (ORC-10, W09): the policy for running work and the suggestion set.
  const exhausted = new Map<string, { taskId: string; reasonCode: string }[]>();
  for (const skip of scheduled.skipped) {
    if (skip.reason !== 'OVER_BUDGET' && skip.reason !== 'BUDGET_PAUSED') continue;
    const budgetId = getTask(ws, skip.taskId)?.node.rootBudgetId;
    if (budgetId === undefined) continue;
    exhausted.set(budgetId, [...(exhausted.get(budgetId) ?? []), { taskId: skip.taskId, reasonCode: skip.reason }]);
  }
  for (const [budgetId, refused] of exhausted) {
    const report = await onBudgetExhausted(ws, authority, budgetId, refused);
    ctx.trace({ event: 'orchestrator.budget-exhausted', reasonCode: report === undefined ? 'UNKNOWN_BUDGET' : `POLICY_${report.policy.toUpperCase().replace(/-/g, '_')}` });
  }
  const leaseIds: string[] = [];
  for (const grant of scheduled.leased) {
    const task = getTask(ws, grant.lease.taskId);
    const escalated = escalation !== undefined && escalation.taskId === grant.lease.taskId ? escalation : undefined;
    // A task that names no models starts from the default set's baseline, and routes within it.
    const candidates = task === undefined || task.models.length > 0 || defaults === null ? null : defaults;
    const model = escalated?.model ?? task?.models[0] ?? candidates?.baseline;
    if (task === undefined || model === undefined) continue;
    reasonCodes.set(grant.lease.taskId, 'LEASED');
    leaseIds.push(grant.lease.id);
    const runWith = (chosen: string, maxBudgetUsd?: number, effort?: string, servingHost?: string) =>
      runLeasedTask(ws, grant, {
        authority,
        port,
        model: chosen,
        ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
        ...(effort === undefined ? {} : { effort }),
        ...(servingHost === undefined ? {} : { servingHost }),
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
        prompt: workerPrompt(ws, task, escalated?.history),
        decisionNow: () => engineNow(ctx.engine),
      }).then((result) => {
        // A model found gone: recorded on the machine (or why not), or refused before launch. Codes only.
        const found = result.run?.modelUnavailable;
        if (found !== undefined) ctx.trace({ event: 'orchestrator.model-unavailable', taskId: task.node.id, reasonCode: found.recorded === 'RECORDED' ? found.reasonCode : `RECORD_${found.recorded}`.slice(0, 64) });
        else if (result.reasonCode === 'MODEL_UNAVAILABLE') ctx.trace({ event: 'orchestrator.model-unavailable', taskId: task.node.id, reasonCode: 'NOT_LAUNCHED' });
        // A run that ended with no receipt labels the task's decisions (and its route, once kept) as a failure (P2).
        if (runIncomplete(result.run)) recordRouteOutcome(ws, task.node.id, 'run-incomplete', { run: result.run, nowMs: engineNow(ctx.engine) });
        // R74: an access limit is the neutral usage-limited outcome on every owned path.
        else if (runAccessLimited(result.run)) recordRouteOutcome(ws, task.node.id, 'usage-limited', { run: result.run, nowMs: engineNow(ctx.engine) });
        return result;
      });
    const route = routerOf(ctx.engine);
    // The one bounded escalation runs its stronger model as chosen: the router never swaps it.
    if (escalated !== undefined) ctx.trace({ event: 'orchestrator.worker-route', taskId: task.node.id, reasonCode: 'ESCALATED' });
    // worker.route (§15.4, DOMAINS 72ff950): routing acts only on a harness certified for it.
    // Uncertified, the router only advises (its counterfactual is recorded) and the approved
    // model runs as approved, with no effort setting.
    const certified = (m: string): Promise<boolean> => {
      if (deps.workerRouteCertified === undefined && (scripted !== null || deps.workerPort !== undefined)) return Promise.resolve(true);
      const harness = port.harnessFor?.(m) ?? null;
      if (harness === null) return Promise.resolve(false);
      return (deps.workerRouteCertified ?? ((h: WorkerHarness, at: number) => certifiedWorkerRoute(ctx.home, h, at)))(harness, engineNow(ctx.engine));
    };
    const launched =
      escalated !== undefined
        ? runWith(model).then(async (r) => {
            // The escalated run is its own route, not randomized (P2); its outcomes label it.
            if (r.run !== null && (await keepEscalatedRoute(ws, { taskId: task.node.id, leaseId: r.run.leaseId, run: r.run, nowMs: engineNow(ctx.engine) }).catch(() => null)) !== null) {
              if (runIncomplete(r.run)) recordRouteOutcome(ws, task.node.id, 'run-incomplete', { run: r.run, nowMs: engineNow(ctx.engine) });
              else if (runAccessLimited(r.run)) recordRouteOutcome(ws, task.node.id, 'usage-limited', { run: r.run, nowMs: engineNow(ctx.engine) });
            }
            return settleEscalation(ws, r);
          })
        : route === null
          ? runWith(model)
          : certified(model).then(async (ok) => {
              if (ok) return routedRun(ctx, ws, task, route, model, runWith, port, certified, candidates, await sessionServingHost(ctx, ws, port, task.node.id, model), { grant, authority });
              ctx.trace({ event: 'orchestrator.worker-route', taskId: task.node.id, reasonCode: 'ACTUATOR_UNCERTIFIED' });
              await recordCounterfactuals(ctx, ws, 'advise', [task.node.id], 'ACTUATOR_UNCERTIFIED');
              return runWith(model);
            });
    // When a run ends, the freed lease goes to the next queued task (JEV-0008): with more tasks
    // than `maxConcurrentWorkers`, nothing else would ever start them.
    const run: Promise<unknown> = launched.then(() => drainQueue(ctx, ws, task.node.id)).finally(() => background.delete(run));
    background.add(run);
  }
  return { leaseIds, reasonCodes, fallback: 'QUEUED' };
}

/** The kill switch now, not as the request that started the work saw it. Fails closed. */
async function killSwitchStoppedNow(ctx: SidecarOpContext): Promise<boolean> {
  if (ctx.killSwitchNow === undefined) return ctx.killSwitchStopped;
  try {
    return await ctx.killSwitchNow();
  } catch {
    return true;
  }
}

/**
 * After an owned run ends, leases the queued tasks the freed slot allows (JEV-0008). The kill
 * switch is read live: it may have been set while the run was going, and then nothing new
 * starts. A task the run left queued (it went back to ready) is not started again by its own
 * end, so a run that keeps bouncing cannot loop. A failure is traced, never thrown.
 */
async function drainQueue(ctx: SidecarOpContext, ws: WorkspaceServices, endedTaskId: string): Promise<void> {
  try {
    const left = getTask(ws, endedTaskId)?.node.state;
    if (left === 'proposed' || left === 'validated' || left === 'ready') return;
    const stopped = await killSwitchStoppedNow(ctx);
    if (stopped) {
      ctx.trace({ event: 'orchestrator.plan-continued', reasonCode: 'KILL_SWITCH' });
      return;
    }
    await continueOwnedWork({ ...ctx, killSwitchStopped: false }, ws);
  } catch {
    ctx.trace({ event: 'orchestrator.plan-continued', reasonCode: 'CONTINUE_FAILED' });
  }
}

/**
 * Continues the plan (W04): once a task is verified or reconciled, the tasks whose
 * prerequisites are now verified are promoted and leased under the same bounded-auto
 * conditions as plan.submit. Nothing starts when workers are not automatic, the kill switch
 * is stopped, or no task is waiting.
 */
export async function continueOwnedWork(ctx: SidecarOpContext, ws: WorkspaceServices): Promise<readonly string[]> {
  const waiting = listTasks(ws, { states: ['validated', 'ready'] }).map((t) => t.node.id);
  if (waiting.length === 0 || ctx.killSwitchStopped) return [];
  const started = await startOwnedWork(ctx, ws, waiting);
  if (started.leaseIds.length > 0) ctx.trace({ event: 'orchestrator.plan-continued', reasonCode: 'NEXT_WAVE_LEASED' });
  return started.leaseIds;
}

/** Time a hot op keeps back from its deadline to write its answer (A's bug 1). */
const CONTINUE_ANSWER_MARGIN_MS = 150;

/**
 * Continues the plan after an op has committed a person's decision (a budget resume, a
 * reconcile), without letting the continuation cost the answer (A's bug 1). Leasing the next wave
 * sweeps leases, loads the worker port, the registry and the model offer and routes each task,
 * which under load passes a hot op's 900 ms: the answer then said DEADLINE although the decision
 * was applied. The op waits for the continuation only while its deadline allows; after that it
 * answers with the state as it is, and the continuation finishes in the background, tracked with
 * the background workers (drainBackgroundWorkers). A failure is traced, never thrown.
 */
export async function continueOwnedWorkWithin(ctx: SidecarOpContext, ws: WorkspaceServices): Promise<void> {
  const run: Promise<unknown> = continueOwnedWork(ctx, ws)
    .catch(() => ctx.trace({ event: 'orchestrator.plan-continued', reasonCode: 'CONTINUE_FAILED' }))
    .finally(() => background.delete(run));
  background.add(run);
  const waitMs = ctx.deadline.remainingMs() - CONTINUE_ANSWER_MARGIN_MS;
  if (waitMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bound for the capsule part of a worker prompt, in characters. */
export const WORKER_CAPSULE_CHARS = 4_000;

/**
 * The owned worker's prompt (W01, W03): the task, its expected outputs and write scopes, then
 * the rehydrated capsule for the task (else the workspace's): mandatory items first
 * (constraints, open checks, source handles), bounded, marked advice only.
 */
export function workerPrompt(ws: WorkspaceServices, task: NonNullable<ReturnType<typeof getTask>>, history?: string): string {
  const base = `${task.title}\nExpected outputs: ${task.expectedOutputs.join(', ')}\nStay within: ${task.node.writeScopes.join(', ') || 'the task scope'}.`;
  const head = history === undefined ? base : `${base}\n\n${history}`;
  const capsule = latestCapsule(ws, task.node.id) ?? latestCapsule(ws, null);
  if (capsule === undefined) return head;
  const items = [...capsule.items].sort((a, b) => Number(b.mandatory) - Number(a.mandatory));
  return `${head}\n\n${restoreText(items, capsule.id, WORKER_CAPSULE_CHARS)}`;
}

// ------------------------------------------------------------------ bounded escalation (W02)

/** The stored escalation for a task (collection 'escalations', one per task). */
export interface EscalationState {
  readonly atMs: number;
  readonly fromModel: string | null;
  readonly toModel: string | null;
  /** launched: the stronger worker runs; exhausted: it failed and the task is blocked. */
  readonly state: 'recorded' | 'launched' | 'exhausted' | 'no-stronger-worker' | 'not-relaunchable';
}

interface EscalationLaunch {
  readonly taskId: string;
  readonly model: string;
  readonly history: string;
}

/** Bound for the compact history a stronger worker receives, in characters. */
export const ESCALATION_HISTORY_CHARS = 2_000;

/**
 * The next model after the one that last ran, among the task's approved models (never outside
 * them), skipping `unavailable`: models gone here and models whose provider has no consent.
 */
export function strongerModel(ws: WorkspaceServices, task: NonNullable<ReturnType<typeof getTask>>, unavailable: ReadonlySet<string> = new Set()): { readonly from: string | null; readonly to: string | null } {
  const runs = workerRuns(ws, task.node.id);
  const from = runs.at(-1)?.requestedModel ?? task.models[0] ?? null;
  const at = from === null ? -1 : task.models.indexOf(from);
  // The next stronger approved model that is not found gone here.
  const to = at < 0 ? null : (task.models.slice(at + 1).find((m) => !unavailable.has(m)) ?? null);
  return { from, to };
}

/**
 * The one bounded escalation (W02, SSOT §12.3): a failed owned task whose repair budget is spent
 * is relaunched once with the next stronger approved model. That worker receives the compact
 * history (failures observed, approaches rejected) and still completes only from a new receipt.
 * If it fails too, the task ends blocked (ESCALATION_EXHAUSTED) and recover gives the blocked
 * report. Workers must be automatic (bounded-auto, kill switch clear); nothing outside the
 * task's approved models is ever used.
 */
export async function relaunchEscalated(
  ctx: SidecarOpContext,
  ws: WorkspaceServices,
  taskId: string,
  history: { readonly failures: readonly string[]; readonly rejectedApproaches: readonly string[] },
): Promise<EscalationState> {
  const task = getTask(ws, taskId);
  const key = recordKey(ws.workspaceId, taskId);
  const put = async (state: EscalationState) => {
    await ws.state.transact((tx) => tx.put('escalations', key, state));
    return state;
  };
  if (task === undefined || task.node.state !== 'failed') return put({ atMs: Date.now(), fromModel: null, toModel: null, state: 'not-relaunchable' });
  const gone = new Set<string>();
  for (const m of task.models) if ((await modelUnavailableHere(ws.home, m, null)) !== null) gone.add(m);
  const consent = providerConsentOf(ws);
  const port = await readPortOf(ctx, ws, consent);
  const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  // B's review, INFO 14: a model whose provider the consent gate blocks is never the stronger worker.
  for (const m of await consentBlockedModels(ws, port, registry, consent, task.models)) gone.add(m);
  // R74 (E7): nor is one an access limit pauses on its scope here.
  if (port !== null) for (const m of await accessPausedModels({ home: ws.home, registry, port, models: task.models, nowMs: engineNow(ctx.engine) })) gone.add(m);
  const { from, to } = strongerModel(ws, task, gone);
  if (to === null) return put({ atMs: Date.now(), fromModel: from, toModel: null, state: 'no-stronger-worker' });
  const lines = [
    `Bounded escalation (one attempt) after ${from ?? 'the approved model'} failed. Success needs a new passing check result.`,
    ...(history.failures.length === 0 ? [] : ['Observed failures:', ...history.failures.slice(-8).map((f) => `- ${f}`)]),
    ...(history.rejectedApproaches.length === 0 ? [] : ['Rejected approaches (do not repeat):', ...history.rejectedApproaches.slice(-8).map((r) => `- ${r}`)]),
  ];
  const text = safeText(lines.join('\n'), ESCALATION_HISTORY_CHARS);
  // C16: the failed route's outcome is a retry (the stronger worker is a new, unrouted attempt).
  recordRouteOutcome(ws, taskId, 'retried', { run: workerRuns(ws, taskId).at(-1) ?? null, nowMs: engineNow(ctx.engine) });
  const moved = taskTransition(ws, taskId, 'ready', `bounded escalation to ${to}`, { actor: 'runner', nowMs: Date.now() });
  if (!moved.ok) return put({ atMs: Date.now(), fromModel: from, toModel: to, state: 'not-relaunchable' });
  const state = await put({ atMs: Date.now(), fromModel: from, toModel: to, state: 'launched' });
  const started = await startOwnedWork(ctx, ws, [taskId], { taskId, model: to, history: text });
  if (started.leaseIds.length === 0) {
    // Not leased (workers not automatic, kill switch, no port): back to failed, recorded.
    taskTransition(ws, taskId, 'failed', `escalation not launched: ${started.reasonCodes.get(taskId) ?? started.fallback}`, { actor: 'runner', nowMs: Date.now() });
    return put({ ...state, state: 'not-relaunchable' });
  }
  return state;
}

/**
 * INFO 14 (B's security review): the task's models whose provider the OD-4 consent gate blocks,
 * from the stored consent and the sign-ins the worker port sees (finding 8's rule). When the port
 * cannot say which harness runs a model, every provider counts as signed in, so only a revoke, a
 * stale grant or a provider that always asks (Kimi, DeepSeek) without a grant blocks, as at launch.
 */
async function consentBlockedModels(ws: WorkspaceServices, port: WorkerPort | null, registry: ModelRegistry, consent: ProviderConsentReader | undefined, models: readonly string[]): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  if (models.length === 0) return out;
  const scopes = port === null ? null : await candidateScopesFor(port, models);
  const signedIn = scopes === null ? [...new Set(registry.entries.map((e) => e.provider))] : signedInProvidersOf(registry, scopes, await readModelOffer(ws.home).catch(() => null));
  const gate = providerConsentGate(registry, signedIn, consent ?? ((provider: string) => ({ granted: false, provider, reasonCode: 'PROVIDER_CONSENT_MISSING' })));
  for (const model of models) {
    const provider = registry.entries.find((e) => e.modelId === model)?.provider;
    if (provider !== undefined && !gate.consentedProviders.includes(provider)) out.add(model);
  }
  return out;
}

/** The worker port for a read outside a launch (escalation's filters): the scripted test port, the injected one, else the dispatching port; null when none loads. */
async function readPortOf(ctx: SidecarOpContext, ws: WorkspaceServices, consent: ProviderConsentReader | undefined): Promise<WorkerPort | null> {
  const scripted = deps.workerPort === undefined ? scriptedWorkerPort(process.env, ctx.home) : null;
  return scripted ?? (await (deps.workerPort ?? (() => loadWorkerPort({}, { configDir: ws.configDir, home: ws.home, ...(consent === undefined ? {} : { providerConsent: consent }) })))().catch(() => null));
}

/** After the escalated run: a failure ends the task blocked with a reproducible report. */
async function settleEscalation(ws: WorkspaceServices, result: RunLeasedTaskResult): Promise<RunLeasedTaskResult> {
  if (result.finalState !== 'failed') return result;
  const key = recordKey(ws.workspaceId, result.taskId);
  const prior = ws.state.get<EscalationState>('escalations', key);
  taskTransition(ws, result.taskId, 'blocked', 'ESCALATION_EXHAUSTED: the bounded escalation failed; see jevris recover for the report', { actor: 'runner', nowMs: Date.now() });
  if (prior !== undefined) await ws.state.transact((tx) => tx.put('escalations', key, { ...prior, state: 'exhausted' }));
  return { ...result, finalState: 'blocked', reasonCode: 'ESCALATION_EXHAUSTED' };
}

/** R11: the installed harness and sign-in that reach one model the route may pick; null when none does. */
export type CandidateScope = { readonly harness: string; readonly authMode: 'api-key' | 'subscription' | 'unknown' } | null;

/**
 * R11 (with C): the scope of every model the route may pick (the task's eligible models, else the
 * registry's), from the port that will run it. Null for a model no installed harness reaches (or
 * whose provider is unknown, R5); C derives the signed-in providers and the consent gate from it.
 * The mode is `unknown` where the sign-in is assumed, not seen (`undetected`, finding 8), so it is
 * never counted signed in. Absent when the port cannot say which harness runs a model (a scripted
 * test port).
 */
export async function candidateScopesFor(port: WorkerPort, models: readonly string[]): Promise<{ readonly [modelId: string]: CandidateScope } | null> {
  if (port.harnessFor === undefined) return null;
  const out: { [modelId: string]: CandidateScope } = {};
  for (const model of [...new Set(models)].slice(0, 64)) {
    const harness = port.harnessFor(model);
    if (harness === null) {
      out[model] = null;
      continue;
    }
    const auth = port.authFor === undefined ? null : await port.authFor(model).catch(() => null);
    // Finding 8: an assumed subscription (`undetected`) is not a seen sign-in; core then does not count it signed in.
    out[model] = { harness: MODEL_PORT_OF[harness], authMode: auth !== null && signedInSource(auth.source) ? auth.mode : 'unknown' };
  }
  return out;
}

/**
 * R29, OD-4: the stored consent for each provider (B's point read of the current consent text's
 * version), for the worker port's provider-consent gate. Without a store: undefined, and the port
 * refuses the providers that always ask (Kimi, DeepSeek).
 */
export function providerConsentOf(ws: Pick<WorkspaceServices, 'store'>): ProviderConsentReader | undefined {
  const store = ws.store;
  if (store === undefined) return undefined;
  return (provider: string) => {
    const text = Object.hasOwn(PROVIDER_CONSENT_TEXT, provider) ? PROVIDER_CONSENT_TEXT[provider]?.version : undefined;
    if (text === undefined) return { granted: false, provider, reasonCode: 'PROVIDER_CONSENT_MISSING' };
    try {
      const read = readProviderConsent(store, { provider, currentTextVersion: text });
      return 'granted' in read ? read : { granted: false, provider, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' };
    } catch {
      return { granted: false, provider, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' };
    }
  };
}

/** A task naming no models: the models it may route among, its baseline, and why each other registry model is out (f17a3bc). */
export interface DefaultCandidates {
  readonly models: readonly string[];
  readonly baseline: string;
  readonly excluded: { readonly [modelId: string]: string };
}

/** OD-10: a vendor the user did not name explores on an API key; Antigravity's own sign-in among Gemini models is the exception (6460ca9). */
export const EXPLORATION_NEEDS_API_KEY = 'EXPLORATION_NEEDS_API_KEY';

/** The native harnesses whose registry default can be a no-model task's baseline, in order. */
const BASELINE_HARNESSES = ['claude', 'codex', 'antigravity'] as const;

/**
 * Owner decision f17a3bc: a plan task that names no models routes among every registry model
 * an installed harness reaches (R11's non-null candidate scopes) whose provider the consent gate
 * allows (OD-4). The baseline is the registry's default for the first installed native harness
 * (OD-3), else the registry's baseline. Its provider counts as the one the user chose; any other
 * vendor stays only on an API-key sign-in (OD-10), except Google models on Antigravity's own
 * sign-in. A model paused by an access limit here (`paused`, R74) is out with ACCESS_LIMITED. Null
 * when the port cannot say which harness runs a model.
 */
export async function defaultCandidates(port: WorkerPort, registry: ModelRegistry, consent?: ProviderConsentReader, offer: ModelOffer | null = null, paused: ReadonlySet<string> = new Set()): Promise<DefaultCandidates | null> {
  const ids = [...new Set(registry.entries.map((e) => e.modelId))];
  const scopes = await candidateScopesFor(port, ids);
  if (scopes === null) return null;
  const providerOf = new Map(registry.entries.map((e) => [e.modelId, e.provider] as const));
  const excluded: { [modelId: string]: string } = {};
  for (const id of ids) if (scopes[id] === null || scopes[id] === undefined) excluded[id] = 'NO_HARNESS';
  // R74 (E10): a model an access limit pauses on its scope here is out, and so never the baseline.
  for (const id of ids) if (excluded[id] === undefined && paused.has(id)) excluded[id] = 'ACCESS_LIMITED';
  const reached = ids.filter((id) => excluded[id] === undefined);
  // OD-4, owner decision c065d52: signed in where a sign-in was seen or a harness here ran the
  // provider's model (RAN_HERE); core's rule on the same scopes and model offer.
  const signedIn = signedInProvidersOf(registry, scopes, offer);
  const read: ProviderConsentReader = consent ?? ((provider: string) => ({ granted: false, provider, reasonCode: 'PROVIDER_CONSENT_MISSING' }));
  const gate = providerConsentGate(registry, signedIn, read);
  const blocked = new Map(gate.blocked.map((b) => [b.provider, b.reasonCode] as const));
  const allowed = reached.filter((id) => {
    const provider = providerOf.get(id);
    if (provider !== undefined && gate.consentedProviders.includes(provider)) return true;
    excluded[id] = (provider === undefined ? undefined : blocked.get(provider)) ?? 'PROVIDER_CONSENT_REQUIRED';
    return false;
  });
  const native = BASELINE_HARNESSES.map((h) => routeBaseline(registry, h)).find((b, i) => allowed.includes(b) && scopes[b]?.harness === BASELINE_HARNESSES[i]);
  const baseline = native ?? (allowed.includes(registry.baselineModelId) ? registry.baselineModelId : allowed[0]);
  if (baseline === undefined) return { models: [], baseline: registry.baselineModelId, excluded };
  const chosen = providerOf.get(baseline);
  const models = allowed.filter((id) => {
    const scope = scopes[id];
    if (providerOf.get(id) === chosen || scope?.authMode === 'api-key') return true;
    if (providerOf.get(id) === 'google' && scope?.harness === 'antigravity') return true;
    excluded[id] = EXPLORATION_NEEDS_API_KEY;
    return false;
  });
  return { models, baseline, excluded };
}

/**
 * Serving hosts R52 (design 4.3, step 1): the pinned host the task's linked session on the model's
 * harness goes through, and whether that harness has route.host certified. Null for no linked
 * session, a direct session, a session spelling Jevris cannot read, or a harness that reaches no
 * host (only OpenCode and Kilo do): the run is then the maker's own route, as before. 'unknown'
 * when the link or the port could not be read: the caller launches nothing (B's LOW 44).
 */
async function sessionServingHost(ctx: SidecarOpContext, ws: WorkspaceServices, port: WorkerPort, taskId: string, model: string): Promise<SessionServingHost | 'unknown' | null> {
  try {
    const harness = port.harnessFor?.(model) ?? null;
    const id = harness === null ? null : hostHarnessId(harness);
    if (harness === null || id === null) return null;
    const link = linkedSessionRead(ws.store, taskId, harness);
    if (!link.ok) return 'unknown';
    if (link.model === null) return null;
    const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const session = sessionHost(registry, id, link.model);
    if (session === null || session.via !== 'host') return null;
    const certified = await hostRouteCertified({ home: ctx.home, harness: id, nowMs: engineNow(ctx.engine) }).catch(() => false);
    return { servingHost: session.servingHost, certified };
  } catch {
    return 'unknown';
  }
}

interface SessionServingHost {
  readonly servingHost: string;
  readonly certified: boolean;
}

/**
 * One leased run through C's router; the approved model runs when the router does not launch.
 * R52: with a session host, the router prices every candidate at that host and launches only with
 * route.host certified and the pair's consent (C's gate), and every launch goes through the host.
 * A pick the host cannot serve, or a route that does not launch, launches nothing: the task
 * blocks with the reason, and nothing runs direct at the maker.
 */
async function routedRun(
  ctx: SidecarOpContext,
  ws: WorkspaceServices,
  task: NonNullable<ReturnType<typeof getTask>>,
  route: RouteManagedWorker,
  baseline: string,
  runWith: (model: string, maxBudgetUsd?: number, effort?: string, servingHost?: string) => Promise<RunLeasedTaskResult>,
  port: WorkerPort,
  certified: (model: string) => Promise<boolean>,
  defaults: DefaultCandidates | null = null,
  hostRead: SessionServingHost | 'unknown' | null = null,
  lease: { readonly grant: Parameters<typeof refuseLeasedTask>[1]; readonly authority: LeaseAuthority } | null = null,
): Promise<RunLeasedTaskResult> {
  // R52 (B's LOW 44): a linked session that could not be read may go through a host: nothing runs.
  if (hostRead === 'unknown' && lease !== null) {
    ctx.trace({ event: 'orchestrator.worker-route', taskId: task.node.id, reasonCode: 'HOST_READ_FAILED' });
    return refuseLeasedTask(ws, lease.grant, { authority: lease.authority, reasonCode: 'HOST_ROUTE_NOT_LAUNCHED', reason: 'HOST_ROUTE_NOT_LAUNCHED: the task\'s linked session could not be read (HOST_READ_FAILED), so its host is unknown; nothing ran direct at the maker' });
  }
  const host = hostRead === 'unknown' ? null : hostRead;
  // The models the route may pick: the task's own list, else the default set (f17a3bc). Every model
  // the launch below would refuse is named out first, so the router never picks, and never
  // reserves budget for, a model that cannot launch (C's MEDIUM, B's LOW 43): with a session host,
  // one the port cannot run there (R52); and one on a harness not certified for worker.route.
  const allowed = task.models.length > 0 ? task.models : (defaults?.models ?? []);
  const offHost = host === null ? [] : allowed.filter((m) => (port.harnessFor?.(m, host.servingHost) ?? null) === null);
  const uncertified: string[] = [];
  for (const m of allowed) if (m !== baseline && !offHost.includes(m) && !(await certified(m).catch(() => false))) uncertified.push(m);
  const eligible = allowed.filter((m) => !offHost.includes(m) && !uncertified.includes(m));
  // The host cannot run the baseline, or none of the models (an empty list would leave the router
  // unbounded): route nothing, reserve nothing (C's MEDIUM).
  const baselineOffHost = host !== null && (port.harnessFor?.(baseline, host.servingHost) ?? null) === null;
  if (host !== null && (baselineOffHost || (allowed.length > 0 && eligible.length === 0)) && lease !== null) {
    ctx.trace({ event: 'orchestrator.worker-route', taskId: task.node.id, reasonCode: 'NOT_ON_SESSION_HOST' });
    return refuseLeasedTask(ws, lease.grant, { authority: lease.authority, reasonCode: 'HOST_ROUTE_NOT_LAUNCHED', reason: `HOST_ROUTE_NOT_LAUNCHED: the linked session runs through ${host.servingHost}, which cannot run the task's approved model or its models here (NOT_ON_SESSION_HOST); nothing ran direct at the maker` });
  }
  let ran: RunLeasedTaskResult | undefined;
  // OD-3: the baseline this route reconciles to when the router's note names none.
  let routeBase = baseline;
  let reasonCode = 'ROUTED';
  let learning: unknown;
  try {
    const settings = readWorkerAuthSettings(ws.configDir);
    const routeRegistry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const provider = workerProvider(baseline, routeRegistry);
    const scopes = await candidateScopesFor(port, eligible.length > 0 ? eligible : routeRegistry.entries.map((e) => e.modelId));
    // R11: each candidate's harness and sign-in. f17a3bc: why each registry model left the default set.
    const exclusions = {
      ...(defaults === null || task.models.length > 0 ? {} : defaults.excluded),
      ...Object.fromEntries(offHost.map((m) => [m, 'NOT_ON_SESSION_HOST'])),
      ...Object.fromEntries(uncertified.map((m) => [m, 'ACTUATOR_UNCERTIFIED'])),
    };
    const scoped = {
      ...(scopes === null ? {} : { candidateScopes: scopes }),
      ...(Object.keys(exclusions).length === 0 ? {} : { candidateExclusions: exclusions }),
    };
    // R52: with a session host, the harness and sign-in are the ones that reach the baseline there.
    const harness = port.harnessFor?.(baseline, host?.servingHost) ?? (provider === null ? undefined : ((settings.ok ? settings.harness?.[provider] : undefined) ?? PROVIDER_HARNESSES[provider][0])) ?? 'claude';
    routeBase = routeBaseline(routeRegistry, MODEL_PORT_OF[harness], task.models[0] ?? null);
    // The dispatching port answers the mode the run will use (on OpenCode and Kilo, from what the
    // harness holds for the provider); another port falls back to the declared or environment mode.
    const authMode = port.authFor !== undefined ? ((await port.authFor(baseline, host?.servingHost))?.mode ?? undefined) : settings.ok && provider !== null ? harnessAuthMode(harness, provider, settings.auth[harness], process.env) : undefined;
    const result = await route({
      taskId: task.node.id,
      workspaceId: ws.workspaceId,
      sliceId: task.sliceId,
      ...(eligible.length === 0 ? {} : { eligibleModels: eligible }),
      // OD-3: the plan's approved model is the route's baseline; a task naming none uses the harness default.
      approvedModelId: task.models[0] ?? null,
      mode: 'bounded-auto',
      risk: task.risk,
      ...volumeOf(ws, task.sliceId),
      killSwitchStopped: () => ctx.killSwitchStopped,
      ...(authMode === undefined ? {} : { authMode }),
      harness: MODEL_PORT_OF[harness],
      ...scoped,
      ...(host === null ? {} : { servingHost: host.servingHost, hostRouteCertified: host.certified }),
      async launch(input) {
        // The router never widens the task's approved models (or the default set, where unnamed
        // vendors are only on API keys, OD-10), and never routes onto a harness that is not
        // certified for worker.route. Both were named out above; these stay as the last guard.
        if (!eligible.includes(input.model)) throw new Error('MODEL_NOT_ELIGIBLE');
        if (input.model !== baseline && !(await certified(input.model))) throw new Error('ACTUATOR_UNCERTIFIED');
        const effort = typeof input.effort === 'string' && input.effort !== '' ? input.effort : undefined;
        // R52: the pick runs through the session's host, spelled there by the port, or not at all.
        if (host !== null && (port.harnessFor?.(input.model, host.servingHost) ?? null) === null) throw new Error('NOT_ON_SESSION_HOST');
        ran = await runWith(input.model, input.maxBudgetUsd, effort, host?.servingHost);
        const r = ran.run;
        // The pre-spawn release: a refusal before any child started tells core so, and core releases
        // the reservation (LAUNCH_NOT_STARTED) instead of holding it as unknown usage.
        return { status: r?.status ?? 'failed', requestedModel: input.model, actualModel: r?.actualModel ?? null, usage: r?.usage ?? null, costUsd: r?.costUsd ?? null, ...(r?.spawned === false ? { spawned: false as const } : {}) };
      },
    });
    if (!result.launched) reasonCode = (result.reasonCode ?? 'NOT_LAUNCHED').slice(0, 64);
    learning = result.learning;
  } catch {
    reasonCode = 'ROUTER_ERROR';
  }
  ctx.trace({ event: 'orchestrator.worker-route', taskId: task.node.id, reasonCode: ran === undefined ? `BASELINE_${reasonCode}`.slice(0, 64) : reasonCode });
  // R74 (E3): the router did not launch, so the approved model runs as the baseline. The launch
  // check in runLeasedTask (E9) launches nothing into a paused scope: the task blocks with the pause.
  if (ran === undefined && host !== null && lease !== null) {
    // R52: a route through the session's host that did not launch never falls back to the maker.
    return refuseLeasedTask(ws, lease.grant, { authority: lease.authority, reasonCode: 'HOST_ROUTE_NOT_LAUNCHED', reason: `HOST_ROUTE_NOT_LAUNCHED: the linked session runs through ${host.servingHost}, and the route there did not launch (${reasonCode}); nothing ran direct at the maker` });
  }
  if (ran === undefined) ran = await runWith(baseline);
  // C16: keep the router's learning note with this route, and label the run's own outcomes.
  const run = ran.run;
  if (learning !== undefined && run !== null) {
    try {
      const nowMs = engineNow(ctx.engine);
      // One baseline for route and outcome (P3, OD-3): the router's own, carried in its note;
      // else C's rule: the approved model when registered, else the harness's registry default.
      const kept = await keepLearningNote(ws, { taskId: task.node.id, leaseId: run.leaseId, sliceId: task.sliceId, baselineModelId: routeBase, eligibleModelIds: eligible, risk: task.risk, note: learning, nowMs });
      const now = getTask(ws, task.node.id);
      // The port switch (R63-R67): an access limit is the neutral usage-limited outcome, whether the
      // port says `usage-limit` or `access-limit`; an overload records none (the bounded retry, OP-7).
      if (kept !== null && runAccessLimited(run)) recordRouteOutcome(ws, task.node.id, 'usage-limited', { run, nowMs });
      else if (kept !== null && run.stale === true) recordRouteOutcome(ws, task.node.id, 'stale', { run, nowMs });
      // A person cancelled the running route (a duplicate cancellation says nothing about the model).
      else if (kept !== null && now?.node.state === 'cancelled' && !/^duplicate of /.test(now.stateReason ?? '')) recordRouteOutcome(ws, task.node.id, 'cancelled', { run, nowMs });
      // No receipt: the route failed before its checks could run (P2).
      else if (kept !== null && runIncomplete(run)) recordRouteOutcome(ws, task.node.id, 'run-incomplete', { run, nowMs });
    } catch {
      // Learning never fails the task path.
    }
  }
  return ran;
}

// ------------------------------------------------------------------------------ plan.submit

export const PLAN_SUBMIT_MAX_TASKS = 256;

const RECONCILE_ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

/** The task.reconcile result (a local payload; no surface contract yet). */
export interface TaskReconcilePayload {
  readonly reconciled: boolean;
  readonly reasonCode: string;
  readonly taskId: string;
  readonly operationId: string | null;
  readonly effectState: string | null;
  readonly taskState: string | null;
  readonly auditSeq: number | null;
  /** Owned effects still held in this workspace. */
  readonly held: number;
}

/** The result of `plan.submit` (no surface contract yet; built from validated values). */
export interface PlanSubmitPayload {
  readonly accepted: boolean;
  readonly reasonCode: string;
  readonly planId: string | null;
  readonly rootBudgetId: string | null;
  readonly taskIds: readonly string[];
  readonly waves: readonly (readonly string[])[];
  readonly leaseIds: readonly string[];
  readonly issues: readonly { readonly taskId: string; readonly code: string; readonly detail: string | null }[];
}

const POLICIES: readonly BudgetPolicy[] = ['finish-running', 'cancel-newest', 'pause-all'];
const MAX_LIMIT_MICRO_USD = 1_000_000_000_000;

/** A task the plan named that cannot be used: which one (by position) and what rule it broke. */
export interface PlanTaskProblem extends TaskInputProblem {
  readonly index: number;
}

/**
 * Reads the untrusted plan.submit body. `problem` is set when the body is well formed except for
 * one task's field, so the answer can name that field and rule instead of INVALID_REQUEST.
 */
export function readPlanSubmission(body: unknown): { readonly submission: PlanSubmission | undefined; readonly problem?: PlanTaskProblem } {
  return readPlanSubmissionInner(body);
}

/** Parses the untrusted plan.submit body, or returns undefined (INVALID_REQUEST). */
export function parsePlanSubmission(body: unknown): PlanSubmission | undefined {
  return readPlanSubmissionInner(body).submission;
}

function readPlanSubmissionInner(body: unknown): { readonly submission: PlanSubmission | undefined; readonly problem?: PlanTaskProblem } {
  const none = { submission: undefined };
  if (!isPlain(body)) return none;
  // authorizationId, actor and channel say who may create a new root budget (the op checks them).
  for (const key of Object.keys(body)) if (!['plan', 'ownerId', 'rootBudget', 'authorizationId', 'actor', 'channel'].includes(key)) return none;
  const plan = own(body, 'plan');
  const ownerId = own(body, 'ownerId');
  const budget = own(body, 'rootBudget');
  if (!isPlain(plan) || !isPlain(budget) || typeof ownerId !== 'string' || !CONTRACT_ID.test(ownerId)) return none;
  for (const key of Object.keys(plan)) if (!['tasks', 'requirementIds', 'availableResources'].includes(key)) return none;
  const rawTasks = own(plan, 'tasks');
  if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > PLAN_SUBMIT_MAX_TASKS) return none;
  const tasks: TaskInput[] = [];
  let problem: PlanTaskProblem | undefined;
  for (const [index, raw] of rawTasks.entries()) {
    const checked = checkTaskInput(raw);
    if (!checked.ok) {
      problem = { ...checked.problem, index };
      break;
    }
    tasks.push(checked.input);
  }
  const ids = (value: unknown): readonly string[] | undefined | null => {
    if (value === undefined) return null;
    return Array.isArray(value) && value.length <= 256 && value.every((v) => typeof v === 'string' && CONTRACT_ID.test(v)) ? (value as string[]) : undefined;
  };
  const requirementIds = ids(own(plan, 'requirementIds'));
  const availableResources = ids(own(plan, 'availableResources'));
  if (requirementIds === undefined || availableResources === undefined) return none;
  for (const key of Object.keys(budget)) if (!['id', 'limitMicroUsd', 'shutdownReserveMicroUsd', 'policy'].includes(key)) return none;
  const id = own(budget, 'id');
  const limit = own(budget, 'limitMicroUsd');
  const reserve = own(budget, 'shutdownReserveMicroUsd');
  const policy = own(budget, 'policy');
  if (typeof id !== 'string' || !TASK_ID.test(id)) return none;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT_MICRO_USD) return none;
  if (reserve !== undefined && (typeof reserve !== 'number' || !Number.isSafeInteger(reserve) || reserve < 0 || reserve >= limit)) return none;
  if (policy !== undefined && !(POLICIES as readonly unknown[]).includes(policy)) return none;
  // Everything else in the body is sound, so the one bad task is what the answer names.
  if (problem !== undefined) return { submission: undefined, problem };
  return {
    submission: {
      tasks,
      ownerId,
      rootBudget: {
        id,
        limitMicroUsd: limit,
        ...(reserve === undefined ? {} : { shutdownReserveMicroUsd: reserve as number }),
        ...(policy === undefined ? {} : { policy: policy as BudgetPolicy }),
      },
      ...(requirementIds === null ? {} : { requirementIds }),
      ...(availableResources === null ? {} : { availableResources }),
    },
  };
}

const SPECIFIC_REFUSALS = new Set(['BUDGET_CONFLICT', 'DUPLICATE_TASK', 'STORE_UNAVAILABLE']);
const PLAN_ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

export function taskOps(respond: Respond, workspaceOf: WorkspaceOf) {
  const needWs = (ctx: SidecarOpContext) => {
    const ws = workspaceOf(ctx);
    return ws;
  };
  return [
    {
      op: 'task.get',
      scope: 'status' as const,
      budget: 'hot' as const,
      handle(ctx: SidecarOpContext): SidecarOpOutcome {
        const taskId = taskIdOf(ctx);
        if (taskId === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        return respond(ctx, 'task.get', taskView(ws, taskId));
      },
    },
    {
      op: 'task.submit',
      scope: 'submit' as const,
      budget: 'background' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const raw = isPlain(ctx.body) ? own(ctx.body, 'task') : undefined;
        const input = parseTaskInput(raw);
        const rootBudgetId = isPlain(raw) ? own(raw, 'rootBudgetId') : undefined;
        const refuse = (reasonCode: string, taskId: string | null = null, detail?: string) =>
          respond(ctx, 'task.submit', { accepted: false, taskId, leaseIds: [], reasonCode, ...(detail === undefined ? {} : { detail: safeText(detail, 500) }) });
        if (input === undefined) {
          // Name the field and the rule, as plan.submit does, so the caller can fix the task (JEV-0040).
          const checked = checkTaskInput(raw);
          return checked.ok ? refuse('INVALID_TASK') : refuse('INVALID_TASK', null, `${checked.problem.field}: ${checked.problem.rule}`);
        }
        if (typeof rootBudgetId !== 'string') return refuse('INVALID_TASK', null, 'rootBudgetId: the id of a root budget that already exists in this workspace');
        if (!CONTRACT_ID.test(input.id)) return refuse('INVALID_TASK', null, 'id: letters, digits, . _ - only, starting with a letter or digit, at most 128 characters');
        const budget = ws.host.get<BudgetRecord>('budgets', rootBudgetId);
        if (budget === undefined || budget.workspaceId !== ws.workspaceId) return refuse('NO_ROOT_BUDGET', input.id);
        const added = await submitTask(ws, input, rootBudgetId, budget.ownerId);
        if (!added.ok) return refuse(added.issues[0]?.code ?? 'INVALID_TASK', input.id, added.issues[0]?.detail);
        const started = await startOwnedWork(ctx, ws, [input.id]);
        return respond(ctx, 'task.submit', { accepted: true, taskId: input.id, leaseIds: started.leaseIds, reasonCode: started.reasonCodes.get(input.id) ?? started.fallback });
      },
    },
    {
      // CLI-only (submit scope; mcp and hook never hold it, owned mode grants mcp task.submit only).
      op: 'plan.submit',
      scope: 'submit' as const,
      budget: 'background' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const read = readPlanSubmission(ctx.body);
        const submission = read.submission;
        if (submission === undefined) {
          // One named task with a bad field is answered with that field and its rule (JEV-0006), not a bare
          // INVALID_REQUEST. A task with no usable id (or that is not an object) has nothing to name, so it stays one.
          if (read.problem !== undefined && read.problem.taskId !== null) {
            const { problem } = read;
            const issue = { taskId: problem.taskId !== null && TASK_ID.test(problem.taskId) ? problem.taskId : `#${String(problem.index)}`, code: 'INVALID_TASK', detail: `${problem.field}: ${problem.rule}`.slice(0, 200) };
            return { ok: true, body: { accepted: false, reasonCode: 'PLAN_INVALID', planId: null, rootBudgetId: null, taskIds: [], waves: [], leaseIds: [], issues: [issue] } satisfies PlanSubmitPayload };
          }
          return { ok: false, reasonCode: 'INVALID_REQUEST' };
        }
        const body = isPlain(ctx.body) ? ctx.body : {};
        const authorizationId = own(body, 'authorizationId');
        const actor = own(body, 'actor');
        const channel = own(body, 'channel');
        if (authorizationId !== undefined && (typeof authorizationId !== 'string' || !CONTRACT_ID.test(authorizationId) || typeof actor !== 'string' || !PLAN_ACTOR.test(actor))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (authorizationId === undefined && actor !== undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (channel !== undefined && channel !== 'terminal') return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        // SR-1 (coordinator decision): a new root budget commits money, so it needs a person: a
        // single-use terminal authorization for budget.increase on that budget id (as budget.update
        // takes it), or a person who answered at an interactive terminal. A plan under a budget that
        // already exists in this workspace needs neither: someone already created it.
        const rootBudgetId = submission.rootBudget?.id;
        const existing = rootBudgetId === undefined ? undefined : ws.host.get<BudgetRecord>('budgets', rootBudgetId);
        if (rootBudgetId !== undefined && (existing === undefined || existing.workspaceId !== ws.workspaceId)) {
          const refused = (reasonCode: string): SidecarOpOutcome => {
            ctx.trace({ event: 'orchestrator.plan-refused', reasonCode });
            return { ok: true, body: { accepted: false, reasonCode, planId: null, rootBudgetId: null, taskIds: [], waves: [], leaseIds: [], issues: [] } satisfies PlanSubmitPayload };
          };
          if (typeof authorizationId === 'string') {
            const store = ws.store;
            const used = store !== undefined && useAuthorization(store, { authorizationId, principal: actor as string, actionClass: 'budget.increase' satisfies AuthorizationAction, scope: rootBudgetId, nowMs: Date.now() }).ok;
            if (!used) return refused('AUTHORIZATION_REFUSED');
          } else if (channel !== 'terminal') {
            return refused('CHANNEL_REFUSED');
          }
        }
        const result = await submitPlan(ws, submission);
        if (!result.ok) {
          const issues = result.issues.slice(0, 64).map((i) => ({ taskId: i.taskId.slice(0, 130), code: i.code, detail: i.detail === undefined ? null : i.detail.slice(0, 200) }));
          const only = issues.length === 1 ? issues[0]?.code : undefined;
          const reasonCode = only !== undefined && SPECIFIC_REFUSALS.has(only) ? only : 'PLAN_INVALID';
          ctx.trace({ event: 'orchestrator.plan-refused', reasonCode });
          return { ok: true, body: { accepted: false, reasonCode, planId: null, rootBudgetId: null, taskIds: [], waves: [], leaseIds: [], issues } satisfies PlanSubmitPayload };
        }
        const started = await startOwnedWork(ctx, ws, result.taskIds);
        ctx.trace({ event: 'orchestrator.plan-submitted', reasonCode: 'SUBMITTED' });
        return {
          ok: true,
          body: {
            accepted: true,
            reasonCode: 'SUBMITTED',
            planId: result.planId ?? null,
            rootBudgetId: result.rootBudgetId ?? null,
            taskIds: [...result.taskIds],
            waves: result.waves.map((w) => [...w]),
            leaseIds: [...started.leaseIds],
            issues: [],
          } satisfies PlanSubmitPayload,
        };
      },
    },
    {
      op: 'task.complete',
      scope: 'submit' as const,
      budget: 'background' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const taskId = taskIdOf(ctx);
        if (taskId === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const run = !(isPlain(ctx.body) && own(ctx.body, 'run') === false);
        const done = await completeTask(ws, taskId, { run, nowMs: engineNow(ctx.engine) });
        ctx.trace({ event: 'orchestrator.task-complete', taskId, reasonCode: done.reasonCode });
        if (done.verified) await continueOwnedWorkWithin(ctx, ws);
        return respond(ctx, 'task.get', taskView(ws, taskId));
      },
    },
    {
      // A person reconciles an owned effect the kill switch held (GOV-03, US40). CLI-only
      // (submit scope) and refused while the kill switch is stopped: reconcile after clear.
      op: 'task.reconcile',
      scope: 'submit' as const,
      budget: 'hot' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const taskId = taskIdOf(ctx);
        const resolution = isPlain(ctx.body) ? own(ctx.body, 'resolution') : undefined;
        const actorRaw = isPlain(ctx.body) ? own(ctx.body, 'actor') : undefined;
        if (taskId === undefined || (resolution !== 'applied' && resolution !== 'abandoned')) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (actorRaw !== undefined && (typeof actorRaw !== 'string' || !RECONCILE_ACTOR.test(actorRaw))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        await sweepLeases(ctx, ws);
        const authority = (deps.authority ?? leaseAuthorityFor)(ws);
        const result = reconcileOwnedEffect(ws, { taskId, resolution, actor: typeof actorRaw === 'string' ? actorRaw : 'local-user', channel: 'cli', killSwitchStopped: ctx.killSwitchStopped, moveTask: false });
        if (result.ok && getTask(ws, taskId)?.node.state === 'blocked') {
          // The effect is settled; the task's lease is too: its uncertain reservation counts in
          // full (the crashed or held run's spend is unknown), and the task is ready again.
          const settled = await authority.reconcile(ws.workspaceId, taskId, { spentMicroUsd: null, resume: true }, Date.now());
          if (!settled.ok) taskTransition(ws, taskId, 'ready', `owned effect reconciled as ${resolution}`, { actor: 'human', nowMs: Date.now() });
        }
        // No held effect, but the task is blocked by an expired lease (a crashed worker): settle
        // its uncertain reservation at the full amount and return it to ready (ORC-03).
        if (!result.ok && result.reasonCode === 'NOT_HELD' && getTask(ws, taskId)?.stateReason === 'LEASE_EXPIRED' && getTask(ws, taskId)?.node.state === 'blocked') {
          const lease = await authority.reconcile(ws.workspaceId, taskId, { spentMicroUsd: null, resume: true }, Date.now());
          ctx.trace({ event: 'orchestrator.task-reconcile', taskId, reasonCode: lease.ok ? 'LEASE_RECONCILED' : (lease.reasonCode ?? 'REFUSED') });
          if (lease.ok) await continueOwnedWorkWithin(ctx, ws);
          const body: TaskReconcilePayload = { reconciled: lease.ok, reasonCode: lease.ok ? 'LEASE_RECONCILED' : (lease.reasonCode ?? 'REFUSED'), taskId, operationId: null, effectState: null, taskState: getTask(ws, taskId)?.node.state ?? null, auditSeq: null, held: heldTaskEffects(ws).length };
          return { ok: true, body };
        }
        ctx.trace({ event: 'orchestrator.task-reconcile', taskId, reasonCode: result.ok ? 'RECONCILED' : result.reasonCode });
        if (result.ok) await continueOwnedWorkWithin(ctx, ws);
        const body: TaskReconcilePayload = result.ok
          ? { reconciled: true, reasonCode: 'RECONCILED', taskId, operationId: result.operationId, effectState: result.state, taskState: getTask(ws, taskId)?.node.state ?? result.taskState, auditSeq: result.auditSeq, held: heldTaskEffects(ws).length }
          : { reconciled: false, reasonCode: result.reasonCode, taskId, operationId: null, effectState: null, taskState: getTask(ws, taskId)?.node.state ?? null, auditSeq: null, held: heldTaskEffects(ws).length };
        return { ok: true, body };
      },
    },
    {
      op: 'task.cancel',
      scope: 'submit' as const,
      // GOV-02..04: a stopped Jevris changes no task state.
      stoppedByKillSwitch: true as const,
      // Background: the answer waits for an in-process run to publish its cancellation.
      budget: 'background' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const taskId = taskIdOf(ctx);
        if (taskId === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        // C28 (ORC-08): the user cancels a duplicate after approving the advice, naming the survivor.
        const survivorRaw = isPlain(ctx.body) ? own(ctx.body, 'duplicateOf') : undefined;
        if (survivorRaw !== undefined && (typeof survivorRaw !== 'string' || !CONTRACT_ID.test(survivorRaw) || survivorRaw === taskId)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const authority = (deps.authority ?? leaseAuthorityFor)(ws);
        // A second cancel of a task whose first one is still pending is the same cancellation: it is not labelled again.
        const alreadyPending = cancelPending(ws, taskId);
        // Wait for an in-process run to publish its end within this op's deadline (less a margin for the answer).
        const result = await cancelTask(ws, authority, taskId, typeof survivorRaw === 'string' ? `duplicate of ${survivorRaw}` : undefined, Date.now(), Math.max(0, ctx.deadline.remainingMs() - 100));
        // C16: a person's cancellation labels the task's route. A duplicate cancellation says nothing
        // about the model's work, so it is not a route outcome.
        if (result.cancelled && !alreadyPending && survivorRaw === undefined) recordRouteOutcome(ws, taskId, 'cancelled', { run: workerRuns(ws, taskId).at(-1) ?? null, nowMs: engineNow(ctx.engine) });
        if (result.cancelled && typeof survivorRaw === 'string') {
          await ws.state.transact((tx) => tx.put('duplicate-cancellations', recordKey(ws.workspaceId, taskId), { workspaceId: ws.workspaceId, taskId, survivor: survivorRaw, atMs: Date.now() }));
        }
        ctx.trace({ event: 'orchestrator.task-cancel', taskId, reasonCode: result.reasonCode });
        // The cancelled task's slot is free: the next queued task starts (JEV-0008).
        if (result.cancelled) await continueOwnedWorkWithin(ctx, ws);
        return respond(ctx, 'task.get', taskView(ws, taskId));
      },
    },
    {
      // A user reverts a duplicate cancellation (C28 feedback, ORC-08): recorded as a false
      // cancellation only for a task cancelled as a duplicate. CLI-only; the user re-plans the work.
      op: 'task.revert-duplicate',
      scope: 'submit' as const,
      stoppedByKillSwitch: true as const,
      budget: 'hot' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const taskId = taskIdOf(ctx);
        const actorRaw = isPlain(ctx.body) ? own(ctx.body, 'actor') : undefined;
        if (taskId === undefined || (actorRaw !== undefined && (typeof actorRaw !== 'string' || !RECONCILE_ACTOR.test(actorRaw)))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (ctx.client !== 'cli') return { ok: false, reasonCode: 'CLI_ONLY' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const cancelledAsDuplicate = ws.state.get('duplicate-cancellations', recordKey(ws.workspaceId, taskId)) !== undefined;
        const result = cancelledAsDuplicate ? await recordDuplicateRevert(ws, { taskId, actor: typeof actorRaw === 'string' ? actorRaw : 'local-user' }) : { ok: false, reasonCode: 'NOT_A_DUPLICATE_CANCELLATION' };
        ctx.trace({ event: 'orchestrator.duplicate-revert', taskId, reasonCode: result.reasonCode });
        return { ok: true, body: { recorded: result.ok, reasonCode: result.reasonCode, taskId } };
      },
    },
  ];
}
