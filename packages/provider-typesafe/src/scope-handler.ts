/**
 * Scope-change advice at a diff boundary (INT-05, C06). A session with an approved task scope (the
 * sidecar merges the leased or linked task's write scopes into the event body as `scope.approvedScope`)
 * reaches a meaningful diff boundary after a few writes. Then:
 *
 * - a changed path outside the approved paths pauses by RULE, at once, with no call: one explain line
 *   names only the out-of-scope part;
 * - a requested effect that no person approved is a Jev question (C06, `detectScopeChange`). The effects
 *   are the classes the permission triage recognised on the session's proposed tool calls since the last
 *   boundary (`EFFECT_LEDGER`: codes only, each with one fixed phrase), and any effect a caller names. A
 *   class goes into the request as a fact (a code), so it is judged with source egress denied too; a
 *   caller's free-text effect is evidence and needs egress approved. Jev is never waited for: the
 *   question runs after the hook has answered and the finished line waits for the session's next event.
 *
 * Advice only: it pauses nothing itself, approves nothing and changes no permission; an approval counts
 * only from a trusted channel, never from repository text. Every miss (kill switch, mode, `jev.assist`
 * off, no provider, a deadline, a refusal, a budget stop) says nothing about the effects, with a reason code.
 * A run that asked is one advisory decision (`scope-change`) that `jevris explain` renders.
 */
import { EFFECT_LEDGER, UNKNOWN_SESSION_ID, detectScopeChange, type DecisionEngine, type IntentContext, type ScopeResult } from '@jevris/core';
import { modeAllows, type Mode } from '@jevris/contracts';
import type { HookProposal, TriggerHandler, TriggerHandlerInput } from './sidecar-subscribers.js';
import { assistOf, bodyOf, engineLike, modeOf, plain, stoppedNow, type LiveHandlerOptions } from './live-handlers.js';
import { PENDING_ADVICE } from './pending-advice.js';
import { recordAdviceRun } from './advice-record.js';
import { clippedText, clippedTexts, plainList } from './intent-body.js';
import { cacheHitOf, codeOf, raceDeadlineOf } from './live-advice-util.js';

export const SCOPE_CHANGE_SPEC_ID = 'scope-change';
/** Below this many ms left a call cannot finish: Jev is not asked. */
export const SCOPE_MIN_DEADLINE_MS = 150;
const DETACHED_DEADLINE_MS = 1_500;
const DEFAULT_LATE_GRACE_MS = 1_000;

export interface ScopeGateInput {
  readonly killSwitchStopped?: boolean;
  readonly mode?: Mode;
  readonly assist: 'off' | 'classify';
  readonly engine: Pick<DecisionEngine, 'providerConfigured'> | null;
  readonly deadlineMs: number;
}

/** The reason Jev is not asked about the effects, or null when it may be. */
export function scopeAskGate(g: ScopeGateInput): string | null {
  if (g.killSwitchStopped === true) return 'SCOPE_KILL_SWITCH';
  if (!modeAllows(g.mode ?? 'observe', 'record')) return 'SCOPE_MODE_OFF';
  if (g.assist === 'off') return 'SCOPE_ASSIST_OFF';
  if (g.engine === null || g.engine.providerConfigured === false) return 'SCOPE_NO_PROVIDER';
  if (!Number.isFinite(g.deadlineMs) || g.deadlineMs < SCOPE_MIN_DEADLINE_MS) return 'SCOPE_NO_TIME';
  return null;
}

/** The reason codes of one scope-change run, content-free. */
export function scopeReasonCodes(input: { readonly classes: readonly string[]; readonly effects: number; readonly paused: number; readonly assessed: number; readonly cacheHit: boolean | null; readonly reasonCode: string }): string[] {
  return [
    input.assessed > 0 ? 'SCOPE_SOURCE_JEV' : 'SCOPE_SOURCE_RULES',
    `SCOPE_EFFECTS_${String(input.effects)}`,
    `SCOPE_ASSESSED_${String(input.assessed)}`,
    `SCOPE_PAUSED_${String(input.paused)}`,
    ...input.classes.map((code) => `SCOPE_CLASS_${codeOf(code)}`),
    input.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS',
    input.reasonCode,
  ];
}

function approvedScopeOf(scope: Record<string, unknown>): { readonly paths: string[]; readonly effects: string[] } | null {
  const approved = scope['approvedScope'];
  if (!plain(approved)) return null;
  return { paths: clippedTexts(approved['paths'], 64, 500), effects: clippedTexts(approved['effects'], 64, 300) };
}

function pausedLine(result: ScopeResult, only: (p: ScopeResult['paused'][number]) => boolean): string | null {
  const lines = result.paused.filter(only).slice(0, 5).map((p) => p.explanation);
  return lines.length === 0 ? null : `Jevris: pause only this out-of-scope part; the rest can continue. ${lines.join(' ')}`;
}

/** Scope-change advice (C06): see the module comment. */
export function createScopeChangeHandler(options: LiveHandlerOptions = {}): TriggerHandler {
  const store = options.store ?? PENDING_ADVICE;
  const detach = options.background ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
  const deadlineMs = options.deadlineMs ?? DETACHED_DEADLINE_MS;
  const grace = options.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  return async (input: TriggerHandlerInput): Promise<HookProposal | null> => {
    const scope = bodyOf(input)['scope'];
    if (!plain(scope)) return null;
    const approvedScope = approvedScopeOf(scope);
    if (approvedScope === null) return null;
    const diff = plainList(scope['diff'], 256).flatMap((d) => {
      const path = clippedText(d['path'], 1000);
      return path === null ? [] : [{ path }];
    });
    const requestedEffects = clippedTexts(scope['requestedEffects'], 32, 300);
    const approvals = plainList(scope['approvals'], 32).flatMap((a) => {
      const effect = clippedText(a['effect'], 300);
      const channel = clippedText(a['channel'], 64);
      return effect === null || channel === null ? [] : [{ effect, channel }];
    });
    const sessionId = input.envelope.sessionId;
    const hasSession = sessionId !== UNKNOWN_SESSION_ID;
    // The classes asked for since the last boundary are taken now, whether or not they are judged: they are about this boundary only.
    const classes = hasSession ? EFFECT_LEDGER.take(input.envelope.workspaceId, sessionId) : [];

    // 1. The rules, at once and with no call (no engine): a changed path outside the approved paths pauses. What the rules cannot
    // settle, an effect nobody approved, is what only Jev can judge.
    const rules = await detectScopeChange(null, { approvedScope, diff, requestedEffects, effectClasses: classes, approvals }, scopeContext(input, deadlineMs, grace));
    const pathLine = pausedLine(rules, (p) => p.kind === 'path');
    const immediate: HookProposal | null =
      pathLine === null ? null : { hookOutcome: { kind: 'explain', text: pathLine }, reasonCode: 'SCOPE_CHANGE' };

    // 2. The requested effects nobody approved, which only Jev can judge: after the hook has answered.
    if (!rules.paused.some((p) => p.kind === 'effect')) return immediate;
    const mode = modeOf(input);
    const engine = engineLike(input);
    const gate = scopeAskGate({ mode, assist: assistOf(input), killSwitchStopped: input.ctx.killSwitchStopped === true, engine, deadlineMs });
    if (gate !== null) {
      input.ctx.trace({ event: 'scope-change-advice', reasonCode: gate });
      return immediate;
    }
    const show = modeAllows(mode, 'show-advice');
    detach(
      (async () => {
        if (await stoppedNow(input)) {
          input.ctx.trace({ event: 'scope-change-advice', reasonCode: 'SCOPE_KILL_SWITCH' });
          return;
        }
        const started = performance.now();
        const ctx = scopeContext(input, deadlineMs, grace);
        const raced = await raceDeadlineOf(detectScopeChange(engine, { approvedScope, diff: [], requestedEffects, effectClasses: classes, approvals }, ctx), deadlineMs);
        const result = typeof raced === 'object' ? raced : null;
        const judged = result === null ? [] : result.paused.filter((p) => p.kind === 'effect');
        const assessed = result === null ? 0 : result.assessedCount;
        const cacheHit = result?.decisionId == null || engine === null ? null : await cacheHitOf(engine, result.decisionId);
        const reasonCode = raced === 'late' ? 'SCOPE_DEADLINE' : raced === 'failed' ? 'SCOPE_ERROR' : assessed === 0 ? 'SCOPE_NOT_ASSESSED' : judged.some((p) => p.assessed) ? 'SCOPE_JEV' : 'SCOPE_WITHIN';
        const text = result === null ? null : pausedLine(result, (p) => p.kind === 'effect' && p.assessed);
        const decisionId = await recordAdviceRun(engine, {
          specId: SCOPE_CHANGE_SPEC_ID,
          workspaceId: input.envelope.workspaceId,
          evidenceRevision: input.revision ?? input.envelope.expectedRevision,
          sessionId: hasSession ? sessionId : null,
          ...(input.envelope.taskId === undefined ? {} : { taskId: input.envelope.taskId }),
          evidenceIds: ['effect-classes', 'approved-scope-counts'],
          reasonCodes: scopeReasonCodes({ classes, effects: classes.length + requestedEffects.length, paused: judged.filter((p) => p.assessed).length, assessed, cacheHit, reasonCode }),
          durationMs: performance.now() - started,
        });
        input.ctx.trace({ event: 'scope-change-advice', reasonCode, ...(decisionId === null ? {} : { decisionId }) });
        if (show && hasSession && text !== null) store.put(input.envelope.workspaceId, sessionId, { kind: 'scope-change', text, decisionId, reasonCode });
      })(),
    );
    return immediate;
  };
}

function scopeContext(input: TriggerHandlerInput, deadlineMs: number, graceMs: number): IntentContext {
  return {
    workspaceId: input.envelope.workspaceId,
    evidenceRevision: input.revision ?? input.envelope.expectedRevision,
    sessionId: input.envelope.sessionId,
    ...(input.envelope.taskId === undefined ? {} : { taskId: input.envelope.taskId }),
    deadlineMs: Math.max(1, Math.floor(deadlineMs + graceMs)),
    ...(input.currentRevision === undefined ? {} : { currentRevision: input.currentRevision }),
    ...(input.stillUseful === undefined ? {} : { stillUseful: input.stillUseful }),
  };
}

/** The default handler, on the shared pending-advice store. */
export const scopeChangeAdvice: TriggerHandler = createScopeChangeHandler();
