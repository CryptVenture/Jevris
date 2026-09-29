/**
 * Advice adherence (learning-coverage audit P5, owner decision DOMAINS 7922ee3), C's side of B's
 * port (`ctx.adviceAdherence`, 0d977da): delivered model advice is opened, and advice a session did
 * not follow twice (overridden, or left unchanged) is not repeated in that session. Per session
 * only: a new session starts at 0. It never applies to a safety notice and never feeds the routing
 * posterior (SPEC §18.5).
 */
import type { SidecarOpContext } from '@jevris/contracts';

/** Advice not followed this often in one session is not repeated there (P5; owner decision 7922ee3). */
export const ADVICE_REPEAT_LIMIT = 2;
const ADHERENCE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The slice a session-level advice is kept under when the request names none. */
const SESSION_SLICE = 'session';

/** True when the same advice (session, kind, slice, model) was overridden or left unchanged twice or more. Never throws. */
export function adviceIgnored(ctx: Pick<SidecarOpContext, 'adviceAdherence'>, adviceKind: 'main-route' | 'model-change', sessionId: string | null | undefined, slice: string | null | undefined, advisedModel: string): boolean {
  if (ctx.adviceAdherence === undefined || typeof sessionId !== 'string' || !ADHERENCE_KEY.test(sessionId)) return false;
  const sliceKey = typeof slice === 'string' && ADHERENCE_KEY.test(slice) ? slice : SESSION_SLICE;
  try {
    return ctx.adviceAdherence.overrides({ sessionId, adviceKind, slice: sliceKey, advisedModel }) >= ADVICE_REPEAT_LIMIT;
  } catch {
    return false;
  }
}

/** Opens delivered advice for adherence; nothing when the session is unknown or the sidecar has no store. Never throws. */
export function openAdvice(
  ctx: Pick<SidecarOpContext, 'adviceAdherence'>,
  input: { readonly decisionId: string; readonly adviceKind: 'main-route' | 'model-change'; readonly sessionId: string | null | undefined; readonly slice: string | null | undefined; readonly advisedModel: string; readonly currentModel: string | null; readonly atMs: number },
): boolean {
  if (ctx.adviceAdherence === undefined || typeof input.sessionId !== 'string' || !ADHERENCE_KEY.test(input.sessionId)) return false;
  try {
    return ctx.adviceAdherence.open({
      decisionId: input.decisionId,
      sessionId: input.sessionId,
      adviceKind: input.adviceKind,
      slice: typeof input.slice === 'string' && ADHERENCE_KEY.test(input.slice) ? input.slice : SESSION_SLICE,
      advisedModel: input.advisedModel,
      currentModel: input.currentModel,
      atMs: input.atMs,
    });
  } catch {
    return false;
  }
}

