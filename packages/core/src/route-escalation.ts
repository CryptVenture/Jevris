/**
 * Escalation, downgrade, effort and outage routing (RTE-07, RTE-08, RTE-09, §8.5, C11, C12, C13,
 * C15, US08, US09, US11, W07).
 *
 * - Escalation: a Jev Choice classifies the failure family. Environment, test configuration and
 *   missing context route to diagnosis, because a stronger model cannot fix a missing
 *   credential. A verified-problem family allows one bounded escalation to the next stronger
 *   eligible model; after that the task gets a blocked report, never a second escalation.
 * - Downgrade: only at a safe handoff, with complete acceptance criteria, a verified slice and
 *   Noul readiness at or above the threshold. "The strong model says the rest is easy" is never
 *   enough.
 * - Effort: only a level the registry lists for the chosen model; an effort pin is kept.
 * - Outage: only a preapproved fallback for the failing model, same provider, no broader region.
 *   Anything else is refused and counted; the unauthorized-fallback count stays zero because
 *   nothing outside the list is ever chosen.
 */
import type { DecisionResult, JevQuestions, ModelRegistry, RoutePins, RoutingModel } from '@jevris/contracts';
import { registryModel } from './model-registry.js';
import { filterCandidates, type RoutingPolicy } from './router.js';

export const FAILURE_FAMILIES = [
  'environment',
  'test-misconfiguration',
  'missing-context',
  'same-problem-repeated',
  'interface-ambiguity',
  'security-scope-expansion',
  'repair-exhausted',
  'unclear',
] as const;
export type FailureFamily = (typeof FAILURE_FAMILIES)[number];

const DIAGNOSIS: ReadonlySet<FailureFamily> = new Set(['environment', 'test-misconfiguration', 'missing-context']);
const ESCALATE: ReadonlySet<FailureFamily> = new Set(['same-problem-repeated', 'interface-ambiguity', 'security-scope-expansion', 'repair-exhausted']);

/** The bounded Choice question that classifies a failure (the evidence travels in the packet). */
export const FAILURE_FAMILY_QUESTIONS: JevQuestions = Object.freeze({
  failureFamily: {
    type: 'choice',
    instructions:
      'Classify the most recent verified failure using only the evidence provided. Choose the single family that best explains it. Choose unclear when the evidence does not support one family.',
    criteria: {
      environment: 'The failure comes from the environment: a missing tool, credential, service, permission or network access.',
      'test-misconfiguration': 'The test or check itself is misconfigured, flaky or asserting the wrong thing.',
      'missing-context': 'Essential context is absent: a file, requirement or interface the worker was not given.',
      'same-problem-repeated': 'The same verified problem failed again after a repair attempt, with no progress.',
      'interface-ambiguity': 'An interface or requirement is ambiguous and the worker cannot resolve it from the evidence.',
      'security-scope-expansion': 'The fix needs a security-sensitive change beyond the approved scope.',
      'repair-exhausted': 'Local repair attempts are exhausted without a new hypothesis.',
      unclear: 'The evidence does not support any single family above.',
    },
  },
}) as JevQuestions;

/** The family from a validated Choice answer, or `unclear` when it is not confident enough. */
export function failureFamilyOf(result: DecisionResult | null, minimumProbability = 0.5): FailureFamily {
  const answer = result?.answers['failureFamily'];
  if (answer === undefined || answer.type !== 'choice') return 'unclear';
  const chosen = answer.choice as FailureFamily;
  if (!(FAILURE_FAMILIES as readonly string[]).includes(chosen)) return 'unclear';
  const probability = answer.probabilities[chosen] ?? 0;
  return probability >= minimumProbability ? chosen : 'unclear';
}

export type EscalationAction = 'diagnose' | 'escalate' | 'blocked-report' | 'continue';

export interface EscalationDecision {
  readonly action: EscalationAction;
  readonly family: FailureFamily;
  readonly targetModelId: string | null;
  readonly reasonCode: string;
}

/** Eligible models ordered from cheapest to most expensive input price (the strength ladder). */
function ladder(registry: ModelRegistry, policy: RoutingPolicy): readonly RoutingModel[] {
  return [...filterCandidates(registry, { ...policy, pins: { modelPin: null, effortPin: policy.pins.effortPin } }).eligible].sort(
    (a, b) => a.tariff.inputPerMillion - b.tariff.inputPerMillion || (a.modelId < b.modelId ? -1 : 1),
  );
}

/** RTE-07: the escalation gate. */
export function escalationGate(input: {
  readonly family: FailureFamily;
  readonly currentModelId: string;
  readonly escalationsUsed: number;
  readonly maxEscalations?: number;
  readonly registry: ModelRegistry;
  readonly policy: RoutingPolicy;
}): EscalationDecision {
  const max = input.maxEscalations ?? 1;
  const base = { family: input.family, targetModelId: null };
  if (DIAGNOSIS.has(input.family)) return { ...base, action: 'diagnose', reasonCode: `DIAGNOSE_${input.family.toUpperCase().replace(/-/g, '_')}` };
  if (!ESCALATE.has(input.family)) return { ...base, action: 'continue', reasonCode: 'NO_ESCALATION_EVIDENCE' };
  if (input.policy.pins.modelPin !== null) return { ...base, action: 'blocked-report', reasonCode: 'MODEL_PINNED' };
  if (input.escalationsUsed >= max) return { ...base, action: 'blocked-report', reasonCode: 'ESCALATION_BUDGET_USED' };
  const current = registryModel(input.registry, input.currentModelId);
  const models = ladder(input.registry, input.policy);
  const price = current?.tariff.inputPerMillion ?? Number.POSITIVE_INFINITY;
  const stronger = models.find((model) => model.tariff.inputPerMillion > price);
  if (stronger === undefined) return { ...base, action: 'blocked-report', reasonCode: 'NO_STRONGER_ELIGIBLE_MODEL' };
  return { family: input.family, action: 'escalate', targetModelId: stronger.modelId, reasonCode: 'BOUNDED_ESCALATION' };
}

export interface DowngradeInput {
  readonly atSafeHandoff: boolean;
  readonly acceptanceCriteria: readonly string[];
  /** Noul probability that the task is ready for the smaller model; null when not asked. */
  readonly readiness: number | null;
  readonly readinessThreshold: number;
  readonly sliceVerified: boolean;
  /** Set when the only reason offered is the strong model's own judgement that the rest is easy. */
  readonly onlyModelSaysEasy?: boolean;
}

export type DowngradeDecision = { readonly allowed: true; readonly reasonCode: 'SAFE_DOWNGRADE' } | { readonly allowed: false; readonly reasonCode: string };

/** RTE-08: downgrade only at a safe handoff with complete acceptance criteria and readiness. */
export function downgradeGate(input: DowngradeInput): DowngradeDecision {
  if (!input.atSafeHandoff) return { allowed: false, reasonCode: 'NOT_AT_SAFE_HANDOFF' };
  const criteria = input.acceptanceCriteria.filter((c) => typeof c === 'string' && c.trim().length > 0);
  if (criteria.length === 0 || criteria.length !== input.acceptanceCriteria.length) return { allowed: false, reasonCode: 'ACCEPTANCE_CRITERIA_INCOMPLETE' };
  if (!input.sliceVerified) return { allowed: false, reasonCode: 'SLICE_NOT_VERIFIED' };
  if (input.readiness === null) return { allowed: false, reasonCode: input.onlyModelSaysEasy === true ? 'MODEL_OPINION_NOT_EVIDENCE' : 'READINESS_UNKNOWN' };
  if (input.readiness < input.readinessThreshold) return { allowed: false, reasonCode: 'READINESS_BELOW_THRESHOLD' };
  return { allowed: true, reasonCode: 'SAFE_DOWNGRADE' };
}

export interface EffortDecision {
  readonly effort: string | null;
  readonly reasonCode: 'EFFORT_PINNED' | 'EFFORT_PIN_UNSUPPORTED' | 'EFFORT_SELECTED' | 'EFFORT_UNSUPPORTED' | 'EFFORT_NOT_EXPOSED' | 'NO_EFFORT_REQUESTED';
}

/** RTE-08: effort only from the model's registry levels; an effort pin is always kept. */
export function chooseEffort(model: RoutingModel, requested: string | null, pins: RoutePins): EffortDecision {
  if (pins.effortPin !== null) {
    // The pin is the user's; it is carried unchanged even when the registry does not list it.
    return { effort: pins.effortPin, reasonCode: model.effortLevels.includes(pins.effortPin) ? 'EFFORT_PINNED' : 'EFFORT_PIN_UNSUPPORTED' };
  }
  if (model.effortLevels.length === 0) return { effort: null, reasonCode: 'EFFORT_NOT_EXPOSED' };
  if (requested === null) return { effort: null, reasonCode: 'NO_EFFORT_REQUESTED' };
  if (!model.effortLevels.includes(requested)) return { effort: null, reasonCode: 'EFFORT_UNSUPPORTED' };
  return { effort: requested, reasonCode: 'EFFORT_SELECTED' };
}

export interface ApprovedFallback {
  readonly fromModelId: string;
  readonly toModelId: string;
}

export interface OutageDecision {
  readonly modelId: string | null;
  readonly reasonCode: 'FALLBACK_APPROVED' | 'NO_APPROVED_FALLBACK' | 'FALLBACK_NOT_APPROVED' | 'FALLBACK_BROADENS_PROVIDER' | 'FALLBACK_BROADENS_REGION' | 'FALLBACK_INELIGIBLE' | 'NOT_IN_OUTAGE';
}

/** Counts fallback requests refused because they were not preapproved. */
export class FallbackLedger {
  unauthorizedFallbacks = 0;
  refusedRequests = 0;
}

/** RTE-09: outage routing from the preapproved list only. */
export function outageFallback(input: {
  readonly currentModelId: string;
  readonly registry: ModelRegistry;
  readonly approved: readonly ApprovedFallback[];
  readonly policy: RoutingPolicy;
  /** A specific fallback someone asked for; refused unless approved. */
  readonly requestedModelId?: string | null;
  readonly ledger?: FallbackLedger;
}): OutageDecision {
  const current = registryModel(input.registry, input.currentModelId);
  if (current === null || current.health !== 'unavailable') return { modelId: null, reasonCode: 'NOT_IN_OUTAGE' };
  const approvedTargets = input.approved.filter((entry) => entry.fromModelId === input.currentModelId).map((entry) => entry.toModelId);
  const refuse = (reasonCode: OutageDecision['reasonCode']): OutageDecision => {
    if (input.ledger !== undefined) input.ledger.refusedRequests += 1;
    return { modelId: null, reasonCode };
  };
  if (input.requestedModelId !== undefined && input.requestedModelId !== null && !approvedTargets.includes(input.requestedModelId)) return refuse('FALLBACK_NOT_APPROVED');
  const targets = input.requestedModelId !== undefined && input.requestedModelId !== null ? [input.requestedModelId] : approvedTargets;
  if (targets.length === 0) return { modelId: null, reasonCode: 'NO_APPROVED_FALLBACK' };
  const eligible = new Set(filterCandidates(input.registry, { ...input.policy, pins: { modelPin: null, effortPin: input.policy.pins.effortPin } }).eligible.map((m) => m.modelId));
  let last: OutageDecision['reasonCode'] = 'NO_APPROVED_FALLBACK';
  for (const target of targets) {
    const model = registryModel(input.registry, target);
    if (model === null || !eligible.has(target)) {
      last = 'FALLBACK_INELIGIBLE';
      continue;
    }
    if (model.provider !== current.provider) {
      last = 'FALLBACK_BROADENS_PROVIDER';
      continue;
    }
    if (!model.regions.every((region) => current.regions.includes(region))) {
      last = 'FALLBACK_BROADENS_REGION';
      continue;
    }
    return { modelId: target, reasonCode: 'FALLBACK_APPROVED' };
  }
  return input.requestedModelId !== undefined && input.requestedModelId !== null ? refuse(last) : { modelId: null, reasonCode: last };
}
