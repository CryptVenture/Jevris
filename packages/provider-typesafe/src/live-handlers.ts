/**
 * The two live advisers as trigger handlers (owner decision 2026-10-01, Jev as an active decision
 * aid): repeated-failure advice on the `repeated-failure` trigger and new-task advice on `new-task`.
 *
 * Neither handler ever makes a hook wait for Jev.
 * - Repeated failure: when the rules settle the advice (or a gate keeps Jev out), the proposal is an
 *   `explain` line returned at once. When Jev would be asked, the handler returns nothing, runs the
 *   question after the hook has answered and queues the finished line for the session's next event.
 * - New task: always detached (it reads the person's words, so only with egress approved); the line
 *   is queued for the next event. With egress denied nothing is asked and nothing is recorded.
 *
 * The detached run does not use the hook's signal or deadline (the hook has gone by then); it owns
 * its own bounded deadline and abandons the request at it. It stops if the kill switch is stopped
 * by then. Advice is queued only where the mode shows advice; in observe it is recorded and not shown.
 */
import { modeAllows, type Mode } from '@jevris/contracts';
import { UNKNOWN_SESSION_ID, type DecisionEngine } from '@jevris/core';
import type { HookProposal, TriggerHandler, TriggerHandlerInput } from './sidecar-subscribers.js';
import { DEFAULT_MAX_REPAIR_ATTEMPTS, adviseRepeatedFailure, failureAskGate, failureContextOf, parseFailureFeatures, planFailureAdvice } from './failure-advice.js';
import { adviseNewTask, newTaskAskGate } from './new-task-advice.js';
import { PENDING_ADVICE, type PendingAdviceStore } from './pending-advice.js';

export interface LiveHandlerOptions {
  /** Where finished detached advice waits for the next event (default: the shared store). */
  readonly store?: PendingAdviceStore;
  /** Receives each detached run (tests await it); default: detached and forgotten. */
  readonly background?: (work: Promise<unknown>) => void;
  /** How long a detached run waits for Jev before it abandons the request, in ms (default 1500). */
  readonly deadlineMs?: number;
  /** How long past the deadline the engine lets a request run to warm the cache (default 1000). */
  readonly lateGraceMs?: number;
  readonly now?: () => number;
}

const DETACHED_DEADLINE_MS = 1_500;
/** Time kept back from the hook's remaining time for the rest of its answer when the record is waited for, in ms. */
const RECORD_MARGIN_MS = 150;
/** The longest a hook waits for the advisory record, in ms: a journal write takes a few ms, so a longer wait is a stalled disk. */
const RECORD_WAIT_MAX_MS = 250;
const MAX_TEXT = 4000;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(input: TriggerHandlerInput): Record<string, unknown> {
  return plain(input.ctx.body) ? input.ctx.body : {};
}

/** The repair-attempt bound the sidecar adds to the body from the effective config; the default when absent. */
function repairBound(body: Record<string, unknown>): number {
  const repair = body['repair'];
  const raw = plain(repair) ? repair['maxAttempts'] : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : DEFAULT_MAX_REPAIR_ATTEMPTS;
}

/** Whether the harness shows an explain on this event (the launcher's `showsExplain`); absent reads as yes. */
function showsHere(input: TriggerHandlerInput): boolean {
  return bodyOf(input)['showsExplain'] !== false;
}

function assistOf(input: TriggerHandlerInput): 'off' | 'classify' {
  return input.ctx.jevAssist === 'off' ? 'off' : 'classify';
}

function modeOf(input: TriggerHandlerInput): Mode {
  return input.ctx.mode ?? 'bounded-auto';
}

function engineLike(input: TriggerHandlerInput): DecisionEngine | null {
  return input.engine;
}

/** A live read of the kill switch for a run that outlives its request; a read that fails counts as stopped. */
async function stoppedNow(input: TriggerHandlerInput): Promise<boolean> {
  const read = input.ctx.killSwitchNow;
  if (read === undefined) return input.ctx.killSwitchStopped === true;
  try {
    return (await read()) === true;
  } catch {
    return true;
  }
}

/** Repeated-failure advice (C05, C29): see `failure-advice.ts`. */
export function createRepeatedFailureHandler(options: LiveHandlerOptions = {}): TriggerHandler {
  const store = options.store ?? PENDING_ADVICE;
  const detach = options.background ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
  const deadlineMs = options.deadlineMs ?? DETACHED_DEADLINE_MS;
  return async (input: TriggerHandlerInput): Promise<HookProposal | null> => {
    const body = bodyOf(input);
    const features = parseFailureFeatures(body['failure']);
    // Without the adapter's content-free features (or the filter's counts) there is nothing to advise on.
    if (features === null || input.failure === undefined) return null;
    // An event with no usable session id shares one bucket with every other such event of the workspace, so
    // its repeat count is not one session's and a line for it could show in another: nothing is advised.
    if (input.envelope.sessionId === UNKNOWN_SESSION_ID) {
      input.ctx.trace({ event: 'repeated-failure-advice', reasonCode: 'REPEATED_FAILURE_NO_SESSION' });
      return null;
    }
    const mode = modeOf(input);
    const engine = engineLike(input);
    const context = failureContextOf(features, input.failure, repairBound(body));
    const ids = { workspaceId: input.envelope.workspaceId, sessionId: input.envelope.sessionId, ...(input.envelope.taskId === undefined ? {} : { taskId: input.envelope.taskId }) };
    const common = { mode, assist: assistOf(input), killSwitchStopped: input.ctx.killSwitchStopped === true, deadlineMs, ids, ...(options.now === undefined ? {} : { now: options.now }), ...(options.lateGraceMs === undefined ? {} : { lateGraceMs: options.lateGraceMs }) };
    const plan = planFailureAdvice(context);
    const asks = (plan.askSame || plan.askNext) && failureAskGate({ ...common, engine }) === null;
    const show = modeAllows(mode, 'show-advice');
    if (!asks) {
      // Nothing to wait for: the rules (or the gate's fallback) answer at once. Recording the advice is
      // waited for only briefly, and never past the time the hook has left less a margin for the rest of its answer.
      const advice = await adviseRepeatedFailure(engine, context, {
        ...common,
        recordWaitMs: Math.max(0, Math.min(RECORD_WAIT_MAX_MS, input.ctx.deadline.remainingMs() - RECORD_MARGIN_MS)),
        note: (reasonCode) => input.ctx.trace({ event: 'repeated-failure-advice', reasonCode }),
      });
      input.ctx.trace({ event: 'repeated-failure-advice', reasonCode: advice.reasonCode, ...(advice.decisionId === null ? {} : { decisionId: advice.decisionId }) });
      if (advice.text === null) return null;
      if (!showsHere(input)) {
        // The harness shows nothing on this event (a Kilo or OpenCode tool event, an Antigravity PostToolUse):
        // the line waits for the next event that can show it, as a detached line does.
        if (show) store.put(ids.workspaceId, ids.sessionId, { kind: 'repeated-failure', text: advice.text, decisionId: advice.decisionId, reasonCode: advice.reasonCode });
        return null;
      }
      // The line is also kept waiting, and shown now only if this answer is used: its commit takes the
      // waiting line, so an answer that is dropped (the slice ended, a queued run, a stronger outcome)
      // leaves it for the session's next event instead of losing it.
      const waiting = show && store.put(ids.workspaceId, ids.sessionId, { kind: 'repeated-failure', text: advice.text, decisionId: advice.decisionId, reasonCode: advice.reasonCode }) ? store.find(ids.workspaceId, ids.sessionId, 'repeated-failure') : null;
      return {
        hookOutcome: { kind: 'explain', text: advice.text },
        reasonCode: advice.reasonCode,
        ...(advice.decisionId === null ? {} : { decisionId: advice.decisionId }),
        commit: () => (waiting === null ? true : store.consume(ids.workspaceId, ids.sessionId, waiting)),
      };
    }
    // Jev would be asked: the hook answers now with nothing, and the line waits for the next event.
    detach(
      (async () => {
        if (await stoppedNow(input)) {
          input.ctx.trace({ event: 'repeated-failure-advice', reasonCode: 'REPEATED_FAILURE_KILL_SWITCH' });
          return;
        }
        const advice = await adviseRepeatedFailure(engine, context, common);
        input.ctx.trace({ event: 'repeated-failure-advice', reasonCode: advice.reasonCode, ...(advice.decisionId === null ? {} : { decisionId: advice.decisionId }) });
        if (show && advice.text !== null) store.put(ids.workspaceId, ids.sessionId, { kind: 'repeated-failure', text: advice.text, decisionId: advice.decisionId, reasonCode: advice.reasonCode });
      })(),
    );
    return null;
  };
}

/** New-task advice (C01, C02): see `new-task-advice.ts`. */
export function createNewTaskHandler(options: LiveHandlerOptions = {}): TriggerHandler {
  const store = options.store ?? PENDING_ADVICE;
  const detach = options.background ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
  const deadlineMs = options.deadlineMs ?? DETACHED_DEADLINE_MS;
  return async (input: TriggerHandlerInput): Promise<HookProposal | null> => {
    const task = bodyOf(input)['task'];
    // A caller that brings its own question set (workflow templates or explicit unknowns) is served by the
    // older new-task handler (`newTaskIntent`), which asks about exactly those; this adviser reads the prompt alone.
    if (plain(task) && ((Array.isArray(task['templates']) && task['templates'].length > 0) || (Array.isArray(task['unknowns']) && task['unknowns'].length > 0))) return null;
    const raw = plain(task) ? task['objective'] : undefined;
    const objective = typeof raw === 'string' && raw.trim().length > 0 ? raw.slice(0, MAX_TEXT) : null;
    if (objective === null) return null;
    // No usable session id: the line could not be queued for a session, so the request is not read.
    if (input.envelope.sessionId === UNKNOWN_SESSION_ID) {
      input.ctx.trace({ event: 'new-task-advice', reasonCode: 'NEW_TASK_NO_SESSION' });
      return null;
    }
    const mode = modeOf(input);
    const engine = engineLike(input);
    const common = {
      mode,
      assist: assistOf(input),
      killSwitchStopped: input.ctx.killSwitchStopped === true,
      deadlineMs,
      evidenceRevision: input.revision ?? input.envelope.expectedRevision,
      ids: { workspaceId: input.envelope.workspaceId, sessionId: input.envelope.sessionId, ...(input.envelope.taskId === undefined ? {} : { taskId: input.envelope.taskId }) },
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.lateGraceMs === undefined ? {} : { lateGraceMs: options.lateGraceMs }),
    };
    const gate = newTaskAskGate({ ...common, engine, objective });
    if (gate !== null) {
      // Egress denied is the default: nothing is asked, nothing is recorded, and the hook is as it was.
      input.ctx.trace({ event: 'new-task-advice', reasonCode: gate });
      return null;
    }
    const show = modeAllows(mode, 'show-advice');
    detach(
      (async () => {
        if (await stoppedNow(input)) {
          input.ctx.trace({ event: 'new-task-advice', reasonCode: 'NEW_TASK_KILL_SWITCH' });
          return;
        }
        const advice = await adviseNewTask(engine, objective, common);
        input.ctx.trace({ event: 'new-task-advice', reasonCode: advice.reasonCode, ...(advice.decisionId === null ? {} : { decisionId: advice.decisionId }) });
        if (show && advice.text !== null) store.put(common.ids.workspaceId, common.ids.sessionId, { kind: 'new-task', text: advice.text, decisionId: advice.decisionId, reasonCode: advice.reasonCode });
      })(),
    );
    return null;
  };
}

/** The default handlers, on the shared pending-advice store. */
export const repeatedFailureAdvice: TriggerHandler = createRepeatedFailureHandler();
export const newTaskAdvice: TriggerHandler = createNewTaskHandler();
