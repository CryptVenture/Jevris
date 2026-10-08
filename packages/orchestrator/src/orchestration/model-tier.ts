/**
 * The model tier of an owned launch, kept with the task (owner decision 2026-10-08, tiered routing).
 *
 * C's `routeManagedWorker` judges the tier over the models the launch would accept (the baseline's own provider, the
 * router's gates already applied) and returns a content-free note: the tier, the target, the baseline, why, and the
 * dearer rungs nearest first. D keeps one row per task here (local only, ids and codes, never text), for two uses:
 *
 * - the bounded escalation: a failed task with no stronger approved model is relaunched once on the next rung above the
 *   model that failed (`relaunchEscalated`), never outside the models the launch could use;
 * - explain and status: the row names the decision (`jevris explain <id>`), and says the tier is a rules-based default
 *   or Jev's suggestion, never a learned route or a signed prior.
 */
import { tierSignalsOf, type TierSignals } from '@jevris/core';
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';
import { criticalPathLengths } from './graph.js';
import { getTask, listTasks } from './tasks.js';

const COLLECTION = 'model-tier';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TierRow {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly tier: 'step-down' | 'baseline' | 'step-up';
  readonly targetModelId: string;
  readonly baselineModelId: string;
  readonly basis: 'tier-rule' | 'tier-jev';
  /** The dearer rungs above the baseline, nearest first (at most 8). */
  readonly stepUpModelIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly decisionId: string | null;
  readonly atMs: number;
}

function ids(value: unknown, max: number, pattern = ID): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && pattern.test(v)).slice(0, max) : [];
}

/** Keeps the router's tier note for the task's latest launch. Null for a note that is not one. */
export async function keepTierNote(ws: WorkspaceServices, taskId: string, note: unknown, nowMs: number): Promise<TierRow | null> {
  if (note === null || typeof note !== 'object' || !ID.test(taskId)) return null;
  const n = note as Record<string, unknown>;
  const tier = n['tier'] === 'step-down' || n['tier'] === 'baseline' || n['tier'] === 'step-up' ? n['tier'] : null;
  const target = typeof n['targetModelId'] === 'string' && ID.test(n['targetModelId']) ? n['targetModelId'] : null;
  const baseline = typeof n['baselineModelId'] === 'string' && ID.test(n['baselineModelId']) ? n['baselineModelId'] : null;
  if (tier === null || target === null || baseline === null) return null;
  const row: TierRow = {
    workspaceId: ws.workspaceId,
    taskId,
    tier,
    targetModelId: target,
    baselineModelId: baseline,
    basis: n['basis'] === 'tier-jev' ? 'tier-jev' : 'tier-rule',
    stepUpModelIds: ids(n['stepUpModelIds'], 8),
    reasonCodes: ids(n['reasonCodes'], 16, /^[A-Z][A-Z0-9_]{0,63}$/),
    decisionId: typeof n['decisionId'] === 'string' && ID.test(n['decisionId']) ? n['decisionId'] : null,
    atMs: nowMs,
  };
  await ws.state.transact((tx) => tx.put(COLLECTION, recordKey(ws.workspaceId, taskId), row));
  return row;
}

export function tierRow(ws: WorkspaceServices, taskId: string): TierRow | undefined {
  const row = ws.state.get<TierRow>(COLLECTION, recordKey(ws.workspaceId, taskId));
  return row !== undefined && row.workspaceId === ws.workspaceId ? row : undefined;
}

/**
 * The rungs the bounded escalation may go to, above the model that failed: the ladder the launch named, from the
 * baseline up. A model that is not on the ladder (the baseline itself, or one the route no longer knows) starts at the
 * bottom of it; a failed rung starts above itself. Empty when the task has no tier row.
 */
export function escalationRungs(row: TierRow | undefined, failedModelId: string | null): readonly string[] {
  if (row === undefined) return [];
  const at = failedModelId === null ? -1 : row.stepUpModelIds.indexOf(failedModelId);
  return at < 0 ? row.stepUpModelIds : row.stepUpModelIds.slice(at + 1);
}

/**
 * The content-free tier signals of a task for a main-session turn on Kilo or OpenCode (owner decision 2026-10-08, step 2b):
 * counts, the risk class and its reasons, protected classes, a verb class and the plan depth, the way an owned launch's are
 * (`tierSignalsOf`; the title is reduced to a verb class here and never kept). No run on the baseline is counted: the
 * session's own model is not an owned worker's. Null when the task is not found; never throws.
 */
export function turnTierSignals(ws: WorkspaceServices, taskId: string): TierSignals | null {
  try {
    const task = getTask(ws, taskId);
    if (task === undefined) return null;
    const depth = criticalPathLengths(listTasks(ws, {}).map((t) => t.node)).get(taskId) ?? null;
    return tierSignalsOf({
      hints: { title: task.title, paths: task.node.writeScopes, checkIds: task.node.acceptanceCheckIds },
      ...(task.sliceId === null ? {} : { sliceId: task.sliceId }),
      risk: task.risk,
      riskReasons: task.riskReasons,
      planDepth: depth,
    });
  } catch {
    return null;
  }
}
