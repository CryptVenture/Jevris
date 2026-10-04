/**
 * Worker-readiness advice at an owned-worker launch (owner decision 2026-10-01, Jev as an active
 * decision aid). Where the launch is decided (`routedRun` in `ops/task-ops.ts`), Jev is asked ONE
 * bounded question from the task's content-free features, and the answer is recorded as an advisory
 * decision that `jevris explain` renders (`@jevris/core`'s `adviseWorkerReadiness`).
 *
 * It is advice only. The launch is decided by the rules, the budget and the permissions, exactly as
 * before: this never blocks a launch, starts one, picks a model or changes a reservation, and a launch
 * does not wait for Jev past the wait below (a provider that never answers costs that wait, once, in a
 * background run). The task's title is reduced to a verb class here and its paths to counts and
 * categories before anything is built; nothing of the task leaves as text.
 */
import { modeAllows, type SidecarOpContext } from '@jevris/contracts';
import { adviseWorkerReadiness, type DecisionEngine, type WorkerReadiness } from '@jevris/core';
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';
import type { TaskRecord } from './tasks.js';

/** The state collection holding, per task, the decision of the readiness advice at its latest launch (read by `task.get`). */
export const LAUNCH_READINESS_COLLECTION = 'launch-readiness';

/** The longest a launch waits for Jev, in ms: a cache hit answers in tens of ms, an uncached call in a few hundred. */
export const LAUNCH_READINESS_WAIT_MS = 700;

type ReadinessContext = Pick<SidecarOpContext, 'engine' | 'mode' | 'jevAssist' | 'killSwitchStopped' | 'trace'>;

/** The engine the sidecar built, when `ctx.engine` looks like one (it can decide). */
function engineOf(engine: unknown): DecisionEngine | null {
  if (engine === null || engine === undefined || typeof engine !== 'object') return null;
  return typeof (engine as Partial<DecisionEngine>).decide === 'function' ? (engine as DecisionEngine) : null;
}

/**
 * The readiness advice for one task about to be launched, or null when it was not asked about. Never
 * throws and never waits past `waitMs`; a miss is a `WorkerReadiness` with no state and its reason.
 */
export async function launchReadiness(ctx: ReadinessContext, ws: Pick<WorkspaceServices, 'workspaceId' | 'state'>, task: TaskRecord, options: { readonly waitMs?: number; readonly counterfactual?: boolean } = {}): Promise<WorkerReadiness | null> {
  try {
    const mode = ctx.mode ?? 'bounded-auto';
    // Below observe nothing runs: not even the rules' own record of the launch.
    if (!modeAllows(mode, 'record')) return null;
    const advice = await adviseWorkerReadiness(
      engineOf(ctx.engine),
      { title: task.title, paths: task.node.writeScopes, checkIds: task.node.acceptanceCheckIds },
      { workspaceId: ws.workspaceId, evidenceRevision: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.node.revision) ? task.node.revision : 'launch-r0', taskId: task.node.id },
      {
        mode,
        assist: ctx.jevAssist === 'off' ? 'off' : 'classify',
        killSwitchStopped: ctx.killSwitchStopped,
        deadlineMs: options.waitMs ?? LAUNCH_READINESS_WAIT_MS,
        ...(options.counterfactual === true ? { extraCodes: ['WORKER_READINESS_COUNTERFACTUAL'] } : {}),
      },
    );
    ctx.trace({ event: 'orchestrator.worker-readiness', taskId: task.node.id, reasonCode: advice.reasonCode.slice(0, 64), ...(advice.decisionId === null ? {} : { decisionId: advice.decisionId }) });
    // The decision is kept with the task, so `jevris task get` names it and `jevris explain` shows it. A write that fails changes nothing.
    if (advice.decisionId !== null) {
      const decisionId = advice.decisionId;
      await ws.state.transact((tx) => tx.put(LAUNCH_READINESS_COLLECTION, recordKey(ws.workspaceId, task.node.id), { decisionId, state: advice.state ?? 'none', atMs: Date.now() })).catch(() => undefined);
    }
    return advice;
  } catch {
    // Advice only: a failed ask changes nothing about the launch.
    return null;
  }
}
