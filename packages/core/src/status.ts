import type { StatusInput } from '@jevris/contracts';

/**
 * Plain-text status. Closed words only. No color. No currency sign.
 * active worker is none. non-owned billing is unknown.
 * An error line is the word error plus one closed code.
 */

const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MONEY_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const blockedLabels = ['accuracy', 'providerConfidence', 'route-worker', 'SOURCE_CANARY_do_not_store'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function blocked(value: string): boolean {
  for (const label of blockedLabels) {
    if (value.includes(label)) return true;
  }
  return false;
}

function safeRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value) || dangerous.has(value) || blocked(value)) {
    return 'rejected';
  }
  return value;
}

function modeWord(value: unknown): string {
  if (value === 'off' || value === 'observe' || value === 'advise') return value;
  return 'unsupported';
}

function budgetWord(mode: string, fresh: unknown, health: unknown, reason: unknown): string {
  if (mode !== 'off' && (reason === 'BUDGET' || health === 'budget-bound')) return 'bound';
  if (fresh === 'scheduled') return 'scheduled';
  return 'not-scheduled';
}

function healthWord(mode: string, health: unknown, reason: unknown): string {
  if (mode === 'off') return 'off';
  if (reason === 'BUDGET' || health === 'budget-bound') return 'budget-bound';
  if (health === 'recorded') return 'recorded';
  if (health === 'refused') return 'refused';
  if (health === 'stale') return 'stale';
  if (health === 'off') return 'off';
  return 'rejected';
}

function errorCode(mode: string, health: unknown, reason: unknown): string | undefined {
  if (mode === 'off') return undefined;
  if (reason === 'BUDGET' || health === 'budget-bound') return 'BUDGET';
  if (health === 'recorded') return undefined;
  if (health === 'refused' || reason === 'REFUSED') return 'REFUSED';
  if (health === 'stale' || reason === 'STALE') return 'STALE';
  return undefined;
}

function reservationLine(value: unknown): string | undefined {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) return undefined;
  return `reservationMicroUsd: ${value}`;
}

export function renderStatus(value: StatusInput): string {
  if (!isPlainObject(value) || hasDangerousKey(value)) {
    return [
      'mode: unsupported',
      'model pin: rejected',
      'routing pinned: no',
      'active worker: none',
      'budget state: not-scheduled',
      'non-owned billing: unknown',
      'decision health: rejected',
      '',
    ].join('\n');
  }
  const mode = modeWord(own(value, 'mode'));
  const health = own(value, 'health');
  const reason = own(value, 'reasonCode');
  const pin = safeRevision(own(value, 'pinnedModel'));
  const lines = [
    `mode: ${mode}`,
    `model pin: ${pin}`,
    `routing pinned: ${pin === 'rejected' ? 'no' : 'yes'}`,
    'active worker: none',
    `budget state: ${budgetWord(mode, own(value, 'freshDecision'), health, reason)}`,
    'non-owned billing: unknown',
    `decision health: ${healthWord(mode, health, reason)}`,
  ];
  const reservation = reservationLine(own(value, 'reservationMicroUsd'));
  if (reservation !== undefined) lines.push(reservation);
  const code = errorCode(mode, health, reason);
  if (code !== undefined) lines.push(`error: ${code}`);
  return lines.join('\n') + '\n';
}
