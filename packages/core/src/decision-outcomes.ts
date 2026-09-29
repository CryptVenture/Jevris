/**
 * P4 (learning-coverage audit; owner decision DOMAINS 7922ee3): Jev decisions joined to their
 * task's deterministic outcome (B's store table `decision_outcome`, written by D when a task gets
 * its label). Text-free: codes, counts and ids only.
 *
 * - `taskOutcomeOfLabels` gives explain the decision's `actualTaskOutcome`. The decision record on
 *   disk stays immutable; explain shows it as a view.
 * - `decisionOutcomeReport` is the local report: per decision kind, how many decisions have a known
 *   outcome, how many the task later verified, and how many Jev answered on tasks that later
 *   verified.
 * - Nothing here tunes a live threshold (SPEC §18.5, C52, C67). Local labels become calibration
 *   cases only through a person's review and a signed release, and they never leave the machine.
 */
import type { DecisionRecord } from '@jevris/contracts';

export type TaskOutcome = DecisionRecord['actualTaskOutcome'];

/** The route-learning labels (and run-incomplete), as task outcomes. */
export function taskOutcomeOfLabel(label: string): TaskOutcome {
  switch (label) {
    case 'verified-pass':
      return 'verified-success';
    case 'verified-fail':
    case 'reverted':
    case 'retried':
    case 'run-incomplete':
      return 'verified-failure';
    case 'cancelled':
      return 'abandoned';
    default:
      return 'unknown';
  }
}

/** The fields of a joined row this module reads (B's DecisionOutcomeRow has them all). */
export interface JoinedOutcome {
  readonly decisionId: string;
  readonly kind: string;
  readonly decisionOutcome: string;
  readonly providerCalls: number;
  readonly label: string;
  readonly joinBasis: 'task' | 'session-window';
  readonly labelledAtMs: number;
}

/**
 * One decision's task outcome: its task-joined label when there is one, else its session-window
 * label, the latest of either; `not-yet-observed` with none.
 */
export function taskOutcomeOfLabels(rows: readonly Pick<JoinedOutcome, 'label' | 'joinBasis' | 'labelledAtMs'>[]): TaskOutcome {
  if (rows.length === 0) return 'not-yet-observed';
  const task = rows.filter((r) => r.joinBasis === 'task');
  const pool = task.length > 0 ? task : rows;
  const latest = [...pool].sort((a, b) => b.labelledAtMs - a.labelledAtMs)[0] as { readonly label: string };
  return taskOutcomeOfLabel(latest.label);
}

export interface DecisionKindOutcomes {
  readonly kind: string;
  /** Decisions with a known task outcome (task-joined). */
  readonly decisions: number;
  readonly verifiedSuccess: number;
  readonly verifiedFailure: number;
  readonly abandoned: number;
  readonly unknown: number;
  /** Decisions Jev answered (a provider call, not abstained) … */
  readonly jevAnswered: number;
  /** … whose task later verified. */
  readonly jevAnsweredVerified: number;
  /** Decisions that abstained (rules-only or the fallback). */
  readonly abstained: number;
}

export interface DecisionOutcomeReport {
  readonly schemaVersion: 'jevris-decision-outcomes-1';
  /** Decisions with a task-joined outcome. */
  readonly decisionsWithOutcome: number;
  /** Decisions joined only through their session window (counted apart, never calibrated on). */
  readonly sessionWindowOnly: number;
  readonly byKind: readonly DecisionKindOutcomes[];
}

/** The local report over joined rows. A decision counts once, with its latest task-joined label. */
export function decisionOutcomeReport(rows: readonly JoinedOutcome[]): DecisionOutcomeReport {
  const byDecision = new Map<string, JoinedOutcome[]>();
  for (const r of rows) byDecision.set(r.decisionId, [...(byDecision.get(r.decisionId) ?? []), r]);
  const kinds = new Map<string, { decisions: number; verifiedSuccess: number; verifiedFailure: number; abandoned: number; unknown: number; jevAnswered: number; jevAnsweredVerified: number; abstained: number }>();
  let sessionWindowOnly = 0;
  let decisionsWithOutcome = 0;
  for (const list of byDecision.values()) {
    const task = list.filter((r) => r.joinBasis === 'task');
    if (task.length === 0) {
      sessionWindowOnly += 1;
      continue;
    }
    decisionsWithOutcome += 1;
    const latest = [...task].sort((a, b) => b.labelledAtMs - a.labelledAtMs)[0] as JoinedOutcome;
    const outcome = taskOutcomeOfLabel(latest.label);
    const k = kinds.get(latest.kind) ?? { decisions: 0, verifiedSuccess: 0, verifiedFailure: 0, abandoned: 0, unknown: 0, jevAnswered: 0, jevAnsweredVerified: 0, abstained: 0 };
    k.decisions += 1;
    if (outcome === 'verified-success') k.verifiedSuccess += 1;
    else if (outcome === 'verified-failure') k.verifiedFailure += 1;
    else if (outcome === 'abandoned') k.abandoned += 1;
    else k.unknown += 1;
    const answered = latest.providerCalls > 0 && latest.decisionOutcome !== 'abstained' && latest.decisionOutcome !== 'refused' && latest.decisionOutcome !== 'quarantined';
    if (answered) {
      k.jevAnswered += 1;
      if (outcome === 'verified-success') k.jevAnsweredVerified += 1;
    }
    if (latest.decisionOutcome === 'abstained') k.abstained += 1;
    kinds.set(latest.kind, k);
  }
  return {
    schemaVersion: 'jevris-decision-outcomes-1',
    decisionsWithOutcome,
    sessionWindowOnly,
    byKind: [...kinds.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([kind, k]) => ({ kind, ...k })),
  };
}

/** Plain-text lines for cost-report and status. */
export function decisionOutcomeLines(report: DecisionOutcomeReport): string[] {
  if (report.decisionsWithOutcome === 0) {
    return [`Decisions with a known task outcome: none yet${report.sessionWindowOnly > 0 ? ` (${report.sessionWindowOnly} joined only by session, not counted)` : ''}.`];
  }
  return [
    `Decisions with a known task outcome: ${report.decisionsWithOutcome}${report.sessionWindowOnly > 0 ? ` (and ${report.sessionWindowOnly} joined only by session, not counted)` : ''}.`,
    ...report.byKind.map((k) => `${k.kind}: ${k.decisions} with an outcome, ${k.verifiedSuccess} verified, ${k.verifiedFailure} failed, ${k.abandoned} abandoned, ${k.unknown} unknown; Jev answered ${k.jevAnswered}, of which ${k.jevAnsweredVerified} on tasks that later verified; ${k.abstained} abstained.`),
  ];
}
