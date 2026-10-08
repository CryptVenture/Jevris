/**
 * The model tier (owner decision 2026-10-08, tiered routing): how hard a piece of work is, and so which of the
 * models actually available to this session it should run on, from the baseline the session or task already has.
 *
 *   step-down  a cheaper model of the baseline's own provider
 *   baseline   the model the session or task approved
 *   step-up    a dearer model of the baseline's own provider, for very hard work
 *
 * One pure module, shared by every harness and every use site (an owned worker, a subagent, a main-session line).
 * It decides nothing about permissions, checks, budgets, consent or egress, and it is advice about difficulty: a use
 * site that actuates (an owned worker) applies its own gates first, and the tier only ever picks among the models the
 * caller passes in as eligible.
 *
 * PROVIDER-NEUTRAL. The baseline is the session's own (or the task's approved) model, whatever its provider. The
 * ladder is built from the models the caller passes (the router's eligibility, consent, lifecycle, harness-access and
 * serving-host gates have already run on them) and keeps only the baseline's own provider, by price. No model id is
 * written here: an Anthropic session gets Haiku, Sonnet and Opus, a Codex session the OpenAI rungs, an Antigravity
 * session the Google rungs, a Kilo or OpenCode session on any provider that provider's rungs. A model that is not
 * active (legacy, preview, deprecated), that the registry says is not zero-data-retention eligible (Fable 5.1), or that
 * is not a meaningful price step from the baseline (under 25 percent cheaper or dearer per attempt: a sibling, not a
 * tier) is never a rung, unless it is the baseline itself. Cross-provider candidates are not offered: a route to
 * another provider needs gates (consent, host, harness access) this module does not own.
 *
 * The inputs are CONTENT-FREE signals that already exist in code: the slice, the risk class and its reason codes, file
 * and check counts, protected path classes, the verb class, plan depth, the failure context and whether a run on the
 * baseline already failed. No path, no title and no source text is read here.
 *
 * RULES (the floor and ceiling Jev works inside):
 *  - STEP UP on any of: a protected path class other than a lockfile alone (a lockfile-only change is NOT a step up); a
 *    migration; a refactor or feature over 8 files (or an unbounded scope); the same failure repeated up to the repair
 *    limit and not environmental; a failed run on the baseline model; a critical path 4 tasks deep or more; a blocked
 *    hand-off.
 *  - STEP DOWN only for read-only work (documentation, review, research), or low risk with an acceptance check and at
 *    most 5 files, and never while a failure is open or a protected class is touched.
 *  - otherwise the baseline.
 *
 * THE JEV CHOICE. When the rules are not settled and there is a real choice, Jev is asked ONE bounded Choice over the
 * actual candidate set (the baseline, up to 3 cheaper and up to 3 dearer, by price), named with generic labels A to H
 * in price order and mapped back here, so the question text depends on the number of candidates and on nothing in the
 * registry. Each candidate is described by registry facts only (id, provider, family, price against the baseline, context
 * window, effort levels, lifecycle status). The task goes as its content-free features, and as one screened task-text
 * span only when source egress is approved (`engine.sourceEgress`, which is `decideEgress`); with egress denied the
 * request carries NO evidence at all. The answer is validated against the set passed and used only at confidence 0.6
 * with a 0.15 margin over the next choice (the floors of every Jev feature), and only inside the rules' range:
 *  - rules say STEP UP: Jev may choose the rules' rung or a dearer one, never the baseline or lower;
 *  - rules say BASELINE: Jev may choose the baseline or the nearest dearer rung; BELOW the baseline only with an
 *    egress-approved text span attached, risk below high and no open failure ("judges it easy");
 *  - rules say STEP DOWN: Jev may choose the step-down rung or any dearer one up to the nearest dearer rung; lower than
 *    the rules' rung only with the text span;
 *  - the dearer rungs beyond the nearest are open to Jev only when the rules themselves say step up.
 * `unknown`, an answer outside the set, a pick outside the range, a miss at a floor, `jev.assist` off, no engine, no
 * budget, an open circuit, a missed deadline, a refused packet (a secret in the text) or any error is the rules' tier.
 * Jev's pick is advice labelled "Jev's suggestion from structured features; ..." and is never a learned arm or a signed prior.
 */
import type { JevQuestions, RoutingModel } from '@jevris/contracts';
import type { DecisionEngine } from './decision-engine.js';
import { askBoundedDecision, INTENT_MIN_CONFIDENCE, INTENT_MIN_MARGIN, type IntentContext } from './intent-decisions.js';
import { firstTryOrder, ladderOf, type LadderRung } from './first-try.js';
import type { TokenVolume } from './model-registry.js';
import { MODEL_TIER_SPEC_ID, TIER_JEV_LABEL, TIER_JEV_TEXT_LABEL, TIER_RULES_LABEL } from './model-tier-explain.js';
import { rulesRisk, sliceFeatures, rulesSlice, type SliceRisk, type SliceTaskHints, type SliceVerb } from './slice-classifier.js';

export { MODEL_TIER_SPEC_ID, TIER_JEV_LABEL, TIER_JEV_TEXT_LABEL, TIER_RULES_LABEL } from './model-tier-explain.js';

export const MODEL_TIERS = ['step-down', 'baseline', 'step-up'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Where a tier came from: the rules' default, or Jev's accepted choice. */
export type ModelTierBasis = 'tier-rule' | 'tier-jev';

/** Locked by the owner's design: a refactor or feature over this many files is a step up. */
export const TIER_WIDE_FILES = 8;
/** Locked by the owner's design: a plan this many tasks deep (critical path) is a step up. */
export const TIER_DEEP_PLAN = 4;
/** Locked (mirrors the owned-worker low-risk class): the most files a step-down task covers. */
export const TIER_BOUNDED_FILES = 5;
/** A design constant of this feature, not an owner-locked threshold: a rung must cost at least 25 percent more or less per attempt than the baseline to be a tier. */
export const TIER_MIN_STEP = 1.25;
/** The most candidates offered on each side of the baseline, so the question stays bounded (1 + 3 + 3 = 7 of the 8 labels). */
export const TIER_MAX_EACH_SIDE = 3;
export const TIER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

export const TIER_MIN_CONFIDENCE = INTENT_MIN_CONFIDENCE;
export const TIER_MIN_MARGIN = INTENT_MIN_MARGIN;

// ---------------------------------------------------------------------------------------------------------- signals

/** The content-free signals of one piece of work. Every field already exists in code; none is text. */
export interface TierSignals {
  /** The task slice (a shared slice id), or null. */
  readonly sliceId: string | null;
  readonly risk: SliceRisk;
  /** The owned-worker risk reasons (`PROTECTED_AUTH`, `SCOPE_UNBOUNDED`, ...): a fixed vocabulary. */
  readonly riskReasons: readonly string[];
  readonly files: number;
  readonly checks: number;
  /** Protected path classes (`PROTECTED_CI` ...), sorted. */
  readonly protectedClasses: readonly string[];
  readonly verb: SliceVerb | null;
  /** Documentation, review or research that edits no source, config or CI file. */
  readonly readOnlyWork: boolean;
  /** The critical-path length of the plan the task belongs to, or null. */
  readonly planDepth: number | null;
  /** The failure context: attempts at the same failure, the repair limit, and whether it is environmental. */
  readonly failedAttempts: number | null;
  readonly maxRepairAttempts: number | null;
  readonly failureEnvironmental: boolean;
  /** A run on the baseline model already failed for this task. */
  readonly baselineRunFailed: boolean;
  /** An imported hand-off reports a blocked task. */
  readonly handOffBlocked: boolean;
}

export interface TierSignalsInput {
  /** The task's hints, reduced here to counts and categories (names and text are never kept). */
  readonly hints?: SliceTaskHints;
  readonly sliceId?: string | null;
  readonly risk?: SliceRisk;
  readonly riskReasons?: readonly string[];
  readonly planDepth?: number | null;
  readonly failedAttempts?: number | null;
  readonly maxRepairAttempts?: number | null;
  readonly failureEnvironmental?: boolean;
  readonly baselineRunFailed?: boolean;
  readonly handOffBlocked?: boolean;
}

/** The signals from what a caller knows. Pure. A risk the caller does not give is the rules' own hint for the features. */
export function tierSignalsOf(input: TierSignalsInput): TierSignals {
  const f = sliceFeatures(input.hints ?? {});
  const riskReasons = [...(input.riskReasons ?? [])].filter((r) => /^[A-Z][A-Z0-9_]{0,63}$/.test(r)).slice(0, 16);
  const protectedClasses = [...new Set([...f.protectedClasses, ...riskReasons.filter((r) => r.startsWith('PROTECTED_'))])].sort();
  const editsCode = f.roleSource + f.roleConfig + f.roleCi + f.roleOther > 0;
  const docsOnly = f.files > 0 && f.roleDocs === f.files;
  const readOnlyVerb = f.verb === 'review' || f.verb === 'research' || f.verb === 'docs';
  const sliceId = input.sliceId !== undefined ? input.sliceId : rulesSlice(f).sliceId;
  return {
    sliceId,
    risk: input.risk ?? rulesRisk(f),
    riskReasons,
    files: f.files,
    checks: f.checks,
    protectedClasses,
    verb: f.verb,
    readOnlyWork: protectedClasses.length === 0 && !editsCode && (docsOnly || readOnlyVerb),
    planDepth: typeof input.planDepth === 'number' && Number.isFinite(input.planDepth) ? Math.max(0, Math.floor(input.planDepth)) : null,
    failedAttempts: typeof input.failedAttempts === 'number' && Number.isFinite(input.failedAttempts) ? Math.max(0, Math.floor(input.failedAttempts)) : null,
    maxRepairAttempts: typeof input.maxRepairAttempts === 'number' && Number.isFinite(input.maxRepairAttempts) ? Math.max(0, Math.floor(input.maxRepairAttempts)) : null,
    failureEnvironmental: input.failureEnvironmental === true,
    baselineRunFailed: input.baselineRunFailed === true,
    handOffBlocked: input.handOffBlocked === true,
  };
}

/** Whether the signals say anything at all about the work. */
export function hasTierSignals(s: TierSignals): boolean {
  return s.files > 0 || s.checks > 0 || s.verb !== null || s.sliceId !== null || s.protectedClasses.length > 0 || s.baselineRunFailed || s.handOffBlocked || (s.failedAttempts ?? 0) > 0 || s.planDepth !== null;
}

// ------------------------------------------------------------------------------------------------------------ rules

export interface RulesTier {
  readonly tier: ModelTier;
  /** `TIER_*` reason codes of the rule(s) that decided. */
  readonly reasons: readonly string[];
  /** True when the rules settle it and Jev is not asked: a deterministic fact needs no model. */
  readonly settled: boolean;
}

/** The deterministic tier. No model, no network. */
export function rulesTier(s: TierSignals): RulesTier {
  const up: string[] = [];
  const classes = new Set([...s.protectedClasses, ...s.riskReasons.filter((r) => r.startsWith('PROTECTED_'))]);
  if ([...classes].some((c) => c !== 'PROTECTED_LOCKFILE')) up.push('TIER_PROTECTED_PATH');
  if (s.sliceId === 'migration') up.push('TIER_MIGRATION');
  if ((s.sliceId === 'refactor' || s.sliceId === 'feature' || s.verb === 'refactor' || s.verb === 'add') && (s.files > TIER_WIDE_FILES || s.riskReasons.includes('SCOPE_UNBOUNDED'))) up.push('TIER_WIDE_CHANGE');
  if (s.failedAttempts !== null && s.maxRepairAttempts !== null && s.maxRepairAttempts > 0 && s.failedAttempts >= s.maxRepairAttempts && !s.failureEnvironmental) up.push('TIER_REPEATED_FAILURE');
  if (s.baselineRunFailed) up.push('TIER_BASELINE_FAILED');
  if (s.planDepth !== null && s.planDepth >= TIER_DEEP_PLAN) up.push('TIER_DEEP_PLAN');
  if (s.handOffBlocked) up.push('TIER_HANDOFF_BLOCKED');
  if (up.length > 0) return { tier: 'step-up', reasons: up, settled: false };
  if (!hasTierSignals(s)) return { tier: 'baseline', reasons: ['TIER_NO_SIGNALS'], settled: true };
  const failing = (s.failedAttempts ?? 0) > 0;
  if (!failing && classes.size === 0) {
    if (s.readOnlyWork) return { tier: 'step-down', reasons: ['TIER_READ_ONLY_WORK'], settled: true };
    if (s.risk === 'low' && s.checks > 0 && s.files > 0 && s.files <= TIER_BOUNDED_FILES) return { tier: 'step-down', reasons: ['TIER_LOW_RISK_BOUNDED'], settled: false };
  }
  return { tier: 'baseline', reasons: ['TIER_BASELINE_DEFAULT'], settled: false };
}

// ----------------------------------------------------------------------------------------------------------- ladder

/** One model offered, described by registry facts only. */
export interface TierCandidate {
  readonly modelId: string;
  readonly provider: string;
  readonly family: string;
  /** 1 is the cheapest candidate offered. */
  readonly priceRank: number;
  readonly attemptMicroUsd: number;
  /** This candidate's attempt cost over the baseline's, two decimals. */
  readonly priceVsBaseline: number;
  readonly contextTokens: number;
  readonly effortLevels: readonly string[];
  readonly status: string;
  readonly isBaseline: boolean;
}

export interface TierLadder {
  readonly baselineModelId: string;
  readonly provider: string;
  /** Cheapest first: up to 3 cheaper, the baseline, up to 3 dearer. */
  readonly candidates: readonly TierCandidate[];
  readonly baselineIndex: number;
  /** The rung the rules step down to (the first-try order), or null when no cheaper rung exists. */
  readonly stepDownIndex: number | null;
  /** The nearest dearer rung, or null. */
  readonly stepUpIndex: number | null;
  /** Every dearer rung that qualifies, nearest first (more than the candidates offered): the escalation ladder. */
  readonly stepUpModelIds: readonly string[];
}

export type TierLadderNone = { readonly none: true; readonly reasonCode: 'TIER_BASELINE_NOT_ELIGIBLE' };

/**
 * The ladder around a baseline from the models the caller passes as eligible (already through the router's gates).
 * Only the baseline's own provider, only `active` models (the baseline itself is kept whatever its status), never a
 * model the registry says is not zero-data-retention eligible unless it is the baseline, and only rungs at least
 * `TIER_MIN_STEP` apart from the baseline per attempt at `volume`.
 */
export function buildTierLadder(input: { readonly eligible: readonly RoutingModel[]; readonly baselineModelId: string; readonly volume: TokenVolume }): TierLadder | TierLadderNone {
  const rungs = ladderOf(input.eligible, input.volume);
  const baseline = rungs.find((r) => r.modelId === input.baselineModelId);
  if (baseline === undefined) return { none: true, reasonCode: 'TIER_BASELINE_NOT_ELIGIBLE' };
  const byId = new Map(input.eligible.map((m) => [m.modelId, m] as const));
  const usable = rungs.filter((r) => r.provider === baseline.provider && r.modelId !== baseline.modelId && r.status === 'active' && byId.get(r.modelId)?.dataGovernance?.zdrEligible !== false);
  const cheaper = usable.filter((r) => r.attemptMicroUsd * TIER_MIN_STEP <= baseline.attemptMicroUsd).sort((a, b) => b.attemptMicroUsd - a.attemptMicroUsd || (a.modelId < b.modelId ? -1 : 1));
  const dearer = usable.filter((r) => r.attemptMicroUsd >= baseline.attemptMicroUsd * TIER_MIN_STEP).sort((a, b) => a.attemptMicroUsd - b.attemptMicroUsd || (a.modelId < b.modelId ? -1 : 1));
  const below = cheaper.slice(0, TIER_MAX_EACH_SIDE).reverse();
  const above = dearer.slice(0, TIER_MAX_EACH_SIDE);
  const rows: readonly LadderRung[] = [...below, baseline, ...above];
  const candidates: TierCandidate[] = rows.map((r, i) => {
    const model = byId.get(r.modelId) as RoutingModel;
    return {
      modelId: r.modelId,
      provider: r.provider,
      family: r.family,
      priceRank: i + 1,
      attemptMicroUsd: r.attemptMicroUsd,
      priceVsBaseline: baseline.attemptMicroUsd > 0 ? Math.round((r.attemptMicroUsd / baseline.attemptMicroUsd) * 100) / 100 : 1,
      contextTokens: model.contextTokens,
      effortLevels: [...model.effortLevels],
      status: model.lifecycle?.status ?? 'unknown',
      isBaseline: r.modelId === baseline.modelId,
    };
  });
  // The step-down rung is named the way the first try is: the baseline's own family, else the newest, the smallest tier last.
  const down = firstTryOrder(below, baseline).ordered[0];
  const baselineIndex = below.length;
  return {
    baselineModelId: baseline.modelId,
    provider: baseline.provider,
    candidates,
    baselineIndex,
    stepDownIndex: down === undefined ? null : candidates.findIndex((c) => c.modelId === down.modelId),
    stepUpIndex: above.length === 0 ? null : baselineIndex + 1,
    stepUpModelIds: dearer.map((r) => r.modelId),
  };
}

// --------------------------------------------------------------------------------------------------- the question

/** The definition of the unknown option. Fixed text. */
const UNKNOWN_DEFINITION = 'The listed facts are not enough to choose a model.';

/**
 * The one question, for `count` candidates (2 to 8): a Choice over generic labels in price order, plus `unknown`.
 * Fixed text that depends on `count` only, so a registry change never changes a reviewed question.
 */
export function modelTierQuestions(count: number): JevQuestions {
  const n = Math.max(2, Math.min(TIER_LABELS.length, Math.floor(count)));
  const criteria: Record<string, string> = {};
  for (const label of TIER_LABELS.slice(0, n)) criteria[label] = `Candidate ${label}: the model listed as ${label} in the candidates. Its provider, family, price against the baseline, context window, effort levels and lifecycle status are in its description.`;
  criteria['unknown'] = UNKNOWN_DEFINITION;
  return {
    model: {
      type: 'choice',
      instructions:
        'Which listed candidate model is the cheapest one that can complete this coding task correctly? Judge from the structured facts of the task and the description of each candidate. The candidates are listed from cheapest to dearest, and the baseline named in the facts is the model the work would otherwise run on. Choose the baseline unless the facts show the task is clearly easier or harder than ordinary work.',
      criteria,
    },
  } as unknown as JevQuestions;
}

function candidateDescription(c: TierCandidate): string {
  return `${c.modelId}; provider ${c.provider}; family ${c.family}; ${c.priceVsBaseline} times the baseline's price per attempt; context ${c.contextTokens} tokens; effort ${c.effortLevels.length === 0 ? 'none' : c.effortLevels.join('/')}; ${c.status}${c.isBaseline ? '; the baseline' : ''}`;
}

function taskFacts(s: TierSignals, rules: RulesTier, ladder: TierLadder, textAttached: boolean, range: Range): Record<string, string | number> {
  const label = (i: number | null): string => (i === null ? 'none' : (TIER_LABELS[i] ?? 'none'));
  return {
    baseline: label(ladder.baselineIndex),
    candidates: ladder.candidates.length,
    rulesTier: rules.tier,
    rulesChoice: label(rulesIndex(rules.tier, ladder)),
    allowedFrom: label(range.floor),
    allowedTo: label(range.ceiling),
    risk: s.risk,
    slice: s.sliceId ?? 'none',
    files: s.files,
    checks: s.checks,
    protectedClasses: s.protectedClasses.length === 0 ? 'none' : s.protectedClasses.join(','),
    verb: s.verb ?? 'none',
    readOnlyWork: s.readOnlyWork ? 'yes' : 'no',
    planDepth: s.planDepth ?? 'unknown',
    failedAttempts: s.failedAttempts ?? 0,
    repairLimit: s.maxRepairAttempts ?? 'unknown',
    failureEnvironmental: s.failureEnvironmental ? 'yes' : 'no',
    baselineRunFailed: s.baselineRunFailed ? 'yes' : 'no',
    handOffBlocked: s.handOffBlocked ? 'yes' : 'no',
    taskText: textAttached ? 'attached' : 'none',
  };
}

// ----------------------------------------------------------------------------------------------------- the range

interface Range {
  readonly floor: number;
  readonly ceiling: number;
}

function rulesIndex(tier: ModelTier, ladder: TierLadder): number {
  if (tier === 'step-up') return ladder.stepUpIndex ?? ladder.baselineIndex;
  if (tier === 'step-down') return ladder.stepDownIndex ?? ladder.baselineIndex;
  return ladder.baselineIndex;
}

/** The candidates Jev's pick may be, by index: the rules' floor and ceiling (see the module header). */
function allowedRange(rules: RulesTier, ladder: TierLadder, signals: TierSignals, textAttached: boolean): Range {
  const last = ladder.candidates.length - 1;
  const rulesAt = rulesIndex(rules.tier, ladder);
  if (rules.tier === 'step-up') return { floor: rulesAt, ceiling: last };
  const ceiling = ladder.stepUpIndex ?? ladder.baselineIndex;
  // Below the baseline only with the task text, risk under high and no open failure.
  const mayLower = textAttached && signals.risk !== 'high' && (signals.failedAttempts ?? 0) === 0;
  if (rules.tier === 'step-down') return { floor: mayLower ? 0 : rulesAt, ceiling };
  return { floor: mayLower ? 0 : ladder.baselineIndex, ceiling };
}

// ------------------------------------------------------------------------------------------------------ the result

export interface ModelTierDecision {
  readonly tier: ModelTier;
  /** The model the tier names (the baseline for `baseline`). */
  readonly targetModelId: string;
  readonly baselineModelId: string;
  readonly family: string | null;
  readonly provider: string | null;
  readonly basis: ModelTierBasis;
  /** `TIER_*` codes of the outcome (the rule that decided, and why Jev's answer was or was not used). */
  readonly reasonCodes: readonly string[];
  readonly rulesTier: ModelTier;
  readonly rulesTargetModelId: string;
  readonly signals: TierSignals;
  /** The model ids offered, cheapest first. */
  readonly candidates: readonly string[];
  /** Every dearer rung that qualifies, nearest first: the escalation ladder. */
  readonly stepUpModelIds: readonly string[];
  /** What this result says it is. */
  readonly label: string;
  readonly asked: boolean;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  readonly confidence: number | null;
  /** The candidate Jev answered, even when it was not used. */
  readonly jevModelId: string | null;
  /** Whether a screened task-text span was sent. */
  readonly textSent: boolean;
  /** The recorded advisory decision (explain shows it); null when none was recorded. */
  readonly decisionId: string | null;
  readonly jevDecisionId: string | null;
}

export interface ModelTierOptions {
  /** `off` is `jev.assist off`: Jev is not asked. */
  readonly assist: 'off' | 'classify';
  /** Record the decision as an advisory record (default true). */
  readonly record?: boolean;
  readonly now?: () => number;
  /** Do not ask Jev: the answer is the rules' and carries this reason code (a gate that applies). */
  readonly skipAsk?: string;
}

export interface ModelTierInput {
  readonly signals: TierSignals;
  /** The models eligible for this session or task, already through the router's gates. The baseline must be one of them. */
  readonly eligible: readonly RoutingModel[];
  readonly baselineModelId: string;
  readonly volume: TokenVolume;
  /** The task's title or description, offered as one screened span; sent only when source egress is approved. */
  readonly text?: string | null;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TEXT_MAX_CHARS = 2000;

function ruleDecision(input: ModelTierInput, ladder: TierLadder | TierLadderNone, rules: RulesTier, extra: { readonly reasons?: readonly string[]; readonly textSent?: boolean; readonly ask?: Partial<ModelTierDecision> } = {}): ModelTierDecision {
  const none = 'none' in ladder;
  const rulesAt = none ? -1 : rulesIndex(rules.tier, ladder);
  // A rule that wants a rung the set does not have stays on the baseline, and says so.
  const missing = none ? [] : rules.tier === 'step-up' && ladder.stepUpIndex === null ? ['TIER_NO_STEP_UP_RUNG'] : rules.tier === 'step-down' && ladder.stepDownIndex === null ? ['TIER_NO_STEP_DOWN_RUNG'] : [];
  const tier: ModelTier = none || missing.length > 0 ? 'baseline' : rules.tier;
  const baselineIndex = none ? -1 : ladder.baselineIndex;
  const at = none ? -1 : tier === 'baseline' ? baselineIndex : rulesAt;
  const target = none ? undefined : ladder.candidates[at];
  const targetModelId = target?.modelId ?? input.baselineModelId;
  return {
    tier,
    targetModelId,
    baselineModelId: input.baselineModelId,
    family: target?.family ?? null,
    provider: target?.provider ?? null,
    basis: 'tier-rule',
    reasonCodes: [...(none ? ['TIER_BASELINE_NOT_ELIGIBLE'] : []), ...rules.reasons, ...missing, ...(extra.reasons ?? [])],
    rulesTier: tier,
    rulesTargetModelId: targetModelId,
    signals: input.signals,
    candidates: none ? [] : ladder.candidates.map((c) => c.modelId),
    stepUpModelIds: none ? [] : ladder.stepUpModelIds,
    label: TIER_RULES_LABEL,
    asked: false,
    cacheHit: null,
    latencyMs: null,
    confidence: null,
    jevModelId: null,
    textSent: extra.textSent === true,
    decisionId: null,
    jevDecisionId: null,
    ...extra.ask,
  };
}

interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly margin: number;
}

function choiceOf(answers: Readonly<Record<string, { readonly type: string; readonly [key: string]: unknown }>>): ChoiceAnswer | null {
  const a = answers['model'];
  if (a === undefined || a.type !== 'choice' || typeof a['choice'] !== 'string') return null;
  const raw = a['probabilities'];
  const values = raw !== null && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>).filter((p): p is number => typeof p === 'number' && Number.isFinite(p)) : [];
  const sorted = [...values].sort((x, y) => y - x);
  const top = sorted[0] ?? 0;
  const confidence = typeof a['confidence'] === 'number' && Number.isFinite(a['confidence']) ? a['confidence'] : top;
  return { choice: a['choice'], confidence, margin: top - (sorted[1] ?? 0) };
}

async function cacheHitOf(engine: DecisionEngine, decisionId: string): Promise<boolean | null> {
  try {
    const record = await engine.lookup(decisionId);
    return record === null ? null : record.reasonCodes.includes('CACHE_HIT');
  } catch {
    return null;
  }
}

/**
 * Judges the tier of one piece of work. Never throws and never waits past the context's deadline for Jev: any failure
 * is the rules' answer. Jev is asked only when `assist` is on, an engine exists, the rules do not settle it, the signals
 * say something and the range the rules allow holds at least two candidates.
 */
export async function judgeModelTier(engine: DecisionEngine | null, input: ModelTierInput, ctx: IntentContext, options: ModelTierOptions): Promise<ModelTierDecision> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const ladder = buildTierLadder({ eligible: input.eligible, baselineModelId: input.baselineModelId, volume: input.volume });
  const rules = rulesTier(input.signals);
  const finish = (d: ModelTierDecision): Promise<ModelTierDecision> => recordTier(engine, d, ctx, options.record !== false, now() - started);
  // A baseline the caller's models do not include has no ladder: nothing to judge and nothing worth a record.
  if ('none' in ladder) return ruleDecision(input, ladder, rules);
  if (!hasTierSignals(input.signals)) return finish(ruleDecision(input, ladder, rules));
  if (rules.settled) return finish(ruleDecision(input, ladder, rules, { reasons: ['TIER_RULES_SURE'] }));
  const skip = options.skipAsk !== undefined ? (REASON_CODE.test(options.skipAsk) ? options.skipAsk : 'TIER_ASSIST_OFF') : options.assist === 'off' ? 'TIER_ASSIST_OFF' : engine === null ? 'PROVIDER_NOT_CONFIGURED' : null;
  if (skip !== null || engine === null) return finish(ruleDecision(input, ladder, rules, { reasons: [skip ?? 'PROVIDER_NOT_CONFIGURED'] }));
  // The task text goes as one screened span only with source egress approved (the engine's gate is `decideEgress`).
  const egressApproved = (engine.sourceEgress?.() ?? 'denied') === 'approved';
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, TEXT_MAX_CHARS) : '';
  const withText = egressApproved && text.length > 0;
  const range = allowedRange(rules, ladder, input.signals, withText);
  // Nothing to choose between (a single allowed rung): the rules' answer stands and no request is made.
  if (range.ceiling <= range.floor) return finish(ruleDecision(input, ladder, rules, { reasons: ['TIER_NO_CHOICE'] }));
  const packet = {
    objective: 'Choose the cheapest listed model that can complete one coding task correctly, from the structured features of the task and the description of each model (advice only).',
    trustedPolicy: { candidates: ladder.candidates.map((_, i) => TIER_LABELS[i] as string), grantsAuthority: false },
    facts: taskFacts(input.signals, rules, ladder, withText, range),
    candidates: ladder.candidates.map((c, i) => ({ id: TIER_LABELS[i] as string, description: candidateDescription(c) })),
    // With egress denied the request carries no evidence at all (not even a withheld span's length and digest).
    evidence: withText ? [{ id: 'task-text', text, sourceKind: 'user' as const, priority: 'high' as const }] : [],
  };
  const asked = await askBoundedDecision(engine, MODEL_TIER_SPEC_ID, modelTierQuestions(ladder.candidates.length), packet, ctx, false);
  const latencyMs = Math.round(now() - started);
  const base = { asked: true, latencyMs, textSent: withText } as const;
  if (!asked.ok) return finish(ruleDecision(input, ladder, rules, { reasons: [`TIER_JEV_${asked.reasonCode}`.slice(0, 64)], textSent: false, ask: { asked: true, latencyMs, jevDecisionId: asked.decisionId } }));
  const cacheHit = await cacheHitOf(engine, asked.decisionId);
  const answer = choiceOf(asked.answers);
  const common = { ...base, cacheHit, jevDecisionId: asked.decisionId };
  const rejected = (reason: string, extra: Partial<ModelTierDecision> = {}): Promise<ModelTierDecision> => finish(ruleDecision(input, ladder, rules, { reasons: [reason], textSent: withText, ask: { ...common, ...extra } }));
  if (answer === null) return rejected('TIER_JEV_NO_ANSWER');
  const index = (TIER_LABELS as readonly string[]).indexOf(answer.choice);
  const pick = index >= 0 && index < ladder.candidates.length ? ladder.candidates[index] : undefined;
  const confidence = Math.round(answer.confidence * 100) / 100;
  if (pick === undefined) return rejected(answer.choice === 'unknown' ? 'TIER_JEV_UNKNOWN' : 'TIER_JEV_UNKNOWN_OPTION', { confidence });
  const withPick = { confidence, jevModelId: pick.modelId };
  if (answer.confidence < TIER_MIN_CONFIDENCE || answer.margin < TIER_MIN_MARGIN) return rejected('TIER_JEV_LOW_CONFIDENCE', withPick);
  if (index < range.floor) return rejected('TIER_JEV_BELOW_FLOOR', withPick);
  if (index > range.ceiling) return rejected('TIER_JEV_ABOVE_CEILING', withPick);
  const rulesAt = rulesIndex(rules.tier, ladder);
  const ruled = ruleDecision(input, ladder, rules);
  if (index === rulesAt || (ruled.tier === 'baseline' && index === ladder.baselineIndex)) return finish({ ...ruled, reasonCodes: [...ruled.reasonCodes, 'TIER_JEV_AGREES'], ...common, ...withPick });
  const tier: ModelTier = index < ladder.baselineIndex ? 'step-down' : index > ladder.baselineIndex ? 'step-up' : 'baseline';
  return finish({
    ...ruled,
    tier,
    targetModelId: pick.modelId,
    family: pick.family,
    provider: pick.provider,
    basis: 'tier-jev',
    reasonCodes: [...ruled.reasonCodes, 'TIER_JEV_ACCEPTED'],
    label: withText ? TIER_JEV_TEXT_LABEL : TIER_JEV_LABEL,
    ...common,
    ...withPick,
  });
}

// ---------------------------------------------------------------------------------------------------------- record

const upper = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** The reason codes of the recorded decision: every one reads back through `modelTierLines`. */
export function modelTierReasonCodes(d: ModelTierDecision): string[] {
  const s = d.signals;
  const codes = [
    `TIER_SOURCE_${d.basis === 'tier-jev' ? 'JEV' : 'RULE'}`,
    `TIER_LEVEL_${upper(d.tier)}`,
    `TIER_RULES_${upper(d.rulesTier)}`,
    `TIER_FEATURE_RISK_${upper(s.risk)}`,
    `TIER_FEATURE_FILES_${String(s.files)}`,
    `TIER_FEATURE_CHECKS_${String(s.checks)}`,
    ...(s.protectedClasses.length === 0 ? [] : [`TIER_FEATURE_PROTECTED_${String(s.protectedClasses.length)}`]),
    ...(s.verb === null ? [] : [`TIER_FEATURE_VERB_${upper(s.verb)}`]),
    ...(s.planDepth === null ? [] : [`TIER_FEATURE_DEPTH_${String(s.planDepth)}`]),
    ...(s.baselineRunFailed ? ['TIER_FEATURE_BASELINE_RUN_FAILED'] : []),
    `TIER_CANDIDATES_${String(d.candidates.length)}`,
    d.textSent ? 'TIER_TEXT_SENT' : 'TIER_TEXT_NOT_SENT',
    ...(d.jevModelId === null ? [] : [`TIER_JEV_PICK_${TIER_LABELS[d.candidates.indexOf(d.jevModelId)] ?? 'X'}`]),
    ...(d.asked ? [d.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    ...(d.confidence === null ? [] : [`CONF_${String(Math.round(d.confidence * 100))}`]),
    ...d.reasonCodes,
  ];
  return [...new Set(codes)].filter((c) => REASON_CODE.test(c));
}

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function recordTier(engine: DecisionEngine | null, d: ModelTierDecision, ctx: IntentContext, on: boolean, elapsedMs: number): Promise<ModelTierDecision> {
  const withLatency = d.latencyMs === null && d.asked ? { ...d, latencyMs: Math.round(elapsedMs) } : d;
  if (!on || engine === null || engine.recordAdvice === undefined) return withLatency;
  const s = d.signals;
  const evidenceIds = [
    ...(s.files > 0 ? ['feature-files'] : []),
    ...(s.checks > 0 ? ['feature-checks'] : []),
    ...(s.protectedClasses.length > 0 ? ['feature-protected'] : []),
    ...(s.verb !== null ? ['feature-verb'] : []),
    ...(d.textSent ? ['task-text'] : []),
    `baseline-${d.baselineModelId}`,
    `target-${d.targetModelId}`,
    ...d.candidates.map((id) => `candidate-${id}`),
  ].filter((id) => EVIDENCE_ID.test(id));
  try {
    const recorded = await engine.recordAdvice({
      specId: MODEL_TIER_SPEC_ID,
      workspaceId: ctx.workspaceId,
      evidenceRevision: ctx.evidenceRevision,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
      action: { kind: 'advise', templateId: MODEL_TIER_SPEC_ID, evidenceIds: evidenceIds.slice(0, 64) },
      reasonCodes: modelTierReasonCodes(d),
      durationMs: Math.max(0, Math.round(elapsedMs)),
    });
    return recorded.ok ? { ...withLatency, decisionId: recorded.decisionId } : withLatency;
  } catch {
    return withLatency;
  }
}

// ------------------------------------------------------------------------------------------------------- the note

/** What a use site keeps or shows of a decision (ids, codes and the label: no text). */
export interface TierNote {
  readonly tier: ModelTier;
  readonly targetModelId: string;
  readonly baselineModelId: string;
  readonly basis: ModelTierBasis;
  readonly label: string;
  readonly reasonCodes: readonly string[];
  readonly candidates: readonly string[];
  readonly stepUpModelIds: readonly string[];
  readonly decisionId: string | null;
}

export function tierNoteOf(d: ModelTierDecision): TierNote {
  return {
    tier: d.tier,
    targetModelId: d.targetModelId,
    baselineModelId: d.baselineModelId,
    basis: d.basis,
    label: d.label,
    reasonCodes: d.reasonCodes.slice(0, 16),
    candidates: d.candidates.slice(0, TIER_LABELS.length),
    stepUpModelIds: d.stepUpModelIds.slice(0, 8),
    decisionId: d.decisionId,
  };
}
