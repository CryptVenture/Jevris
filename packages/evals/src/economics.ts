/**
 * Economics (EVL-07..EVL-10, §19.1, §19.4, C53, C55, US32, US33).
 *
 * - Budget envelopes: separate ledgers for decisions, generation, tools, verification, retries
 *   and safe shutdown; a reservation in one never spends another's money, and safe shutdown
 *   keeps its own reserve so a stop can always be paid for.
 * - Rate tracking: requests and tokens per rolling minute; concurrency is allocated from the
 *   quota and expected latency, not only from budget.
 * - Every estimate carries a source and an interval.
 * - Cost report: actual billing or credits, the API-equivalent estimate and the counterfactual
 *   are separate labelled measures; nothing is presented as money saved from a fixed plan.
 * - Billing import: provider exports (Anthropic usage CSV, TypeSafe JSON, generic CSV) are parsed
 *   and reconciled conservatively: unmatched billed usage stays counted, and a disagreement
 *   takes the larger amount.
 * - Price registry: dated rows with source URLs; the §19.1 arithmetic is recomputed from it.
 */
/** The budget ledger surface this module needs (core's DecisionBudget satisfies it). */
export interface EnvelopeLedger {
  reserve(input: { readonly decisionId: string; readonly workspaceId: string; readonly microUsd: number }): Promise<{ readonly ok: boolean }>;
  snapshot(): Promise<{ readonly availableMicroUsd: number } | null>;
}
type DecisionBudget = EnvelopeLedger;

export const ENVELOPES = ['decisions', 'generation', 'tools', 'verification', 'retries', 'safe-shutdown'] as const;
export type Envelope = (typeof ENVELOPES)[number];

export interface Estimate {
  readonly microUsd: number;
  readonly lowerMicroUsd: number;
  readonly upperMicroUsd: number;
  /** Where the number comes from, e.g. `registry:anthropic-2026-09-22` or `provider-usage`. */
  readonly source: string;
}

export function estimate(point: number, lower: number, upper: number, source: string): Estimate {
  if (!(lower <= point && point <= upper) || source.trim().length === 0) throw new Error('ESTIMATE_INVALID');
  return { microUsd: Math.round(point), lowerMicroUsd: Math.round(lower), upperMicroUsd: Math.round(upper), source };
}

/** A set of envelopes, each its own budget ledger. */
export class BudgetEnvelopes {
  readonly #budgets: ReadonlyMap<Envelope, DecisionBudget>;
  constructor(budgets: Readonly<Record<Envelope, DecisionBudget>>) {
    const missing = ENVELOPES.filter((name) => budgets[name] === undefined);
    if (missing.length > 0) throw new Error(`ENVELOPES_MISSING:${missing.join(',')}`);
    const distinct = new Set(ENVELOPES.map((name) => budgets[name]));
    if (distinct.size !== ENVELOPES.length) throw new Error('ENVELOPES_SHARED');
    this.#budgets = new Map(ENVELOPES.map((name) => [name, budgets[name]]));
  }

  envelope(name: Envelope): DecisionBudget {
    return this.#budgets.get(name) as DecisionBudget;
  }

  /** Reserves the estimate's upper bound in one envelope only. */
  async reserve(name: Envelope, input: { readonly id: string; readonly workspaceId: string; readonly estimate: Estimate }) {
    return this.envelope(name).reserve({ decisionId: input.id, workspaceId: input.workspaceId, microUsd: Math.max(1, input.estimate.upperMicroUsd) });
  }

  async available(): Promise<Readonly<Record<Envelope, number | null>>> {
    const out: Partial<Record<Envelope, number | null>> = {};
    for (const name of ENVELOPES) out[name] = (await this.envelope(name).snapshot())?.availableMicroUsd ?? null;
    return out as Record<Envelope, number | null>;
  }
}

/** Requests and tokens per rolling minute, from an injected clock. */
export class RateTracker {
  readonly #events: { at: number; tokens: number }[] = [];
  readonly #now: () => number;
  readonly #windowMs: number;
  constructor(now: () => number, windowMs = 60_000) {
    this.#now = now;
    this.#windowMs = windowMs;
  }
  #trim(): void {
    const floor = this.#now() - this.#windowMs;
    while (this.#events.length > 0 && (this.#events[0] as { at: number }).at <= floor) this.#events.shift();
  }
  record(tokens: number): void {
    this.#events.push({ at: this.#now(), tokens: Math.max(0, tokens) });
    this.#trim();
  }
  rates(): { readonly requestsPerMinute: number; readonly tokensPerMinute: number } {
    this.#trim();
    const scale = 60_000 / this.#windowMs;
    return { requestsPerMinute: this.#events.length * scale, tokensPerMinute: this.#events.reduce((s, e) => s + e.tokens, 0) * scale };
  }
  /** Whether one more request of `tokens` stays within the quota. */
  admits(quota: { readonly requestsPerMinute: number; readonly tokensPerMinute: number }, tokens: number): boolean {
    const now = this.rates();
    return now.requestsPerMinute + 1 <= quota.requestsPerMinute && now.tokensPerMinute + tokens <= quota.tokensPerMinute;
  }
}

/**
 * Concurrency from quota and latency (Little's law): in-flight requests that the per-minute
 * request and token quotas can sustain at the expected latency, capped by `maxConcurrency`.
 */
export function allocateConcurrency(input: { readonly requestsPerMinute: number; readonly tokensPerMinute: number; readonly expectedLatencyMs: number; readonly tokensPerRequest: number; readonly maxConcurrency?: number }): number {
  const perMs = Math.min(input.requestsPerMinute, input.tokensPerMinute / Math.max(1, input.tokensPerRequest)) / 60_000;
  const slots = Math.floor(perMs * Math.max(1, input.expectedLatencyMs));
  return Math.max(0, Math.min(input.maxConcurrency ?? 64, slots));
}

export type Measure<T> = { readonly label: string; readonly value: T; readonly precision: 'provider-reported' | 'billing-export' | 'estimate' | 'hypothetical' | 'unknown' };

export interface CostReport {
  readonly schemaVersion: 'jevris-cost-report-2';
  /** What was actually billed or consumed (subscription credits or API invoice). */
  readonly actual: Measure<number | 'unknown'>;
  /** What the same usage would cost at API list prices; not money saved. */
  readonly apiEquivalent: Measure<number | 'unmeasured'>;
  /** What an unobserved alternative might have cost; never a measured saving. */
  readonly counterfactual: Measure<number | 'hypothetical'>;
  readonly savingMicroUsd: null;
  readonly notes: readonly string[];
}

/** The billingReport shape the store returns (micro-USD as bigint or a label). */
export interface StoreBillingReport {
  readonly subscriptionActual: bigint | 'unknown';
  readonly apiEquivalentEstimate: bigint | 'unmeasured';
  readonly counterfactualHypothetical: bigint | 'hypothetical';
}

function num(value: bigint | string): number | null {
  return typeof value === 'bigint' ? Number(value) : null;
}

/** EVL-08: three separately labelled measures, from the store's billingReport. */
export function buildCostReport(billing: StoreBillingReport, context: { readonly billingMode: 'api' | 'subscription' | 'unknown'; readonly actualSource?: 'provider-reported' | 'billing-export' }): CostReport {
  const actual = num(billing.subscriptionActual);
  const equivalent = num(billing.apiEquivalentEstimate);
  const counterfactual = num(billing.counterfactualHypothetical);
  const notes = ['Actual, API-equivalent and counterfactual are separate measures; none is a saving.'];
  if (context.billingMode === 'subscription') notes.push('On a subscription, an API-equivalent estimate is not money removed from the fixed plan.');
  if (counterfactual !== null) notes.push('The counterfactual is an unobserved alternative and is not a measured result.');
  return {
    schemaVersion: 'jevris-cost-report-2',
    actual: { label: context.billingMode === 'subscription' ? 'subscription credits used' : 'billed cost', value: actual ?? 'unknown', precision: actual === null ? 'unknown' : (context.actualSource ?? 'provider-reported') },
    apiEquivalent: { label: 'API list-price equivalent', value: equivalent ?? 'unmeasured', precision: equivalent === null ? 'unknown' : 'estimate' },
    counterfactual: { label: 'counterfactual (not observed)', value: counterfactual ?? 'hypothetical', precision: 'hypothetical' },
    savingMicroUsd: null,
    notes,
  };
}

export interface BillingLine {
  readonly provider: 'anthropic' | 'typesafe' | 'other';
  readonly day: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  /** A request or decision id when the export carries one. */
  readonly requestId: string | null;
}

function csvRows(text: string): readonly Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((key, i) => (row[key] = (cells[i] ?? '').trim()));
    return row;
  });
}

function money(usd: string): number | null {
  const value = Number(usd.replace(/^\$/, ''));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : null;
}

function count(text: string | undefined): number | null {
  const value = Number(text ?? '');
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export type ImportResult = { readonly ok: true; readonly lines: readonly BillingLine[]; readonly skipped: readonly { readonly line: number; readonly reason: string }[] } | { readonly ok: false; readonly reasonCode: string };

/**
 * EVL-09: parses a billing export. Anthropic: CSV with date, model, input_tokens, output_tokens,
 * cost_usd (and optional request_id). TypeSafe: JSON `{ usage: [{ date, model, input_tokens,
 * output_tokens, cost_usd, request_id? }] }`. Other: CSV with the same columns. A malformed row
 * is skipped and named, never guessed.
 */
export function importBillingExport(provider: BillingLine['provider'], text: string): ImportResult {
  let rows: readonly Record<string, unknown>[];
  if (provider === 'typesafe') {
    try {
      const parsed = JSON.parse(text) as { readonly usage?: unknown };
      if (!Array.isArray(parsed.usage)) return { ok: false, reasonCode: 'NO_USAGE_ARRAY' };
      rows = parsed.usage.map((r) => (r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : {}));
    } catch {
      return { ok: false, reasonCode: 'NOT_JSON' };
    }
  } else {
    rows = csvRows(text);
  }
  const lines: BillingLine[] = [];
  const skipped: { line: number; reason: string }[] = [];
  rows.forEach((row, index) => {
    const day = String(row['date'] ?? row['day'] ?? '');
    const model = String(row['model'] ?? '');
    const input = count(String(row['input_tokens'] ?? ''));
    const output = count(String(row['output_tokens'] ?? ''));
    const cost = money(String(row['cost_usd'] ?? ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return void skipped.push({ line: index + 1, reason: 'INVALID_DATE' });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) return void skipped.push({ line: index + 1, reason: 'INVALID_MODEL' });
    if (input === null || output === null) return void skipped.push({ line: index + 1, reason: 'INVALID_TOKENS' });
    if (cost === null) return void skipped.push({ line: index + 1, reason: 'INVALID_COST' });
    const request = String(row['request_id'] ?? '');
    lines.push({ provider, day, model, inputTokens: input, outputTokens: output, costMicroUsd: cost, requestId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request) ? request : null });
  });
  return { ok: true, lines, skipped };
}

export interface LocalUsage {
  readonly requestId: string | null;
  readonly day: string;
  readonly model: string;
  readonly estimatedMicroUsd: number;
}

export interface Reconciliation {
  readonly matched: number;
  readonly unmatchedBilled: number;
  readonly unmatchedLocal: number;
  /** Conservative total: every billed line counts, and a mismatch takes the larger amount. */
  readonly reconciledMicroUsd: number;
  readonly billedMicroUsd: number;
  readonly estimatedMicroUsd: number;
}

/** Matches by request id, then by day and model; unmatched billing is still counted. */
export function reconcileBilling(billed: readonly BillingLine[], local: readonly LocalUsage[]): Reconciliation {
  const remaining = [...local];
  let matched = 0;
  let total = 0;
  let unmatchedBilled = 0;
  for (const line of billed) {
    let index = line.requestId === null ? -1 : remaining.findIndex((u) => u.requestId === line.requestId);
    if (index < 0) index = remaining.findIndex((u) => u.requestId === null && u.day === line.day && u.model === line.model);
    if (index >= 0) {
      const usage = remaining.splice(index, 1)[0] as LocalUsage;
      matched += 1;
      total += Math.max(line.costMicroUsd, usage.estimatedMicroUsd);
    } else {
      unmatchedBilled += 1;
      total += line.costMicroUsd;
    }
  }
  // Local usage the export does not show yet stays at its estimate (never zero).
  total += remaining.reduce((s, u) => s + u.estimatedMicroUsd, 0);
  return {
    matched,
    unmatchedBilled,
    unmatchedLocal: remaining.length,
    reconciledMicroUsd: total,
    billedMicroUsd: billed.reduce((s, l) => s + l.costMicroUsd, 0),
    estimatedMicroUsd: local.reduce((s, u) => s + u.estimatedMicroUsd, 0),
  };
}

export interface PriceRow {
  readonly vendor: string;
  readonly modelId: string;
  readonly sourceUrl: string;
  readonly fetchedOn: string;
  readonly input: number;
  readonly output: number | null;
  readonly unit: 'USD per million tokens';
  /**
   * The join key to the model registry: the registry `provider` and exact API id. Anthropic rows
   * name the model by its display name (`modelId`, which §19.1 reads), so the API id is separate.
   */
  readonly provider?: string;
  readonly apiModelId?: string;
}

export interface CostRegistryFile {
  readonly schemaVersion: 'cost-registry-1';
  readonly fetchedOn: string;
  readonly prices: readonly PriceRow[];
  readonly [key: string]: unknown;
}

/** EVL-10: validates a price row; every row needs an https source URL and a date. */
export function validatePriceRow(row: unknown): row is PriceRow {
  if (row === null || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r['vendor'] === 'string' &&
    typeof r['modelId'] === 'string' &&
    typeof r['sourceUrl'] === 'string' &&
    /^https:\/\/[A-Za-z0-9.-]+\//.test(r['sourceUrl']) &&
    typeof r['fetchedOn'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r['fetchedOn']) &&
    typeof r['input'] === 'number' &&
    r['input'] >= 0 &&
    (r['output'] === null || (typeof r['output'] === 'number' && r['output'] >= 0)) &&
    r['unit'] === 'USD per million tokens' &&
    // The join key is optional, but when present both halves are exact ids.
    (r['provider'] === undefined) === (r['apiModelId'] === undefined) &&
    (r['provider'] === undefined || (typeof r['provider'] === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(r['provider']))) &&
    (r['apiModelId'] === undefined || (typeof r['apiModelId'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(r['apiModelId'])))
  );
}

/** The price row for a model-registry entry, joined on provider and exact API id. */
export function priceRowFor(registry: CostRegistryFile, provider: string, apiModelId: string): PriceRow | null {
  const rows = registry.prices.filter((row) => row.provider === provider && row.apiModelId === apiModelId);
  return rows.length === 1 ? (rows[0] as PriceRow) : null;
}

/** Applies reviewed price updates (by vendor and model) and dates the registry. */
export function refreshPrices(registry: CostRegistryFile, updates: readonly PriceRow[], fetchedOn: string): CostRegistryFile {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fetchedOn)) throw new Error('PRICE_DATE');
  for (const row of updates) if (!validatePriceRow(row)) throw new Error(`PRICE_ROW_INVALID:${(row as { modelId?: string }).modelId ?? '?'}`);
  const prices = registry.prices.map((row) => updates.find((u) => u.vendor === row.vendor && u.modelId === row.modelId) ?? row);
  for (const update of updates) if (!prices.some((row) => row.vendor === update.vendor && row.modelId === update.modelId)) prices.push(update);
  return { ...registry, fetchedOn, prices };
}

export function priceOf(registry: CostRegistryFile, modelId: string): PriceRow | null {
  return registry.prices.find((row) => row.modelId === modelId) ?? null;
}

/** §19.1: cost of `evaluations` Jev calls of `tokens` input tokens, and input-price ratios. */
export function section191(registry: CostRegistryFile, jevModel = 'jev-1.13.0'): { readonly hundredEvaluationsUsd: number; readonly thousandEvaluationsUsd: number; readonly ratios: Readonly<Record<string, number>> } | null {
  const jev = priceOf(registry, jevModel);
  if (jev === null) return null;
  // Rounded to the micro-dollar: tokens x USD per million tokens / 1e6.
  const cost = (evaluations: number) => Math.round(evaluations * 5_000 * jev.input) / 1_000_000;
  const ratios: Record<string, number> = {};
  for (const name of ['Claude Haiku 4.5', 'Claude Sonnet 5', 'Claude Opus 5.5', 'Claude Opus 5', 'Claude Fable 5.1']) {
    const row = priceOf(registry, name);
    if (row !== null) ratios[name] = Math.round((row.input / jev.input) * 10) / 10;
  }
  return { hundredEvaluationsUsd: cost(100), thousandEvaluationsUsd: cost(1000), ratios };
}
