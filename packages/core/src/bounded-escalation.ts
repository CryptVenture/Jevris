/**
 * One bounded escalation record. It does not launch a worker, session, lease,
 * checkout, or DAG. Success requires a new current receipt from acceptRunnerReceipt.
 * A model sentence is not that receipt. An environment failure is not escalated.
 *
 * Core does not import the store (BLD-14): the caller injects acceptRunnerReceipt from
 * @jevris/store. With no port, a receipt is never verified.
 */

import { adviseFailureLoop } from './loop-advice.js';

const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The store as core sees it: an opened store result, checked structurally. */
export interface OpenedStoreLike {
  readonly ok: true;
  readonly resolvedPath: string;
}

export interface EscalationPorts {
  /** @jevris/store acceptRunnerReceipt. Absent: no receipt is verified. */
  readonly acceptRunnerReceipt?: (store: OpenedStoreLike, receipt: unknown, revision: unknown) => { readonly ok: boolean };
}

export interface EscalationRecord {
  readonly verb: 'ask' | 'pause' | 'abstain';
  readonly escalated: boolean;
  readonly launched: false;
  readonly sessionStarted: false;
  readonly leaseStarted: false;
  readonly checkoutStarted: false;
  readonly dagStarted: false;
  readonly applied: false;
  readonly authorityGranted: false;
  readonly verified: boolean;
  readonly blocked: boolean;
  readonly nextStep: 'request-environment-evidence' | 'blocked-report' | 'abstain';
  readonly rejectedApproaches: readonly string[];
  readonly providerCalls: 0;
  readonly text: string;
}

function isPlain(value: unknown): value is Record<string, unknown> {
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

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return undefined;
  return value;
}

function approachesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 10) return [];
  const copied: string[] = [];
  for (const item of value) {
    const id = safeId(item);
    if (id === undefined) return [];
    copied.push(id);
  }
  return copied;
}

function integer(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 0 || value > 10) return undefined;
  return value;
}

function noLaunch(): Pick<
  EscalationRecord,
  | 'launched'
  | 'sessionStarted'
  | 'leaseStarted'
  | 'checkoutStarted'
  | 'dagStarted'
  | 'applied'
  | 'authorityGranted'
  | 'providerCalls'
> {
  return {
    launched: false,
    sessionStarted: false,
    leaseStarted: false,
    checkoutStarted: false,
    dagStarted: false,
    applied: false,
    authorityGranted: false,
    providerCalls: 0,
  };
}

function blockedReport(approaches: readonly string[]): EscalationRecord {
  return {
    verb: 'pause',
    escalated: false,
    verified: false,
    blocked: true,
    nextStep: 'blocked-report',
    rejectedApproaches: approaches,
    text: 'Blocked report. A further failure does not escalate again. No worker was launched.',
    ...noLaunch(),
  };
}

function environmentRecord(approaches: readonly string[]): EscalationRecord {
  return {
    verb: 'ask',
    escalated: false,
    verified: false,
    blocked: false,
    nextStep: 'request-environment-evidence',
    rejectedApproaches: approaches,
    text: 'Next step: request environment evidence. An environment failure is not escalated.',
    ...noLaunch(),
  };
}

function isOpenedStore(value: unknown): value is OpenedStoreLike {
  if (!isPlain(value) || hasDangerousKey(value)) return false;
  return value['ok'] === true && typeof value['resolvedPath'] === 'string';
}

function receiptCurrent(input: Record<string, unknown>, ports: EscalationPorts): boolean {
  const accept = ports.acceptRunnerReceipt;
  if (typeof accept !== 'function') return false;
  const receipt = own(input, 'receipt');
  const revision = own(input, 'currentRevision');
  const store = own(input, 'store');
  if (receipt === undefined || revision === undefined || store === undefined) return false;
  if (typeof receipt === 'string') return false;
  if (!isOpenedStore(store)) return false;
  try {
    return accept(store, receipt, revision).ok === true;
  } catch {
    return false;
  }
}

export function adviseBoundedEscalation(input: unknown, ports: EscalationPorts = {}): EscalationRecord {
  if (!isPlain(input) || hasDangerousKey(input)) {
    return {
      verb: 'abstain',
      escalated: false,
      verified: false,
      blocked: false,
      nextStep: 'abstain',
      rejectedApproaches: [],
      text: 'Escalation refused. No worker was launched.',
      ...noLaunch(),
    };
  }
  const diagnostic = own(input, 'diagnostic');
  const approaches = approachesOf(own(input, 'rejectedApproaches'));
  if (diagnostic === 'missing-service') {
    const loop = adviseFailureLoop(input);
    const retained = approaches.length > 0 ? approaches : loop.rejectedApproaches;
    return environmentRecord(retained);
  }
  const used = integer(own(input, 'repairAttemptsUsed'));
  const max = integer(own(input, 'maxRepairAttempts'));
  const exhausted = used !== undefined && max !== undefined && used >= max;
  const qualified = own(input, 'workerQualified') === true;
  const present = own(input, 'sourceEvidence') === 'present';
  const prior = own(input, 'priorEscalation') === true;
  if (diagnostic === 'source-defect' && present && exhausted && qualified && prior) {
    return blockedReport(approaches);
  }
  if (diagnostic === 'source-defect' && present && exhausted && qualified) {
    return {
      verb: 'pause',
      escalated: true,
      verified: receiptCurrent(input, ports),
      blocked: false,
      nextStep: 'abstain',
      rejectedApproaches: approaches,
      text: 'One escalation recorded. Success requires a new current receipt. No worker was launched.',
      ...noLaunch(),
    };
  }
  return {
    verb: 'pause',
    escalated: false,
    verified: false,
    blocked: false,
    nextStep: 'abstain',
    rejectedApproaches: approaches,
    text: 'Escalation was not started. No worker was launched.',
    ...noLaunch(),
  };
}
