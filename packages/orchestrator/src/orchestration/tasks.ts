/**
 * Tasks on B's store (DATA-03; SSOT §6.2, §10.1, §10.2).
 *
 * The task table, its dependency edges and its transition history live in the store; this
 * module is the orchestrator's typed view over them. The orchestrator's own fields (title,
 * write scopes, acceptance checks, resources, toolchains, models, outputs, value, estimate and
 * the current lease id) are the row's opaque `record`. Every state change goes through the
 * store's `transitionTask`, which refuses an illegal transition, a stale revision and an actor
 * outside its moves (an agent reaches at most `verifying`). `verified` is reachable only
 * through `markVerified`, which calls the store's `verifyTask` with current, passed receipts
 * the store holds, or through a human exception backed by a terminal authorization
 * (`waiveTask`, verifiedBy `exception`).
 *
 * Store calls are synchronous, so they can run inside a lease-ledger transaction.
 */
import { TASK_STATES, TaskNodeContract, type TaskNode, type TaskState } from '@jevris/contracts';
import {
  TASK_TRANSITIONS,
  acceptException,
  createTask,
  getTask as storeGetTask,
  listTasks as storeListTasks,
  taskHistory,
  transitionTask as storeTransition,
  updateTaskRecord,
  verifyTask,
  type OpenStoreResult,
  type TaskActor,
  type TaskResult,
  type TaskRow,
} from '@jevris/store';
import type { WorkspaceServices } from '../workspace.js';
import { isPlain, own, safeText } from '../util.js';
import type { RouteRisk } from '@jevris/core';
import { DEFAULT_LOW_RISK_SLICE, taskRisk, type RiskReason } from './risk.js';

export type { TaskActor };

export interface TaskHistoryEntry {
  readonly state: TaskState;
  readonly atMs: number;
  readonly reason: string;
  readonly actor: string;
}

export interface TaskRecord {
  readonly node: TaskNode;
  readonly title: string;
  /** The accountable owner (a person or team id), required for every plan. */
  readonly ownerId: string;
  /** Exclusive resources: at most one running lease holds each key. */
  readonly resourceKeys: readonly string[];
  /** Toolchain programs the task needs on the runner. */
  readonly toolchains: readonly string[];
  /** Data scope the task may read ('workspace' by default). */
  readonly dataScope: string;
  /** Model ids eligible to work the task; empty means any registered model. */
  readonly models: readonly string[];
  readonly expectedOutputs: readonly string[];
  /** Relative value 1..100 used for value-per-budget ordering. */
  readonly value: number;
  readonly estimateMicroUsd: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly stateReason: string | null;
  /** How a verified task was verified: by checks, or by a human exception. */
  readonly verifiedBy: 'checks' | 'exception' | null;
  readonly leaseId: string | null;
  /**
   * The evaluation slice the planner declared (RTE-12): one of the ids a calibration release
   * permits, never derived from text. Null when none was declared (routing then abstains).
   */
  readonly sliceId: string | null;
  /**
   * The rules-only risk class computed when the task was created (risk.ts; owner decision
   * 7922ee3). Only `low` lets route learning explore or follow a learned slice. `unknown` for a
   * task created before the class existed.
   */
  readonly risk: RouteRisk;
  /** Why the task is not low (reason codes; empty when low or unknown). */
  readonly riskReasons: readonly RiskReason[];
  /** The plan's labels (keys only, for example `security`). */
  readonly labels: readonly string[];
  /** The last 64 transitions (only on `getTask`; `listTasks` leaves it empty). */
  readonly history: readonly TaskHistoryEntry[];
}

/** The legal transitions, the store's (D05 plus cancellation and reconciliation edges). */
export const TRANSITIONS: { readonly [S in TaskState]: readonly TaskState[] } = TASK_TRANSITIONS;

/** Task ids the store accepts (a subset of the contracts' opaque ids). */
export const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type TaskReason =
  | 'UNKNOWN_TASK'
  | 'ILLEGAL_TRANSITION'
  | 'STALE_REVISION'
  | 'VERIFY_REQUIRES_COMPLETION'
  | 'ACTOR_NOT_ALLOWED'
  | 'DEPENDENCY_NOT_VERIFIED'
  | 'NO_PASSING_RECEIPT'
  | 'AUTHORIZATION_REFUSED'
  | 'DUPLICATE_TASK'
  | 'CYCLE'
  | 'INVALID_TASK'
  | 'STORE_UNAVAILABLE';

export type TransitionResult =
  | { readonly ok: true; readonly task: TaskRecord; readonly blockedBy?: readonly string[] }
  | { readonly ok: false; readonly reasonCode: TaskReason };

/** The orchestrator fields kept in the store row's opaque record. */
interface TaskFields {
  readonly schema: 'jevris-task-record-1';
  readonly title: string;
  readonly writeScopes: readonly string[];
  readonly acceptanceCheckIds: readonly string[];
  readonly resourceKeys: readonly string[];
  readonly toolchains: readonly string[];
  readonly dataScope: string;
  readonly models: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly value: number;
  readonly estimateMicroUsd: number;
  readonly leaseId: string | null;
  readonly sliceId: string | null;
  readonly labels: readonly string[];
  readonly risk: RouteRisk;
  readonly riskReasons: readonly RiskReason[];
  /** A readable reason for the current state, when the transition gave one. */
  readonly note: string | null;
  readonly noteState: string | null;
}

/** The workspace's store view, or undefined when the store is unavailable. */
export function taskStore(ws: WorkspaceServices): OpenStoreResult | undefined {
  return ws.store !== undefined && ws.store.ok ? ws.store : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function fieldsOf(record: unknown): TaskFields {
  const r = isPlain(record) ? record : {};
  const num = (k: string, d: number): number => {
    const v = own(r, k);
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const str = (k: string, d: string): string => {
    const v = own(r, k);
    return typeof v === 'string' ? v : d;
  };
  const lease = own(r, 'leaseId');
  const slice = own(r, 'sliceId');
  const note = own(r, 'note');
  const noteState = own(r, 'noteState');
  const risk = own(r, 'risk');
  return {
    schema: 'jevris-task-record-1',
    title: str('title', ''),
    writeScopes: strings(own(r, 'writeScopes')),
    acceptanceCheckIds: strings(own(r, 'acceptanceCheckIds')),
    resourceKeys: strings(own(r, 'resourceKeys')),
    toolchains: strings(own(r, 'toolchains')),
    dataScope: str('dataScope', 'workspace'),
    models: strings(own(r, 'models')),
    expectedOutputs: strings(own(r, 'expectedOutputs')),
    value: num('value', 50),
    estimateMicroUsd: num('estimateMicroUsd', 0),
    leaseId: typeof lease === 'string' ? lease : null,
    sliceId: typeof slice === 'string' && KEY.test(slice) ? slice : null,
    labels: strings(own(r, 'labels')).filter((l) => KEY.test(l)),
    risk: risk === 'low' || risk === 'medium' || risk === 'high' ? risk : 'unknown',
    riskReasons: strings(own(r, 'riskReasons')).filter((c): c is RiskReason => /^[A-Z][A-Z_]{0,63}$/.test(c)),
    note: typeof note === 'string' ? note : null,
    noteState: typeof noteState === 'string' ? noteState : null,
  };
}

function toRecord(ws: WorkspaceServices, store: OpenStoreResult, row: TaskRow, withHistory: boolean): TaskRecord {
  const f = fieldsOf(row.record);
  const node = {
    id: row.taskId,
    schemaVersion: '1.0',
    workspaceId: ws.workspaceId,
    state: row.state,
    revision: `r${String(row.revision)}`,
    requirementIds: [...row.requirementIds],
    dependencyIds: [...row.dependsOn],
    writeScopes: [...f.writeScopes],
    acceptanceCheckIds: [...f.acceptanceCheckIds],
    rootBudgetId: row.rootBudgetId,
  } as TaskNode;
  return {
    node,
    title: f.title.length > 0 ? f.title : row.taskId,
    ownerId: row.ownerId,
    resourceKeys: f.resourceKeys,
    toolchains: f.toolchains,
    dataScope: f.dataScope,
    models: f.models,
    expectedOutputs: f.expectedOutputs,
    value: f.value,
    estimateMicroUsd: f.estimateMicroUsd,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    stateReason: f.note !== null && f.noteState === row.state ? f.note : row.stateReason,
    verifiedBy: row.verifiedBy,
    leaseId: f.leaseId,
    sliceId: f.sliceId,
    risk: f.risk,
    riskReasons: f.riskReasons,
    labels: f.labels,
    history: withHistory
      ? taskHistory(store, row.taskId)
          .slice(-64)
          .map((h) => ({ state: h.to as TaskState, atMs: h.atMs, reason: h.reasonCode, actor: h.actor }))
      : [],
  };
}

export function getTask(ws: WorkspaceServices, taskId: string): TaskRecord | undefined {
  const store = taskStore(ws);
  if (store === undefined || !TASK_ID.test(taskId)) return undefined;
  const row = storeGetTask(store, taskId);
  return row === undefined ? undefined : toRecord(ws, store, row, true);
}

export function listTasks(ws: WorkspaceServices, filter: { readonly states?: readonly TaskState[] } = {}): readonly TaskRecord[] {
  const store = taskStore(ws);
  if (store === undefined) return [];
  return storeListTasks(store, filter.states === undefined ? {} : { states: filter.states })
    .map((row) => toRecord(ws, store, row, false))
    .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.node.id < b.node.id ? -1 : 1));
}

function reasonOf(result: TaskResult): TaskReason {
  if (result.ok) return 'ILLEGAL_TRANSITION';
  if ('reasonCode' in result) return result.reasonCode === 'VERIFY_REQUIRES_PROOF' ? 'VERIFY_REQUIRES_COMPLETION' : result.reasonCode;
  return result.reason === 'invalid-input' ? 'INVALID_TASK' : 'STORE_UNAVAILABLE';
}

/** An upper-snake reason code for the store, from a code or a short phrase. */
export function reasonCode(reason: string): string {
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) return reason;
  const code = reason
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[A-Z]/.test(code) ? code : `R_${code}`.slice(0, 64);
}

export interface TransitionOptions {
  readonly actor: TaskActor;
  /** The node revision the caller saw (`r<number>`); a stale one is refused. */
  readonly expectedRevision?: string;
  readonly nowMs?: number;
  /** Changes to the orchestrator fields, written right after the transition. */
  readonly patch?: { readonly leaseId?: string | null };
}

/** One state change through the store. Synchronous; safe inside a ledger transaction. */
export function taskTransition(ws: WorkspaceServices, taskId: string, to: TaskState, reason: string, options: TransitionOptions): TransitionResult {
  if (to === 'verified') return { ok: false, reasonCode: 'VERIFY_REQUIRES_COMPLETION' };
  const store = taskStore(ws);
  if (store === undefined) return { ok: false, reasonCode: 'STORE_UNAVAILABLE' };
  if (!TASK_ID.test(taskId)) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
  const nowMs = options.nowMs ?? Date.now();
  let expected: number | undefined;
  if (options.expectedRevision !== undefined) {
    expected = Number(options.expectedRevision.replace(/^r/, ''));
    if (!Number.isSafeInteger(expected)) return { ok: false, reasonCode: 'STALE_REVISION' };
  }
  const current = storeGetTask(store, taskId);
  if (current === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
  let row = current;
  let blockedBy: readonly string[] | undefined;
  if (current.state !== to) {
    const moved = storeTransition(store, {
      taskId,
      to,
      actor: options.actor,
      reasonCode: reasonCode(reason),
      ...(expected === undefined ? {} : { expectedRevision: expected }),
      nowMs,
    });
    if (!moved.ok) return { ok: false, reasonCode: reasonOf(moved) };
    row = moved.task;
    blockedBy = moved.blockedBy;
  } else if (expected !== undefined && expected !== current.revision) {
    return { ok: false, reasonCode: 'STALE_REVISION' };
  }
  // A phrase (not a code) is kept as the readable reason; the store keeps its code.
  const fields = fieldsOf(row.record);
  const isCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(reason);
  const note = isCode ? { note: null, noteState: null } : { note: safeText(reason, 300), noteState: to };
  const noteChanged = fields.note !== note.note || fields.noteState !== note.noteState;
  // A lease id means something only while leased or running; any other state drops it.
  const dropLease = current.state !== to && fields.leaseId !== null && to !== 'leased' && to !== 'running' ? { leaseId: null } : {};
  if (options.patch !== undefined || (current.state !== to && (noteChanged || 'leaseId' in dropLease))) {
    const updated = updateTaskRecord(store, { taskId, record: { ...fields, ...(current.state !== to ? note : {}), ...dropLease, ...(options.patch ?? {}) }, nowMs });
    if (updated.ok) row = updated.task;
  }
  return { ok: true, task: toRecord(ws, store, row, false), ...(blockedBy === undefined ? {} : { blockedBy }) };
}

/** Async form for callers outside a transaction (the default actor is the planner). */
export async function transitionTask(
  ws: WorkspaceServices,
  taskId: string,
  to: TaskState,
  reason: string,
  options: { readonly expectedRevision?: string; readonly nowMs?: number; readonly actor?: TaskActor } = {},
): Promise<TransitionResult> {
  return taskTransition(ws, taskId, to, reason, {
    actor: options.actor ?? 'planner',
    ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
}

/**
 * Package-internal: the completion path marks a task verified from receipts the store holds.
 * Each receipt must be a current, passed receipt recorded for this task; the store checks it.
 */
export function markVerified(ws: WorkspaceServices, taskId: string, receiptIds: readonly string[], nowMs: number): TransitionResult {
  const store = taskStore(ws);
  if (store === undefined) return { ok: false, reasonCode: 'STORE_UNAVAILABLE' };
  const current = storeGetTask(store, taskId);
  if (current === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
  if (current.state === 'running' || current.state === 'awaiting-evidence') {
    const step = storeTransition(store, { taskId, to: 'verifying', actor: 'runner', reasonCode: 'COMPLETION_EVALUATION', nowMs });
    if (!step.ok) return { ok: false, reasonCode: reasonOf(step) };
  }
  if (receiptIds.length === 0) return { ok: false, reasonCode: 'NO_PASSING_RECEIPT' };
  const verified = verifyTask(store, { taskId, receiptIds, nowMs });
  if (!verified.ok) return { ok: false, reasonCode: reasonOf(verified) };
  return { ok: true, task: toRecord(ws, store, verified.task, false) };
}

// -------------------------------------------------------------------------- task input

export interface TaskInput {
  readonly id: string;
  readonly title?: string;
  readonly requirementIds?: readonly string[];
  readonly dependencyIds?: readonly string[];
  readonly writeScopes?: readonly string[];
  readonly acceptanceCheckIds?: readonly string[];
  readonly resourceKeys?: readonly string[];
  readonly toolchains?: readonly string[];
  readonly dataScope?: string;
  readonly models?: readonly string[];
  readonly expectedOutputs?: readonly string[];
  readonly value?: number;
  readonly estimateMicroUsd?: number;
  readonly sliceId?: string;
  /** Plan labels (keys); `security` makes the task high risk. */
  readonly labels?: readonly string[];
  /** The plan's declared risk: it may lower the rules' class, never raise it to low. */
  readonly risk?: RouteRisk;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function keyList(value: unknown, max = 64): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !KEY.test(v)) return undefined;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** What is wrong with one untrusted task: the field and the rule it broke (JEV-0006). */
export interface TaskInputProblem {
  /** The task's id when it has a usable one. */
  readonly taskId: string | null;
  readonly field: string;
  /** A plain-text rule, safe to show (it never carries the value). */
  readonly rule: string;
}

export type TaskInputCheck = { readonly ok: true; readonly input: TaskInput } | { readonly ok: false; readonly problem: TaskInputProblem };

const KEY_TEXT = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const KEY_RULE = `each entry must be a name matching ${KEY_TEXT} (letters, digits, . _ : -, no "/" or spaces)`;

/**
 * The rule text of each list field. `expectedOutputs` are names for the outputs a task should
 * produce, not file paths, so an entry with a slash is refused and the rule says so.
 */
function listRule(name: string, max: number): string {
  const names = name === 'expectedOutputs' ? 'names, not paths: ' : '';
  return `${names}a list of at most ${String(max)} entries; ${KEY_RULE}`;
}

/**
 * Checks an untrusted task input (a TaskNode, or a TaskNode plus scheduling fields) and, when it
 * is not usable, names the first field and the rule it broke, so a person can fix it.
 */
export function checkTaskInput(raw: unknown): TaskInputCheck {
  if (!isPlain(raw)) return { ok: false, problem: { taskId: null, field: 'task', rule: 'each task must be an object' } };
  const id = own(raw, 'id');
  if (typeof id !== 'string') return { ok: false, problem: { taskId: null, field: 'id', rule: 'each task needs a string id' } };
  const taskId = id.length <= 130 ? id : null;
  const bad = (field: string, rule: string): TaskInputCheck => ({ ok: false, problem: { taskId, field, rule } });
  const lists = ['requirementIds', 'dependencyIds', 'acceptanceCheckIds', 'resourceKeys', 'toolchains', 'models', 'expectedOutputs', 'labels'] as const;
  const parsed: { [k: string]: unknown } = { id };
  for (const name of lists) {
    const max = name === 'expectedOutputs' ? 128 : name === 'labels' ? 32 : 256;
    const list = keyList(own(raw, name), max);
    if (list === undefined) return bad(name, listRule(name, max));
    if (name !== 'labels' || list.length > 0) parsed[name] = list;
  }
  const scopes = own(raw, 'writeScopes');
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.length > 256 || !scopes.every((s) => typeof s === 'string')) return bad('writeScopes', 'a list of at most 256 path strings');
    parsed['writeScopes'] = scopes;
  }
  const title = own(raw, 'title');
  if (title !== undefined) {
    if (typeof title !== 'string' || title.length > 300) return bad('title', 'a string of at most 300 characters');
    parsed['title'] = title;
  }
  const sliceId = own(raw, 'sliceId');
  if (sliceId !== undefined) {
    if (typeof sliceId !== 'string' || !KEY.test(sliceId)) return bad('sliceId', `a name matching ${KEY_TEXT}`);
    parsed['sliceId'] = sliceId;
  }
  const risk = own(raw, 'risk');
  if (risk !== undefined) {
    if (risk !== 'low' && risk !== 'medium' && risk !== 'high' && risk !== 'unknown') return bad('risk', 'one of low, medium, high, unknown');
    parsed['risk'] = risk;
  }
  const dataScope = own(raw, 'dataScope');
  if (dataScope !== undefined) {
    if (typeof dataScope !== 'string' || !KEY.test(dataScope)) return bad('dataScope', `a name matching ${KEY_TEXT}`);
    parsed['dataScope'] = dataScope;
  }
  const value = own(raw, 'value');
  if (value !== undefined) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) return bad('value', 'a whole number from 1 to 100');
    parsed['value'] = value;
  }
  const estimate = own(raw, 'estimateMicroUsd');
  if (estimate !== undefined) {
    if (typeof estimate !== 'number' || !Number.isSafeInteger(estimate) || estimate < 0) return bad('estimateMicroUsd', 'a whole number of micro-USD, zero or more');
    parsed['estimateMicroUsd'] = estimate;
  }
  return { ok: true, input: parsed as unknown as TaskInput };
}

/** Parses an untrusted task input (a TaskNode, or a TaskNode plus scheduling fields). */
export function parseTaskInput(raw: unknown): TaskInput | undefined {
  const checked = checkTaskInput(raw);
  return checked.ok ? checked.input : undefined;
}

/** The validated node for a task input; task and dependency ids must be store task ids. */
export function nodeFor(input: TaskInput, workspaceId: string, rootBudgetId: string, _nowMs?: number): TaskNode | undefined {
  if (!TASK_ID.test(input.id) || !(input.dependencyIds ?? []).every((d) => TASK_ID.test(d))) return undefined;
  const node = {
    id: input.id,
    schemaVersion: '1.0' as const,
    workspaceId,
    state: 'proposed' as const,
    revision: 'r1',
    requirementIds: [...(input.requirementIds ?? [])],
    dependencyIds: [...(input.dependencyIds ?? [])],
    writeScopes: [...(input.writeScopes ?? [])],
    acceptanceCheckIds: [...(input.acceptanceCheckIds ?? [])],
    rootBudgetId,
  };
  const checked = TaskNodeContract.validate(node);
  return checked.ok ? (node as TaskNode) : undefined;
}

function fieldsFor(node: TaskNode, input: TaskInput, workspaceRoot: string): TaskFields {
  const labels = [...(input.labels ?? [])];
  const cls = taskRisk({ acceptanceCheckIds: node.acceptanceCheckIds, writeScopes: node.writeScopes, labels, ...(input.risk === undefined ? {} : { declaredRisk: input.risk }) }, workspaceRoot);
  return {
    schema: 'jevris-task-record-1',
    title: (input.title ?? node.id).slice(0, 300),
    writeScopes: [...node.writeScopes],
    acceptanceCheckIds: [...node.acceptanceCheckIds],
    resourceKeys: [...(input.resourceKeys ?? [])],
    toolchains: [...(input.toolchains ?? [])],
    dataScope: input.dataScope ?? 'workspace',
    models: [...(input.models ?? [])],
    expectedOutputs: [...(input.expectedOutputs ?? [])],
    value: input.value ?? 50,
    estimateMicroUsd: input.estimateMicroUsd ?? 0,
    leaseId: null,
    // A low-risk task with no declared slice is a bounded edit by the rules that made it low.
    sliceId: input.sliceId ?? (cls.risk === 'low' ? DEFAULT_LOW_RISK_SLICE : null),
    labels,
    risk: cls.risk,
    riskReasons: cls.reasons,
    note: null,
    noteState: null,
  };
}

/** Creates a task in the store as `proposed` (the planner validates it next). */
export function createTaskRecord(ws: WorkspaceServices, node: TaskNode, input: TaskInput, ownerId: string, nowMs: number): TransitionResult {
  const store = taskStore(ws);
  if (store === undefined) return { ok: false, reasonCode: 'STORE_UNAVAILABLE' };
  const made = createTask(store, {
    taskId: node.id,
    ownerId,
    rootBudgetId: node.rootBudgetId,
    requirementIds: node.requirementIds,
    dependsOn: node.dependencyIds,
    record: fieldsFor(node, input, ws.workspaceRoot),
    nowMs,
  });
  if (!made.ok) return { ok: false, reasonCode: reasonOf(made) };
  return { ok: true, task: toRecord(ws, store, made.task, false) };
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

/** A prerequisite releases its dependants only when verified (by checks or a human exception). */
export function prerequisiteSatisfied(task: TaskRecord): boolean {
  return task.node.state === 'verified';
}

/**
 * A human accepts a documented exception for a task (SSOT §10.1). It needs an authorization
 * minted on the terminal for `task.exception` on `<workspaceId>:<taskId>`; the task then shows
 * `verifiedBy: 'exception'`, never a pass.
 */
export function waiveTask(
  ws: WorkspaceServices,
  taskId: string,
  input: { readonly principal: string; readonly reason: string; readonly authorizationId: string; readonly exceptionId?: string; readonly nowMs?: number },
): TransitionResult {
  const store = taskStore(ws);
  if (store === undefined) return { ok: false, reasonCode: 'STORE_UNAVAILABLE' };
  const nowMs = input.nowMs ?? Date.now();
  const accepted = acceptException(store, {
    taskId,
    exceptionId: input.exceptionId ?? `exc-${String(nowMs)}`,
    principal: input.principal,
    reason: input.reason,
    authorizationId: input.authorizationId,
    nowMs,
  });
  if (!accepted.ok) return { ok: false, reasonCode: reasonOf(accepted) };
  return { ok: true, task: toRecord(ws, store, accepted.task, false) };
}

// ------------------------------------------------------------------ lease port (per workspace)

/** What the lease authority reads and changes on a task, synchronously inside its transaction. */
/** The task fields the lease authority reads. */
export interface LeaseTaskView {
  readonly node: { readonly state: TaskState; readonly rootBudgetId: string };
  readonly resourceKeys: readonly string[];
}

export interface LeaseTaskPort {
  get(taskId: string): LeaseTaskView | undefined;
  /** ready -> leased (scheduler) with the lease id recorded. */
  leased(taskId: string, leaseId: string, nowMs: number): boolean;
  /** An expired lease's task -> blocked (reconciler), when that lease still holds it. */
  expired(taskId: string, leaseId: string, nowMs: number): boolean;
  /** blocked -> ready or cancelled (reconciler). */
  reconciled(taskId: string, resume: boolean, nowMs: number): { readonly ok: true } | { readonly ok: false; readonly reasonCode: string };
  /** Tasks that record a lease while leased or running (for orphan detection). */
  holding(): readonly { readonly taskId: string; readonly leaseId: string }[];
}

export function storeTaskPort(ws: WorkspaceServices): LeaseTaskPort {
  return {
    get: (taskId) => getTask(ws, taskId),
    leased: (taskId, leaseId, nowMs) => taskTransition(ws, taskId, 'leased', 'LEASED', { actor: 'scheduler', nowMs, patch: { leaseId } }).ok,
    expired(taskId, leaseId, nowMs) {
      const task = getTask(ws, taskId);
      if (task === undefined || task.leaseId !== leaseId || !['leased', 'running', 'awaiting-evidence'].includes(task.node.state)) return false;
      return taskTransition(ws, taskId, 'blocked', 'LEASE_EXPIRED', { actor: 'reconciler', nowMs, patch: { leaseId: null } }).ok;
    },
    reconciled: (taskId, resume, nowMs) =>
      taskTransition(ws, taskId, resume ? 'ready' : 'cancelled', resume ? 'RECONCILED' : 'RECONCILED_ABANDONED', { actor: 'reconciler', nowMs }),
    holding: () =>
      listTasks(ws, { states: ['leased', 'running'] })
        .filter((t) => t.leaseId !== null)
        .map((t) => ({ taskId: t.node.id, leaseId: t.leaseId as string })),
  };
}
