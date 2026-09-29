/**
 * P13 (learning-coverage audit; D's subagent timing records): what C's subagent route handler did
 * for one Claude Code subagent launch, handed to D's SubagentStart subscriber. The PreToolUse
 * (Agent/Task) event that C answers and the SubagentStart event that D records share no id, so the
 * note is keyed by workspace, session and subagent type, and D takes the oldest unclaimed one
 * within `SUBAGENT_NOTE_TTL_MS`.
 *
 * In memory only, bounded (`SUBAGENT_NOTE_CAP`, oldest dropped first), text-free: a reason code, an
 * outcome and the registry model id the route proposed (R20: D attributes a verified parent's
 * subagent outcome to it when the note was rendered). The note itself is never a learning label.
 */
import { MODEL_ID_PATTERN } from '@jevris/contracts';

export const SUBAGENT_ROUTE_OUTCOMES = ['proposed', 'rendered', 'explained', 'abstained'] as const;
export type SubagentRouteOutcome = (typeof SUBAGENT_ROUTE_OUTCOMES)[number];

export const SUBAGENT_NOTE_TTL_MS = 120_000;
export const SUBAGENT_NOTE_CAP = 256;

const KEY_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODEL_ID = new RegExp(MODEL_ID_PATTERN);

interface Note {
  readonly key: string;
  readonly reasonCode: string;
  outcome: SubagentRouteOutcome;
  readonly atMs: number;
  /** The registry model id the route proposed; null for an abstention. */
  readonly modelId: string | null;
}

const notes: Note[] = [];

function keyOf(workspaceId: string, sessionId: string, subagentType: string): string | null {
  return KEY_PART.test(workspaceId) && KEY_PART.test(sessionId) && KEY_PART.test(subagentType) ? `${workspaceId}\n${sessionId}\n${subagentType}` : null;
}

/**
 * Notes one handled launch. A `rendered` or `explained` note for a key whose newest unclaimed note
 * is `proposed` upgrades that note (the subscriber learns the certification after the handler
 * proposed). Returns false when an input is not a valid id, code or outcome.
 */
export function noteSubagentRoute(input: { readonly workspaceId: string; readonly sessionId: string; readonly subagentType: string; readonly reasonCode: string; readonly outcome: SubagentRouteOutcome; readonly atMs: number; readonly modelId?: string | null }): boolean {
  const key = keyOf(input.workspaceId, input.sessionId, input.subagentType);
  if (key === null || !REASON.test(input.reasonCode) || !SUBAGENT_ROUTE_OUTCOMES.includes(input.outcome) || !Number.isFinite(input.atMs)) return false;
  const modelId = input.modelId ?? null;
  // A model id only with a proposal, and only a well-formed registry id.
  if (modelId !== null && (input.outcome === 'abstained' || typeof modelId !== 'string' || !MODEL_ID.test(modelId))) return false;
  if (input.outcome === 'rendered' || input.outcome === 'explained') {
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      const n = notes[i] as Note;
      if (n.key === key && n.outcome === 'proposed' && Math.abs(input.atMs - n.atMs) <= SUBAGENT_NOTE_TTL_MS) {
        n.outcome = input.outcome;
        return true;
      }
    }
  }
  notes.push({ key, reasonCode: input.reasonCode, outcome: input.outcome, atMs: input.atMs, modelId });
  while (notes.length > SUBAGENT_NOTE_CAP) notes.shift();
  return true;
}

/** Returns and removes the oldest unclaimed note for the key within the TTL, else null. Expired notes are dropped. */
export function takeSubagentRoute(workspaceId: string, sessionId: string, subagentType: string, nowMs: number): { readonly reasonCode: string; readonly outcome: SubagentRouteOutcome; readonly atMs: number; readonly modelId: string | null } | null {
  const key = keyOf(workspaceId, sessionId, subagentType);
  if (key === null) return null;
  // Within the window either way: the handler's engine clock and the caller's may differ slightly.
  for (let i = notes.length - 1; i >= 0; i -= 1) if (Math.abs(nowMs - (notes[i] as Note).atMs) > SUBAGENT_NOTE_TTL_MS) notes.splice(i, 1);
  const at = notes.findIndex((n) => n.key === key);
  if (at < 0) return null;
  const [n] = notes.splice(at, 1) as [Note];
  return { reasonCode: n.reasonCode, outcome: n.outcome, atMs: n.atMs, modelId: n.modelId };
}

/** Test seam: forgets every note. */
export function clearSubagentRouteNotes(): void {
  notes.length = 0;
}
