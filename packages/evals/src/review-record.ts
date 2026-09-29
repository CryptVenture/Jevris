import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateQualityGate, type QualityGateInput } from '@jevris/contracts';

/**
 * Review-only P4 records. The holdout id and the quality gate are computed from the supplied
 * evaluation inputs (EVL-01), never written as literals; with no inputs the gate is not a pass.
 * A passing gate does not change a record's status: these capabilities stay unsupported until
 * their own evidence exists. This module does not import a store writer, the TypeSafe client,
 * or a process library. It does not train, fine-tune, or actuate.
 */

const WIN_TOKEN = 'beats-rules';
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const REVIEW_IDS = [
  'CAP-24',
  'CAP-32',
  'CAP-40',
  'CAP-62',
  'CAP-65',
  'CAP-66',
  'CAP-67',
  'CAP-68',
  'CAP-69',
  'CAP-70',
  'CAP-71',
  'EPC-35',
  'EPC-36',
] as const;

export type ReviewId = (typeof REVIEW_IDS)[number];

export interface ReviewRecord {
  readonly schemaVersion: 'p4-1';
  readonly id: ReviewId;
  readonly requirementId: ReviewId;
  readonly status: 'unsupported';
  readonly applied: false;
  readonly trainer: false;
  readonly holdoutId: string | null;
  readonly qualityGate: 'passed' | 'not-passed';
  readonly waivesLock: false;
  readonly waivesReceipt: false;
  readonly waivesQualityFloor: false;
  readonly actuates: false;
  readonly detail: string;
}

function detailFor(id: ReviewId): string {
  if (id === 'CAP-24') {
    return 'Long-horizon project memory is unsupported. This record does not keep unverified agent claims and does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-32') {
    return 'Native workflow or team advice is unsupported. No workflow is recommended. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-40') {
    return 'Visual-work evidence is unsupported. Textual ranking is not an image assertion. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-62') {
    return 'Release risk summary is unsupported. Deployment and rollback authority stay separate. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-65') {
    return 'Portfolio compute allocation is unsupported. No discretionary allocation is applied. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-66') {
    return 'Task-specific learned router is unsupported. trainer is false. No fine-tune runs and this record is not loaded into production. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-67') {
    return 'Automatic question improvement is unsupported. Live policy is not self-modified. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-68') {
    return 'Speculative evaluation is unsupported. No worker is launched and no external effect is applied. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-69') {
    return 'Cross-model disagreement triage is unsupported. Agreement is not independent proof. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-70') {
    return 'Project-wide change campaign is unsupported. No wave is scheduled. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'CAP-71') {
    return 'Autonomous policy-evaluation laboratory is unsupported. This record is not a calibration release and is not training data. This record does not waive a lock, a receipt, or a quality floor.';
  }
  if (id === 'EPC-35') {
    return 'Native workflow and team bridge is unsupported. npm and network access were not treated as a bridge. This record does not waive a lock, a receipt, or a quality floor.';
  }
  return 'Offline routing research is unsupported. A quality result comes only from the computed gate over a released holdout, never from this record. trainer is false. This record does not actuate. This record does not waive a lock, a receipt, or a quality floor.';
}

function recordFor(id: ReviewId, gate: { readonly holdoutId: string | null; readonly verdict: 'passed' | 'not-passed' }): ReviewRecord {
  return {
    schemaVersion: 'p4-1',
    id,
    requirementId: id,
    status: 'unsupported',
    applied: false,
    trainer: false,
    holdoutId: gate.holdoutId,
    qualityGate: gate.verdict,
    waivesLock: false,
    waivesReceipt: false,
    waivesQualityFloor: false,
    actuates: false,
    detail: detailFor(id),
  };
}

export function buildReviewSet(gate: QualityGateInput = {}): readonly ReviewRecord[] {
  const result = evaluateQualityGate(gate);
  return REVIEW_IDS.map((id) => recordFor(id, result));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasDangerousKey(value: object): boolean {
  if (
    Object.hasOwn(value, '__proto__') ||
    Object.hasOwn(value, 'prototype') ||
    Object.hasOwn(value, 'constructor')
  ) {
    return true;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key) || key === WIN_TOKEN) return true;
    const child = (value as Record<string, unknown>)[key];
    if (typeof child === 'object' && child !== null && hasDangerousKey(child)) return true;
  }
  return false;
}

function containsWin(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(WIN_TOKEN);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsWin(item)) return true;
    }
    return false;
  }
  if (typeof value !== 'object' || value === null) return false;
  for (const key of Object.keys(value)) {
    if (key.includes(WIN_TOKEN)) return true;
    if (containsWin((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

function hasForbiddenFlag(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasForbiddenFlag(item)) return true;
    }
    return false;
  }
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['trainer'] === true) return true;
  if (record['applied'] === true) return true;
  if (record['qualityGate'] === 'passed') return true;
  if (record['waivesLock'] === true) return true;
  if (record['waivesReceipt'] === true) return true;
  if (record['waivesQualityFloor'] === true) return true;
  if (record['actuates'] === true) return true;
  if (record['passed'] === true || Object.hasOwn(record, 'passed')) return true;
  for (const key of Object.keys(record)) {
    if (hasForbiddenFlag(record[key])) return true;
  }
  return false;
}

export function acceptReviewClaim(claim: unknown): 'accepted' | 'refused' {
  if (!isPlainObject(claim)) return 'refused';
  if (hasDangerousKey(claim) || containsWin(claim) || hasForbiddenFlag(claim)) return 'refused';
  return 'accepted';
}

export async function writeReviewRecords(directory: string, claim?: unknown, gate: QualityGateInput = {}): Promise<'refused' | 'written'> {
  if (claim !== undefined) {
    if (acceptReviewClaim(claim) === 'refused') return 'refused';
    return 'refused';
  }
  const files: { readonly name: string; readonly text: string }[] = [];
  for (const record of buildReviewSet(gate)) {
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (text.includes(WIN_TOKEN)) return 'refused';
    files.push({ name: `${record.id.toLowerCase()}.json`, text });
  }
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    await writeFile(join(directory, file.name), file.text);
  }
  return 'written';
}
