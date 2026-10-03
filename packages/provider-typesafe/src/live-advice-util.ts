/**
 * Small helpers the two live advisers share (repeated-failure and new-task advice): reading a
 * Choice or Noul answer, racing one Jev request against the caller's deadline, and the reason-code
 * filter. Nothing here talks to a provider on its own.
 */
import type { askBoundedDecision } from '@jevris/core';

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Reason codes that read back through the explain lines: upper snake case, at most 64 characters. */
export function validReasonCodes(codes: readonly string[]): string[] {
  return codes.filter((code) => REASON_CODE.test(code));
}

/** A code fragment from an id (`failing-test-output` is `FAILING_TEST_OUTPUT`). */
export function codeOf(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

export type Asked = Awaited<ReturnType<typeof askBoundedDecision>>;
export type Answers = Extract<Asked, { readonly ok: true }>['answers'];

export interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly margin: number;
}

/** A Choice answer's option, its confidence and its margin over the runner-up; null when there is none. */
export function choiceAnswer(answers: Answers, id: string): ChoiceAnswer | null {
  const a = answers[id];
  if (a === undefined || a.type !== 'choice' || typeof a['choice'] !== 'string') return null;
  const raw = a['probabilities'];
  const values = raw !== null && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>).filter((p): p is number => typeof p === 'number' && Number.isFinite(p)) : [];
  const sorted = [...values].sort((x, y) => y - x);
  const top = sorted[0] ?? 0;
  const confidence = typeof a['confidence'] === 'number' && Number.isFinite(a['confidence']) ? a['confidence'] : top;
  return { choice: a['choice'], confidence, margin: top - (sorted[1] ?? 0) };
}

/** A Noul answer's probability of `true`; null when there is none. */
export function noulProbability(answers: Answers, id: string): number | null {
  const a = answers[id];
  return a !== undefined && a.type === 'noul' && typeof a['noul'] === 'number' && Number.isFinite(a['noul']) ? a['noul'] : null;
}

/**
 * The refusals that happen on this machine, before anything is sent: the audit trail says Jev was
 * not asked for these (a secret in the request, source egress not approved, no provider, a lint of
 * the questions, evidence missing, no budget, an open circuit, the kill switch, a request over the cap).
 */
const LOCAL_REFUSAL = /^(?:SECRET_BLOCKED|EGRESS_NOT_APPROVED|PROVIDER_NOT_CONFIGURED|QUESTION_LINT|MISSING_EVIDENCE|REQUIRED_EVIDENCE_OMITTED|JOURNAL_UNAVAILABLE|KILL_SWITCH|CIRCUIT_OPEN|REQUEST_TOO_LARGE|TOO_MANY_QUESTIONS|OVER_BUDGET|BUDGET(?:_[A-Z_]+)?)$/;

/** Whether an abstention's reason means the engine refused before sending anything. */
export function refusedBeforeSending(reasonCode: string): boolean {
  return LOCAL_REFUSAL.test(reasonCode);
}

/**
 * Waits for one Jev request until `deadlineMs`, then abandons it: `'late'`. A late answer is not
 * wasted: the engine lets the request run on (its own deadline carries a grace) so the decision
 * cache is warm for the same question next time. A request that throws is `'failed'`.
 */
export async function raceDeadline(run: Promise<Asked>, deadlineMs: number): Promise<Asked | 'late' | 'failed'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), Math.max(1, Math.floor(deadlineMs)));
  });
  try {
    const raced = await Promise.race([run.catch(() => 'failed' as const), late]);
    if (raced === 'late') void run.catch(() => undefined);
    return raced;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Whether the recorded decision was answered from the cache (`CACHE_HIT`); null when it cannot be read. */
export async function cacheHitOf(engine: { lookup(id: string): Promise<{ readonly reasonCodes: readonly string[] } | null> }, decisionId: string): Promise<boolean | null> {
  try {
    const record = await engine.lookup(decisionId);
    return record === null ? null : record.reasonCodes.includes('CACHE_HIT');
  } catch {
    return null;
  }
}
