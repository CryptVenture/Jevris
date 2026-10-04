/**
 * Worker-readiness advice (owner decision 2026-10-01, Jev as an active decision aid). When an owned
 * worker is about to be launched, Jev is asked one bounded question from the task's content-free
 * features: is this a bounded task a worker model can finish and pass its checks without escalating
 * (`WORKER_READINESS_QUESTIONS`, the decision a routing calibration is released for).
 *
 * The answer is ADVICE, recorded with the launch and shown by `jevris explain`. It never gates the
 * launch: the launch stays with the rules, the budget and the permissions, and Jev's answer never
 * blocks one, starts one, picks a model or changes a reservation. A launch proceeds whatever Jev says,
 * whenever Jev cannot be asked, and whether or not this module is called.
 *
 * - Features only: the file count, the kind of each (source, test, docs, config, CI), protected path
 *   classes, the check count and kinds, a verb class from a fixed vocabulary and a size bucket. Path
 *   names, check ids and the task title never leave as text, with egress approved or not.
 * - Rules answer first when they are sure: a task that names no file and no check is open-ended, and a
 *   task that touches a protected path class is not for an automatic worker. Neither needs a model.
 * - Jev is asked otherwise, and its answer is used at a certainty of 0.6 or more (a Noul of 0.4 or less,
 *   or 0.6 or more). A kill switch, a mode below observe, `jev.assist: off`, no provider, no time, a
 *   budget stop, an open circuit, a deadline or an unsure answer is a miss: no readiness is stated, with
 *   the reason code.
 */
import type { DecisionEngine } from './decision-engine.js';
import { modeAllows, type Mode } from '@jevris/contracts';
import { askBoundedDecision, noulAnswer, type IntentContext } from './intent-decisions.js';
import { sliceFeatures, type SliceFeatures, type SliceTaskHints } from './slice-classifier.js';
import { WORKER_READINESS_QUESTIONS, WORKER_READINESS_SPEC } from './route-worker.js';

/** The decision spec id of the advisory record (the engine's own record of the Jev call shares it). */
export const WORKER_READINESS_ADVICE_SPEC_ID = WORKER_READINESS_SPEC.id;
export const WORKER_READINESS_MIN_CERTAINTY = 0.6;
/** Below this many ms left, Jev is not asked. */
export const WORKER_READINESS_MIN_DEADLINE_MS = 150;

export type WorkerReadinessSource = 'rules' | 'jev' | 'none';
export type WorkerReadinessState = 'ready' | 'not-ready' | 'unsure' | null;

export interface WorkerReadiness {
  readonly source: WorkerReadinessSource;
  /** What the advice says; null when nothing was stated (a miss). */
  readonly state: WorkerReadinessState;
  /** Jev's probability that the task is bounded for a worker, when it answered. */
  readonly probability: number | null;
  /** A `WORKER_READINESS_*` code, content-free. */
  readonly reasonCode: string;
  readonly asked: boolean;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** The advisory decision of this run; null when none was recorded. */
  readonly decisionId: string | null;
  /** The engine's own record of the Jev call, when one was made. */
  readonly jevDecisionId: string | null;
  /** The feature names the advice read (never values that are text). */
  readonly evidenceIds: readonly string[];
}

export interface WorkerReadinessOptions {
  readonly mode?: Mode;
  readonly assist: 'off' | 'classify';
  readonly killSwitchStopped?: boolean;
  /** How long to wait for Jev, in ms; the request is abandoned at it. */
  readonly deadlineMs: number;
  /** Record the advice as an advisory decision (default true). */
  readonly record?: boolean;
  readonly now?: () => number;
  /** Extra reason codes the caller joins to the record (for example the launch's own). */
  readonly extraCodes?: readonly string[];
}

/** The facts of the request: counts and category codes. Nothing here is text of the task. */
export function workerReadinessFacts(f: SliceFeatures): Record<string, string | number | boolean> {
  return {
    files: f.files,
    checks: f.checks,
    protectedClasses: f.protectedClasses.length === 0 ? 'none' : f.protectedClasses.join(','),
    verb: f.verb ?? 'none',
    titleSize: f.titleSize,
    roleSource: f.roleSource,
    roleTest: f.roleTest,
    roleDocs: f.roleDocs,
    roleConfig: f.roleConfig,
    roleCi: f.roleCi,
    checkKinds: f.checkKinds.length === 0 ? 'none' : f.checkKinds.join(','),
  };
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function codeOf(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** The reason codes of the record; every one reads back through the explain lines. */
export function workerReadinessReasonCodes(r: Omit<WorkerReadiness, 'decisionId' | 'jevDecisionId' | 'latencyMs'>, f: SliceFeatures, extra: readonly string[] = []): string[] {
  const codes = [
    `READY_SOURCE_${r.source.toUpperCase()}`,
    `READY_STATE_${r.state === null ? 'NONE' : codeOf(r.state)}`,
    ...(r.probability === null ? [] : [`READY_P_${Math.round(r.probability * 100)}`]),
    `READY_FILES_${Math.min(f.files, 999)}`,
    `READY_CHECKS_${Math.min(f.checks, 999)}`,
    `READY_PROTECTED_${f.protectedClasses.length}`,
    `READY_VERB_${f.verb === null ? 'NONE' : codeOf(f.verb)}`,
    ...(r.asked ? [r.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    r.reasonCode,
    ...extra,
  ];
  return codes.filter((c) => CODE.test(c));
}

/** The reason Jev is not asked, or null when it may be. */
export function workerReadinessGate(g: { readonly killSwitchStopped?: boolean; readonly mode?: Mode; readonly assist: 'off' | 'classify'; readonly engine: Pick<DecisionEngine, 'providerConfigured'> | null; readonly deadlineMs: number }): string | null {
  if (g.killSwitchStopped === true) return 'WORKER_READINESS_KILL_SWITCH';
  if (!modeAllows(g.mode ?? 'observe', 'record')) return 'WORKER_READINESS_MODE_OFF';
  if (g.assist === 'off') return 'WORKER_READINESS_ASSIST_OFF';
  if (g.engine === null || g.engine.providerConfigured === false) return 'WORKER_READINESS_NO_PROVIDER';
  if (!Number.isFinite(g.deadlineMs) || g.deadlineMs < WORKER_READINESS_MIN_DEADLINE_MS) return 'WORKER_READINESS_NO_TIME';
  return null;
}

async function cacheHitOf(engine: DecisionEngine, decisionId: string): Promise<boolean | null> {
  try {
    const record = await engine.lookup(decisionId);
    return record === null ? null : record.reasonCodes.includes('CACHE_HIT');
  } catch {
    return null;
  }
}

const EVIDENCE_IDS = ['feature-files', 'feature-checks', 'feature-protected', 'feature-verb', 'feature-roles'] as const;

/**
 * Advice on one owned-worker launch. Never throws and never waits past `deadlineMs`; every miss is
 * `state: null` with its reason. A run that stated something or asked Jev is recorded as one advisory
 * decision (`worker-readiness`).
 */
export async function adviseWorkerReadiness(engine: DecisionEngine | null, hints: SliceTaskHints, ctx: IntentContext, options: WorkerReadinessOptions): Promise<WorkerReadiness> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const features = sliceFeatures(hints);
  const base = { source: 'none' as WorkerReadinessSource, state: null as WorkerReadinessState, probability: null as number | null, asked: false, cacheHit: null as boolean | null, evidenceIds: EVIDENCE_IDS as readonly string[] };
  const finish = async (r: Omit<WorkerReadiness, 'decisionId' | 'jevDecisionId' | 'latencyMs'> & { readonly jevDecisionId?: string | null }, record: boolean): Promise<WorkerReadiness> => {
    const elapsed = Math.max(0, Math.round(now() - started));
    const out: WorkerReadiness = { ...r, jevDecisionId: r.jevDecisionId ?? null, decisionId: null, latencyMs: r.asked ? elapsed : null };
    if (!record || options.record === false || engine === null || engine.recordAdvice === undefined) return out;
    try {
      const recorded = await engine.recordAdvice({
        specId: WORKER_READINESS_ADVICE_SPEC_ID,
        workspaceId: ctx.workspaceId,
        evidenceRevision: ctx.evidenceRevision,
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
        action: { kind: 'advise', templateId: WORKER_READINESS_ADVICE_SPEC_ID, evidenceIds: [...r.evidenceIds] },
        reasonCodes: workerReadinessReasonCodes(out, features, options.extraCodes),
        durationMs: elapsed,
      });
      return recorded.ok ? { ...out, decisionId: recorded.decisionId } : out;
    } catch {
      return out;
    }
  };

  // A deterministic fact needs no model.
  if (features.protectedClasses.length > 0) return finish({ ...base, source: 'rules', state: 'not-ready', reasonCode: 'WORKER_READINESS_RULES_PROTECTED' }, true);
  if (features.files === 0 && features.checks === 0) return finish({ ...base, source: 'rules', state: 'not-ready', reasonCode: 'WORKER_READINESS_RULES_OPEN_ENDED' }, true);
  const gate = workerReadinessGate({ ...options, engine, deadlineMs: options.deadlineMs });
  if (gate !== null || engine === null) return { ...base, reasonCode: gate ?? 'WORKER_READINESS_NO_PROVIDER', jevDecisionId: null, decisionId: null, latencyMs: null };

  const packet = {
    objective: 'Judge whether a proposed worker model can finish a bounded task from structured features (advice only).',
    trustedPolicy: { grantsAuthority: false },
    facts: workerReadinessFacts(features),
    evidence: [],
  };
  const grace = 1_000;
  const run = askBoundedDecision(
    engine,
    WORKER_READINESS_SPEC.id,
    WORKER_READINESS_QUESTIONS,
    packet,
    { ...ctx, deadlineMs: Math.max(1, Math.floor(options.deadlineMs + grace)) },
    false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), Math.max(1, Math.floor(options.deadlineMs)));
  });
  let raced: Awaited<typeof run> | 'late' | 'failed';
  try {
    raced = await Promise.race([run.catch(() => 'failed' as const), late]);
    if (raced === 'late') void run.catch(() => undefined);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (raced === 'late') return finish({ ...base, asked: true, reasonCode: 'WORKER_READINESS_DEADLINE' }, true);
  if (raced === 'failed') return finish({ ...base, asked: true, reasonCode: 'WORKER_READINESS_ERROR' }, true);
  if (!raced.ok) {
    // Refused on this machine before anything was sent (a budget stop, an open circuit): Jev was not asked.
    const local = /^(?:SECRET_BLOCKED|EGRESS_NOT_APPROVED|PROVIDER_NOT_CONFIGURED|QUESTION_LINT|MISSING_EVIDENCE|JOURNAL_UNAVAILABLE|KILL_SWITCH|CIRCUIT_OPEN|REQUEST_TOO_LARGE|TOO_MANY_QUESTIONS|OVER_BUDGET|BUDGET(?:_[A-Z_]+)?)$/.test(raced.reasonCode);
    return finish({ ...base, asked: !local, reasonCode: `WORKER_READINESS_JEV_${raced.reasonCode}`.slice(0, 64), jevDecisionId: raced.decisionId }, true);
  }
  const p = noulAnswer(raced.answers, 'workerReady');
  const cacheHit = await cacheHitOf(engine, raced.decisionId);
  if (p === null) return finish({ ...base, asked: true, cacheHit, reasonCode: 'WORKER_READINESS_JEV_NO_ANSWER', jevDecisionId: raced.decisionId }, true);
  const certainty = Math.max(p, 1 - p);
  const probability = Math.round(p * 100) / 100;
  if (certainty < WORKER_READINESS_MIN_CERTAINTY) return finish({ ...base, source: 'jev', state: 'unsure', probability, asked: true, cacheHit, reasonCode: 'WORKER_READINESS_JEV_UNSURE', jevDecisionId: raced.decisionId }, true);
  return finish({ ...base, source: 'jev', state: p >= 0.5 ? 'ready' : 'not-ready', probability, asked: true, cacheHit, reasonCode: 'WORKER_READINESS_JEV', jevDecisionId: raced.decisionId }, true);
}
