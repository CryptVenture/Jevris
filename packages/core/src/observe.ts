import { readFile } from 'node:fs/promises';
import { durableWrite } from '@jevris/platform';
import {
  OBSERVATION_KEYS,
  OBSERVATION_SCHEMA_VERSION,
  OBSERVE_RECORDED_EXPLANATION,
} from '@jevris/contracts';
import type { LocalCallerRejectReason, ObservationFile } from '@jevris/contracts';
import { decideEgress, type EgressRequest } from './egress.js';
import { authorizeLocalCaller } from './runtime.js';
import type { AntiReplayStore, LocalCallerCredential } from './runtime.js';

/**
 * Observe record. Named fields only. A recommendation stays in the file.
 * This module does not bind a listener and does not call a provider.
 */

const dangerous = new Set(['__proto__', 'prototype', 'constructor']);

export type RecordObservationResult =
  | {
      readonly accepted: false;
      readonly reasonCode: LocalCallerRejectReason;
      readonly applied: false;
      readonly toolPermission: false;
      readonly sent: false;
      readonly fileWritten: false;
    }
  | {
      readonly accepted: true;
      readonly reasonCode: null;
      readonly applied: false;
      readonly toolPermission: false;
      readonly sent: false;
      readonly file: ObservationFile;
      readonly fileWritten: boolean;
    };

export type ReadObservationFileResult =
  | { readonly ok: true; readonly file: ObservationFile }
  | { readonly ok: false; readonly reasonCode: 'SCHEMA_FAILURE' };

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

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isReplay(value: unknown): value is AntiReplayStore {
  if (value === null || typeof value !== 'object') return false;
  const consumed = Reflect.get(value, 'consumed');
  const consume = Reflect.get(value, 'consume');
  return typeof consumed === 'function' && typeof consume === 'function';
}

function isCredential(value: unknown): value is LocalCallerCredential {
  if (!isPlainObject(value) || hasDangerousKey(value)) return false;
  return (
    typeof value.user === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.expiresAtMs === 'number' &&
    value.token instanceof Uint8Array
  );
}

function reject(reasonCode: LocalCallerRejectReason): RecordObservationResult {
  return {
    accepted: false,
    reasonCode,
    applied: false,
    toolPermission: false,
    sent: false,
    fileWritten: false,
  };
}

function recorded(file: ObservationFile, fileWritten: boolean): RecordObservationResult {
  return {
    accepted: true,
    reasonCode: null,
    applied: false,
    toolPermission: false,
    sent: false,
    file,
    fileWritten,
  };
}

function schemaFailure(): ReadObservationFileResult {
  return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (!expected.includes(key)) return false;
  }
  return true;
}

function encodeUtf8(text: string): Uint8Array {
  const Ctor = (globalThis as unknown as {
    TextEncoder?: new () => { encode(input?: string): Uint8Array };
  }).TextEncoder;
  if (Ctor === undefined) return new Uint8Array();
  return new Ctor().encode(text);
}

function decodeUtf8Fatal(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => { decode(input?: Uint8Array): string };
  }).TextDecoder;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function egressRequest(input: Record<string, unknown>): EgressRequest {
  const hasSetting = Object.hasOwn(input, 'setting');
  const hasClaims = Object.hasOwn(input, 'untrustedClaims');
  if (hasSetting && hasClaims) {
    return { setting: input.setting, untrustedClaims: input.untrustedClaims };
  }
  if (hasSetting) return { setting: input.setting };
  if (hasClaims) return { untrustedClaims: input.untrustedClaims };
  return {};
}

function fileFromParsed(value: unknown): ObservationFile | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, OBSERVATION_KEYS)) {
    return undefined;
  }
  if (value.schemaVersion !== OBSERVATION_SCHEMA_VERSION) return undefined;
  if (value.mode !== 'observe') return undefined;
  if (!nonEmpty(value.policyVersion) || !nonEmpty(value.actualModel)) return undefined;
  if (value.recommendedModel !== null && typeof value.recommendedModel !== 'string') return undefined;
  if (value.requestedModel !== null && typeof value.requestedModel !== 'string') return undefined;
  if (value.actualWorker !== null || value.appliedAction !== null) return undefined;
  if (value.applied !== false || value.toolPermission !== false || value.sent !== false) return undefined;
  if (typeof value.explanation !== 'string') return undefined;
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    mode: 'observe',
    policyVersion: value.policyVersion,
    recommendedModel: value.recommendedModel,
    actualModel: value.actualModel,
    actualWorker: null,
    requestedModel: value.requestedModel,
    applied: false,
    appliedAction: null,
    toolPermission: false,
    sent: false,
    explanation: value.explanation,
  };
}

async function writeObservation(destination: string, file: ObservationFile): Promise<boolean> {
  const bytes = encodeUtf8(JSON.stringify(file));
  return (await durableWrite(destination, bytes)).ok;
}

export async function recordObservation(input: object): Promise<RecordObservationResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return reject('MALFORMED');
  const replay = own(input, 'replay');
  if (!isReplay(replay)) return reject('MALFORMED');
  const presented = own(input, 'presented');
  const presentedToken = isPlainObject(presented) ? own(presented, 'token') : undefined;
  let consumed = false;
  try {
    consumed = presentedToken instanceof Uint8Array && replay.consumed(presentedToken);
  } catch {
    return reject('MALFORMED');
  }
  const expectedUser = own(input, 'expectedUser');
  const expectedPid = own(input, 'expectedPid');
  const nowMs = own(input, 'nowMs');
  if (typeof expectedUser !== 'string' || typeof expectedPid !== 'number' || typeof nowMs !== 'number') {
    return reject('MALFORMED');
  }
  const credentialValue = own(input, 'credential');
  let credential: LocalCallerCredential | null;
  if (credentialValue === null || credentialValue === undefined) {
    credential = null;
  } else if (isCredential(credentialValue)) {
    credential = credentialValue;
  } else {
    return reject('MALFORMED');
  }
  let auth: ReturnType<typeof authorizeLocalCaller>;
  try {
    auth = authorizeLocalCaller(presented, expectedUser, expectedPid, credential, nowMs, consumed);
  } catch {
    return reject('MALFORMED');
  }
  if (auth.decision === 'reject') return reject(auth.reasonCode);
  try {
    if (presentedToken instanceof Uint8Array) replay.consume(presentedToken);
  } catch {
    return reject('MALFORMED');
  }

  const mode = own(input, 'mode');
  const policyVersion = own(input, 'policyVersion');
  const actualModel = own(input, 'actualModel');
  const requestedModel = own(input, 'requestedModel');
  if (mode !== 'observe' || !nonEmpty(policyVersion) || !nonEmpty(actualModel)) {
    return reject('MALFORMED');
  }
  if (requestedModel !== null && typeof requestedModel !== 'string') {
    return reject('MALFORMED');
  }

  const egress = decideEgress(egressRequest(input));
  let recommendedModel: string | null;
  let explanation: string;
  if (egress.decision === 'deny') {
    recommendedModel = null;
    explanation = egress.explanation;
  } else {
    const supplied = own(input, 'recommendedModel');
    if (typeof supplied !== 'string') return reject('MALFORMED');
    recommendedModel = supplied;
    explanation = OBSERVE_RECORDED_EXPLANATION;
  }

  const file: ObservationFile = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    mode: 'observe',
    policyVersion,
    recommendedModel,
    actualModel,
    actualWorker: null,
    requestedModel,
    applied: false,
    appliedAction: null,
    toolPermission: false,
    sent: false,
    explanation,
  };

  const destination = own(input, 'destination');
  if (typeof destination !== 'string' || destination.length === 0) {
    return recorded(file, false);
  }
  const written = await writeObservation(destination, file);
  return recorded(file, written);
}

export async function readObservationFile(destination: string): Promise<ReadObservationFileResult> {
  if (typeof destination !== 'string' || destination.length === 0) return schemaFailure();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(destination);
  } catch {
    return schemaFailure();
  }
  const text = decodeUtf8Fatal(bytes);
  if (text === undefined) return schemaFailure();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return schemaFailure();
  }
  const file = fileFromParsed(parsed);
  if (file === undefined) return schemaFailure();
  return { ok: true, file };
}
