/**
 * Route learning in use (C16, owner decision "baseline, then learn in use", DOMAINS cb29708).
 *
 * When C's router routes an owned run and the workspace has a route-learning state, its answer
 * carries a learning note. D keeps that note with the route (collection `route-learning`, one
 * row per task, local only) and gives C's `learnFromOutcome` the route's deterministic outcomes:
 *
 * - `verified-pass` / `verified-fail`: completion from a mandatory check's store receipt (its id);
 * - `run-incomplete`: the run ended with no receipt (failed, timeout, max-turns, budget-exceeded,
 *   refused, or a write outside its paths), a failure;
 * - `retried`: the one bounded escalation relaunches the task with a stronger model (W02); the
 *   escalated run is then its own route (`gen-<its lease>`, not randomized);
 * - `reverted`: a verified pass did not hold: the task was reopened (its receipt invalidated) and
 *   its mandatory checks then failed;
 * - `stale`: the run's result arrived after a newer lease owned the task (W04);
 * - `cancelled`: a person cancelled the task;
 * - `usage-limited`: the harness hit its subscription or session limit.
 *
 * A route's first label carries the run's cost, tokens and latency; a later `reverted` or
 * `retried` overturns it (C applies the 30-day window) and carries none, so a run is counted once
 * (P2). A route keeps at most one verified label.
 *
 * Every event carries the task's rules-only risk class (risk.ts, P1): C explores and follows a
 * learned slice only on a low-risk route. The route and its outcomes share one baseline, the one
 * the router reconciled against (its note, else the registry's), and the rules-only choice
 * (`rulesModelId`) from the note (P3; owner decision 7922ee3).
 *
 * Only ids, the outcome kind, slice, models, effort, auth mode, cost (billed and API-equivalent),
 * latency and token counts go into the event; no task or workspace text. The record is written by C under the Jevris data
 * directory and never leaves the machine. Recording runs in the background and a failure is
 * dropped: learning never fails or delays the task path.
 */
import { recordFirstTryOutcome } from './first-try.js';
import { BUNDLED_MODEL_REGISTRY, LABEL_SOURCE_OF, apiEquivalentCostMicroUsd, learnFromOutcome, loadModelRegistry, routeBaseline, subagentSliceId, type LearnFromOutcomeResult, type OutcomeKind, type RouteRisk } from '@jevris/core';
import { ACCESS_PAUSE_CLASSES, type ModelRegistry } from '@jevris/contracts';
import { recordDecisionOutcomes } from '@jevris/store';
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';
import { getTask } from './tasks.js';
import type { WorkerRunRecord } from './workers.js';
import { accessHarnessOf } from './access-limits.js';
import { cleanRunSpelling, resolveRunSpelling } from './model-spelling.js';

const COLLECTION = 'route-learning';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/;

/** The router's learning note, as D keeps it with the route. */
export interface RouteLearningRow {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly routeId: string;
  readonly sliceId: string;
  readonly policyVersion: number;
  readonly explored: boolean;
  readonly propensity: number | null;
  readonly authMode: 'api-key' | 'subscription' | 'unknown';
  /** The effort arm the router launched (null: the model's default). */
  readonly effort: string | null;
  /** The baseline the router reconciled the slice against (its note; else the registry's), so route and outcome share one baseline (P3). */
  readonly baselineModelId: string;
  readonly eligibleModelIds: readonly string[];
  /** The task's rules-only risk class, sent with every outcome (P1). Absent on rows kept before it existed. */
  readonly risk?: RouteRisk;
  /** What the rules-only policy chose for this route (arm C); null when the router did not say. */
  readonly rulesModelId?: string | null;
  readonly atMs: number;
  /** The latest recorded outcome (null: none yet). */
  readonly outcome: OutcomeKind | null;
  /** Every label sent for this route, in order (P2). Absent on rows kept before it existed: then `outcome` alone. */
  readonly labels?: readonly OutcomeKind[];
  readonly proposalId: string | null;
  /** C's answer to the outcome (reason codes only), once it is recorded. */
  readonly learned?: { readonly recorded: boolean; readonly reasonCode: string | null; readonly regression: string | null; readonly promotion: string | null };
}

export interface LearningNoteInput {
  readonly policyVersion?: unknown;
  readonly exploration?: unknown;
  readonly authMode?: unknown;
  readonly effort?: unknown;
  readonly baselineModelId?: unknown;
  readonly eligibleModelIds?: unknown;
  readonly rulesModelId?: unknown;
}

function num01(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Keeps the router's learning note for the route that just ran (ids and numbers only). */
export async function keepLearningNote(
  ws: WorkspaceServices,
  input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly sliceId: string | null;
    /** The router's baseline when its note does not carry one (the registry's baseline, P3). */
    readonly baselineModelId: string;
    readonly eligibleModelIds: readonly string[];
    readonly risk: RouteRisk;
    readonly note: unknown;
    readonly nowMs: number;
  },
): Promise<RouteLearningRow | null> {
  const note = input.note;
  if (note === null || typeof note !== 'object' || input.sliceId === null || !ID.test(input.sliceId)) return null;
  const n = note as LearningNoteInput;
  if (typeof n.policyVersion !== 'number' || !Number.isSafeInteger(n.policyVersion) || n.policyVersion < 0) return null;
  const exploration = n.exploration !== null && typeof n.exploration === 'object' ? (n.exploration as { readonly explored?: unknown; readonly propensity?: unknown }) : null;
  const routeId = `gen-${input.leaseId}`.slice(0, 128);
  // The router's own baseline and eligible list win, so the outcome reconciles what the route did.
  const baselineModelId = typeof n.baselineModelId === 'string' && ID.test(n.baselineModelId) ? n.baselineModelId : input.baselineModelId;
  const noted = Array.isArray(n.eligibleModelIds) ? n.eligibleModelIds.filter((m): m is string => typeof m === 'string' && ID.test(m)) : [];
  const eligibleModelIds = noted.length > 0 ? noted : input.eligibleModelIds.filter((m) => ID.test(m));
  const rulesModelId = typeof n.rulesModelId === 'string' && ID.test(n.rulesModelId) ? n.rulesModelId : null;
  if (!ID.test(routeId) || !ID.test(input.taskId) || !ID.test(baselineModelId)) return null;
  const row: RouteLearningRow = {
    workspaceId: ws.workspaceId,
    taskId: input.taskId,
    routeId,
    sliceId: input.sliceId,
    policyVersion: n.policyVersion,
    explored: exploration?.explored === true,
    propensity: num01(exploration?.propensity),
    authMode: n.authMode === 'api-key' || n.authMode === 'subscription' ? n.authMode : 'unknown',
    effort: typeof n.effort === 'string' && EFFORT.test(n.effort) ? n.effort : null,
    baselineModelId,
    eligibleModelIds: eligibleModelIds.slice(0, 64),
    risk: input.risk,
    rulesModelId,
    atMs: input.nowMs,
    outcome: null,
    proposalId: null,
  };
  await ws.state.transact((tx) => tx.put(COLLECTION, recordKey(ws.workspaceId, input.taskId), row));
  return row;
}

export function learningRow(ws: WorkspaceServices, taskId: string): RouteLearningRow | undefined {
  const row = ws.state.get<RouteLearningRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
  return row !== undefined && row.workspaceId === ws.workspaceId ? row : undefined;
}

/** Routes whose outcome produced a promotion proposal, for status (E renders the accept command). */
export function pendingLearningProposals(ws: WorkspaceServices): readonly { readonly taskId: string; readonly sliceId: string; readonly proposalId: string }[] {
  return ws.state
    .list<RouteLearningRow>(COLLECTION)
    .filter((r) => r.workspaceId === ws.workspaceId && r.proposalId !== null)
    .map((r) => ({ taskId: r.taskId, sliceId: r.sliceId, proposalId: r.proposalId as string }));
}

/**
 * Run statuses that end a route with no receipt and count as its failure (P2): not a usage limit,
 * an access limit or an overload (R75), an abort, a gone model or an unsupported harness.
 */
const INCOMPLETE_STATUSES: ReadonlySet<string> = new Set(['failed', 'timeout', 'max-turns', 'budget-exceeded', 'refused']);

/**
 * The host that served a run (R42's spelling, R49): from the spelling the harness reported, or
 * for a clean run with no report, from the requested spelling. Null when the run names no harness
 * or its spelling does not resolve; the outcome then carries no host and prices at the maker's.
 */
export function runServingHost(registry: ModelRegistry, run: Pick<WorkerRunRecord, 'harness' | 'actualModel' | 'requestedModel' | 'status' | 'modelUnavailable'>): string | null {
  if (run.harness === undefined) return null;
  const port = accessHarnessOf(run.harness);
  if (run.actualModel !== null) return resolveRunSpelling(registry, port, run.actualModel)?.servingHost ?? null;
  const clean = run.status === 'completed' && run.modelUnavailable === undefined;
  return clean ? (cleanRunSpelling(registry, port, run.requestedModel)?.servingHost ?? null) : null;
}

/**
 * Whether a finished run ends its route with no receipt (`run-incomplete`): a failure status, or a
 * completed run that wrote outside its paths. A run the runner found at an access limit is never
 * one, whatever status its port reported (R75, design A12): a limit is the account's, not the model's.
 */
export function runIncomplete(run: WorkerRunRecord | null): boolean {
  if (run === null || run.stale === true || run.accessLimit !== undefined) return false;
  return INCOMPLETE_STATUSES.has(run.status) || (run.status === 'completed' && run.pathViolations.length > 0);
}

const PAUSE_CLASSES: ReadonlySet<string> = new Set(ACCESS_PAUSE_CLASSES);

/**
 * Whether a finished run records the neutral `usage-limited` route outcome (design 8, the port
 * switch R63-R67): a port's interim `usage-limit`, or a run whose signal the runner classified as
 * a pausing class (`access-limit`, or any status the port reported for it). An `overloaded` run is
 * not one: it records no route outcome and goes only to the bounded overload retry (design 7.4, OP-7).
 */
export function runAccessLimited(run: WorkerRunRecord | null): boolean {
  if (run === null) return false;
  if (run.status === 'usage-limit') return true;
  return run.accessLimit !== undefined && PAUSE_CLASSES.has(run.accessLimit.class);
}

/** The reset a `usage-limited` outcome carries for the record (never read for a pause): the port's, else the classified one. */
function limitResetOf(run: WorkerRunRecord | null): string | null {
  if (run === null) return null;
  if (run.resetAt !== undefined) return run.resetAt;
  const at = run.accessLimit?.resetAtMs;
  // B's nit: only a time Date can hold, so the outcome recorder never throws on it.
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15 ? new Date(at).toISOString() : null;
}

const VERIFIED: ReadonlySet<OutcomeKind> = new Set(['verified-pass', 'verified-fail']);

/** The labels a route already has. */
export function routeLabels(row: RouteLearningRow): readonly OutcomeKind[] {
  return row.labels ?? (row.outcome === null ? [] : [row.outcome]);
}

/**
 * Whether a route takes this label (P2). The first label always; after it, a `reverted` of a
 * pass, a `retried` of an ended route, or the one verified label after a run-incomplete. A kind
 * is sent once per route.
 */
export function routeTakesLabel(row: RouteLearningRow, kind: OutcomeKind): boolean {
  const labels = routeLabels(row);
  if (labels.length === 0) return true;
  if (labels.includes(kind) || labels.length >= 4) return false;
  if (kind === 'reverted') return labels.includes('verified-pass');
  if (kind === 'retried') return labels.some((l) => l === 'run-incomplete' || VERIFIED.has(l));
  if (VERIFIED.has(kind)) return labels.every((l) => l === 'run-incomplete');
  return false;
}

/**
 * The escalated run's own route (P2): the task's stronger worker, chosen by the bounded
 * escalation and not by the router, so it is not randomized (explored false, propensity null).
 * It keeps the slice, policy, baseline, eligible models, risk and rules choice of the route it
 * follows. Nothing is kept when the task had no route.
 */
export async function keepEscalatedRoute(ws: WorkspaceServices, input: { readonly taskId: string; readonly leaseId: string; readonly run: WorkerRunRecord | null; readonly nowMs: number }): Promise<RouteLearningRow | null> {
  const prior = learningRow(ws, input.taskId);
  const routeId = `gen-${input.leaseId}`.slice(0, 128);
  if (prior === undefined || prior.routeId === routeId || !ID.test(routeId)) return null;
  const mode = input.run?.authMode;
  const ranEffort = input.run?.effort;
  const { learned: _learned, ...base } = prior;
  const row: RouteLearningRow = {
    ...base,
    routeId,
    explored: false,
    propensity: null,
    authMode: mode === 'api-key' || mode === 'subscription' ? mode : 'unknown',
    effort: typeof ranEffort === 'string' && EFFORT.test(ranEffort) ? ranEffort : null,
    atMs: input.nowMs,
    outcome: null,
    labels: [],
    proposalId: null,
  };
  await ws.state.transact((tx) => tx.put(COLLECTION, recordKey(ws.workspaceId, input.taskId), row));
  return row;
}

/** The run a route launched (its lease is the route id's suffix), for a later label sent without one. */
function routeRun(ws: WorkspaceServices, row: RouteLearningRow): WorkerRunRecord | null {
  const leaseId = row.routeId.slice(4);
  const run = ws.host.get<WorkerRunRecord>('worker-runs', recordKey(ws.workspaceId, leaseId));
  return run !== undefined && run.workspaceId === ws.workspaceId && run.taskId === row.taskId ? run : null;
}

const pending = new Set<Promise<unknown>>();

/** Waits for background learning records (tests and orderly shutdown). */
export async function drainRouteLearning(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export interface OutcomeDetail {
  readonly receiptId?: string | null;
  readonly run?: WorkerRunRecord | null;
  /** When the outcome is recorded: the engine's clock (`engineNow`), never read here. */
  readonly nowMs: number;
}

/** The learner (test seam); C's learnFromOutcome by default. */
let learner: typeof learnFromOutcome = learnFromOutcome;
export function setRouteLearner(fn: typeof learnFromOutcome | null): void {
  learner = fn ?? learnFromOutcome;
}

/**
 * Joins the task's deterministic label to every decision made for it (B's P4 decision
 * outcomes), routed or not. A verified label needs its receipt. B keeps one label per decision
 * and task and lets only an overturning label replace it; a failure changes nothing here.
 */
function labelDecisions(ws: WorkspaceServices, taskId: string, kind: OutcomeKind, detail: OutcomeDetail): void {
  if (ws.store === undefined) return;
  const verified = kind === 'verified-pass' || kind === 'verified-fail';
  const receiptId = detail.receiptId ?? null;
  if (verified && (receiptId === null || !ID.test(receiptId))) return;
  try {
    recordDecisionOutcomes(ws.store, { workspaceId: ws.workspaceId, taskId, label: kind, labelSource: LABEL_SOURCE_OF[kind], receiptId: verified ? receiptId : null, atMs: detail.nowMs });
  } catch {
    // The report's join is advice; the task path never fails on it.
  }
}

/**
 * R20 (C d4351f9): one subagent's label from its parent's verification receipt, recorded in the
 * background under C's subagent learning key (`subagent:<type>` against the harness's baseline,
 * which learnFromOutcome applies). Observational: never explored and no propensity, so it moves
 * the posterior but never counts toward a promotion alone. No cost, latency or tokens: the hooks
 * report none for a subagent. Nothing ever throws or waits.
 */
export function recordSubagentOutcome(
  ws: WorkspaceServices,
  input: {
    readonly harness: string;
    readonly subagentType: string;
    readonly agentId: string;
    readonly taskId: string | null;
    readonly modelId: string;
    readonly kind: 'verified-pass' | 'verified-fail';
    readonly receiptId: string;
    readonly risk: string;
    readonly nowMs: number;
    readonly registry: ModelRegistry;
  },
): void {
  const sliceId = subagentSliceId(input.subagentType);
  if (sliceId === null || !ID.test(input.modelId) || !ID.test(input.receiptId) || !ID.test(input.agentId)) return;
  const baselineModelId = routeBaseline(input.registry, input.harness, null);
  const routeId = `subagent:${input.taskId ?? 'none'}:${input.agentId}`.slice(0, 128);
  const risk = input.risk === 'low' || input.risk === 'medium' || input.risk === 'high' ? input.risk : 'unknown';
  const work = learner({
    home: ws.home,
    workspaceId: ws.workspaceId,
    baselineModelId,
    eligibleModelIds: [...new Set([baselineModelId, input.modelId])],
    now: new Date(input.nowMs).toISOString(),
    registry: input.registry,
    event: {
      eventId: `${routeId}:${input.kind}:${input.receiptId}`.slice(0, 128),
      routeId,
      sliceId,
      modelId: input.modelId,
      rulesModelId: null,
      policyVersion: 0,
      kind: input.kind,
      labelSource: LABEL_SOURCE_OF[input.kind],
      receiptId: input.receiptId,
      explored: false,
      propensity: null,
      risk,
      costMicroUsd: null,
      latencyMs: null,
      at: new Date(input.nowMs).toISOString(),
      authMode: 'unknown',
      tokens: null,
    },
  }).catch(() => null);
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/**
 * Records the route's deterministic outcome in the background. Nothing happens when the task's
 * route carried no learning note or already has its label; nothing ever throws or waits.
 */
export function recordRouteOutcome(ws: WorkspaceServices, taskId: string, kind: OutcomeKind, detail: OutcomeDetail): void {
  labelDecisions(ws, taskId, kind, detail);
  // Sonnet-first: the same deterministic label follows the task's first-try ledger row (a verified label needs its receipt).
  if ((kind !== 'verified-pass' && kind !== 'verified-fail') || (detail.receiptId !== undefined && detail.receiptId !== null && ID.test(detail.receiptId))) {
    const ledger = recordFirstTryOutcome(ws, taskId, kind, { run: detail.run ?? null, nowMs: detail.nowMs }).catch(() => null);
    pending.add(ledger);
    void ledger.finally(() => pending.delete(ledger));
  }
  const work = (async (): Promise<LearnFromOutcomeResult | null> => {
    const row = learningRow(ws, taskId);
    if (row === undefined || !routeTakesLabel(row, kind)) return null;
    const receiptId = detail.receiptId ?? null;
    if ((kind === 'verified-pass' || kind === 'verified-fail') && (receiptId === null || !ID.test(receiptId))) return null;
    const run = detail.run === undefined ? routeRun(ws, row) : detail.run;
    // A run labels only its own route (the task may have routed an earlier lease).
    if (run !== null && run.leaseId !== row.routeId.slice(4)) return null;
    // A later label overturns the first; the run's cost, tokens and latency went with the first (P2).
    const followUp = routeLabels(row).length > 0;
    const task = getTask(ws, taskId);
    const modelId = run?.actualModel ?? run?.requestedModel ?? task?.models[0] ?? null;
    if (modelId === null || !ID.test(modelId)) return null;
    const nowMs = detail.nowMs;
    const usage = followUp ? null : (run?.usage ?? null);
    const tokens = usage === null ? null : usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    // Claim the label first, so the same label is never sent twice for a route.
    const claimed = await ws.state.transact((tx) => {
      const current = tx.get<RouteLearningRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
      if (current === undefined || current.routeId !== row.routeId || routeLabels(current).length !== routeLabels(row).length || !routeTakesLabel(current, kind)) return false;
      tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), { ...current, outcome: kind, labels: [...routeLabels(current), kind] } satisfies RouteLearningRow);
      return true;
    });
    if (!claimed) return null;
    const authMode = run?.authMode ?? row.authMode;
    // The effort the port actually passed (the run record), never the requested one: F maps some
    // levels down (Codex max runs as xhigh, agy xhigh as high) and Haiku takes none. Absent or
    // null is the model's default arm (C, f501ceb).
    const ranEffort = run?.effort;
    const effort = typeof ranEffort === 'string' && EFFORT.test(ranEffort) ? ranEffort : null;
    const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const servingHost = run === null ? null : runServingHost(registry, run);
    // The route's usage at the registry's list tariff (C's machine-wide learning design): a
    // subscription route has no billed dollars, so its economics use this API-equivalent figure,
    // at the serving host's tariff for a run through a gateway or host (R49). Null without usage
    // or for a model the registry does not price.
    const apiEquivalentMicroUsd =
      usage === null
        ? null
        : apiEquivalentCostMicroUsd(registry, modelId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadInputTokens, cacheWriteTokens: usage.cacheCreationInputTokens }, servingHost);
    const result = await learner({
      home: ws.home,
      workspaceId: ws.workspaceId,
      baselineModelId: row.baselineModelId,
      eligibleModelIds: row.eligibleModelIds.length > 0 ? row.eligibleModelIds : [row.baselineModelId],
      now: new Date(nowMs).toISOString(),
      registry,
      event: {
        eventId: `${row.routeId}:${kind}:${receiptId ?? run?.leaseId ?? row.routeId.slice(4)}`.slice(0, 128),
        routeId: row.routeId,
        sliceId: row.sliceId,
        modelId,
        rulesModelId: row.rulesModelId ?? null,
        policyVersion: row.policyVersion,
        kind,
        labelSource: LABEL_SOURCE_OF[kind],
        receiptId: kind === 'verified-pass' || kind === 'verified-fail' ? receiptId : null,
        explored: row.explored,
        propensity: row.propensity,
        risk: row.risk ?? 'unknown',
        costMicroUsd: followUp || run?.costUsd === null || run?.costUsd === undefined ? null : Math.max(0, Math.round(run.costUsd * 1_000_000)),
        latencyMs: followUp || run === null ? null : Math.max(0, Math.round(run.durationMs)),
        at: new Date(nowMs).toISOString(),
        authMode: authMode === 'api-key' || authMode === 'subscription' ? authMode : 'unknown',
        tokens,
        apiEquivalentMicroUsd,
        ...(effort === null ? {} : { effort }),
        ...(kind === 'usage-limited' ? { limitResetAt: limitResetOf(run) } : {}),
        ...(servingHost === null ? {} : { servingHost }),
      },
    });
    // C's answer is kept with the route for status and explain: recorded or refused (for example
    // EVENT_EXPIRED past the 30-day window, DUPLICATE_EVENT), a demotion (POSTERIOR_REGRESSION,
    // WINDOW_REGRESSION, BASELINE_CHANGED …) or a promotion. A refusal is final: nothing retries.
    const learned = {
      recorded: result.recorded,
      reasonCode: typeof result.reasonCode === 'string' ? result.reasonCode.slice(0, 64) : null,
      regression: typeof result.regression === 'string' ? result.regression : null,
      promotion: typeof result.promotion === 'string' ? result.promotion : null,
    };
    await ws.state.transact((tx) => {
      const current = tx.get<RouteLearningRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
      if (current !== undefined && current.routeId === row.routeId) {
        tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), { ...current, learned, ...(result.proposalId === null ? {} : { proposalId: result.proposalId }) } satisfies RouteLearningRow);
      }
    });
    return result;
  })().catch(() => null);
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/**
 * The label a completion gives the task's route: a failing mandatory receipt after the route's
 * verified pass means the pass did not hold (the task was reopened and its checks now fail), so
 * the route is `reverted` (P2); otherwise the completion's own verified label.
 */
export function completionLabel(ws: WorkspaceServices, taskId: string, label: { readonly kind: OutcomeKind; readonly receiptId: string }): { readonly kind: OutcomeKind; readonly receiptId: string | null } {
  const row = learningRow(ws, taskId);
  if (label.kind === 'verified-fail' && row !== undefined && routeLabels(row).includes('verified-pass')) return { kind: 'reverted', receiptId: null };
  return label;
}

/** The verified outcome of a completion: pass from a passing mandatory receipt, fail from a failed one. */
export function completionOutcome(completion: { readonly verified: boolean; readonly checks: readonly { readonly mandatory: boolean; readonly status: string; readonly receiptId: string | null }[] }): { readonly kind: OutcomeKind; readonly receiptId: string } | null {
  const mandatory = completion.checks.filter((c) => c.mandatory && c.receiptId !== null);
  if (completion.verified) {
    const pass = mandatory.find((c) => c.status === 'passed');
    return pass === undefined ? null : { kind: 'verified-pass', receiptId: pass.receiptId as string };
  }
  const failed = mandatory.find((c) => c.status === 'failed');
  return failed === undefined ? null : { kind: 'verified-fail', receiptId: failed.receiptId as string };
}
