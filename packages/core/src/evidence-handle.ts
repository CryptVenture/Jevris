import type { EvidenceOffset, EvidenceView } from '@jevris/contracts';
import { createHash } from 'node:crypto';

/**
 * Extractive view. The handle addresses the original output.
 * A failure stays a failure. A hypothesis stays a hypothesis.
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);

export interface CapsuleClaim {
  readonly status: 'hypothesis';
  readonly provenanceId: string;
  readonly acceptedRequirement: false;
}

export interface ContradictionSurface {
  readonly claims: readonly string[];
  readonly acceptedRequirementId: string;
}

export interface CompactionAdvice {
  readonly boundary: string;
  readonly nativeAllowed: true;
  readonly deferred: boolean;
}

export interface OmissionAudit {
  readonly missingConstraintIds: readonly string[];
  readonly restoredMandatoryIds: readonly string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function stripControls(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b/g, '');
}

function stable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? 'unserializable';
  } catch {
    return 'unserializable';
  }
}

function passthrough(value: unknown): EvidenceView {
  const base = {
    handle: 'passthrough',
    hash: sha256(stable(value)),
    errorState: 'unknown',
    offsets: [],
    passthrough: true,
    text: '',
  };
  if (value === undefined) return base;
  return { ...base, value };
}

function readOffsets(value: unknown): readonly EvidenceOffset[] {
  if (!Array.isArray(value)) return [];
  const offsets: EvidenceOffset[] = [];
  for (const item of value) {
    if (!isPlain(item) || dangerous(item)) continue;
    const start = own(item, 'start');
    const end = own(item, 'end');
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end < start) continue;
    offsets.push({ start, end });
  }
  return offsets;
}

function viewText(body: string, errorState: string): string {
  const cleaned = stripControls(body);
  if (errorState !== 'ok' && /succeeded/i.test(cleaned)) return errorState;
  return cleaned;
}

export function distillToolOutput(input: unknown): EvidenceView {
  if (!isPlain(input) || dangerous(input) || own(input, 'kind') !== 'tool-output') return passthrough(input);
  const handle = own(input, 'handle');
  const body = own(input, 'body');
  const errorState = own(input, 'errorState');
  if (!isId(handle) || typeof body !== 'string' || !isId(errorState)) return passthrough(input);
  return {
    handle,
    hash: sha256(body),
    errorState,
    offsets: readOffsets(own(input, 'offsets')),
    passthrough: false,
    text: viewText(body, errorState),
  };
}

export function importCapsuleClaim(input: unknown): CapsuleClaim {
  const provenanceId = isPlain(input) && !dangerous(input) ? own(input, 'provenanceId') : undefined;
  return {
    status: 'hypothesis',
    provenanceId: isId(provenanceId) ? provenanceId : 'unprovenanced',
    acceptedRequirement: false,
  };
}

function claimText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) return undefined;
  return stripControls(value);
}

export function surfaceContradiction(input: unknown): ContradictionSurface {
  const claims: string[] = [];
  let acceptedRequirementId = 'unchanged';
  if (isPlain(input) && !dangerous(input)) {
    const listed = own(input, 'claims');
    if (Array.isArray(listed)) {
      for (const item of listed) {
        const text = claimText(item);
        if (text !== undefined) claims.push(text);
      }
    }
    const accepted = own(input, 'acceptedRequirementId');
    if (isId(accepted)) acceptedRequirementId = accepted;
  }
  return { claims, acceptedRequirementId };
}

export function adviseCompaction(input: unknown): CompactionAdvice {
  const deferred = isPlain(input) && !dangerous(input) && own(input, 'safeTriggerEvidence') === true;
  return {
    boundary: 'recommend-boundary',
    nativeAllowed: true,
    deferred,
  };
}

function idList(input: Record<string, unknown>, key: string): readonly string[] {
  const value = own(input, key);
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (isId(item)) ids.push(item);
  }
  return ids;
}

export function auditOmissions(input: unknown): OmissionAudit {
  if (!isPlain(input) || dangerous(input)) {
    return { missingConstraintIds: [], restoredMandatoryIds: [] };
  }
  const mandatory = idList(input, 'mandatoryConstraintIds');
  const present = new Set(idList(input, 'presentConstraintIds'));
  const missing: string[] = [];
  for (const id of mandatory) {
    if (!present.has(id)) missing.push(id);
  }
  return {
    missingConstraintIds: missing,
    restoredMandatoryIds: mandatory,
  };
}
