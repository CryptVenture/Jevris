/**
 * Completion reads receipts. A frame, a model sentence, and a score are not a pass.
 * One reminder is the continuation cap. The next stop is unverified.
 *
 * Receipts must come from the receipt ledger: only an input built by `storeReadInput` (which
 * carries a symbol no JSON frame can hold) can verify (VER-04, BUG-24). A frame object, with or
 * without an `op` key, is always unverified.
 */

/** Brand for completion input assembled from the receipt ledger, never from a frame. */
export const STORE_READ_RECEIPTS: unique symbol = Symbol('jevris.store-read-receipts');

export interface StoreReceiptRow {
  readonly checkId: string;
  readonly sourceRevision: string;
  /** The current revision of this check's inputs; defaults to the input's currentRevision. */
  readonly currentRevision?: string;
  readonly validity: 'current' | 'invalidated';
  readonly failed: boolean;
}

export interface StoreReadInput {
  readonly [STORE_READ_RECEIPTS]: true;
  readonly currentRevision: string;
  readonly mandatoryChecks: readonly string[];
  readonly receipts: readonly StoreReceiptRow[];
  readonly impact?: 'known' | 'unknown';
  readonly requiredContextIds?: readonly string[];
  readonly presentContextIds?: readonly string[];
}

/** Called by the receipt ledger reader (the orchestrator), never with frame data. */
export function storeReadInput(fields: Omit<StoreReadInput, typeof STORE_READ_RECEIPTS>): StoreReadInput {
  return { ...fields, [STORE_READ_RECEIPTS]: true };
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const STOP_CAP = 1;

export interface CompletionDecision {
  readonly verified: boolean;
  readonly applied: false;
  readonly authorityGranted: false;
  readonly providerCalls: 0;
  readonly outcome: 'unverified' | 'verified' | 'ask';
  readonly mandatoryChecks: readonly string[];
  readonly suite: string;
  readonly handoff: false;
  readonly waiting: boolean;
}

export interface StopDecision {
  readonly outcome: 'remind' | 'unverified';
  readonly continuationScheduled: boolean;
  readonly verified: false;
  readonly humanStopAvailable: true;
  readonly cap: 1;
}

function closed(fields: {
  readonly verified?: boolean;
  readonly outcome?: CompletionDecision['outcome'];
  readonly mandatoryChecks?: readonly string[];
  readonly suite?: string;
  readonly waiting?: boolean;
}): CompletionDecision {
  return {
    verified: fields.verified === true,
    applied: false,
    authorityGranted: false,
    providerCalls: 0,
    outcome: fields.outcome ?? 'unverified',
    mandatoryChecks: fields.mandatoryChecks ?? [],
    suite: fields.suite ?? 'declared',
    handoff: false,
    waiting: fields.waiting !== false,
  };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function dangerous(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && DANGEROUS.has(key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function checkIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (!isId(item)) return undefined;
      ids.push(item);
      continue;
    }
    if (!isPlain(item) || dangerous(item)) return undefined;
    const id = own(item, 'id');
    if (!isId(id)) return undefined;
    ids.push(id);
  }
  return ids;
}

function isCurrent(row: unknown, id: string, revision: string): boolean {
  if (!isPlain(row) || dangerous(row)) return false;
  if (own(row, 'checkId') !== id) return false;
  const perCheck = own(row, 'currentRevision');
  const expected = typeof perCheck === 'string' ? perCheck : revision;
  if (own(row, 'sourceRevision') !== expected) return false;
  if (own(row, 'validity') !== 'current') return false;
  if (own(row, 'failed') === true) return false;
  return true;
}

function receiptsCover(input: Record<string, unknown>, checks: readonly string[]): boolean {
  const currentRevision = own(input, 'currentRevision');
  const receipts = own(input, 'receipts');
  if (typeof currentRevision !== 'string' || !Array.isArray(receipts) || checks.length === 0) return false;
  for (const id of checks) {
    const match = receipts.find((row) => isCurrent(row, id, currentRevision));
    if (match === undefined) return false;
  }
  return true;
}

function missingContext(input: Record<string, unknown>): boolean {
  const required = own(input, 'requiredContextIds');
  if (!Array.isArray(required) || required.length === 0) return false;
  const present = own(input, 'presentContextIds');
  const have = new Set<string>();
  if (Array.isArray(present)) {
    for (const id of present) {
      if (typeof id === 'string') have.add(id);
    }
  }
  for (const id of required) {
    if (typeof id !== 'string' || !have.has(id)) return true;
  }
  return false;
}

function storeRead(input: object): boolean {
  return Reflect.get(input, STORE_READ_RECEIPTS) === true;
}

export function completionFromReceipts(input: unknown): CompletionDecision {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return closed({ waiting: true });
  const branded = storeRead(input);
  const plain = branded ? { ...(input as Record<string, unknown>) } : input;
  if (!isPlain(plain) || dangerous(plain)) return closed({ waiting: true });
  if (Object.hasOwn(plain, 'passed')) return closed({ waiting: true });
  if (!branded) {
    // A frame can name checks and ask; it can never verify.
    const checks = checkIds(own(plain, 'mandatoryChecks')) ?? [];
    const suite = own(plain, 'impact') === 'unknown' ? 'broader' : 'declared';
    return closed({ mandatoryChecks: checks, suite, waiting: true, ...(missingContext(plain) ? { outcome: 'ask' as const } : {}) });
  }
  input = plain;
  const record = input as Record<string, unknown>;
  const checks = checkIds(own(record, 'mandatoryChecks'));
  const suite = own(record, 'impact') === 'unknown' ? 'broader' : 'declared';
  if (checks === undefined) return closed({ suite, waiting: true });
  const covered = receiptsCover(record, checks);
  const contextMissing = missingContext(record);
  if (contextMissing) {
    return closed({
      outcome: 'ask',
      mandatoryChecks: checks,
      suite,
      waiting: !covered,
    });
  }
  if (!covered) {
    return closed({
      mandatoryChecks: checks,
      suite,
      waiting: true,
    });
  }
  return closed({
    verified: true,
    outcome: 'verified',
    mandatoryChecks: checks,
    suite,
    waiting: false,
  });
}

function reminderCount(input: unknown): number {
  if (!isPlain(input) || dangerous(input)) return STOP_CAP;
  const value = own(input, 'remindersAlreadyFired');
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

function checkUnavailable(input: unknown): boolean {
  if (!isPlain(input) || dangerous(input)) return false;
  return own(input, 'requiredCheckUnavailable') === true;
}

export function stopContinuation(input: unknown): StopDecision {
  const fired = reminderCount(input);
  const unavailable = checkUnavailable(input);
  if (unavailable && fired < STOP_CAP) {
    return {
      outcome: 'remind',
      continuationScheduled: true,
      verified: false,
      humanStopAvailable: true,
      cap: STOP_CAP,
    };
  }
  return {
    outcome: 'unverified',
    continuationScheduled: false,
    verified: false,
    humanStopAvailable: true,
    cap: STOP_CAP,
  };
}
