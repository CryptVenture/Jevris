/**
 * Budget ops (ORC-10, W09), local payloads:
 *
 * - `budget.get` (status scope): `{ budgetId }` gives the budget, what it holds and what new
 *   work may still reserve, plus the last exhaustion report (policy actions and suggestions).
 * - `budget.update` (submit scope, CLI only; stopped by the kill switch):
 *   `{ budgetId, limitMicroUsd?, resume?, authorizationId?, actor }`. A higher limit needs a
 *   single-use terminal authorization (`jevris authorize budget.increase --scope <budget id>`)
 *   minted for the same actor. Model or frame text cannot approve it. Resume unpauses a budget
 *   the pause-all policy paused. The plan then continues under bounded-auto workers.
 * - `learning.report` (status scope): what D has learned in this workspace, ids and counts only:
 *   estimate accuracy (P11; `{ rootBudgetId? }` narrows it to one plan), restore outcomes (P9),
 *   Stop reminders (P6), evidence-selection usage (P10) and subagent runs (P13, timing only).
 *   It changes nothing.
 */
import { ID_PATTERN, type SidecarOpContext, type SidecarOpOutcome } from '@jevris/contracts';
import { useAuthorization, type AuthorizationAction } from '@jevris/store';
import type { WorkspaceServices } from '../workspace.js';
import { isPlain, own } from '../util.js';
import { budgetUse, type BudgetRecord } from '../orchestration/leases.js';
import { budgetExhaustion, updateBudget } from '../orchestration/budget.js';
import { continueOwnedWorkWithin } from './task-ops.js';
import { estimateAccuracy } from '../orchestration/estimates.js';
import { restoreSummary } from '../memory/restore-outcomes.js';
import { evidenceUsage } from '../memory/evidence-usage.js';
import { reminderSummary } from '../verify/completion.js';
import { subagentSummary } from '../orchestration/subagent-runs.js';

type WorkspaceOf = (ctx: SidecarOpContext) => WorkspaceServices | undefined;

const CONTRACT_ID = new RegExp(ID_PATTERN);
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
/** The authorization class a budget increase consumes (B's GOV-09 terminal channel). */
export const BUDGET_INCREASE_ACTION = 'budget.increase';

function budgetView(ws: WorkspaceServices, budgetId: string) {
  const budget = ws.host.get<BudgetRecord>('budgets', budgetId);
  const use = budgetUse(ws.host, budgetId);
  if (budget === undefined || use === undefined || budget.workspaceId !== ws.workspaceId) return { found: false as const, budget: null, use: null, exhaustion: null };
  return {
    found: true as const,
    budget: { id: budget.id, ownerId: budget.ownerId, limitMicroUsd: budget.limitMicroUsd, shutdownReserveMicroUsd: budget.shutdownReserveMicroUsd, policy: budget.policy, paused: budget.paused === true },
    use: { heldMicroUsd: use.heldMicroUsd, availableMicroUsd: Math.max(0, use.limitMicroUsd - use.reserveMicroUsd - use.heldMicroUsd) },
    exhaustion: budgetExhaustion(ws, budgetId) ?? null,
    // P11: the plan's estimates against what its tasks committed.
    estimates: estimateAccuracy(ws, { rootBudgetId: budgetId }),
  };
}

export function budgetOps(workspaceOf: WorkspaceOf) {
  return [
    {
      op: 'learning.report',
      scope: 'status' as const,
      budget: 'background' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const id = isPlain(ctx.body) ? own(ctx.body, 'rootBudgetId') : undefined;
        if (id !== undefined && (typeof id !== 'string' || !CONTRACT_ID.test(id))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = workspaceOf(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        return {
          ok: true,
          body: {
            estimates: estimateAccuracy(ws, id === undefined ? {} : { rootBudgetId: id }),
            restores: restoreSummary(ws),
            reminders: reminderSummary(ws.state, ws.workspaceId),
            evidence: evidenceUsage(ws),
            subagents: subagentSummary(ws),
          },
        };
      },
    },
    {
      op: 'budget.get',
      scope: 'status' as const,
      budget: 'hot' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const id = isPlain(ctx.body) ? own(ctx.body, 'budgetId') : undefined;
        if (typeof id !== 'string' || !CONTRACT_ID.test(id)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = workspaceOf(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        return { ok: true, body: budgetView(ws, id) };
      },
    },
    {
      op: 'budget.update',
      scope: 'submit' as const,
      budget: 'hot' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        if (!isPlain(ctx.body)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const id = own(ctx.body, 'budgetId');
        const limit = own(ctx.body, 'limitMicroUsd');
        const resume = own(ctx.body, 'resume');
        const authorizationId = own(ctx.body, 'authorizationId');
        const actor = own(ctx.body, 'actor');
        if (typeof id !== 'string' || !CONTRACT_ID.test(id)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (resume !== undefined && typeof resume !== 'boolean') return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (authorizationId !== undefined && (typeof authorizationId !== 'string' || !CONTRACT_ID.test(authorizationId))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (typeof actor !== 'string' || !ACTOR.test(actor)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        // A person's decision at the CLI: MCP and hooks never hold the submit scope.
        if (ctx.client !== 'cli') return { ok: false, reasonCode: 'CLI_ONLY' };
        const ws = workspaceOf(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const store = ws.store;
        const result = await updateBudget(ws, {
          budgetId: id,
          ...(limit === undefined ? {} : { limitMicroUsd: limit as number }),
          ...(resume === true ? { resume: true } : {}),
          authorize: (scope) =>
            store !== undefined &&
            typeof authorizationId === 'string' &&
            useAuthorization(store, { authorizationId, principal: actor, actionClass: BUDGET_INCREASE_ACTION as AuthorizationAction, scope, nowMs: Date.now() }).ok,
        });
        ctx.trace({ event: 'orchestrator.budget-update', reasonCode: result.ok ? 'UPDATED' : result.reasonCode });
        if (result.ok) await continueOwnedWorkWithin(ctx, ws);
        return { ok: true, body: { updated: result.ok, reasonCode: result.ok ? 'UPDATED' : result.reasonCode, ...budgetView(ws, id) } };
      },
    },
  ];
}
