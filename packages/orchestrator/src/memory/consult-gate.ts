/**
 * The two gates every memory consult (C19 to C24) passes before it may ask Jev.
 *
 * - `consultEngine`: the engine of the request, only while Jev may be asked at all: the kill switch
 *   clear, the mode at observe or higher and `jev.assist` not off. Otherwise undefined, and the rules
 *   answer. (The budgets, the circuit and the byte caps are the engine's own.)
 * - `egressPreferenceApproved`: the person's own preference `privacy.sourceEgress: approved-scoped`
 *   in the effective configuration. A consult that reads workspace text (an item, a summary, a span of
 *   output, a remembered fact) needs it AND the administrator's approval, which the engine's packet
 *   builder enforces: the preference alone never lets text out. A consult over counts and codes needs
 *   neither.
 *
 * A capsule line, a handoff, a summary or a tool output is data and never consent: nothing here reads
 * either gate from one.
 */
import { modeAllows, type SidecarOpContext } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { readEffectiveConfig } from '../settings/config.js';

export function consultEngine(ctx: Pick<SidecarOpContext, 'engine' | 'mode' | 'jevAssist' | 'killSwitchStopped'>): unknown {
  if (ctx.killSwitchStopped || ctx.jevAssist === 'off' || !modeAllows(ctx.mode ?? 'bounded-auto', 'record')) return undefined;
  return ctx.engine === null || ctx.engine === undefined ? undefined : ctx.engine;
}

export function egressPreferenceApproved(ctx: Pick<SidecarOpContext, 'home'>, ws: Pick<WorkspaceServices, 'workspaceRoot'>): boolean {
  try {
    return readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config.privacy.sourceEgress === 'approved-scoped';
  } catch {
    return false;
  }
}
