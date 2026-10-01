/**
 * The first-try ledger (Sonnet-first routing, owner decision 2026-09-30).
 *
 * C's router assigns a low-risk owned route either the cheaper first-try model or the baseline
 * first (the control) and carries that in its learning note. D keeps one row per task here (local
 * only, ids, models, outcomes, cost and time, never text), follows every deterministic label of
 * each attempt, and answers C's `firstTry.history` with what this workspace measured per slice:
 * first-try success, hand-offs, verified tasks, and the cost and wall time per verified task
 * INCLUDING the hand-off attempt. The per-slice verdict (`firstTryVerdict`, the owner-locked
 * thresholds) is persisted when a task finishes, so a slice returns to baseline-first by itself
 * when the first try does not pay and comes back when it does.
 *
 * Labels are C's own deterministic ones, sent through `recordRouteOutcome`; a model's opinion is
 * never a label. A task finishes `verified` only from a passing check receipt.
 */
import {
  BUNDLED_MODEL_REGISTRY,
  EMPTY_FIRST_TRY_STATS,
  apiEquivalentCostMicroUsd,
  firstTryVerdict,
  learningSettings,
  loadLearningState,
  loadModelRegistry,
  type FirstTryArm,
  type FirstTryHistory,
  type FirstTryNote,
  type FirstTryState,
  type FirstTryStats,
  type OutcomeKind,
} from '@jevris/core';
import type { ModelRegistry } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';
import type { WorkerRunRecord } from './workers.js';

const COLLECTION = 'first-try';
const STATE_COLLECTION = 'first-try-state';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type FirstTryAttemptLabel = 'pass' | 'fail' | 'incomplete' | 'limited';

export interface FirstTryAttempt {
  readonly role: 'first' | 'hand-off';
  readonly modelId: string;
  /** The lease of the run; null for a hand-off attempt until its run starts. */
  readonly leaseId: string | null;
  readonly label: FirstTryAttemptLabel | null;
  /** The attempt's cost, micro-USD: billed on an API key, else the API-equivalent estimate. Null until known. */
  readonly costMicroUsd: number | null;
  readonly estimate: boolean;
  readonly wallMs: number | null;
}

export interface FirstTryRow {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly sliceId: string;
  readonly arm: FirstTryArm;
  /** The probability of this arm under the route's randomized assignment. */
  readonly propensity: number;
  readonly firstTryModelId: string;
  readonly baselineModelId: string;
  readonly stepUpModelIds: readonly string[];
  readonly breakEven: number;
  readonly overheadMicroUsd: number;
  readonly attempts: readonly FirstTryAttempt[];
  /** The model the one hand-off went to; null until (and unless) it happened. */
  readonly handedOffTo: string | null;
  readonly state: 'open' | 'verified' | 'failed' | 'cancelled';
  readonly atMs: number;
  readonly finishedAtMs: number | null;
}

interface StateRow extends FirstTryState {
  readonly reasonCode: string;
  readonly atMs: number;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function idList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && ID.test(v)).slice(0, 8) : [];
}

function stateKey(ws: Pick<WorkspaceServices, 'workspaceId'>, row: Pick<FirstTryRow, 'sliceId' | 'baselineModelId' | 'firstTryModelId'>): string {
  return recordKey(ws.workspaceId, `${row.sliceId}|${row.baselineModelId}|${row.firstTryModelId}`.slice(0, 400));
}

/** Every first-try ledger row of this workspace (read only): the source of the status, explain and cost-report views. */
export function firstTryRows(ws: WorkspaceServices): readonly FirstTryRow[] {
  return ws.state.list<FirstTryRow>(COLLECTION).filter((r) => r.workspaceId === ws.workspaceId);
}

export function firstTryRow(ws: WorkspaceServices, taskId: string): FirstTryRow | undefined {
  const row = ws.state.get<FirstTryRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
  return row !== undefined && row.workspaceId === ws.workspaceId ? row : undefined;
}

/**
 * Keeps the route's first-try assignment for the run that just started. Only a run that really ran
 * the assigned arm counts (the first-try model for `first-try`, the baseline for `control`): a
 * first try the route could not launch that fell back to the baseline is not a first-try sample.
 * A task that already has a labelled first attempt keeps its row (a resumed task is not a new sample).
 */
export async function keepFirstTryRoute(
  ws: WorkspaceServices,
  input: { readonly taskId: string; readonly sliceId: string | null; readonly run: Pick<WorkerRunRecord, 'leaseId' | 'requestedModel'> | null; readonly note: unknown; readonly nowMs: number },
): Promise<FirstTryRow | null> {
  const learning = input.note !== null && typeof input.note === 'object' ? (input.note as { readonly firstTry?: unknown }) : null;
  const n = learning?.firstTry !== null && typeof learning?.firstTry === 'object' ? (learning.firstTry as Partial<FirstTryNote>) : null;
  if (n === null || input.sliceId === null || input.run === null || !ID.test(input.sliceId) || !ID.test(input.taskId)) return null;
  const arm = n.arm === 'first-try' || n.arm === 'control' ? n.arm : null;
  const firstTryModelId = typeof n.firstTryModelId === 'string' && ID.test(n.firstTryModelId) ? n.firstTryModelId : null;
  const baselineModelId = typeof n.baselineModelId === 'string' && ID.test(n.baselineModelId) ? n.baselineModelId : null;
  const propensity = num(n.propensity);
  if (arm === null || firstTryModelId === null || baselineModelId === null || propensity === null || propensity > 1) return null;
  const ran = input.run.requestedModel;
  if (ran !== (arm === 'first-try' ? firstTryModelId : baselineModelId)) return null;
  const row: FirstTryRow = {
    workspaceId: ws.workspaceId,
    taskId: input.taskId,
    sliceId: input.sliceId,
    arm,
    propensity,
    firstTryModelId,
    baselineModelId,
    stepUpModelIds: idList(n.stepUpModelIds),
    breakEven: num(n.breakEven) ?? 1,
    overheadMicroUsd: num(n.overheadMicroUsd) ?? 0,
    attempts: [{ role: 'first', modelId: ran, leaseId: input.run.leaseId, label: null, costMicroUsd: null, estimate: false, wallMs: null }],
    handedOffTo: null,
    state: 'open',
    atMs: input.nowMs,
    finishedAtMs: null,
  };
  const kept = await ws.state.transact((tx) => {
    const current = tx.get<FirstTryRow>(COLLECTION, recordKey(ws.workspaceId, input.taskId));
    if (current !== undefined && current.workspaceId === ws.workspaceId && current.attempts[0]?.label !== null && current.attempts[0]?.label !== 'limited') return false;
    tx.put(COLLECTION, recordKey(ws.workspaceId, input.taskId), row);
    return true;
  });
  return kept ? row : null;
}

const emptyStats = { ...EMPTY_FIRST_TRY_STATS };

/** What this workspace measured for one arm: finished tasks only (verified, or failed after every allowed attempt). */
function statsOf(rows: readonly FirstTryRow[]): FirstTryStats {
  let s: { -readonly [K in keyof FirstTryStats]: FirstTryStats[K] } = { ...emptyStats };
  for (const row of rows) {
    if (row.state !== 'verified' && row.state !== 'failed') continue;
    const first = row.attempts[0];
    const costs = row.attempts.map((a) => a.costMicroUsd);
    const known = costs.every((c) => c !== null);
    const walls = row.attempts.map((a) => a.wallMs);
    const firstFailed = first?.label === 'fail' || first?.label === 'incomplete';
    s = {
      ...s,
      tasks: s.tasks + 1,
      firstAttemptPass: s.firstAttemptPass + (first?.label === 'pass' ? 1 : 0),
      firstAttemptFail: s.firstAttemptFail + (firstFailed ? 1 : 0),
      escalated: s.escalated + (row.handedOffTo === null ? 0 : 1),
      verified: s.verified + (row.state === 'verified' ? 1 : 0),
      costMicroUsd: s.costMicroUsd + costs.reduce<number>((sum, c) => sum + (c ?? 0), 0),
      costKnownTasks: s.costKnownTasks + (known ? 1 : 0),
      estimate: s.estimate || row.attempts.some((a) => a.estimate),
      wallMs: s.wallMs + walls.reduce<number>((sum, w) => sum + (w ?? 0), 0),
      wallKnownTasks: s.wallKnownTasks + (walls.every((w) => w !== null) ? 1 : 0),
      firstAttemptCost: first?.costMicroUsd == null ? s.firstAttemptCost : { sumMicroUsd: s.firstAttemptCost.sumMicroUsd + first.costMicroUsd, n: s.firstAttemptCost.n + 1 },
      stepUpAttemptCost: row.attempts.filter((a) => a.role === 'hand-off' && a.costMicroUsd !== null).reduce((acc, a) => ({ sumMicroUsd: acc.sumMicroUsd + (a.costMicroUsd as number), n: acc.n + 1 }), s.stepUpAttemptCost),
    };
  }
  return s;
}

/** The workspace's measured history for one slice, baseline and first-try model: what C's route reads. */
export function firstTryHistory(ws: WorkspaceServices, query: { readonly sliceId: string; readonly baselineModelId: string; readonly firstTryModelId: string }): FirstTryHistory {
  const rows = ws.state
    .list<FirstTryRow>(COLLECTION)
    .filter((r) => r.workspaceId === ws.workspaceId && r.sliceId === query.sliceId && r.baselineModelId === query.baselineModelId && r.firstTryModelId === query.firstTryModelId);
  const saved = ws.state.get<StateRow>(STATE_COLLECTION, stateKey(ws, { ...query }));
  return {
    firstTry: statsOf(rows.filter((r) => r.arm === 'first-try')),
    control: statsOf(rows.filter((r) => r.arm === 'control')),
    state: saved === undefined ? null : { mode: saved.mode, changedAtFinished: saved.changedAtFinished },
  };
}

/** The cost of one attempt: billed dollars on an API key, else the usage at list price as an estimate. */
async function attemptCost(ws: WorkspaceServices, run: WorkerRunRecord | null): Promise<{ readonly costMicroUsd: number | null; readonly estimate: boolean }> {
  if (run === null) return { costMicroUsd: null, estimate: false };
  if (run.authMode !== 'subscription' && run.costUsd !== null && run.costUsd !== undefined) return { costMicroUsd: Math.max(0, Math.round(run.costUsd * 1_000_000)), estimate: false };
  if (run.usage === null || run.usage === undefined) return { costMicroUsd: null, estimate: false };
  const registry: ModelRegistry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const apiEquivalent = apiEquivalentCostMicroUsd(registry, run.actualModel ?? run.requestedModel, {
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    cacheReadTokens: run.usage.cacheReadInputTokens,
    cacheWriteTokens: run.usage.cacheCreationInputTokens,
  });
  return { costMicroUsd: apiEquivalent, estimate: true };
}

const FINISHED: ReadonlySet<FirstTryRow['state']> = new Set(['verified', 'failed', 'cancelled']);

export interface FirstTryOutcomeDetail {
  readonly run?: WorkerRunRecord | null;
  readonly nowMs: number;
}

/**
 * Follows a deterministic label of the task's latest attempt (C's own kinds, sent once per route).
 * `verified-pass` finishes the task verified; a failure finishes a control task, or a hand-off
 * attempt, as failed; a failed first attempt of a first-try task leaves it open for the one hand-off.
 * Idempotent: an attempt takes its first label only (a `reverted` overturns a pass).
 */
export async function recordFirstTryOutcome(ws: WorkspaceServices, taskId: string, kind: OutcomeKind, detail: FirstTryOutcomeDetail): Promise<FirstTryRow | null> {
  const row = firstTryRow(ws, taskId);
  if (row === undefined) return null;
  if (kind !== 'verified-pass' && kind !== 'verified-fail' && kind !== 'run-incomplete' && kind !== 'reverted' && kind !== 'cancelled' && kind !== 'usage-limited') return null;
  const cost = kind === 'verified-pass' || kind === 'verified-fail' || kind === 'run-incomplete' ? await attemptCost(ws, detail.run ?? null) : { costMicroUsd: null, estimate: false };
  const leaseId = detail.run?.leaseId ?? null;
  let finishedNow: FirstTryRow | null = null;
  await ws.state.transact((tx) => {
    const current = tx.get<FirstTryRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
    if (current === undefined || current.workspaceId !== ws.workspaceId) return;
    const byLease = leaseId === null ? -1 : current.attempts.findIndex((a) => a.leaseId === leaseId);
    const open = current.attempts.map((a, i) => (a.label === null ? i : -1)).filter((i) => i >= 0);
    const at = byLease >= 0 ? byLease : (open.at(-1) ?? current.attempts.length - 1);
    const attempt = current.attempts[at];
    if (attempt === undefined) return;
    const put = (next: FirstTryRow) => {
      tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), next);
      if (FINISHED.has(next.state) && !FINISHED.has(current.state)) finishedNow = next;
    };
    const relabel = (label: FirstTryAttemptLabel, patch: Partial<FirstTryRow>): void => {
      const attempts = current.attempts.map((a, i) =>
        i === at ? { ...a, label, costMicroUsd: a.costMicroUsd ?? cost.costMicroUsd, estimate: a.estimate || (a.costMicroUsd === null && cost.estimate), wallMs: a.wallMs ?? (detail.run === undefined || detail.run === null ? null : Math.max(0, Math.round(detail.run.durationMs))) } : a,
      );
      put({ ...current, attempts, ...patch });
    };
    const done = (state: 'verified' | 'failed'): Partial<FirstTryRow> => ({ state, finishedAtMs: detail.nowMs });
    if (current.state === 'cancelled') return;
    if (kind === 'cancelled') return put({ ...current, state: 'cancelled', finishedAtMs: detail.nowMs });
    if (kind === 'reverted') {
      if (attempt.label !== 'pass') return;
      return relabel('fail', done('failed'));
    }
    if (FINISHED.has(current.state)) return;
    if (kind === 'usage-limited') return attempt.label === null ? relabel('limited', {}) : undefined;
    // A receipt-less run later checked: the one verified label after `incomplete`, as the route's own labels allow.
    const late = attempt.label === 'incomplete' && current.handedOffTo === null && (kind === 'verified-pass' || kind === 'verified-fail');
    if (attempt.label !== null && attempt.label !== 'limited' && !late) return;
    if (kind === 'verified-pass') return relabel('pass', done('verified'));
    const failed = kind === 'verified-fail' ? 'fail' : 'incomplete';
    // A control task, or the hand-off attempt, ends the task; a failed first try waits for its one hand-off.
    return relabel(failed, current.arm === 'control' || attempt.role === 'hand-off' ? done('failed') : {});
  });
  const finished = finishedNow as FirstTryRow | null;
  if (finished !== null) await refreshVerdict(ws, finished);
  return firstTryRow(ws, taskId) ?? null;
}

/** The hand-off left for this task's failed first try: its row, the models to hand to, or why none. */
export function handOffPlan(ws: WorkspaceServices, taskId: string): { readonly row: FirstTryRow; readonly stepUpModelIds: readonly string[] } | null {
  const row = firstTryRow(ws, taskId);
  if (row === undefined || row.arm !== 'first-try' || row.state !== 'open' || row.handedOffTo !== null) return null;
  const first = row.attempts[0];
  if (first === undefined || (first.label !== 'fail' && first.label !== 'incomplete')) return null;
  return { row, stepUpModelIds: row.stepUpModelIds };
}

/** The one hand-off started: its attempt joins the row (its lease joins when its run starts). */
export async function noteHandOff(ws: WorkspaceServices, taskId: string, toModelId: string, nowMs: number): Promise<void> {
  await ws.state.transact((tx) => {
    const current = tx.get<FirstTryRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
    if (current === undefined || current.workspaceId !== ws.workspaceId || current.handedOffTo !== null || current.state !== 'open') return;
    tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), { ...current, handedOffTo: toModelId, attempts: [...current.attempts, { role: 'hand-off', modelId: toModelId, leaseId: null, label: null, costMicroUsd: null, estimate: false, wallMs: null }] } satisfies FirstTryRow);
  });
  void nowMs;
}

/** The hand-off run's lease, so its labels and cost find their attempt. */
export async function attachHandOffLease(ws: WorkspaceServices, taskId: string, leaseId: string): Promise<void> {
  await ws.state.transact((tx) => {
    const current = tx.get<FirstTryRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
    if (current === undefined || current.workspaceId !== ws.workspaceId) return;
    const i = current.attempts.findIndex((a) => a.role === 'hand-off' && a.leaseId === null);
    if (i < 0) return;
    tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), { ...current, attempts: current.attempts.map((a, at) => (at === i ? { ...a, leaseId } : a)) } satisfies FirstTryRow);
  });
}

/**
 * No hand-off can be made (or the one started did not launch): the task ends failed in the ledger,
 * a finished sample. A hand-off attempt that never got a run is dropped, so its unknown cost does not count.
 */
export async function closeUnhandled(ws: WorkspaceServices, taskId: string, nowMs: number): Promise<void> {
  let closed: FirstTryRow | null = null;
  await ws.state.transact((tx) => {
    const current = tx.get<FirstTryRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
    if (current === undefined || current.workspaceId !== ws.workspaceId || current.state !== 'open' || current.arm !== 'first-try') return;
    const last = current.attempts.at(-1);
    const dangling = last !== undefined && last.role === 'hand-off' && last.leaseId === null && last.label === null;
    const attempts = dangling ? current.attempts.slice(0, -1) : current.attempts;
    const first = attempts[0];
    if (first === undefined || (first.label !== 'fail' && first.label !== 'incomplete')) return;
    if (!dangling && current.handedOffTo !== null) return;
    closed = { ...current, attempts, handedOffTo: null, state: 'failed', finishedAtMs: nowMs };
    tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), closed);
  });
  if (closed !== null) await refreshVerdict(ws, closed);
}

/** Recomputes the slice's verdict from its finished tasks and persists a change (the anti-flap floor counts from it). */
async function refreshVerdict(ws: WorkspaceServices, row: FirstTryRow): Promise<void> {
  try {
    const query = { sliceId: row.sliceId, baselineModelId: row.baselineModelId, firstTryModelId: row.firstTryModelId };
    const history = firstTryHistory(ws, query);
    const loaded = await loadLearningState({ home: ws.home, workspaceId: ws.workspaceId }).catch(() => null);
    const verdict = firstTryVerdict({ history, candidate: { breakEven: row.breakEven, overheadMicroUsd: row.overheadMicroUsd }, settings: learningSettings(loaded?.settings ?? {}) });
    if (!verdict.changed) return;
    const next: StateRow = { mode: verdict.mode, changedAtFinished: history.firstTry.tasks, reasonCode: verdict.reasonCode, atMs: row.finishedAtMs ?? Date.now() };
    await ws.state.transact((tx) => tx.put(STATE_COLLECTION, stateKey(ws, query), next));
  } catch {
    // The verdict is advice for the next route; it never fails the task path.
  }
}

// ------------------------------------------------------------------------------------ reporting

export interface FirstTrySliceReport {
  readonly sliceId: string;
  readonly baselineModelId: string;
  readonly firstTryModelId: string;
  readonly mode: 'first-try' | 'baseline';
  readonly reasonCode: string;
  readonly firstTry: FirstTryStats;
  readonly control: FirstTryStats;
  readonly open: number;
}

/** One report per (slice, baseline, first-try model) this workspace has a ledger row for. */
export function firstTryReports(ws: WorkspaceServices): readonly FirstTrySliceReport[] {
  const rows = ws.state.list<FirstTryRow>(COLLECTION).filter((r) => r.workspaceId === ws.workspaceId);
  const keys = new Map<string, FirstTryRow>();
  for (const row of rows) keys.set(`${row.sliceId}|${row.baselineModelId}|${row.firstTryModelId}`, row);
  return [...keys.values()]
    .map((r): FirstTrySliceReport => {
      const query = { sliceId: r.sliceId, baselineModelId: r.baselineModelId, firstTryModelId: r.firstTryModelId };
      const history = firstTryHistory(ws, query);
      const saved = ws.state.get<StateRow>(STATE_COLLECTION, stateKey(ws, query));
      return {
        ...query,
        mode: history.state?.mode ?? 'first-try',
        reasonCode: saved?.reasonCode ?? 'DAY_1_PRIOR',
        firstTry: history.firstTry,
        control: history.control,
        open: rows.filter((x) => x.sliceId === r.sliceId && x.baselineModelId === r.baselineModelId && x.firstTryModelId === r.firstTryModelId && x.state === 'open').length,
      };
    })
    .sort((a, b) => (a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : a.firstTryModelId < b.firstTryModelId ? -1 : 1));
}
