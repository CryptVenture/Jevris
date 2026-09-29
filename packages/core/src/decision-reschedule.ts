/**
 * Late-decision rescheduler (DEC-12, US31, §7.1).
 *
 * A decision that went stale because the evidence revision moved is not re-applied. The
 * rescheduler issues a fresh decision on the new revision only when it is still useful and
 * affordable, once per stale decision:
 *
 * - sources: ledger records marked `freshDecision: 'scheduled'`, and journal decisions whose
 *   outcome is `stale` with `STALE_REVISION`;
 * - "still useful": the caller's predicate (for example the task is still open);
 * - "affordable": the budget has room for the estimate and holds no unreconciled usage for the
 *   same decision;
 * - the fresh request is rebuilt by the caller from current evidence (the journal never stores
 *   content), so a stale packet is never replayed.
 */
import type { DecisionFileRecord } from '@jevris/contracts';
import type { DecisionBudget } from './decision-budget.js';
import type { DecideOptions, DecideOutcome, DecideRequest, DecisionEngine } from './decision-engine.js';

export interface StaleDecision {
  readonly decisionId: string;
  readonly evidenceRevision: string;
  readonly specId: string;
  readonly workspaceId: string | null;
  readonly taskId: string | null;
}

export type RescheduleResult =
  | { readonly decisionId: string; readonly rescheduled: true; readonly outcome: DecideOutcome }
  | { readonly decisionId: string; readonly rescheduled: false; readonly reasonCode: 'SAME_REVISION' | 'NOT_USEFUL' | 'NOT_AFFORDABLE' | 'NO_REQUEST' | 'ALREADY_RESCHEDULED' };

export interface RescheduleInput {
  readonly engine: DecisionEngine;
  readonly stale: readonly StaleDecision[];
  readonly currentRevision: (stale: StaleDecision) => string | null;
  readonly stillUseful: (stale: StaleDecision) => boolean;
  /** Builds a fresh request from current evidence on the new revision, or null. */
  readonly rebuild: (stale: StaleDecision, revision: string) => DecideRequest | null;
  /** Estimated cost of the fresh decision, micro-USD. */
  readonly estimateMicroUsd: number;
  readonly options?: DecideOptions;
}

/** Stale decisions from the engine's journal (outcome stale, reason STALE_REVISION). */
export async function staleFromJournal(engine: DecisionEngine, limit = 200): Promise<readonly StaleDecision[]> {
  const out: StaleDecision[] = [];
  const ids = await engine.journal.list();
  for (const id of ids.slice(-limit * 4)) {
    const entry = await engine.journal.read(id);
    const record = entry?.record;
    if (entry === null || record === null || record === undefined) continue;
    if (entry.state !== 'stale' || !record.reasonCodes.includes('STALE_REVISION')) continue;
    out.push({ decisionId: id, evidenceRevision: record.evidenceRevision, specId: record.specId, workspaceId: record.workspaceId ?? null, taskId: record.taskId ?? null });
    if (out.length >= limit) break;
  }
  return out;
}

/** Ledger records the legacy ledger marked for a fresh decision. */
export function staleFromLedger(records: readonly DecisionFileRecord[], specId = 'legacy-choice'): readonly StaleDecision[] {
  return records
    .filter((record) => record.freshDecision === 'scheduled')
    .map((record) => ({ decisionId: record.decisionId, evidenceRevision: record.evidenceRevision, specId, workspaceId: null, taskId: null }));
}

async function affordable(budget: DecisionBudget | null, amount: number, workspaceId: string | null): Promise<boolean> {
  if (budget === null) return true;
  const snapshot = await budget.snapshot(workspaceId ?? undefined);
  if (snapshot === null || snapshot.availableMicroUsd < amount) return false;
  // A workspace with its own cap must have room under it too (owner decision 2026-09-29).
  return snapshot.workspace === undefined || snapshot.workspace === null || snapshot.workspace.availableMicroUsd >= amount;
}

export class DecisionRescheduler {
  readonly #done = new Set<string>();

  async run(input: RescheduleInput): Promise<readonly RescheduleResult[]> {
    const results: RescheduleResult[] = [];
    for (const stale of input.stale) {
      if (this.#done.has(stale.decisionId)) {
        results.push({ decisionId: stale.decisionId, rescheduled: false, reasonCode: 'ALREADY_RESCHEDULED' });
        continue;
      }
      const revision = input.currentRevision(stale);
      if (revision === null || revision === stale.evidenceRevision) {
        results.push({ decisionId: stale.decisionId, rescheduled: false, reasonCode: 'SAME_REVISION' });
        continue;
      }
      if (!input.stillUseful(stale)) {
        this.#done.add(stale.decisionId);
        results.push({ decisionId: stale.decisionId, rescheduled: false, reasonCode: 'NOT_USEFUL' });
        continue;
      }
      if (!(await affordable(input.engine.budget, input.estimateMicroUsd, stale.workspaceId))) {
        results.push({ decisionId: stale.decisionId, rescheduled: false, reasonCode: 'NOT_AFFORDABLE' });
        continue;
      }
      const request = input.rebuild(stale, revision);
      if (request === null || request.evidenceRevision !== revision) {
        results.push({ decisionId: stale.decisionId, rescheduled: false, reasonCode: 'NO_REQUEST' });
        continue;
      }
      this.#done.add(stale.decisionId);
      const outcome = await input.engine.decide(request, input.options);
      results.push({ decisionId: stale.decisionId, rescheduled: true, outcome });
    }
    return results;
  }
}
