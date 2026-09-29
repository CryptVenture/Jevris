import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { durableWrite } from '@jevris/platform';
import { FALLBACK_KEYS, FALLBACK_SCHEMA_VERSION, PINNED_MODEL, VALIDITY_KEY_NAMES } from '@jevris/contracts';
import type {
  FallbackErrorClass,
  FallbackFile,
  FallbackMode,
  FallbackRestore,
  LocalCallerRejectReason,
  ProviderPort,
} from '@jevris/contracts';
import { decideEgress } from './egress.js';
import { recordDecision, type RecordDecisionArgs } from './ledger.js';

/**
 * Fail-closed local entry. Named fields only.
 * Off returns before a provider call. This module does not bind a listener.
 */

const TOKEN_BYTES = 32;
const OFF_EXPLANATION = 'Rules-only fallback: mode is off. No provider call was made.';
const NOT_READY_EXPLANATION = 'Rules-only fallback: mode is not ready. No provider call was made.';
const TIMEOUT_EXPLANATION =
  'Rules-only fallback: provider timeout. Coding continues on the approved model.';
const OVERLOAD_EXPLANATION =
  'Rules-only fallback: provider overload. Coding continues on the approved model.';
const PROHIBITED_EXPLANATION =
  'Rules-only fallback: network policy prohibits the provider. Coding continues on the approved model.';
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const loopback = new Set(['localhost', '127.0.0.1', '::1']);

export interface LocalCallerCredential {
  readonly user: string;
  readonly pid: number;
  readonly expiresAtMs: number;
  readonly token: Uint8Array;
}

export interface AntiReplayStore {
  consumed(token: Uint8Array): boolean;
  consume(token: Uint8Array): void;
}

export type IssueLocalCallerTokenResult =
  | {
      readonly ok: true;
      readonly token: Uint8Array;
      readonly user: string;
      readonly pid: number;
      readonly expiresAtMs: number;
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'MALFORMED';
    };

export type AuthorizeLocalCallerResult =
  | { readonly decision: 'accept'; readonly consume: true }
  | { readonly decision: 'reject'; readonly reasonCode: LocalCallerRejectReason };

export type ReadFallbackFileResult =
  | { readonly ok: true; readonly file: FallbackFile }
  | { readonly ok: false; readonly reasonCode: 'SCHEMA_FAILURE' };

export type RuntimeResult =
  | {
      readonly decision: 'reject';
      readonly reasonCode: LocalCallerRejectReason;
      readonly accepted: false;
      readonly applied: false;
      readonly toolPermission: false;
      readonly sent: false;
      readonly interrupt: false;
      readonly fileWritten: false;
    }
  | {
      readonly decision: 'fallback';
      readonly accepted: true;
      readonly reasonCode: null;
      readonly applied: false;
      readonly toolPermission: false;
      readonly sent: false;
      readonly interrupt: boolean;
      readonly errorClass: FallbackErrorClass;
      readonly cacheReused: boolean;
      readonly restore: 'none';
      readonly explanation: string;
      readonly fileWritten: boolean;
    }
  | {
      readonly decision: 'withheld';
      readonly accepted: true;
      readonly reasonCode: null;
      readonly applied: false;
      readonly toolPermission: false;
      readonly sent: false;
      readonly interrupt: false;
      readonly errorClass: null;
      readonly cacheReused: false;
      readonly restore: FallbackRestore;
      readonly actuationResumed?: false;
      readonly fileWritten: false;
    };

interface OutageMemory {
  seen(errorClass: string, providerRoute: string, policyVersion: string): boolean;
  mark(errorClass: string, providerRoute: string, policyVersion: string): void;
}

interface ProbeMemory {
  probed(): boolean;
  mark(): void;
}

interface RunLocalRuntimeInput {
  readonly mode: string;
  readonly caller: object;
  readonly expectedUser: string;
  readonly expectedPid: number;
  readonly credential: LocalCallerCredential | null;
  readonly nowMs: number;
  readonly replay: AntiReplayStore;
  readonly approvedModel: string;
  readonly providerRoute: string;
  readonly policyVersion: string;
  readonly networkPolicy: 'allowed' | 'prohibited';
  readonly availability: 'available' | 'timeout';
  readonly outages: OutageMemory;
  readonly probes: ProbeMemory;
  readonly status?: number;
  readonly destination?: string;
  readonly connectivity?: string;
  readonly circuit?: string;
  readonly probe?: (health: { readonly kind: 'health' }) => unknown;
  readonly validity?: unknown;
  readonly cached?: unknown;
  readonly egressSetting?: unknown;
  readonly untrustedClaims?: unknown;
  readonly ledger?: object;
  readonly sourceOpener?: { open: (...args: never[]) => unknown };
  readonly workLauncher?: { launch: (...args: never[]) => unknown };
  readonly actuator?: { actuate: (...args: never[]) => unknown };
  readonly port?: { evaluate: (...args: never[]) => unknown };
  readonly alternatePort?: { evaluate: (...args: never[]) => unknown };
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

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function credentialPresent(
  value: LocalCallerCredential | null | undefined,
): value is LocalCallerCredential {
  return value !== null && value !== undefined;
}

function reject(reasonCode: LocalCallerRejectReason): RuntimeResult {
  return {
    decision: 'reject',
    reasonCode,
    accepted: false,
    applied: false,
    toolPermission: false,
    sent: false,
    interrupt: false,
    fileWritten: false,
  };
}

function malformed(): IssueLocalCallerTokenResult {
  return { ok: false, reasonCode: 'MALFORMED' };
}

function schemaFailure(): ReadFallbackFileResult {
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

function safeId(value: string): boolean {
  return ID_PATTERN.test(value) && !dangerous.has(value);
}

function isFallbackMode(value: unknown): value is FallbackMode {
  return value === 'off' || value === 'unavailable';
}

function isErrorClass(value: unknown): value is FallbackErrorClass {
  return value === null || value === 'timeout' || value === 'overload' || value === 'prohibited';
}

function isRestore(value: unknown): value is FallbackRestore {
  return value === 'none' || value === 'observation';
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

export function issueLocalCallerToken(scope: {
  readonly user: string;
  readonly pid: number;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}): IssueLocalCallerTokenResult {
  if (!isPlainObject(scope) || hasDangerousKey(scope)) return malformed();
  const user = scope.user;
  const pid = scope.pid;
  const expiresAtMs = scope.expiresAtMs;
  const nowMs = scope.nowMs;
  if (typeof user !== 'string' || user.length === 0) return malformed();
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0) return malformed();
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) return malformed();
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return malformed();
  if (nowMs >= expiresAtMs) return malformed();
  return {
    ok: true,
    token: randomBytes(TOKEN_BYTES),
    user,
    pid,
    expiresAtMs,
  };
}

export function authorizeLocalCaller(
  presented: unknown,
  expectedUser: string,
  expectedPid: number,
  credential: LocalCallerCredential | null,
  nowMs: number,
  consumed: boolean,
): AuthorizeLocalCallerResult {
  if (!isPlainObject(presented) || hasDangerousKey(presented)) {
    return { decision: 'reject', reasonCode: 'MALFORMED' };
  }
  const host = own(presented, 'host');
  const user = own(presented, 'user');
  const pid = own(presented, 'pid');
  const token = own(presented, 'token');
  if (
    absent(user) &&
    absent(pid) &&
    absent(token) &&
    typeof host === 'string' &&
    loopback.has(host)
  ) {
    return { decision: 'reject', reasonCode: 'LOCALHOST_ONLY' };
  }
  if (absent(user) || typeof user !== 'string') {
    return { decision: 'reject', reasonCode: 'MISSING_USER' };
  }
  if (user !== expectedUser || (credentialPresent(credential) && user !== credential.user)) {
    return { decision: 'reject', reasonCode: 'USER_MISMATCH' };
  }
  if (absent(pid) || typeof pid !== 'number') {
    return { decision: 'reject', reasonCode: 'MISSING_PID' };
  }
  if (pid !== expectedPid || (credentialPresent(credential) && pid !== credential.pid)) {
    return { decision: 'reject', reasonCode: 'PID_MISMATCH' };
  }
  if (absent(token) || !credentialPresent(credential)) {
    return { decision: 'reject', reasonCode: 'MISSING_TOKEN' };
  }
  if (!(token instanceof Uint8Array) || token.byteLength !== TOKEN_BYTES) {
    return { decision: 'reject', reasonCode: 'TOKEN_MISMATCH' };
  }
  if (consumed) {
    return { decision: 'reject', reasonCode: 'REPLAYED_TOKEN' };
  }
  const expiresAtMs = own(credential, 'expiresAtMs');
  if (
    typeof expiresAtMs !== 'number' ||
    !Number.isFinite(expiresAtMs) ||
    typeof nowMs !== 'number' ||
    !Number.isFinite(nowMs) ||
    nowMs >= expiresAtMs
  ) {
    return { decision: 'reject', reasonCode: 'STALE_TOKEN' };
  }
  const expected = own(credential, 'token');
  if (!(expected instanceof Uint8Array) || expected.byteLength !== token.byteLength) {
    return { decision: 'reject', reasonCode: 'TOKEN_MISMATCH' };
  }
  let matches = false;
  try {
    matches = timingSafeEqual(token, expected);
  } catch {
    return { decision: 'reject', reasonCode: 'TOKEN_MISMATCH' };
  }
  if (!matches) {
    return { decision: 'reject', reasonCode: 'TOKEN_MISMATCH' };
  }
  return { decision: 'accept', consume: true };
}

export function createAntiReplayStore(): AntiReplayStore {
  const copies: Uint8Array[] = [];
  return {
    consumed(token) {
      if (!(token instanceof Uint8Array) || token.byteLength !== TOKEN_BYTES) return false;
      for (const copy of copies) {
        if (copy.byteLength !== token.byteLength) continue;
        try {
          if (timingSafeEqual(copy, token)) return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    consume(token) {
      if (!(token instanceof Uint8Array) || token.byteLength !== TOKEN_BYTES) return;
      copies.push(new Uint8Array(token));
    },
  };
}

function fallbackResult(explanation: string, fileWritten: boolean): RuntimeResult {
  return {
    decision: 'fallback',
    accepted: true,
    reasonCode: null,
    applied: false,
    toolPermission: false,
    sent: false,
    interrupt: false,
    errorClass: null,
    cacheReused: false,
    restore: 'none',
    explanation,
    fileWritten,
  };
}

function offFile(approvedModel: string, providerRoute: string, policyVersion: string): FallbackFile {
  return {
    schemaVersion: FALLBACK_SCHEMA_VERSION,
    mode: 'off',
    errorClass: null,
    applied: false,
    toolPermission: false,
    approvedModel,
    explanation: OFF_EXPLANATION,
    interrupt: false,
    providerRoute,
    policyVersion,
    cacheReused: false,
    actuationResumed: false,
    restore: 'none',
    cachedChoice: null,
  };
}

async function writeFallbackFile(destination: string, file: FallbackFile): Promise<boolean> {
  const bytes = encodeUtf8(JSON.stringify(file));
  return (await durableWrite(destination, bytes)).ok;
}

async function writeOff(input: RunLocalRuntimeInput): Promise<RuntimeResult> {
  const destination = input.destination;
  if (typeof destination !== 'string' || destination.length === 0) {
    return fallbackResult(OFF_EXPLANATION, false);
  }
  const file = offFile(input.approvedModel, input.providerRoute, input.policyVersion);
  const written = await writeFallbackFile(destination, file);
  return fallbackResult(OFF_EXPLANATION, written);
}

type UnavailableClass = 'timeout' | 'overload' | 'prohibited';

function classifyUnavailable(input: RunLocalRuntimeInput): UnavailableClass | null {
  if (input.networkPolicy === 'prohibited') return 'prohibited';
  if (input.availability === 'timeout') return 'timeout';
  if (input.status === 529) return 'overload';
  return null;
}

function explanationFor(errorClass: UnavailableClass): string {
  if (errorClass === 'timeout') return TIMEOUT_EXPLANATION;
  if (errorClass === 'overload') return OVERLOAD_EXPLANATION;
  return PROHIBITED_EXPLANATION;
}

function unavailableFile(
  approvedModel: string,
  providerRoute: string,
  policyVersion: string,
  errorClass: UnavailableClass,
  explanation: string,
  interrupt: boolean,
  cacheReused: boolean,
  cachedChoice: string | null,
): FallbackFile {
  return {
    schemaVersion: FALLBACK_SCHEMA_VERSION,
    mode: 'unavailable',
    errorClass,
    applied: false,
    toolPermission: false,
    approvedModel,
    explanation,
    interrupt,
    providerRoute,
    policyVersion,
    cacheReused,
    actuationResumed: false,
    restore: 'none',
    cachedChoice,
  };
}

function unavailableResult(
  explanation: string,
  errorClass: UnavailableClass,
  interrupt: boolean,
  fileWritten: boolean,
  cacheReused: boolean,
): RuntimeResult {
  return {
    decision: 'fallback',
    accepted: true,
    reasonCode: null,
    applied: false,
    toolPermission: false,
    sent: false,
    interrupt,
    errorClass,
    cacheReused,
    restore: 'none',
    explanation,
    fileWritten,
  };
}

function validityRecord(value: unknown): { [key: string]: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const record: { [key: string]: string } = {};
  for (const name of VALIDITY_KEY_NAMES) {
    const item = own(value, name);
    if (typeof item !== 'string') return undefined;
    record[name] = item;
  }
  return record;
}

function sameValidity(
  left: { readonly [key: string]: string },
  right: { readonly [key: string]: string },
): boolean {
  for (const name of VALIDITY_KEY_NAMES) {
    if (left[name] !== right[name]) return false;
  }
  return true;
}

const CACHED_OWN_KEYS = [...VALIDITY_KEY_NAMES, 'security', 'choice'];

function exclusiveOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) return false;
  }
  return true;
}

function reusedChoice(input: RunLocalRuntimeInput): {
  readonly cacheReused: boolean;
  readonly cachedChoice: string | null;
} {
  const miss = { cacheReused: false, cachedChoice: null };
  const cached = input.cached;
  const validity = input.validity;
  if (!isPlainObject(cached) || hasDangerousKey(cached) || !exclusiveOwnKeys(cached, CACHED_OWN_KEYS)) {
    return miss;
  }
  if (
    !isPlainObject(validity) ||
    hasDangerousKey(validity) ||
    !exclusiveOwnKeys(validity, VALIDITY_KEY_NAMES)
  ) {
    return miss;
  }
  if (own(cached, 'security') !== false) return miss;
  const choice = own(cached, 'choice');
  if (typeof choice !== 'string' || !safeId(choice)) return miss;
  const current = validityRecord(validity);
  const prior = validityRecord(cached);
  if (current === undefined || prior === undefined) return miss;
  if (!sameValidity(current, prior)) return miss;
  return { cacheReused: true, cachedChoice: choice };
}

async function unavailableFallback(input: RunLocalRuntimeInput): Promise<RuntimeResult | null> {
  const errorClass = classifyUnavailable(input);
  if (errorClass === null) return null;
  const explanation = explanationFor(errorClass);
  const providerRoute = input.providerRoute;
  const policyVersion = input.policyVersion;
  const approvedModel = input.approvedModel;
  const already = input.outages.seen(errorClass, providerRoute, policyVersion);
  const interrupt = !already;
  const reuse = reusedChoice(input);
  const file = unavailableFile(
    approvedModel,
    providerRoute,
    policyVersion,
    errorClass,
    explanation,
    interrupt,
    reuse.cacheReused,
    reuse.cachedChoice,
  );
  if (!already) input.outages.mark(errorClass, providerRoute, policyVersion);
  const destination = input.destination;
  if (typeof destination !== 'string' || destination.length === 0) {
    return unavailableResult(explanation, errorClass, interrupt, false, reuse.cacheReused);
  }
  const written = await writeFallbackFile(destination, file);
  return unavailableResult(explanation, errorClass, interrupt, written, reuse.cacheReused);
}

interface ProbeGate {
  readonly restore: FallbackRestore;
  readonly actuationResumed: false;
}

function restoreFromProbe(value: unknown, policyVersion: string): FallbackRestore {
  if (!isPlainObject(value) || hasDangerousKey(value)) return 'observation';
  if (own(value, 'model') !== PINNED_MODEL) return 'observation';
  if (own(value, 'policyVersion') !== policyVersion) return 'observation';
  return 'none';
}

function maybeProbe(input: RunLocalRuntimeInput): ProbeGate | null {
  if (input.mode !== 'ready') return null;
  if (input.connectivity !== 'returned') return null;
  if (input.circuit !== 'open') return null;
  if (input.networkPolicy === 'prohibited') return null;
  if (input.availability === 'timeout') return null;
  if (input.status === 529) return null;
  if (input.probes.probed()) return null;
  const probe = input.probe;
  if (typeof probe !== 'function') return null;
  input.probes.mark();
  const argument = { kind: 'health' as const };
  let value: unknown;
  try {
    value = probe(argument);
  } catch {
    return { restore: 'none', actuationResumed: false };
  }
  return { restore: restoreFromProbe(value, input.policyVersion), actuationResumed: false };
}

function applyProbe(admitted: RuntimeResult, outcome: ProbeGate | null): RuntimeResult {
  if (outcome === null || admitted.decision !== 'withheld') return admitted;
  return {
    decision: 'withheld',
    accepted: true,
    reasonCode: null,
    applied: false,
    toolPermission: false,
    sent: false,
    interrupt: false,
    errorClass: null,
    cacheReused: false,
    restore: outcome.restore,
    actuationResumed: false,
    fileWritten: false,
  };
}

function withheldReady(): RuntimeResult {
  return {
    decision: 'withheld',
    accepted: true,
    reasonCode: null,
    applied: false,
    toolPermission: false,
    sent: false,
    interrupt: false,
    errorClass: null,
    cacheReused: false,
    restore: 'none',
    actuationResumed: false,
    fileWritten: false,
  };
}

function egressRequest(input: RunLocalRuntimeInput): {
  readonly setting: unknown;
  readonly untrustedClaims?: unknown;
} {
  if (Object.hasOwn(input, 'untrustedClaims')) {
    return { setting: input.egressSetting, untrustedClaims: input.untrustedClaims };
  }
  return { setting: input.egressSetting };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = own(record, key);
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = own(record, key);
  return typeof value === 'number' ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = own(record, key);
  return typeof value === 'boolean' ? value : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value)) return undefined;
  return value;
}

function namedRevision(value: unknown): RecordDecisionArgs['revision'] | undefined {
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  const expected = own(record, 'expected');
  const read = own(record, 'read');
  if (typeof expected !== 'string' || typeof read !== 'function') return undefined;
  return {
    expected,
    read() {
      const next = read();
      return typeof next === 'string' ? next : '';
    },
  };
}

function namedClock(value: unknown): RecordDecisionArgs['clock'] | undefined {
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  const read = own(record, 'read');
  if (typeof read !== 'function') return undefined;
  return {
    read() {
      const next = read();
      return typeof next === 'number' ? next : Number.NaN;
    },
  };
}

function namedSignal(value: unknown): { readonly aborted: boolean } | undefined {
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  const aborted = own(record, 'aborted');
  if (typeof aborted !== 'boolean') return undefined;
  return { aborted };
}

function namedPort(value: unknown): ProviderPort | undefined {
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  return record as unknown as ProviderPort;
}

function namedDecision(ledger: Record<string, unknown>): RecordDecisionArgs | undefined {
  const destination = stringField(ledger, 'destination');
  const decisionId = stringField(ledger, 'decisionId');
  const policyVersion = stringField(ledger, 'policyVersion');
  const evidenceRevision = stringField(ledger, 'evidenceRevision');
  const revision = namedRevision(own(ledger, 'revision'));
  const clock = namedClock(own(ledger, 'clock'));
  const deadlineAtMs = numberField(ledger, 'deadlineAtMs');
  const remainingMicroUsd = stringField(ledger, 'remainingMicroUsd');
  const reservationMicroUsd = stringField(ledger, 'reservationMicroUsd');
  const attempts = numberField(ledger, 'attempts');
  const questions = numberField(ledger, 'questions');
  const stillUseful = booleanField(ledger, 'stillUseful');
  const port = namedPort(own(ledger, 'port'));
  const signal = namedSignal(own(ledger, 'signal'));
  if (
    destination === undefined ||
    decisionId === undefined ||
    policyVersion === undefined ||
    evidenceRevision === undefined ||
    revision === undefined ||
    clock === undefined ||
    deadlineAtMs === undefined ||
    remainingMicroUsd === undefined ||
    reservationMicroUsd === undefined ||
    attempts === undefined ||
    questions === undefined ||
    stillUseful === undefined ||
    port === undefined ||
    signal === undefined
  ) {
    return undefined;
  }
  const spec = own(ledger, 'spec');
  const evaluationInput = own(ledger, 'input');
  if (!Object.hasOwn(ledger, 'usage')) {
    return {
      destination,
      decisionId,
      policyVersion,
      evidenceRevision,
      revision,
      clock,
      deadlineAtMs,
      remainingMicroUsd,
      reservationMicroUsd,
      attempts,
      questions,
      stillUseful,
      spec,
      input: evaluationInput,
      port,
      signal,
    };
  }
  const withUsage = {
    destination,
    decisionId,
    policyVersion,
    evidenceRevision,
    revision,
    clock,
    deadlineAtMs,
    remainingMicroUsd,
    reservationMicroUsd,
    attempts,
    questions,
    stillUseful,
    spec,
    input: evaluationInput,
    port,
    signal,
    usage: own(ledger, 'usage'),
  };
  return withUsage as unknown as RecordDecisionArgs;
}

async function admitReady(input: RunLocalRuntimeInput): Promise<RuntimeResult> {
  const egress = decideEgress(egressRequest(input));
  if (egress.decision !== 'allow') return withheldReady();
  if (!Object.hasOwn(input, 'ledger')) return withheldReady();
  const ledger = plainRecord(input.ledger);
  if (ledger === undefined) return withheldReady();
  const args = namedDecision(ledger);
  if (args === undefined) return withheldReady();
  try {
    const recorded = await recordDecision(args);
    return {
      decision: 'withheld',
      accepted: true,
      reasonCode: null,
      applied: recorded.applied,
      toolPermission: false,
      sent: false,
      interrupt: false,
      errorClass: null,
      cacheReused: false,
      restore: 'none',
      actuationResumed: false,
      fileWritten: false,
    };
  } catch {
    return withheldReady();
  }
}

function parseFallback(value: Record<string, unknown>): FallbackFile | undefined {
  if (value.schemaVersion !== FALLBACK_SCHEMA_VERSION) return undefined;
  if (!isFallbackMode(value.mode)) return undefined;
  if (!isErrorClass(value.errorClass)) return undefined;
  if (value.applied !== false) return undefined;
  if (value.toolPermission !== false) return undefined;
  if (typeof value.approvedModel !== 'string') return undefined;
  if (typeof value.explanation !== 'string') return undefined;
  if (typeof value.interrupt !== 'boolean') return undefined;
  if (typeof value.providerRoute !== 'string') return undefined;
  if (typeof value.policyVersion !== 'string') return undefined;
  if (typeof value.cacheReused !== 'boolean') return undefined;
  if (value.actuationResumed !== false) return undefined;
  if (!isRestore(value.restore)) return undefined;
  const cachedChoice = value.cachedChoice;
  if (cachedChoice !== null && (typeof cachedChoice !== 'string' || !safeId(cachedChoice))) {
    return undefined;
  }
  return {
    schemaVersion: FALLBACK_SCHEMA_VERSION,
    mode: value.mode,
    errorClass: value.errorClass,
    applied: false,
    toolPermission: false,
    approvedModel: value.approvedModel,
    explanation: value.explanation,
    interrupt: value.interrupt,
    providerRoute: value.providerRoute,
    policyVersion: value.policyVersion,
    cacheReused: value.cacheReused,
    actuationResumed: false,
    restore: value.restore,
    cachedChoice,
  };
}

export async function readFallbackFile(destination: string): Promise<ReadFallbackFileResult> {
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
  if (!isPlainObject(parsed) || hasDangerousKey(parsed) || !sameKeys(parsed, FALLBACK_KEYS)) {
    return schemaFailure();
  }
  const file = parseFallback(parsed);
  if (file === undefined) return schemaFailure();
  return { ok: true, file };
}

export async function runLocalRuntime(input: RunLocalRuntimeInput): Promise<RuntimeResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return reject('MALFORMED');
  const caller = input.caller;
  if (!isPlainObject(caller) || hasDangerousKey(caller)) return reject('MALFORMED');
  const presentedToken = own(caller, 'token');
  const consumed = presentedToken instanceof Uint8Array && input.replay.consumed(presentedToken);
  const auth = authorizeLocalCaller(
    caller,
    input.expectedUser,
    input.expectedPid,
    input.credential,
    input.nowMs,
    consumed,
  );
  if (auth.decision === 'reject') return reject(auth.reasonCode);
  if (presentedToken instanceof Uint8Array) input.replay.consume(presentedToken);
  if (input.mode !== 'ready') {
    if (input.mode === 'off') return writeOff(input);
    return fallbackResult(NOT_READY_EXPLANATION, false);
  }
  const unavailable = await unavailableFallback(input);
  if (unavailable !== null) return unavailable;
  const outcome = maybeProbe(input);
  return applyProbe(await admitReady(input), outcome);
}
