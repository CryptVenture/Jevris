import { putReceipt } from './invalidate.js';
import { automationRefusedGuard, driverFor, type OpenStoreResult } from './open.js';
import { immediately, type SqlDriver } from './schema.js';

const BYTE_CAP = 131_072;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);

export type CiImportResult =
  | {
      readonly ok: true;
      readonly current: boolean;
      readonly mandatoryCheckIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'refused';
      readonly current: false;
      readonly mandatoryCheckIds: readonly string[];
    };

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function copyChecks(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return [];
    ids.push(item);
  }
  return ids;
}

function refused(mandatoryCheckIds: readonly string[]): CiImportResult {
  return { ok: false, reason: 'refused', current: false, mandatoryCheckIds };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function textRefused(text: string): boolean {
  if (byteLength(text) > BYTE_CAP) return true;
  if (text.includes('__proto__') || text.includes('prototype') || text.includes('constructor')) return true;
  return false;
}

function passedClaim(value: object): boolean {
  if (Object.hasOwn(value, 'passed')) return true;
  const validity = own(value, 'validity');
  const status = own(value, 'status');
  const claim = own(value, 'claim');
  return validity === 'passed' || status === 'passed' || claim === 'passed';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

function parseBody(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === 'string') {
    if (textRefused(body) || body.includes('"passed"')) return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!isPlain(parsed) || dangerous(parsed) || passedClaim(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > BYTE_CAP) return undefined;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return undefined;
    }
    return parseBody(text);
  }
  if (!isPlain(body) || dangerous(body) || passedClaim(body)) return undefined;
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return undefined;
  }
  if (textRefused(text) || text.includes('"passed"')) return undefined;
  return body;
}

function issuerOf(authorization: object): string | undefined {
  if (!Object.hasOwn(authorization, 'issuer')) return undefined;
  const issuer = own(authorization, 'issuer');
  if (typeof issuer !== 'string' || issuer.trim().length === 0) return undefined;
  return issuer;
}

function revisionOf(record: object): string | undefined {
  const revision = own(record, 'revision');
  if (isKey(revision)) return revision;
  const sourceRevision = own(record, 'sourceRevision');
  if (isKey(sourceRevision)) return sourceRevision;
  return undefined;
}

function insertInvalidated(driver: SqlDriver, workspaceId: string, receiptId: string, revision: string): boolean {
  const existing = driver
    .prepare('SELECT 1 AS n FROM receipt_row WHERE workspace_id = ? AND receipt_id = ?')
    .get(workspaceId, receiptId);
  if (existing !== undefined && existing !== null) return false;
  driver
    .prepare(
      `INSERT INTO receipt_row (
         workspace_id, receipt_id, source_revision, validity, evidence_id
       ) VALUES (?, ?, ?, 'invalidated', NULL)`,
    )
    .run(workspaceId, receiptId, revision);
  return true;
}

export function importCiReceipt(
  store: OpenStoreResult,
  body: unknown,
  authorization: unknown,
  currentRevision: unknown,
  mandatoryCheckIds: unknown,
): CiImportResult {
  const checks = copyChecks(mandatoryCheckIds);
  if (!store.ok) return refused(checks);
  const blocked = automationRefusedGuard(store);
  if (blocked !== undefined) return refused(checks);
  const driver = driverFor(store);
  if (driver === undefined) return refused(checks);
  const parsed = parseBody(body);
  if (parsed === undefined || passedClaim(parsed)) return refused(checks);
  if (!isPlain(authorization) || dangerous(authorization)) return refused(checks);
  if (issuerOf(authorization) === undefined) return refused(checks);
  const authorizedRevision = revisionOf(authorization);
  const bodyRevision = revisionOf(parsed);
  const receiptId = own(parsed, 'receiptId');
  if (!isId(receiptId) || authorizedRevision === undefined || bodyRevision === undefined) return refused(checks);
  if (!isKey(currentRevision)) return refused(checks);
  const disposition = own(authorization, 'disposition');
  if (authorizedRevision === currentRevision && bodyRevision === currentRevision) {
    const written = putReceipt(store, {
      workspaceId: store.workspaceId,
      receiptId,
      sourceRevision: bodyRevision,
    });
    if (!written.ok) return refused(checks);
    return { ok: true, current: true, mandatoryCheckIds: checks };
  }
  if (
    disposition === 'historical' &&
    authorizedRevision === bodyRevision &&
    bodyRevision !== currentRevision
  ) {
    let stored = false;
    const run = driver.transaction(() => {
      stored = insertInvalidated(driver, store.workspaceId, receiptId, bodyRevision);
    });
    try {
      immediately(run);
    } catch {
      return refused(checks);
    }
    if (!stored) return refused(checks);
    return { ok: true, current: false, mandatoryCheckIds: checks };
  }
  return refused(checks);
}
