/**
 * Loads the shipped evaluation inventories (BLD-04: `<package root>/assets/evaluation`, never
 * `fixtures/`) and computes, rather than asserts, their evaluation status (EVL-01).
 *
 * The corpus is labelled only when the file says so and every task row carries a label; the
 * quality gate is `evaluateQualityGate` over the corpus summary and whatever protocol, holdout
 * and measurement the caller supplies. Missing inputs are named reasons, never a pass.
 */
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateQualityGate, type CorpusSummary, type QualityGateInput } from '@jevris/contracts';
import { packageRoot } from '@jevris/platform';

export interface CorpusLoadResult {
  readonly qualityGate: 'passed' | 'not-passed';
  readonly gateReasons: readonly string[];
  readonly labelled: boolean;
  readonly corpus: CorpusSummary;
  /** Observed task outcomes, or null when the file records none. */
  readonly outcomes: readonly unknown[] | null;
  readonly measuredSpeedRatio: number | null;
  readonly measuredCostRatio: number | null;
  readonly modelCount: number;
  readonly costCount: number;
  readonly modelIds: readonly string[];
  readonly costIds: readonly string[];
  readonly labels: readonly unknown[];
  readonly taskOutcomes: readonly unknown[];
}

/** Protocol, holdout manifest and measurement for the gate (the corpus comes from the files). */
export type CorpusGateInputs = Omit<QualityGateInput, 'corpus'>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('refused');
  }
  if (!isPlainObject(parsed)) throw new Error('refused');
  return parsed;
}

function rows(record: Record<string, unknown>, key: string): readonly unknown[] {
  if (!Object.hasOwn(record, key)) throw new Error('refused');
  const value = record[key];
  if (!Array.isArray(value)) throw new Error('refused');
  return value;
}

function rowId(row: unknown, key: string): string {
  if (!isPlainObject(row)) throw new Error('refused');
  if (!Object.hasOwn(row, key)) throw new Error('refused');
  const id = row[key];
  if (typeof id !== 'string' || id.length === 0) throw new Error('refused');
  return id;
}

function ratio(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

const SLICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function loadEvaluationCorpus(root?: string, gate: CorpusGateInputs = {}): Promise<CorpusLoadResult> {
  const base = root === undefined ? packageRoot() : root;
  if (base.length === 0) throw new Error('refused');
  const frontier = parseObject(await readFile(join(base, 'assets', 'evaluation', 'frontier-corpus.json'), 'utf8'));
  const cost = parseObject(await readFile(join(base, 'assets', 'evaluation', 'cost-registry.json'), 'utf8'));
  const models = rows(frontier, 'models');
  const taskClasses = rows(frontier, 'taskClasses');
  const prices = rows(cost, 'prices');
  const modelIds = models.map((row) => rowId(row, 'id'));
  const costIds = prices.map((row) => rowId(row, 'modelId'));
  const labels: unknown[] = [];
  const taskOutcomes: unknown[] = [];
  const sliceCounts: Record<string, number> = {};
  let consentedRows = 0;
  for (const row of taskClasses) {
    if (!isPlainObject(row)) throw new Error('refused');
    labels.push(row['label'] ?? null);
    taskOutcomes.push(row['outcome'] ?? null);
    const slice = row['slice'];
    if (typeof slice === 'string' && SLICE.test(slice)) sliceCounts[slice] = (sliceCounts[slice] ?? 0) + 1;
    if (typeof row['consentId'] === 'string' && row['consentId'].length > 0) consentedRows += 1;
  }
  const everyLabel = labels.length > 0 && labels.every((label) => typeof label === 'string' && label.length > 0);
  const labelled = frontier['labelled'] === true && everyLabel;
  const outcomes = Array.isArray(frontier['outcomes']) ? (frontier['outcomes'] as unknown[]) : null;
  const corpus: CorpusSummary = {
    labelled,
    consented: frontier['consented'] === true && consentedRows === taskClasses.length && taskClasses.length > 0,
    tasks: taskClasses.length,
    sliceCounts,
  };
  const result = evaluateQualityGate({ ...gate, corpus });
  return {
    qualityGate: result.verdict,
    gateReasons: result.reasons,
    labelled,
    corpus,
    outcomes,
    measuredSpeedRatio: ratio(cost['measuredSpeedRatio']),
    measuredCostRatio: ratio(cost['measuredCostRatio']),
    modelCount: modelIds.length,
    costCount: costIds.length,
    modelIds,
    costIds,
    labels,
    taskOutcomes,
  };
}
