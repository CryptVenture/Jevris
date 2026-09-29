import { open, readFile, rename, rm } from 'node:fs/promises';
import { evaluateChoice } from './kernel.js';
/**
 * Local decision file. Named fields only. applied stays false.
 * The caller supplies the clock and the revision. This module does not send.
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
const FILE_KEYS = ['schemaVersion', 'records'];
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
];
const REASON_CODES = [
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
const writers = new Map();
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.getPrototypeOf(value) === Object.prototype;
}
function hasDangerousKey(value) {
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || dangerous.has(key))
            return true;
    }
    return false;
}
function sameKeys(value, expected) {
    const keys = Object.keys(value);
    if (keys.length !== expected.length)
        return false;
    for (const key of keys) {
        if (!expected.includes(key))
            return false;
    }
    return true;
}
function safeId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value) && !dangerous.has(value);
}
function safeRevision(value) {
    return typeof value === 'string' && REVISION_PATTERN.test(value) && !dangerous.has(value);
}
function isCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseMoney(value) {
    if (typeof value !== 'string' || !MONEY_PATTERN.test(value))
        return undefined;
    return BigInt(value);
}
function isReasonCode(value) {
    return typeof value === 'string' && REASON_CODES.includes(value);
}
function isOutcome(value) {
    return value === 'advisory' || value === 'refused' || value === 'stale';
}
function isFresh(value) {
    return value === 'scheduled' || value === 'not-scheduled';
}
function explanation(outcome, reasonCode) {
    if (outcome === 'advisory')
        return ADVISORY_EXPLANATION;
    if (reasonCode === 'INVALID_RESPONSE')
        return SCHEMA_EXPLANATION;
    if (reasonCode === 'DEADLINE')
        return DEADLINE_EXPLANATION;
    if (reasonCode === 'STALE')
        return STALE_EXPLANATION;
    if (reasonCode === 'BUDGET')
        return BUDGET_EXPLANATION;
    return OTHER_EXPLANATION;
}
function freshDecisionFlag() {
    return 'not-scheduled';
}
function scheduleFreshDecision(latestRevision, expected, stillUseful, latestClock, deadlineAtMs, attempts, questions, existing, remainingMicroUsd, reservationMicroUsd, consumedMicroUsd) {
    if (latestRevision === expected || !stillUseful)
        return 'not-scheduled';
    if (!Number.isFinite(latestClock) || !Number.isFinite(deadlineAtMs) || latestClock >= deadlineAtMs) {
        return 'not-scheduled';
    }
    if (attempts !== 1 || questions !== 1)
        return 'not-scheduled';
    for (const record of existing) {
        if (!record.usage.known)
            return 'not-scheduled';
    }
    const remaining = parseMoney(remainingMicroUsd);
    const reservation = parseMoney(reservationMicroUsd);
    const consumed = parseMoney(consumedMicroUsd);
    const stored = storedReservationSum(existing);
    if (remaining === undefined || reservation === undefined || consumed === undefined || stored === undefined) {
        return 'not-scheduled';
    }
    if (remaining - stored - consumed >= reservation)
        return 'scheduled';
    return 'not-scheduled';
}
function unknownUsage() {
    return { known: false };
}
function storedReservationSum(existing) {
    let stored = 0n;
    for (const record of existing) {
        const value = parseMoney(record.reservationMicroUsd);
        if (value === undefined)
            return undefined;
        stored += value;
    }
    return stored;
}
function hasUnknownUsage(existing) {
    for (const record of existing) {
        if (!record.usage.known)
            return true;
    }
    return false;
}
function closedResult(outcome, reasonCode, fileWritten, freshDecision = freshDecisionFlag()) {
    return {
        applied: false,
        outcome,
        reasonCode,
        freshDecision,
        fileWritten,
    };
}
function refuseUnsafe() {
    return closedResult('refused', 'INVALID_REQUEST', false);
}
function encodeUtf8(text) {
    const Ctor = globalThis.TextEncoder;
    if (Ctor === undefined)
        return new Uint8Array();
    return new Ctor().encode(text);
}
function decodeUtf8Fatal(bytes) {
    const Ctor = globalThis.TextDecoder;
    if (Ctor === undefined)
        return undefined;
    try {
        return new Ctor('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return undefined;
    }
}
function isNotFound(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    return Reflect.get(error, 'code') === 'ENOENT';
}
function readClock(clock) {
    try {
        const value = clock.read();
        return typeof value === 'number' ? value : Number.NaN;
    }
    catch {
        return Number.NaN;
    }
}
function readRevision(revision) {
    try {
        const value = revision.read();
        return typeof value === 'string' ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function clockMiss(now, deadlineAtMs) {
    return !Number.isFinite(now) || !Number.isFinite(deadlineAtMs) || now >= deadlineAtMs;
}
function acceptUsage(value) {
    if (value === undefined)
        return 'omitted';
    if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, ['inputTokens', 'outputTokens'])) {
        return 'invalid';
    }
    const inputTokens = value.inputTokens;
    const outputTokens = value.outputTokens;
    if (!isCount(inputTokens) || !isCount(outputTokens))
        return 'invalid';
    return { known: true, inputTokens, outputTokens };
}
function usageFromFile(value) {
    if (!isPlainObject(value) || hasDangerousKey(value))
        return undefined;
    if (value.known === false) {
        if (!sameKeys(value, ['known']))
            return undefined;
        return { known: false };
    }
    if (value.known !== true || !sameKeys(value, ['known', 'inputTokens', 'outputTokens']))
        return undefined;
    const inputTokens = value.inputTokens;
    const outputTokens = value.outputTokens;
    if (!isCount(inputTokens) || !isCount(outputTokens))
        return undefined;
    return { known: true, inputTokens, outputTokens };
}
function recordFromFile(value) {
    if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, RECORD_KEYS))
        return undefined;
    if (value.schemaVersion !== '1.0')
        return undefined;
    if (!safeId(value.decisionId) || !safeId(value.policyVersion) || !safeRevision(value.evidenceRevision)) {
        return undefined;
    }
    const resolvedModel = value.resolvedModel;
    if (resolvedModel !== null && typeof resolvedModel !== 'string')
        return undefined;
    if (!isOutcome(value.outcome) || !isReasonCode(value.reasonCode))
        return undefined;
    const usage = usageFromFile(value.usage);
    if (usage === undefined)
        return undefined;
    if (value.applied !== false || value.nonOwnedBilling !== 'unknown')
        return undefined;
    if (typeof value.explanation !== 'string')
        return undefined;
    if (value.explanation !== explanation(value.outcome, value.reasonCode))
        return undefined;
    if (!isFresh(value.freshDecision))
        return undefined;
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
function fileFromParsed(value) {
    if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, FILE_KEYS))
        return undefined;
    if (value.schemaVersion !== '1.0' || !Array.isArray(value.records))
        return undefined;
    if (hasDangerousKey(value.records))
        return undefined;
    const records = [];
    const seen = new Set();
    for (const item of value.records) {
        const record = recordFromFile(item);
        if (record === undefined || seen.has(record.decisionId))
            return undefined;
        seen.add(record.decisionId);
        records.push(record);
    }
    return { schemaVersion: '1.0', records };
}
function parseLedgerText(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    return fileFromParsed(parsed);
}
async function loadLedger(destination) {
    let bytes;
    try {
        bytes = await readFile(destination);
    }
    catch (error) {
        if (isNotFound(error))
            return { status: 'missing' };
        return { status: 'invalid' };
    }
    const text = decodeUtf8Fatal(bytes);
    if (text === undefined)
        return { status: 'invalid' };
    const file = parseLedgerText(text);
    if (file === undefined)
        return { status: 'invalid' };
    return { status: 'ok', file };
}
function buildRecord(decisionId, policyVersion, evidenceRevision, resolvedModel, outcome, reasonCode, usage, reservationMicroUsd, freshDecision = freshDecisionFlag()) {
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
async function replaceLedger(destination, decisionId, file) {
    if (!safeId(decisionId))
        return false;
    const bytes = encodeUtf8(JSON.stringify(file));
    const temp = `${destination}.${decisionId}.tmp`;
    let created = false;
    let handle;
    try {
        handle = await open(temp, 'wx', 0o600);
        created = true;
        await handle.writeFile(bytes, { flush: true });
        await handle.close();
        handle = undefined;
        await rename(temp, destination);
        return true;
    }
    catch {
        if (handle !== undefined) {
            try {
                await handle.close();
            }
            catch {
                // The temp is removed below. The error text is not stored.
            }
        }
        if (created) {
            try {
                await rm(temp);
            }
            catch {
                // Only the temp this call created is removed.
            }
        }
        return false;
    }
}
async function persist(destination, existing, record) {
    const file = {
        schemaVersion: '1.0',
        records: [...existing, record],
    };
    return replaceLedger(destination, record.decisionId, file);
}
function findRecord(records, decisionId) {
    for (const record of records) {
        if (record.decisionId === decisionId)
            return record;
    }
    return undefined;
}
function resultFromRecord(record, fileWritten) {
    return closedResult(record.outcome, record.reasonCode, fileWritten, record.freshDecision);
}
function resolvedModelOf(record, rules) {
    if (rules)
        return null;
    return typeof record.resolvedModel === 'string' ? record.resolvedModel : null;
}
function enqueue(destination, work) {
    const previous = writers.get(destination) ?? Promise.resolve();
    const run = previous.then(work, work);
    writers.set(destination, run.then(() => undefined, () => undefined));
    return run;
}
function admit(input) {
    if (!isPlainObject(input) || hasDangerousKey(input))
        return refuseUnsafe();
    const destination = input.destination;
    const decisionId = input.decisionId;
    const policyVersion = input.policyVersion;
    const evidenceRevision = input.evidenceRevision;
    const revision = input.revision;
    const clock = input.clock;
    const port = input.port;
    const signal = input.signal;
    if (typeof destination !== 'string' || destination.length === 0)
        return refuseUnsafe();
    if (!safeId(decisionId) || !safeId(policyVersion) || !safeRevision(evidenceRevision))
        return refuseUnsafe();
    if (!isPlainObject(revision) || hasDangerousKey(revision) || typeof revision.read !== 'function') {
        return refuseUnsafe();
    }
    if (!safeRevision(revision.expected))
        return refuseUnsafe();
    if (!isPlainObject(clock) || hasDangerousKey(clock) || typeof clock.read !== 'function')
        return refuseUnsafe();
    if (!isPlainObject(port) || hasDangerousKey(port) || typeof port.evaluate !== 'function')
        return refuseUnsafe();
    if (typeof signal !== 'object' || signal === null || typeof signal.aborted !== 'boolean')
        return refuseUnsafe();
    if (typeof input.stillUseful !== 'boolean')
        return refuseUnsafe();
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
    };
}
async function storeRefusal(call, existing, outcome, reasonCode, resolvedModel, usage, reservationMicroUsd, freshDecision = freshDecisionFlag()) {
    const record = buildRecord(call.decisionId, call.policyVersion, call.evidenceRevision, resolvedModel, outcome, reasonCode, usage, reservationMicroUsd, freshDecision);
    const fileWritten = await persist(call.destination, existing, record);
    return closedResult(outcome, reasonCode, fileWritten, freshDecision);
}
async function decide(call) {
    const loaded = await loadLedger(call.destination);
    if (loaded.status === 'invalid')
        return closedResult('refused', 'INVALID_REQUEST', false);
    const existing = loaded.status === 'ok' ? loaded.file.records : [];
    const prior = findRecord(existing, call.decisionId);
    if (prior !== undefined)
        return resultFromRecord(prior, false);
    const now = readClock(call.clock);
    if (clockMiss(now, call.deadlineAtMs)) {
        return storeRefusal(call, existing, 'refused', 'DEADLINE', null, unknownUsage(), '0', 'not-scheduled');
    }
    const currentRevision = readRevision(call.revision);
    if (currentRevision !== call.revision.expected) {
        return storeRefusal(call, existing, 'stale', 'STALE', null, unknownUsage(), '0', scheduleFreshDecision(currentRevision, call.revision.expected, call.stillUseful, now, call.deadlineAtMs, call.attempts, call.questions, existing, call.remainingMicroUsd, call.reservationMicroUsd, '0'));
    }
    const remaining = parseMoney(call.remainingMicroUsd);
    const reservation = parseMoney(call.reservationMicroUsd);
    const usage = acceptUsage(call.usage);
    const held = storedReservationSum(existing);
    if (call.attempts !== 1
        || call.questions !== 1
        || remaining === undefined
        || reservation === undefined
        || held === undefined
        || remaining - held < reservation
        || hasUnknownUsage(existing)
        || usage === 'invalid') {
        return storeRefusal(call, existing, 'refused', 'BUDGET', null, unknownUsage(), '0');
    }
    const storedUsage = usage === 'omitted' ? unknownUsage() : usage;
    let kernel;
    try {
        kernel = await evaluateChoice(call.spec, call.evaluationInput, {
            port: call.port,
            deadlineAtMs: call.deadlineAtMs,
            signal: call.signal,
        });
    }
    catch {
        return storeRefusal(call, existing, 'refused', 'KNOWN_FAILURE', null, storedUsage, call.reservationMicroUsd);
    }
    const afterClock = readClock(call.clock);
    const afterRevision = readRevision(call.revision);
    const rules = kernel.disposition === 'rules';
    const resolvedModel = resolvedModelOf(kernel, rules);
    if (clockMiss(afterClock, call.deadlineAtMs)) {
        return storeRefusal(call, existing, 'refused', 'DEADLINE', resolvedModel, storedUsage, call.reservationMicroUsd, 'not-scheduled');
    }
    if (afterRevision !== call.revision.expected) {
        return storeRefusal(call, existing, 'stale', 'STALE', resolvedModel, storedUsage, call.reservationMicroUsd, scheduleFreshDecision(afterRevision, call.revision.expected, call.stillUseful, afterClock, call.deadlineAtMs, call.attempts, call.questions, existing, call.remainingMicroUsd, call.reservationMicroUsd, call.reservationMicroUsd));
    }
    if (rules || (kernel.disposition === 'abstained' && kernel.reasonCode === 'CHOICE_RECORDED')) {
        return storeRefusal(call, existing, 'advisory', kernel.reasonCode, resolvedModel, storedUsage, call.reservationMicroUsd);
    }
    return storeRefusal(call, existing, 'refused', kernel.reasonCode, null, storedUsage, call.reservationMicroUsd);
}
export async function recordDecision(input) {
    const admitted = admit(input);
    if (!('destination' in admitted) || !('evaluationInput' in admitted))
        return admitted;
    return enqueue(admitted.destination, () => decide(admitted));
}
export async function readDecisionFile(destination) {
    if (typeof destination !== 'string' || destination.length === 0) {
        return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
    }
    try {
        const loaded = await loadLedger(destination);
        if (loaded.status !== 'ok')
            return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
        return { ok: true, file: loaded.file };
    }
    catch {
        return { ok: false, reasonCode: 'SCHEMA_FAILURE' };
    }
}
