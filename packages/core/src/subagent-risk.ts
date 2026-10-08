/**
 * Per-launch risk of one subagent (owner decision 2026-10-08, DOMAINS: "Jevris can always choose a
 * lower model for a subagent / function if it's deemed low risk, without necessarily changing the
 * current model permanently"). It reverses the abstain-only line of 9ce2ba5 for Claude Code.
 *
 * One Agent launch is judged low, medium or high risk from CONTENT-FREE features only: the
 * subagent type over a fixed vocabulary (read-only built-in, general-purpose, custom) and a size
 * bucket of the tool input. The prompt and the description never reach this module, so they can
 * never leave the machine; a feature that is not a class, a bucket or a count is not added here.
 *
 * - Rules answer first. A read-only built-in type (Explore, Plan) is low risk (medium when its input is
 *   large or its size unknown). A general-purpose or custom type may edit, so the rules never route it on
 *   size alone: their answer is HIGH, which changes nothing, and the subagent keeps the session's model.
 * - Jev is asked ONE bounded Choice (low, medium, high, unknown) for those write-capable types, and only
 *   for them (a read-only built-in is settled by the rules and never asked). Its answer is used only at
 *   confidence 0.6 and a 0.15 margin (the floors of the slice classifier, the new-task adviser, the check
 *   ranking and the failure advice), and then it may LOWER the level from high to medium or low. This is
 *   the one question where Jev lowers rather than raises (owner review 2026-10-08): the rules' default is
 *   the safe answer (no change), so Jev's answer can only unlock a cheaper model, never remove a gate.
 *   Any failure, abstention, `unknown`, `high`, low confidence, no engine, `jev.assist` off, no budget, an
 *   open circuit or a missed deadline leaves the rules' HIGH standing. Jev never overrides an explicit
 *   model, a pin, the mode, consent or a lifecycle gate (the route applies them all after this), and its
 *   answer is advice.
 * - The result is advice about a model for one call. It never changes the session's model, a
 *   permission, a verification or an egress rule.
 *
 * Pure but for the one engine call: no clock read other than the injected one, no I/O.
 */
import type { JevQuestions } from '@jevris/contracts';
import type { DecisionEngine } from './decision-engine.js';
import { askBoundedDecision, INTENT_MIN_CONFIDENCE, INTENT_MIN_MARGIN, type IntentContext } from './intent-decisions.js';
import { SUBAGENT_RISK_SPEC_ID } from './subagent-risk-explain.js';

export { SUBAGENT_RISK_SPEC_ID } from './subagent-risk-explain.js';

export const SUBAGENT_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type SubagentRiskLevel = (typeof SUBAGENT_RISK_LEVELS)[number];
const RANK: Readonly<Record<SubagentRiskLevel, number>> = { low: 0, medium: 1, high: 2 };

/** The fixed vocabulary a subagent type is reduced to. A type that names none of it is `custom`. */
export const SUBAGENT_CLASSES = ['read-only', 'general-purpose', 'custom'] as const;
export type SubagentClass = (typeof SUBAGENT_CLASSES)[number];

/**
 * Claude Code's built-in subagent types that read and search but never edit (their tool lists carry no
 * Edit, Write or Bash): the rules call a launch of one low risk. Compared case-insensitively.
 */
export const READ_ONLY_SUBAGENT_TYPES: readonly string[] = Object.freeze(['explore', 'plan']);
const GENERAL_PURPOSE_TYPE = 'general-purpose';

/** Tool-input size buckets, in bytes: under 1 KiB is small, under 4 KiB medium, else large. */
export const SUBAGENT_SIZE_SMALL_BYTES = 1024;
export const SUBAGENT_SIZE_MEDIUM_BYTES = 4096;
export const SUBAGENT_SIZES = ['small', 'medium', 'large'] as const;
export type SubagentInputSize = (typeof SUBAGENT_SIZES)[number];

/** The content-free features of one launch. */
export interface SubagentRiskFeatures {
  readonly subagentClass: SubagentClass;
  readonly size: SubagentInputSize;
  /** How many keys the tool input carries (a count, never the names). */
  readonly keys: number;
}

export function subagentClassOf(subagentType: string | null | undefined): SubagentClass {
  if (typeof subagentType !== 'string') return 'custom';
  const type = subagentType.trim().toLowerCase();
  if (READ_ONLY_SUBAGENT_TYPES.includes(type)) return 'read-only';
  return type === GENERAL_PURPOSE_TYPE ? 'general-purpose' : 'custom';
}

export function sizeOfToolInput(bytes: number | null | undefined): SubagentInputSize {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'large';
  return bytes < SUBAGENT_SIZE_SMALL_BYTES ? 'small' : bytes < SUBAGENT_SIZE_MEDIUM_BYTES ? 'medium' : 'large';
}

/** The content-free features from what the adapter's event carries: the type, the input's byte size and its key count. Pure. */
export function subagentRiskFeatures(input: { readonly subagentType?: string | null; readonly toolInputBytes?: number | null; readonly toolInputKeys?: number | null }): SubagentRiskFeatures {
  const keys = typeof input.toolInputKeys === 'number' && Number.isFinite(input.toolInputKeys) ? Math.max(0, Math.min(64, Math.floor(input.toolInputKeys))) : 0;
  return { subagentClass: subagentClassOf(input.subagentType), size: sizeOfToolInput(input.toolInputBytes), keys };
}

/**
 * The rules' level. A read-only built-in is low (a large or unknown-size input makes it medium: a long brief
 * for a planner or searcher is real work). A general-purpose or custom type may edit, so the rules answer high
 * whatever the size: no change of model unless Jev's answer clears the floors and lowers it.
 */
export function rulesSubagentRisk(f: SubagentRiskFeatures): SubagentRiskLevel {
  if (f.subagentClass === 'read-only') return f.size === 'large' ? 'medium' : 'low';
  return 'high';
}

/** Whether Jev is asked: only for a write-capable type (general-purpose or custom), where the rules' high is all that stands without its answer. */
export function subagentRiskNeedsJev(f: SubagentRiskFeatures): boolean {
  return f.subagentClass !== 'read-only';
}

const DEFINITIONS: Readonly<Record<SubagentRiskLevel | 'unknown', string>> = {
  low: 'A launch whose brief is so small and bounded that a cheaper, weaker model does it as well as a stronger one, with little to get wrong.',
  medium: 'A short, bounded launch of a general or custom subagent: it may edit, but the brief is small enough that a mid-sized model does it well.',
  high: 'A launch that may need careful reasoning or touch much, or that the features do not show to be small: a cheaper model risks a worse result, so the subagent keeps the session model.',
  unknown: 'The listed features are not enough to judge how risky the launch is.',
};

/** The one question: a Choice over low, medium, high and unknown. Fixed text; no user text. */
export function subagentRiskQuestions(): JevQuestions {
  return {
    risk: {
      type: 'choice',
      instructions: 'How risky is it to run this write-capable subagent launch on a cheaper model, judging only from the structured features of the launch (its type class and the size of its input)?',
      criteria: { low: DEFINITIONS.low, medium: DEFINITIONS.medium, high: DEFINITIONS.high, unknown: DEFINITIONS.unknown },
    },
  } as unknown as JevQuestions;
}

function featureFacts(f: SubagentRiskFeatures): Record<string, string | number> {
  return { subagentClass: f.subagentClass, inputSize: f.size, inputKeys: f.keys, rulesLevel: rulesSubagentRisk(f) };
}

export type SubagentRiskSource = 'rules' | 'jev';

export interface SubagentRiskJudgement {
  /** The level to route by: the higher of the rules' and Jev's. */
  readonly level: SubagentRiskLevel;
  readonly source: SubagentRiskSource;
  readonly subagentClass: SubagentClass;
  readonly size: SubagentInputSize;
  readonly rulesLevel: SubagentRiskLevel;
  /** What Jev answered even when it was not used; null when it did not answer. */
  readonly jevLevel: SubagentRiskLevel | null;
  readonly confidence: number | null;
  /** Why: `SUBAGENT_RISK_*` code, content-free. */
  readonly reasonCode: string;
  readonly asked: boolean;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** The advisory record of this judgement; null when none was recorded. */
  readonly decisionId: string | null;
  /** The Jev call's own decision id, when Jev was asked. */
  readonly jevDecisionId: string | null;
  readonly evidenceIds: readonly string[];
}

export interface SubagentRiskOptions {
  /** `off` is `jev.assist off`: Jev is not asked. */
  readonly assist: 'off' | 'classify';
  /** Record the judgement as an advisory decision (default true). */
  readonly record?: boolean;
  readonly now?: () => number;
  /** Do not ask Jev: the answer is the rules' and carries this reason code (a gate that applies). */
  readonly skipAsk?: string;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function rulesJudgement(f: SubagentRiskFeatures, reasonCode: string, extra: Partial<SubagentRiskJudgement> = {}): SubagentRiskJudgement {
  return {
    level: rulesSubagentRisk(f),
    source: 'rules',
    subagentClass: f.subagentClass,
    size: f.size,
    rulesLevel: rulesSubagentRisk(f),
    jevLevel: null,
    confidence: null,
    reasonCode,
    asked: false,
    cacheHit: null,
    latencyMs: null,
    decisionId: null,
    jevDecisionId: null,
    evidenceIds: ['feature-subagent-class', 'feature-input-size', 'feature-input-keys'],
    ...extra,
  };
}

/** The reason codes of the recorded decision: every one reads back through `subagentRiskLines`. */
export function subagentRiskReasonCodes(j: SubagentRiskJudgement, extra: readonly string[] = []): string[] {
  const codes = [
    `SUBAGENT_RISK_SOURCE_${j.source.toUpperCase()}`,
    `SUBAGENT_RISK_CLASS_${j.subagentClass.toUpperCase().replace(/-/g, '_')}`,
    `SUBAGENT_RISK_SIZE_${j.size.toUpperCase()}`,
    `SUBAGENT_RISK_LEVEL_${j.level.toUpperCase()}`,
    `SUBAGENT_RISK_RULES_${j.rulesLevel.toUpperCase()}`,
    ...(j.jevLevel === null ? [] : [`SUBAGENT_RISK_JEV_${j.jevLevel.toUpperCase()}`]),
    ...(j.asked ? [j.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    ...(j.confidence === null ? [] : [`CONF_${String(Math.round(j.confidence * 100))}`]),
    j.reasonCode,
    ...extra,
  ];
  return codes.filter((c) => REASON_CODE.test(c));
}

async function cacheHitOf(engine: DecisionEngine, decisionId: string): Promise<boolean | null> {
  try {
    const record = await engine.lookup(decisionId);
    return record === null ? null : record.reasonCodes.includes('CACHE_HIT');
  } catch {
    return null;
  }
}

function choiceOf(answers: Readonly<Record<string, { readonly type: string; readonly [key: string]: unknown }>>): { readonly choice: string; readonly confidence: number; readonly margin: number } | null {
  const a = answers['risk'];
  if (a === undefined || a.type !== 'choice' || typeof a['choice'] !== 'string') return null;
  const raw = a['probabilities'];
  const values = raw !== null && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>).filter((p): p is number => typeof p === 'number' && Number.isFinite(p)) : [];
  const sorted = [...values].sort((x, y) => y - x);
  const top = sorted[0] ?? 0;
  const confidence = typeof a['confidence'] === 'number' && Number.isFinite(a['confidence']) ? a['confidence'] : top;
  return { choice: a['choice'], confidence, margin: top - (sorted[1] ?? 0) };
}

/**
 * Judges one launch. Never throws and never waits past the context's deadline for Jev: any failure
 * is the rules' answer. Jev is asked only where `subagentRiskNeedsJev`, with `assist` on and no
 * gate; for a write-capable type the answer may lower the rules' high, at the floors.
 */
export async function judgeSubagentRisk(engine: DecisionEngine | null, features: SubagentRiskFeatures, ctx: IntentContext, options: SubagentRiskOptions): Promise<SubagentRiskJudgement> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const finish = (j: SubagentRiskJudgement): Promise<SubagentRiskJudgement> => record(engine, j, ctx, options.record !== false, now() - started);
  if (!subagentRiskNeedsJev(features)) return finish(rulesJudgement(features, 'SUBAGENT_RISK_RULES_SURE'));
  if (options.skipAsk !== undefined) return finish(rulesJudgement(features, REASON_CODE.test(options.skipAsk) ? options.skipAsk : 'SUBAGENT_RISK_ASSIST_OFF'));
  if (options.assist === 'off') return finish(rulesJudgement(features, 'SUBAGENT_RISK_ASSIST_OFF'));
  if (engine === null) return finish(rulesJudgement(features, 'PROVIDER_NOT_CONFIGURED'));
  const packet = {
    objective: 'Judge how risky it is to run one coding-agent subagent launch on a cheaper model, from its structured features (advice only).',
    trustedPolicy: { levels: [...SUBAGENT_RISK_LEVELS], grantsAuthority: false },
    facts: featureFacts(features),
    evidence: [],
  };
  const asked = await askBoundedDecision(engine, SUBAGENT_RISK_SPEC_ID, subagentRiskQuestions(), packet, ctx, false);
  const latencyMs = Math.round(now() - started);
  if (!asked.ok) return finish(rulesJudgement(features, `SUBAGENT_RISK_JEV_${asked.reasonCode}`.slice(0, 64), { asked: true, latencyMs, jevDecisionId: asked.decisionId }));
  const cacheHit = await cacheHitOf(engine, asked.decisionId);
  const base = { asked: true, cacheHit, latencyMs, jevDecisionId: asked.decisionId };
  const choice = choiceOf(asked.answers);
  if (choice === null) return finish(rulesJudgement(features, 'SUBAGENT_RISK_JEV_NO_ANSWER', base));
  const jevLevel = (SUBAGENT_RISK_LEVELS as readonly string[]).includes(choice.choice) ? (choice.choice as SubagentRiskLevel) : null;
  const common = { ...base, jevLevel, confidence: Math.round(choice.confidence * 100) / 100 };
  if (jevLevel === null) return finish(rulesJudgement(features, choice.choice === 'unknown' ? 'SUBAGENT_RISK_JEV_UNKNOWN' : 'SUBAGENT_RISK_JEV_UNKNOWN_OPTION', common));
  if (choice.confidence < INTENT_MIN_CONFIDENCE || choice.margin < INTENT_MIN_MARGIN) return finish(rulesJudgement(features, 'SUBAGENT_RISK_JEV_LOW_CONFIDENCE', common));
  const rules = rulesSubagentRisk(features);
  // Owner review 2026-10-08: for this question Jev may LOWER the level, from the rules' high to medium or low, at the floors.
  if (RANK[jevLevel] >= RANK[rules]) return finish(rulesJudgement(features, 'SUBAGENT_RISK_JEV_HIGH', common));
  return finish({ ...rulesJudgement(features, 'SUBAGENT_RISK_JEV_LOWERED', common), level: jevLevel, source: 'jev' });
}

async function record(engine: DecisionEngine | null, j: SubagentRiskJudgement, ctx: IntentContext, on: boolean, elapsedMs: number): Promise<SubagentRiskJudgement> {
  const withLatency = j.latencyMs === null && j.asked ? { ...j, latencyMs: Math.round(elapsedMs) } : j;
  if (!on || engine === null || engine.recordAdvice === undefined) return withLatency;
  try {
    const recorded = await engine.recordAdvice({
      specId: SUBAGENT_RISK_SPEC_ID,
      workspaceId: ctx.workspaceId,
      evidenceRevision: ctx.evidenceRevision,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
      action: { kind: 'advise', templateId: SUBAGENT_RISK_SPEC_ID, evidenceIds: [...j.evidenceIds].slice(0, 16) },
      reasonCodes: subagentRiskReasonCodes(j),
      durationMs: Math.max(0, Math.round(elapsedMs)),
    });
    return recorded.ok ? { ...withLatency, decisionId: recorded.decisionId } : withLatency;
  } catch {
    return withLatency;
  }
}
