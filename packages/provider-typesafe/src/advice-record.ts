/**
 * The one advisory record of a wired Jev run (owner decision 2026-10-01, Jev as an active decision aid).
 * Every place Jev advises on a hook, an op or a launch records ONE advisory decision for the run, with
 * reason codes only (no text, no path, no output), so `jevris explain` can render what was asked, who
 * answered and why a miss fell back to the rules. A run that cannot be recorded (an engine with no
 * `recordAdvice`, a journal that refuses) still advises: the record is for the audit trail, never a gate.
 */
import type { DecisionEngine } from '@jevris/core';
import { validReasonCodes } from './live-advice-util.js';

export interface AdviceRun {
  readonly specId: string;
  readonly workspaceId: string;
  /** The workspace revision the run read; a bounded id, else `advice-r0`. */
  readonly evidenceRevision?: string;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  /** Names of the features or fixed templates the run read: never text. */
  readonly evidenceIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly durationMs?: number;
}

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Records the run; the decision id, or null when it could not be recorded. Never throws. */
export async function recordAdviceRun(engine: Pick<DecisionEngine, 'recordAdvice'> | null, run: AdviceRun): Promise<string | null> {
  if (engine === null || engine.recordAdvice === undefined) return null;
  try {
    const recorded = await engine.recordAdvice({
      specId: run.specId,
      workspaceId: run.workspaceId,
      evidenceRevision: run.evidenceRevision !== undefined && REVISION.test(run.evidenceRevision) ? run.evidenceRevision : 'advice-r0',
      ...(run.taskId === undefined || run.taskId === null ? {} : { taskId: run.taskId }),
      ...(run.sessionId === undefined || run.sessionId === null ? {} : { sessionId: run.sessionId }),
      action: { kind: 'advise', templateId: run.specId, evidenceIds: [...run.evidenceIds].slice(0, 32) },
      reasonCodes: validReasonCodes(run.reasonCodes),
      ...(run.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(run.durationMs)) }),
    });
    return recorded.ok ? recorded.decisionId : null;
  } catch {
    return null;
  }
}
