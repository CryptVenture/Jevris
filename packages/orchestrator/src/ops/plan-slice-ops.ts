/**
 * Slice suggestions for a submitted plan (owner decision 2026-10-01, Jev as an active decision
 * aid). `jevris plan --submit` shows each task with the slice and risk the route classifier gives
 * it, as the plan check does. A label for a person: it is made from the tasks the plan already
 * holds and is never stored in the plan, never changes a task, and never starts anything. Any
 * failure is no labels, never a failed submit.
 */
import { PlanSliceSuggestionsContract, type PlanSliceSuggestion, type SidecarOpContext } from '@jevris/contracts';
import { WORKSPACE_REVISIONS, planSliceTimes, suggestPlanSlices, type PlanSliceTask } from '@jevris/core';
import type { TaskInput } from '../orchestration/tasks.js';
import { decisionEngineOf } from '../verify/relevance.js';

export type PlanSliceContext = Pick<SidecarOpContext, 'engine' | 'mode' | 'jevAssist' | 'killSwitchStopped' | 'deadline' | 'trace'>;

/** The slice evidence of the submitted tasks, in the plan's order. */
export function submittedSliceTasks(tasks: readonly TaskInput[], order: readonly string[]): PlanSliceTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  return order.flatMap((id) => {
    const t = byId.get(id);
    return t === undefined ? [] : [{ id, title: t.title ?? null, paths: t.writeScopes ?? [], checkIds: t.acceptanceCheckIds ?? [], sliceId: t.sliceId ?? null }];
  });
}

/** The suggestions for the tasks just submitted; empty when nothing could be labelled. Never throws. */
export async function submittedPlanSuggestions(ctx: PlanSliceContext, workspaceId: string, tasks: readonly TaskInput[], order: readonly string[]): Promise<readonly PlanSliceSuggestion[]> {
  try {
    const found = await suggestPlanSlices(
      decisionEngineOf(ctx.engine),
      submittedSliceTasks(tasks, order),
      { workspaceId, evidenceRevision: WORKSPACE_REVISIONS.current(workspaceId) },
      {
        // Absent (a direct unit call) reads as classify, like the route op.
        assist: ctx.jevAssist === 'off' ? 'off' : 'classify',
        ...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
        killSwitchStopped: ctx.killSwitchStopped,
        // The tasks were created a moment ago under these ids: each decision is recorded under its own task's id.
        tasksExist: true,
        note: (reasonCode) => ctx.trace({ event: 'plan-slices', reasonCode }),
        ...planSliceTimes(ctx.deadline.remainingMs()),
      },
    );
    const checked = PlanSliceSuggestionsContract.validate(found);
    return checked.ok ? checked.value : [];
  } catch {
    return [];
  }
}
