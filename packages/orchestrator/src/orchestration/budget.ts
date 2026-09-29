/**
 * Budget exhaustion (ORC-10, SSOT W09, US32).
 *
 * The lease authority already refuses a reservation that would exceed the owned envelope,
 * which is the limit minus the shutdown reserve (OVER_BUDGET). The reserve is never admitted
 * to new work. When that happens during owned work, `onBudgetExhausted`:
 *
 * - applies the budget's predeclared cancellation policy to the running work, once per
 *   exhaustion episode:
 *   - finish-running: running work continues;
 *   - cancel-newest: the most recently leased running task is cancelled (its worktree kept);
 *   - pause-all: the budget is paused, so no new lease starts until a person resumes it, and
 *     running work finishes;
 * - records a content-free report with the suggestion set: narrow the task, a cheaper
 *   qualified profile (another of the task's approved models with a lower registry price, or
 *   none), pause, or a user-approved increase. Skipping mandatory verification is never
 *   offered.
 *
 * Unknown vendor usage stays held at its full reservation (uncertain), and reconciliation
 * counts it in full.
 *
 * `updateBudget` is the person's answer, and is CLI only. It raises the limit (never below
 * what is held) only with a single-use terminal authorization (`jevris authorize
 * budget.increase --scope <budget id>`). It can also resume a paused budget and closes the
 * episode.
 */
import { BUNDLED_MODEL_REGISTRY, loadModelRegistry, registryModel } from '@jevris/core';
import type { ModelRegistry } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { budgetUse, type BudgetRecord, type LeaseAuthority, type LeaseRecord } from './leases.js';
import { getTask, listTasks } from './tasks.js';
import { cancelTask } from './workers.js';

export const BUDGET_EXHAUSTION_SCHEMA = 'jevris-budget-exhaustion-1';

export type BudgetSuggestionKind = 'narrow' | 'cheaper-profile' | 'pause' | 'increase';

export interface BudgetSuggestion {
  readonly kind: BudgetSuggestionKind;
  readonly taskId: string | null;
  /** cheaper-profile: the approved model to run instead. */
  readonly model: string | null;
  /** increase: the smallest limit that admits every refused task. */
  readonly increaseToMicroUsd: number | null;
  readonly text: string;
}

export interface BudgetExhaustionReport {
  readonly schemaVersion: typeof BUDGET_EXHAUSTION_SCHEMA;
  readonly budgetId: string;
  readonly workspaceId: string;
  readonly atMs: number;
  /** True until a person resumes or raises the budget. */
  readonly open: boolean;
  readonly policy: BudgetRecord['policy'];
  readonly limitMicroUsd: number;
  readonly heldMicroUsd: number;
  readonly reserveMicroUsd: number;
  /** What new work may still reserve: limit minus reserve minus held, never below 0. */
  readonly availableMicroUsd: number;
  readonly refused: readonly { readonly taskId: string; readonly estimateMicroUsd: number; readonly reasonCode: string }[];
  readonly actions: readonly { readonly taskId: string; readonly action: 'continue' | 'cancelled' | 'paused' }[];
  readonly suggestions: readonly BudgetSuggestion[];
  /** Mandatory verification is never skipped to fit a budget. */
  readonly mandatoryChecksKept: true;
  /** Raising the limit needs a person's terminal authorization. */
  readonly increaseNeedsAuthorization: true;
}

export function budgetExhaustion(ws: WorkspaceServices, budgetId: string): BudgetExhaustionReport | undefined {
  const row = ws.state.get<BudgetExhaustionReport>('budget-exhaustions', budgetId);
  return row !== undefined && row.workspaceId === ws.workspaceId ? row : undefined;
}

function available(use: { readonly heldMicroUsd: number; readonly limitMicroUsd: number; readonly reserveMicroUsd: number }): number {
  return Math.max(0, use.limitMicroUsd - use.reserveMicroUsd - use.heldMicroUsd);
}

/**
 * The output price of a model (USD per million tokens) in the model registry in use (the signed
 * refresh in the Jevris home when it loads, else the bundled one), or null when unknown.
 */
function priceOf(registry: ModelRegistry, model: string, nowMs: number): number | null {
  const entry = registryModel(registry, model);
  if (entry === null) return null;
  // The price in force now: the latest scheduled change already effective, else the base.
  const tariff = entry.tariff as { readonly outputPerMillion: number; readonly scheduled?: readonly { readonly effectiveAt: string; readonly outputPerMillion: number }[] };
  const due = (tariff.scheduled ?? []).filter((row) => Date.parse(row.effectiveAt) <= nowMs).at(-1);
  const price = due?.outputPerMillion ?? tariff.outputPerMillion;
  return typeof price === 'number' && Number.isFinite(price) ? price : null;
}

function cheaperModel(registry: ModelRegistry, task: NonNullable<ReturnType<typeof getTask>>, nowMs: number): string | null {
  const current = task.models[0];
  if (current === undefined) return null;
  const now = priceOf(registry, current, nowMs);
  if (now === null) return null;
  let best: { model: string; price: number } | null = null;
  for (const m of task.models.slice(1)) {
    const p = priceOf(registry, m, nowMs);
    if (p !== null && p < now && (best === null || p < best.price)) best = { model: m, price: p };
  }
  return best?.model ?? null;
}

/**
 * Applies the budget's cancellation policy (once per episode) and records the suggestion set
 * for the refused tasks.
 */
export async function onBudgetExhausted(
  ws: WorkspaceServices,
  authority: LeaseAuthority,
  budgetId: string,
  refused: readonly { readonly taskId: string; readonly reasonCode: string }[],
  nowMs = Date.now(),
): Promise<BudgetExhaustionReport | undefined> {
  const budget = ws.host.get<BudgetRecord>('budgets', budgetId);
  const use = budgetUse(ws.host, budgetId);
  if (budget === undefined || use === undefined || budget.workspaceId !== ws.workspaceId) return undefined;
  const prior = budgetExhaustion(ws, budgetId);
  // The policy acts once per episode. A person's resume at the same limit does not start a new
  // one (the policy is not re-applied against their decision); a raised limit does.
  const firstInEpisode = prior === undefined || (!prior.open && prior.limitMicroUsd !== budget.limitMicroUsd);
  // Running work of this budget, newest lease first.
  const leases = authority.activeLeases(ws.workspaceId);
  const running = listTasks(ws, { states: ['leased', 'running'] })
    .filter((t) => t.node.rootBudgetId === budgetId)
    .map((t) => ({ taskId: t.node.id, issuedAtMs: leases.find((l) => l.lease.taskId === t.node.id)?.issuedAtMs ?? 0 }))
    .sort((a, b) => b.issuedAtMs - a.issuedAtMs);
  let actions: BudgetExhaustionReport['actions'] = prior?.open === true ? prior.actions : running.map((r) => ({ taskId: r.taskId, action: 'continue' as const }));
  if (firstInEpisode) {
    if (budget.policy === 'cancel-newest' && running[0] !== undefined) {
      const newest = running[0].taskId;
      const cancelled = await cancelTask(ws, authority, newest, 'budget exhausted: cancel-newest policy', nowMs);
      actions = running.map((r) => ({ taskId: r.taskId, action: r.taskId === newest && cancelled.cancelled ? ('cancelled' as const) : ('continue' as const) }));
    } else if (budget.policy === 'pause-all') {
      await ws.host.transact((tx) => tx.put('budgets', budgetId, { ...budget, paused: true, updatedAtMs: nowMs } satisfies BudgetRecord));
      actions = running.map((r) => ({ taskId: r.taskId, action: 'paused' as const }));
    }
  }
  const after = budgetUse(ws.host, budgetId) ?? use;
  const free = available(after);
  const rows = refused.map((r) => ({ taskId: r.taskId, estimateMicroUsd: Math.max(0, Math.trunc(getTask(ws, r.taskId)?.estimateMicroUsd ?? 0)), reasonCode: r.reasonCode }));
  const suggestions: BudgetSuggestion[] = [];
  const registry = rows.length === 0 ? BUNDLED_MODEL_REGISTRY : ((await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY);
  for (const r of rows) {
    const task = getTask(ws, r.taskId);
    if (task === undefined) continue;
    if (r.estimateMicroUsd > free) {
      suggestions.push({ kind: 'narrow', taskId: r.taskId, model: null, increaseToMicroUsd: null, text: `Narrow ${r.taskId} (split it or reduce its outputs) so its reservation of ${String(r.estimateMicroUsd)} micro-USD fits the ${String(free)} available. Its acceptance checks stay mandatory.` });
    }
    const cheaper = cheaperModel(registry, task, nowMs);
    suggestions.push(
      cheaper === null
        ? { kind: 'cheaper-profile', taskId: r.taskId, model: null, increaseToMicroUsd: null, text: `No cheaper qualified profile among ${r.taskId}'s approved models.` }
        : { kind: 'cheaper-profile', taskId: r.taskId, model: cheaper, increaseToMicroUsd: null, text: `Run ${r.taskId} with ${cheaper}, an approved model with a lower registry price; replan the task with that model first.` },
    );
  }
  suggestions.push({ kind: 'pause', taskId: null, model: null, increaseToMicroUsd: null, text: `Pause: the refused tasks stay queued; running work follows the ${budget.policy} policy.` });
  const needed = rows.reduce((n, r) => n + r.estimateMicroUsd, 0) - free;
  if (needed > 0) {
    const to = after.limitMicroUsd + needed;
    suggestions.push({ kind: 'increase', taskId: null, model: null, increaseToMicroUsd: to, text: `Ask the budget owner to raise the limit to ${String(to)} micro-USD: jevris authorize budget.increase --scope ${budgetId}, then the budget update.` });
  }
  const report: BudgetExhaustionReport = {
    schemaVersion: BUDGET_EXHAUSTION_SCHEMA,
    budgetId,
    workspaceId: ws.workspaceId,
    atMs: nowMs,
    open: true,
    policy: budget.policy,
    limitMicroUsd: after.limitMicroUsd,
    heldMicroUsd: after.heldMicroUsd,
    reserveMicroUsd: after.reserveMicroUsd,
    availableMicroUsd: free,
    refused: rows,
    actions,
    suggestions,
    mandatoryChecksKept: true,
    increaseNeedsAuthorization: true,
  };
  await ws.state.transact((tx) => tx.put('budget-exhaustions', budgetId, report));
  return report;
}

export interface UpdateBudgetInput {
  readonly budgetId: string;
  /** A new, higher limit; needs `authorize` (a consumed terminal authorization). */
  readonly limitMicroUsd?: number;
  /** Resume a budget the pause-all policy paused. */
  readonly resume?: boolean;
  /** Consumes the person's terminal authorization for `budget.increase` on this budget. */
  readonly authorize: (scope: string) => boolean;
  readonly nowMs?: number;
}

export type UpdateBudgetResult =
  | { readonly ok: true; readonly budget: BudgetRecord }
  | { readonly ok: false; readonly reasonCode: 'UNKNOWN_BUDGET' | 'NOTHING_TO_CHANGE' | 'LIMIT_NOT_HIGHER' | 'AUTHORIZATION_REFUSED' };

/** The person's answer to an exhaustion: a higher limit (authorized) and/or resume. */
export async function updateBudget(ws: WorkspaceServices, input: UpdateBudgetInput): Promise<UpdateBudgetResult> {
  const budget = ws.host.get<BudgetRecord>('budgets', input.budgetId);
  if (budget === undefined || budget.workspaceId !== ws.workspaceId) return { ok: false, reasonCode: 'UNKNOWN_BUDGET' };
  if (input.limitMicroUsd === undefined && input.resume !== true) return { ok: false, reasonCode: 'NOTHING_TO_CHANGE' };
  if (input.limitMicroUsd !== undefined) {
    if (!Number.isSafeInteger(input.limitMicroUsd) || input.limitMicroUsd <= budget.limitMicroUsd) return { ok: false, reasonCode: 'LIMIT_NOT_HIGHER' };
    if (!input.authorize(input.budgetId)) return { ok: false, reasonCode: 'AUTHORIZATION_REFUSED' };
  }
  const next: BudgetRecord = {
    ...budget,
    ...(input.limitMicroUsd === undefined ? {} : { limitMicroUsd: input.limitMicroUsd }),
    ...(input.resume === true || input.limitMicroUsd !== undefined ? { paused: false } : {}),
    updatedAtMs: input.nowMs ?? Date.now(),
  };
  await ws.host.transact((tx) => tx.put('budgets', budget.id, next));
  const report = budgetExhaustion(ws, budget.id);
  if (report !== undefined && report.open) await ws.state.transact((tx) => tx.put('budget-exhaustions', budget.id, { ...report, open: false }));
  return { ok: true, budget: next };
}
