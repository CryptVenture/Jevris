/**
 * The one orientation line a session gets when it starts (SessionStart on Claude Code and Codex,
 * a session's creation on Kilo Code and OpenCode, held until the harness next shows an answer).
 *
 * It says only that Jevris is on here, in which mode, that it gives advice and changes no
 * permission, and where to look. On Claude Code it adds one standing sentence on the subagent model policy. It is proposed as `context`, so it renders only where a signed
 * certification record covers the harness's `hooks.context` (the same gate as a capsule restore),
 * and only while the mode shows advice (advise, bounded-auto) and the kill switch is not stopped.
 * It carries no path, no id and no workspace text, and it is capped in bytes.
 *
 * Sent for a fresh session (`startup`, `clear`, or a harness with no source). Not sent for
 * `compact` or `resume`: those already re-send the capsule (or, on a resume, the transcript
 * still holds the line), so a second copy would only repeat it.
 */
import { modeAllows, type HarnessId, type Mode, type SidecarOpContext } from '@jevris/contracts';
import { CONTEXT_FEATURE, isCertified } from './certification.js';

/** The hard cap, in UTF-8 bytes, on the line (540 from 2026-10-08: the subagent sentence now names the stronger model for very hard work). Every mode's text is tested against it. */
export const ORIENTATION_MAX_BYTES = 540;

/**
 * The standing sentence of owner decision 2026-10-08, Claude Code only: the policy for a subagent's model. It says
 * nothing about a task, a prompt or a path, and nothing is forced.
 */
export const SUBAGENT_POLICY_SENTENCE = 'A low-risk subagent may run on a cheaper model (a very hard one on a stronger model) for that one call only; Jevris advises it and sets it where certified, and your session model is never changed. For very hard or clearly routine main-session work it may suggest /model; nothing is forced.';

/** The line for a mode: on, what it does not do, and where to look. On Claude Code it also states the subagent model policy. */
export function orientationLine(mode: Mode, harness?: string): string {
  const base = `Jevris is on here (mode: ${mode}). It gives advice and keeps local records; permissions and approvals are unchanged, and nothing it shows is approval. Ask the Jevris status skill (jevris_status) what it decided, or the guide skill for a tour.`;
  return harness === 'claude' ? `${base} ${SUBAGENT_POLICY_SENTENCE}` : base;
}

export type OrientationResult =
  | { readonly kind: 'context'; readonly text: string }
  | { readonly kind: 'observe'; readonly reasonCode: string };

const quiet = (reasonCode: string): OrientationResult => ({ kind: 'observe', reasonCode });

/** Whether this session start is one that gets the line. */
export function startsFreshSession(trigger: string | null): boolean {
  return trigger !== 'compact' && trigger !== 'resume';
}

/**
 * The orientation for one session start, or why there is none. `ctx.mode` is set by the sidecar
 * for every event; without it (a direct unit call) nothing is said.
 */
export async function orientationFor(
  ctx: SidecarOpContext,
  env: { readonly harness: string; readonly agentId: string | null },
  nowMs: number,
): Promise<OrientationResult> {
  // A subagent's start is not a session's.
  if (env.agentId !== null) return quiet('NOT_A_SESSION_START');
  const mode = ctx.mode;
  if (mode === undefined || !modeAllows(mode, 'show-advice')) return quiet('MODE_DOES_NOT_ADVISE');
  if (ctx.killSwitchStopped) return quiet('KILL_SWITCH');
  const forwarded = typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as { readonly harnessVersion?: unknown }).harnessVersion : undefined;
  const cert = await isCertified({ home: ctx.home, harness: env.harness as HarnessId, featureId: CONTEXT_FEATURE, nowMs, ...(typeof forwarded === 'string' ? { harnessVersion: forwarded } : {}) });
  if (!cert.certified) return quiet(cert.reasonCode ?? 'NOT_CERTIFIED');
  return { kind: 'context', text: orientationLine(mode, env.harness) };
}
