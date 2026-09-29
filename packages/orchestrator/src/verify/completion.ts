/**
 * Freshness, completion and stop continuation (VER-03, VER-04, VER-05; SSOT §10.5, C39, C45,
 * C48, US23, US24).
 *
 * - `refreshFreshness` compares the current revision snapshot with the last one and invalidates
 *   every receipt whose declared inputs changed; a branch or lockfile change invalidates all.
 * - `evaluateCompletion` reads receipts from the ledger only, recomputes each check's scoped
 *   revision immediately before deciding, maps acceptance requirements to checks, and verifies
 *   only when every mandatory check has a current passing receipt.
 * - `decideStop` persists one reminder per task and unchanged missing-evidence condition,
 *   respects `stop_hook_active`, and afterwards records an explicit unverified report.
 */
import { stillRunningText } from '@jevris/contracts';
import { completionFromReceipts, stopContinuation, storeReadInput, type CompletionDecision } from '@jevris/core';
import { invalidateForRevision, type OpenStoreResult } from '@jevris/store';
import type { RecordLedger } from '../ledger.js';
import type { CheckManifest } from './manifest.js';
import type { ReceiptLedger, StoredReceipt } from './receipts.js';
import type { ReceiptScope } from './receipt-scope.js';
import { compareSnapshots, nodeGit, scopedRevision, snapshotRevision, type GitPort, type RevisionChange, type RevisionSnapshot } from './revision.js';
import { hashOf, recordKey } from '../util.js';

export interface FreshnessInput {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly receipts: ReceiptLedger;
  readonly state: RecordLedger;
  readonly git?: GitPort;
  /** The sidecar's open store, when there is one: its receipt rows are invalidated too. */
  readonly store?: OpenStoreResult;
  /** The receipts this root owns and its snapshot key (`receiptScopeOf`); default all, keyed by workspace. */
  readonly scope?: ReceiptScope;
}

export interface FreshnessResult {
  readonly snapshot: RevisionSnapshot;
  readonly change: RevisionChange;
  readonly invalidated: readonly string[];
  /** Scoped revisions already computed for this snapshot, by scope list (one `ls-tree` each). */
  readonly scopeRevisions?: ReadonlyMap<string, string>;
}

function sameSnapshot(a: RevisionSnapshot | undefined, b: RevisionSnapshot): boolean {
  return a !== undefined && a.kind === b.kind && a.revision === b.revision && a.head === b.head && a.branch === b.branch && a.dirtyHash === b.dirtyHash && a.lockfileHash === b.lockfileHash;
}

interface StoredSnapshot {
  readonly workspaceId: string;
  readonly snapshot: RevisionSnapshot;
}

export async function refreshFreshness(input: FreshnessInput): Promise<FreshnessResult> {
  const git = input.git ?? nodeGit();
  const snapshot = await snapshotRevision(input.workspaceRoot, git);
  const scopeKey = input.scope?.key ?? input.workspaceId;
  const prior = input.state.get<StoredSnapshot>('freshness', scopeKey);
  const change = compareSnapshots(prior?.snapshot, snapshot);
  const invalidateAll = prior !== undefined && (change.branchChanged || change.lockfileChanged);
  const byReason = new Map<string, string[]>();
  const scopeCache = new Map<string, string>();
  for (const row of input.receipts.list(input.workspaceId)) {
    if (row.validity !== 'current') continue;
    if (input.scope !== undefined && !input.scope.includes(row)) continue;
    let reason: string | undefined;
    // A branch or lockfile change since the stored snapshot invalidates every receipt made
    // before it. A receipt made after it (a check just run) already carries the new branch and
    // lockfile, so it is judged by its own scoped revision like any other.
    if (invalidateAll && change.branchChanged && row.receipt.inputRevision.branch !== snapshot.branch) reason = 'branch-changed';
    else if (invalidateAll && change.lockfileChanged && row.receipt.inputRevision.lockfileHash !== snapshot.lockfileHash) reason = 'lockfile-changed';
    else {
      const key = row.receipt.inputScopes.join('\n');
      let current = scopeCache.get(key);
      if (current === undefined) {
        current = await scopedRevision(input.workspaceRoot, snapshot, row.receipt.inputScopes, git);
        scopeCache.set(key, current);
      }
      if (current !== row.receipt.inputRevision.scopeRevision) reason = 'inputs-changed';
    }
    if (reason === undefined) continue;
    const list = byReason.get(reason) ?? [];
    list.push(row.receipt.id);
    byReason.set(reason, list);
  }
  const invalidated: string[] = [];
  for (const [reason, ids] of byReason) {
    await input.receipts.invalidate(input.workspaceId, ids, reason);
    invalidated.push(...ids);
  }
  if (input.store !== undefined && prior !== undefined && prior.snapshot.revision !== snapshot.revision) {
    invalidateForRevision(input.store, prior.snapshot.revision.slice(0, 128), snapshot.revision.slice(0, 128));
  }
  // An unchanged snapshot is not written again: the hook paths (Stop, restore) run inside the
  // sidecar's subscriber slice, and a durable write is most of their cost.
  if (!sameSnapshot(prior?.snapshot, snapshot)) {
    await input.state.transact((tx) => {
      tx.put('freshness', scopeKey, {
        workspaceId: input.workspaceId,
        snapshot: { ...snapshot, dirty: snapshot.dirty.slice(0, 5000) },
      } satisfies StoredSnapshot);
    });
  }
  return { snapshot, change, invalidated: invalidated.sort(), scopeRevisions: scopeCache };
}

export interface CompletionInput {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly manifests: readonly CheckManifest[];
  /** Acceptance checks from the task graph (TaskNode.acceptanceCheckIds). */
  readonly acceptanceCheckIds?: readonly string[];
  /** Acceptance requirements of the task (TaskNode.requirementIds). */
  readonly requirementIds?: readonly string[];
  readonly receipts: ReceiptLedger;
  readonly state: RecordLedger;
  readonly git?: GitPort;
  readonly store?: OpenStoreResult;
  readonly impact?: 'known' | 'unknown';
  /** The receipts this root owns (`receiptScopeOf`); default all. */
  readonly scope?: ReceiptScope;
}

export type CheckStatus = 'passed' | 'failed' | 'stale' | 'missing' | 'not-run' | 'unknown';

export interface CheckReport {
  readonly checkId: string;
  readonly mandatory: boolean;
  readonly status: CheckStatus;
  readonly receiptId: string | null;
  readonly outcomeReason: string | null;
}

export interface CompletionReport {
  readonly verified: boolean;
  readonly decision: CompletionDecision;
  readonly revision: string;
  readonly checks: readonly CheckReport[];
  readonly mandatoryCheckIds: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly uncoveredRequirements: readonly string[];
  readonly invalidated: readonly string[];
  /** Hash of what is missing; the stop continuation keys its reminder on it. */
  readonly conditionKey: string;
  readonly applied: false;
  readonly authorityGranted: false;
}

/** The newest receipt per check, as `ReceiptLedger.latest`, limited to the root's scope. */
function latestInScope(rows: readonly StoredReceipt[], taskId: string | null, scope: ReceiptScope | undefined): ReadonlyMap<string, StoredReceipt> {
  const out = new Map<string, StoredReceipt>();
  for (const row of rows) {
    if (taskId !== null && row.receipt.taskId !== null && row.receipt.taskId !== taskId) continue;
    if (scope !== undefined && !scope.includes(row)) continue;
    const prior = out.get(row.receipt.checkId);
    if (prior === undefined || prior.receipt.endedAt < row.receipt.endedAt || (prior.receipt.endedAt === row.receipt.endedAt && prior.recordedAtMs < row.recordedAtMs)) out.set(row.receipt.checkId, row);
  }
  return out;
}

function statusOf(row: StoredReceipt | undefined, currentScope: string | undefined): CheckStatus {
  if (row === undefined) return 'missing';
  if (row.validity !== 'current' || currentScope !== row.receipt.inputRevision.scopeRevision) return 'stale';
  switch (row.receipt.outcome) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'not-run':
      return 'not-run';
    case 'unknown':
      return 'unknown';
  }
}

export async function evaluateCompletion(input: CompletionInput): Promise<CompletionReport> {
  const git = input.git ?? nodeGit();
  const fresh = await refreshFreshness({
    workspaceRoot: input.workspaceRoot,
    workspaceId: input.workspaceId,
    receipts: input.receipts,
    state: input.state,
    git,
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
  const byId = new Map(input.manifests.map((m) => [m.id, m]));
  const mandatory = new Set<string>(input.acceptanceCheckIds ?? []);
  for (const manifest of input.manifests) if (manifest.mandatory) mandatory.add(manifest.id);
  // Requirement -> checks mapping: from manifests' requirementIds.
  const uncovered: string[] = [];
  for (const requirement of input.requirementIds ?? []) {
    const covering = input.manifests.filter((m) => m.requirementIds.includes(requirement));
    if (covering.length === 0) uncovered.push(requirement);
    for (const m of covering) mandatory.add(m.id);
  }
  const latest = latestInScope(input.receipts.list(input.workspaceId), input.taskId, input.scope);
  const checks: CheckReport[] = [];
  const rows: { checkId: string; sourceRevision: string; currentRevision: string; validity: 'current' | 'invalidated'; failed: boolean }[] = [];
  const ids = [...new Set([...mandatory, ...input.manifests.map((m) => m.id)])].sort();
  for (const checkId of ids) {
    const manifest = byId.get(checkId);
    const row = latest.get(checkId);
    const scopes = manifest?.inputScopes ?? row?.receipt.inputScopes ?? [];
    const scopeKey = scopes.join('\n');
    const known = fresh.scopeRevisions?.get(scopeKey);
    const currentScope = known ?? await scopedRevision(input.workspaceRoot, fresh.snapshot, scopes, git);
    const status = statusOf(row, currentScope);
    checks.push({
      checkId,
      mandatory: mandatory.has(checkId),
      status,
      receiptId: row?.receipt.id ?? null,
      outcomeReason: row?.receipt.outcomeReason ?? null,
    });
    if (row !== undefined) {
      rows.push({
        checkId,
        sourceRevision: row.receipt.inputRevision.scopeRevision,
        currentRevision: currentScope,
        validity: row.validity,
        failed: row.receipt.outcome !== 'passed',
      });
    }
  }
  const mandatoryIds = [...mandatory].sort();
  const decision = completionFromReceipts(
    storeReadInput({
      currentRevision: fresh.snapshot.revision,
      mandatoryChecks: mandatoryIds,
      receipts: rows,
      ...(input.impact === undefined ? {} : { impact: input.impact }),
    }),
  );
  const missing = checks.filter((c) => c.mandatory && c.status !== 'passed').map((c) => `${c.checkId}:${c.status}`);
  const verified = decision.verified && uncovered.length === 0 && mandatoryIds.length > 0;
  return {
    verified,
    decision,
    revision: fresh.snapshot.revision,
    checks,
    mandatoryCheckIds: mandatoryIds,
    missingEvidence: missing,
    uncoveredRequirements: uncovered.sort(),
    invalidated: fresh.invalidated,
    // The missing-evidence condition (SSOT §10.5): which mandatory checks lack a current pass and
    // in what state, and which requirements are uncovered. Not the revision: in a checkout where
    // other work lands every few minutes the revision always moves, and keying on it would turn
    // "one reminder per unchanged condition" into a reminder at every stop.
    conditionKey: hashOf({ task: input.taskId, missing, uncovered }).slice(0, 32),
    applied: false,
    authorityGranted: false,
  };
}

export interface StopInput {
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly completion: CompletionReport;
  readonly stopHookActive: boolean;
  readonly userInterrupt?: boolean;
  readonly state: RecordLedger;
  readonly nowMs?: number;
  /** `orchestration.maxStopContinuationsPerCondition` (0 or 1; default 1). With 0 no reminder is scheduled. */
  readonly maxContinuations?: number;
  /**
   * Checks a verification run is producing now (RUNNING) or will next (QUEUED). When every
   * missing check is one of them, a reminder cannot help: the stop is labelled unverified and
   * says the evidence is on its way, and the reminder stays available for when it lands.
   */
  readonly pending?: ReadonlyMap<string, 'RUNNING' | 'QUEUED'>;
  /**
   * Whether the answer carrying a reminder will be used (the sidecar's slice has not ended).
   * Checked inside the transaction: a reminder that would not be delivered is not spent, and the
   * report says `remind` without a scheduled continuation. Default: always used.
   */
  readonly answerWanted?: () => boolean;
}

export interface StopReport {
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly at: string;
  readonly outcome: 'verified' | 'remind' | 'unverified';
  readonly continuationScheduled: boolean;
  readonly remindersFired: number;
  readonly missingEvidence: readonly string[];
  readonly uncoveredRequirements: readonly string[];
  readonly text: string;
  readonly humanStopAvailable: true;
}

/** What followed a Stop reminder (audit P6): a check started, the task verified, or the work ended unverified. */
export const REMINDER_OUTCOMES = ['check-started', 'verified', 'ended-unverified'] as const;
export type ReminderOutcome = (typeof REMINDER_OUTCOMES)[number];

/** One reminder's result, kept after the row moves on to a newer reminder (times only, no text). */
export interface ReminderHistoryEntry {
  readonly firedAtMs: number;
  readonly outcome: ReminderOutcome | null;
  /** From the reminder to its final outcome (verified or ended-unverified); null while open. */
  readonly timeToOutcomeMs: number | null;
  /** From the reminder to the first check run after it; null when none ran. */
  readonly timeToCheckMs: number | null;
}

/** Past reminders kept per task row. */
export const REMINDER_HISTORY_MAX = 16;

interface ReminderRow {
  readonly key: string;
  /** The missing-evidence condition the reminder was for (`conditionKey`). */
  readonly condition?: string;
  readonly fired: number;
  /** A verified stop cleared the row: the same condition after later work may remind once more. */
  readonly cleared?: boolean;
  /** When the latest reminder fired (absent on rows kept before P6). */
  readonly firedAtMs?: number;
  readonly outcome?: ReminderOutcome | null;
  readonly timeToOutcomeMs?: number | null;
  readonly timeToCheckMs?: number | null;
  readonly history?: readonly ReminderHistoryEntry[];
}

function reminderKey(workspaceId: string, taskId: string | null): string {
  return recordKey(workspaceId, taskId ?? '-');
}

/** The latest reminder's result, or undefined for a row kept before P6. */
function currentEntry(row: ReminderRow): ReminderHistoryEntry | undefined {
  if (typeof row.firedAtMs !== 'number') return undefined;
  return { firedAtMs: row.firedAtMs, outcome: row.outcome ?? null, timeToOutcomeMs: row.timeToOutcomeMs ?? null, timeToCheckMs: row.timeToCheckMs ?? null };
}

/** A final outcome for the latest reminder, once (a verified or ended-unverified reminder keeps its first final outcome). */
function settledRow(row: ReminderRow, outcome: 'verified' | 'ended-unverified', nowMs: number): ReminderRow | undefined {
  if (typeof row.firedAtMs !== 'number' || row.outcome === 'verified' || row.outcome === 'ended-unverified') return undefined;
  return { ...row, outcome, timeToOutcomeMs: Math.max(0, nowMs - row.firedAtMs) };
}

/**
 * A check run started after a Stop reminder (P6): the reminder's outcome becomes `check-started`
 * (until the task verifies or the work ends unverified) with the time from the reminder. Nothing
 * is written when no reminder is open. It never counts as evidence.
 */
export async function noteReminderCheckStarted(state: RecordLedger, workspaceId: string, taskId: string | null, nowMs: number): Promise<void> {
  const key = reminderKey(workspaceId, taskId);
  const open = (row: ReminderRow | undefined): row is ReminderRow => row !== undefined && row.cleared !== true && typeof row.firedAtMs === 'number' && (row.outcome ?? null) === null;
  if (!open(state.get<ReminderRow>('stop-reminders', key))) return;
  await state.transact((tx) => {
    const row = tx.get<ReminderRow>('stop-reminders', key);
    if (!open(row)) return;
    tx.put('stop-reminders', key, { ...row, outcome: 'check-started', timeToCheckMs: Math.max(0, nowMs - (row.firedAtMs as number)) } satisfies ReminderRow);
  });
}

/** Stop reminders in a workspace and what followed them (P6; C48's stop-loop measure, status). */
export interface ReminderSummary {
  readonly fired: number;
  /** A check ran after the reminder. */
  readonly ledToCheck: number;
  readonly ledToVerification: number;
  readonly endedUnverified: number;
}

export function reminderSummary(state: RecordLedger, workspaceId: string): ReminderSummary {
  const prefix = recordKey(workspaceId, '');
  let [fired, ledToCheck, ledToVerification, endedUnverified] = [0, 0, 0, 0];
  for (const row of state.list<ReminderRow>('stop-reminders')) {
    if (typeof row.key !== 'string' || !row.key.startsWith(prefix)) continue;
    const current = currentEntry(row);
    for (const entry of [...(row.history ?? []), ...(current === undefined ? [] : [current])]) {
      fired += 1;
      if (entry.timeToCheckMs !== null || entry.outcome === 'check-started') ledToCheck += 1;
      if (entry.outcome === 'verified') ledToVerification += 1;
      if (entry.outcome === 'ended-unverified') endedUnverified += 1;
    }
  }
  return { fired, ledToCheck, ledToVerification, endedUnverified };
}

export async function decideStop(input: StopInput): Promise<StopReport> {
  const at = new Date(input.nowMs ?? Date.now()).toISOString();
  const base = {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    at,
    missingEvidence: input.completion.missingEvidence,
    uncoveredRequirements: input.completion.uncoveredRequirements,
    humanStopAvailable: true as const,
  };
  // One row per task: the condition its last reminder was for, and what followed each reminder
  // (P6). A verified stop clears it, so the same condition after later work may remind once more;
  // anything else keeps it.
  const key = reminderKey(input.workspaceId, input.taskId);
  const nowMs = input.nowMs ?? Date.now();
  if (input.completion.verified) {
    const prior = input.state.get<ReminderRow>('stop-reminders', key);
    if (prior !== undefined && prior.cleared !== true) {
      await input.state.transact((tx) => {
        const row = tx.get<ReminderRow>('stop-reminders', key);
        if (row === undefined) return;
        tx.put('stop-reminders', key, { ...(settledRow(row, 'verified', nowMs) ?? row), cleared: true } satisfies ReminderRow);
      });
    }
    return { ...base, outcome: 'verified', continuationScheduled: false, remindersFired: 0, text: 'Verified: every mandatory check has a current passing receipt.' };
  }
  const condition = input.completion.conditionKey;
  const pending = input.pending ?? new Map<string, 'RUNNING' | 'QUEUED'>();
  const missingIds = [...new Set(input.completion.missingEvidence.map((e) => e.split(':')[0] ?? e))];
  const waiting = missingIds.filter((id) => pending.has(id));
  const onlyWaiting = missingIds.length > 0 && waiting.length === missingIds.length && input.completion.uncoveredRequirements.length === 0;
  // The same words as each harness's Stop block reason (contracts stillRunningText).
  const waitingText = waiting.length === 0 ? '' : ` ${stillRunningText(waiting.map((id) => [id, pending.get(id) ?? 'RUNNING'] as const))}`;
  let report: StopReport | undefined;
  await input.state.transact((tx) => {
    const row = tx.get<ReminderRow>('stop-reminders', key);
    const fired = row !== undefined && row.cleared !== true && row.condition === condition ? row.fired : 0;
    const blocked = input.stopHookActive || input.userInterrupt === true || input.maxContinuations === 0 || onlyWaiting;
    const decision = stopContinuation({
      remindersAlreadyFired: blocked ? 1 : fired,
      requiredCheckUnavailable: true,
    });
    if (decision.continuationScheduled && input.answerWanted?.() === false) {
      report = { ...base, outcome: 'remind', continuationScheduled: false, remindersFired: fired, text: 'The reminder was not delivered; the next stop asks again.' };
      return;
    }
    if (decision.continuationScheduled) {
      // The earlier reminder's result moves to the row's history (bounded); the new one is open.
      const earlier = row === undefined ? undefined : currentEntry(row);
      const history = [...(row?.history ?? []), ...(earlier === undefined ? [] : [earlier])].slice(-REMINDER_HISTORY_MAX);
      tx.put('stop-reminders', key, { key, condition, fired: fired + 1, firedAtMs: nowMs, outcome: null, timeToOutcomeMs: null, timeToCheckMs: null, history } satisfies ReminderRow);
    } else if (row !== undefined && !onlyWaiting) {
      // The work ends unverified after a reminder (not while its missing checks are still running).
      const settled = settledRow(row, 'ended-unverified', nowMs);
      if (settled !== undefined) tx.put('stop-reminders', key, settled);
    }
    const missing = input.completion.missingEvidence.join(', ') || 'none';
    const uncovered = input.completion.uncoveredRequirements.join(', ') || 'none';
    report = {
      ...base,
      outcome: decision.continuationScheduled ? 'remind' : 'unverified',
      continuationScheduled: decision.continuationScheduled,
      remindersFired: decision.continuationScheduled ? fired + 1 : fired,
      text: decision.continuationScheduled
        ? `Missing verification evidence: ${missing}. Uncovered requirements: ${uncovered}. Run the declared checks (jevris verify) before finishing.${waitingText}`
        : `Unverified: the work ends without current passing receipts for ${missing}. Uncovered requirements: ${uncovered}. It is labelled unverified.${waitingText}`,
    };
    if (!decision.continuationScheduled) tx.put('stop-reports', recordKey(input.workspaceId, input.taskId ?? '-'), report);
  });
  return report as unknown as StopReport;
}

/** The last unverified stop report for status and explain. */
export function lastStopReport(state: RecordLedger, workspaceId: string, taskId: string | null): StopReport | undefined {
  return state.get<StopReport>('stop-reports', recordKey(workspaceId, taskId ?? '-'));
}
