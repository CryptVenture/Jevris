/**
 * Compaction readiness (MEM-07; SSOT §9.3, C19, US14).
 *
 * The working budget is the model's context capacity from the registry, minus the output
 * reservation, a fixed harness overhead and a safety margin. Readiness compares the current
 * estimate with it and recommends a boundary. Native compaction always stays allowed: Jevris
 * defers it only on a positive, certified safe-trigger signal, at most once per episode, and
 * never against a manual compaction. The capsule is refreshed at task boundaries so a
 * compaction never finds it stale.
 */
import type { ModelRegistry } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { listTasks } from '../orchestration/tasks.js';
import { consultNoul } from '../capabilities/consult.js';
import { recordKey } from '../util.js';
import { latestCapsule, writeCapsule, type AssembleInput, type CapsuleV2 } from './capsule.js';

export interface BudgetFacts {
  readonly capacityTokens: number;
  readonly outputReservationTokens: number;
  readonly overheadTokens: number;
  /** Fraction of capacity kept free (0..0.5). */
  readonly marginFraction: number;
}

export const DEFAULT_OVERHEAD_TOKENS = 12_000;
export const DEFAULT_MARGIN = 0.1;

/** Budget facts from a registry snapshot; null when the model is not in the registry. */
export function budgetFromRegistry(registry: ModelRegistry | null, modelId: string, overrides: Partial<BudgetFacts> = {}): BudgetFacts | null {
  const entry = registry?.entries.find((e) => e.modelId === modelId || modelId.startsWith(`${e.modelId}[`));
  if (entry === undefined) return null;
  return {
    capacityTokens: entry.contextTokens,
    outputReservationTokens: Math.min(entry.maxOutputTokens, Math.floor(entry.contextTokens / 4)),
    overheadTokens: overrides.overheadTokens ?? DEFAULT_OVERHEAD_TOKENS,
    marginFraction: overrides.marginFraction ?? DEFAULT_MARGIN,
  };
}

export function workingBudget(facts: BudgetFacts): number {
  const margin = Math.floor(facts.capacityTokens * Math.min(0.5, Math.max(0, facts.marginFraction)));
  return Math.max(0, facts.capacityTokens - facts.outputReservationTokens - facts.overheadTokens - margin);
}

export type Boundary = 'none' | 'prepare' | 'recommend-boundary';

export interface ReadinessInput {
  readonly taskId: string | null;
  readonly facts: BudgetFacts | null;
  readonly usedTokens: number | null;
  readonly episodeId: string;
  /** The harness compacting on its own (auto) or by the user's command (manual). */
  readonly trigger?: 'auto' | 'manual' | null;
  /** A certified signal that deferring is safe right now (e.g. a tool call mid-flight). */
  readonly certifiedSafeTrigger?: boolean;
  readonly engine?: unknown;
  readonly remainingMs?: number;
  readonly nowMs?: number;
}

export interface Readiness {
  readonly workingBudget: number | null;
  readonly usedFraction: number | null;
  readonly boundary: Boundary;
  /** Native compaction is always allowed. */
  readonly nativeAllowed: true;
  readonly deferred: boolean;
  readonly deferReason: string | null;
  readonly capsuleId: string | null;
  readonly capsuleFresh: boolean;
  readonly source: 'rules' | 'jev';
  /** The Jev decision that said so (C19), for `jevris explain`; null when rules did or Jev was not asked. */
  readonly decisionId: string | null;
}

/** Readiness from the budget; with a certified signal, may defer a non-manual compaction once. */
export async function compactionReadiness(ws: WorkspaceServices, input: ReadinessInput): Promise<Readiness> {
  const nowMs = input.nowMs ?? Date.now();
  const budget = input.facts === null ? null : workingBudget(input.facts);
  const used = input.usedTokens === null || budget === null || budget === 0 ? null : input.usedTokens / budget;
  let boundary: Boundary = 'none';
  if (used !== null) boundary = used >= 0.9 ? 'recommend-boundary' : used >= 0.7 ? 'prepare' : 'none';
  let source: 'rules' | 'jev' = 'rules';
  let decisionId: string | null = null;
  const capsule = latestCapsule(ws, input.taskId);
  const capsuleFresh = capsule !== undefined && nowMs - Date.parse(capsule.createdAt) < 15 * 60_000;
  // C19: in the grey zone Jev may recommend a boundary earlier; it never forbids compaction. The question is
  // asked over local facts only (the use as a percent, how many tasks are running, how many checks are open
  // and unresolved, whether the capsule is current): counts and flags, so it needs no egress approval.
  if (boundary === 'prepare' && input.engine !== undefined) {
    const items = capsule?.items ?? [];
    const count = (kind: string): number => items.filter((i) => i.kind === kind).length;
    const running = listTasks(ws).filter((t) => ['leased', 'running', 'awaiting-evidence', 'verifying'].includes(t.node.state)).length;
    const r = await consultNoul(input.engine, {
      capabilityId: 'C19',
      specVersion: '1',
      objective: 'Recommend whether this is a good boundary to compact context, from counts only (advice only).',
      instructions: 'Using only the facts (the percent of the working context in use, the running tasks, the open checks, the unresolved failures and whether the saved capsule is current), is now a good boundary to compact: a task just finished and no work is mid-flight?',
      whenTrue: 'A clean boundary: nothing is running, no check or failure is open, and the capsule is current, so compaction now loses little.',
      whenFalse: 'Work is mid-flight, a check or failure is open, or the capsule is out of date: wait for the next boundary.',
      evidence: [],
      facts: { usedPercent: Math.round((used ?? 0) * 100), runningTasks: Math.min(running, 99), openChecks: Math.min(count('open-check'), 99), unresolved: Math.min(count('unresolved'), 99), capsuleCurrent: capsuleFresh },
      workspaceId: ws.workspaceId,
      evidenceRevision: input.episodeId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'episode',
      ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
      rules: () => ({ value: false, reasonCode: 'RULES' }),
    });
    if (r.source === 'jev') source = 'jev';
    decisionId = r.decisionId;
    if (r.value) boundary = 'recommend-boundary';
  }
  let deferred = false;
  let deferReason: string | null = null;
  if (input.trigger === 'manual') deferReason = 'MANUAL_NEVER_DEFERRED';
  else if (input.certifiedSafeTrigger !== true) deferReason = 'NO_CERTIFIED_SIGNAL';
  else {
    const key = recordKey(ws.workspaceId, input.episodeId);
    deferred = await ws.hook.transact((tx) => {
      if (tx.get<number>('compaction-deferrals', key) !== undefined) return false;
      tx.put('compaction-deferrals', key, nowMs);
      return true;
    });
    deferReason = deferred ? 'DEFERRED_ONCE' : 'ALREADY_DEFERRED_THIS_EPISODE';
  }
  return {
    workingBudget: budget,
    usedFraction: used,
    boundary,
    nativeAllowed: true,
    deferred,
    deferReason,
    capsuleId: capsule?.id ?? null,
    capsuleFresh,
    source,
    decisionId,
  };
}

/** Task boundary: refresh the capsule so the next compaction finds it current. */
export async function onTaskBoundary(ws: WorkspaceServices, input: AssembleInput): Promise<CapsuleV2> {
  return writeCapsule(ws, input);
}
