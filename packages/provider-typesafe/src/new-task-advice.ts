/**
 * New-task advice (owner decision 2026-10-01, Jev as an active decision aid; C01, C04 and C02 on the
 * hook path). When a prompt starts a task, Jev reads the request once and says, in one short line at
 * the next event, which kind of work it looks like and the one question whose answer would most
 * change the implementation. The request itself is never rewritten and nothing is blocked.
 *
 * This is the trigger and the line, not a second implementation of the decisions. The three decisions
 * are core's own handlers, and each one runs here:
 * - C01 `triageTaskFamily`: a Choice over the workflow families of the trusted installed templates
 *   (the eight families that ship with Jevris, one template each, unless the caller names its own);
 * - C04 `shortlistTemplates`: the templates of the chosen family, from their metadata alone (with one
 *   template per family it is settled by rules and asks nothing; it asks Jev when more than one
 *   trusted template matches);
 * - C02 `detectAmbiguity`: a Noul for each fixed open point (scope, acceptance, target, edge cases,
 *   compatibility), "does the request leave this undecided in a way that would change the
 *   implementation", and at most the most material one becomes the question.
 *
 * This reads the person's own words, so it runs only with source egress approved:
 * - Egress denied (the default): the adviser abstains with `EGRESS_NOT_APPROVED`, makes no request
 *   and records nothing as an answer. Behaviour is exactly what it was before this adviser existed.
 * - Egress approved: the request goes as ONE evidence span, screened like every other span (a
 *   secret refuses the packet). The question text, the options and the instructions are fixed
 *   templates with no user text; the families and the open points are fixed lists that ship with
 *   Jevris. C01 and C02 run side by side, so the wait is one request, not two.
 *
 * Detached: the hook answers first; the adviser runs after it and its advice waits for the
 * session's next event (see `pending-advice.ts`). The decision cache, the deadline (abandon, no
 * inner retries), the budgets, the kill switch, the mode, the circuit and `jev.assist: off` all
 * apply and fall back to saying nothing, with a reason code. A Jev answer is used at a confidence of
 * 0.6 or more and a margin of 0.15 over the runner-up. Each run that asked is one advisory
 * decision (`new-task`) that `jevris explain` renders; the decisions it ran (`c01-task-family`,
 * `c02-ambiguity`, `c04-template`) are recorded under their own ids as well.
 */
import {
  BUILT_IN_TEMPLATES,
  BUILT_IN_TEMPLATE_PREFIX,
  OPEN_POINTS,
  detectAmbiguity,
  shortlistTemplates,
  triageTaskFamily,
  type AmbiguityResult,
  type DecisionEngine,
  type ExplicitUnknown,
  type IntentContext,
  type TemplateMeta,
  type TemplateShortlist,
  type TriageResult,
} from '@jevris/core';
import { modeAllows, type Mode } from '@jevris/contracts';
import { cacheHitOf, codeOf, raceDeadlineOf, refusedBeforeSending, validReasonCodes } from './live-advice-util.js';

export { BUILT_IN_TEMPLATES, OPEN_KINDS, OPEN_POINTS, TASK_FAMILIES, TASK_FAMILY_TEXT, type OpenKind, type TaskFamily } from '@jevris/core';

/** The decision spec id of a new-task advisory record. */
export const NEW_TASK_SPEC_ID = 'new-task';
export const NEW_TASK_MIN_CONFIDENCE = 0.6;
export const NEW_TASK_MIN_MARGIN = 0.15;
/**
 * The certainty a Noul needs for an open point to become the question line. Higher than the 0.6 floor of the
 * other decisions on purpose: measured live (2026-10-04, jev-1.13.0), Jev read all five fixed open points of a
 * plain, well-specified bugfix request as material at 0.68 to 0.72, so at 0.6 every task would get a question.
 * At 0.75 a clear request gets none, and a request that leaves something open (0.80 to 0.84) still does.
 */
export const NEW_TASK_MIN_MATERIALITY = 0.75;
export const NEW_TASK_MIN_DEADLINE_MS = 150;
/** The most characters of the request sent as the one evidence span. */
export const NEW_TASK_SPAN_CHARS = 2000;
/** Fewer words than this is not a task to read: nothing is asked. */
export const NEW_TASK_MIN_WORDS = 4;
const DEFAULT_LATE_GRACE_MS = 1_000;
/** The longest advice line, in characters. */
const MAX_LINE = 400;

/** The advice line: the one question, with the family named as a suggestion; or the family alone. */
export function newTaskAdviceText(family: string | null, question: string | null, templates: readonly string[] = []): string | null {
  const familyText = family === null ? null : `This looks like a ${family} task.`;
  const named = templates.length === 0 ? '' : ` Workflow templates to consider: ${templates.slice(0, 5).join(', ')}.`;
  if (question !== null) return `Jevris: one question before implementing: ${question}${familyText === null ? '' : ` (${familyText}${named})`}`.slice(0, MAX_LINE);
  return familyText === null ? null : `Jevris: ${familyText}${named}`.slice(0, MAX_LINE);
}

export interface NewTaskGateInput {
  readonly killSwitchStopped?: boolean;
  readonly mode?: Mode;
  readonly assist: 'off' | 'classify';
  readonly engine: Pick<DecisionEngine, 'providerConfigured' | 'sourceEgress'> | null;
  readonly deadlineMs: number;
  readonly objective: string | null;
}

/** The number of words in the request (a cheap local test that there is a task to read). */
export function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

/**
 * The reason nothing is asked, or null when Jev may be asked. `EGRESS_NOT_APPROVED` is the egress
 * rule: the request is the person's words, so with egress denied it never leaves the machine.
 */
export function newTaskAskGate(g: NewTaskGateInput): string | null {
  if (g.killSwitchStopped === true) return 'NEW_TASK_KILL_SWITCH';
  if (!modeAllows(g.mode ?? 'observe', 'record')) return 'NEW_TASK_MODE_OFF';
  if (g.assist === 'off') return 'NEW_TASK_ASSIST_OFF';
  if (g.engine === null || g.engine.providerConfigured === false) return 'NEW_TASK_NO_PROVIDER';
  if ((g.engine.sourceEgress?.() ?? 'denied') !== 'approved') return 'EGRESS_NOT_APPROVED';
  if (g.objective === null || wordCount(g.objective) < NEW_TASK_MIN_WORDS) return 'NEW_TASK_TOO_SHORT';
  if (!Number.isFinite(g.deadlineMs) || g.deadlineMs < NEW_TASK_MIN_DEADLINE_MS) return 'NEW_TASK_NO_TIME';
  return null;
}

export interface NewTaskAdvice {
  /** The one line to show at the next event, or null when there is nothing to say. */
  readonly text: string | null;
  /** The family C01 chose, or null. */
  readonly family: string | null;
  /** The open point C02 would ask about (an id from the fixed list, or the caller's own unknown), or null. */
  readonly open: string | null;
  /** Why: a `NEW_TASK_*` code (or `EGRESS_NOT_APPROVED`), content-free. */
  readonly reasonCode: string;
  /** Jev was asked (a call or the cache). False for every gate. */
  readonly asked: boolean;
  /** How many of the decisions (C01, C02, and C04 when it had to ask) asked Jev. */
  readonly askedCount: number;
  /** How many of them gave an answer that was used. */
  readonly usedCount: number;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** The advisory decision of this run; null when none was recorded (nothing was asked). */
  readonly decisionId: string | null;
  /** The decision record of C01's own Jev call (the family), or null. */
  readonly jevDecisionId: string | null;
  /** Every Jev decision this run made (C01, C02, C04), in that order. */
  readonly jevDecisionIds: readonly string[];
}

export interface AdviseNewTaskOptions extends Omit<NewTaskGateInput, 'engine' | 'objective'> {
  readonly record?: boolean;
  /** The workspace revision the prompt arrived at. */
  readonly evidenceRevision?: string;
  readonly now?: () => number;
  readonly lateGraceMs?: number;
  readonly ids: { readonly workspaceId: string; readonly taskId?: string | null; readonly sessionId?: string | null };
  /** Installed templates the caller holds (trusted only when they say so and are installed); default: the ones that ship with Jevris. */
  readonly templates?: readonly TemplateMeta[];
  /** Explicit unknowns the caller names; default: the fixed open points. */
  readonly unknowns?: readonly ExplicitUnknown[];
  /**
   * DEC-12, US31: the repository revision now. A decision that finishes after it moved is kept as stale
   * and never shown; one fresh decision runs on the new revision when `stillUseful` says it is worth it.
   */
  readonly currentRevision?: () => string | null;
  readonly stillUseful?: () => boolean;
}

/** What one decision of the run came to. */
interface Part {
  readonly id: 'C01' | 'C02' | 'C04';
  /** Jev was asked (a call, or the cache). */
  readonly asked: boolean;
  /** An answer came back from Jev. */
  readonly answered: boolean;
  /** The answer was used (it cleared the floors, whatever it said). */
  readonly used: boolean;
  /** A code for the record: the handler's own, or `LATE` (abandoned at the deadline) or `FAILED` (the request threw). */
  readonly code: string;
  /** The engine refused before sending anything. */
  readonly refused: boolean;
  readonly decisionId: string | null;
}

const skipped = (id: Part['id'], code: string): Part => ({ id, asked: false, answered: false, used: false, code, refused: false, decisionId: null });

function triagePart(r: TriageResult | 'late' | 'failed'): Part {
  if (r === 'late') return { id: 'C01', asked: true, answered: false, used: false, code: 'LATE', refused: false, decisionId: null };
  if (r === 'failed') return { id: 'C01', asked: true, answered: false, used: false, code: 'FAILED', refused: false, decisionId: null };
  if (r.outcome === 'selected') return { id: 'C01', asked: true, answered: true, used: true, code: 'SELECTED', refused: false, decisionId: r.decisionId };
  const answered = ['NO_ANSWER', 'LOW_CONFIDENCE', 'NO_TEMPLATE_FITS', 'FAMILY_UNKNOWN', 'UNKNOWN_OPTION'].includes(r.reasonCode) && r.decisionId !== null;
  const refused = r.decisionId !== null && !answered && refusedBeforeSending(r.reasonCode);
  return {
    id: 'C01',
    asked: answered || (r.decisionId !== null && !refused),
    answered: answered && r.reasonCode !== 'NO_ANSWER',
    used: r.reasonCode === 'NO_TEMPLATE_FITS' || r.reasonCode === 'FAMILY_UNKNOWN',
    code: r.reasonCode,
    refused: refused || (r.decisionId === null && refusedBeforeSending(r.reasonCode)),
    decisionId: r.decisionId,
  };
}

function ambiguityPart(r: AmbiguityResult | 'late' | 'failed'): Part {
  if (r === 'late') return { id: 'C02', asked: true, answered: false, used: false, code: 'LATE', refused: false, decisionId: null };
  if (r === 'failed') return { id: 'C02', asked: true, answered: false, used: false, code: 'FAILED', refused: false, decisionId: null };
  if (r.outcome === 'ask') return { id: 'C02', asked: true, answered: true, used: true, code: 'ASK', refused: false, decisionId: r.decisionId };
  const answered = (r.reasonCode === 'NOT_MATERIAL' || r.reasonCode === 'UNCERTAIN' || r.reasonCode === 'NO_ANSWER') && r.decisionId !== null;
  const refused = r.decisionId !== null && !answered && refusedBeforeSending(r.reasonCode);
  return {
    id: 'C02',
    asked: answered || (r.decisionId !== null && !refused),
    answered: answered && r.reasonCode !== 'NO_ANSWER',
    used: r.reasonCode === 'NOT_MATERIAL',
    code: r.reasonCode,
    refused: refused || (r.decisionId === null && r.reasonCode !== 'NO_EXPLICIT_UNKNOWNS' && refusedBeforeSending(r.reasonCode)),
    decisionId: r.decisionId,
  };
}

function shortlistPart(r: TemplateShortlist | 'late' | 'failed'): Part {
  if (r === 'late') return { id: 'C04', asked: true, answered: false, used: false, code: 'LATE', refused: false, decisionId: null };
  if (r === 'failed') return { id: 'C04', asked: true, answered: false, used: false, code: 'FAILED', refused: false, decisionId: null };
  if (r.decisionId === null) return skipped('C04', r.reasonCode);
  const answered = r.reasonCode === 'RANKED' || r.reasonCode === 'NO_TEMPLATE_FITS' || r.reasonCode === 'NO_ANSWER';
  const refused = !answered && refusedBeforeSending(r.reasonCode);
  return { id: 'C04', asked: !refused, answered: answered && r.reasonCode !== 'NO_ANSWER', used: r.reasonCode === 'RANKED' || r.reasonCode === 'NO_TEMPLATE_FITS', code: r.reasonCode, refused, decisionId: r.decisionId };
}

export function newTaskReasonCodes(a: Omit<NewTaskAdvice, 'decisionId' | 'jevDecisionId' | 'jevDecisionIds' | 'latencyMs'>, parts: readonly { readonly id: string; readonly code: string }[] = []): string[] {
  const shown = a.text === null ? 'NONE' : a.open !== null ? 'QUESTION' : 'FAMILY';
  return validReasonCodes([
    'TASK_SOURCE_JEV',
    `TASK_FAMILY_${a.family === null ? 'NONE' : codeOf(a.family)}`,
    `TASK_OPEN_${a.open === null ? 'NONE' : codeOf(a.open)}`,
    `TASK_ADVICE_${shown}`,
    `TASK_ASKED_${String(a.askedCount)}`,
    `TASK_USED_${String(a.usedCount)}`,
    a.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS',
    a.reasonCode,
    ...parts.map((p) => `TASK_${p.id}_${codeOf(p.code)}`),
  ]);
}

/** The run's reason code from what each decision came to. */
function reasonOf(parts: readonly Part[]): string {
  const asked = parts.filter((p) => p.asked);
  if (asked.length === 0) {
    const refusal = parts.find((p) => p.refused);
    return refusal === undefined ? 'NEW_TASK_NOTHING_TO_ASK' : `NEW_TASK_JEV_${refusal.code}`.slice(0, 64);
  }
  const used = asked.filter((p) => p.used).length;
  if (used > 0) return used === asked.length ? 'NEW_TASK_JEV' : 'NEW_TASK_JEV_PARTIAL';
  // Nothing was used: the first miss says why (a deadline, an error, an engine refusal), else Jev answered and was not sure.
  const miss = asked.find((p) => !p.answered && (p.code === 'LATE' || p.code === 'FAILED'));
  if (miss !== undefined) return miss.code === 'LATE' ? 'NEW_TASK_DEADLINE' : 'NEW_TASK_ERROR';
  if (asked.some((p) => p.answered)) return 'NEW_TASK_JEV_LOW_CONFIDENCE';
  const refusal = asked.find((p) => p.code !== 'NO_ANSWER' && p.code !== 'UNCERTAIN');
  return refusal === undefined ? 'NEW_TASK_JEV_NO_ANSWER' : `NEW_TASK_JEV_${refusal.code}`.slice(0, 64);
}

/**
 * Reads one request and advises. Never throws and never waits past `deadlineMs`. With a gate closed
 * (including `EGRESS_NOT_APPROVED`) it makes no request, records nothing and returns the gate's
 * reason with no text.
 */
export async function adviseNewTask(engine: DecisionEngine | null, objective: string | null, options: AdviseNewTaskOptions): Promise<NewTaskAdvice> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const none = (reasonCode: string, extra: Partial<NewTaskAdvice> = {}): NewTaskAdvice => ({ text: null, family: null, open: null, reasonCode, asked: false, askedCount: 0, usedCount: 0, cacheHit: null, latencyMs: null, decisionId: null, jevDecisionId: null, jevDecisionIds: [], ...extra });
  const gate = newTaskAskGate({ ...options, engine, objective });
  if (gate !== null || engine === null || objective === null) return none(gate ?? 'NEW_TASK_NO_PROVIDER');

  const recordable = options.record !== false && engine.recordAdvice !== undefined;
  // The workspace revision the prompt arrived at (DEC-12). Never derived from the request's words.
  const revision = options.evidenceRevision !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.evidenceRevision) ? options.evidenceRevision : 'task-r0';
  const finish = async (advice: NewTaskAdvice, parts: readonly Part[]): Promise<NewTaskAdvice> => {
    const elapsed = Math.max(0, Math.round(now() - started));
    const timed: NewTaskAdvice = { ...advice, latencyMs: elapsed };
    if (!recordable || engine.recordAdvice === undefined) return timed;
    try {
      const recorded = await engine.recordAdvice({
        specId: NEW_TASK_SPEC_ID,
        workspaceId: options.ids.workspaceId,
        evidenceRevision: revision,
        ...(options.ids.taskId === undefined || options.ids.taskId === null ? {} : { taskId: options.ids.taskId }),
        ...(options.ids.sessionId === undefined || options.ids.sessionId === null ? {} : { sessionId: options.ids.sessionId }),
        action: { kind: 'advise', templateId: NEW_TASK_SPEC_ID, evidenceIds: ['request', 'fixed-templates'] },
        reasonCodes: newTaskReasonCodes(timed, parts),
        durationMs: elapsed,
      });
      return recorded.ok ? { ...timed, decisionId: recorded.decisionId } : timed;
    } catch {
      return timed;
    }
  };

  const templates = options.templates ?? BUILT_IN_TEMPLATES;
  const unknowns = options.unknowns ?? OPEN_POINTS;
  const span = objective.slice(0, NEW_TASK_SPAN_CHARS);
  const grace = options.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  const ctx: IntentContext = {
    workspaceId: options.ids.workspaceId,
    evidenceRevision: revision,
    ...(options.ids.taskId === undefined || options.ids.taskId === null ? {} : { taskId: options.ids.taskId }),
    ...(options.ids.sessionId === undefined || options.ids.sessionId === null ? {} : { sessionId: options.ids.sessionId }),
    // The engine's own deadline outlives the caller's wait by the grace, so an abandoned request still warms the cache.
    deadlineMs: Math.max(1, Math.floor(options.deadlineMs + grace)),
    ...(options.currentRevision === undefined ? {} : { currentRevision: options.currentRevision }),
    ...(options.stillUseful === undefined ? {} : { stillUseful: options.stillUseful }),
  };
  const remaining = (): number => Math.max(1, Math.floor(options.deadlineMs - (now() - started)));
  // C01 and C02 read the same one request and need nothing from each other: side by side.
  const [family, ambiguity] = await Promise.all([
    raceDeadlineOf(triageTaskFamily(engine, { objective: span, templates, minConfidence: NEW_TASK_MIN_CONFIDENCE, minMargin: NEW_TASK_MIN_MARGIN }, ctx), options.deadlineMs),
    raceDeadlineOf(detectAmbiguity(engine, { objective: span, unknowns, threshold: NEW_TASK_MIN_MATERIALITY }, ctx), options.deadlineMs),
  ]);
  const parts: Part[] = [triagePart(family), ambiguityPart(ambiguity)];
  const chosen = typeof family === 'object' && family.outcome === 'selected' ? family.family : null;
  // C04: the templates of the chosen family, from their metadata alone; it asks only when more than one trusted template matches.
  let templateNames: readonly string[] = [];
  if (chosen !== null) {
    const shortlist = await raceDeadlineOf(shortlistTemplates(engine, { taskProfile: { family: chosen, tags: [chosen] }, templates }, ctx), remaining());
    parts.push(shortlistPart(shortlist));
    if (typeof shortlist === 'object') templateNames = shortlist.shortlist.filter((id) => !id.startsWith(BUILT_IN_TEMPLATE_PREFIX));
  }
  const questionOf = typeof ambiguity === 'object' && ambiguity.outcome === 'ask' ? ambiguity.question : null;
  const asked = parts.filter((p) => p.asked);
  const jevDecisionIds = parts.flatMap((p) => (p.decisionId === null ? [] : [p.decisionId]));
  const hits = await Promise.all(jevDecisionIds.map((id) => cacheHitOf(engine, id)));
  const cacheHit = jevDecisionIds.length === 0 ? null : hits.every((h) => h === true) ? true : hits.some((h) => h === null) ? null : false;
  const reasonCode = reasonOf(parts);
  const base: Omit<NewTaskAdvice, 'decisionId' | 'jevDecisionId' | 'jevDecisionIds' | 'latencyMs'> = {
    text: newTaskAdviceText(chosen, questionOf === null ? null : questionOf.text, templateNames),
    family: chosen,
    open: questionOf === null ? null : questionOf.unknownId,
    reasonCode,
    asked: asked.length > 0,
    askedCount: asked.length,
    usedCount: asked.filter((p) => p.used).length,
    cacheHit,
  };
  const c01 = parts[0];
  return finish({ ...base, latencyMs: null, decisionId: null, jevDecisionId: c01?.decisionId ?? null, jevDecisionIds }, parts);
}
