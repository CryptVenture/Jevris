import type { ReasonCode } from '@jevris/contracts';

/**
 * Pure rules gate. It never issues permission, reserves money, or executes an action.
 * A hit is not authorization. Null means the input is ambiguous-failure and may continue.
 */

const dangerous = new Set(['__proto__', 'prototype', 'constructor']);

export interface RulesHit {
  readonly disposition: 'rules' | 'refused';
  readonly reasonCode: ReasonCode;
  readonly classification: string | null;
  readonly count: number | null;
}

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

function refused(): RulesHit {
  return {
    disposition: 'refused',
    reasonCode: 'INVALID_REQUEST',
    classification: null,
    count: null,
  };
}

function rulesHit(reasonCode: ReasonCode, classification: string | null, count: number | null): RulesHit {
  return {
    disposition: 'rules',
    reasonCode,
    classification,
    count,
  };
}

const knownFamilies = new Set(['type_error', 'assertion', 'environment']);
const authorityAsks = new Set(['permission', 'consent', 'verified']);

function knownFailure(input: Record<string, unknown>): RulesHit {
  const family = input.family;
  if (typeof family !== 'string' || !knownFamilies.has(family)) return refused();
  return rulesHit('KNOWN_FAILURE', family, null);
}

function integerCount(input: Record<string, unknown>): RulesHit {
  if (!Array.isArray(input.items)) return refused();
  return rulesHit('INTEGER_COUNT', null, input.items.length);
}

function authorityRequest(input: Record<string, unknown>): RulesHit {
  const asked = input.asked;
  if (typeof asked !== 'string' || !authorityAsks.has(asked)) return refused();
  return {
    disposition: 'refused',
    reasonCode: 'INELIGIBLE',
    classification: null,
    count: null,
  };
}

export function applyRules(input: unknown): RulesHit | null {
  if (!isPlainObject(input) || hasDangerousKey(input)) return refused();
  if (input.kind === 'ambiguous-failure') return null;
  if (input.kind === 'known-failure') return knownFailure(input);
  if (input.kind === 'count') return integerCount(input);
  if (input.kind === 'authority-request') return authorityRequest(input);
  return refused();
}
