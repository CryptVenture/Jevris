/**
 * `jevris cost-report [--json]` (EVL-08, US33, §19.4, C55): what Jevris's own decision calls
 * cost, from C's `cost.report` sidecar op. Three measures are kept apart and labelled, never
 * added together and never turned into a saving:
 *   - actual: decision-call cost the provider reported or a billing export reconciled;
 *   - API-equivalent estimate: what the same usage would cost at API list price;
 *   - counterfactual: what another route would have cost, a hypothesis only.
 * A measure the op does not supply reads "unmeasured" or "hypothetical", never zero. Usage that
 * is still unknown stays unknown. The journal lives with the sidecar, so there is no local report.
 * Beside it, D's `learning.report` (2794ac4) adds a Learning section, counts only; a sidecar
 * without that op, or an answer that does not match, leaves the section out and is no error.
 */
import { COMMAND_EXIT_CODES, FEEDBACK_REASONS, jevBudgetText } from '@jevris/contracts';
import { decisionOutcomeLines, estimatorCalibrationLines, feedbackLines, type DecisionOutcomeReport, type EstimatorCalibration, type FeedbackKindReport, type FeedbackReport } from '@jevris/core';
import { localFirstTryCost } from './first-try-local.js';
import { firstTryCostLines } from './first-try-lines.js';
import { checkLearningReport, learningReportLines, type LearningReportView } from './learning-report.js';
import { effectiveSettings } from './public/local.js';
import { defaultPorts } from './public/ports.js';
import { firstTryOf, type FirstTryCostView } from '@jevris/orchestrator';
import { contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';
import { homeRefusal } from './public/home-guard.js';

type Write = (text: string) => void;

export const COST_REPORT_HELP = `Usage: jevris cost-report [--json] [--home <dir>] [--workspace <dir>]

What Jevris's own decision calls cost in this workspace, as three separate labelled measures:
actual (provider-reported or reconciled billing), the API-equivalent estimate, and the
counterfactual (what another route would have cost; a hypothesis, never a saving). A measure
Jevris has not got reads "unmeasured" or "hypothetical", never zero. The cost of your coding
harness itself is not Jevris's to see and is not included. It shows this month's Jev spend
against the machine-wide limit (decisions.monthlyBudgetMicroUsd), against this workspace's cap
(jevris configure workspace-budget) when it has one, and the date both reset. It also shows how the token
estimator's estimates compare with the input tokens the provider reported (min, p10, median,
p90, max of estimate / reported), with a warning when an estimate was below the reported
count or the provider refused a request's size, and, per decision kind, how many decisions
had a known task outcome, how many of those tasks verified, and how often Jev answered or
abstained. Your feedback on advice (jevris feedback) is shown per decision kind: accepted,
rejected by reason, and the error rate with its interval; it never changes a policy. A Learning section adds what the orchestrator learned here, counts only: owned
tasks' estimates against what they committed, restores and what followed them, the Stop
reminders and what followed them, and how often evidence a selection ranked was read. A
sidecar that cannot say leaves the section out.

Options:
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line

Exit codes: 0 report printed; 1 no report (the sidecar is not running); 2 usage error.

Examples:
  jevris cost-report
  jevris cost-report --json`;

type Measure = number | 'unknown' | 'unmeasured' | 'hypothetical';

export interface CostReport {
  readonly providerConfigured: boolean;
  readonly budget: {
    readonly period: string;
    readonly limitMicroUsd: number;
    readonly committedMicroUsd: number;
    readonly reservedMicroUsd: number;
    readonly availableMicroUsd: number;
    /** When the month ends and both limits start again (UTC); null when the sidecar does not say. */
    readonly resetsAt: string | null;
    /** This workspace's own cap and its use this month; null when it has none (owner decision 2026-09-29). */
    readonly workspace: { readonly limitMicroUsd: number; readonly committedMicroUsd: number; readonly reservedMicroUsd: number; readonly availableMicroUsd: number } | null;
  } | null;
  readonly decisions: {
    readonly total: number;
    readonly providerCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly usageUnknown: number;
    readonly actualMicroUsd: number;
    readonly byBillingBasis: { readonly [basis: string]: number };
    readonly scanned: number;
    readonly truncated: boolean;
  } | null;
  readonly measures: { readonly actual: Measure; readonly apiEquivalentEstimate: Measure; readonly counterfactual: Measure };
  readonly note: string | null;
  readonly diagnostics: readonly string[];
  /**
   * P7 (C 5a0d00c): the token estimator's estimate over the provider-reported input tokens for
   * this workspace's decisions; null when the sidecar sends none or it does not match.
   */
  readonly estimator: EstimatorCalibration | null;
  /**
   * P4 (C df9087b): this workspace's decisions joined to their tasks' verified outcomes, per
   * decision kind. Codes and counts only; null when the sidecar sends none or it does not match.
   */
  readonly outcomes: DecisionOutcomeReport | null;
  /**
   * P12 (C 216d411): people's feedback on advice per decision kind, as hypotheses for a reviewed
   * release. Codes and counts only; null when the sidecar sends none or it does not match.
   */
  readonly feedback: FeedbackReport | null;
  /** D's learning.report (2794ac4), counts only; null when the sidecar sends none or it does not match. */
  readonly learning: LearningReportView | null;
  /**
   * Sonnet-first routing (owner decision 2026-09-30, visibility): tasks started, handed up and
   * completed on the first try, and the spend against the baseline estimate, read from this
   * workspace's first-try ledger. Integer micro-USD, null where the data to compute a figure does
   * not exist; null itself when the ledger cannot be read.
   */
  readonly firstTry: FirstTryCostView | null;
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const BASIS = /^[a-z][a-z-]{0,63}$/;

function measure(value: unknown, absent: 'unknown' | 'unmeasured' | 'hypothetical'): Measure | null {
  if (value === undefined) return absent;
  if (value === absent) return absent;
  if (count(value)) return value;
  if (typeof value === 'string' && /^\d{1,18}$/.test(value)) return Number(value);
  return null;
}

const ENCODER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const ESTIMATOR_STATUSES = ['no-samples', 'ok', 'under-estimate'] as const;
const ratioValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

/** C's `jevris-estimator-calibration-1` block, checked; null when it does not match. */
export function checkEstimator(raw: unknown): EstimatorCalibration | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as { [key: string]: unknown };
  if (e['schemaVersion'] !== 'jevris-estimator-calibration-1' || typeof e['encoderId'] !== 'string' || !ENCODER.test(e['encoderId'])) return null;
  if (![e['samples'], e['otherEncoder'], e['underEstimates'], e['repacked']].every(count)) return null;
  const status = ESTIMATOR_STATUSES.find((s) => s === e['status']);
  if (status === undefined || !Array.isArray(e['reasonCodes']) || e['reasonCodes'].length > 8 || !e['reasonCodes'].every((c) => typeof c === 'string' && REASON.test(c))) return null;
  let ratio: EstimatorCalibration['ratio'] = null;
  if (e['ratio'] !== null) {
    const r = e['ratio'] as { [key: string]: unknown } | undefined;
    if (r === undefined || typeof r !== 'object' || !['min', 'p10', 'p50', 'p90', 'max'].every((k) => ratioValue(r[k]))) return null;
    ratio = { min: r['min'] as number, p10: r['p10'] as number, p50: r['p50'] as number, p90: r['p90'] as number, max: r['max'] as number };
  }
  if ((e['samples'] as number) > 0 && ratio === null) return null;
  return {
    schemaVersion: 'jevris-estimator-calibration-1',
    encoderId: e['encoderId'],
    samples: e['samples'] as number,
    otherEncoder: e['otherEncoder'] as number,
    ratio,
    underEstimates: e['underEstimates'] as number,
    repacked: e['repacked'] as number,
    status,
    reasonCodes: e['reasonCodes'] as string[],
  };
}

const KIND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OUTCOME_COUNTS = ['decisions', 'verifiedSuccess', 'verifiedFailure', 'abandoned', 'unknown', 'jevAnswered', 'jevAnsweredVerified', 'abstained'] as const;

/** C's `jevris-decision-outcomes-1` block, checked; null when it does not match. */
export function checkOutcomes(raw: unknown): DecisionOutcomeReport | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { [key: string]: unknown };
  if (o['schemaVersion'] !== 'jevris-decision-outcomes-1' || !count(o['decisionsWithOutcome']) || !count(o['sessionWindowOnly'])) return null;
  if (!Array.isArray(o['byKind']) || o['byKind'].length > 32) return null;
  const byKind: DecisionOutcomeReport['byKind'][number][] = [];
  for (const item of o['byKind'] as unknown[]) {
    if (item === null || typeof item !== 'object') return null;
    const k = item as { [key: string]: unknown };
    if (typeof k['kind'] !== 'string' || !KIND.test(k['kind']) || !OUTCOME_COUNTS.every((key) => count(k[key]))) return null;
    byKind.push({
      kind: k['kind'],
      decisions: k['decisions'] as number,
      verifiedSuccess: k['verifiedSuccess'] as number,
      verifiedFailure: k['verifiedFailure'] as number,
      abandoned: k['abandoned'] as number,
      unknown: k['unknown'] as number,
      jevAnswered: k['jevAnswered'] as number,
      jevAnsweredVerified: k['jevAnsweredVerified'] as number,
      abstained: k['abstained'] as number,
    });
  }
  return { schemaVersion: 'jevris-decision-outcomes-1', decisionsWithOutcome: o['decisionsWithOutcome'] as number, sessionWindowOnly: o['sessionWindowOnly'] as number, byKind };
}

const share = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const HYPOTHESES = new Set(['possible-error', 'unavailable-context', 'preference-only']);

/** C's `jevris-feedback-report-1` block, checked; null when it does not match. */
export function checkFeedback(raw: unknown): FeedbackReport | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = raw as { [key: string]: unknown };
  if (f['schemaVersion'] !== 'jevris-feedback-report-1' || !count(f['total']) || f['policyChanged'] !== false) return null;
  if (!Array.isArray(f['byKind']) || f['byKind'].length > 32) return null;
  const byKind: FeedbackKindReport[] = [];
  for (const item of f['byKind'] as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const k = item as { [key: string]: unknown };
    const by = k['rejectedBy'] as { [key: string]: unknown } | null;
    if (typeof k['kind'] !== 'string' || !KIND.test(k['kind']) || !count(k['total']) || !count(k['accepted']) || k['accepted'] > k['total']) return null;
    if (by === null || typeof by !== 'object' || !FEEDBACK_REASONS.every((reason) => count(by[reason]))) return null;
    const rate = k['errorRate'] as { [key: string]: unknown } | null;
    if (rate !== null && (typeof rate !== 'object' || !share(rate['point']) || !share(rate['lower']) || !share(rate['upper']))) return null;
    if (!(k['unlabelledShare'] === null || share(k['unlabelledShare']))) return null;
    const hypotheses = k['hypotheses'];
    if (!Array.isArray(hypotheses) || hypotheses.length > 3) return null;
    if (!hypotheses.every((h) => h !== null && typeof h === 'object' && HYPOTHESES.has((h as { kind?: unknown }).kind as string) && (h as { action?: unknown }).action === 'review-through-release-pipeline')) return null;
    byKind.push({
      kind: k['kind'],
      total: k['total'],
      accepted: k['accepted'],
      rejectedBy: { preference: by['preference'] as number, 'unavailable-context': by['unavailable-context'] as number, error: by['error'] as number, unspecified: by['unspecified'] as number },
      errorRate: rate === null ? null : { point: rate['point'] as number, lower: rate['lower'] as number, upper: rate['upper'] as number },
      unlabelledShare: k['unlabelledShare'] as number | null,
      hypotheses: hypotheses.map((h) => ({ kind: (h as { kind: FeedbackKindReport['hypotheses'][number]['kind'] }).kind, action: 'review-through-release-pipeline' as const })),
    });
  }
  return { schemaVersion: 'jevris-feedback-report-1', total: f['total'], byKind, policyChanged: false };
}

function line(text: unknown): string | null {
  return typeof text === 'string' && text.length > 0 && text.length <= 500 && !/[\r\n]/.test(text) ? text : null;
}

/** Checks the op's answer; null when it does not match C's `jevris-cost-report-1` shape. */
export function checkCostReport(raw: unknown): CostReport | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { [key: string]: unknown };
  if (r['schemaVersion'] !== 'jevris-cost-report-1' || typeof r['providerConfigured'] !== 'boolean') return null;
  let budget: CostReport['budget'] = null;
  if (r['budget'] !== null && r['budget'] !== undefined) {
    const b = r['budget'] as { [key: string]: unknown };
    if (typeof b !== 'object' || typeof b['period'] !== 'string' || b['period'].length > 64) return null;
    if (![b['limitMicroUsd'], b['committedMicroUsd'], b['reservedMicroUsd'], b['availableMicroUsd']].every(count)) return null;
    const resetsAt = typeof b['resetsAt'] === 'string' && b['resetsAt'].length <= 40 && !Number.isNaN(Date.parse(b['resetsAt'])) ? b['resetsAt'] : null;
    let workspace: NonNullable<CostReport['budget']>['workspace'] = null;
    const w = b['workspace'];
    if (w !== null && w !== undefined) {
      if (typeof w !== 'object' || Array.isArray(w)) return null;
      const o = w as { [key: string]: unknown };
      if (![o['limitMicroUsd'], o['committedMicroUsd'], o['reservedMicroUsd'], o['availableMicroUsd']].every(count)) return null;
      // A hold counts against the cap like a reservation.
      const held = count(o['heldMicroUsd']) ? o['heldMicroUsd'] : 0;
      workspace = { limitMicroUsd: o['limitMicroUsd'] as number, committedMicroUsd: o['committedMicroUsd'] as number, reservedMicroUsd: (o['reservedMicroUsd'] as number) + held, availableMicroUsd: o['availableMicroUsd'] as number };
    }
    budget = { period: b['period'], limitMicroUsd: b['limitMicroUsd'] as number, committedMicroUsd: b['committedMicroUsd'] as number, reservedMicroUsd: b['reservedMicroUsd'] as number, availableMicroUsd: b['availableMicroUsd'] as number, resetsAt, workspace };
  }
  let decisions: CostReport['decisions'] = null;
  if (r['decisions'] !== null && r['decisions'] !== undefined) {
    const d = r['decisions'] as { [key: string]: unknown };
    if (typeof d !== 'object') return null;
    const numbers = ['total', 'providerCalls', 'inputTokens', 'outputTokens', 'usageUnknown', 'actualMicroUsd', 'scanned'] as const;
    if (!numbers.every((key) => count(d[key])) || typeof d['truncated'] !== 'boolean') return null;
    const byBasis: { [basis: string]: number } = {};
    const rawBasis = d['byBillingBasis'];
    if (rawBasis !== null && typeof rawBasis === 'object' && !Array.isArray(rawBasis)) {
      for (const [basis, n] of Object.entries(rawBasis as { [key: string]: unknown }).slice(0, 16)) {
        if (!BASIS.test(basis) || !count(n)) return null;
        byBasis[basis] = n;
      }
    }
    decisions = {
      total: d['total'] as number,
      providerCalls: d['providerCalls'] as number,
      inputTokens: d['inputTokens'] as number,
      outputTokens: d['outputTokens'] as number,
      usageUnknown: d['usageUnknown'] as number,
      actualMicroUsd: d['actualMicroUsd'] as number,
      byBillingBasis: byBasis,
      scanned: d['scanned'] as number,
      truncated: d['truncated'] as boolean,
    };
  }
  // The three measures: from the op's billing block when it sends one (the store's billingReport
  // labels), else actual from the journal and the other two not measured.
  const billing = r['billing'] !== null && typeof r['billing'] === 'object' ? (r['billing'] as { [key: string]: unknown }) : {};
  const actual = billing['subscriptionActual'] !== undefined ? measure(billing['subscriptionActual'], 'unknown') : decisions === null ? 'unknown' : decisions.actualMicroUsd;
  const apiEquivalentEstimate = measure(billing['apiEquivalentEstimate'], 'unmeasured');
  const counterfactual = measure(billing['counterfactualHypothetical'], 'hypothetical');
  if (actual === null || apiEquivalentEstimate === null || counterfactual === null) return null;
  const diagnostics = Array.isArray(r['diagnostics']) ? r['diagnostics'].map(line).filter((x): x is string => x !== null).slice(0, 8) : [];
  return { providerConfigured: r['providerConfigured'], budget, decisions, measures: { actual, apiEquivalentEstimate, counterfactual }, note: line(r['note']), diagnostics, estimator: checkEstimator(r['estimator']), outcomes: checkOutcomes(r['outcomes']), feedback: checkFeedback(r['feedback']), learning: null, firstTry: null };
}

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

function measureText(value: Measure): string {
  if (typeof value === 'number') return usd(value);
  if (value === 'unmeasured') return 'unmeasured';
  if (value === 'hypothetical') return 'hypothetical (not claimed as a saving)';
  return 'unknown';
}

export function renderCostReport(report: CostReport): string {
  const lines = ['Jevris decision-call cost for this workspace. The three measures are separate; none is a saving.'];
  const actualBasis = report.decisions === null ? '' : report.decisions.usageUnknown > 0 ? ` (${report.decisions.usageUnknown} call(s) with usage not yet known are not included)` : '';
  lines.push(`actual (reported or reconciled billing): ${measureText(report.measures.actual)}${actualBasis}`);
  lines.push(`API-equivalent estimate: ${measureText(report.measures.apiEquivalentEstimate)}`);
  lines.push(`counterfactual: ${measureText(report.measures.counterfactual)}`);
  lines.push(`provider configured: ${report.providerConfigured ? 'yes' : 'no'}`);
  if (report.decisions !== null) {
    const d = report.decisions;
    lines.push(`decisions: ${d.total}${d.truncated ? ` (the newest ${d.scanned} scanned)` : ''}`, `provider calls: ${d.providerCalls}`, `tokens: ${d.inputTokens} input, ${d.outputTokens} output`);
    for (const [basis, n] of Object.entries(d.byBillingBasis)) lines.push(`billing basis ${basis}: ${n}`);
  }
  if (report.budget !== null) {
    const b = report.budget;
    lines.push(`budget ${b.period}: ${usd(b.committedMicroUsd)} committed, ${usd(b.reservedMicroUsd)} reserved, ${usd(b.availableMicroUsd)} available of ${usd(b.limitMicroUsd)}`);
    // Owner decision 2026-09-29: the limit is machine-wide; a workspace may have its own cap inside it.
    const zero = b.limitMicroUsd === 0 ? '; 0 means no Jev calls, decisions run rules-only' : '';
    lines.push(`jev budget: ${jevBudgetText(b.committedMicroUsd)} spent of the machine-wide limit ${jevBudgetText(b.limitMicroUsd)} in ${b.period}${zero}${b.resetsAt === null ? '' : `; resets ${b.resetsAt.slice(0, 10)} (UTC)`}`);
    if (b.workspace !== null) {
      const w = b.workspace;
      lines.push(`jev budget this workspace: ${jevBudgetText(w.committedMicroUsd)} spent, ${jevBudgetText(w.reservedMicroUsd)} reserved, ${jevBudgetText(w.availableMicroUsd)} available of its cap ${jevBudgetText(w.limitMicroUsd)} in ${b.period}`);
    }
    if (b.availableMicroUsd === 0) lines.push('jev budget spent: the machine-wide limit (BUDGET_MACHINE_LIMIT); decisions run rules-only until it resets');
    else if (b.workspace !== null && b.workspace.availableMicroUsd === 0) lines.push("jev budget spent: this workspace's cap (BUDGET_WORKSPACE_CAP); its decisions run rules-only until it resets");
  }
  // The distribution and any under-estimate warning, in C's own words, from the checked numbers.
  if (report.estimator !== null) lines.push(...estimatorCalibrationLines(report.estimator));
  // Which decisions led to verified work, in C's own words, from the checked counts.
  if (report.outcomes !== null) lines.push(...decisionOutcomeLines(report.outcomes));
  // Feedback on advice, in C's own words, from the checked counts; never a policy change.
  if (report.feedback !== null) lines.push(...feedbackLines(report.feedback));
  if (report.learning !== null) lines.push(...learningReportLines(report.learning));
  if (report.firstTry !== null) lines.push(...firstTryCostLines(report.firstTry));
  if (report.note !== null) lines.push(report.note);
  for (const diagnostic of report.diagnostics) lines.push(`diagnostic: ${diagnostic}`);
  return `${lines.join('\n')}\n`;
}

/** Runs `jevris cost-report ...` (argv after `cost-report`). */
export async function runCostReportCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(`${COST_REPORT_HELP}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, ['--home', '--workspace'], ['--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help cost-report for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals.length > 0) return usage('cost-report takes no arguments.');
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  const out = (result: object, text: string, code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'cost-report', ...result })}\n` : text);
    return code;
  };
  const unavailable = (reasonCode: string): number =>
    out({ report: null, reasonCode }, `No cost report (${reasonCode}). The decision journal is read by the Jevris sidecar: start it with jevris sidecar start and retry.\n`, COMMAND_EXIT_CODES.negative);
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return unavailable(`SIDECAR_${ensured.reason.toUpperCase()}`);
  }
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'cost.report', workspace: ctx.workspaceRoot ?? ctx.workspaceId, body: {}, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'background' });
  if (!answer.ok) return unavailable(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  const report = checkCostReport(answer.result);
  if (report === null) return unavailable('SIDECAR_INVALID_RESULT');
  // D's learning.report: an older sidecar without the op, or any refusal, leaves the section out.
  const learned = await ctx.ports.sidecar.request({ home: ctx.home, op: 'learning.report', workspace: ctx.workspaceRoot ?? ctx.workspaceId, body: {}, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'background' });
  // Sonnet-first routing: the local first-try ledger, read with the same functions the sidecar's status uses.
  const firstTry = await localFirstTryCost(ctx, firstTryOf(effectiveSettings(ctx).config));
  const full: CostReport = { ...report, learning: learned.ok ? checkLearningReport(learned.result) : null, firstTry };
  return out({ report: full, reasonCode: null }, renderCostReport(full), COMMAND_EXIT_CODES.ok);
}
