/**
 * The main-session model line (owner decisions 2026-10-08, tiered routing, step 3; every harness, provider-neutral).
 *
 * A hook cannot change a main session's model (Claude Code and Codex), and on Kilo, OpenCode and Antigravity only part of
 * the session can be steered. So the main session gets honest, short ADVICE, once, addressed to the model (a context) where
 * the harness has one and to the person otherwise: "this looks hard (PROTECTED_AUTH): consider Opus 5.5 (/model opus)", or
 * "Sonnet 5.5 has failed this 3 times (not environmental): consider Opus 5.5", or, when the session runs a dearer model than
 * its harness's own baseline on clearly routine work, "this looks routine: Sonnet 5.5 would be enough". Silence means the
 * session is on the right tier.
 *
 * Rules only, no Jev call on the prompt path (the hook never waits): the tier comes from
 *  - the linked task's content-free signals the sidecar adds to a prompt or a failure event (`tierSignals`: counts, the risk
 *    class, protected-class codes, plan depth; never a path or a title), judged by the shared `rulesTier`;
 *  - the repeated failure of the session (the filter's attempt count, the repair bound, the environmental flag), the same
 *    non-asking signals the repeated-failure adviser uses; and
 *  - the session's tier memo (`jevris route` with a task, ten minutes), whose step up counts as the rules' and whose model
 *    (it may be Jev's earlier pick) names the target when it is a rung of the session's own ladder.
 * The target comes from the session's own ladder (`buildTierLadder` over the models eligible here, the baseline's own provider).
 *
 * Gates, every one a silence with a reason code:
 *  - shown in `advise` and `bounded-auto`; in `observe` the decision is recorded and nothing is shown or queued; `off` does nothing;
 *  - none under the kill switch, with a model pin (a pin holds), with no session id, or with no ladder (the session's model is
 *    unknown or no rung exists in this direction: the session is on the right tier, or nothing is known to point at);
 *  - on Kilo and OpenCode, none where the turn itself is switched under `plugin-bounded-auto` (the line would only repeat it);
 *  - at most one line per session and direction in 30 minutes, counted from when it was handed to the harness, and none while
 *    one waits;
 *  - delivered advice is opened for adherence (the existing machinery: `main-route`, the slice `tier-up` or `tier-down`); after
 *    two times it was not followed (`adviceIgnored`) the line stops for the session.
 * The line is advice: it says nothing was changed, never claims Jevris switched anything, and carries no prompt, no title, no
 * path and no failure text, only model names, a fixed phrase and codes. At most 500 characters.
 */
import { UNKNOWN_SESSION_ID, MODEL_TIER_SPEC_ID, CLAUDE_CODE_SUBAGENT_ALIASES, SLICE_VERBS, aliasMeansModel, aliasNeedsClaudeCode, aliasNewestOfFamily, aliasVersionOldText, buildTierLadder, claudeCodeVersionOf, harnessHasDefault, loadModelRegistry, readPins, readSessionTier, registryModel, routeBaseline, rulesTier, tierSignalsOf, type SessionTierMemo, type SliceRisk, type SliceVerb, type TierLadder, type TierSignals } from '@jevris/core';
import { modeAllows, type ModelRegistry } from '@jevris/contracts';
import type { HookProposal, TriggerHandler, TriggerHandlerInput } from './sidecar-subscribers.js';
import { adviceIgnored, openAdvice } from './advice-adherence.js';
import { parseFailureFeatures } from './failure-advice.js';
import { bodyOf, modeOf, plain, repairBound, showsHere } from './live-handlers.js';
import { PENDING_ADVICE, type PendingAdviceStore } from './pending-advice.js';
import { aliasCertifiedFor, sessionConsent, sessionEligible } from './session-tier.js';

export type TierLineDirection = 'up' | 'down';

/** One line per session and direction in this long (owner design 2026-10-08), counted from delivery. */
export const TIER_LINE_QUIET_MS = 30 * 60_000;
/** The adherence slice of each direction: one per direction, so a step-up line never counts a step-down one. */
export const tierLineSlice = (direction: TierLineDirection): string => `tier-${direction}`;
const MAX_LINE = 500;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The short note a line carries for the model beyond what the person reads. */
export const TIER_LINE_MODEL_NOTE = ' If you are the model, tell the user this once and do not repeat it.';

// ------------------------------------------------------------------------------------------------------------- the line

export interface TierLineInput {
  readonly direction: TierLineDirection;
  readonly harness: string;
  /** The `TIER_*` rules reasons that decided. */
  readonly reasons: readonly string[];
  /** The protected class codes (`PROTECTED_AUTH`), when a protected path decided. */
  readonly protectedClasses: readonly string[];
  /** The repeated failure's attempt count, when the failure decided. */
  readonly attempts: number | null;
  readonly baselineName: string;
  readonly targetName: string;
  /** What to type to switch (`/model opus`), or null when the harness's way is not documented here. */
  readonly switchCommand: string | null;
  /** The family alias a Claude Code subagent call takes (`opus`), or null. */
  readonly subagentAlias: string | null;
  /** Claude Code only: why no alias is named when the installed version maps it to an older model (plain words), or null/absent. */
  readonly subagentAliasNote?: string | null;
}

const UP_WHY: Readonly<Record<string, string>> = {
  TIER_MIGRATION: 'a migration',
  TIER_WIDE_CHANGE: 'a wide change over 8 files',
  TIER_BASELINE_FAILED: 'a run on the current model already failed',
  TIER_DEEP_PLAN: 'a deep plan',
  TIER_HANDOFF_BLOCKED: 'a blocked hand-off',
};
const DOWN_WHY: Readonly<Record<string, string>> = { TIER_READ_ONLY_WORK: 'read-only work', TIER_LOW_RISK_BOUNDED: 'low risk, few files' };

/**
 * The line for the person and the line for the model: fixed templates over model names, a command and codes. Nothing of the
 * prompt, a title, a path or a failure's text can appear in it.
 */
export function modelTierLine(i: TierLineInput): { readonly person: string; readonly model: string } {
  const how = i.switchCommand === null ? '' : ` (${i.switchCommand})`;
  const sub = i.subagentAlias === null ? '' : `, or give the hard part to a subagent with model: ${i.subagentAlias}`;
  const aliasNote = i.subagentAlias === null && i.subagentAliasNote != null ? ` ${i.subagentAliasNote}` : '';
  const tail = `${aliasNote} Advice only; nothing was changed.`;
  let body: string;
  if (i.direction === 'down') {
    const why = i.reasons.map((r) => DOWN_WHY[r]).find((w) => w !== undefined);
    body = `this looks routine${why === undefined ? '' : ` (${why})`}: ${i.targetName} would be enough${how}.`;
  } else if (i.attempts !== null && i.reasons.includes('TIER_REPEATED_FAILURE')) {
    body = `${i.baselineName} has failed this ${String(Math.max(2, Math.min(9999, Math.floor(i.attempts))))} times (not environmental): consider switching to ${i.targetName}${how}${sub}.`;
  } else {
    const protectedClass = i.reasons.includes('TIER_PROTECTED_PATH') ? (i.protectedClasses.find((c) => c !== 'PROTECTED_LOCKFILE') ?? 'a protected path') : null;
    const why = protectedClass ?? i.reasons.map((r) => UP_WHY[r]).find((w) => w !== undefined) ?? 'the tier rules say so';
    body = `this looks hard (${why}): consider switching to ${i.targetName}${how}${sub}.`;
  }
  const person = `Jevris: ${body}${tail}`.slice(0, MAX_LINE);
  const model = `${person}${TIER_LINE_MODEL_NOTE}`.slice(0, MAX_LINE);
  // A line cut at the cap would lose its tail; the templates are short enough that this holds.
  return { person, model };
}

/**
 * What to type to switch the session's model on this harness, from what this repository's own harness docs say, or null.
 * Claude Code: `/model <alias>` when the family alias means this model today, else `/model <id>`. Codex: `/model` (its picker).
 * Kilo, OpenCode and Antigravity: no command is documented here, so none is named (the model name alone).
 */
export function switchCommandFor(harness: string, registry: ModelRegistry, modelId: string, nowMs: number, claudeCodeVersion: string | null = null): string | null {
  if (harness === 'codex') return '/model';
  if (harness !== 'claude') return null;
  const alias = claudeAlias(registry, modelId, nowMs, claudeCodeVersion);
  return `/model ${alias ?? modelId}`;
}

/**
 * The plain note for a tier line when the target's family alias is gated by a Claude Code version the installed one does not
 * meet: what the alias would map to and what to do. Null when the alias is not gated, is fine, or the model has no alias.
 */
function subagentAliasNoteFor(registry: ModelRegistry, modelId: string, nowMs: number, claudeCodeVersion: string | null): string | null {
  const model = registryModel(registry, modelId);
  if (model === null || model.provider !== 'anthropic' || !(CLAUDE_CODE_SUBAGENT_ALIASES as readonly string[]).includes(model.family)) return null;
  // An unknown or unparseable version is not a reason to say "update": the line stays silent about it (JEV-0077).
  if (claudeCodeVersionOf(claudeCodeVersion) === null) return null;
  const since = aliasNeedsClaudeCode(model, claudeCodeVersion);
  if (since === null || !aliasNewestOfFamily(registry, model, nowMs)) return null;
  return aliasVersionOldText(model.family, claudeCodeVersion, since);
}

/**
 * The family alias Claude Code's own `model` argument and `/model` take for a model, only when it means that model today on the
 * installed Claude Code (amended 2026-10-08: a family alias means a newer model only from a version, `CLAUDE_CODE_ALIAS_SINCE`;
 * an unknown version is not enough for such a model, so the command names the model id instead).
 */
export function claudeAlias(registry: ModelRegistry, modelId: string, nowMs: number, claudeCodeVersion: string | null = null): string | null {
  const model = registryModel(registry, modelId);
  if (model === null || model.provider !== 'anthropic' || !(CLAUDE_CODE_SUBAGENT_ALIASES as readonly string[]).includes(model.family)) return null;
  return aliasMeansModel(registry, model, nowMs, claudeCodeVersion) ? model.family : null;
}

// ------------------------------------------------------------------------------------------------------------- signals

const nonNegative = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null);
const codes = (v: unknown, max: number): string[] | null => (Array.isArray(v) && v.length <= max && v.every((c) => typeof c === 'string' && REASON.test(c)) ? (v as string[]) : null);

/**
 * The linked task's tier signals as the sidecar put them in the event body, checked field by field; null when the body has none
 * or any field is not exactly what `tierSignalsOf` produces. A hook cannot supply them (the sidecar replaces the field).
 */
export function readTierSignals(value: unknown): TierSignals | null {
  if (!plain(value)) return null;
  const risk = value['risk'];
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high' && risk !== 'unknown') return null;
  const riskReasons = codes(value['riskReasons'], 16);
  const protectedClasses = codes(value['protectedClasses'], 16);
  const files = nonNegative(value['files']);
  const checks = nonNegative(value['checks']);
  const sliceId = value['sliceId'];
  const verb = value['verb'];
  const planDepth = value['planDepth'];
  const failedAttempts = value['failedAttempts'];
  const maxRepairAttempts = value['maxRepairAttempts'];
  if (riskReasons === null || protectedClasses === null || files === null || checks === null) return null;
  if (sliceId !== null && !(typeof sliceId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(sliceId))) return null;
  if (verb !== null && !(typeof verb === 'string' && (SLICE_VERBS as readonly string[]).includes(verb))) return null;
  if (planDepth !== null && nonNegative(planDepth) === null) return null;
  if (failedAttempts !== null && nonNegative(failedAttempts) === null) return null;
  if (maxRepairAttempts !== null && nonNegative(maxRepairAttempts) === null) return null;
  if (typeof value['readOnlyWork'] !== 'boolean' || typeof value['failureEnvironmental'] !== 'boolean' || typeof value['baselineRunFailed'] !== 'boolean' || typeof value['handOffBlocked'] !== 'boolean') return null;
  return {
    sliceId: sliceId as string | null,
    risk: risk as SliceRisk,
    riskReasons,
    files,
    checks,
    protectedClasses,
    verb: verb as SliceVerb | null,
    readOnlyWork: value['readOnlyWork'],
    planDepth: planDepth as number | null,
    failedAttempts: failedAttempts as number | null,
    maxRepairAttempts: maxRepairAttempts as number | null,
    failureEnvironmental: value['failureEnvironmental'],
    baselineRunFailed: value['baselineRunFailed'],
    handOffBlocked: value['handOffBlocked'],
  };
}

// ------------------------------------------------------------------------------------------------------------ the handler

/** Per-handler memory of when a line was last handed over (or recorded in observe), by workspace, session and direction. */
export type TierLineQuiet = Map<string, number>;

export interface ModelTierHandlerOptions {
  readonly store?: PendingAdviceStore;
  readonly quiet?: TierLineQuiet;
  readonly now?: () => number;
  /** The longest an answered hook waits for the advisory record, in ms (default 250; still cut to the time left). */
  readonly recordWaitMaxMs?: number;
}

const QUIET_MAX = 1024;
const RECORD_WAIT_MAX_MS = 250;
const RECORD_MARGIN_MS = 150;
const DEFAULT_QUIET: TierLineQuiet = new Map();

/** Test seam: forgets when the default handler last showed a line. */
export function clearModelTierQuiet(): void {
  DEFAULT_QUIET.clear();
}

const quietKey = (workspaceId: string, sessionId: string, direction: TierLineDirection): string => `${workspaceId}\u0000${sessionId}\u0000${direction}`;

function modelLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

interface Judged {
  readonly direction: TierLineDirection;
  readonly reasons: readonly string[];
  readonly signals: TierSignals | null;
  readonly memo: SessionTierMemo | null;
  readonly source: 'failure' | 'task' | 'memo';
}

/** The direction the rules (or the session's memo) point in, from content-free signals only; null when none. */
function judge(input: TriggerHandlerInput, body: Record<string, unknown>, memo: SessionTierMemo | null): Judged | null {
  const task = readTierSignals(body['tierSignals']);
  let signals = task;
  let source: Judged['source'] = 'task';
  if (input.trigger === 'repeated-failure') {
    // The non-asking branch of the repeated-failure handler: its features and counts, never its text.
    const features = parseFailureFeatures(body['failure']);
    if (features === null || input.failure === undefined) return null;
    const base = task ?? tierSignalsOf({});
    signals = { ...base, failedAttempts: Math.max(0, Math.min(10_000, Math.floor(input.failure.attempts))), maxRepairAttempts: repairBound(body), failureEnvironmental: features.environmental };
    source = 'failure';
  }
  const rules = signals === null ? null : rulesTier(signals);
  if (rules !== null && rules.tier === 'step-up') return { direction: 'up', reasons: rules.reasons, signals, memo, source };
  if (memo !== null && memo.tier === 'step-up') return { direction: 'up', reasons: memo.reasonCodes.filter((c) => REASON.test(c)), signals, memo, source: 'memo' };
  // Routine work is only ever said at a prompt, and only from the rules' own read-only or low-risk-bounded signal.
  if (input.trigger === 'new-task' && rules !== null && rules.tier === 'step-down') return { direction: 'down', reasons: rules.reasons, signals, memo, source };
  return null;
}

/** The step-up rung for the session, from the memo's model when it is a rung above the baseline, else the nearest one. */
function upTarget(ladder: TierLadder, memo: SessionTierMemo | null): string | null {
  const above = ladder.candidates.slice(ladder.baselineIndex + 1).map((c) => c.modelId);
  if (memo !== null && memo.tier === 'step-up' && memo.baselineModelId === ladder.baselineModelId && above.includes(memo.targetModelId)) return memo.targetModelId;
  return above[0] ?? null;
}

/**
 * The step-down target: the harness's own baseline model, and only when the session runs a dearer model of the same provider
 * (so the line says "the usual model would be enough"). A harness with no default of its own (Kilo, OpenCode) has none.
 */
function downTarget(registry: ModelRegistry, harness: string, ladder: TierLadder): string | null {
  if (!harnessHasDefault(registry, harness)) return null;
  const usual = routeBaseline(registry, harness, null);
  return ladder.candidates.slice(0, ladder.baselineIndex).some((c) => c.modelId === usual) ? usual : null;
}

function evidenceIdsOf(signals: TierSignals | null, baseline: string, target: string, ladder: TierLadder): string[] {
  const ids = [
    ...(signals !== null && signals.files > 0 ? ['feature-files'] : []),
    ...(signals !== null && signals.checks > 0 ? ['feature-checks'] : []),
    ...(signals !== null && signals.protectedClasses.length > 0 ? ['feature-protected'] : []),
    ...(signals !== null && signals.verb !== null ? ['feature-verb'] : []),
    `baseline-${baseline}`,
    `target-${target}`,
    ...ladder.candidates.map((c) => `candidate-${c.modelId}`),
  ];
  return ids.filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)).slice(0, 64);
}

const upper = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * The main-session model line as a trigger handler, on `new-task` (a prompt: Claude Code's UserPromptSubmit, Codex's, Kilo's and
 * OpenCode's chat.message, Antigravity's task event) and `repeated-failure`. Never asks Jev and never waits for anything but the
 * advisory record, briefly. See the header for every gate.
 */
export function createModelTierHandler(options: ModelTierHandlerOptions = {}): TriggerHandler {
  const store = options.store ?? PENDING_ADVICE;
  const quiet = options.quiet ?? DEFAULT_QUIET;
  const clock = options.now ?? (() => Date.now());
  const recordWaitMaxMs = options.recordWaitMaxMs ?? RECORD_WAIT_MAX_MS;
  return async (input: TriggerHandlerInput): Promise<HookProposal | null> => {
    const silent = (reasonCode: string): null => {
      input.ctx.trace({ event: 'model-tier-line', reasonCode });
      return null;
    };
    const { workspaceId, sessionId } = input.envelope;
    if (sessionId === UNKNOWN_SESSION_ID) return silent('TIER_LINE_NO_SESSION');
    if (input.ctx.killSwitchStopped === true) return silent('TIER_LINE_KILL_SWITCH');
    const mode = modeOf(input);
    if (!modeAllows(mode, 'record')) return silent('TIER_LINE_MODE_OFF');
    const body = bodyOf(input);
    const harness = input.event.harness;
    // A pin holds: the person chose the model.
    if (readPins(body['pins']).modelPin !== null) return silent('TIER_LINE_PINNED');
    const nowMs = clock();
    const memo = readSessionTier(workspaceId, sessionId, nowMs, harness);
    const judged = judge(input, body, memo);
    if (judged === null) return silent('TIER_LINE_NOTHING_TO_SAY');
    const { direction } = judged;
    const key = quietKey(workspaceId, sessionId, direction);
    const last = quiet.get(key);
    if (last !== undefined && nowMs - last < TIER_LINE_QUIET_MS) return silent('TIER_LINE_QUIET');
    if (store.find(workspaceId, sessionId, 'model-tier') !== null) return silent('TIER_LINE_WAITING');
    // Kilo and OpenCode: a turn the plugin switches under plugin-bounded-auto needs no line to say so.
    const turn = body['tierTurn'];
    if ((harness === 'kilocode' || harness === 'opencode') && (turn === 'both' || (turn === 'up' && direction === 'up'))) return silent('TIER_LINE_TURN_SWITCHED');

    const registry = await loadModelRegistry({ home: input.ctx.home });
    if (registry === null) return silent('TIER_LINE_REGISTRY_INVALID');
    // The session's own model: what the harness names on this event, else the sidecar's record of the session.
    const sessionModel = modelLabel(input.event.model) ?? modelLabel(body['sessionModel']);
    const authMode = body['authMode'] === 'api-key' || body['authMode'] === 'subscription' ? body['authMode'] : null;
    const session = await sessionEligible(input, registry, sessionModel, { nowMs, authMode, consentedProviders: sessionConsent(input, registry, sessionModel), aliasCertified: await aliasCertifiedFor(input), harnessVersion: input.harnessVersion ?? null });
    if (session === null) return silent('TIER_LINE_NO_LADDER');
    const ladder = buildTierLadder({ eligible: session.eligible, baselineModelId: session.baselineModelId, volume: session.volume });
    if ('none' in ladder) return silent('TIER_LINE_NO_LADDER');
    // Already on the advised tier (no rung in that direction) is the right tier: silence.
    const targetId = direction === 'up' ? upTarget(ladder, memo) : downTarget(registry, harness, ladder);
    if (targetId === null) return silent(direction === 'up' ? 'TIER_LINE_NO_STEP_UP_RUNG' : 'TIER_LINE_ALREADY_ON_TIER');
    // Advice this session did not follow twice is not repeated (the existing adherence machinery).
    if (adviceIgnored(input.ctx, 'main-route', sessionId, tierLineSlice(direction), targetId)) return silent('TIER_LINE_IGNORED');

    const name = (id: string): string => registryModel(registry, id)?.displayName ?? id;
    const lines = modelTierLine({
      direction,
      harness,
      reasons: judged.reasons,
      protectedClasses: judged.signals?.protectedClasses ?? [],
      attempts: judged.source === 'failure' ? (judged.signals?.failedAttempts ?? null) : null,
      baselineName: name(ladder.baselineModelId),
      targetName: name(targetId),
      switchCommand: switchCommandFor(harness, registry, targetId, nowMs, input.harnessVersion ?? null),
      subagentAlias: direction === 'up' && harness === 'claude' ? claudeAlias(registry, targetId, nowMs, input.harnessVersion ?? null) : null,
      subagentAliasNote: direction === 'up' && harness === 'claude' ? subagentAliasNoteFor(registry, targetId, nowMs, input.harnessVersion ?? null) : null,
    });
    const show = modeAllows(mode, 'show-advice');
    const decisionId = await recordLine(input, {
      judged,
      ladder,
      targetId,
      harness,
      show,
      nowMs,
      waitMs: Math.max(0, Math.min(recordWaitMaxMs, input.ctx.deadline.remainingMs() - RECORD_MARGIN_MS)),
    });
    if (!show) {
      // Observe: recorded, nothing shown or queued, and not recorded again for the quiet period.
      quiet.set(key, nowMs);
      trimQuiet(quiet);
      return silent('TIER_LINE_OBSERVED');
    }
    const advisedAtMs = nowMs;
    const delivered = (): void => {
      quiet.set(key, advisedAtMs);
      trimQuiet(quiet);
      // Opened for adherence on delivery; a line with no record gets an id derived from its session, direction and time.
      openAdvice(input.ctx, {
        decisionId: decisionId ?? `tier-line-${direction}-${advisedAtMs.toString(36)}-${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`,
        adviceKind: 'main-route',
        sessionId,
        slice: tierLineSlice(direction),
        advisedModel: targetId,
        currentModel: ladder.baselineModelId,
        atMs: advisedAtMs,
      });
    };
    const reasonCode = direction === 'up' ? 'TIER_LINE_UP' : 'TIER_LINE_DOWN';
    const queued = store.put(workspaceId, sessionId, { kind: 'model-tier', text: lines.model, personText: lines.person, decisionId, reasonCode, delivered });
    // The harness shows nothing on this event (a Kilo or OpenCode tool event, an Antigravity PostToolUse): the line waits.
    if (!queued || !showsHere(input)) return silent('TIER_LINE_QUEUED');
    const waiting = store.find(workspaceId, sessionId, 'model-tier');
    input.ctx.trace({ event: 'model-tier-line', reasonCode, ...(decisionId === null ? {} : { decisionId }) });
    return {
      hookOutcome: { kind: 'context', text: lines.model },
      fallbackText: lines.person,
      reasonCode,
      ...(decisionId === null ? {} : { decisionId }),
      commit: () => (waiting === null ? true : store.consume(workspaceId, sessionId, waiting)),
    };
  };
}

function trimQuiet(quiet: TierLineQuiet): void {
  while (quiet.size > QUIET_MAX) {
    const first = quiet.keys().next();
    if (first.done === true) break;
    quiet.delete(first.value);
  }
}

/**
 * Records the line as one advisory `model-tier` decision (`jevris explain` renders it through the same lines as a route's tier),
 * waiting for the journal no longer than `waitMs`; null when there is no engine, no time or the record failed.
 */
async function recordLine(
  input: TriggerHandlerInput,
  r: { readonly judged: Judged; readonly ladder: TierLadder; readonly targetId: string; readonly harness: string; readonly show: boolean; readonly nowMs: number; readonly waitMs: number },
): Promise<string | null> {
  const engine = input.engine;
  if (engine === null || engine.recordAdvice === undefined || input.ctx.killSwitchStopped === true) return null;
  const s = r.judged.signals;
  const level = r.judged.direction === 'up' ? 'STEP_UP' : 'STEP_DOWN';
  const reasonCodes = [
    r.show ? 'TIER_MAIN_LINE_QUEUED' : 'TIER_MAIN_LINE_OBSERVED',
    `TIER_MAIN_DIRECTION_${upper(r.judged.direction)}`,
    `TIER_MAIN_SOURCE_${upper(r.judged.source)}`,
    `TIER_MAIN_HARNESS_${upper(r.harness)}`,
    'TIER_SOURCE_RULE',
    `TIER_LEVEL_${level}`,
    `TIER_RULES_${level}`,
    ...(s === null ? [] : [`TIER_FEATURE_RISK_${upper(s.risk)}`, `TIER_FEATURE_FILES_${String(s.files)}`, `TIER_FEATURE_CHECKS_${String(s.checks)}`]),
    ...(s !== null && s.protectedClasses.length > 0 ? [`TIER_FEATURE_PROTECTED_${String(s.protectedClasses.length)}`] : []),
    ...(s !== null && s.verb !== null ? [`TIER_FEATURE_VERB_${upper(s.verb)}`] : []),
    `TIER_CANDIDATES_${String(r.ladder.candidates.length)}`,
    'TIER_TEXT_NOT_SENT',
    ...r.judged.reasons,
  ].filter((c) => REASON.test(c));
  const started = performance.now();
  let recording: Promise<string | null>;
  try {
    recording = engine
      .recordAdvice({
        specId: MODEL_TIER_SPEC_ID,
        workspaceId: input.envelope.workspaceId,
        evidenceRevision: input.revision ?? input.envelope.expectedRevision,
        ...(input.envelope.taskId === undefined ? {} : { taskId: input.envelope.taskId }),
        sessionId: input.envelope.sessionId,
        action: { kind: 'advise', templateId: MODEL_TIER_SPEC_ID, evidenceIds: evidenceIdsOf(s, r.ladder.baselineModelId, r.targetId, r.ladder) },
        reasonCodes: [...new Set(reasonCodes)],
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      })
      .then(
        (recorded) => (recorded.ok && ID.test(recorded.decisionId) ? recorded.decisionId : null),
        () => null,
      );
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, Math.floor(r.waitMs)));
  });
  try {
    return await Promise.race([recording, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The default handler, on the shared pending-advice store. */
export const modelTierAdvice: TriggerHandler = createModelTierHandler();
