/**
 * New-task advice (owner decision 2026-10-01, Jev as an active decision aid; C01 and C02 on the
 * hook path). When a prompt starts a task, Jev reads the request once and says, in one short line at
 * the next event, which kind of work it looks like and the one question whose answer would most
 * change the implementation. The request itself is never rewritten and nothing is blocked.
 *
 * This reads the person's own words, so it runs only with source egress approved:
 * - Egress denied (the default): the adviser abstains with `EGRESS_NOT_APPROVED`, makes no request
 *   and records nothing as an answer. Behaviour is exactly what it was before this adviser existed.
 * - Egress approved: the request goes as ONE evidence span, screened like every other span (a
 *   secret refuses the packet). The question text, the options and the instructions are fixed
 *   templates with no user text; the families and the open-question kinds are fixed lists that ship
 *   with Jevris. One request, two questions (the cap is 12).
 *
 * Detached: the hook answers first; the adviser runs after it and its advice waits for the
 * session's next event (see `pending-advice.ts`). The decision cache, the deadline (abandon, no
 * inner retries), the budgets, the kill switch, the mode, the circuit and `jev.assist: off` all
 * apply and fall back to saying nothing, with a reason code. A Jev answer is used at a confidence of
 * 0.6 or more and a margin of 0.15 over the runner-up. Each run that asked is one advisory
 * decision (`new-task`) that `jevris explain` renders.
 */
import { askBoundedDecision, type DecisionEngine } from '@jevris/core';
import { MAX_QUESTIONS, modeAllows, type JevQuestions, type Mode } from '@jevris/contracts';
import { cacheHitOf, choiceAnswer, codeOf, raceDeadline, refusedBeforeSending, validReasonCodes } from './live-advice-util.js';

/** The decision spec id of a new-task advisory record and of its Jev request. */
export const NEW_TASK_SPEC_ID = 'new-task';
export const NEW_TASK_MIN_CONFIDENCE = 0.6;
export const NEW_TASK_MIN_MARGIN = 0.15;
export const NEW_TASK_MIN_DEADLINE_MS = 150;
/** The most characters of the request sent as the one evidence span. */
export const NEW_TASK_SPAN_CHARS = 2000;
/** Fewer words than this is not a task to read: nothing is asked. */
export const NEW_TASK_MIN_WORDS = 4;
const DEFAULT_LATE_GRACE_MS = 1_000;

/** The workflow families that ship with Jevris. No installed template catalogue exists yet. */
export const TASK_FAMILIES = ['bugfix', 'feature', 'refactor', 'tests', 'docs', 'investigation', 'config', 'dependency'] as const;
export type TaskFamily = (typeof TASK_FAMILIES)[number];

export const TASK_FAMILY_TEXT: Readonly<Record<TaskFamily, string>> = {
  bugfix: 'Fix a defect: something that should work does not, and the change restores the intended behaviour.',
  feature: 'Add new behaviour: a capability, option or interface that does not exist yet.',
  refactor: 'Restructure existing code without changing what it does.',
  tests: 'Add or repair tests without changing the behaviour under test.',
  docs: 'Write or correct documentation, comments or messages shown to people.',
  investigation: 'Find out how something works or why it behaves as it does, without changing code.',
  config: 'Change build, CI, tooling or settings files.',
  dependency: 'Add, remove or upgrade a dependency or a platform version.',
};

/** The kinds of open question, from a fixed list. */
export const OPEN_KINDS = ['scope', 'acceptance', 'target', 'edge-cases', 'compatibility'] as const;
export type OpenKind = (typeof OPEN_KINDS)[number];

const OPEN_OPTION_TEXT: Readonly<Record<OpenKind, string>> = {
  scope: 'The request does not say what is in scope and what must stay as it is.',
  acceptance: 'The request does not say how the result will be shown to be correct.',
  target: 'The request does not say which file, component or interface to change.',
  'edge-cases': 'The request does not say what should happen in the cases it does not mention.',
  compatibility: 'The request does not say whether existing behaviour or an interface must stay compatible.',
};

/** The one question, per kind, as it is shown. Fixed text: nothing of the request is in it. */
export const OPEN_QUESTION_TEXT: Readonly<Record<OpenKind, string>> = {
  scope: 'what is in scope, and what must stay as it is?',
  acceptance: 'how will the result be shown to be correct?',
  target: 'which file, component or interface should change?',
  'edge-cases': 'what should happen in the cases the request does not mention?',
  compatibility: 'must existing behaviour or an interface stay compatible?',
};

/** The advice line: the one question, with the family named as a suggestion; or the family alone. */
export function newTaskAdviceText(family: TaskFamily | null, open: OpenKind | null): string | null {
  const familyText = family === null ? null : `This looks like a ${family} task.`;
  if (open !== null) return `Jevris: one question before implementing: ${OPEN_QUESTION_TEXT[open]}${familyText === null ? '' : ` (${familyText})`}`;
  return familyText === null ? null : `Jevris: ${familyText}`;
}

/** The questions: a Choice over the families, a Choice over the open kinds. Fixed text, no user text. */
export function newTaskQuestions(): JevQuestions {
  const family: Record<string, string> = {};
  for (const id of TASK_FAMILIES) family[id] = TASK_FAMILY_TEXT[id];
  family['none'] = 'No listed workflow family fits this request.';
  family['unknown'] = 'The request is too short or unclear to choose a family.';
  const open: Record<string, string> = {};
  for (const id of OPEN_KINDS) open[id] = OPEN_OPTION_TEXT[id];
  open['none'] = 'Nothing is left open that would change the implementation.';
  open['unknown'] = 'The request is too short or unclear to tell what is left open.';
  return {
    family: { type: 'choice', instructions: 'Which listed workflow family fits the request in the evidence item request?', criteria: family },
    open: { type: 'choice', instructions: 'Which one open question about the request in the evidence item request would most change the implementation if it were answered differently?', criteria: open },
  } as unknown as JevQuestions;
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
  readonly family: TaskFamily | null;
  readonly open: OpenKind | null;
  /** Why: a `NEW_TASK_*` code (or `EGRESS_NOT_APPROVED`), content-free. */
  readonly reasonCode: string;
  /** Jev was asked (a call or the cache). False for every gate. */
  readonly asked: boolean;
  readonly askedCount: number;
  readonly usedCount: number;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** The advisory decision of this run; null when none was recorded (nothing was asked). */
  readonly decisionId: string | null;
  readonly jevDecisionId: string | null;
}

export interface AdviseNewTaskOptions extends Omit<NewTaskGateInput, 'engine' | 'objective'> {
  readonly record?: boolean;
  /** The workspace revision the prompt arrived at. */
  readonly evidenceRevision?: string;
  readonly now?: () => number;
  readonly lateGraceMs?: number;
  readonly ids: { readonly workspaceId: string; readonly taskId?: string | null; readonly sessionId?: string | null };
}

export function newTaskReasonCodes(a: Omit<NewTaskAdvice, 'decisionId' | 'jevDecisionId' | 'latencyMs'>): string[] {
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
  ]);
}

/**
 * Reads one request and advises. Never throws and never waits past `deadlineMs`. With a gate closed
 * (including `EGRESS_NOT_APPROVED`) it makes no request, records nothing and returns the gate's
 * reason with no text.
 */
export async function adviseNewTask(engine: DecisionEngine | null, objective: string | null, options: AdviseNewTaskOptions): Promise<NewTaskAdvice> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const none = (reasonCode: string, extra: Partial<NewTaskAdvice> = {}): NewTaskAdvice => ({ text: null, family: null, open: null, reasonCode, asked: false, askedCount: 0, usedCount: 0, cacheHit: null, latencyMs: null, decisionId: null, jevDecisionId: null, ...extra });
  const gate = newTaskAskGate({ ...options, engine, objective });
  if (gate !== null || engine === null || objective === null) return none(gate ?? 'NEW_TASK_NO_PROVIDER');

  const recordable = options.record !== false && engine.recordAdvice !== undefined;
  // The workspace revision the prompt arrived at (DEC-12). Never derived from the request's words.
  const revision = options.evidenceRevision !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.evidenceRevision) ? options.evidenceRevision : 'task-r0';
  const finish = async (advice: NewTaskAdvice): Promise<NewTaskAdvice> => {
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
        reasonCodes: newTaskReasonCodes(timed),
        durationMs: elapsed,
      });
      return recorded.ok ? { ...timed, decisionId: recorded.decisionId } : timed;
    } catch {
      return timed;
    }
  };

  const questions = newTaskQuestions();
  const askedCount = Object.keys(questions as unknown as Record<string, unknown>).length;
  if (askedCount > MAX_QUESTIONS) return none('NEW_TASK_TOO_MANY_QUESTIONS');
  const span = objective.slice(0, NEW_TASK_SPAN_CHARS);
  const packet = {
    objective: 'Read the one request in the evidence and choose its workflow family and the one open question that would most change the implementation (advice only).',
    trustedPolicy: { grantsAuthority: false, families: [...TASK_FAMILIES], openKinds: [...OPEN_KINDS] },
    facts: { words: Math.min(wordCount(span), 400), characters: span.length },
    evidence: [{ id: 'request', text: span, sourceKind: 'user' as const, priority: 'mandatory' as const }],
  };
  const grace = options.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  const run = askBoundedDecision(
    engine,
    NEW_TASK_SPEC_ID,
    questions,
    packet,
    {
      workspaceId: options.ids.workspaceId,
      evidenceRevision: revision,
      ...(options.ids.taskId === undefined || options.ids.taskId === null ? {} : { taskId: options.ids.taskId }),
      ...(options.ids.sessionId === undefined || options.ids.sessionId === null ? {} : { sessionId: options.ids.sessionId }),
      deadlineMs: Math.max(1, Math.floor(options.deadlineMs + grace)),
    },
    true,
  );
  const asked = await raceDeadline(run, options.deadlineMs);
  if (asked === 'late') return finish(none('NEW_TASK_DEADLINE', { asked: true, askedCount }));
  if (asked === 'failed') return finish(none('NEW_TASK_ERROR', { asked: true, askedCount }));
  if (!asked.ok) {
    // A refusal before anything was sent (a secret in the request, no budget, an open circuit) is a miss with its reason.
    return finish(none(`NEW_TASK_JEV_${asked.reasonCode}`.slice(0, 64), refusedBeforeSending(asked.reasonCode) ? { jevDecisionId: asked.decisionId } : { asked: true, askedCount, jevDecisionId: asked.decisionId }));
  }
  const cacheHit = await cacheHitOf(engine, asked.decisionId);
  let used = 0;
  let answered = 0;
  let family: TaskFamily | null = null;
  let open: OpenKind | null = null;
  const f = choiceAnswer(asked.answers, 'family');
  if (f !== null) {
    answered += 1;
    if (f.confidence >= NEW_TASK_MIN_CONFIDENCE && f.margin >= NEW_TASK_MIN_MARGIN) {
      used += 1;
      if ((TASK_FAMILIES as readonly string[]).includes(f.choice)) family = f.choice as TaskFamily;
    }
  }
  const o = choiceAnswer(asked.answers, 'open');
  if (o !== null) {
    answered += 1;
    if (o.confidence >= NEW_TASK_MIN_CONFIDENCE && o.margin >= NEW_TASK_MIN_MARGIN) {
      used += 1;
      if ((OPEN_KINDS as readonly string[]).includes(o.choice)) open = o.choice as OpenKind;
    }
  }
  const text = newTaskAdviceText(family, open);
  const reasonCode = used === 0 ? (answered === 0 ? 'NEW_TASK_JEV_NO_ANSWER' : 'NEW_TASK_JEV_LOW_CONFIDENCE') : used === askedCount ? 'NEW_TASK_JEV' : 'NEW_TASK_JEV_PARTIAL';
  return finish({ text, family, open, reasonCode, asked: true, askedCount, usedCount: used, cacheHit, latencyMs: null, decisionId: null, jevDecisionId: asked.decisionId });
}
