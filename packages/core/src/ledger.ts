import { readFile } from 'node:fs/promises';
import { durableWrite } from '@jevris/platform';
import type {
  DecisionFileRecord,
  DecisionLedgerFile,
  DecisionUsage,
  FreshDecision,
  LedgerOutcome,
  LedgerReasonCode,
  ProviderPort,
} from '@jevris/contracts';
import { evaluateChoice } from './kernel.js';
import { jevCostMicroUsd, type DecisionBudget } from './decision-budget.js';

/**
 * Local decision file. Named fields only. applied stays false.
 * The caller supplies the clock and the revision. This module does not send.
 *
 * Budget (DATA-06, DATA-07, SSOT §19.4). With a shared `DecisionBudget`, a call reserves
 * before the port is entered and settles afterwards: known usage commits its actual cost, a
 * provider error or a call that never reached the provider releases, and a timeout or any
 * other outcome with unknown usage holds the reservation until it is reconciled. The budget
 * file is locked across processes, so separate processes never exceed the envelope. Without
 * one, the file's own reservations are subtracted from the caller's remaining amount. Unknown
 * usage in either case is a conservative hold: it counts, but it never refuses a later
 * decision that still fits (the old rule refused every decision after one unknown usage).
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MONEY_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);

const ADVISORY_EXPLANATION = 'Decision recorded. No action was applied.';
const SCHEMA_EXPLANATION = 'Decision stored and not applied: schema failure.';
const DEADLINE_EXPLANATION = 'Decision stored and not applied: deadline passed. Rules-only fallback.';
const STALE_EXPLANATION = 'Decision stored and not applied: repository revision changed.';
const BUDGET_EXPLANATION = 'Decision stored and not applied: budget bound.';
const OTHER_EXPLANATION = 'Decision stored and not applied.';

const FILE_KEYS = ['schemaVersion', 'records'] as const;
const RECORD_KEYS = [
  'schemaVersion',
  'decisionId',
  'policyVersion',
  'evidenceRevision',
  'resolvedModel',
  'outcome',
  'reasonCode',
  'usage',
  'applied',
  'explanation',
  'nonOwnedBilling',
  'freshDecision',
  'reservationMicroUsd',
] as const;
const REASON_CODES: readonly LedgerReasonCode[] = [
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'MODEL_MISMATCH',
  'REQUEST_TOO_LARGE',
  'RESPONSE_TOO_LARGE',
  'DEADLINE',
  'CANCELLED',
  'INELIGIBLE',
  'KNOWN_FAILURE',
  'INTEGER_COUNT',
  'CHOICE_RECORDED',
  'STALE',
  'BUDGET',
];

export interface RecordDecisionResult {
  readonly applied: false;
  readonly outcome: LedgerOutcome;
  readonly reasonCode: LedgerReasonCode;
  readonly freshDecision: FreshDecision;
  readonly fileWritten: boolean;
}

export type ReadDecisionFileResult =
  | { readonly ok: true; readonly file: DecisionLedgerFile }
  | { readonly ok: false; readonly reasonCode: 'SCHEMA_FAILURE' };

export interface RecordDecisionArgs {
  readonly destination: string;
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly evidenceRevision: string;
  readonly revision: {
    readonly expected: string;
    read(): string;
  };
  readonly clock: {
    read(): number;
  };
  readonly deadlineAtMs: number;
  readonly remainingMicroUsd: string;
  readonly reservationMicroUsd: string;
  readonly attempts: number;
  readonly questions: number;
  readonly stillUseful: boolean;
  readonly spec: unknown;
  readonly input: unknown;
  readonly port: ProviderPort;
  readonly signal: { readonly aborted: boolean };
  readonly sourceText?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  /** The shared decision budget; when present it is the envelope. */
  readonly budget?: LedgerBudget;
  /** The workspace the reservation is charged to (default `global`). */
  readonly workspaceId?: string;
  /** Jev tariff for the actual cost of known usage; without one the reservation is charged. */
  readonly tariff?: { readonly inputMicroUsdPerMillion: number; readonly outputMicroUsdPerMillion: number };
}

/** The parts of C's DecisionBudget this ledger uses. */
export type LedgerBudget = Pick<DecisionBudget, 'reserve' | 'commit' | 'release' | 'hold'>;

interface AdmittedCall {
  readonly destination: string;
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly evidenceRevision: string;
  readonly revision: {
    readonly expected: string;
    read(): string;
  };
  readonly clock: {
    read(): number;
  };
  readonly deadlineAtMs: number;
  readonly remainingMicroUsd: string;
  readonly reservationMicroUsd: string;
  readonly attempts: number;
  readonly questions: number;
  readonly stillUseful: boolean;
  readonly spec: unknown;
  readonly evaluationInput: unknown;
  readonly port: ProviderPort;
  readonly signal: { readonly aborted: boolean };
  readonly usage: unknown;
  readonly budget: LedgerBudget | undefined;
  readonly workspaceId: string;
  readonly tariff: RecordDecisionArgs['tariff'];
}

type LoadedLedger =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly file: DecisionLedgerFile };

const writers = new Map<string, Promise<void>>();

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

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (!expected.includes(key)) return false;
  }
  return true;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !dangerous.has(value);
}

function safeRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value) && !dangerous.has(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseMoney(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) return undefined;
  return BigInt(value);
}

function isReasonCode(value: unknown): value is LedgerReasonCode {
  return typeof value === 'string' && REASON_CODES.includes(value as LedgerReasonCode);
}

function isOutcome(value: unknown): value is LedgerOutcome {
  return value === 'advisory' || value === 'refused' || value === 'stale';
}

function isFresh(value: unknown): value is FreshDecision {
  return value === 'scheduled' || value === 'not-scheduled';
}

function explanation(outcome: LedgerOutcome, reasonCode: LedgerReasonCode): string {
  if (outcome === 'advisory') return ADVISORY_EXPLANATION;
  if (reasonCode === 'INVALID_RESPONSE') return SCHEMA_EXPLANATION;
  if (reasonCode === 'DEADLINE') return DEADLINE_EXPLANATION;
  if (reasonCode === 'STALE') return STALE_EXPLANATION;
  if (reasonCode === 'BUDGET') return BUDGET_EXPLANATION;
  return OTHER_EXPLANATION;
}

function freshDecisionFlag(): FreshDecision {
  return 'not-scheduled';
}

function scheduleFreshDecision(
  latestRevision: string | undefined,
  expected: string,
  stillUseful: boolean,
  latestClock: number,
  deadlineAtMs: number,
  attempts: number,
  questions: number,
  existing: readonly DecisionFileRecord[],
  remainingMicroUsd: string,
  reservationMicroUsd: string,
  consumedMicroUsd: string,
): FreshDecision {
  if (latestRevision === expected || !stillUseful) return 'not-scheduled';
  if (!Number.isFinite(latestClock) || !Number.isFinite(deadlineAtMs) || latestClock >= deadlineAtMs) {
    return 'not-scheduled';
  }
  if (attempts !== 1 || questions !== 1) return 'not-scheduled';
  for (const record of existing) {
    if (!record.usage.known) return 'not-scheduled';
  }
  const remaining = parseMoney(remainingMicroUsd);
  const reservation = parseMoney(reservationMicroUsd);
  const consumed = parseMoney(consumedMicroUsd);
  const stored = storedReservationSum(existing);
  if (remaining === undefined || reservation === undefined || consumed === undefined || stored === undefined) {
    return 'not-scheduled';
  }
  if (remaining - stored - consumed >= reservation) return 'scheduled';
  return 'not-scheduled';
}

function unknownUsage(): DecisionUsage {
  return { known: false };
}

function storedReservationSum(existing: readonly DecisionFileRecord[]): bigint | undefined {
  let stored = 0n;
  for (const record of existing) {
    const value = parseMoney(record.reservationMicroUsd);
    if (value === undefined) return undefined;
    stored += value;
  }
  return stored;
}

function closedResult(
  outcome: LedgerOutcome,
  reasonCode: LedgerReasonCode,
  fileWritten: boolean,
  freshDecision: FreshDecision = freshDecisionFlag(),
): RecordDecisionResult {
  return {
    applied: false,
    outcome,
    reasonCode,
    freshDecision,
    fileWritten,
  };
}

function refuseUnsafe(): RecordDecisionResult {
  return closedResult('refused', 'INVALID_REQUEST', false);
}

function encodeUtf8(text: string): Uint8Array {
  const Ctor = (globalThis as unknown as { TextEncoder?: new () => { encode(input?: string): Uint8Array } }).TextEncoder;
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

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return Reflect.get(error, 'code') === 'ENOENT';
}

function readClock(clock: { read(): number }): number {
  try {
    const value = clock.read();
    return typeof value === 'number' ? value : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function readRevision(revision: { read(): string }): string | undefined {
  try {
    const value = revision.read();
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function clockMiss(now: number, deadlineAtMs: number): boolean {
  return !Number.isFinite(now) || !Number.isFinite(deadlineAtMs) || now >= deadlineAtMs;
}

function acceptUsage(value: unknown): DecisionUsage | 'invalid' | 'omitted' {
  if (value === undefined) return 'omitted';
  if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, ['inputTokens', 'outputTokens'])) {
    return 'invalid';
  }
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (!isCount(inputTokens) || !isCount(outputTokens)) return 'invalid';
  return { known: true, inputTokens, outputTokens };
}

function usageFromFile(value: unknown): DecisionUsage | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value)) return undefined;
  if (value.known === false) {
    if (!sameKeys(value, ['known'])) return undefined;
    return { known: false };
  }
  if (value.known !== true || !sameKeys(value, ['known', 'inputTokens', 'outputTokens'])) return undefined;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined;
  return { known: true, inputTokens, outputTokens };
}

function recordFromFile(value: unknown): DecisionFileRecord | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, RECORD_KEYS)) return undefined;
  if (value.schemaVersion !== '1.0') return undefined;
  if (!safeId(value.decisionId) || !safeId(value.policyVersion) || !safeRevision(value.evidenceRevision)) {
    return undefined;
  }
  const resolvedModel = value.resolvedModel;
  if (resolvedModel !== null && typeof resolvedModel !== 'string') return undefined;
  if (!isOutcome(value.outcome) || !isReasonCode(value.reasonCode)) return undefined;
  const usage = usageFromFile(value.usage);
  if (usage === undefined) return undefined;
  if (value.applied !== false || value.nonOwnedBilling !== 'unknown') return undefined;
  if (typeof value.explanation !== 'string') return undefined;
  if (value.explanation !== explanation(value.outcome, value.reasonCode)) return undefined;
  if (!isFresh(value.freshDecision)) return undefined;
  if (typeof value.reservationMicroUsd !== 'string' || !MONEY_PATTERN.test(value.reservationMicroUsd)) {
    return undefined;
  }
  return {
    schemaVersion: '1.0',
    decisionId: value.decisionId,
    policyVersion: value.policyVersion,
    evidenceRevision: value.evidenceRevision,
    resolvedModel,
    outcome: value.outcome,
    reasonCode: value.reasonCode,
    usage,
    applied: false,
    explanation: value.explanation,
    nonOwnedBilling: 'unknown',
    freshDecision: value.freshDecision,
    reservationMicroUsd: value.reservationMicroUsd,
  };
}

function fileFromParsed(value: unknown): DecisionLedgerFile | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, FILE_KEYS)) return undefined;
  if (value.schemaVersion !== '1.0' || !Array.isArray(value.records)) return undefined;
  if (hasDangerousKey(value.records)) return undefined;
  const records: DecisionFileRecord[] = [];
  const seen = new Set<string>();
  for (const item of value.records) {
    const record = recordFromFile(item);
    if (record === undefined || seen.has(record.decisionId)) return undefined;
    seen.add(record.decisionId);
    records.push(record);
  }
  return { schemaVersion: '1.0', records };
}

function parseLedgerText(text: string): DecisionLedgerFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return fileFromParsed(parsed);
}

async function loadLedger(destination: string): Promise<LoadedLedger> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(destination);
  } catch (error) {
    if (isNotFound(error)) return { status: 'missing' };
    return { status: 'invalid' };
  }
  const text = decodeUtf8Fatal(bytes);
  if (text === undefined) return { status: 'invalid' };
  const file = parseLedgerText(text);
  if (file === undefined) return { status: 'invalid' };
  return { status: 'ok', file };
}

function buildRecord(
  decisionId: string,
  policyVersion: string,
  evidenceRevision: string,
  resolvedModel: string | null,
  outcome: LedgerOutcome,
  reasonCode: LedgerReasonCode,
  usage: DecisionUsage,
  reservationMicroUsd: string,
  freshDecision: FreshDecision = freshDecisionFlag(),
): DecisionFileRecord {
  return {
    schemaVersion: '1.0',
    decisionId,
    policyVersion,
    evidenceRevision,
    resolvedModel,
    outcome,
    reasonCode,
    usage,
    applied: false,
    explanation: explanation(outcome, reasonCode),
    nonOwnedBilling: 'unknown',
    freshDecision,
    reservationMicroUsd,
  };
}

async function replaceLedger(destination: string, decisionId: string, file: DecisionLedgerFile): Promise<boolean> {
  if (!safeId(decisionId)) return false;
  const bytes = encodeUtf8(JSON.stringify(file));
  return (await durableWrite(destination, bytes)).ok;
}

async function persist(
  destination: string,
  existing: readonly DecisionFileRecord[],
  record: DecisionFileRecord,
): Promise<boolean> {
  const file: DecisionLedgerFile = {
    schemaVersion: '1.0',
    records: [...existing, record],
  };
  return replaceLedger(destination, record.decisionId, file);
}

function findRecord(records: readonly DecisionFileRecord[], decisionId: string): DecisionFileRecord | undefined {
  for (const record of records) {
    if (record.decisionId === decisionId) return record;
  }
  return undefined;
}

function resultFromRecord(record: DecisionFileRecord, fileWritten: boolean): RecordDecisionResult {
  return closedResult(record.outcome, record.reasonCode, fileWritten, record.freshDecision);
}

function resolvedModelOf(record: { readonly resolvedModel?: string }, rules: boolean): string | null {
  if (rules) return null;
  return typeof record.resolvedModel === 'string' ? record.resolvedModel : null;
}

function enqueue(destination: string, work: () => Promise<RecordDecisionResult>): Promise<RecordDecisionResult> {
  const previous = writers.get(destination) ?? Promise.resolve();
  const run = previous.then(work, work);
  writers.set(destination, run.then(() => undefined, () => undefined));
  return run;
}

function admit(input: RecordDecisionArgs): AdmittedCall | RecordDecisionResult {
  if (!isPlainObject(input) || hasDangerousKey(input)) return refuseUnsafe();
  const destination = input.destination;
  const decisionId = input.decisionId;
  const policyVersion = input.policyVersion;
  const evidenceRevision = input.evidenceRevision;
  const revision = input.revision;
  const clock = input.clock;
  const port = input.port;
  const signal = input.signal;
  if (typeof destination !== 'string' || destination.length === 0) return refuseUnsafe();
  if (!safeId(decisionId) || !safeId(policyVersion) || !safeRevision(evidenceRevision)) return refuseUnsafe();
  if (!isPlainObject(revision) || hasDangerousKey(revision) || typeof revision.read !== 'function') {
    return refuseUnsafe();
  }
  if (!safeRevision(revision.expected)) return refuseUnsafe();
  if (!isPlainObject(clock) || hasDangerousKey(clock) || typeof clock.read !== 'function') return refuseUnsafe();
  if (!isPlainObject(port) || hasDangerousKey(port) || typeof port.evaluate !== 'function') return refuseUnsafe();
  if (typeof signal !== 'object' || signal === null || typeof signal.aborted !== 'boolean') return refuseUnsafe();
  if (typeof input.stillUseful !== 'boolean') return refuseUnsafe();
  const budget = input.budget;
  if (budget !== undefined && (budget === null || typeof budget !== 'object' || typeof budget.reserve !== 'function' || typeof budget.commit !== 'function' || typeof budget.release !== 'function' || typeof budget.hold !== 'function')) {
    return refuseUnsafe();
  }
  const workspaceId = input.workspaceId ?? 'global';
  if (!safeRevision(workspaceId)) return refuseUnsafe();
  return {
    destination,
    decisionId,
    policyVersion,
    evidenceRevision,
    revision: {
      expected: revision.expected,
      read: () => revision.read(),
    },
    clock: {
      read: () => clock.read(),
    },
    deadlineAtMs: input.deadlineAtMs,
    remainingMicroUsd: input.remainingMicroUsd,
    reservationMicroUsd: input.reservationMicroUsd,
    attempts: input.attempts,
    questions: input.questions,
    stillUseful: input.stillUseful,
    spec: input.spec,
    evaluationInput: input.input,
    port,
    signal,
    usage: input.usage,
    budget,
    workspaceId,
    tariff: input.tariff,
  };
}

type Settlement = 'commit' | 'release' | 'hold';

/** Settles a budget reservation; a failed settle leaves it reserved, which still counts. */
async function settle(call: AdmittedCall, reservationId: string | undefined, how: Settlement, usage: DecisionUsage, reservation: bigint): Promise<void> {
  if (call.budget === undefined || reservationId === undefined) return;
  try {
    if (how === 'release') await call.budget.release(reservationId);
    else if (how === 'hold' || !usage.known) await call.budget.hold(reservationId);
    else {
      const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      const actual = call.tariff === undefined ? Number(reservation) : jevCostMicroUsd(tokens.inputTokens, tokens.outputTokens, call.tariff);
      await call.budget.commit(reservationId, { usage: tokens, actualMicroUsd: actual });
    }
  } catch {
    // The reservation stays open and counted; reconciliation or hold expiry settles it.
  }
}

async function storeRefusal(
  call: AdmittedCall,
  existing: readonly DecisionFileRecord[],
  outcome: LedgerOutcome,
  reasonCode: LedgerReasonCode,
  resolvedModel: string | null,
  usage: DecisionUsage,
  reservationMicroUsd: string,
  freshDecision: FreshDecision = freshDecisionFlag(),
): Promise<RecordDecisionResult> {
  const record = buildRecord(
    call.decisionId,
    call.policyVersion,
    call.evidenceRevision,
    resolvedModel,
    outcome,
    reasonCode,
    usage,
    reservationMicroUsd,
    freshDecision,
  );
  const fileWritten = await persist(call.destination, existing, record);
  return closedResult(outcome, reasonCode, fileWritten, freshDecision);
}

async function decide(call: AdmittedCall): Promise<RecordDecisionResult> {
  const loaded = await loadLedger(call.destination);
  if (loaded.status === 'invalid') return closedResult('refused', 'INVALID_REQUEST', false);
  const existing = loaded.status === 'ok' ? loaded.file.records : [];
  const prior = findRecord(existing, call.decisionId);
  if (prior !== undefined) return resultFromRecord(prior, false);

  const now = readClock(call.clock);
  if (clockMiss(now, call.deadlineAtMs)) {
    return storeRefusal(call, existing, 'refused', 'DEADLINE', null, unknownUsage(), '0', 'not-scheduled');
  }
  const currentRevision = readRevision(call.revision);
  if (currentRevision !== call.revision.expected) {
    return storeRefusal(
      call,
      existing,
      'stale',
      'STALE',
      null,
      unknownUsage(),
      '0',
      scheduleFreshDecision(
        currentRevision,
        call.revision.expected,
        call.stillUseful,
        now,
        call.deadlineAtMs,
        call.attempts,
        call.questions,
        existing,
        call.remainingMicroUsd,
        call.reservationMicroUsd,
        '0',
      ),
    );
  }
  const remaining = parseMoney(call.remainingMicroUsd);
  const reservation = parseMoney(call.reservationMicroUsd);
  const usage = acceptUsage(call.usage);
  const held = storedReservationSum(existing);
  if (
    call.attempts !== 1
    || call.questions !== 1
    || remaining === undefined
    || reservation === undefined
    || held === undefined
    || usage === 'invalid'
    || (call.budget === undefined && remaining - held < reservation)
  ) {
    return storeRefusal(call, existing, 'refused', 'BUDGET', null, unknownUsage(), '0');
  }
  let reservationId: string | undefined;
  if (call.budget !== undefined) {
    let reserved: Awaited<ReturnType<LedgerBudget['reserve']>> | undefined;
    try {
      reserved = reservation <= BigInt(Number.MAX_SAFE_INTEGER)
        ? await call.budget.reserve({ decisionId: call.decisionId, workspaceId: call.workspaceId, microUsd: Number(reservation) })
        : undefined;
    } catch {
      reserved = undefined;
    }
    if (reserved === undefined || !reserved.ok) return storeRefusal(call, existing, 'refused', 'BUDGET', null, unknownUsage(), '0');
    reservationId = reserved.reservation.id;
  }
  const storedUsage = usage === 'omitted' ? unknownUsage() : usage;

  let kernel: Awaited<ReturnType<typeof evaluateChoice>>;
  try {
    kernel = await evaluateChoice(call.spec, call.evaluationInput, {
      port: call.port,
      deadlineAtMs: call.deadlineAtMs,
      signal: call.signal,
    });
  } catch {
    // A provider error is a failed call: its reservation is released (DATA-06).
    await settle(call, reservationId, 'release', storedUsage, reservation);
    return storeRefusal(call, existing, 'refused', 'KNOWN_FAILURE', null, storedUsage, call.reservationMicroUsd);
  }

  const afterClock = readClock(call.clock);
  const afterRevision = readRevision(call.revision);
  const rules = kernel.disposition === 'rules';
  const resolvedModel = resolvedModelOf(kernel, rules);
  if (clockMiss(afterClock, call.deadlineAtMs)) {
    // A deadline after the call may have been billed: hold until reconciled (DATA-07).
    await settle(call, reservationId, 'hold', storedUsage, reservation);
    return storeRefusal(
      call,
      existing,
      'refused',
      'DEADLINE',
      resolvedModel,
      storedUsage,
      call.reservationMicroUsd,
      'not-scheduled',
    );
  }
  if (afterRevision !== call.revision.expected) {
    await settle(call, reservationId, 'commit', storedUsage, reservation);
    return storeRefusal(
      call,
      existing,
      'stale',
      'STALE',
      resolvedModel,
      storedUsage,
      call.reservationMicroUsd,
      scheduleFreshDecision(
        afterRevision,
        call.revision.expected,
        call.stillUseful,
        afterClock,
        call.deadlineAtMs,
        call.attempts,
        call.questions,
        existing,
        call.remainingMicroUsd,
        call.reservationMicroUsd,
        call.reservationMicroUsd,
      ),
    );
  }
  await settle(call, reservationId, 'commit', storedUsage, reservation);
  if (rules || (kernel.disposition === 'abstained' && kernel.reasonCode === 'CHOICE_RECORDED')) {
    return storeRefusal(call, existing, 'advisory', kernel.reasonCode, resolvedModel, storedUsage, call.reservationMicroUsd);
  }
  return storeRefusal(call, existing, 'refused', kernel.reasonCode, null, storedUsage, call.reservationMicroUsd);
}

export async function recordDecision(input: RecordDecisionArgs): Promise<RecordDecisionResult> {
  const admitted = admit(input);
  if (!('destination' in admitted) || !('evaluationInput' in admitted)) return admitted;
  return enqueue(admitted.destination, () => decide(admitted));
}

export async function readDecisionFile(destination: string): Promise<ReadDecisionFileResult> {
  if (typeof destination !== 'string' || destination.length === 0) {
    return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
  }
  try {
    const loaded = await loadLedger(destination);
    if (loaded.status !== 'ok') return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
    return { ok: true, file: loaded.file };
  } catch {
    return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
  }
}
