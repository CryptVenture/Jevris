import { isAbsoluteFor } from '@jevris/platform';
/**
 * Trusted analyzer manifest and the unknown-stack fallback.
 * A compiler runs only from an absolute argument vector.
 * This module does not start a process and does not write a receipt.
 */

const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const MANIFEST_FIELDS = new Set([
  'runnerId',
  'command',
  'args',
  'commandHash',
  'workspaceId',
  'receiptId',
  'sourceRevision',
  'evidenceId',
  'currentRevision',
]);
const VERIFICATION_REASON =
  'verification remains unsupported until an approved runner manifest exists.';

export interface AnalyzerAcceptance {
  readonly ok: true;
}

export interface AnalyzerRefusal {
  readonly ok: false;
  readonly reason: 'refused';
}

export interface UnknownStackResult {
  readonly triage: 'allowed';
  readonly checkpoint: {
    readonly applied: false;
    readonly providerCalls: 0;
    readonly toolPermission: false;
  };
  readonly verification: 'unsupported';
  readonly verificationReason: typeof VERIFICATION_REASON;
  readonly receipt: null;
  readonly binaryCorrectness: 'unverified';
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

function extraField(value: object, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return true;
  }
  return false;
}

function passedClaim(value: object): boolean {
  if (Object.hasOwn(value, 'passed')) return true;
  const validity = own(value, 'validity');
  const status = own(value, 'status');
  const claim = own(value, 'claim');
  return validity === 'passed' || status === 'passed' || claim === 'passed';
}

function jevCommandField(value: object): boolean {
  for (const key of Object.keys(value)) {
    const folded = key.toLowerCase();
    if (folded.includes('jev') && folded.includes('command')) return true;
  }
  return false;
}

function shellMetacharacter(command: string): boolean {
  // Parentheses are legal in C:\Program Files (x86); with no shell they are inert, and a
  // .cmd shim is caret-escaped by the spawn helper (BLD-06, BLD-07).
  return /[|;`$&<>\n\r]/.test(command);
}

function readArgs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const argv: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 4_096 || item.includes('\0')) return undefined;
    argv.push(item);
  }
  return argv;
}

export interface ManifestOptions {
  /** The platform whose absolute-path rule applies. Default: this process. */
  readonly platform?: string;
}

export function acceptAnalyzerManifest(input: unknown, options: ManifestOptions = {}): AnalyzerAcceptance | AnalyzerRefusal {
  if (!isPlain(input) || dangerous(input) || extraField(input, MANIFEST_FIELDS)) {
    return { ok: false, reason: 'refused' };
  }
  if (passedClaim(input) || jevCommandField(input)) return { ok: false, reason: 'refused' };
  const command = own(input, 'command');
  if (typeof command !== 'string' || !isAbsoluteFor(command, options.platform) || command.includes('\0')) {
    return { ok: false, reason: 'refused' };
  }
  if (shellMetacharacter(command)) return { ok: false, reason: 'refused' };
  if (readArgs(own(input, 'args')) === undefined) return { ok: false, reason: 'refused' };
  return { ok: true };
}

export function triageUnknownStack(): UnknownStackResult {
  return {
    triage: 'allowed',
    checkpoint: {
      applied: false,
      providerCalls: 0,
      toolPermission: false,
    },
    verification: 'unsupported',
    verificationReason: VERIFICATION_REASON,
    receipt: null,
    binaryCorrectness: 'unverified',
  };
}
