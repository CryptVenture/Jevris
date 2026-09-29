/**
 * Learning records (owner decision 2026-09-27, "everything Jevris decides must be learnable";
 * learning-coverage audit P4, P5 and P8). Every row holds ids, codes, counts, milliseconds and
 * integer micro-USD only: never prompt, source, model output or a remote body. They stay on this
 * machine, and nothing here changes a live threshold, permission or policy.
 *
 * - P4, `decision_outcome`: a Jev decision joined to its task's deterministic label. It copies
 *   the decision's codes and numbers, so it stays usable after the decision record's own sweep.
 *   D writes it where it labels a task; C reads it for explain, the local report and offline
 *   calibration cases, which a person reviews for a signed release.
 * - P5, `session_model_change` and `advice_adherence`: each change of a session's actual model,
 *   and whether model advice was followed, overridden or left without a change. C applies the
 *   per-session suppression rule on `adviceOverrides`.
 * - P8, `latency_counter`: daily host counters for hook deadline misses per harness, sidecar
 *   deadlines and late answers per op, queued and slow subscribers, and breaker opens.
 * - P12, `decision_feedback` (v7): a person's accept or reject of a decision's advice, with one of
 *   the closed reason tokens (contracts' FEEDBACK_REASONS) and never free text. The latest
 *   feedback on a decision wins. C's `decision.feedback` op writes it and its report reads it.
 *
 * Retention: every table follows `decisionRetentionDays` (the sweep in retention.ts); learning
 * never relaxes retention. `deleteLearningRecords` removes them for `jevris data delete --scope
 * learning` and `jevris route learning reset --clear-evidence`.
 */
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { field, isId, isKey, isMs, nullableNum, nullableStr, num, read, refuse, str, write } from './access.js';
import type { SqlDriver } from './schema.js';

/** v6: learning records (decision outcomes, session model changes, advice adherence, latency counters). */
export const LEARNING_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS decision_outcome (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  spec_version TEXT NOT NULL,
  model TEXT NOT NULL,
  calibration_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  route TEXT,
  lane TEXT,
  decision_outcome TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  provider_calls INTEGER NOT NULL CHECK (provider_calls >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd >= 0),
  cost_micro_usd INTEGER,
  decided_at_ms INTEGER NOT NULL,
  label TEXT NOT NULL,
  label_source TEXT NOT NULL,
  receipt_id TEXT,
  join_basis TEXT NOT NULL CHECK (join_basis IN ('task', 'session-window')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  previous_label TEXT,
  labelled_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, decision_id, task_id)
);

CREATE INDEX IF NOT EXISTS decision_outcome_by_time ON decision_outcome (labelled_at_ms);
CREATE INDEX IF NOT EXISTS decision_outcome_by_decision ON decision_outcome (workspace_id, decision_id);

CREATE TABLE IF NOT EXISTS session_model_change (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  at_ms INTEGER NOT NULL,
  from_model TEXT,
  to_model TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, seq)
);

CREATE TRIGGER IF NOT EXISTS session_model_change_no_update BEFORE UPDATE ON session_model_change
BEGIN
  SELECT RAISE(ABORT, 'session model changes are append-only');
END;

CREATE TABLE IF NOT EXISTS advice_adherence (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  advice_kind TEXT NOT NULL CHECK (advice_kind IN ('main-route', 'model-change')),
  slice TEXT NOT NULL,
  advised_model TEXT NOT NULL,
  model_at_advice TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('open', 'followed', 'overridden', 'no-change', 'unknown')),
  resolved_by TEXT,
  events_until INTEGER NOT NULL DEFAULT 0 CHECK (events_until >= 0),
  advised_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  PRIMARY KEY (workspace_id, decision_id)
);

CREATE INDEX IF NOT EXISTS advice_adherence_by_session ON advice_adherence (workspace_id, session_id, verdict);

CREATE TABLE IF NOT EXISTS latency_counter (
  day_start_ms INTEGER NOT NULL CHECK (day_start_ms >= 0),
  scope TEXT NOT NULL CHECK (scope IN ('hook', 'sidecar-op', 'subscriber', 'breaker')),
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  total_ms INTEGER NOT NULL CHECK (total_ms >= 0),
  max_ms INTEGER NOT NULL CHECK (max_ms >= 0),
  PRIMARY KEY (day_start_ms, scope, name, metric)
);
`;

/**
 * v7: P12 feedback on a decision's advice (C with E, 2026-09-27). One row per decision; the latest
 * write wins and `revision` counts the writes. A rejection carries a closed reason token, and an
 * acceptance none. Codes and times only.
 */
export const DECISION_FEEDBACK_SQL = `
CREATE TABLE IF NOT EXISTS decision_feedback (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  reason TEXT CHECK (reason IN ('preference', 'unavailable-context', 'error', 'unspecified')),
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK ((accepted = 1 AND reason IS NULL) OR (accepted = 0 AND reason IS NOT NULL)),
  PRIMARY KEY (workspace_id, decision_id)
);

CREATE INDEX IF NOT EXISTS decision_feedback_by_time ON decision_feedback (at_ms);
`;

/** The tables `deleteLearningRecords` and the retention sweep cover. */
export const LEARNING_TABLES = Object.freeze(['decision_outcome', 'session_model_change', 'advice_adherence', 'latency_counter', 'decision_feedback'] as const);

const CODE = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const DAY_MS = 86_400_000;

function label(value: unknown): string | null {
  return typeof value === 'string' && LABEL.test(value) ? value : null;
}

function jsonOf(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function reasonCodesOf(text: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '[]');
  } catch {
    parsed = [];
  }
  return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string' && REASON.test(c)).slice(0, 32) : [];
}

function scopeOf(workspaceId: string, wanted: string | undefined): string | undefined {
  return workspaceId === 'host' ? wanted : workspaceId;
}

// ---------------------------------------------------------------- P4 decision outcomes

/**
 * Labels that may overturn an earlier one (owner 2026-09-27, as route learning): a later revert,
 * retry or incomplete run can overturn a verified pass. A later pass overturns only an incomplete
 * run (D: the first run ended with no receipt and a relaunch passed); it never overturns
 * verified-fail, reverted or retried.
 */
export const OVERTURNING_LABELS: ReadonlySet<string> = new Set(['reverted', 'retried', 'run-incomplete']);

/** Whether a later label replaces the earlier one on the same decision and task. */
export function labelOverturns(previous: string, next: string): boolean {
  if (previous === next) return false;
  if (OVERTURNING_LABELS.has(next)) return true;
  return next === 'verified-pass' && previous === 'run-incomplete';
}

export interface DecisionOutcomeInput {
  /** Needed on the host handle; a workspace view uses its own. */
  readonly workspaceId?: string;
  readonly taskId: string;
  /** A deterministic label code, e.g. verified-pass, verified-fail, reverted, run-incomplete. */
  readonly label: string;
  /** Where the label came from, e.g. verification-receipt, revert, retry. */
  readonly labelSource: string;
  readonly receiptId?: string | null;
  readonly atMs: number;
  /** Also joins that session's decisions with no task made inside the window (for the report only). */
  readonly sessionWindow?: { readonly sessionId: string; readonly fromMs: number; readonly toMs: number };
}

export interface DecisionOutcomeRow {
  readonly workspaceId: string;
  readonly decisionId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly kind: string;
  readonly specVersion: string;
  readonly model: string;
  readonly calibrationVersion: string;
  readonly policyVersion: string;
  readonly route: string | null;
  readonly lane: string | null;
  readonly decisionOutcome: string;
  readonly reasonCodes: readonly string[];
  readonly latencyMs: number;
  readonly providerCalls: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly reservedMicroUsd: number;
  readonly costMicroUsd: number | null;
  readonly decidedAtMs: number;
  readonly label: string;
  readonly labelSource: string;
  readonly receiptId: string | null;
  readonly joinBasis: 'task' | 'session-window';
  readonly revision: number;
  readonly previousLabel: string | null;
  readonly labelledAtMs: number;
}

const DECISION_COLUMNS =
  'decision_id, task_id, kind, spec_version, model, calibration_version, policy_version, outcome, reason_codes, latency_ms, provider_calls, usage_known, input_tokens, output_tokens, reserved_micro_usd, cost_micro_usd, created_at_ms, record';

function upsertOutcome(driver: SqlDriver, ws: string, taskId: string, row: unknown, input: DecisionOutcomeInput, basis: 'task' | 'session-window'): 'joined' | 'relabelled' | 'kept' | 'skipped' {
  const decisionId = str(field(row, 'decision_id'));
  if (!isId(decisionId)) return 'skipped';
  const record = jsonOf(field(row, 'record'));
  const known = num(field(row, 'usage_known')) === 1;
  const existing = driver.prepare('SELECT label, revision FROM decision_outcome WHERE workspace_id = ? AND decision_id = ? AND task_id = ?').get(ws, decisionId, taskId);
  if (existing !== undefined) {
    const previous = str(field(existing, 'label')) ?? '';
    if (!labelOverturns(previous, input.label)) return 'kept';
    driver
      .prepare('UPDATE decision_outcome SET label = ?, label_source = ?, receipt_id = ?, previous_label = ?, revision = revision + 1, labelled_at_ms = ? WHERE workspace_id = ? AND decision_id = ? AND task_id = ?')
      .run(input.label, input.labelSource, input.receiptId ?? null, previous, input.atMs, ws, decisionId, taskId);
    return 'relabelled';
  }
  const sessionId = typeof record['sessionId'] === 'string' && isKey(record['sessionId']) ? record['sessionId'] : null;
  driver
    .prepare(
      `INSERT INTO decision_outcome (workspace_id, decision_id, task_id, session_id, kind, spec_version, model, calibration_version, policy_version, route, lane,
        decision_outcome, reason_codes, latency_ms, provider_calls, input_tokens, output_tokens, reserved_micro_usd, cost_micro_usd, decided_at_ms,
        label, label_source, receipt_id, join_basis, labelled_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ws,
      decisionId,
      taskId,
      sessionId,
      label(field(row, 'kind')) ?? 'unknown',
      label(field(row, 'spec_version')) ?? 'unknown',
      label(field(row, 'model')) ?? 'unknown',
      label(field(row, 'calibration_version')) ?? 'none',
      label(field(row, 'policy_version')) ?? 'unknown',
      label(record['route']),
      label(record['lane']),
      label(field(row, 'outcome')) ?? 'unknown',
      JSON.stringify(reasonCodesOf(field(row, 'reason_codes'))),
      num(field(row, 'latency_ms')) ?? 0,
      num(field(row, 'provider_calls')) ?? 0,
      known ? (num(field(row, 'input_tokens')) ?? null) : null,
      known ? (num(field(row, 'output_tokens')) ?? null) : null,
      num(field(row, 'reserved_micro_usd')) ?? 0,
      nullableNum(field(row, 'cost_micro_usd')),
      num(field(row, 'created_at_ms')) ?? 0,
      input.label,
      input.labelSource,
      input.receiptId ?? null,
      basis,
      input.atMs,
    );
  return 'joined';
}

/**
 * Joins a task's deterministic label to every decision made for that task (and, with a session
 * window, to that session's decisions inside the window). Idempotent: a repeat keeps the row; a
 * later overturning label (OVERTURNING_LABELS) replaces the label and keeps the previous one.
 */
export function recordDecisionOutcomes(
  store: OpenStoreResult,
  input: DecisionOutcomeInput,
): { readonly ok: true; readonly joined: number; readonly relabelled: number } | StoreRefusal {
  if (!isId(input.taskId) || !CODE.test(input.label) || !CODE.test(input.labelSource) || !isMs(input.atMs)) return refuse('invalid-input');
  if (input.receiptId !== undefined && input.receiptId !== null && !isKey(input.receiptId)) return refuse('invalid-input');
  if (input.workspaceId !== undefined && !isId(input.workspaceId)) return refuse('invalid-input');
  const window = input.sessionWindow;
  if (window !== undefined && (!isKey(window.sessionId) || !isMs(window.fromMs) || !isMs(window.toMs) || window.toMs < window.fromMs)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, input.workspaceId);
    if (ws === undefined) return refuse('invalid-input');
    let joined = 0;
    let relabelled = 0;
    const tally = (result: ReturnType<typeof upsertOutcome>): void => {
      if (result === 'joined') joined += 1;
      else if (result === 'relabelled') relabelled += 1;
    };
    const byTask = driver.prepare(`SELECT ${DECISION_COLUMNS} FROM decision_record WHERE workspace_id = ? AND task_id = ? ORDER BY created_at_ms LIMIT 1000`).all(ws, input.taskId);
    const seen = new Set<string>();
    for (const row of byTask) {
      seen.add(str(field(row, 'decision_id')) ?? '');
      tally(upsertOutcome(driver, ws, input.taskId, row, input, 'task'));
    }
    if (window !== undefined) {
      const bySession = driver
        .prepare(`SELECT ${DECISION_COLUMNS} FROM decision_record WHERE workspace_id = ? AND task_id IS NULL AND created_at_ms >= ? AND created_at_ms <= ? AND json_extract(record, '$.sessionId') = ? ORDER BY created_at_ms LIMIT 1000`)
        .all(ws, window.fromMs, window.toMs, window.sessionId);
      for (const row of bySession) {
        if (seen.has(str(field(row, 'decision_id')) ?? '')) continue;
        tally(upsertOutcome(driver, ws, input.taskId, row, input, 'session-window'));
      }
    }
    return { ok: true as const, joined, relabelled };
  });
}

function outcomeRow(row: unknown): DecisionOutcomeRow | undefined {
  const decisionId = str(field(row, 'decision_id'));
  const taskId = str(field(row, 'task_id'));
  if (decisionId === undefined || taskId === undefined) return undefined;
  const input = nullableNum(field(row, 'input_tokens'));
  const output = nullableNum(field(row, 'output_tokens'));
  return {
    workspaceId: str(field(row, 'workspace_id')) ?? '',
    decisionId,
    taskId,
    sessionId: nullableStr(field(row, 'session_id')),
    kind: str(field(row, 'kind')) ?? '',
    specVersion: str(field(row, 'spec_version')) ?? '',
    model: str(field(row, 'model')) ?? '',
    calibrationVersion: str(field(row, 'calibration_version')) ?? '',
    policyVersion: str(field(row, 'policy_version')) ?? '',
    route: nullableStr(field(row, 'route')),
    lane: nullableStr(field(row, 'lane')),
    decisionOutcome: str(field(row, 'decision_outcome')) ?? '',
    reasonCodes: reasonCodesOf(field(row, 'reason_codes')),
    latencyMs: num(field(row, 'latency_ms')) ?? 0,
    providerCalls: num(field(row, 'provider_calls')) ?? 0,
    usage: input !== null && output !== null ? { inputTokens: input, outputTokens: output } : null,
    reservedMicroUsd: num(field(row, 'reserved_micro_usd')) ?? 0,
    costMicroUsd: nullableNum(field(row, 'cost_micro_usd')),
    decidedAtMs: num(field(row, 'decided_at_ms')) ?? 0,
    label: str(field(row, 'label')) ?? '',
    labelSource: str(field(row, 'label_source')) ?? '',
    receiptId: nullableStr(field(row, 'receipt_id')),
    joinBasis: str(field(row, 'join_basis')) === 'session-window' ? 'session-window' : 'task',
    revision: num(field(row, 'revision')) ?? 1,
    previousLabel: nullableStr(field(row, 'previous_label')),
    labelledAtMs: num(field(row, 'labelled_at_ms')) ?? 0,
  };
}

/** Decision outcomes for the report and calibration cases, oldest label first. */
export function readDecisionOutcomes(
  store: OpenStoreResult,
  filter: { readonly workspaceId?: string; readonly sinceMs?: number; readonly kind?: string; readonly joinBasis?: 'task' | 'session-window'; readonly limit?: number } = {},
): readonly DecisionOutcomeRow[] {
  const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 10_000);
  const result = read(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, filter.workspaceId);
    const where: string[] = ['labelled_at_ms >= ?'];
    const args: (string | number)[] = [filter.sinceMs ?? 0];
    if (ws !== undefined) {
      where.push('workspace_id = ?');
      args.push(ws);
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.joinBasis !== undefined) {
      where.push('join_basis = ?');
      args.push(filter.joinBasis);
    }
    const rows = driver.prepare(`SELECT * FROM decision_outcome WHERE ${where.join(' AND ')} ORDER BY labelled_at_ms, decision_id LIMIT ?`).all(...args, limit);
    return rows.map(outcomeRow).filter((r): r is DecisionOutcomeRow => r !== undefined);
  });
  return Array.isArray(result) ? result : [];
}

/** The outcome labels joined to one decision (explain's actualTaskOutcome). */
export function decisionOutcomeFor(store: OpenStoreResult, decisionId: string, workspaceId?: string): readonly DecisionOutcomeRow[] {
  if (!isId(decisionId)) return [];
  const result = read(store, ({ driver, workspaceId: own }) => {
    const ws = scopeOf(own, workspaceId);
    const rows = ws === undefined
      ? driver.prepare('SELECT * FROM decision_outcome WHERE decision_id = ? ORDER BY labelled_at_ms').all(decisionId)
      : driver.prepare('SELECT * FROM decision_outcome WHERE workspace_id = ? AND decision_id = ? ORDER BY labelled_at_ms').all(ws, decisionId);
    return rows.map(outcomeRow).filter((r): r is DecisionOutcomeRow => r !== undefined);
  });
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------- P5 model changes and advice adherence

export const ADVICE_KINDS = ['main-route', 'model-change'] as const;
export type AdviceKind = (typeof ADVICE_KINDS)[number];
export type AdviceVerdict = 'open' | 'followed' | 'overridden' | 'no-change' | 'unknown';

/**
 * Called by recordSession inside its transaction. A change of a known actual model appends a
 * session_model_change row and resolves the session's open advice; every event counts toward
 * the open advice's events_until; a session end closes its open advice.
 */
export function noteSessionEvent(
  driver: SqlDriver,
  ws: string,
  input: { readonly sessionId: string; readonly previousModel: string | null; readonly actualModel: string | null; readonly ended: boolean; readonly atMs: number; readonly source: string },
): void {
  const open = driver.prepare("SELECT decision_id, advised_model FROM advice_adherence WHERE workspace_id = ? AND session_id = ? AND verdict = 'open' AND advised_at_ms <= ?").all(ws, input.sessionId, input.atMs);
  const changed = input.actualModel !== null && input.previousModel !== null && input.actualModel !== input.previousModel;
  if (changed) {
    const next = (num(field(driver.prepare('SELECT MAX(seq) AS s FROM session_model_change WHERE workspace_id = ? AND session_id = ?').get(ws, input.sessionId), 's')) ?? 0) + 1;
    driver
      .prepare('INSERT INTO session_model_change (workspace_id, session_id, seq, at_ms, from_model, to_model, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ws, input.sessionId, next, input.atMs, input.previousModel, input.actualModel, CODE.test(input.source) || /^[a-z][a-z0-9.-]{0,63}$/.test(input.source) ? input.source : 'unknown');
  }
  const resolve = driver.prepare("UPDATE advice_adherence SET verdict = ?, resolved_by = ?, resolved_at_ms = ? WHERE workspace_id = ? AND decision_id = ? AND verdict = 'open'");
  const bump = driver.prepare("UPDATE advice_adherence SET events_until = events_until + 1 WHERE workspace_id = ? AND decision_id = ? AND verdict = 'open'");
  const current = input.actualModel ?? input.previousModel;
  for (const row of open) {
    const decisionId = str(field(row, 'decision_id')) ?? '';
    const advised = str(field(row, 'advised_model')) ?? '';
    if (changed) resolve.run(input.actualModel === advised ? 'followed' : 'overridden', 'model-change', input.atMs, ws, decisionId);
    else if (input.ended) resolve.run(current === null ? 'unknown' : current === advised ? 'followed' : 'no-change', 'session-end', input.atMs, ws, decisionId);
    else bump.run(ws, decisionId);
  }
}

export interface OpenAdviceInput {
  readonly workspaceId?: string;
  readonly decisionId: string;
  readonly sessionId: string;
  readonly adviceKind: AdviceKind;
  /** The routing slice the advice was for (a code). */
  readonly slice: string;
  readonly advisedModel: string;
  /** The session's model when the advice was delivered, if known. */
  readonly currentModel?: string | null;
  readonly atMs: number;
}

/**
 * Records delivered model advice (C calls this on delivery). An earlier open advice of the same
 * session and slice closes first: followed when the session already runs its model, else
 * no-change. The new advice stays open until a model change or the session ends.
 */
export function openAdvice(store: OpenStoreResult, input: OpenAdviceInput): { readonly ok: true; readonly closed: number } | StoreRefusal {
  if (!isId(input.decisionId) || !isKey(input.sessionId) || !(ADVICE_KINDS as readonly string[]).includes(input.adviceKind) || !isKey(input.slice) || !LABEL.test(input.advisedModel) || !isMs(input.atMs)) return refuse('invalid-input');
  if (input.currentModel !== undefined && input.currentModel !== null && !LABEL.test(input.currentModel)) return refuse('invalid-input');
  if (input.workspaceId !== undefined && !isId(input.workspaceId)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, input.workspaceId);
    if (ws === undefined) return refuse('invalid-input');
    const sessionModel = nullableStr(field(driver.prepare('SELECT actual_model FROM session WHERE workspace_id = ? AND session_id = ?').get(ws, input.sessionId), 'actual_model'));
    const current = input.currentModel ?? sessionModel;
    const earlier = driver
      .prepare("SELECT decision_id, advised_model FROM advice_adherence WHERE workspace_id = ? AND session_id = ? AND slice = ? AND verdict = 'open' AND decision_id <> ?")
      .all(ws, input.sessionId, input.slice, input.decisionId);
    const close = driver.prepare("UPDATE advice_adherence SET verdict = ?, resolved_by = 'next-advice', resolved_at_ms = ? WHERE workspace_id = ? AND decision_id = ? AND verdict = 'open'");
    for (const row of earlier) {
      const advised = str(field(row, 'advised_model')) ?? '';
      close.run(current === null ? 'unknown' : current === advised ? 'followed' : 'no-change', input.atMs, ws, str(field(row, 'decision_id')) ?? '');
    }
    driver
      .prepare(
        `INSERT INTO advice_adherence (workspace_id, decision_id, session_id, advice_kind, slice, advised_model, model_at_advice, verdict, advised_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?) ON CONFLICT (workspace_id, decision_id) DO NOTHING`,
      )
      .run(ws, input.decisionId, input.sessionId, input.adviceKind, input.slice, input.advisedModel, current, input.atMs);
    return { ok: true as const, closed: earlier.length };
  });
}

/**
 * How often this session overrode the same advice (overridden or no-change verdicts). C does not
 * repeat that advice at 2 or more; a new session starts at 0. Never used for safety notices.
 */
export function adviceOverrides(store: OpenStoreResult, input: { readonly workspaceId?: string; readonly sessionId: string; readonly adviceKind: AdviceKind; readonly slice: string; readonly advisedModel: string }): number {
  if (!isKey(input.sessionId) || !isKey(input.slice) || !LABEL.test(input.advisedModel)) return 0;
  const result = read(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, input.workspaceId);
    if (ws === undefined) return 0;
    return (
      num(
        field(
          driver
            .prepare("SELECT COUNT(*) AS n FROM advice_adherence WHERE workspace_id = ? AND session_id = ? AND advice_kind = ? AND slice = ? AND advised_model = ? AND verdict IN ('overridden', 'no-change')")
            .get(ws, input.sessionId, input.adviceKind, input.slice, input.advisedModel),
          'n',
        ),
      ) ?? 0
    );
  });
  return typeof result === 'number' ? result : 0;
}

export interface AdviceAdherenceRow {
  readonly decisionId: string;
  readonly sessionId: string;
  readonly adviceKind: AdviceKind;
  readonly slice: string;
  readonly advisedModel: string;
  readonly modelAtAdvice: string | null;
  readonly verdict: AdviceVerdict;
  readonly resolvedBy: string | null;
  readonly eventsUntil: number;
  readonly advisedAtMs: number;
  readonly resolvedAtMs: number | null;
}

/** One decision's adherence (explain), or undefined when it was not model advice. */
export function adviceAdherenceFor(store: OpenStoreResult, decisionId: string, workspaceId?: string): AdviceAdherenceRow | undefined {
  if (!isId(decisionId)) return undefined;
  const result = read(store, ({ driver, workspaceId: own }) => {
    const ws = scopeOf(own, workspaceId);
    const row = ws === undefined
      ? driver.prepare('SELECT * FROM advice_adherence WHERE decision_id = ? LIMIT 1').get(decisionId)
      : driver.prepare('SELECT * FROM advice_adherence WHERE workspace_id = ? AND decision_id = ?').get(ws, decisionId);
    if (row === undefined) return undefined;
    const kind = str(field(row, 'advice_kind'));
    const verdict = str(field(row, 'verdict'));
    return {
      decisionId,
      sessionId: str(field(row, 'session_id')) ?? '',
      adviceKind: kind === 'model-change' ? 'model-change' : 'main-route',
      slice: str(field(row, 'slice')) ?? '',
      advisedModel: str(field(row, 'advised_model')) ?? '',
      modelAtAdvice: nullableStr(field(row, 'model_at_advice')),
      verdict: (['open', 'followed', 'overridden', 'no-change', 'unknown'].includes(verdict ?? '') ? verdict : 'unknown') as AdviceVerdict,
      resolvedBy: nullableStr(field(row, 'resolved_by')),
      eventsUntil: num(field(row, 'events_until')) ?? 0,
      advisedAtMs: num(field(row, 'advised_at_ms')) ?? 0,
      resolvedAtMs: nullableNum(field(row, 'resolved_at_ms')),
    } satisfies AdviceAdherenceRow;
  });
  return result !== undefined && !Object.hasOwn(result, 'reason') ? (result as AdviceAdherenceRow) : undefined;
}

/** Verdict counts per advice kind since a time (status). */
export function adviceAdherenceCounts(
  store: OpenStoreResult,
  filter: { readonly sinceMs: number; readonly workspaceId?: string },
): { readonly [kind: string]: { readonly [verdict: string]: number } } {
  const result = read(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, filter.workspaceId);
    const rows = ws === undefined
      ? driver.prepare('SELECT advice_kind, verdict, COUNT(*) AS n FROM advice_adherence WHERE advised_at_ms >= ? GROUP BY advice_kind, verdict').all(filter.sinceMs)
      : driver.prepare('SELECT advice_kind, verdict, COUNT(*) AS n FROM advice_adherence WHERE workspace_id = ? AND advised_at_ms >= ? GROUP BY advice_kind, verdict').all(ws, filter.sinceMs);
    const out: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      const kind = str(field(row, 'advice_kind')) ?? 'other';
      const verdict = str(field(row, 'verdict')) ?? 'unknown';
      (out[kind] ??= {})[verdict] = num(field(row, 'n')) ?? 0;
    }
    return out;
  });
  return result !== null && typeof result === 'object' && !Object.hasOwn(result, 'reason') ? (result as Record<string, Record<string, number>>) : {};
}

/** The session's model changes, oldest first (explain and reports). */
export function sessionModelChanges(store: OpenStoreResult, sessionId: string, workspaceId?: string): readonly { readonly seq: number; readonly atMs: number; readonly fromModel: string | null; readonly toModel: string; readonly source: string }[] {
  if (!isKey(sessionId)) return [];
  const result = read(store, ({ driver, workspaceId: own }) => {
    const ws = scopeOf(own, workspaceId);
    if (ws === undefined) return [];
    return driver
      .prepare('SELECT seq, at_ms, from_model, to_model, source FROM session_model_change WHERE workspace_id = ? AND session_id = ? ORDER BY seq')
      .all(ws, sessionId)
      .map((row) => ({ seq: num(field(row, 'seq')) ?? 0, atMs: num(field(row, 'at_ms')) ?? 0, fromModel: nullableStr(field(row, 'from_model')), toModel: str(field(row, 'to_model')) ?? '', source: str(field(row, 'source')) ?? '' }));
  });
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------- P8 latency counters

export const LATENCY_SCOPES = ['hook', 'sidecar-op', 'subscriber', 'breaker'] as const;
export type LatencyScope = (typeof LATENCY_SCOPES)[number];
const COUNTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const METRIC = /^(?:answered|[A-Z][A-Z0-9_]{0,63})$/;

export interface LatencyCount {
  readonly atMs: number;
  readonly scope: LatencyScope;
  /** A harness id, op name, subscriber name or breaker name. */
  readonly name: string;
  /** `answered`, or a reason code (DEADLINE, HOOK_DEADLINE, LATE_ANSWER, SUBSCRIBER_QUEUED, ...). */
  readonly metric: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export function dayStartMs(atMs: number): number {
  return Math.floor(atMs / DAY_MS) * DAY_MS;
}

function validCount(c: LatencyCount): boolean {
  return (
    isMs(c.atMs) &&
    (LATENCY_SCOPES as readonly string[]).includes(c.scope) &&
    COUNTER_NAME.test(c.name) &&
    METRIC.test(c.metric) &&
    isMs(c.count) &&
    c.count > 0 &&
    isMs(c.totalMs) &&
    isMs(c.maxMs)
  );
}

/** Adds counts to the daily counters in one transaction; invalid entries are dropped. */
export function addLatencyCounts(store: OpenStoreResult, counts: readonly LatencyCount[]): { readonly ok: true; readonly added: number; readonly dropped: number } | StoreRefusal {
  const valid = counts.slice(0, 10_000).filter(validCount);
  const dropped = counts.length - valid.length;
  if (valid.length === 0) return { ok: true, added: 0, dropped };
  return write(store, ({ driver }) => {
    const upsert = driver.prepare(
      `INSERT INTO latency_counter (day_start_ms, scope, name, metric, count, total_ms, max_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day_start_ms, scope, name, metric) DO UPDATE SET
         count = latency_counter.count + excluded.count,
         total_ms = latency_counter.total_ms + excluded.total_ms,
         max_ms = MAX(latency_counter.max_ms, excluded.max_ms)`,
    );
    for (const c of valid) upsert.run(dayStartMs(c.atMs), c.scope, c.name, c.metric, c.count, c.totalMs, c.maxMs);
    return { ok: true as const, added: valid.length, dropped };
  });
}

export interface LatencyCounterRow {
  readonly dayStartMs: number;
  readonly scope: LatencyScope;
  readonly name: string;
  readonly metric: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

/** The daily counters since a day (status, doctor), oldest day first. */
export function latencyCounters(store: OpenStoreResult, filter: { readonly sinceMs: number; readonly scope?: LatencyScope }): readonly LatencyCounterRow[] {
  const result = read(store, ({ driver }) => {
    const since = dayStartMs(Math.max(0, filter.sinceMs));
    const rows = filter.scope === undefined
      ? driver.prepare('SELECT * FROM latency_counter WHERE day_start_ms >= ? ORDER BY day_start_ms, scope, name, metric LIMIT 5000').all(since)
      : driver.prepare('SELECT * FROM latency_counter WHERE day_start_ms >= ? AND scope = ? ORDER BY day_start_ms, name, metric LIMIT 5000').all(since, filter.scope);
    return rows.map((row) => ({
      dayStartMs: num(field(row, 'day_start_ms')) ?? 0,
      scope: (str(field(row, 'scope')) ?? 'hook') as LatencyScope,
      name: str(field(row, 'name')) ?? '',
      metric: str(field(row, 'metric')) ?? '',
      count: num(field(row, 'count')) ?? 0,
      totalMs: num(field(row, 'total_ms')) ?? 0,
      maxMs: num(field(row, 'max_ms')) ?? 0,
    }));
  });
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------- P12 decision feedback

/** contracts' FEEDBACK_REASONS (the store does not depend on contracts; a test pins the two). */
export const DECISION_FEEDBACK_REASONS = ['preference', 'unavailable-context', 'error', 'unspecified'] as const;
export type DecisionFeedbackReason = (typeof DECISION_FEEDBACK_REASONS)[number];

export interface DecisionFeedbackInput {
  readonly workspaceId?: string;
  readonly decisionId: string;
  /** The decision's spec id. */
  readonly kind: string;
  readonly accepted: boolean;
  /** Null when accepted; one of DECISION_FEEDBACK_REASONS when rejected (`unspecified` when none was given). */
  readonly reason: DecisionFeedbackReason | null;
  readonly atMs: number;
}

export interface DecisionFeedbackRow {
  readonly decisionId: string;
  readonly kind: string;
  readonly accepted: boolean;
  readonly reason: DecisionFeedbackReason | null;
  readonly atMs: number;
  readonly revision: number;
}

function isFeedbackReason(value: unknown): value is DecisionFeedbackReason {
  return typeof value === 'string' && (DECISION_FEEDBACK_REASONS as readonly string[]).includes(value);
}

/**
 * Records a person's feedback on a decision (C's `decision.feedback` op, which checks that the
 * decision exists in the workspace). The latest write replaces an earlier one and bumps its
 * revision. A reason on an acceptance, or a rejection without a closed reason, is refused.
 */
export function recordDecisionFeedback(
  store: OpenStoreResult,
  input: DecisionFeedbackInput,
): { readonly ok: true; readonly result: 'recorded' | 'replaced'; readonly revision: number } | StoreRefusal {
  if (!isId(input.decisionId) || !isKey(input.kind) || typeof input.accepted !== 'boolean' || !isMs(input.atMs)) return refuse('invalid-input');
  if (input.accepted ? input.reason !== null : !isFeedbackReason(input.reason)) return refuse('invalid-input');
  if (input.workspaceId !== undefined && !isId(input.workspaceId)) return refuse('invalid-input');
  return write(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, input.workspaceId);
    if (ws === undefined) return refuse('invalid-input');
    const before = num(field(driver.prepare('SELECT revision FROM decision_feedback WHERE workspace_id = ? AND decision_id = ?').get(ws, input.decisionId), 'revision'));
    driver
      .prepare(
        `INSERT INTO decision_feedback (workspace_id, decision_id, kind, accepted, reason, at_ms, revision) VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (workspace_id, decision_id) DO UPDATE SET
           kind = excluded.kind, accepted = excluded.accepted, reason = excluded.reason, at_ms = excluded.at_ms,
           revision = decision_feedback.revision + 1`,
      )
      .run(ws, input.decisionId, input.kind, input.accepted ? 1 : 0, input.accepted ? null : input.reason, input.atMs);
    return before === undefined
      ? { ok: true as const, result: 'recorded' as const, revision: 1 }
      : { ok: true as const, result: 'replaced' as const, revision: before + 1 };
  });
}

/** Feedback rows, newest first (C's feedback report). `limit` defaults to 1000, at most 5000. */
export function readDecisionFeedback(
  store: OpenStoreResult,
  filter: { readonly workspaceId?: string; readonly sinceMs?: number; readonly kind?: string; readonly limit?: number } = {},
): readonly DecisionFeedbackRow[] {
  if (filter.kind !== undefined && !isKey(filter.kind)) return [];
  if (filter.workspaceId !== undefined && !isId(filter.workspaceId)) return [];
  const limit = typeof filter.limit === 'number' && Number.isSafeInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 5000) : 1000;
  const since = isMs(filter.sinceMs) ? filter.sinceMs : 0;
  const result = read(store, ({ driver, workspaceId }) => {
    const ws = scopeOf(workspaceId, filter.workspaceId);
    const where = ['at_ms >= ?'];
    const args: (string | number)[] = [since];
    if (ws !== undefined) {
      where.push('workspace_id = ?');
      args.push(ws);
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    return driver
      .prepare(`SELECT decision_id, kind, accepted, reason, at_ms, revision FROM decision_feedback WHERE ${where.join(' AND ')} ORDER BY at_ms DESC, decision_id LIMIT ${String(limit)}`)
      .all(...args)
      .map((row) => {
        const reason = field(row, 'reason');
        return {
          decisionId: str(field(row, 'decision_id')) ?? '',
          kind: str(field(row, 'kind')) ?? '',
          accepted: num(field(row, 'accepted')) === 1,
          reason: isFeedbackReason(reason) ? reason : null,
          atMs: num(field(row, 'at_ms')) ?? 0,
          revision: num(field(row, 'revision')) ?? 1,
        } satisfies DecisionFeedbackRow;
      });
  });
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------- deletion

/**
 * Removes the learning records: every table, or one workspace's decision outcomes, model changes
 * and advice (the host latency counters go only with every workspace). For `jevris data delete
 * --scope learning` and `jevris route learning reset --clear-evidence`.
 */
export function deleteLearningRecords(store: OpenStoreResult, filter: { readonly workspaceId?: string } = {}): { readonly ok: true; readonly removed: { readonly [table: string]: number } } | StoreRefusal {
  if (filter.workspaceId !== undefined && !isId(filter.workspaceId)) return refuse('invalid-input');
  return write(
    store,
    ({ driver, workspaceId }) => {
      const ws = scopeOf(workspaceId, filter.workspaceId);
      const removed: Record<string, number> = {};
      for (const table of LEARNING_TABLES) {
        if (table === 'latency_counter') {
          removed[table] = ws === undefined ? (num(field(driver.prepare('DELETE FROM latency_counter').run(), 'changes')) ?? 0) : 0;
          continue;
        }
        removed[table] = ws === undefined
          ? (num(field(driver.prepare(`DELETE FROM ${table}`).run(), 'changes')) ?? 0)
          : (num(field(driver.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(ws), 'changes')) ?? 0);
      }
      return { ok: true as const, removed };
    },
    { ignoreAutomationRefusal: true },
  );
}
