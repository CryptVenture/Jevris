/**
 * Closed ask, rank, or pause advice for the phase 21 capability ids that remain here (C's and
 * B's). D's ids (CAP-17..48, CAP-57..72) answer through D's capability.advise op
 * (adviseCapability in @jevris/orchestrator) with real evidence; here they abstain.
 * A result grants nothing. Caller text is not copied. Unknown ids abstain.
 * This module does not load the capability catalogue as skills.
 */

const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export type AdviceVerb = 'ask' | 'rank' | 'pause' | 'abstain';

export interface BoundedAdvice {
  readonly verb: AdviceVerb;
  readonly capabilityId: string | null;
  readonly applied: false;
  readonly authorityGranted: false;
  readonly verified: false;
  readonly testsPassed: false;
  readonly grant: false;
  readonly waivedCheck: false;
  readonly installedPackage: false;
  readonly merged: false;
  readonly migrated: false;
  readonly answerInvented: false;
  readonly text: string;
  readonly requirementRewritten: false;
  readonly uncoveredIds: readonly string[];
  readonly cycleRejected: boolean;
  readonly approvalSource: 'trusted-channel' | null;
  readonly repositoryApproval: false;
  readonly pausedPortion: 'out-of-scope' | null;
  readonly feasible: false;
  readonly scheduled: false;
  readonly jobLaunched: false;
  readonly refused: boolean;
  readonly chosenRole: string | null;
  readonly permissionAdded: false;
  readonly recommendation: 'merge' | 'cancel' | 'investigation' | null;
  readonly forceDelete: false;
  readonly guessedDate: null;
  readonly allowlistExpanded: false;
  readonly invocation: 'unauthorized';
  readonly rankedTool: string | null;
  readonly autoApproved: false;
  readonly patchAccepted: false;
  readonly rankedPatch: string | null;
  readonly mandatoryReviewers: readonly string[];
  readonly reviewerWaived: false;
  readonly testDisabled: false;
  readonly vulnerabilityAbsenceCertified: false;
  readonly accessGranted: false;
  readonly supplementary: boolean;
  readonly consentFromNegativeFlag: false;
  readonly diagnosis: 'source' | 'infra' | 'flaky-investigation' | null;
  readonly ciSecretsChanged: false;
  readonly requiredChecksChanged: false;
  readonly ciImported: false;
  readonly packageInstalled: false;
  readonly risks: readonly string[];
  readonly productionMigrationRun: false;
  readonly rehearsalRequired: true;
  readonly undocumentedBehaviorAsserted: false;
  readonly docIds: readonly string[];
  readonly activated: false;
  readonly repositoryExceptions: readonly string[];
}

interface Varying {
  readonly verb: AdviceVerb;
  readonly capabilityId: string | null;
  readonly text: string;
  readonly cycleRejected?: boolean;
  readonly uncoveredIds?: readonly string[];
  readonly approvalSource?: 'trusted-channel' | null;
  readonly pausedPortion?: 'out-of-scope' | null;
  readonly refused?: boolean;
  readonly chosenRole?: string | null;
  readonly recommendation?: 'merge' | 'cancel' | 'investigation' | null;
  readonly rankedTool?: string | null;
  readonly rankedPatch?: string | null;
  readonly mandatoryReviewers?: readonly string[];
  readonly supplementary?: boolean;
  readonly diagnosis?: 'source' | 'infra' | 'flaky-investigation' | null;
  readonly risks?: readonly string[];
  readonly docIds?: readonly string[];
  readonly repositoryExceptions?: readonly string[];
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return undefined;
  return value;
}

function safeList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const id = safeId(item);
    if (id !== undefined) out.push(id);
  }
  return out;
}

function hasCycle(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const edges = new Map<string, string[]>();
  for (const item of value) {
    if (!isPlain(item) || hasDangerousKey(item)) return true;
    const from = safeId(own(item, 'from'));
    const to = safeId(own(item, 'to'));
    if (from === undefined || to === undefined) continue;
    const next = edges.get(from);
    if (next === undefined) edges.set(from, [to]);
    else next.push(to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) {
      if (walk(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of edges.keys()) {
    if (walk(node)) return true;
  }
  return false;
}

function result(varying: Varying): BoundedAdvice {
  return {
    verb: varying.verb,
    capabilityId: varying.capabilityId,
    text: varying.text,
    applied: false,
    authorityGranted: false,
    verified: false,
    testsPassed: false,
    grant: false,
    waivedCheck: false,
    installedPackage: false,
    merged: false,
    migrated: false,
    answerInvented: false,
    requirementRewritten: false,
    uncoveredIds: varying.uncoveredIds ?? [],
    cycleRejected: varying.cycleRejected ?? false,
    approvalSource: varying.approvalSource ?? null,
    repositoryApproval: false,
    pausedPortion: varying.pausedPortion ?? null,
    feasible: false,
    scheduled: false,
    jobLaunched: false,
    refused: varying.refused ?? false,
    chosenRole: varying.chosenRole ?? null,
    permissionAdded: false,
    recommendation: varying.recommendation ?? null,
    forceDelete: false,
    guessedDate: null,
    allowlistExpanded: false,
    invocation: 'unauthorized',
    rankedTool: varying.rankedTool ?? null,
    autoApproved: false,
    patchAccepted: false,
    rankedPatch: varying.rankedPatch ?? null,
    mandatoryReviewers: varying.mandatoryReviewers ?? [],
    reviewerWaived: false,
    testDisabled: false,
    vulnerabilityAbsenceCertified: false,
    accessGranted: false,
    supplementary: varying.supplementary ?? false,
    consentFromNegativeFlag: false,
    diagnosis: varying.diagnosis ?? null,
    ciSecretsChanged: false,
    requiredChecksChanged: false,
    ciImported: false,
    packageInstalled: false,
    risks: varying.risks ?? [],
    productionMigrationRun: false,
    rehearsalRequired: true,
    undocumentedBehaviorAsserted: false,
    docIds: varying.docIds ?? [],
    activated: false,
    repositoryExceptions: varying.repositoryExceptions ?? [],
  };
}

function abstain(): BoundedAdvice {
  return result({
    verb: 'abstain',
    capabilityId: null,
    text: 'Advice abstained. No action was applied.',
  });
}

function cap02(): BoundedAdvice {
  return result({
    verb: 'ask',
    capabilityId: 'CAP-02',
    text: 'What consequence follows if this choice is wrong?',
  });
}

function cap03(input: Record<string, unknown>): BoundedAdvice {
  const supplied = new Set(safeList(own(input, 'suppliedIds')));
  const uncovered = safeList(own(input, 'requirementIds')).filter((id) => !supplied.has(id));
  const cycle = hasCycle(own(input, 'graph'));
  const oversized = own(input, 'oversized') === true;
  const pause = uncovered.length > 0 || cycle || oversized;
  return result({
    verb: pause ? 'pause' : 'rank',
    capabilityId: 'CAP-03',
    text: 'Uncovered or cyclic scope is flagged. The requirement text was not rewritten.',
    uncoveredIds: uncovered,
    cycleRejected: cycle,
  });
}

function cap06(input: Record<string, unknown>): BoundedAdvice {
  const source = own(input, 'approvalSource');
  return result({
    verb: 'pause',
    capabilityId: 'CAP-06',
    text: 'Pause only the out-of-scope portion. Repository text is not approval.',
    approvalSource: source === 'trusted-channel' ? 'trusted-channel' : null,
    pausedPortion: 'out-of-scope',
  });
}

function cap07(): BoundedAdvice {
  return result({
    verb: 'rank',
    capabilityId: 'CAP-07',
    text: 'Rank recorded. The highest score is not feasibility.',
  });
}

function cap49(): BoundedAdvice {
  return result({
    verb: 'ask',
    capabilityId: 'CAP-49',
    text: 'Suggest caution. Access is not granted.',
  });
}

function cap51(): BoundedAdvice {
  return result({
    verb: 'pause',
    capabilityId: 'CAP-51',
    text: 'Flag the text as supplementary. A negative flag is not consent.',
    supplementary: true,
  });
}

const TABLE: { readonly [id: string]: (input: Record<string, unknown>) => BoundedAdvice } = {
  'CAP-02': () => cap02(),
  'CAP-03': cap03,
  'CAP-06': cap06,
  'CAP-07': () => cap07(),
  'CAP-49': () => cap49(),
  'CAP-51': () => cap51(),
};

export function adviseBounded(input: unknown): BoundedAdvice {
  if (!isPlain(input) || hasDangerousKey(input)) return abstain();
  const id = own(input, 'capabilityId');
  if (typeof id !== 'string') return abstain();
  const handler = TABLE[id];
  if (handler === undefined) return abstain();
  return handler(input);
}
