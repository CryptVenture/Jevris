/**
 * Consulting domain C's decision engine for D capabilities.
 *
 * The sidecar builds one engine (`createDecisionEngine` in @jevris/core) and hands it to op
 * handlers as `ctx.engine`. This module talks to it structurally (`engine.decide(request)`),
 * so D never constructs a provider. With no engine, an abstention, or a deadline too short
 * for a provider call, the deterministic rules answer instead and the result says so.
 *
 * Every consult is advice: it grants nothing, applies nothing and certifies nothing.
 */
import { DecisionSpecContract, MAX_QUESTIONS, questionHash, type DecisionSpec, type JevQuestions } from '@jevris/contracts';
import { safeText, sha256 } from '../util.js';

export type ConsultSource = 'jev' | 'rules';

export interface EvidenceItem {
  readonly id: string;
  readonly text: string;
  readonly sourceKind: 'user' | 'file' | 'tool' | 'policy' | 'receipt';
  readonly priority: 'mandatory' | 'high' | 'optional';
}

interface ConsultBase {
  /** Capability id, e.g. 'C29'. */
  readonly capabilityId: string;
  readonly specVersion: string;
  readonly objective: string;
  readonly workspaceId: string;
  readonly evidenceRevision: string;
  readonly evidence: readonly EvidenceItem[];
  readonly facts?: { readonly [key: string]: string | number | boolean | null };
  /**
   * Facts that name something read from the workspace (a package name, a tool name). They go into the
   * request only while source egress is approved; with egress denied the request carries `facts` alone,
   * which must hold counts, codes and flags only.
   */
  readonly approvedFacts?: { readonly [key: string]: string | number | boolean | null };
  /**
   * True when the question itself (an option text or key, the objective) carries text read from the
   * workspace or its tools: a skill, agent or tool description, a failure line, a module path, a saved
   * objective. The transport guard screens evidence text only, so such a question is asked only while
   * source egress is approved; with egress denied the rules answer and nothing is sent
   * (`EGRESS_NOT_APPROVED`).
   */
  readonly sendsWorkspaceText?: boolean;
  readonly taskId?: string | null;
  readonly deadlineMs?: number;
  /** Remaining time for this request; below `minProviderMs` the rules answer directly. */
  readonly remainingMs?: number;
  readonly minProviderMs?: number;
  readonly lane?: 'interactive' | 'background';
}

export interface ChoiceConsult extends ConsultBase {
  readonly instructions: string;
  readonly options: { readonly [key: string]: string };
  readonly rules: () => { readonly choice: string; readonly reasonCode: string };
}

export interface NoulConsult extends ConsultBase {
  readonly instructions: string;
  readonly whenTrue: string;
  readonly whenFalse: string;
  readonly rules: () => { readonly value: boolean; readonly reasonCode: string };
}

export interface ScoreConsult extends ConsultBase {
  readonly instructions: string;
  /** 2..10 ordinal anchors, lowest first. */
  readonly anchors: readonly string[];
  readonly rules: () => { readonly score: number; readonly reasonCode: string };
}

export interface ConsultResult<T> {
  readonly value: T;
  readonly source: ConsultSource;
  readonly reasonCode: string;
  readonly decisionId: string | null;
  readonly confidence: number | null;
  readonly probabilities: { readonly [key: string]: number } | null;
}

interface EngineLike {
  decide(request: unknown, options?: unknown): Promise<unknown>;
  /** The administrator's source-egress setting as the engine reads it (`approved` or `denied`). */
  sourceEgress?(): unknown;
}

/** Whether the engine's packet builder lets evidence and workspace text out. An engine that cannot say reads as denied. */
function egressApproved(engine: EngineLike): boolean {
  try {
    return engine.sourceEgress?.() === 'approved';
  } catch {
    return false;
  }
}

function engineOf(engine: unknown): EngineLike | null {
  return engine !== null && typeof engine === 'object' && typeof (engine as { decide?: unknown }).decide === 'function' ? (engine as EngineLike) : null;
}

/** Time kept back from the engine to build and send the answer. */
export const DEADLINE_MARGIN_MS = 150;

function specFor(base: ConsultBase, questions: JevQuestions): DecisionSpec | null {
  const spec = {
    id: `d-${base.capabilityId.toLowerCase()}`,
    version: base.specVersion,
    questionHash: questionHash(questions),
    evidenceRequirements: [],
    // The engine settles inside the op's own budget: its deadline never outlives the time the
    // request has left (less a margin to answer), so the caller gets this decision, not a timeout.
    deadlineMs: Math.max(1, Math.min(base.deadlineMs ?? 5_000, 600_000, base.remainingMs === undefined ? Infinity : Math.floor(base.remainingMs - DEADLINE_MARGIN_MS))),
    fallback: 'rules-only' as const,
    calibrationId: null,
  };
  return DecisionSpecContract.validate(spec).ok ? spec : null;
}

type Answers = { readonly [key: string]: unknown };
type Asked = { readonly answer: Answers | null; /** Every answer of the request, by question id. */ readonly answers: { readonly [id: string]: Answers }; readonly decisionId: string | null; readonly reasonCode: string };

async function ask(engine: unknown, base: ConsultBase, questions: JevQuestions): Promise<Asked> {
  const none = (decisionId: string | null, reasonCode: string): Asked => ({ answer: null, answers: {}, decisionId, reasonCode });
  const e = engineOf(engine);
  if (e === null) return none(null, 'NO_ENGINE');
  const approved = egressApproved(e);
  if (base.sendsWorkspaceText === true && !approved) return none(null, 'EGRESS_NOT_APPROVED');
  if (base.remainingMs !== undefined && base.remainingMs < (base.minProviderMs ?? 400)) return none(null, 'DEADLINE_SHORT');
  const spec = specFor(base, questions);
  if (spec === null) return none(null, 'SPEC_INVALID');
  try {
    const outcome = (await e.decide({
      spec,
      questions,
      packet: {
        objective: safeText(base.objective, 2000),
        trustedPolicy: { capability: base.capabilityId, grantsAuthority: false },
        facts: { ...(base.facts ?? {}), ...(approved ? (base.approvedFacts ?? {}) : {}) },
        evidence: base.evidence.slice(0, 64).map((item) => ({ ...item, text: safeText(item.text, 3000) })),
      },
      workspaceId: base.workspaceId,
      evidenceRevision: base.evidenceRevision,
      lane: base.lane ?? 'background',
      ...(base.taskId === undefined || base.taskId === null ? {} : { taskId: base.taskId }),
    })) as { readonly abstained?: boolean; readonly reasonCode?: string; readonly decisionId?: string; readonly result?: { readonly answers?: { readonly [key: string]: unknown } } };
    if (outcome === null || typeof outcome !== 'object') return none(null, 'ENGINE_INVALID');
    const decisionId = typeof outcome.decisionId === 'string' ? outcome.decisionId : null;
    if (outcome.abstained === true) return none(decisionId, typeof outcome.reasonCode === 'string' ? outcome.reasonCode : 'ABSTAINED');
    const answer = outcome.result?.answers?.['q'];
    const answers: { [id: string]: Answers } = {};
    for (const [id, a] of Object.entries(outcome.result?.answers ?? {})) if (a !== null && typeof a === 'object') answers[id] = a as Answers;
    return { answer: answer !== null && typeof answer === 'object' ? (answer as Answers) : null, answers, decisionId, reasonCode: 'JEV' };
  } catch {
    return none(null, 'ENGINE_ERROR');
  }
}

function probs(value: unknown): { readonly [key: string]: number } | null {
  if (value === null || typeof value !== 'object') return null;
  const out: { [key: string]: number } = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v;
  return out;
}

/**
 * The floors every other Jev consumer applies (the route slice classifier, the new-task adviser, the check
 * ranking, the failure advice): an answer is used at a provider confidence of 0.6 or more, and a Choice also
 * needs its best option 0.15 ahead of the next. A capability consult had no floor at all: measured live
 * (jev-1.13.0, 2026-10-03), 12 of 33 consult answers came back below 0.6 (a canary module chosen at 0.24, a
 * host-triage recommendation at 0.16) and were used as if Jev were sure. Below a floor the rules answer and
 * the result says so (`confidence` holds what Jev reported).
 */
export const CONSULT_MIN_CONFIDENCE = 0.6;
export const CONSULT_MIN_MARGIN = 0.15;

/** The best option's lead over the next, from a distribution; 1 when there is no second option to compare. */
function marginOf(probabilities: { readonly [key: string]: number } | null): number {
  if (probabilities === null) return 1;
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  return sorted.length < 2 ? 1 : (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

/** The option keys the question contract accepts; any other id is sent as `option_<n>` and mapped back. */
const WIRE_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export async function consultChoice(engine: unknown, input: ChoiceConsult): Promise<ConsultResult<string>> {
  const keys = Object.keys(input.options);
  // A Choice needs two options. With fewer there is nothing to choose between: the rules answer and no
  // decision is built, refused and recorded for nothing (live: C32 on four of five harnesses, C26 with one agent).
  if (keys.length < 2) {
    const rules = input.rules();
    return { value: rules.choice, source: 'rules', reasonCode: rules.reasonCode, decisionId: null, confidence: null, probabilities: null };
  }
  // A skill, agent or tool name may hold a dot, a colon or start with a digit, which the question contract
  // refuses as a key (one such name turned Jev off for the whole list). Such ids go out as option_<n>.
  const wire = new Map<string, string>();
  const original = new Map<string, string>();
  keys.forEach((key, i) => {
    const sent = WIRE_KEY.test(key) && !/^option_\d+$/.test(key) ? key : `option_${String(i + 1)}`;
    wire.set(key, sent);
    original.set(sent, key);
  });
  const criteria: { [key: string]: string } = {};
  for (const key of keys) criteria[wire.get(key) as string] = input.options[key] as string;
  const questions = { q: { type: 'choice' as const, instructions: input.instructions, criteria } };
  const got = await ask(engine, input, questions);
  const choice = got.answer?.['choice'];
  const mapped = typeof choice === 'string' ? original.get(choice) : undefined;
  if (mapped !== undefined) {
    const probabilities = probs(got.answer?.['probabilities']);
    const confidence = typeof got.answer?.['confidence'] === 'number' ? (got.answer['confidence'] as number) : null;
    const mappedProbabilities = probabilities === null ? null : Object.fromEntries(Object.entries(probabilities).map(([k, v]) => [original.get(k) ?? k, v]));
    // An answer the engine validated always carries its confidence; one that does not is not trusted.
    if (confidence !== null && confidence >= CONSULT_MIN_CONFIDENCE && marginOf(probabilities) >= CONSULT_MIN_MARGIN) {
      return { value: mapped, source: 'jev', reasonCode: 'JEV_CHOICE', decisionId: got.decisionId, confidence, probabilities: mappedProbabilities };
    }
    const rules = input.rules();
    return { value: rules.choice, source: 'rules', reasonCode: rules.reasonCode, decisionId: got.decisionId, confidence, probabilities: mappedProbabilities };
  }
  const rules = input.rules();
  return { value: rules.choice, source: 'rules', reasonCode: rules.reasonCode, decisionId: got.decisionId, confidence: null, probabilities: null };
}

export async function consultNoul(engine: unknown, input: NoulConsult): Promise<ConsultResult<boolean>> {
  const questions = { q: { type: 'noul' as const, instructions: input.instructions, criteria: { true: input.whenTrue, false: input.whenFalse } } };
  const got = await ask(engine, input, questions);
  const p = got.answer?.['noul'];
  if (typeof p === 'number' && p >= 0 && p <= 1) {
    const certainty = Math.max(p, 1 - p);
    if (certainty >= CONSULT_MIN_CONFIDENCE) return { value: p >= 0.5, source: 'jev', reasonCode: 'JEV_NOUL', decisionId: got.decisionId, confidence: certainty, probabilities: { true: p, false: 1 - p } };
    const rules = input.rules();
    return { value: rules.value, source: 'rules', reasonCode: rules.reasonCode, decisionId: got.decisionId, confidence: certainty, probabilities: { true: p, false: 1 - p } };
  }
  const rules = input.rules();
  return { value: rules.value, source: 'rules', reasonCode: rules.reasonCode, decisionId: got.decisionId, confidence: null, probabilities: null };
}

export async function consultScore(engine: unknown, input: ScoreConsult): Promise<ConsultResult<number>> {
  const questions = { q: { type: 'score' as const, instructions: input.instructions, criteria: [...input.anchors] } };
  const got = await ask(engine, input, questions);
  const score = got.answer?.['score'];
  if (typeof score === 'number' && score >= 0 && score <= input.anchors.length - 1) {
    const confidence = typeof got.answer?.['confidence'] === 'number' ? (got.answer['confidence'] as number) : null;
    const probabilities = probs(got.answer?.['probabilities']);
    if (confidence !== null && confidence >= CONSULT_MIN_CONFIDENCE) return { value: score, source: 'jev', reasonCode: 'JEV_SCORE', decisionId: got.decisionId, confidence, probabilities };
    const rules = input.rules();
    return { value: rules.score, source: 'rules', reasonCode: rules.reasonCode, decisionId: got.decisionId, confidence, probabilities };
  }
  const rules = input.rules();
  return { value: rules.score, source: 'rules', reasonCode: rules.reasonCode, decisionId: got.decisionId, confidence: null, probabilities: null };
}

// ------------------------------------------------------------------------------ several Scores in one request

/** The most questions one request carries (the contracts' cap): one Score per item, so twelve items. */
export const SCORE_BATCH_ITEMS = MAX_QUESTIONS;
/** The most evidence bytes (UTF-8) one batched request carries: a chunk is cut here too, under the request byte cap (131,072) with room for the questions and facts. */
export const SCORE_BATCH_BYTES = 96_000;
const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text.slice(0, 3000)).length;

export interface ScoreBatchItem {
  /** The one piece of evidence this item is judged on: a span of tool output, a remembered fact. Its text is led by the item's number in the request. */
  readonly evidence: EvidenceItem;
  /** The item's own fallback, used when Jev is not asked, misses, or answers below the confidence floor. */
  readonly rules: () => { readonly score: number; readonly reasonCode: string };
}

export interface ScoreBatchConsult extends Omit<ScoreConsult, 'evidence' | 'rules' | 'evidenceRevision'> {
  /** Evidence that every item is judged against (a question), sent once, ahead of the items'. */
  readonly shared?: readonly EvidenceItem[];
  /** What an item is called in the question and in its evidence: `span` gives "span 3". Fixed text, never the person's. */
  readonly noun: string;
  /** A stable name of the evidence as a whole; each request's revision is a digest of it and the items it carries. */
  readonly evidenceRevision: string;
  readonly items: readonly ScoreBatchItem[];
}

/**
 * Consults several Scores that share one question: all of them in as few requests as the 12-question cap and the
 * evidence size allow, instead of one request each (the plan's slice labels do the same: a request of 12 questions
 * took about as long as one, and fewer calls cost less). Each item keeps its own answer, its own confidence floor
 * (0.6, as `consultScore`), its own rules fallback and its own result, in the order given. A request holds one decision
 * record, which every item of it names (`decisionId`); each item's answer is under its own question id in that record.
 * An item alone, or a chunk of one, is asked the single way, so it shares the single-item decision cache. A request that
 * is refused, abstains or fails gives each of its items its rules answer. Never throws.
 */
export async function consultScoreBatch(engine: unknown, input: ScoreBatchConsult): Promise<ConsultResult<number>[]> {
  const results: ConsultResult<number>[] = new Array<ConsultResult<number>>(input.items.length);
  const rulesResult = (item: ScoreBatchItem, decisionId: string | null, confidence: number | null, probabilities: { readonly [key: string]: number } | null): ConsultResult<number> => {
    const r = item.rules();
    return { value: r.score, source: 'rules', reasonCode: r.reasonCode, decisionId, confidence, probabilities };
  };
  // Chunks, in order: at most 12 items, and at most SCORE_BATCH_BYTES of evidence text (the shared evidence counts against every chunk;
  // the text of an item is cut at 3000 characters, so a request of 3-byte characters is the one that reaches the byte cap first).
  const sharedBytes = (input.shared ?? []).reduce((n, e) => n + bytesOf(e.text), 0);
  const chunks: number[][] = [];
  let current: number[] = [];
  let bytes = sharedBytes;
  input.items.forEach((item, index) => {
    const size = bytesOf(item.evidence.text) + 16;
    if (current.length > 0 && (current.length >= SCORE_BATCH_ITEMS || bytes + size > SCORE_BATCH_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = sharedBytes;
    }
    current.push(index);
    bytes += size;
  });
  if (current.length > 0) chunks.push(current);

  await Promise.all(
    chunks.map(async (chunk) => {
      const only = chunk[0];
      if (chunk.length === 1 && only !== undefined) {
        const item = input.items[only] as ScoreBatchItem;
        results[only] = await consultScore(engine, { ...input, evidence: [...(input.shared ?? []), item.evidence], rules: item.rules, evidenceRevision: sha256(`${input.evidenceRevision}|${item.evidence.id}`).slice(0, 32) });
        return;
      }
      try {
        const label = (i: number): string => `${input.noun.charAt(0).toUpperCase()}${input.noun.slice(1)} ${String(i)}`;
        const questions: { [id: string]: unknown } = {};
        chunk.forEach((_, i) => {
          questions[`s${String(i)}`] = { type: 'score', instructions: `${input.instructions} This question is about ${input.noun} ${String(i)}: the evidence item that begins "${label(i)}:".`, criteria: [...input.anchors] };
        });
        const evidence: EvidenceItem[] = [...(input.shared ?? []), ...chunk.map((index, i) => ({ ...(input.items[index] as ScoreBatchItem).evidence, text: `${label(i)}: ${(input.items[index] as ScoreBatchItem).evidence.text}` }))];
        const base: ConsultBase = { ...input, evidence, evidenceRevision: sha256(`${input.evidenceRevision}|${chunk.map((i) => (input.items[i] as ScoreBatchItem).evidence.id).join(',')}`).slice(0, 32) };
        const got = await ask(engine, base, questions as unknown as JevQuestions);
        chunk.forEach((index, i) => {
          const item = input.items[index] as ScoreBatchItem;
          const answer = got.answers[`s${String(i)}`];
          const score = answer?.['score'];
          if (answer !== undefined && typeof score === 'number' && score >= 0 && score <= input.anchors.length - 1) {
            const confidence = typeof answer['confidence'] === 'number' ? (answer['confidence'] as number) : null;
            const probabilities = probs(answer['probabilities']);
            results[index] = confidence !== null && confidence >= CONSULT_MIN_CONFIDENCE ? { value: score, source: 'jev', reasonCode: 'JEV_SCORE', decisionId: got.decisionId, confidence, probabilities } : rulesResult(item, got.decisionId, confidence, probabilities);
          } else results[index] = rulesResult(item, got.decisionId, null, null);
        });
      } catch {
        // Left to the rules below.
      }
    }),
  );
  // An item no request settled (a chunk that threw) is the rules' own.
  input.items.forEach((item, index) => {
    if (results[index] === undefined) results[index] = rulesResult(item, null, null, null);
  });
  return results;
}
