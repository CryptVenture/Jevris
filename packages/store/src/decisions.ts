/**
 * The decision ledger in the store (DATA-05, SSOT §17.1 "decision", ADR-04).
 *
 * Decision rows are immutable semantic results: spec and spec version, model, encoder,
 * calibration and policy versions, outcome and reason codes, latency, provider calls and
 * usage. Usage may be filled in once by reconciliation; nothing else changes.
 *
 * Writers: the sidecar is the single store writer (DATA-09). It archives terminal decisions
 * from the decision journal (`archiveJournal`), which every process (CLI, sidecar, hook
 * helpers) writes with one file per decision, and migrates the legacy JSON decision ledger
 * (`importLegacyLedger`), renaming the file so it is retired. Ingest is idempotent by
 * decision id, so no record is lost or doubled however many processes wrote.
 */
import { lstatSync, readFileSync, renameSync } from 'node:fs';
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { field, isId, isMs, nullableNum, nullableStr, num, read, refuse, str, write } from './access.js';
import type { SqlDriver } from './schema.js';
import { readSharedFileSync } from '@jevris/platform';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;
const RECORD_CAP = 131_072;
const PROCESS_ROLES = ['sidecar', 'cli', 'hook', 'mcp', 'migration'] as const;
export type DecisionProcessRole = (typeof PROCESS_ROLES)[number];

export interface DecisionRowInput {
  readonly workspaceId: string;
  readonly decisionId: string;
  readonly taskId: string | null;
  /** The decision spec (question family) id. */
  readonly kind: string;
  readonly specVersion: string;
  /** The resolved model, or `rules` for a rules-only decision. */
  readonly model: string;
  readonly encoderVersion: string;
  readonly calibrationVersion: string;
  readonly policyVersion: string;
  readonly state: string;
  readonly outcome: string;
  readonly reasonCodes: readonly string[];
  readonly latencyMs: number;
  readonly providerCalls: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly reservedMicroUsd: number;
  readonly costMicroUsd: number | null;
  readonly billingBasis: string;
  readonly processRole: DecisionProcessRole;
  readonly source: 'journal' | 'legacy-ledger' | 'direct';
  /** The full redacted record (the §23.4 DecisionRecord). */
  readonly record: unknown;
  readonly createdAtMs: number;
}

export interface DecisionRow extends Omit<DecisionRowInput, 'record'> {
  readonly record: unknown;
}

const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

function validRow(input: DecisionRowInput): string | undefined {
  if (!isId(input.workspaceId) || !isId(input.decisionId) || (input.taskId !== null && !isId(input.taskId))) return undefined;
  for (const label of [input.kind, input.specVersion, input.model, input.encoderVersion, input.calibrationVersion, input.policyVersion, input.state, input.outcome, input.billingBasis]) {
    if (typeof label !== 'string' || !LABEL.test(label)) return undefined;
  }
  if (!Array.isArray(input.reasonCodes) || input.reasonCodes.length === 0 || input.reasonCodes.length > 32 || !input.reasonCodes.every((c) => typeof c === 'string' && REASON.test(c))) return undefined;
  if (!isMs(input.latencyMs) || !isMs(input.providerCalls) || !isMs(input.reservedMicroUsd) || !isMs(input.createdAtMs)) return undefined;
  if (input.costMicroUsd !== null && !isMs(input.costMicroUsd)) return undefined;
  if (input.usage !== null && (!isMs(input.usage.inputTokens) || !isMs(input.usage.outputTokens))) return undefined;
  if (!(PROCESS_ROLES as readonly string[]).includes(input.processRole) || !['journal', 'legacy-ledger', 'direct'].includes(input.source)) return undefined;
  if (input.record === null || typeof input.record !== 'object') return undefined;
  const text = JSON.stringify(input.record);
  return new TextEncoder().encode(text).length <= RECORD_CAP ? text : undefined;
}

function insertRow(driver: SqlDriver, input: DecisionRowInput, recordText: string): 'inserted' | 'duplicate' | 'usage-filled' {
  const existing = driver.prepare('SELECT usage_known, cost_micro_usd FROM decision_record WHERE workspace_id = ? AND decision_id = ?').get(input.workspaceId, input.decisionId);
  if (existing !== undefined) {
    // A later archive of the same decision may carry reconciled usage: fill it in once.
    const known = num(field(existing, 'usage_known')) === 1 && field(existing, 'cost_micro_usd') !== null;
    if (!known && input.usage !== null && input.costMicroUsd !== null) {
      driver
        .prepare('UPDATE decision_record SET usage_known = 1, input_tokens = ?, output_tokens = ?, cost_micro_usd = ?, billing_basis = ? WHERE workspace_id = ? AND decision_id = ?')
        .run(input.usage.inputTokens, input.usage.outputTokens, input.costMicroUsd, input.billingBasis, input.workspaceId, input.decisionId);
      return 'usage-filled';
    }
    return 'duplicate';
  }
  driver
    .prepare(
      `INSERT INTO decision_record (workspace_id, decision_id, task_id, kind, spec_version, model, encoder_version, calibration_version, policy_version,
        state, outcome, reason_codes, latency_ms, provider_calls, usage_known, input_tokens, output_tokens, reserved_micro_usd, cost_micro_usd,
        billing_basis, process_role, source, record, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.workspaceId,
      input.decisionId,
      input.taskId,
      input.kind,
      input.specVersion,
      input.model,
      input.encoderVersion,
      input.calibrationVersion,
      input.policyVersion,
      input.state,
      input.outcome,
      JSON.stringify(input.reasonCodes),
      input.latencyMs,
      input.providerCalls,
      input.usage !== null ? 1 : 0,
      input.usage?.inputTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.reservedMicroUsd,
      input.costMicroUsd,
      input.billingBasis,
      input.processRole,
      input.source,
      recordText,
      input.createdAtMs,
    );
  return 'inserted';
}

/** Records one decision (idempotent by id; usage fills in once). */
export function recordDecisionRow(store: OpenStoreResult, input: DecisionRowInput): { readonly ok: true; readonly result: 'inserted' | 'duplicate' | 'usage-filled' } | StoreRefusal {
  const recordText = validRow(input);
  if (recordText === undefined) return refuse('invalid-input');
  if (store.ok && store.workspaceId !== 'host' && store.workspaceId !== input.workspaceId) return refuse('invalid-input');
  return write(store, ({ driver }) => ({ ok: true as const, result: insertRow(driver, input, recordText) }));
}

function decisionRow(row: unknown): DecisionRow | undefined {
  const decisionId = str(field(row, 'decision_id'));
  if (decisionId === undefined) return undefined;
  const parse = (text: unknown): unknown => {
    try {
      return JSON.parse(typeof text === 'string' ? text : 'null');
    } catch {
      return null;
    }
  };
  const reasonCodes = parse(field(row, 'reason_codes'));
  const known = num(field(row, 'usage_known')) === 1;
  const role = str(field(row, 'process_role')) ?? 'sidecar';
  const source = str(field(row, 'source')) ?? 'direct';
  return {
    workspaceId: str(field(row, 'workspace_id')) ?? '',
    decisionId,
    taskId: nullableStr(field(row, 'task_id')),
    kind: str(field(row, 'kind')) ?? '',
    specVersion: str(field(row, 'spec_version')) ?? '',
    model: str(field(row, 'model')) ?? '',
    encoderVersion: str(field(row, 'encoder_version')) ?? '',
    calibrationVersion: str(field(row, 'calibration_version')) ?? '',
    policyVersion: str(field(row, 'policy_version')) ?? '',
    state: str(field(row, 'state')) ?? '',
    outcome: str(field(row, 'outcome')) ?? '',
    reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.filter((c): c is string => typeof c === 'string') : [],
    latencyMs: num(field(row, 'latency_ms')) ?? 0,
    providerCalls: num(field(row, 'provider_calls')) ?? 0,
    usage: known ? { inputTokens: num(field(row, 'input_tokens')) ?? 0, outputTokens: num(field(row, 'output_tokens')) ?? 0 } : null,
    reservedMicroUsd: num(field(row, 'reserved_micro_usd')) ?? 0,
    costMicroUsd: nullableNum(field(row, 'cost_micro_usd')),
    billingBasis: str(field(row, 'billing_basis')) ?? '',
    processRole: ((PROCESS_ROLES as readonly string[]).includes(role) ? role : 'sidecar') as DecisionProcessRole,
    source: (['journal', 'legacy-ledger', 'direct'].includes(source) ? source : 'direct') as DecisionRow['source'],
    record: parse(field(row, 'record')),
    createdAtMs: num(field(row, 'created_at_ms')) ?? 0,
  };
}

export function readDecisionRows(store: OpenStoreResult, filter: { readonly workspaceId?: string; readonly sinceMs?: number; readonly limit?: number } = {}): readonly DecisionRow[] {
  const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 10_000);
  const result = read(store, ({ driver, workspaceId }) => {
    const ws = workspaceId === 'host' ? filter.workspaceId : workspaceId;
    const rows = ws === undefined
      ? driver.prepare('SELECT * FROM decision_record WHERE created_at_ms >= ? ORDER BY created_at_ms, decision_id LIMIT ?').all(filter.sinceMs ?? 0, limit)
      : driver.prepare('SELECT * FROM decision_record WHERE workspace_id = ? AND created_at_ms >= ? ORDER BY created_at_ms, decision_id LIMIT ?').all(ws, filter.sinceMs ?? 0, limit);
    return rows.map(decisionRow).filter((r): r is DecisionRow => r !== undefined);
  });
  return Array.isArray(result) ? result : [];
}

/** One decision's summary for status and health: no record column. */
export interface DecisionSummary {
  readonly decisionId: string;
  readonly outcome: string;
  readonly reasonCodes: readonly string[];
  readonly model: string;
  readonly createdAtMs: number;
}

/**
 * The newest decisions since a time, newest first (audit K5): status and the provider-down health
 * line. It reads only the columns they show, never the record, and at most 20 rows.
 */
export function recentDecisionSummaries(store: OpenStoreResult, filter: { readonly workspaceId?: string; readonly sinceMs?: number; readonly limit?: number } = {}): readonly DecisionSummary[] {
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 5), 1), 20);
  const result = read(store, ({ driver, workspaceId }) => {
    const ws = workspaceId === 'host' ? filter.workspaceId : workspaceId;
    const columns = 'decision_id, outcome, reason_codes, model, created_at_ms';
    const rows = ws === undefined
      ? driver.prepare(`SELECT ${columns} FROM decision_record WHERE created_at_ms >= ? ORDER BY created_at_ms DESC, decision_id DESC LIMIT ?`).all(filter.sinceMs ?? 0, limit)
      : driver.prepare(`SELECT ${columns} FROM decision_record WHERE workspace_id = ? AND created_at_ms >= ? ORDER BY created_at_ms DESC, decision_id DESC LIMIT ?`).all(ws, filter.sinceMs ?? 0, limit);
    const out: DecisionSummary[] = [];
    for (const row of rows) {
      const decisionId = str(field(row, 'decision_id'));
      if (decisionId === undefined) continue;
      let codes: unknown = [];
      try {
        codes = JSON.parse(str(field(row, 'reason_codes')) ?? '[]');
      } catch {
        codes = [];
      }
      out.push({
        decisionId,
        outcome: str(field(row, 'outcome')) ?? '',
        reasonCodes: Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string') : [],
        model: str(field(row, 'model')) ?? '',
        createdAtMs: num(field(row, 'created_at_ms')) ?? 0,
      });
    }
    return out;
  });
  return Array.isArray(result) ? result : [];
}

export function countDecisionRows(store: OpenStoreResult): number {
  const result = read(store, ({ driver, workspaceId }) =>
    num(field(workspaceId === 'host' ? driver.prepare('SELECT COUNT(*) AS n FROM decision_record').get() : driver.prepare('SELECT COUNT(*) AS n FROM decision_record WHERE workspace_id = ?').get(workspaceId), 'n')) ?? 0,
  );
  return typeof result === 'number' ? result : 0;
}

// ---------------------------------------------------------------- counters (OBS-02)

/** Latency percentiles over a set of decisions, in milliseconds. */
export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/**
 * The SSOT §17.5 decision counters over a window: decision count, outcomes, abstentions, rules
 * bypass (no provider call), fallbacks (Jev was called but local rules answered), stale
 * decisions, retries, latency, tokens and cost (reserved, actual, and how many are unknown).
 * Every label is a bounded code from the row, never task content.
 */
export interface DecisionCounters {
  readonly sinceMs: number;
  readonly decisions: number;
  readonly outcomes: { readonly [outcome: string]: number };
  readonly abstentions: number;
  readonly rulesOnly: number;
  readonly semantic: number;
  readonly fallbacks: number;
  readonly stale: number;
  readonly retries: number;
  readonly latencyMs: { readonly rules: LatencySummary | null; readonly semantic: LatencySummary | null };
  readonly tokens: { readonly input: number; readonly output: number; readonly usageUnknown: number };
  readonly costMicroUsd: { readonly reserved: number; readonly actual: number; readonly actualUnknown: number };
  readonly models: { readonly [model: string]: number };
  readonly reasonCodes: { readonly [reasonCode: string]: number };
  /** More rows than COUNTER_ROWS_MAX fell in the window; the newest were counted. */
  readonly truncated: boolean;
}

const COUNTER_ROWS_MAX = 50_000;
const COUNTER_OUTCOMES = new Set(['applied', 'advisory', 'refused', 'stale', 'abstained', 'quarantined']);

function summarize(values: number[]): LatencySummary | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const at = (q: number): number => values[Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1))] as number;
  return { count: values.length, p50: at(0.5), p95: at(0.95), max: values[values.length - 1] as number };
}

function topCounts(counts: Map<string, number>, limit: number): { readonly [key: string]: number } {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const out: Record<string, number> = {};
  let other = 0;
  sorted.forEach(([key, n], index) => {
    if (index < limit) out[key] = n;
    else other += n;
  });
  if (other > 0) out['OTHER'] = (out['OTHER'] ?? 0) + other;
  return out;
}

export function decisionCounters(store: OpenStoreResult, filter: { readonly sinceMs: number; readonly workspaceId?: string }): DecisionCounters | StoreRefusal {
  return read(store, ({ driver, workspaceId }) => {
    const ws = workspaceId === 'host' ? filter.workspaceId : workspaceId;
    const columns = 'outcome, model, provider_calls, latency_ms, usage_known, input_tokens, output_tokens, reserved_micro_usd, cost_micro_usd, reason_codes';
    const rows = ws === undefined
      ? driver.prepare(`SELECT ${columns} FROM decision_record WHERE created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT ?`).all(filter.sinceMs, COUNTER_ROWS_MAX + 1)
      : driver.prepare(`SELECT ${columns} FROM decision_record WHERE workspace_id = ? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT ?`).all(ws, filter.sinceMs, COUNTER_ROWS_MAX + 1);
    const truncated = rows.length > COUNTER_ROWS_MAX;
    const outcomes = new Map<string, number>();
    const models = new Map<string, number>();
    const reasons = new Map<string, number>();
    const rulesLatency: number[] = [];
    const semanticLatency: number[] = [];
    let abstentions = 0;
    let rulesOnly = 0;
    let fallbacks = 0;
    let stale = 0;
    let retries = 0;
    let input = 0;
    let output = 0;
    let usageUnknown = 0;
    let reserved = 0;
    let actual = 0;
    let actualUnknown = 0;
    for (const row of rows.slice(0, COUNTER_ROWS_MAX)) {
      const rawOutcome = str(field(row, 'outcome')) ?? 'other';
      const outcome = COUNTER_OUTCOMES.has(rawOutcome) ? rawOutcome : 'other';
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      const calls = num(field(row, 'provider_calls')) ?? 0;
      const latency = num(field(row, 'latency_ms')) ?? 0;
      if (outcome === 'abstained') abstentions += 1;
      if (outcome === 'stale') stale += 1;
      if (calls === 0) {
        rulesOnly += 1;
        rulesLatency.push(latency);
      } else {
        semanticLatency.push(latency);
        retries += calls - 1;
        if (outcome !== 'applied' && outcome !== 'advisory') fallbacks += 1;
      }
      const rawModel = str(field(row, 'model')) ?? 'unknown';
      const model = LABEL.test(rawModel) ? rawModel : 'unknown';
      models.set(model, (models.get(model) ?? 0) + 1);
      if (num(field(row, 'usage_known')) === 1) {
        input += num(field(row, 'input_tokens')) ?? 0;
        output += num(field(row, 'output_tokens')) ?? 0;
      } else {
        usageUnknown += 1;
      }
      reserved += num(field(row, 'reserved_micro_usd')) ?? 0;
      const cost = nullableNum(field(row, 'cost_micro_usd'));
      if (cost === null) actualUnknown += 1;
      else actual += cost;
      let codes: unknown;
      try {
        codes = JSON.parse(str(field(row, 'reason_codes')) ?? '[]');
      } catch {
        codes = [];
      }
      for (const code of Array.isArray(codes) ? codes.slice(0, 32) : []) {
        const key = typeof code === 'string' && REASON.test(code) ? code : 'OTHER';
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
    }
    const counted = Math.min(rows.length, COUNTER_ROWS_MAX);
    return {
      sinceMs: filter.sinceMs,
      decisions: counted,
      outcomes: Object.fromEntries(outcomes),
      abstentions,
      rulesOnly,
      semantic: counted - rulesOnly,
      fallbacks,
      stale,
      retries,
      latencyMs: { rules: summarize(rulesLatency), semantic: summarize(semanticLatency) },
      tokens: { input, output, usageUnknown },
      costMicroUsd: { reserved, actual, actualUnknown },
      models: topCounts(models, 16),
      reasonCodes: topCounts(reasons, 32),
      truncated,
    };
  });
}

/** The status line's day tally (P9): four sums and the last row it counted. */
export interface DecisionTally {
  readonly decisions: number;
  readonly abstentions: number;
  readonly fallbacks: number;
  readonly costMicroUsd: number;
  /** The highest decision_record rowid counted, for the next increment. */
  readonly lastRowid: number;
}

/**
 * The status line's counts for decisions created since `sinceMs` (sidecar concurrency audit P9),
 * summed in SQL, and only over rows after `afterRowid`, so the sidecar adds each new row once
 * instead of reading the whole day each second. The same rules as decisionCounters: an
 * abstention is outcome `abstained`; a fallback is a provider call whose outcome is neither
 * applied nor advisory; cost sums the known actual costs.
 */
export function decisionTally(store: OpenStoreResult, filter: { readonly sinceMs: number; readonly afterRowid?: number }): DecisionTally | StoreRefusal {
  const after = typeof filter.afterRowid === 'number' && Number.isSafeInteger(filter.afterRowid) && filter.afterRowid > 0 ? filter.afterRowid : 0;
  return read(store, ({ driver }) => {
    const row = driver
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN outcome = 'abstained' THEN 1 ELSE 0 END), 0) AS abstentions,
                COALESCE(SUM(CASE WHEN provider_calls > 0 AND outcome NOT IN ('applied', 'advisory') THEN 1 ELSE 0 END), 0) AS fallbacks,
                COALESCE(SUM(cost_micro_usd), 0) AS cost,
                COALESCE(MAX(rowid), 0) AS last
           FROM decision_record WHERE created_at_ms >= ? AND rowid > ?`,
      )
      .get(filter.sinceMs, after);
    const last = num(field(row, 'last')) ?? 0;
    return {
      decisions: num(field(row, 'n')) ?? 0,
      abstentions: num(field(row, 'abstentions')) ?? 0,
      fallbacks: num(field(row, 'fallbacks')) ?? 0,
      costMicroUsd: num(field(row, 'cost')) ?? 0,
      lastRowid: Math.max(last, after),
    };
  });
}

// ---------------------------------------------------------------- journal archive

/** The slice of C's DecisionJournal the archiver reads (structural, no core import). */
export interface JournalSource {
  list(): Promise<readonly string[]>;
  read(decisionId: string): Promise<JournalEntryLike | null>;
}

export interface JournalEntryLike {
  readonly decisionId: string;
  readonly state: string;
  readonly history: readonly { readonly state: string; readonly atMs: number }[];
  readonly draft: { readonly specVersion?: string; readonly packetHash?: string | null; readonly workspaceId?: string; readonly taskId?: string | null };
  readonly record: { readonly [key: string]: unknown } | null;
}

const TERMINAL = new Set(['applied', 'refused', 'stale', 'abstained', 'quarantined', 'reconciled', 'planned']);

/** Maps a terminal journal entry's §23.4 record to a store row. */
export function rowFromJournal(entry: JournalEntryLike, processRole: DecisionProcessRole): DecisionRowInput | undefined {
  const record = entry.record;
  if (record === null || !TERMINAL.has(entry.state)) return undefined;
  const get = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
  const nested = (obj: unknown, key: string): unknown => (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined);
  const usage = get('usage');
  const cost = get('cost');
  const calibration = get('calibration');
  const reasonCodes = get('reasonCodes');
  const first = entry.history[0]?.atMs ?? 0;
  const last = entry.history[entry.history.length - 1]?.atMs ?? first;
  const inputTokens = nested(usage, 'inputTokens');
  const outputTokens = nested(usage, 'outputTokens');
  const actual = nested(cost, 'actualMicroUsd');
  const reserved = nested(cost, 'reservedMicroUsd');
  const durationMs = get('durationMs');
  return {
    workspaceId: typeof get('workspaceId') === 'string' ? (get('workspaceId') as string) : (entry.draft.workspaceId ?? 'host'),
    decisionId: entry.decisionId,
    taskId: typeof get('taskId') === 'string' ? (get('taskId') as string) : (entry.draft.taskId ?? null),
    kind: typeof get('specId') === 'string' ? (get('specId') as string) : 'unknown',
    specVersion: typeof get('specVersion') === 'string' ? (get('specVersion') as string) : (entry.draft.specVersion ?? 'unknown'),
    model: typeof get('modelResolved') === 'string' ? (get('modelResolved') as string) : 'rules',
    encoderVersion: entry.draft.packetHash !== null && entry.draft.packetHash !== undefined ? 'packet-1' : 'none',
    calibrationVersion: typeof nested(calibration, 'version') === 'string' ? (nested(calibration, 'version') as string) : 'none',
    policyVersion: typeof get('policyVersion') === 'string' ? (get('policyVersion') as string) : 'unknown',
    state: entry.state,
    outcome: typeof get('outcome') === 'string' ? (get('outcome') as string) : 'abstained',
    reasonCodes: Array.isArray(reasonCodes) && reasonCodes.length > 0 ? (reasonCodes as string[]) : ['UNKNOWN'],
    latencyMs: typeof durationMs === 'number' ? durationMs : Math.max(0, last - first),
    providerCalls: typeof get('providerCalls') === 'number' ? (get('providerCalls') as number) : 0,
    usage: typeof inputTokens === 'number' && typeof outputTokens === 'number' ? { inputTokens, outputTokens } : null,
    reservedMicroUsd: typeof reserved === 'number' ? reserved : 0,
    costMicroUsd: typeof actual === 'number' ? actual : null,
    billingBasis: typeof get('billingBasis') === 'string' ? (get('billingBasis') as string) : 'unknown',
    processRole,
    source: 'journal',
    record,
    createdAtMs: first,
  };
}

/**
 * Archives every terminal journal entry into the store. Idempotent: a re-run inserts
 * nothing new and only fills usage that reconciliation added since.
 */
/**
 * Audit K4 (with C 89c9420): the archive never brings back a row the retention sweep removed. An
 * entry created before `notBeforeMs` (the sweep's cutoff, now - decisionRetentionDays) is past
 * the watermark and is skipped as `expired`; C's journal prune removes it from the journal on the
 * same cutoff. The created time is the row's created_at_ms, which is C's journalEntryCreatedAtMs.
 */
export interface ArchiveOptions {
  readonly notBeforeMs?: number;
}

function pastWatermark(row: DecisionRowInput, options: ArchiveOptions): boolean {
  return typeof options.notBeforeMs === 'number' && Number.isFinite(options.notBeforeMs) && row.createdAtMs < options.notBeforeMs;
}

export async function archiveJournal(
  store: OpenStoreResult,
  journal: JournalSource,
  processRole: DecisionProcessRole = 'sidecar',
  options: ArchiveOptions = {},
): Promise<{ readonly ok: true; readonly inserted: number; readonly duplicate: number; readonly usageFilled: number; readonly skipped: number; readonly expired: number } | StoreRefusal> {
  let inserted = 0;
  let duplicate = 0;
  let usageFilled = 0;
  let skipped = 0;
  let expired = 0;
  for (const id of await journal.list()) {
    const entry = await journal.read(id);
    const row = entry === null ? undefined : rowFromJournal(entry, processRole);
    if (row === undefined) {
      skipped += 1;
      continue;
    }
    if (pastWatermark(row, options)) {
      expired += 1;
      continue;
    }
    const result = recordDecisionRow(store, row);
    if (!result.ok) {
      if (result.reason === 'invalid-input') {
        skipped += 1;
        continue;
      }
      return result;
    }
    if (result.result === 'inserted') inserted += 1;
    else if (result.result === 'usage-filled') usageFilled += 1;
    else duplicate += 1;
  }
  return { ok: true, inserted, duplicate, usageFilled, skipped, expired };
}

/**
 * Archives one journal entry as soon as it is terminal (the sidecar calls this after each
 * engine action, so `status` lists a decision without waiting for the periodic archive).
 * Idempotent like archiveJournal; an entry that is missing or not terminal writes nothing.
 */
export async function archiveJournalEntry(
  store: OpenStoreResult,
  journal: JournalSource,
  decisionId: string,
  processRole: DecisionProcessRole = 'sidecar',
  options: ArchiveOptions = {},
): Promise<{ readonly ok: true; readonly result: 'inserted' | 'duplicate' | 'usage-filled' | 'not-terminal' | 'missing' | 'expired' } | StoreRefusal> {
  const entry = await journal.read(decisionId);
  if (entry === null) return { ok: true, result: 'missing' };
  const row = rowFromJournal(entry, processRole);
  if (row === undefined) return { ok: true, result: 'not-terminal' };
  if (pastWatermark(row, options)) return { ok: true, result: 'expired' };
  const result = recordDecisionRow(store, row);
  return result.ok ? { ok: true, result: result.result } : result;
}

// ---------------------------------------------------------------- legacy JSON ledger

const LEGACY_CAP = 8 * 1024 * 1024;

/**
 * Migrates a v1 JSON decision ledger (`{ schemaVersion: '1.0', records: [...] }`) into the
 * store and retires the file by renaming it `<file>.migrated`. A file that is not a ledger
 * is left alone. Returns the number of rows written.
 */
export function importLegacyLedger(
  store: OpenStoreResult,
  file: string,
  input: { readonly workspaceId: string; readonly nowMs: number },
): { readonly ok: true; readonly imported: number; readonly retiredTo: string | null } | StoreRefusal {
  if (!isId(input.workspaceId) || !isMs(input.nowMs)) return refuse('invalid-input');
  let text: string;
  try {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined) return { ok: true, imported: 0, retiredTo: null };
    if (!st.isFile()) return refuse('path-refused');
    text = readSharedFileSync(file, 'utf8');
  } catch {
    return refuse('store-unavailable');
  }
  if (text.length > LEGACY_CAP) return refuse('oversize');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('invalid-input');
  }
  const records = parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'records') : undefined;
  if (Reflect.get(parsed as object, 'schemaVersion') !== '1.0' || !Array.isArray(records)) return refuse('invalid-input');
  const rows: DecisionRowInput[] = [];
  for (const raw of records) {
    if (raw === null || typeof raw !== 'object') continue;
    const get = (key: string): unknown => (Object.hasOwn(raw, key) ? (raw as Record<string, unknown>)[key] : undefined);
    const decisionId = get('decisionId');
    if (!isId(decisionId)) continue;
    const usage = get('usage');
    const inputTokens = usage !== null && typeof usage === 'object' ? Reflect.get(usage, 'inputTokens') : undefined;
    const outputTokens = usage !== null && typeof usage === 'object' ? Reflect.get(usage, 'outputTokens') : undefined;
    const reservation = get('reservationMicroUsd');
    const reserved = typeof reservation === 'string' && /^\d{1,15}$/.test(reservation) ? Number(reservation) : typeof reservation === 'number' ? reservation : 0;
    const reasonCode = get('reasonCode');
    const model = get('resolvedModel');
    const policy = get('policyVersion');
    const outcome = get('outcome');
    rows.push({
      workspaceId: input.workspaceId,
      decisionId,
      taskId: null,
      kind: 'legacy-choice',
      specVersion: 'legacy-1',
      model: typeof model === 'string' && LABEL.test(model) ? model : 'rules',
      encoderVersion: 'none',
      calibrationVersion: 'none',
      policyVersion: typeof policy === 'string' && LABEL.test(policy) ? policy : 'unknown',
      state: 'refused',
      outcome: typeof outcome === 'string' && LABEL.test(outcome) ? outcome : 'advisory',
      reasonCodes: [typeof reasonCode === 'string' && REASON.test(reasonCode) ? reasonCode : 'UNKNOWN'],
      latencyMs: 0,
      providerCalls: 0,
      usage: typeof inputTokens === 'number' && typeof outputTokens === 'number' ? { inputTokens, outputTokens } : null,
      reservedMicroUsd: Number.isSafeInteger(reserved) && reserved >= 0 ? reserved : 0,
      costMicroUsd: null,
      billingBasis: 'unknown',
      processRole: 'migration',
      source: 'legacy-ledger',
      record: raw,
      createdAtMs: input.nowMs,
    });
  }
  const written = write(store, ({ driver }) => {
    let imported = 0;
    for (const row of rows) {
      const recordText = validRow(row);
      if (recordText === undefined) continue;
      if (insertRow(driver, row, recordText) === 'inserted') imported += 1;
    }
    return imported;
  });
  if (typeof written !== 'number') return written;
  const retiredTo = `${file}.migrated`;
  try {
    renameSync(file, retiredTo);
  } catch {
    return { ok: true, imported: written, retiredTo: null };
  }
  return { ok: true, imported: written, retiredTo };
}
