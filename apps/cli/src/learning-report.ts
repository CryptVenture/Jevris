/**
 * D's `learning.report` (2794ac4) as the CLI shows it: what the orchestrator has learned in a
 * workspace, ids and counts only. Four blocks, each checked on its own and null when it does
 * not match:
 *   - estimates (P11): owned tasks' estimates against what their leases committed;
 *   - restores (P9): restore outcomes and what followed them;
 *   - reminders (P6): the Stop reminders and what followed them;
 *   - evidence (P10): evidence selections and the reads that followed.
 * `budget.get` carries the same estimates block for one root budget. Nothing here is a saving.
 */

type Rec = { readonly [key: string]: unknown };

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const share = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
const ratio = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000);

export interface EstimatesView {
  readonly tasks: number;
  readonly compared: number;
  readonly estimateMicroUsd: number;
  readonly actualMicroUsd: number;
  readonly medianRatio: number | null;
  readonly underEstimated: number;
}

export interface RestoresView {
  readonly delivered: number;
  readonly degraded: number;
  readonly refused: number;
  readonly omittedItems: number;
  readonly reasked: number;
  readonly withRepeats: number;
  readonly checkStarted: number;
  readonly verified: number;
}

export interface RemindersView {
  readonly fired: number;
  readonly ledToCheck: number;
  readonly ledToVerification: number;
  readonly endedUnverified: number;
}

export interface EvidenceView {
  readonly selections: number;
  readonly reads: number;
  readonly readsFromSelection: number;
  readonly precisionAtK: number | null;
  readonly k: number;
  readonly recall: number | null;
}

export interface LearningReportView {
  readonly estimates: EstimatesView | null;
  readonly restores: RestoresView | null;
  readonly reminders: RemindersView | null;
  readonly evidence: EvidenceView | null;
}

/** The named counts of a block, copied; null when one is missing or not a count. */
function counts<K extends string>(raw: unknown, keys: readonly K[]): { readonly [key in K]: number } | null {
  if (!isRec(raw)) return null;
  const outCounts = {} as { [key in K]: number };
  for (const key of keys) {
    const value = raw[key];
    if (!count(value)) return null;
    outCounts[key] = value;
  }
  return outCounts;
}

/** D's estimateAccuracy block; null when it does not match. */
export function checkEstimates(raw: unknown): EstimatesView | null {
  const c = counts(raw, ['tasks', 'compared', 'estimateMicroUsd', 'actualMicroUsd', 'underEstimated'] as const);
  if (c === null || !isRec(raw) || !ratio(raw['medianRatio']) || c.compared > c.tasks || c.underEstimated > c.compared) return null;
  return { ...c, medianRatio: raw['medianRatio'] };
}

/** D's reminderSummary block; null when it does not match. */
export function checkReminders(raw: unknown): RemindersView | null {
  return counts(raw, ['fired', 'ledToCheck', 'ledToVerification', 'endedUnverified'] as const);
}

function checkEvidence(raw: unknown): EvidenceView | null {
  const c = counts(raw, ['selections', 'reads', 'readsFromSelection', 'k'] as const);
  if (c === null || !isRec(raw) || !share(raw['precisionAtK']) || !share(raw['recall'])) return null;
  return { ...c, precisionAtK: raw['precisionAtK'], recall: raw['recall'] };
}

/** D's learning.report answer, each block checked on its own; null when it is not an object. */
export function checkLearningReport(raw: unknown): LearningReportView | null {
  if (!isRec(raw)) return null;
  return {
    estimates: checkEstimates(raw['estimates']),
    restores: counts(raw['restores'], ['delivered', 'degraded', 'refused', 'omittedItems', 'reasked', 'withRepeats', 'checkStarted', 'verified'] as const),
    reminders: checkReminders(raw['reminders']),
    evidence: checkEvidence(raw['evidence']),
  };
}

const dollars = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(4)}`;
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** The Stop reminders line, shared by `jevris status` and the cost report. */
export function reminderLine(m: RemindersView): string {
  return `reminders (Stop): ${m.fired} fired, ${m.ledToCheck} led to a check, ${m.ledToVerification} led to verification, ${m.endedUnverified} ended unverified`;
}

/** The estimates line, shared by the cost report (whole workspace) and `jevris budget status` (one plan). */
export function estimatesLine(e: EstimatesView): string {
  const head = `estimates: ${e.tasks} finished task(s)`;
  if (e.compared === 0) return `${head}; none has a committed cost to compare with its estimate yet`;
  const median = e.medianRatio === null ? 'n/a' : e.medianRatio.toFixed(2);
  return `${head}, ${e.compared} compared: estimated ${dollars(e.estimateMicroUsd)}, committed ${dollars(e.actualMicroUsd)}, median committed / estimate ${median}, ${e.underEstimated} over their estimate`;
}

/** The "Learning" section of the cost report; empty when no block matched. */
export function learningReportLines(report: LearningReportView): string[] {
  const lines: string[] = [];
  if (report.estimates !== null) lines.push(estimatesLine(report.estimates));
  if (report.restores !== null) {
    const r = report.restores;
    lines.push(`restores: ${r.delivered} delivered, ${r.degraded} degraded, ${r.refused} refused, ${r.omittedItems} item(s) left out; after a restore ${r.reasked} re-asked, ${r.withRepeats} repeated a failure, ${r.checkStarted} started a check, ${r.verified} verified`);
  }
  if (report.reminders !== null) lines.push(reminderLine(report.reminders));
  if (report.evidence !== null) {
    const v = report.evidence;
    lines.push(`evidence: ${v.selections} selection(s), ${v.reads} read(s), ${v.readsFromSelection} of them ranked by a selection; precision at ${v.k} ${pct(v.precisionAtK)}, recall ${pct(v.recall)}`);
  }
  return lines.length === 0 ? [] : ['Learning in this workspace (ids and counts only; none is a saving):', ...lines];
}
