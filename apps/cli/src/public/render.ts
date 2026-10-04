/**
 * Plain-text rendering of surface results (§4.4): one summary sentence first, then labelled
 * lines. No colour, no symbols that carry meaning alone, stable wording for screen readers.
 */
import { accessUsageLines, untimedClearTextFor } from '@jevris/core';
import { jevBudgetText, servingHostOf, type ModeSource, type PlanSliceSuggestion, type RouteServing, type SurfaceOperation, type SurfacePayloads, type SurfaceResult } from '@jevris/contracts';
import { backgroundVerifyAtStopText } from '../background-verify-line.js';
import { firstTrySliceLines, firstTryStatusLine } from '../first-try-lines.js';
import { reminderLine } from '../learning-report.js';
import { latencyLines } from './latency.js';

/** Where the effective mode comes from, as status and configure name it. */
const MODE_SOURCE_TEXT: { readonly [S in ModeSource]: string } = {
  defaults: 'the defaults',
  user: 'your jevris.config.json',
  workspace: "the workspace's .jevris/config.json (it may only lower the mode)",
  organization: "your organization's organization.json (a ceiling)",
  host: "the administrator's host.json (a ceiling)",
  managed: 'the managed policy (a ceiling)',
};

/** Route-learning slice modes as users read them (C16): `auto` routes the learned model, so it is "active". */
const LEARNING_MODE = { advise: 'advice only', auto: 'active', pinned: 'pinned' } as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function summaryFor(op: SurfaceOperation, payload: unknown, mode: 'full' | 'reduced'): string {
  const tail = mode === 'reduced' ? ' (reduced mode)' : '';
  switch (op) {
    case 'status': {
      const p = payload as SurfacePayloads['status'];
      const stop = p.killSwitch === 'stopped' ? ' The kill switch is stopped.' : '';
      return `Jevris is in ${p.jevrisMode} mode; decision health is ${p.decisionHealth}${tail}.${stop}`;
    }
    case 'explain': {
      const p = payload as SurfacePayloads['explain'];
      return p.found && p.trace !== null
        ? `Decision ${p.decisionId} was ${p.trace.outcome}${tail}.`
        : `No decision ${p.decisionId} was found${tail}.`;
    }
    case 'route': {
      const p = payload as SurfacePayloads['route'];
      if (p.main.outcome === 'recommend' && p.main.recommendedModel !== null) {
        return `Jevris suggests ${p.main.recommendedModel} for the main session; nothing was switched${tail}.`;
      }
      if (p.main.pinState === 'pinned') return `Keep the pinned model ${p.main.modelPin ?? ''}; nothing was switched${tail}.`.replace('  ', ' ');
      return `No model change is recommended; nothing was switched${tail}.`;
    }
    case 'plan': {
      const p = payload as SurfacePayloads['plan'];
      return p.valid
        ? `The plan is valid: ${plural(p.taskCount, 'task')} in ${plural(p.waves.length, 'wave')}${tail}.`
        : `The plan has ${plural(p.issues.length, 'issue')} to fix before it can be scheduled${tail}.`;
    }
    case 'checkpoint': {
      const p = payload as SurfacePayloads['checkpoint'];
      return p.written
        ? `Checkpoint ${p.capsuleId} saved ${plural(p.items.length, 'item')}; compaction was not triggered${tail}.`
        : `Checkpoint ${p.capsuleId} could not be saved; compaction was not triggered${tail}.`;
    }
    case 'recover': {
      const p = payload as SurfacePayloads['recover'];
      return `Recovery advice: ${p.action} (${p.classification})${tail}.`;
    }
    case 'verify': {
      const p = payload as SurfacePayloads['verify'];
      if (p.readiness === 'verified') return `Verified: every mandatory check has a current passing receipt${tail}.`;
      if (p.readiness === 'no-checks') return `Not verified: no checks are declared for this work${tail}.`;
      if (p.readiness === 'needs-environment') {
        const needs = (p.needsEnvironment ?? []).map((id) => {
          const env = p.checks.find((c) => c.checkId === id)?.environment;
          return env === undefined || env === null ? id : `${id} (${env})`;
        });
        return `Software checks verified; needs another environment: ${needs.length === 0 ? 'unknown' : needs.join(', ')}${tail}.`;
      }
      // A check still running or queued is said so: "nothing ran" never stands alone while one is.
      const waiting = verifyWaiting(p);
      const state = waiting.length > 0 ? `; ${waiting.join(', ')}` : p.ran ? '' : '; nothing ran';
      return `Not verified: ${plural(p.missing.length, 'check')} without a current passing receipt${state}${tail}.`;
    }
    case 'configure': {
      const p = payload as SurfacePayloads['configure'];
      // JEV-0010: a dry run says what would change and that nothing was written; it never reads as a change made.
      if (p.dryRun === true) {
        return p.changed.length > 0
          ? `Would change ${p.changed.map((c) => c.key).join(', ')}; nothing was written (dry run); native permissions would not change${tail}.`
          : `Dry run: no setting would change; nothing was written${tail}.`;
      }
      if (p.changed.length > 0) return `Changed ${p.changed.map((c) => c.key).join(', ')}; native permissions were not changed${tail}.`;
      return p.valid
        ? `Configuration from ${p.source} is valid; mode is ${p.effective.mode}${tail}.`
        : `The configuration file is invalid, so defaults apply${tail}.`;
    }
    case 'task.get': {
      const p = payload as SurfacePayloads['task.get'];
      return p.found && p.task !== null ? `Task ${p.taskId} is ${p.task.state}${tail}.` : `No task ${p.taskId} was found${tail}.`;
    }
    case 'evidence.select': {
      const p = payload as SurfacePayloads['evidence.select'];
      return `Selected ${plural(p.items.length, 'evidence item')}${tail}.`;
    }
    case 'evidence.get': {
      const p = payload as SurfacePayloads['evidence.get'];
      return p.found ? `Evidence ${p.handle} returned${p.truncated ? ' (truncated view)' : ''}${tail}.` : `No evidence ${p.handle} was found${tail}.`;
    }
    case 'verification.record': {
      const p = payload as SurfacePayloads['verification.record'];
      return p.accepted
        ? `Receipt ${p.receiptId} was linked; its outcome is ${p.outcome ?? 'unknown'}${tail}.`
        : `Receipt ${p.receiptId} was not linked (${p.reasonCode}); no receipt was created${tail}.`;
    }
    case 'task.submit': {
      const p = payload as SurfacePayloads['task.submit'];
      return p.accepted ? `Task ${p.taskId ?? ''} was submitted with ${plural(p.leaseIds.length, 'lease')}${tail}.` : `The task was not submitted (${p.reasonCode})${p.detail === undefined ? '' : `: ${p.detail}`}${tail}.`;
    }
    case 'handoff.export': {
      const p = payload as SurfacePayloads['handoff.export'];
      return p.found ? `Exported capsule ${p.capsuleId ?? ''}${tail}.` : `No capsule was found to export${tail}.`;
    }
    case 'handoff.import': {
      const p = payload as SurfacePayloads['handoff.import'];
      return p.accepted
        ? `Imported capsule ${p.capsuleId ?? ''}${p.mode === undefined ? '' : ` (${p.mode})`} with ${plural(p.facts, 'pinned fact')}; no authority was granted${tail}.`
        : `The capsule was not imported (${p.reasonCode})${tail}.`;
    }
    case 'capability.advise': {
      const p = payload as SurfacePayloads['capability.advise'];
      return `${p.title}: ${p.summary.replace(/\.$/, '')}${tail}.`;
    }
  }
}

/** D's per-check reasons for a check that has not answered yet (21e3481), as people read them. */
const WAITING_TEXT = { RUNNING: 'still running in the background', QUEUED: 'queued behind the run under way' } as const;

function waitingOf(reasonCode: string | null | undefined): keyof typeof WAITING_TEXT | null {
  return reasonCode === 'RUNNING' || reasonCode === 'QUEUED' ? reasonCode : null;
}

/** How many checks are still running or queued, e.g. `1 still running, 2 queued`. */
function verifyWaiting(p: SurfacePayloads['verify']): string[] {
  const running = p.checks.filter((c) => waitingOf(c.reasonCode) === 'RUNNING').length;
  const queued = p.checks.filter((c) => waitingOf(c.reasonCode) === 'QUEUED').length;
  return [...(running > 0 ? [`${String(running)} still running`] : []), ...(queued > 0 ? [`${String(queued)} queued`] : [])];
}

/** Failing test names shown per check; the rest are counted as "and N more". */
const FAILED_TESTS_SHOWN = 3;

/** A failed check's failing tests and where to read more (D 837da7e), in one plain line. */
function failureLine(c: SurfacePayloads['verify']['checks'][number]): string | null {
  const f = c.failure;
  if (f === undefined) return null;
  const verb = c.outcome === 'failed' ? 'failed' : 'did not pass';
  const names = f.failedTests.slice(0, FAILED_TESTS_SHOWN).map((t) => (t.name === '' || t.name === t.id ? t.id : `${t.id}: ${t.name}`));
  const more = f.failedTestCount - names.length;
  const listed = names.length === 0 ? '' : ` (${names.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''})`;
  const count = f.failedTestCount === 0 ? 'no failing test was parsed from its output' : `${plural(f.failedTestCount, 'failing test')}${listed}`;
  const details = f.evidenceHandle === null ? '' : `; details: jevris evidence get ${f.evidenceHandle}`;
  return `${c.checkId} ${verb}: ${count}${details}`;
}

/**
 * The Jev decision budget on status (owner decision 2026-09-29): the month's spend against the
 * machine-wide limit, against this workspace's cap when it has one, and the reset date.
 */
export function jevBudgetLines(budget: SurfacePayloads['status']['budget']): string[] {
  if (budget.limitMicroUsd === null || budget.spentMicroUsd === undefined) return [];
  const period = budget.period === undefined ? 'this month' : `in ${budget.period}`;
  const resets = budget.resetsAt === undefined ? '' : `; resets ${budget.resetsAt.slice(0, 10)} (UTC)`;
  const zero = budget.limitMicroUsd === 0 ? ' (0: no Jev calls, decisions run rules-only)' : '';
  const lines = [`jev budget: ${jevBudgetText(budget.spentMicroUsd)} spent of ${jevBudgetText(budget.limitMicroUsd)} ${period}, machine-wide${zero}${resets}`];
  const ws = budget.workspace;
  if (ws !== undefined && ws !== null) {
    const from = ws.source === 'repository' ? "the repository's .jevris/config.json" : ws.source === 'unreadable' ? 'a cap record that cannot be read (0 until set again)' : 'jevris configure workspace-budget';
    lines.push(`jev budget this workspace: ${jevBudgetText(ws.spentMicroUsd)} spent of its cap ${jevBudgetText(ws.limitMicroUsd)} ${period} (set by ${from})`);
  }
  if (budget.exhaustedBy === 'machine') lines.push('jev budget spent: the machine-wide limit (BUDGET_MACHINE_LIMIT); decisions run rules-only until it resets');
  if (budget.exhaustedBy === 'workspace') lines.push("jev budget spent: this workspace's cap (BUDGET_WORKSPACE_CAP); its decisions run rules-only until it resets");
  return lines;
}

function line(label: string, value: string | number | boolean | null): string {
  return `${label}: ${value === null ? 'none' : String(value)}`;
}

/** configure's source egress: the host decision, then the jevris.config.json preference apart from it (SET-02). */
function sourceEgressText(e: SurfacePayloads['configure']['effective']): string {
  const preference = e.sourceEgressPreference ?? 'not set';
  return `${e.sourceEgress} (host policy; see jevris egress status); your jevris.config.json preference: ${preference}`;
}

/**
 * US12: the model that was asked for and the one that did the work, on separate lines. A
 * missing observation reads "unknown", never a guess, and never claims cost precision.
 */
/** The last unverified stop (VER-05): what it said, when, and what evidence it lacked. */
function stopReportLines(report: SurfacePayloads['verify']['stopReport']): string[] {
  if (report === undefined || report === null) return [];
  const lines = [`last stop (${report.at}): ${report.text}`];
  if (report.missingEvidence.length > 0) lines.push(list('last stop missing evidence', report.missingEvidence));
  if (report.uncoveredRequirements.length > 0) lines.push(list('last stop uncovered requirements', report.uncoveredRequirements));
  return lines;
}

/** The recorded decision behind an answer, when there is one, with the command that explains it. */
function decisionLine(decisionId: string | null | undefined): string[] {
  return typeof decisionId === 'string' ? [`decision: ${decisionId} (jevris explain ${decisionId})`] : [];
}

/** B's model registry status on one line: which registry routing reads, or why routing is unavailable. */
export function modelRegistryLine(m: NonNullable<SurfacePayloads['status']['modelRegistry']>): string {
  if (m.source === 'bundled') return `model registry: bundled snapshot ${m.snapshotId ?? 'unknown'}`;
  if (m.source === 'override') return `model registry: administrator override ${m.snapshotId ?? 'unknown'}`;
  return `model registry: override refused (${m.reasonCode ?? 'MODEL_REGISTRY_INVALID'}), routing unavailable; fix or remove <config>/model-registry.json`;
}

/** Owner decision 29423b6: the link a turn decision was made under, or why it got advice only. */
export function sessionLinkExplainLine(link: NonNullable<SurfacePayloads['explain']['trace']>['sessionLink']): string {
  if (link === null || link === undefined) return 'session link: none, so this turn got advice only (link it with jevris route --task <id> --link)';
  return `session link: ${link.harness} ${link.sessionId.length <= 12 ? link.sessionId : `…${link.sessionId.slice(-8)}`} -> task ${link.taskId} (${link.via}, ${new Date(link.linkedAtMs).toISOString().slice(0, 10)})`;
}

/** Owner decision 29423b6: which sessions are linked to a task (only those may be switched per turn). */
export function sessionLinksLine(links: NonNullable<SurfacePayloads['status']['sessionLinks']>): string {
  if (links.length === 0) return 'session links: none (a Kilo or OpenCode session gets advice only until linked: jevris route --task <id> --link)';
  const shown = links.map((l) => `${l.harness} ${l.sessionId.length <= 12 ? l.sessionId : `…${l.sessionId.slice(-8)}`} -> task ${l.taskId} (${l.via}, ${l.worker === true ? 'worker, ' : ''}${new Date(l.linkedAtMs).toISOString().slice(0, 10)})`);
  return `session links: ${shown.join('; ')}`;
}

/**
 * Plain text for a route abstention code whose engine text may not reach this surface (serving
 * hosts, owner decisions 8c1f85d): shown after the code wherever a route reason is rendered.
 */
const ROUTE_REASON_TEXT: Readonly<Record<string, string>> = {
  HOST_UNKNOWN: "Jevris cannot read this session's host, so it gives advice only",
  // Serving hosts R44 and R48.
  NOT_ON_SESSION_HOST: "a route keeps the session's host, and Jevris has not seen this model served there, so it gives advice only",
  HOST_TARIFF_UNKNOWN: "the serving host's tariff for this model is not known, so Jevris gives advice only",
};
export function routeReasonLabel(code: string | null): string | null {
  if (code === null) return null;
  const text = ROUTE_REASON_TEXT[code];
  return text === undefined ? code : `${code} (${text})`;
}

const MAIN_SESSION_REASON_TEXT: Readonly<Record<string, string>> = {
  MAIN_SESSION_ADVICE_ONLY: 'routing.mainSession is not plugin-bounded-auto',
  HARNESS_ADVICE_ONLY: 'this harness takes advice only',
  KILL_SWITCH: 'the kill switch is on or unknown',
  TURN_ROUTE_UNCERTIFIED: 'turn switching is not certified for this harness; run jevris certify',
  CONFIG_UNREADABLE: 'the routing.mainSession setting could not be read',
  HOST_UNKNOWN: ROUTE_REASON_TEXT['HOST_UNKNOWN'] as string,
  NOT_ON_SESSION_HOST: ROUTE_REASON_TEXT['NOT_ON_SESSION_HOST'] as string,
  HOST_TARIFF_UNKNOWN: ROUTE_REASON_TEXT['HOST_TARIFF_UNKNOWN'] as string,
};
function mainSessionReason(code: string | null): string {
  if (code === null) return '';
  const text = MAIN_SESSION_REASON_TEXT[code];
  return text === undefined ? ` (${code})` : `: ${text} (${code})`;
}

/** OD-8: per harness, the main-session mode and whether its turns can be switched at all. */
/** Serving hosts R54 (design 8): the session's serving host and whether its tariff is known; nothing when not seen. */
function sessionHostWords(v: NonNullable<SurfacePayloads['status']['mainSessions']>[number]): string {
  if (v.sessionHost === undefined || v.sessionHost === null) return '';
  const tariff = v.tariff === 'known' ? ', tariff known' : v.tariff === 'unknown' ? ', tariff unknown (routes through it are advice only)' : '';
  return `session host ${v.sessionHost.id} (${v.sessionHost.kind})${tariff}, `;
}

export function mainSessionsLines(views: NonNullable<SurfacePayloads['status']['mainSessions']>): string[] {
  if (views.length === 0) return ['main sessions: unknown'];
  return views.map((v) => `main session ${v.harness}: ${v.mode}, ${sessionHostWords(v)}${v.turnSwitching === 'possible' ? 'turns may be switched (each turn still needs a linked session, low risk and budget)' : `advice only${mainSessionReason(v.reasonCode)}`}`);
}

const JEV_DISABLED_FOR: Readonly<Record<string, string>> = { BILLING: 'billing', ACCOUNT: 'the account', AUTH: 'its API key' };

/** A.R77: Jev disabled, why, since when and the one command that clears it. */
export function jevCircuitLine(v: NonNullable<SurfacePayloads['status']['jevCircuit']>): string {
  const since = v.since === null ? '' : ` since ${v.since.slice(0, 16)}Z`;
  const fix = v.reasonClass === 'AUTH' ? `a 401 clears only with a new key: ${v.command}` : `after fixing ${JEV_DISABLED_FOR[v.reasonClass] ?? 'it'}, run ${v.command}`;
  return `jev: disabled for ${JEV_DISABLED_FOR[v.reasonClass] ?? v.reasonClass} (${v.reasonCode})${since}; Jevris decides rules-only; ${fix}`;
}

type AccessLimitsView = NonNullable<SurfacePayloads['status']['accessLimits']>;

/** `codex subscription openai (gpt-5.5)`: the same words as core's accessScopeText. */
function accessScopeWords(scope: AccessLimitsView['entries'][number]['scope']): string {
  const narrow = scope.modelId ?? scope.family;
  return `${scope.harness} ${scope.authMode} ${scope.servingHost}${narrow === null ? '' : ` (${narrow})`}`;
}

const minuteUtc = (timestamp: string): string => `${timestamp.slice(0, 16)}Z`;

/**
 * Access limits R79 (design 11): a count line and one line per pause in force, in the words of
 * `jevris route limits`; nothing when none is in force and the record is readable and not full.
 */
export function accessLimitsStatusLines(view: AccessLimitsView): string[] {
  const lines: string[] = [];
  if (view.active > 0) {
    lines.push(`access limits: ${view.active} active (see jevris route limits)`);
    for (const e of view.entries) {
      // Core's one wording (C2 d0ff6bf0): a new key is named only where the view says it clears.
      const when = e.until === null ? `since ${minuteUtc(e.since)}; ${untimedClearTextFor(e.scope, e.newKeyClears === true)}` : `until ${minuteUtc(e.until)} (${e.resetBasis})`;
      lines.push(`  ${accessScopeWords(e.scope)}: ${e.class}${e.weekly ? ' (weekly)' : ''} ${when} (${e.source})`);
    }
    if (view.active > view.entries.length) lines.push(`  … and ${view.active - view.entries.length} more`);
  }
  if (!view.readable) lines.push('access limits: the record could not be read (ACCESS_LIMITS_UNREADABLE), so it pauses nothing; jevris doctor says more');
  if (view.full) lines.push('access limits: the record is full (ACCESS_LIMITS_FULL); a new pause replaces the oldest expired or timed one');
  return lines;
}

type AccessUsageView = NonNullable<SurfacePayloads['status']['accessUsage']>;

/**
 * OP-6: the last Codex usage reading per sign-in, one line each in core's words (accessUsageLines:
 * bands, weekly flags, resets, and "usage not allowed" when the reading said so); nothing when there
 * is none and the file is readable. Never a percentage or the payload.
 */
export function accessUsageStatusLines(view: AccessUsageView): string[] {
  const lines: string[] = [];
  // The contract's Timestamp keeps these parseable; a time that still fails to parse drops the
  // reading (readAt) or reads as no reset, never a throw (B's nit).
  const ms = (t: string | null): number | null => {
    const v = t === null ? Number.NaN : Date.parse(t);
    return Number.isFinite(v) ? v : null;
  };
  const readings = view.readings.flatMap((r) => {
    const readAtMs = ms(r.readAt);
    if (readAtMs === null) return [];
    return [{ harness: r.harness, authMode: r.authMode, readAtMs, allowed: r.allowed, windows: r.windows.map((w) => ({ weekly: w.weekly, band: w.band, resetAtMs: ms(w.resetsAt) })) }];
  });
  if (readings.length > 0) lines.push('usage readings (the harness\'s own account windows):', ...accessUsageLines(readings).map((l) => `  ${l}`));
  if (!view.readable) lines.push('usage readings: the file could not be read (ACCESS_USAGE_UNREADABLE), so it pauses and lifts nothing');
  return lines;
}

const hostWords = (host: string): string => {
  const kind = servingHostOf(host)?.kind;
  return kind === undefined ? host : `${host} (${kind})`;
};

/** The route's slice classification: the slice and who chose it, the risk, the reason and the decision to explain. */
function sliceLines(s: NonNullable<SurfacePayloads['route']['slice']>): string[] {
  const who = s.source === 'jev' ? 'classified by Jev, advice only' : s.source === 'rules' ? 'classified by rules, advice only' : 'none used, the approved baseline stays';
  const how = s.asked ? `${s.cacheHit === true ? 'cache hit' : 'asked Jev'}${s.latencyMs === null ? '' : `, ${s.latencyMs} ms`}${s.confidencePercent === null ? '' : `, confidence ${s.confidencePercent} percent`}` : 'Jev not asked';
  return [
    line('task slice', `${s.sliceId ?? 'none'} (${who})`),
    line('slice risk', `${s.risk}; ${s.reasonCode} (${how})`),
    ...(s.decisionId === null ? [] : [line('slice decision', `${s.decisionId} (jevris explain ${s.decisionId})`)]),
  ];
}

const PLAN_SLICE_NOTES: { readonly [code: string]: string } = {
  SLICE_NO_FEATURES: 'the task names no write scope, check or title to go on',
  SLICE_HIGH_RISK: 'a protected path or a high risk, so the approved baseline stays',
  SLICE_JEV_LOW_CONFIDENCE: 'Jev was not sure enough',
  SLICE_JEV_UNKNOWN: 'Jev could not tell from the features',
};

/**
 * One line per task of a plan: the slice Jev or the rules suggest, or the plan's own with what the
 * classifier makes of it, and the risk. Advice for a person; it is not part of the plan.
 */
export function planSliceLines(list: readonly PlanSliceSuggestion[]): string[] {
  return list.map((s) => {
    const by = (source: string | undefined): string => (source === 'jev' ? 'Jev' : 'the rules');
    const why = s.reasonCode.startsWith('PLAN_JEV_') ? `; reason ${s.reasonCode}` : '';
    const risk = `risk ${s.risk}`;
    if (s.source === 'given') {
      const verdict =
        s.agrees === true
          ? `; ${by(s.suggestedBy)} agrees`
          : s.agrees === false
            ? `; ${by(s.suggestedBy)} suggests ${s.suggestedSlice ?? 'another slice'}, advice only`
            : '';
      return `task ${s.taskId}: slice ${s.slice ?? 'none'} (declared in the plan${verdict}${why}); ${risk}`;
    }
    if (s.slice === null) return `task ${s.taskId}: no slice suggested (${PLAN_SLICE_NOTES[s.reasonCode] ?? `reason ${s.reasonCode}`}); ${risk}`;
    return `task ${s.taskId}: slice ${s.slice} (suggested by ${by(s.source)}, advice only${why}); ${risk}`;
  });
}

/**
 * Serving hosts R55 (design 8): which host the session's model and the route's target go through,
 * whether the route kept the host, each party's consent and what the price rests on. Ids, codes
 * and dates only.
 */
export function servingLines(v: RouteServing): string[] {
  const through = (host: string, via: 'maker' | 'host'): string => (via === 'maker' ? `direct from ${host}` : `served by ${hostWords(host)}`);
  const lines = [line('model', `${v.spelling} = ${v.modelId} (${v.provider}), ${through(v.servingHost, v.via)}`)];
  if (v.targetSpelling !== null && v.targetSpelling !== v.spelling) {
    const model = v.targetModelId === null || v.targetProvider === null ? '' : ` = ${v.targetModelId} (${v.targetProvider})`;
    const targetHost = v.targetServingHost === null || v.targetVia === null ? '' : `, ${through(v.targetServingHost, v.targetVia)}`;
    lines.push(line('target', `${v.targetSpelling}${model}${targetHost}`));
  }
  const seen = v.seenHosts.length === 0 ? '' : v.seenHosts.length === 1 ? ` (the only host seen for it here: ${v.seenHosts[0] ?? ''})` : ` (seen through ${v.seenHosts.join(', ')})`;
  if (v.hostDecision === 'kept') lines.push(line('host', `kept (${v.servingHost})`));
  else if (v.hostDecision === 'changed') lines.push(line('host', `changed to ${v.targetServingHost ?? 'another host'}${seen}`));
  else if (v.hostDecision === 'not-switched') lines.push(line('host', `not switched: ${v.hostReasonCode === null ? 'no reason given' : (routeReasonLabel(v.hostReasonCode) ?? v.hostReasonCode)}${seen}`));
  // Consent and price describe the target when there is one, else the session's model.
  const host = v.targetServingHost ?? v.servingHost;
  const maker = v.targetProvider ?? v.provider;
  const state = (s: string): string => s.replace(/-/g, ' ');
  lines.push(line('consent', `${v.consent.host === null ? '' : `host ${host} ${state(v.consent.host)}; `}maker ${maker} ${state(v.consent.maker)} (jevris consent provider says why)`));
  const price =
    v.tariffBasis === 'maker-price-estimate'
      ? `estimate: ${maker}'s list price (${host} tariff unknown)`
      : v.tariffSource === null
        ? `${host === maker ? `${maker}'s list price` : `${host} tariff`}`
        : `${host} tariff (${v.tariffSource.sourceId}, ${v.tariffSource.fetchedOn})`;
  lines.push(line('host price', price));
  return lines;
}

/** OD-8: for a main-session turn decision, the mode it ran under and whether the model was switched. */
export function mainSessionExplainLine(view: NonNullable<NonNullable<SurfacePayloads['explain']['trace']>['mainSession']>): string {
  return `main session: ${view.harness} ${view.mode}, ${view.switched ? 'the turn\'s model was switched' : `advice only${mainSessionReason(view.reasonCode)}`}`;
}

function workerModelLines(models: NonNullable<SurfacePayloads['explain']['trace']>['models']): string[] {
  if (models === undefined) return ['requested model: unknown', 'observed model: unknown (not reported)'];
  const observed = models.observed === null ? 'unknown (nothing reported it)' : `${models.observed} (reported by the ${models.source})`;
  const substituted = models.substituted === null ? 'unknown' : models.substituted ? `yes: ${models.requested ?? 'unknown'} was requested, ${models.observed ?? 'unknown'} did the work` : 'no';
  return [line('requested model', models.requested ?? 'unknown'), line('observed model', observed), line('substituted', substituted), line('cost precision', models.costPrecision)];
}

/**
 * Cost wording follows the auth mode (owner decisions, DOMAINS 177c6fe and 8703ab6): an API key
 * is a real per-token charge at API list price; a subscription has no per-token charge, so a
 * dollar figure is an API-equivalent estimate and use counts against the plan's usage limits;
 * an unknown mode says so and names the figure as priced at API list price.
 */
type AuthModeLabel = 'api-key' | 'subscription' | 'unknown';
function dollarLabel(mode: AuthModeLabel | undefined): string {
  if (mode === 'api-key') return 'cost (API list price)';
  if (mode === 'subscription') return 'API-equivalent estimate; a subscription has no per-token charge, and this use counts against your plan\'s usage limits';
  return 'at API list price; the billing basis is unknown (API key or subscription not detected)';
}
function costBasisText(basis: string, mode: AuthModeLabel | undefined): string {
  if (basis === 'subscription-quota') return dollarLabel('subscription');
  if (basis === 'api-list-price') return dollarLabel(mode);
  // Serving hosts R48: through a host whose own tariff is not known.
  if (basis === 'maker-price-estimate') return "estimate: the maker's list price; the serving host's tariff is not known";
  return basis;
}
function list(label: string, values: readonly string[]): string {
  return `${label}: ${values.length === 0 ? 'none' : values.join(', ')}`;
}

function sidecarLine(result: SurfaceResult): string[] {
  const s = result.sidecar;
  const lines = [line('sidecar', s.state)];
  if (s.reasonCode !== null && s.state !== 'running') lines.push(line('sidecar reason', s.reasonCode));
  if (s.message !== null) lines.push(line('what to do', s.message));
  return lines;
}

function body(result: SurfaceResult): string[] {
  const r = result.result as unknown;
  switch (result.command) {
    case 'status': {
      const p = r as SurfacePayloads['status'];
      const lines = [
        line('mode', p.jevrisMode),
        ...(p.modeSource === undefined ? [] : [line('mode set by', MODE_SOURCE_TEXT[p.modeSource])]),
        ...(p.settingsIssues ?? []).map((issue) => `settings issue: ${issue.path} ${issue.code}`),
        ...(p.modeNotice === undefined ? [] : [`notice: ${p.modeNotice}`]),
        line('kill switch', p.killSwitch),
        line('decision health', p.decisionHealth),
        line('model pin', p.routing.modelPin),
        line('routing pinned', p.routing.pinned ? 'yes' : 'no'),
        list('active workers', p.activeWorkers),
        line('budget', p.budget.state),
        ...(p.testWorkerPort === undefined || p.testWorkerPort === null ? [] : [p.testWorkerPort]),
      ];
      if (p.budget.reservedMicroUsd !== null) lines.push(line('reserved micro-USD', p.budget.reservedMicroUsd));
      lines.push(...jevBudgetLines(p.budget));
      lines.push(line('store', p.store.state));
      if (p.store.diagnostic !== null) lines.push(line('store diagnostic', p.store.diagnostic));
      if (p.degradedReason !== null) lines.push(line('degraded', p.degradedReason));
      lines.push(...latencyLines(p.latency));
      if (p.reminders !== undefined && p.reminders !== null) {
        lines.push(reminderLine(p.reminders));
      }
      if (p.queue !== undefined && p.queue !== null) {
        const q = p.queue;
        lines.push(`queues: ${q.hotInFlight} hook request(s), ${q.backgroundInFlight} background${q.overrun > 0 ? ` (${q.overrun} past their deadline, still running)` : ''}; background work: ${q.running} running, ${q.held} held, ${q.queued} waiting (${q.spooled} spooled)`);
      }
      if (p.modelRegistry !== undefined && p.modelRegistry !== null) lines.push(modelRegistryLine(p.modelRegistry));
      if (p.sessionLinks !== undefined && p.sessionLinks !== null) lines.push(sessionLinksLine(p.sessionLinks));
      if (p.mainSessions !== undefined && p.mainSessions !== null) lines.push(...mainSessionsLines(p.mainSessions));
      if (p.backgroundVerifyAtStop !== undefined) lines.push(line('background verify at stop', backgroundVerifyAtStopText(p.backgroundVerifyAtStop, p.jevrisMode, 'a main-session Stop queues the missing approved checks')));
      if (p.firstTryRouting !== undefined) lines.push(line('first-try routing', p.firstTryRouting === 'auto' ? 'auto (a low-risk owned task starts on a cheaper model and is handed once to a stronger one if its check fails; estimates only)' : 'baseline (the baseline model runs first)'));
      if (p.firstTry !== undefined) lines.push(firstTryStatusLine(p.firstTry));
      if (p.jevAssist !== undefined) lines.push(line('jev assist', p.jevAssist === 'classify' ? 'classify (Jev classifies a route request\'s task slice and ranks which approved checks matter first, from structured features; advice only, rules are the fallback)' : 'off (every such decision is rules-only)'));
      if (p.accessLimits !== undefined && p.accessLimits !== null) lines.push(...accessLimitsStatusLines(p.accessLimits));
      if (p.jevCircuit !== undefined && p.jevCircuit !== null) lines.push(jevCircuitLine(p.jevCircuit));
      if (p.accessUsage !== undefined && p.accessUsage !== null) lines.push(...accessUsageStatusLines(p.accessUsage));
      lines.push(...stopReportLines(p.stopReport));
      lines.push(list('unknown slices', p.unknownSlices));
      if (p.recentDecisions.length === 0) lines.push('recent decisions: none');
      for (const d of p.recentDecisions) lines.push(`decision ${d.decisionId}: ${d.outcome} ${d.reasonCode} model ${d.resolvedModel ?? 'none'}`);
      return lines;
    }
    case 'explain': {
      const p = r as SurfacePayloads['explain'];
      if (p.trace === null) return ['Run jevris status to list recent decision ids.'];
      return [
        line('outcome', p.trace.outcome),
        list('reasons', p.trace.reasonCodes.map((code) => routeReasonLabel(code) ?? code)),
        line('resolved model', p.trace.resolvedModel),
        ...workerModelLines(p.trace.models),
        ...(p.trace.sessionLink === undefined ? [] : [sessionLinkExplainLine(p.trace.sessionLink)]),
        ...(p.trace.mainSession === undefined || p.trace.mainSession === null ? [] : [mainSessionExplainLine(p.trace.mainSession)]),
        ...(p.trace.serving === undefined || p.trace.serving === null ? [] : servingLines(p.trace.serving)),
        ...(p.trace.learning === undefined ? [] : [line('route learning', `${p.trace.learning.sliceId}: ${LEARNING_MODE[p.trace.learning.mode]}, policy v${String(p.trace.learning.version)}`), ...p.trace.learning.lines]),
        ...(p.trace.firstTry === undefined ? [] : firstTrySliceLines(p.trace.firstTry)),
        line('usage', p.trace.usage.known ? `${p.trace.usage.inputTokens} input, ${p.trace.usage.outputTokens} output tokens` : 'unknown'),
        line('uncertainty', p.trace.uncertainty),
        line('applied', p.trace.applied ? 'yes' : 'no'),
        '',
        p.trace.rendered,
      ];
    }
    case 'route': {
      const p = r as SurfacePayloads['route'];
      return [
        line('main session', p.main.outcome),
        line('current model', p.main.currentModel),
        line('model pin', p.main.modelPin),
        line('recommended model', p.main.recommendedModel),
        line('reason', routeReasonLabel(p.main.reasonCode)),
        line('cost basis', costBasisText(p.main.costBasis, p.main.authMode)),
        ...(p.slice === undefined ? [] : sliceLines(p.slice)),
        ...(p.needs === undefined ? [] : p.needs.map((n) => line('to get advice, pass', n))),
        ...(p.main.serving === undefined || p.main.serving === null ? [] : servingLines(p.main.serving)),
        ...(p.main.consentedProviders === undefined ? [] : [line('providers considered', `${p.main.consentedProviders.length === 0 ? 'none' : p.main.consentedProviders.join(', ')} (others need consent: jevris consent provider)`)]),
        p.main.text,
        line('managed workers', p.worker.outcome),
        p.worker.text,
        'applied: no',
      ];
    }
    case 'plan': {
      const p = r as SurfacePayloads['plan'];
      const lines = [line('valid', p.valid ? 'yes' : 'no'), line('tasks', p.taskCount)];
      p.waves.forEach((wave, index) => lines.push(list(`wave ${index + 1}`, wave)));
      lines.push(list('critical path', p.criticalPath), list('ready', p.ready));
      for (const issue of p.issues) lines.push(`issue: ${issue.taskId} ${issue.code}`);
      for (const advice of p.advice) lines.push(`advice: ${advice}`);
      if (p.sliceSuggestions !== undefined) lines.push(...planSliceLines(p.sliceSuggestions));
      return lines;
    }
    case 'checkpoint': {
      const p = r as SurfacePayloads['checkpoint'];
      const lines = [
        line('capsule', p.handle),
        line('constraints', p.retained.constraints),
        line('changed files', p.retained.changedFiles),
        line('open checks', p.retained.openChecks),
        line('compaction triggered', 'no'),
      ];
      if (p.compaction !== undefined) {
        const say = p.compaction.boundary === 'recommend-boundary' ? 'a good boundary to compact' : p.compaction.boundary === 'prepare' ? 'getting full; compact at the next clean boundary' : 'no need to compact yet';
        lines.push(line('context in use', `${String(p.compaction.usedPercent)} percent: ${say} (advice from ${p.compaction.source === 'jev' ? 'Jev' : 'the rules'}; native compaction is never deferred or started)`));
      }
      for (const item of p.items.slice(0, 40)) lines.push(`${item.kind}: ${item.text}`);
      if (p.items.length > 40) lines.push(`and ${p.items.length - 40} more items`);
      return [...lines, ...decisionLine(p.decisionId)];
    }
    case 'recover': {
      const p = r as SurfacePayloads['recover'];
      return [
        line('classification', p.classification),
        line('action', p.action),
        p.advice,
        line('failures', p.signals.failures),
        line('distinct failures', p.signals.distinctFingerprints),
        line('most repeats', p.signals.maxRepeat),
        line('environment failures', p.signals.environmentFailures),
        ...p.rejectedApproaches.map((a) => `rejected approach: ${a}`),
        ...decisionLine(p.decisionId),
      ];
    }
    case 'verify': {
      const p = r as SurfacePayloads['verify'];
      const lines = [line('readiness', p.readiness), line('checks ran', p.ran ? 'yes' : 'no')];
      if (p.checkOrder !== undefined) lines.push(list('check order', p.checkOrder.ids), p.checkOrder.text, ...decisionLine(p.checkOrder.decisionId));
      for (const c of p.checks) {
        const why = c.reasonCode === undefined || c.reasonCode === null ? '' : ` reason ${c.reasonCode}`;
        const where = c.environment === undefined || c.environment === null ? '' : ` needs ${c.environment}`;
        lines.push(`check ${c.checkId}: ${c.outcome}${c.mandatory ? ' mandatory' : ''}${c.fresh ? '' : ' not-current'} receipt ${c.receiptId ?? 'none'}${why}${where}`);
        const waiting = waitingOf(c.reasonCode);
        if (waiting !== null) lines.push(`${c.checkId}: ${WAITING_TEXT[waiting]}`);
        const failed = failureLine(c);
        if (failed !== null) lines.push(failed);
      }
      if (verifyWaiting(p).length > 0) lines.push('Run jevris verify again later to read the result.');
      lines.push(list('missing', p.missing));
      if (p.needsEnvironment !== undefined) lines.push(list('needs another environment', p.needsEnvironment));
      lines.push(...stopReportLines(p.stopReport));
      return lines;
    }
    case 'configure': {
      const p = r as SurfacePayloads['configure'];
      const lines = [
        line('source', p.source),
        line('file', p.path),
        line('valid', p.valid ? 'yes' : 'no'),
        line('mode', p.effective.mode),
        ...(p.effective.modeSource === undefined ? [] : [line('mode set by', MODE_SOURCE_TEXT[p.effective.modeSource])]),
        line('source egress', sourceEgressText(p.effective)),
        line('remote telemetry', p.effective.remoteTelemetry),
        line('main session routing', p.effective.mainSession),
        line('managed workers', p.effective.managedWorkers),
        line('orchestration', p.effective.orchestrationEnabled ? 'enabled' : 'disabled'),
        ...(p.effective.monthlyBudgetMicroUsd === undefined
          ? []
          : [line('jev monthly budget', `${p.effective.monthlyBudgetMicroUsd} micro-USD (${jevBudgetText(p.effective.monthlyBudgetMicroUsd)}), machine-wide${p.effective.monthlyBudgetMicroUsd === 0 ? '; 0 means no Jev calls, decisions run rules-only' : ''}`)]),
        ...(p.effective.backgroundVerifyAtStop === undefined ? [] : [line('background verify at stop', backgroundVerifyAtStopText(p.effective.backgroundVerifyAtStop, p.effective.mode, 'a main-session Stop queues the missing approved checks in the background'))]),
        ...(p.effective.firstTryRouting === undefined ? [] : [line('first-try routing', p.effective.firstTryRouting === 'auto' ? 'auto (a low-risk owned task starts on a cheaper model, then one hand-off to a stronger one)' : 'baseline')]),
        ...(p.effective.jevAssist === undefined ? [] : [line('jev assist', p.effective.jevAssist === 'classify' ? 'classify (Jev classifies a route request\'s task slice from structured features; advice only)' : 'off (rules-only)')]),
        'native permissions changed: no',
      ];
      for (const issue of p.issues) lines.push(`issue: ${issue.path || '/'} ${issue.code}`);
      for (const c of p.changed) lines.push(`changed: ${c.key} ${c.from} -> ${c.to}`);
      if (p.dryRun === true) lines.push('dry run: nothing was written');
      return lines;
    }
    case 'task.get': {
      const p = r as SurfacePayloads['task.get'];
      if (!p.found || p.task === null) return [];
      const lines = [line('state', p.task.state)];
      if (p.task.stateReason !== undefined) lines.push(line('reason', p.task.stateReason));
      // A cancel was delivered and the run has not published its end yet: the task stops shortly.
      if (p.cancelRequested === true) lines.push(line('cancel', 'requested; the run is stopping'));
      for (const receipt of p.receipts.slice(0, 40)) lines.push(`check ${receipt.checkId}: ${receipt.outcome}${receipt.fresh ? '' : ' not-current'} receipt ${receipt.receiptId}`);
      const w = p.worker ?? null;
      if (w === null) lines.push('worker: none ran');
      else {
        const observed = w.actualModel ?? 'unknown (nothing reported it)';
        const cost = w.costMicroUsd === null || w.costBasis === 'unknown' ? 'unknown' : `$${(w.costMicroUsd / 1_000_000).toFixed(4)}, reported by the worker (${dollarLabel(w.authMode)})`;
        lines.push(line('worker run', w.status), line('requested model', w.requestedModel ?? 'unknown'), line('observed model', observed), line('cost', cost), line('duration ms', w.durationMs));
      }
      // Jev's advice at the launch (advice only: the launch never depended on it); `jevris explain` shows what was asked.
      if (p.readiness !== undefined) lines.push(line('launch advice', `${p.readiness.state === 'none' ? 'nothing stated' : p.readiness.state === 'ready' ? 'looked bounded for a worker' : p.readiness.state === 'not-ready' ? 'did not look bounded for a worker' : 'not sure'}; jevris explain ${p.readiness.decisionId}`));
      // A run that ended after a newer lease owned the task is history; it changed nothing.
      if ((p.lateResults ?? 0) > 0) lines.push(line('late results kept', p.lateResults ?? 0));
      return lines;
    }
    case 'evidence.get': {
      const p = r as SurfacePayloads['evidence.get'];
      if (!p.found) return [];
      const lines = [line('media type', p.mediaType), line('bytes', p.byteLength), line('hash', /^ev:[0-9a-f]{64}$/.test(p.handle) ? `sha256:${p.handle.slice(3)}` : null)];
      const o = p.output ?? null;
      if (o !== null) {
        lines.push(line('exit code', o.exitCode), line('error state', o.errorState), line('stderr starts at byte', o.stderrOffset), line('view', o.passthroughReason === null ? o.mode : `${o.mode} (${o.passthroughReason})`));
        for (const span of o.keptSpans.slice(0, 40)) lines.push(`kept bytes ${span.startByte}-${span.endByte} (lines ${span.startLine}-${span.endLine})`);
        if (o.keptSpans.length > 40) lines.push(`and ${o.keptSpans.length - 40} more kept spans`);
        lines.push(line('omitted lines', o.omittedLines));
      }
      if (p.text !== null) lines.push('--- original ---', p.text);
      return lines;
    }
    case 'handoff.import': {
      const p = r as SurfacePayloads['handoff.import'];
      const lines = [line('mode', p.mode ?? null), line('pinned facts', p.facts), 'authority granted: no'];
      if (p.missingCapabilities !== undefined) lines.push(list('missing capabilities', p.missingCapabilities));
      for (const u of p.unresolved) lines.push(`unresolved: ${u}`);
      return lines;
    }
    case 'capability.advise': {
      const p = r as SurfacePayloads['capability.advise'];
      const lines = [
        line('capability', `${p.capabilityId} (${p.primitive})`),
        line('advice', p.verb),
        line('recommendation', p.recommendation),
        line('reason', p.reasonCode),
        line('source', p.source === 'jev' ? 'Jev' : 'rules'),
      ];
      for (const item of p.ranked.slice(0, 32)) lines.push(`- ${item.label}${item.score === null ? '' : ` (${item.score})`}: ${item.reason}`);
      if (p.ranked.length > 32) lines.push(`and ${p.ranked.length - 32} more`);
      if (p.question !== null) lines.push(line('question', p.question));
      if (p.kept.length > 0) lines.push(list('kept', p.kept));
      if (p.validation.length > 0) lines.push(list('validate with', p.validation));
      lines.push(line('needs your approval to act on', p.requiresApproval ? 'yes' : 'no'));
      for (const note of p.notes) lines.push(`note: ${note}`);
      lines.push('applied: no (advice only; nothing was created, merged, installed or run)');
      if (p.decisionId !== null) lines.push(`decision: ${p.decisionId} (jevris explain ${p.decisionId})`);
      return lines;
    }
    default:
      return [JSON.stringify(result.result, null, 2)];
  }
}

export function renderHuman(result: SurfaceResult): string {
  const lines = [result.summary, ...body(result), ...sidecarLine(result)];
  if (result.workspace.root !== null) lines.push(line('workspace', result.workspace.root));
  return `${lines.join('\n')}\n`;
}
