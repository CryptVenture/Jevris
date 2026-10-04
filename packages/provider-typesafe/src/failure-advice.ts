/**
 * Repeated-failure advice (owner decision 2026-10-01, Jev as an active decision aid; C05 and C29 on
 * the hook path). When the same tool failure comes back in a session, say once, in one short line,
 * what evidence would help most next, instead of letting the agent try random changes.
 *
 * The input is content-free: the adapter's `failure` features (a tool class and an exit class, two
 * one-way digests that stay on this machine, an environmental flag, an elapsed bucket and which of a
 * FIXED vocabulary of artifacts the failure already shows) plus counts the trigger filter made. No
 * error text, no path, no command and no tool output reaches this module or a request, so the
 * advice needs no egress approval. The parser here drops everything it does not know.
 *
 * Rules first. `adviseFailureLoop` and `orchestration.maxRepairAttempts` decide when repair attempts
 * are used up and when a failure is environmental; a fixed priority list names the next artifact.
 * Jev is asked only when the rules cannot settle a question, and the two questions run side by side:
 * - a Noul "is this the same failure as before" when the signatures differ but the same call ran
 *   again with nothing edited (equal signatures are the same failure, no call), and
 * - C05, core's evidence-sufficiency decision (`checkEvidenceSufficiency`), when more than one candidate
 *   remains and the failure is not environmental: is the evidence so far enough, and if not which listed
 *   artifact to obtain next. It is the decision's own handler that asks; this module supplies the
 *   failure's content-free facts and the candidates, and reads the result.
 * The question text, the options and the instructions are fixed templates over the vocabulary.
 * A Jev answer is used at a confidence of 0.6 or more; any miss (kill switch, mode, `jev.assist`
 * off, no provider, no time, a deadline, an error, a budget stop, an open circuit, low confidence)
 * keeps the rules advice with a reason code. The advice is one line of text: it changes no
 * permission, runs nothing and marks nothing done. Each advised failure is one advisory decision
 * (`repeated-failure`) that `jevris explain` renders.
 */
import { FAILURE_ARTIFACT_TEXT, adviseFailureLoop, askBoundedDecision, checkEvidenceSufficiency, type DecisionEngine, type FailureObservation, type IntentContext, type SufficiencyResult } from '@jevris/core';
import {
  FAILURE_ARTIFACT_IDS,
  FAILURE_ELAPSED_BUCKETS,
  FAILURE_EXIT_CLASSES,
  FAILURE_TOOL_CLASSES,
  modeAllows,
  sha256Hex,
  type FailureArtifactId,
  type FailureElapsedBucket,
  type FailureExitClass,
  type FailureToolClass,
  type JevQuestions,
  type Mode,
} from '@jevris/contracts';
import { cacheHitOf, codeOf, noulProbability, raceDeadline, raceDeadlineOf, refusedBeforeSending, validReasonCodes } from './live-advice-util.js';

export { FAILURE_ARTIFACT_TEXT };

/** The decision spec id of a repeated-failure advisory record and of its Jev request. */
export const REPEATED_FAILURE_SPEC_ID = 'repeated-failure';
/** Jev's confidence floor for an answer to be used. */
export const FAILURE_MIN_CONFIDENCE = 0.6;
/** Below this many ms left, Jev is not asked: a call cannot finish. */
export const FAILURE_MIN_DEADLINE_MS = 150;
/** The repair-attempt bound when the setting is not passed (config `orchestration.maxRepairAttempts`). */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;
const DEFAULT_LATE_GRACE_MS = 1_000;

// -------------------------------------------------------------------------------- features

/** The adapter's `failure` features after strict parsing: closed sets, two digests, two booleans. */
export interface FailureFeatures {
  readonly toolClass: FailureToolClass;
  readonly exitClass: FailureExitClass;
  /** `${toolClass}:${exitClass}`. */
  readonly family: string;
  /** A one-way digest of the normalized error text. Compared locally, never sent. */
  readonly signature: string | null;
  /** A one-way digest of the failed call's input. Compared locally, never sent. */
  readonly commandDigest: string | null;
  readonly environmental: boolean;
  readonly elapsed: FailureElapsedBucket;
  readonly present: readonly FailureArtifactId[];
}

const HEX16 = /^[0-9a-f]{16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function oneOf<T extends string>(set: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * The failure features from an event body's `failure` field, or null when it is missing or not
 * exactly the closed shape. Unknown keys are dropped; an unknown value anywhere refuses the whole
 * object, so free text can never ride in on it.
 */
export function parseFailureFeatures(value: unknown): FailureFeatures | null {
  if (!isRecord(value)) return null;
  const toolClass = oneOf(FAILURE_TOOL_CLASSES, own(value, 'toolClass'));
  const exitClass = oneOf(FAILURE_EXIT_CLASSES, own(value, 'exitClass'));
  const elapsed = oneOf(FAILURE_ELAPSED_BUCKETS, own(value, 'elapsed'));
  const environmental = own(value, 'environmental');
  const signature = own(value, 'signature');
  const commandDigest = own(value, 'commandDigest');
  const presentRaw = own(value, 'present');
  if (toolClass === null || exitClass === null || elapsed === null || typeof environmental !== 'boolean') return null;
  if (own(value, 'family') !== `${toolClass}:${exitClass}`) return null;
  if (signature !== null && !(typeof signature === 'string' && HEX16.test(signature))) return null;
  if (commandDigest !== null && !(typeof commandDigest === 'string' && HEX16.test(commandDigest))) return null;
  if (!Array.isArray(presentRaw) || presentRaw.length > FAILURE_ARTIFACT_IDS.length) return null;
  const present = new Set<FailureArtifactId>();
  for (const entry of presentRaw) {
    const id = oneOf(FAILURE_ARTIFACT_IDS, entry);
    if (id === null) return null;
    present.add(id);
  }
  return {
    toolClass,
    exitClass,
    family: `${toolClass}:${exitClass}`,
    signature: signature === null ? null : (signature as string),
    commandDigest: commandDigest === null ? null : (commandDigest as string),
    environmental,
    elapsed,
    present: FAILURE_ARTIFACT_IDS.filter((id) => present.has(id)),
  };
}

// --------------------------------------------------------------------------- fixed texts

/** The rules' priority order of artifacts to obtain, by the kind of failure. */
const ORDER_DEFAULT: readonly FailureArtifactId[] = ['failing-test-output', 'stack-trace', 'recent-diff', 'repro-steps', 'logs', 'config-file', 'environment-info'];
const ORDER_ENVIRONMENT: readonly FailureArtifactId[] = ['environment-info', 'logs', 'config-file', 'repro-steps', 'recent-diff', 'stack-trace', 'failing-test-output'];
const ORDER_TIMEOUT: readonly FailureArtifactId[] = ['logs', 'environment-info', 'repro-steps', 'recent-diff', 'config-file', 'stack-trace', 'failing-test-output'];

/** The one short advice line, from fixed templates. No text of the failure appears in it. */
export function failureAdviceText(step: FailureStep, attempts: number, next: FailureArtifactId | null, environmental: boolean): string | null {
  const times = `${String(Math.max(2, attempts))} times`;
  if (step === 'capped') return `Jevris: this failure has come back ${times} with nothing changed and the repair attempts are used up; stop and report what was tried.`;
  if (step === 'environment') return `Jevris: this failure has come back ${times} and looks environmental; get the environment information (tool versions, running services, variables set) before changing code.`;
  if (step === 'none' || next === null) return null;
  const phrase = FAILURE_ARTIFACT_TEXT[next].phrase;
  return environmental ? `Jevris: this failure has come back ${times} and looks environmental; the next most useful evidence is ${phrase}.` : `Jevris: this failure has come back ${times}; the next most useful evidence is ${phrase}.`;
}

// -------------------------------------------------------------------------------- the plan

export type FailureStep = 'artifact' | 'environment' | 'capped' | 'none';

/** What the rules know about one repeated failure: the features plus the filter's counts. */
export interface FailureContext {
  readonly features: FailureFeatures;
  readonly attempts: number;
  readonly sameCommand: boolean | null;
  readonly editsSince: number;
  /** The signatures differ but the same call ran again with nothing edited. */
  readonly unsure: boolean;
  readonly previous: { readonly environmental: boolean; readonly elapsed: string; readonly present: readonly string[] } | null;
  readonly maxRepairAttempts: number;
}

export interface FailurePlan {
  readonly step: FailureStep;
  /** The rules' pick of the next artifact (null when none is named). */
  readonly next: FailureArtifactId | null;
  /** The artifacts not already present, in the rules' priority order. */
  readonly candidates: readonly FailureArtifactId[];
  /** The rules settle which artifact to name: Jev is not asked the Choice. */
  readonly sure: boolean;
  readonly sureCode: string | null;
  readonly askNext: boolean;
  readonly askSame: boolean;
}

/** The failure context from the adapter's features and the trigger filter's observation. */
export function failureContextOf(features: FailureFeatures, observation: FailureObservation | undefined, maxRepairAttempts: number = DEFAULT_MAX_REPAIR_ATTEMPTS): FailureContext {
  const o = observation;
  return {
    features,
    attempts: o === undefined ? 2 : Math.max(1, Math.min(10_000, Math.floor(o.attempts))),
    sameCommand: o === undefined ? null : o.sameCommand,
    editsSince: o === undefined ? 0 : Math.max(0, Math.floor(o.editsSince)),
    unsure: o === undefined ? false : o.unsure,
    // The previous failure's shape is checked against the closed sets again: whatever the filter held, only a code can reach a request.
    previous: o?.previous === null || o?.previous === undefined ? null : { environmental: o.previous.environmental === true, elapsed: oneOf(FAILURE_ELAPSED_BUCKETS, o.previous.elapsed) ?? 'unknown', present: FAILURE_ARTIFACT_IDS.filter((id) => o.previous?.present.includes(id) === true) },
    maxRepairAttempts: Math.max(0, Math.min(10, Math.floor(maxRepairAttempts))),
  };
}

function loopStepOf(c: FailureContext): 'request-environment-evidence' | 'stop-with-report' | 'abstain' {
  const hasSource = c.features.present.includes('stack-trace') || c.features.present.includes('failing-test-output');
  const result = adviseFailureLoop({
    diagnostic: c.features.environmental ? 'missing-service' : 'unknown',
    sourceEvidence: hasSource ? 'present' : 'absent',
    fingerprint: c.features.signature === null ? `family-${c.features.toolClass}-${c.features.exitClass}` : `sig-${c.features.signature}`,
    sameFingerprintCount: Math.min(10, c.attempts),
    commandHashRepeated: c.sameCommand === true,
    relevantDiff: c.editsSince > 0 ? 'present' : 'none',
    rejectedApproaches: [],
    proposedCause: null,
    maxRepairAttempts: c.maxRepairAttempts,
    repairAttemptsUsed: Math.min(10, c.attempts),
  });
  return result.nextStep === 'request-environment-evidence' || result.nextStep === 'stop-with-report' ? result.nextStep : 'abstain';
}

/** The rules' plan: the step, the candidate artifacts, and which questions Jev would be asked. Pure. */
export function planFailureAdvice(c: FailureContext): FailurePlan {
  const f = c.features;
  const order = f.environmental ? ORDER_ENVIRONMENT : f.exitClass === 'timeout' ? ORDER_TIMEOUT : ORDER_DEFAULT;
  const candidates = order.filter((id) => !f.present.includes(id));
  const loop = loopStepOf(c);
  const base = { candidates, askSame: c.unsure };
  if (loop === 'stop-with-report') return { ...base, step: 'capped', next: null, sure: true, sureCode: 'REPEATED_FAILURE_RULES_SURE', askNext: false };
  if (loop === 'request-environment-evidence') return { ...base, step: 'environment', next: 'environment-info', sure: true, sureCode: 'REPEATED_FAILURE_RULES_SURE', askNext: false };
  if (candidates.length === 0) return { ...base, step: 'none', next: null, sure: true, sureCode: 'REPEATED_FAILURE_NO_CANDIDATE', askNext: false };
  if (f.environmental) return { ...base, step: 'artifact', next: candidates[0] ?? null, sure: true, sureCode: 'REPEATED_FAILURE_RULES_SURE', askNext: false };
  if (candidates.length === 1) return { ...base, step: 'artifact', next: candidates[0] ?? null, sure: true, sureCode: 'REPEATED_FAILURE_ONE_CANDIDATE', askNext: false };
  return { ...base, step: 'artifact', next: candidates[0] ?? null, sure: false, sureCode: null, askNext: true };
}

// ---------------------------------------------------------------------------------- gates

export interface FailureGateInput {
  /** The kill switch was stopped when the event arrived. */
  readonly killSwitchStopped?: boolean;
  /** The effective mode; absent reads as observe. Below observe nothing is asked or recorded. */
  readonly mode?: Mode;
  readonly assist: 'off' | 'classify';
  readonly engine: Pick<DecisionEngine, 'providerConfigured'> | null;
  /** How long a caller can wait for Jev, in ms. */
  readonly deadlineMs: number;
}

/**
 * The reason Jev may not be asked, or null when it may. Every gate falls back to the rules advice
 * with this code; none of them changes what the rules say.
 */
export function failureAskGate(g: FailureGateInput): string | null {
  if (g.killSwitchStopped === true) return 'REPEATED_FAILURE_KILL_SWITCH';
  if (!modeAllows(g.mode ?? 'observe', 'record')) return 'REPEATED_FAILURE_MODE_OFF';
  if (g.assist === 'off') return 'REPEATED_FAILURE_ASSIST_OFF';
  if (g.engine === null || g.engine.providerConfigured === false) return 'REPEATED_FAILURE_NO_PROVIDER';
  if (!Number.isFinite(g.deadlineMs) || g.deadlineMs < FAILURE_MIN_DEADLINE_MS) return 'REPEATED_FAILURE_NO_TIME';
  return null;
}

// -------------------------------------------------------------------------------- questions

/**
 * The adviser's own question, a Noul "same failure" when `askSame`; empty otherwise. Fixed text only. The
 * Choice "which artifact next" is C05's (`checkEvidenceSufficiency`), with its own fixed text.
 */
export function failureQuestions(plan: FailurePlan): JevQuestions {
  const questions: Record<string, unknown> = {};
  if (plan.askSame) {
    questions['same'] = {
      type: 'noul',
      instructions: 'Is the latest failure in the facts the same failure as the previous one, with the same cause, even though its error signature differs?',
      criteria: { true: 'The same call ran again with nothing edited and failed the same way: it is the same failure.', false: 'The latest failure has a different cause from the previous one.' },
    };
  }
  return questions as unknown as JevQuestions;
}

function attemptsBucket(attempts: number): string {
  return attempts <= 2 ? '2' : attempts <= 4 ? '3-4' : '5+';
}

/** The facts of the request: closed codes, counts and flags. Nothing here is text of the failure. */
export function failureFacts(c: FailureContext): Record<string, string | number | boolean> {
  const f = c.features;
  const facts: Record<string, string | number | boolean> = {
    family: f.family,
    attempts: attemptsBucket(c.attempts),
    environmental: f.environmental,
    elapsed: f.elapsed,
    present: f.present.length === 0 ? 'none' : f.present.join(','),
    sameCommand: c.sameCommand === null ? 'unknown' : c.sameCommand,
    editsSince: Math.min(3, c.editsSince),
    maxRepairAttempts: c.maxRepairAttempts,
  };
  if (c.previous !== null) {
    facts['previousEnvironmental'] = c.previous.environmental;
    facts['previousElapsed'] = c.previous.elapsed;
    facts['previousPresent'] = c.previous.present.length === 0 ? 'none' : c.previous.present.join(',');
  }
  return facts;
}

function revisionOf(facts: Record<string, string | number | boolean>, plan: FailurePlan): string {
  return `fail-${sha256Hex(JSON.stringify([facts, plan.candidates, plan.askSame, plan.askNext])).slice(0, 24)}`;
}

function evidenceIdsOf(c: FailureContext): string[] {
  const ids = ['feature-family', 'feature-attempts', 'feature-environmental', 'feature-elapsed'];
  if (c.features.present.length > 0) ids.push('feature-artifacts');
  return ids;
}

// ------------------------------------------------------------------------------- the advice

export interface FailureAdvice {
  /** The one line to show, or null when the advice is to say nothing. */
  readonly text: string | null;
  readonly step: FailureStep;
  readonly next: FailureArtifactId | null;
  readonly source: 'rules' | 'jev';
  /** Why this source: a `REPEATED_FAILURE_*` code, content-free. */
  readonly reasonCode: string;
  readonly asked: boolean;
  readonly askedCount: number;
  readonly usedCount: number;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** The advisory decision of this run; null when none was recorded. */
  readonly decisionId: string | null;
  readonly jevDecisionId: string | null;
  /** The signatures differed, the same call ran again, and Jev said it is the same failure. */
  readonly sameByJev: boolean;
  /** C05: Jev said the evidence so far is enough to choose a fix, so no further evidence is named. */
  readonly sufficientByJev: boolean;
}

export interface AdviseFailureOptions extends Omit<FailureGateInput, 'engine'> {
  /** Record the advice as an advisory decision (default true). */
  readonly record?: boolean;
  /** The clock for latency; tests inject one. */
  readonly now?: () => number;
  /** How long past `deadlineMs` the engine lets the call run to warm the cache (default 1000 ms). */
  readonly lateGraceMs?: number;
  /**
   * The longest to wait for the advisory record, in ms. Absent, the record is waited for (a detached
   * run has no one waiting). A hook path sets it to the time the hook has left: past it the advice is
   * returned without a decision id, the record finishes or fails on its own, and `note` is told
   * `REPEATED_FAILURE_RECORD_LATE`.
   */
  readonly recordWaitMs?: number;
  /** Told a reason code for the run as a whole (content-free), for the caller's trace. */
  readonly note?: (reasonCode: string) => void;
  readonly ids: { readonly workspaceId: string; readonly taskId?: string | null; readonly sessionId?: string | null };
}

export function failureReasonCodes(c: FailureContext, a: Omit<FailureAdvice, 'decisionId' | 'jevDecisionId' | 'latencyMs' | 'text'>, rulesNext: FailureArtifactId | null): string[] {
  const codes = [
    `FAIL_FAMILY_${codeOf(c.features.toolClass)}_${codeOf(c.features.exitClass)}`,
    `FAIL_ATTEMPTS_${String(Math.min(c.attempts, 9999))}`,
    `FAIL_SOURCE_${a.source.toUpperCase()}`,
    `FAIL_STEP_${codeOf(a.step)}`,
    ...(a.next === null ? [] : [`FAIL_NEXT_${codeOf(a.next)}`]),
    ...(rulesNext === null ? [] : [`FAIL_RULES_${codeOf(rulesNext)}`]),
    ...(c.features.environmental ? ['FAIL_ENV'] : []),
    ...(a.sameByJev ? ['FAIL_SAME_JEV'] : c.unsure ? ['FAIL_SAME_UNSURE'] : []),
    ...(a.sufficientByJev ? ['FAIL_SUFFICIENT_JEV'] : []),
    ...(a.asked ? [`FAIL_ASKED_${String(a.askedCount)}`, `FAIL_USED_${String(a.usedCount)}`, a.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    a.reasonCode,
  ];
  return validReasonCodes(codes);
}

/** One request that missed: why the rules advice stands, whether Jev was asked, and the engine's record of the call. */
interface Miss {
  readonly code: string;
  readonly asked: boolean;
  readonly decisionId: string | null;
}

/** The reasons C05 returns when Jev answered and the answer was not used: not a miss of the request itself. */
const C05_ANSWERED: ReadonlySet<string> = new Set(['LOW_CONFIDENCE', 'INSUFFICIENT_NO_ARTIFACT_NAMED', 'NO_ARTIFACT_HELPS', 'NO_ANSWER']);

/**
 * Advice for one repeated failure. Never throws and never waits past `deadlineMs` for Jev: any
 * failure is the rules advice. With the gates closed, or when the rules settle every question, no
 * request is made and nothing waits.
 */
export async function adviseRepeatedFailure(engine: DecisionEngine | null, c: FailureContext, options: AdviseFailureOptions): Promise<FailureAdvice> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const plan = planFailureAdvice(c);
  const mode: Mode = options.mode ?? 'observe';
  const recordable = options.record !== false && options.killSwitchStopped !== true && modeAllows(mode, 'record') && engine !== null && engine.recordAdvice !== undefined;

  const make = (r: {
    readonly step: FailureStep;
    readonly next: FailureArtifactId | null;
    readonly source: 'rules' | 'jev';
    readonly reasonCode: string;
    readonly asked?: boolean;
    readonly askedCount?: number;
    readonly usedCount?: number;
    readonly cacheHit?: boolean | null;
    readonly jevDecisionId?: string | null;
    readonly sameByJev?: boolean;
    readonly sufficientByJev?: boolean;
    readonly silent?: boolean;
  }): FailureAdvice => ({
    text: r.silent === true ? null : failureAdviceText(r.step, c.attempts, r.next, c.features.environmental),
    step: r.step,
    next: r.next,
    source: r.source,
    reasonCode: r.reasonCode,
    asked: r.asked === true,
    askedCount: r.askedCount ?? 0,
    usedCount: r.usedCount ?? 0,
    cacheHit: r.cacheHit ?? null,
    latencyMs: null,
    decisionId: null,
    jevDecisionId: r.jevDecisionId ?? null,
    sameByJev: r.sameByJev === true,
    sufficientByJev: r.sufficientByJev === true,
  });

  /** Records the advice when there is advice to give or Jev was asked, and stamps its latency. */
  const finish = async (advice: FailureAdvice): Promise<FailureAdvice> => {
    const elapsed = Math.max(0, Math.round(now() - started));
    const timed: FailureAdvice = { ...advice, latencyMs: advice.asked ? elapsed : null };
    if (!recordable || engine === null || engine.recordAdvice === undefined || (timed.text === null && !timed.asked)) return timed;
    const facts = failureFacts(c);
    let recording: Promise<FailureAdvice>;
    try {
      recording = engine
        .recordAdvice({
          specId: REPEATED_FAILURE_SPEC_ID,
          workspaceId: options.ids.workspaceId,
          evidenceRevision: revisionOf(facts, plan),
          ...(options.ids.taskId === undefined || options.ids.taskId === null ? {} : { taskId: options.ids.taskId }),
          ...(options.ids.sessionId === undefined || options.ids.sessionId === null ? {} : { sessionId: options.ids.sessionId }),
          action: { kind: 'advise', templateId: REPEATED_FAILURE_SPEC_ID, evidenceIds: evidenceIdsOf(c) },
          reasonCodes: failureReasonCodes(c, timed, plan.next),
          durationMs: elapsed,
        })
        .then(
          (recorded) => (recorded.ok ? { ...timed, decisionId: recorded.decisionId } : timed),
          () => timed,
        );
    } catch {
      return timed;
    }
    if (options.recordWaitMs === undefined) return recording;
    // The hook has only so long: past it the line goes without its decision id and the record
    // finishes (or fails) on its own, so a slow disk never holds the line.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), Math.max(0, Math.floor(options.recordWaitMs ?? 0)));
    });
    try {
      const raced = await Promise.race([recording, late]);
      if (raced !== 'late') return raced;
      try {
        options.note?.('REPEATED_FAILURE_RECORD_LATE');
      } catch {
        // A note is for the caller's trace; its failure changes nothing.
      }
      return timed;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const rules = (reasonCode: string, extra: Partial<Parameters<typeof make>[0]> = {}): Promise<FailureAdvice> => finish(make({ step: plan.step, next: plan.next, source: 'rules', reasonCode, ...extra }));

  // The rules settle everything: no question to ask.
  if (!plan.askSame && !plan.askNext) return rules(plan.sureCode ?? 'REPEATED_FAILURE_RULES_SURE');
  const gate = failureAskGate({ ...options, engine });
  if (gate !== null || engine === null) return rules(gate ?? 'REPEATED_FAILURE_NO_PROVIDER');

  const facts = failureFacts(c);
  const revision = revisionOf(facts, plan);
  const grace = options.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  const deadline = Math.max(1, Math.floor(options.deadlineMs + grace));
  const idFields = {
    workspaceId: options.ids.workspaceId,
    evidenceRevision: revision,
    ...(options.ids.taskId === undefined || options.ids.taskId === null ? {} : { taskId: options.ids.taskId }),
    ...(options.ids.sessionId === undefined || options.ids.sessionId === null ? {} : { sessionId: options.ids.sessionId }),
  };
  // The two questions need nothing from each other: side by side, so the wait is one request, not two.
  const sameRun = plan.askSame
    ? raceDeadline(
        askBoundedDecision(
          engine,
          REPEATED_FAILURE_SPEC_ID,
          failureQuestions(plan),
          { objective: 'Decide whether the latest tool failure is the same failure as the previous one (advice only).', trustedPolicy: { grantsAuthority: false, kinds: [...FAILURE_ARTIFACT_IDS] }, facts, evidence: [] },
          { ...idFields, deadlineMs: deadline },
          false,
        ),
        options.deadlineMs,
      )
    : Promise.resolve(null);
  // C05: the evidence the failure already shows is what is available; the candidates are what could be obtained. Fixed ids only.
  const artifact = (id: FailureArtifactId, available: boolean) => ({ id, description: FAILURE_ARTIFACT_TEXT[id].phrase, available, fresh: available ? true : null });
  const intentCtx: IntentContext = { ...idFields, deadlineMs: deadline };
  const nextRun = plan.askNext
    ? raceDeadlineOf(
        checkEvidenceSufficiency(
          engine,
          { objective: 'Decide which one kind of evidence would help most with a repeated tool failure, from the listed kinds (advice only).', objectiveIsFixed: true, required: c.features.present.map((id) => artifact(id, true)), obtainable: plan.candidates.map((id) => artifact(id, false)), approvedRoots: [], facts },
          intentCtx,
        ),
        options.deadlineMs,
      )
    : Promise.resolve(null);
  const [same, sufficiency] = await Promise.all([sameRun, nextRun]);

  // A request that missed (abandoned at the deadline, threw, refused or abstained) leaves the rules advice standing.
  const miss = (code: string, asked: boolean, decisionId: string | null = null): Miss => ({ code: code.slice(0, 64), asked, decisionId });
  const sameMiss: Miss | null = same === null ? null : same === 'late' ? miss('REPEATED_FAILURE_DEADLINE', true) : same === 'failed' ? miss('REPEATED_FAILURE_ERROR', true) : same.ok ? null : miss(`REPEATED_FAILURE_JEV_${same.reasonCode}`, !refusedBeforeSending(same.reasonCode), same.decisionId);
  const nextMiss: Miss | null =
    sufficiency === null
      ? null
      : sufficiency === 'late'
        ? miss('REPEATED_FAILURE_DEADLINE', true)
        : sufficiency === 'failed'
          ? miss('REPEATED_FAILURE_ERROR', true)
          : sufficiency.outcome === 'undetermined' && !C05_ANSWERED.has(sufficiency.reasonCode)
            ? miss(`REPEATED_FAILURE_JEV_${sufficiency.reasonCode}`, !refusedBeforeSending(sufficiency.reasonCode), sufficiency.decisionId)
            : null;
  const wanted = (plan.askSame ? 1 : 0) + (plan.askNext ? 1 : 0);
  const misses = [sameMiss, nextMiss].filter((m): m is Miss => m !== null);
  const askedCount = (plan.askSame && (sameMiss === null || sameMiss.asked) ? 1 : 0) + (plan.askNext && (nextMiss === null || nextMiss.asked) ? 1 : 0);
  if (misses.length === wanted) {
    const first = misses[0] as Miss;
    const jevDecisionId = misses.map((m) => m.decisionId).find((id) => id !== null) ?? null;
    return rules(first.code, askedCount > 0 ? { asked: true, askedCount, jevDecisionId } : { jevDecisionId });
  }

  const sameAnswers = same !== null && typeof same === 'object' && same.ok ? same : null;
  const sufficiencyResult: SufficiencyResult | null = sufficiency !== null && typeof sufficiency === 'object' && nextMiss === null ? sufficiency : null;
  const decisionIds = [sameAnswers?.decisionId ?? null, sufficiencyResult?.decisionId ?? null].filter((id): id is string => id !== null);
  const hits = await Promise.all(decisionIds.map((id) => cacheHitOf(engine, id)));
  const cacheHit = decisionIds.length === 0 ? null : hits.every((h) => h === true) ? true : hits.some((h) => h === null) ? null : false;
  let used = 0;
  let answered = 0;
  let next = plan.next;
  let step = plan.step;
  let silent = false;
  let sameByJev = false;
  let notSame = false;
  let sufficientByJev = false;
  let confidentUnusable = false;
  if (sameAnswers !== null) {
    const p = noulProbability(sameAnswers.answers, 'same');
    if (p !== null) {
      answered += 1;
      if (Math.max(p, 1 - p) >= FAILURE_MIN_CONFIDENCE) {
        used += 1;
        if (p >= 0.5) sameByJev = true;
        else notSame = true;
      }
    }
  }
  if (sufficiencyResult !== null && !notSame) {
    if (sufficiencyResult.outcome === 'request-artifact') {
      answered += 1;
      used += 1;
      if ((plan.candidates as readonly string[]).includes(sufficiencyResult.artifact.id)) next = sufficiencyResult.artifact.id as FailureArtifactId;
    } else if (sufficiencyResult.outcome === 'sufficient') {
      // Jev says the evidence so far is enough to choose a fix: naming more to collect would contradict it.
      answered += 1;
      used += 1;
      step = 'none';
      next = null;
      silent = true;
      sufficientByJev = true;
    } else if (sufficiencyResult.reasonCode !== 'NO_ANSWER') {
      answered += 1;
      if (sufficiencyResult.jevSaid === 'none') {
        // Jev says no listed kind of evidence would help: say nothing rather than name one.
        used += 1;
        step = 'none';
        next = null;
        silent = true;
      } else if (sufficiencyResult.reasonCode !== 'LOW_CONFIDENCE') {
        // Sure of a choice that names no listed kind of evidence (for example "unknown"): nothing to name.
        confidentUnusable = true;
      }
    }
  }
  const base = { asked: true, askedCount, cacheHit, jevDecisionId: decisionIds[0] ?? null, usedCount: used, sameByJev, sufficientByJev };
  if (notSame) return rules('REPEATED_FAILURE_NOT_SAME', { ...base, source: 'jev', silent: true });
  if (used === 0) return rules(answered === 0 ? 'REPEATED_FAILURE_JEV_NO_ANSWER' : confidentUnusable ? 'REPEATED_FAILURE_JEV_UNUSABLE' : 'REPEATED_FAILURE_JEV_LOW_CONFIDENCE', base);
  return finish(make({ step, next, source: 'jev', reasonCode: used === askedCount ? 'REPEATED_FAILURE_JEV' : 'REPEATED_FAILURE_JEV_PARTIAL', ...base, silent }));
}
