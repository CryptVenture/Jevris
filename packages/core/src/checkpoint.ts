import { open, readFile } from 'node:fs/promises';
import { durableWrite } from '@jevris/platform';
import { MAX_REQUEST_BYTES } from '@jevris/contracts';
import type {
  CapsuleApproval,
  CapsuleConstraint,
  CapsuleFile,
  CapsuleHash,
  CapsuleOpenCheck,
  CheckpointReasonCode,
  ConstraintKind,
  OpenCheckState,
} from '@jevris/contracts';
import { authorizeLocalCaller } from './runtime.js';
import type { LocalCallerCredential } from './runtime.js';

/**
 * Local capsule. Named fields only. Facts are written before any ranking.
 * This module does not call a provider and does not open a transcript path.
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const CAPSULE_KEYS = [
  'schemaVersion',
  'capsuleId',
  'workspaceId',
  'taskId',
  'policyVersion',
  'evidenceRevision',
  'userConstraints',
  'taskIds',
  'approvals',
  'sourceHashes',
  'openChecks',
  'restoreQueued',
  'providerCalls',
  'applied',
  'toolPermission',
] as const;

export interface PersistMandatoryFactsResult {
  readonly reasonCode: CheckpointReasonCode;
  readonly providerCalls: 0;
  readonly applied: false;
  readonly toolPermission: false;
  readonly fileWritten: boolean;
}

export interface LoadMatchingSubsetResult {
  readonly matched: boolean;
  readonly subset: CapsuleFile | null;
  readonly authorizesEffect: false;
  readonly toolPermission: false;
  readonly applied: false;
  readonly providerCalls: 0;
  readonly reasonCode: CheckpointReasonCode;
}

export interface CheckpointHookResult {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly providerCalls: 0;
  readonly toolPermission: false;
}

const ALLOW: CheckpointHookResult = {
  exitCode: 0,
  stdout: '',
  providerCalls: 0,
  toolPermission: false,
};

export const MAX_ADDITIONAL_CONTEXT_CHARS = 10000;

type ParsedStdin =
  | { readonly kind: 'oversize' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'event'; readonly event: string; readonly summary: string; readonly source: string };

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

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isKind(value: unknown): value is ConstraintKind {
  return value === 'compatibility' || value === 'security' || value === 'user';
}

function isScope(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isCheckState(value: unknown): value is OpenCheckState {
  return value === 'open' || value === 'stale';
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

function refused(reasonCode: CheckpointReasonCode): PersistMandatoryFactsResult {
  return {
    reasonCode,
    providerCalls: 0,
    applied: false,
    toolPermission: false,
    fileWritten: false,
  };
}

function unmatched(reasonCode: CheckpointReasonCode): LoadMatchingSubsetResult {
  return {
    matched: false,
    subset: null,
    authorizesEffect: false,
    toolPermission: false,
    applied: false,
    providerCalls: 0,
    reasonCode,
  };
}

function isCredential(value: unknown): value is LocalCallerCredential {
  if (!isPlainObject(value) || hasDangerousKey(value)) return false;
  const user = own(value, 'user');
  const pid = own(value, 'pid');
  const expiresAtMs = own(value, 'expiresAtMs');
  const token = own(value, 'token');
  return (
    typeof user === 'string' &&
    user.length > 0 &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid >= 0 &&
    isFiniteNumber(expiresAtMs) &&
    token instanceof Uint8Array
  );
}

function callerAccepted(input: Record<string, unknown>): boolean {
  const expectedUser = own(input, 'expectedUser');
  const expectedPid = own(input, 'expectedPid');
  const nowMs = own(input, 'nowMs');
  const consumed = own(input, 'consumed');
  if (typeof expectedUser !== 'string' || typeof expectedPid !== 'number' || !isFiniteNumber(nowMs)) {
    return false;
  }
  if (consumed !== false && consumed !== true) return false;
  const credentialValue = own(input, 'credential');
  let credential: LocalCallerCredential | null;
  if (credentialValue === null) {
    credential = null;
  } else if (isCredential(credentialValue)) {
    credential = credentialValue;
  } else {
    return false;
  }
  try {
    const auth = authorizeLocalCaller(
      own(input, 'presented'),
      expectedUser,
      expectedPid,
      credential,
      nowMs,
      consumed,
    );
    return auth.decision === 'accept';
  } catch {
    return false;
  }
}

function readConstraints(value: unknown): readonly CapsuleConstraint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CapsuleConstraint[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) return undefined;
    const id = own(item, 'id');
    const kind = own(item, 'kind');
    const text = own(item, 'text');
    if (!safeId(id) || !isKind(kind) || !nonEmpty(text)) return undefined;
    out.push({ id, kind, text });
  }
  return out;
}

function readTaskIds(value: unknown, taskId: string): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (!safeId(item)) return undefined;
    out.push(item);
  }
  if (!out.includes(taskId)) out.push(taskId);
  return out;
}

function readApprovals(value: unknown): readonly CapsuleApproval[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CapsuleApproval[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) return undefined;
    const id = own(item, 'id');
    const scope = own(item, 'scope');
    const expiresAtMs = own(item, 'expiresAtMs');
    if (!safeId(id) || !isScope(scope) || !isFiniteNumber(expiresAtMs)) return undefined;
    out.push({ id, scope, expiresAtMs, authorizesEffect: false });
  }
  return out;
}

function readHashes(value: unknown): { readonly hashes: readonly CapsuleHash[]; readonly checks: readonly CapsuleOpenCheck[] } | undefined {
  if (!Array.isArray(value)) return undefined;
  const hashes: CapsuleHash[] = [];
  const checks: CapsuleOpenCheck[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) return undefined;
    const path = own(item, 'path');
    const hash = own(item, 'hash');
    if (typeof path !== 'string' || typeof hash !== 'string') return undefined;
    if (hash.length === 0) {
      if (!safeId(path)) return undefined;
      checks.push({ id: path, state: 'open' });
      continue;
    }
    if (path.length === 0) return undefined;
    hashes.push({ path, hash });
  }
  return { hashes, checks };
}

function readStoredHashes(value: unknown): readonly CapsuleHash[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hashes: CapsuleHash[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) return undefined;
    const path = own(item, 'path');
    const hash = own(item, 'hash');
    if (!nonEmpty(path) || !nonEmpty(hash)) return undefined;
    hashes.push({ path, hash });
  }
  return hashes;
}

function readChecks(value: unknown): readonly CapsuleOpenCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CapsuleOpenCheck[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) return undefined;
    const id = own(item, 'id');
    const state = own(item, 'state');
    if (!safeId(id)) return undefined;
    if (state === 'passed') return undefined;
    if (!isCheckState(state)) return undefined;
    out.push({ id, state });
  }
  return out;
}

function buildCapsule(input: Record<string, unknown>, restoreQueued: boolean): CapsuleFile | undefined {
  const capsuleId = own(input, 'capsuleId');
  const workspaceId = own(input, 'workspaceId');
  const taskId = own(input, 'taskId');
  const policyVersion = own(input, 'policyVersion');
  const evidenceRevision = own(input, 'evidenceRevision');
  if (!safeId(capsuleId) || !safeId(workspaceId) || !safeId(taskId) || !safeId(policyVersion)) {
    return undefined;
  }
  if (!safeRevision(evidenceRevision)) return undefined;
  const userConstraints = readConstraints(own(input, 'userConstraints'));
  const taskIds = readTaskIds(own(input, 'taskIds'), taskId);
  const approvals = readApprovals(own(input, 'approvals'));
  const hashed = readHashes(own(input, 'sourceHashes'));
  const listed = readChecks(own(input, 'openChecks'));
  if (
    userConstraints === undefined ||
    taskIds === undefined ||
    approvals === undefined ||
    hashed === undefined ||
    listed === undefined
  ) {
    return undefined;
  }
  const openChecks = [...listed, ...hashed.checks];
  return {
    schemaVersion: '1.0',
    capsuleId,
    workspaceId,
    taskId,
    policyVersion,
    evidenceRevision,
    userConstraints,
    taskIds,
    approvals,
    sourceHashes: hashed.hashes,
    openChecks,
    restoreQueued,
    providerCalls: 0,
    applied: false,
    toolPermission: false,
  };
}

function copyCapsule(
  file: CapsuleFile,
  restoreQueued: boolean,
  overrides?: {
    readonly approvals?: readonly CapsuleApproval[];
    readonly openChecks?: readonly CapsuleOpenCheck[];
  },
): CapsuleFile {
  const constraints: CapsuleConstraint[] = [];
  for (const item of file.userConstraints) {
    constraints.push({ id: item.id, kind: item.kind, text: item.text });
  }
  const approvals: CapsuleApproval[] = [];
  const sourceApprovals = overrides?.approvals ?? file.approvals;
  for (const item of sourceApprovals) {
    approvals.push({
      id: item.id,
      scope: item.scope,
      expiresAtMs: item.expiresAtMs,
      authorizesEffect: false,
    });
  }
  const hashes: CapsuleHash[] = [];
  for (const item of file.sourceHashes) {
    hashes.push({ path: item.path, hash: item.hash });
  }
  const checks: CapsuleOpenCheck[] = [];
  const sourceChecks = overrides?.openChecks ?? file.openChecks;
  for (const item of sourceChecks) {
    checks.push({ id: item.id, state: item.state });
  }
  return {
    schemaVersion: '1.0',
    capsuleId: file.capsuleId,
    workspaceId: file.workspaceId,
    taskId: file.taskId,
    policyVersion: file.policyVersion,
    evidenceRevision: file.evidenceRevision,
    userConstraints: constraints,
    taskIds: [...file.taskIds],
    approvals,
    sourceHashes: hashes,
    openChecks: checks,
    restoreQueued,
    providerCalls: 0,
    applied: false,
    toolPermission: false,
  };
}

function capsuleFromParsed(value: unknown): CapsuleFile | undefined {
  if (!isPlainObject(value) || hasDangerousKey(value) || !sameKeys(value, CAPSULE_KEYS)) return undefined;
  if (own(value, 'schemaVersion') !== '1.0') return undefined;
  const capsuleId = own(value, 'capsuleId');
  const workspaceId = own(value, 'workspaceId');
  const taskId = own(value, 'taskId');
  const policyVersion = own(value, 'policyVersion');
  const evidenceRevision = own(value, 'evidenceRevision');
  if (!safeId(capsuleId) || !safeId(workspaceId) || !safeId(taskId) || !safeId(policyVersion)) {
    return undefined;
  }
  if (!safeRevision(evidenceRevision)) return undefined;
  const userConstraints = readConstraints(own(value, 'userConstraints'));
  const taskIds = readTaskIds(own(value, 'taskIds'), taskId);
  const approvals = readApprovals(own(value, 'approvals'));
  const sourceHashes = readStoredHashes(own(value, 'sourceHashes'));
  const openChecks = readChecks(own(value, 'openChecks'));
  const restoreQueued = own(value, 'restoreQueued');
  if (
    userConstraints === undefined ||
    taskIds === undefined ||
    approvals === undefined ||
    sourceHashes === undefined ||
    openChecks === undefined ||
    typeof restoreQueued !== 'boolean'
  ) {
    return undefined;
  }
  return {
    schemaVersion: '1.0',
    capsuleId,
    workspaceId,
    taskId,
    policyVersion,
    evidenceRevision,
    userConstraints,
    taskIds,
    approvals,
    sourceHashes,
    openChecks,
    restoreQueued,
    providerCalls: 0,
    applied: false,
    toolPermission: false,
  };
}

async function replaceCapsule(destination: string, capsuleId: string, bytes: Uint8Array): Promise<boolean> {
  if (!safeId(capsuleId)) return false;
  return (await durableWrite(destination, bytes)).ok;
}

async function readCapsule(destination: string): Promise<CapsuleFile | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(destination);
  } catch {
    return undefined;
  }
  if (bytes.byteLength > MAX_REQUEST_BYTES) return undefined;
  const text = decodeUtf8Fatal(bytes);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return capsuleFromParsed(parsed);
}

function parseStdin(stdin: unknown): ParsedStdin {
  let bytes: Uint8Array;
  if (typeof stdin === 'string') {
    bytes = encodeUtf8(stdin);
  } else if (stdin instanceof Uint8Array) {
    bytes = stdin;
  } else {
    return { kind: 'unknown' };
  }
  if (bytes.byteLength > MAX_REQUEST_BYTES) return { kind: 'oversize' };
  const text = decodeUtf8Fatal(bytes);
  if (text === undefined) return { kind: 'unknown' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unknown' };
  }
  if (!isPlainObject(parsed) || hasDangerousKey(parsed)) return { kind: 'unknown' };
  const event = own(parsed, 'hook_event_name');
  if (typeof event !== 'string' || event.length === 0) return { kind: 'unknown' };
  const trigger = own(parsed, 'trigger');
  if (trigger !== undefined && typeof trigger !== 'string') return { kind: 'unknown' };
  const summaryValue = own(parsed, 'compact_summary');
  const sourceValue = own(parsed, 'source');
  return {
    kind: 'event',
    event,
    summary: typeof summaryValue === 'string' ? summaryValue : '',
    source: typeof sourceValue === 'string' ? sourceValue : '',
  };
}

function approvalSentence(approval: CapsuleApproval, nowMs: unknown, callerScope: unknown): string {
  const base = `Historical approval ${approval.id} scope ${approval.scope}`;
  if (isFiniteNumber(nowMs) && approval.expiresAtMs <= nowMs) {
    return `${base} is expired and does not authorize a new effect.`;
  }
  if (typeof callerScope === 'string' && callerScope !== approval.scope) {
    return `${base} does not match the current scope and does not authorize a new effect.`;
  }
  return `${base} does not authorize a new effect.`;
}

function cappedContext(index: string, lines: readonly string[]): string {
  let text = index;
  if (text.length > MAX_ADDITIONAL_CONTEXT_CHARS) {
    return text.slice(0, MAX_ADDITIONAL_CONTEXT_CHARS);
  }
  for (const line of lines) {
    const next = `${text}\n${line}`;
    if (next.length <= MAX_ADDITIONAL_CONTEXT_CHARS) text = next;
  }
  return text;
}

function restoreLines(file: CapsuleFile, nowMs: unknown, callerScope: unknown): string {
  const quotes: string[] = [];
  const ids: string[] = [];
  for (const constraint of file.userConstraints) {
    ids.push(constraint.id);
    quotes.push(`Stored constraint ${constraint.id}: ${constraint.text}`);
  }
  const approvals: string[] = [];
  if (file.approvals.length === 0) {
    approvals.push('Historical approvals do not authorize a new effect.');
  } else {
    for (const approval of file.approvals) {
      approvals.push(approvalSentence(approval, nowMs, callerScope));
    }
  }
  const lines = [...quotes, ...approvals];
  const full = lines.join('\n');
  if (full.length <= MAX_ADDITIONAL_CONTEXT_CHARS) return full;
  return cappedContext(`Constraint index: ${ids.join(' ')}`, lines);
}

async function queueRestore(input: Record<string, unknown>, summary: string): Promise<void> {
  if (!callerAccepted(input)) return;
  const destination = own(input, 'destination');
  if (typeof destination !== 'string' || destination.length === 0) return;
  const file = await readCapsule(destination);
  if (file === undefined) return;
  let missing = false;
  for (const constraint of file.userConstraints) {
    if (!summary.includes(constraint.id)) missing = true;
  }
  const next = copyCapsule(file, missing);
  const bytes = encodeUtf8(JSON.stringify(next));
  if (bytes.byteLength > MAX_REQUEST_BYTES) return;
  await replaceCapsule(destination, next.capsuleId, bytes);
}

async function injectRestore(
  input: Record<string, unknown>,
  hookEventName: 'SessionStart' | 'UserPromptSubmit',
): Promise<CheckpointHookResult> {
  if (!callerAccepted(input)) return ALLOW;
  const destination = own(input, 'destination');
  const workspaceId = own(input, 'workspaceId');
  const taskId = own(input, 'taskId');
  if (typeof destination !== 'string' || !safeId(workspaceId) || !safeId(taskId)) return ALLOW;
  const file = await readCapsule(destination);
  if (file === undefined || !file.restoreQueued) return ALLOW;
  if (file.workspaceId !== workspaceId || file.taskId !== taskId) return ALLOW;
  const stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: restoreLines(file, own(input, 'nowMs'), own(input, 'scope')),
    },
  });
  return { exitCode: 0, stdout, providerCalls: 0, toolPermission: false };
}

export async function persistMandatoryFacts(input: object): Promise<PersistMandatoryFactsResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return refused('INVALID_CAPSULE');
  if (!callerAccepted(input)) return refused('CALLER_REJECTED');
  const built = buildCapsule(input, false);
  if (built === undefined) return refused('INVALID_CAPSULE');
  const destination = own(input, 'destination');
  if (typeof destination !== 'string' || destination.length === 0) return refused('INVALID_CAPSULE');
  const bytes = encodeUtf8(JSON.stringify(built));
  if (bytes.byteLength > MAX_REQUEST_BYTES) return refused('OVERSIZE');
  const wrote = await replaceCapsule(destination, built.capsuleId, bytes);
  if (!wrote) return refused('WRITE_FAILED');
  return {
    reasonCode: 'ACCEPTED',
    providerCalls: 0,
    applied: false,
    toolPermission: false,
    fileWritten: true,
  };
}

function revisionMismatch(input: Record<string, unknown>, stored: string): boolean {
  if (!Object.hasOwn(input, 'evidenceRevision')) return false;
  return own(input, 'evidenceRevision') !== stored;
}

function retainHistoricalApprovals(
  approvals: readonly CapsuleApproval[],
  nowMs: unknown,
  callerScope: unknown,
): readonly CapsuleApproval[] {
  const out: CapsuleApproval[] = [];
  for (const item of approvals) {
    const expired = isFiniteNumber(nowMs) && item.expiresAtMs <= nowMs;
    const scopeChanged = typeof callerScope !== 'string' || callerScope !== item.scope;
    const sameScopeCurrent = !expired && !scopeChanged;
    if (expired || scopeChanged || sameScopeCurrent) {
      out.push({
        id: item.id,
        scope: item.scope,
        expiresAtMs: item.expiresAtMs,
        authorizesEffect: false,
      });
    }
  }
  return out;
}

function markOpenChecksStale(checks: readonly CapsuleOpenCheck[]): {
  readonly checks: readonly CapsuleOpenCheck[];
  readonly changed: boolean;
} {
  const next: CapsuleOpenCheck[] = [];
  let changed = false;
  for (const item of checks) {
    if (item.state === 'open') {
      next.push({ id: item.id, state: 'stale' });
      changed = true;
      continue;
    }
    next.push({ id: item.id, state: item.state });
  }
  return { checks: next, changed };
}

function matchedSubset(
  file: CapsuleFile,
  nowMs: unknown,
  callerScope: unknown,
  openChecks: readonly CapsuleOpenCheck[],
): CapsuleFile {
  return copyCapsule(file, file.restoreQueued, {
    approvals: retainHistoricalApprovals(file.approvals, nowMs, callerScope),
    openChecks,
  });
}

export async function loadMatchingSubset(input: object): Promise<LoadMatchingSubsetResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return unmatched('INVALID_CAPSULE');
  if (!callerAccepted(input)) return unmatched('CALLER_REJECTED');
  const destination = own(input, 'destination');
  const workspaceId = own(input, 'workspaceId');
  const taskId = own(input, 'taskId');
  if (typeof destination !== 'string' || !safeId(workspaceId) || !safeId(taskId)) {
    return unmatched('INVALID_CAPSULE');
  }
  const file = await readCapsule(destination);
  if (file === undefined) return unmatched('INVALID_CAPSULE');
  if (file.workspaceId !== workspaceId || file.taskId !== taskId) return unmatched('INVALID_CAPSULE');
  const nowMs = own(input, 'nowMs');
  const callerScope = own(input, 'scope');
  let openChecks = file.openChecks;
  if (revisionMismatch(input, file.evidenceRevision)) {
    const marked = markOpenChecksStale(file.openChecks);
    openChecks = marked.checks;
    if (marked.changed) {
      const next = matchedSubset(file, nowMs, callerScope, openChecks);
      const bytes = encodeUtf8(JSON.stringify(next));
      if (bytes.byteLength > MAX_REQUEST_BYTES) return unmatched('OVERSIZE');
      const wrote = await replaceCapsule(destination, next.capsuleId, bytes);
      if (!wrote) return unmatched('WRITE_FAILED');
      return {
        matched: true,
        subset: next,
        authorizesEffect: false,
        toolPermission: false,
        applied: false,
        providerCalls: 0,
        reasonCode: 'ACCEPTED',
      };
    }
  }
  return {
    matched: true,
    subset: matchedSubset(file, nowMs, callerScope, openChecks),
    authorizesEffect: false,
    toolPermission: false,
    applied: false,
    providerCalls: 0,
    reasonCode: 'ACCEPTED',
  };
}

export async function handleCheckpointHook(input: object): Promise<CheckpointHookResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return ALLOW;
  const parsed = parseStdin(own(input, 'stdin'));
  if (parsed.kind === 'oversize' || parsed.kind === 'unknown') {
    await persistMandatoryFacts(input);
    return ALLOW;
  }
  if (parsed.event === 'PreCompact') {
    await persistMandatoryFacts(input);
    return ALLOW;
  }
  if (parsed.event === 'PostCompact') {
    await queueRestore(input, parsed.summary);
    return ALLOW;
  }
  if (parsed.event === 'SessionStart' && (parsed.source === 'compact' || parsed.source === 'resume')) {
    return injectRestore(input, 'SessionStart');
  }
  if (parsed.event === 'UserPromptSubmit') {
    return injectRestore(input, 'UserPromptSubmit');
  }
  return ALLOW;
}

export interface PortableCapsuleImport {
  readonly mode: 'blocked';
  readonly functionality: 'reduced';
  readonly authorizesEffect: false;
  readonly applied: false;
  readonly toolPermission: false;
  readonly providerCalls: 0;
  readonly approvals: readonly CapsuleApproval[];
  readonly openChecks: readonly CapsuleOpenCheck[];
}

function handoffApprovals(value: unknown, nowMs: number): readonly CapsuleApproval[] {
  if (!Array.isArray(value)) return [];
  const out: CapsuleApproval[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) continue;
    const id = own(item, 'id');
    const scope = own(item, 'scope');
    const expiresAtMs = own(item, 'expiresAtMs');
    if (!safeId(id) || !isScope(scope) || !isFiniteNumber(expiresAtMs)) continue;
    if (expiresAtMs <= nowMs) continue;
    out.push({ id, scope, expiresAtMs, authorizesEffect: false });
  }
  return out;
}

function handoffChecks(value: unknown): readonly CapsuleOpenCheck[] {
  if (!Array.isArray(value)) return [];
  const out: CapsuleOpenCheck[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || hasDangerousKey(item)) continue;
    const id = own(item, 'id');
    const state = own(item, 'state');
    if (!safeId(id)) continue;
    if (state === 'passed') continue;
    if (state !== 'open' && state !== 'stale') continue;
    out.push({ id, state });
  }
  return out;
}

export function importPortableCapsule(
  capsule: unknown,
  nowMs: number,
  callerScope: string,
): PortableCapsuleImport {
  const approvals = isPlainObject(capsule) && !hasDangerousKey(capsule) ? handoffApprovals(own(capsule, 'approvals'), nowMs) : [];
  const openChecks = isPlainObject(capsule) && !hasDangerousKey(capsule) ? handoffChecks(own(capsule, 'openChecks')) : [];
  const foreignScope = approvals.some((item) => item.scope !== callerScope);
  const missingTarget = !isPlainObject(capsule) || !Object.hasOwn(capsule, 'targetControl');
  const mode = foreignScope || missingTarget || callerScope.length === 0 ? 'blocked' : 'blocked';
  return {
    mode,
    functionality: 'reduced',
    authorizesEffect: false,
    applied: false,
    toolPermission: false,
    providerCalls: 0,
    approvals,
    openChecks,
  };
}
