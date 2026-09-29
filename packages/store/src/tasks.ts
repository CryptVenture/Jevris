/**
 * Tasks and dependency edges (DATA-03, SSOT §10.1, D05, US24).
 *
 * States: proposed, validated, ready, leased, running, awaiting-evidence, verifying,
 * verified, failed, blocked, cancelled. Every change goes through `transitionTask`, which
 * refuses an illegal transition, a stale revision and an actor that may not make it.
 *
 * - "Agent finished" moves a task at most to `verifying`: the `agent` actor can never
 *   reach `verified`, and no actor reaches it through `transitionTask`.
 * - `verified` is set only by `verifyTask` (current, passed verification receipts read from
 *   the store for this task) or `acceptException` (a human exception backed by a terminal
 *   authorization receipt). The two stay distinguishable (`verifiedBy`).
 * - An unknown dependency blocks: moving a task to `ready` with a dependency that is not a
 *   task in this workspace moves it to `blocked` instead.
 * - Edges refuse self-dependencies and cycles.
 */
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { StoreStop, field, isId, isMs, nullableStr, num, read, refuse, str, write } from './access.js';
import type { SqlDriver } from './schema.js';
import { authorizationKey, consumeAuthorization } from './governance.js';

export const STORE_TASK_STATES = [
  'proposed',
  'validated',
  'ready',
  'leased',
  'running',
  'awaiting-evidence',
  'verifying',
  'verified',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type StoreTaskState = (typeof STORE_TASK_STATES)[number];

export const TASK_ACTORS = ['planner', 'scheduler', 'agent', 'runner', 'human', 'reconciler'] as const;
export type TaskActor = (typeof TASK_ACTORS)[number];

/** Legal transitions (D05 plus cancellation and reconciliation edges). */
export const TASK_TRANSITIONS: { readonly [S in StoreTaskState]: readonly StoreTaskState[] } = {
  proposed: ['validated', 'blocked', 'cancelled'],
  validated: ['ready', 'proposed', 'blocked', 'cancelled'],
  ready: ['leased', 'validated', 'blocked', 'cancelled'],
  leased: ['running', 'ready', 'blocked', 'failed', 'cancelled'],
  running: ['awaiting-evidence', 'verifying', 'failed', 'blocked', 'cancelled'],
  'awaiting-evidence': ['running', 'verifying', 'failed', 'blocked', 'cancelled'],
  verifying: ['verified', 'awaiting-evidence', 'ready', 'failed', 'blocked', 'cancelled'],
  verified: ['awaiting-evidence'],
  failed: ['ready', 'blocked', 'cancelled'],
  blocked: ['validated', 'ready', 'failed', 'cancelled'],
  cancelled: [],
};

/** What an agent (a model worker) may do: work, and report it finished (at most verifying). */
const AGENT_MOVES: ReadonlySet<string> = new Set(['leased>running', 'running>awaiting-evidence', 'running>verifying', 'awaiting-evidence>running', 'awaiting-evidence>verifying']);

export type TaskReasonCode =
  | 'UNKNOWN_TASK'
  | 'ILLEGAL_TRANSITION'
  | 'STALE_REVISION'
  | 'VERIFY_REQUIRES_PROOF'
  | 'ACTOR_NOT_ALLOWED'
  | 'DEPENDENCY_NOT_VERIFIED'
  | 'CYCLE'
  | 'DUPLICATE_TASK'
  | 'NO_PASSING_RECEIPT'
  | 'AUTHORIZATION_REFUSED';

export interface TaskRow {
  readonly taskId: string;
  readonly revision: number;
  readonly state: StoreTaskState;
  readonly ownerId: string;
  readonly rootBudgetId: string;
  readonly requirementIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly stateReason: string | null;
  readonly verifiedBy: 'checks' | 'exception' | null;
  /** Opaque JSON owned by the orchestrator (title, scopes, outputs, estimates). */
  readonly record: unknown;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type TaskResult =
  | { readonly ok: true; readonly task: TaskRow; readonly blockedBy?: readonly string[] }
  | { readonly ok: false; readonly reasonCode: TaskReasonCode; readonly task?: TaskRow }
  | StoreRefusal;

const RECORD_CAP = 65_536;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

function isState(value: unknown): value is StoreTaskState {
  return typeof value === 'string' && (STORE_TASK_STATES as readonly string[]).includes(value);
}

function idList(value: unknown, max = 256): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (!isId(item)) return undefined;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function edgesOf(driver: SqlDriver, workspaceId: string, taskId: string): string[] {
  return driver
    .prepare('SELECT depends_on FROM task_edge WHERE workspace_id = ? AND task_id = ? ORDER BY depends_on')
    .all(workspaceId, taskId)
    .map((row) => str(field(row, 'depends_on')) ?? '')
    .filter((id) => id.length > 0);
}

function taskRow(driver: SqlDriver, workspaceId: string, row: unknown): TaskRow | undefined {
  const taskId = str(field(row, 'task_id'));
  const state = field(row, 'state');
  if (taskId === undefined || !isState(state)) return undefined;
  const verifiedBy = field(row, 'verified_by');
  const requirements = parseJson(field(row, 'requirement_ids'));
  return Object.freeze({
    taskId,
    revision: num(field(row, 'revision')) ?? 1,
    state,
    ownerId: str(field(row, 'owner_id')) ?? '',
    rootBudgetId: str(field(row, 'root_budget_id')) ?? '',
    requirementIds: Array.isArray(requirements) ? requirements.filter((r): r is string => typeof r === 'string') : [],
    dependsOn: edgesOf(driver, workspaceId, taskId),
    stateReason: nullableStr(field(row, 'state_reason')),
    verifiedBy: verifiedBy === 'checks' || verifiedBy === 'exception' ? verifiedBy : null,
    record: parseJson(field(row, 'record')),
    createdAtMs: num(field(row, 'created_at_ms')) ?? 0,
    updatedAtMs: num(field(row, 'updated_at_ms')) ?? 0,
  });
}

function load(driver: SqlDriver, workspaceId: string, taskId: string): TaskRow | undefined {
  return taskRow(driver, workspaceId, driver.prepare('SELECT * FROM task WHERE workspace_id = ? AND task_id = ?').get(workspaceId, taskId));
}

/** True when adding task -> dependsOn would close a cycle (dependsOn already reaches task). */
function wouldCycle(driver: SqlDriver, workspaceId: string, taskId: string, dependsOn: string): boolean {
  const seen = new Set<string>();
  const stack = [dependsOn];
  while (stack.length > 0) {
    const next = stack.pop() ?? '';
    if (next === taskId) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    if (seen.size > 10_000) return true;
    stack.push(...edgesOf(driver, workspaceId, next));
  }
  return false;
}

function recordText(record: unknown): string | undefined {
  if (record === undefined) return '{}';
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const text = JSON.stringify(record);
  return new TextEncoder().encode(text).length <= RECORD_CAP ? text : undefined;
}

function history(driver: SqlDriver, workspaceId: string, taskId: string, from: string, to: string, actor: TaskActor, reason: string, atMs: number): void {
  const seq = (num(field(driver.prepare('SELECT MAX(seq) AS m FROM task_transition WHERE workspace_id = ? AND task_id = ?').get(workspaceId, taskId), 'm')) ?? 0) + 1;
  driver
    .prepare('INSERT INTO task_transition (workspace_id, task_id, seq, from_state, to_state, actor, reason_code, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(workspaceId, taskId, seq, from, to, actor, reason, atMs);
}

function setState(
  driver: SqlDriver,
  workspaceId: string,
  task: TaskRow,
  to: StoreTaskState,
  actor: TaskActor,
  reason: string,
  atMs: number,
  verifiedBy: 'checks' | 'exception' | null = null,
): TaskRow {
  driver
    .prepare('UPDATE task SET state = ?, revision = revision + 1, state_reason = ?, verified_by = ?, updated_at_ms = ? WHERE workspace_id = ? AND task_id = ?')
    .run(to, reason, to === 'verified' ? verifiedBy : null, atMs, workspaceId, task.taskId);
  history(driver, workspaceId, task.taskId, task.state, to, actor, reason, atMs);
  const next = load(driver, workspaceId, task.taskId);
  if (next === undefined) throw new StoreStop('store-unavailable');
  return next;
}

export interface CreateTaskInput {
  readonly taskId: string;
  readonly ownerId: string;
  readonly rootBudgetId: string;
  readonly requirementIds?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly record?: unknown;
  readonly nowMs: number;
}

/** Creates a task in `proposed` with its dependency edges (cycles refused). */
export function createTask(store: OpenStoreResult, input: CreateTaskInput): TaskResult {
  const requirements = idList(input.requirementIds ?? []);
  const deps = idList(input.dependsOn ?? []);
  const record = recordText(input.record);
  if (!isId(input.taskId) || !isId(input.ownerId) || !isId(input.rootBudgetId) || requirements === undefined || deps === undefined || record === undefined || !isMs(input.nowMs)) {
    return refuse('invalid-input');
  }
  if (deps.includes(input.taskId)) return { ok: false, reasonCode: 'CYCLE' };
  return write(store, ({ driver, workspaceId }): TaskResult => {
    if (load(driver, workspaceId, input.taskId) !== undefined) return { ok: false, reasonCode: 'DUPLICATE_TASK' };
    // A dependency may already depend on this id (an earlier unknown dependency).
    if (deps.some((dep) => wouldCycle(driver, workspaceId, input.taskId, dep))) return { ok: false, reasonCode: 'CYCLE' };
    driver
      .prepare('INSERT INTO task (workspace_id, task_id, revision, state, owner_id, root_budget_id, requirement_ids, record, created_at_ms, updated_at_ms) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, input.taskId, 'proposed', input.ownerId, input.rootBudgetId, JSON.stringify(requirements), record, input.nowMs, input.nowMs);
    for (const dep of deps) {
      driver.prepare('INSERT INTO task_edge (workspace_id, task_id, depends_on) VALUES (?, ?, ?)').run(workspaceId, input.taskId, dep);
    }
    history(driver, workspaceId, input.taskId, 'proposed', 'proposed', 'planner', 'CREATED', input.nowMs);
    const task = load(driver, workspaceId, input.taskId);
    if (task === undefined) throw new StoreStop('store-unavailable');
    return { ok: true, task };
  }) as TaskResult;
}

/** Adds a dependency edge while the task is not yet scheduled; a cycle is refused. */
export function addDependency(store: OpenStoreResult, input: { readonly taskId: string; readonly dependsOn: string; readonly nowMs: number }): TaskResult {
  if (!isId(input.taskId) || !isId(input.dependsOn) || !isMs(input.nowMs)) return refuse('invalid-input');
  if (input.taskId === input.dependsOn) return { ok: false, reasonCode: 'CYCLE' };
  const result = write(store, ({ driver, workspaceId }): TaskResult => {
    const task = load(driver, workspaceId, input.taskId);
    if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
    if (!['proposed', 'validated', 'blocked'].includes(task.state)) return { ok: false, reasonCode: 'ILLEGAL_TRANSITION', task };
    if (wouldCycle(driver, workspaceId, input.taskId, input.dependsOn)) return { ok: false, reasonCode: 'CYCLE', task };
    driver.prepare('INSERT OR IGNORE INTO task_edge (workspace_id, task_id, depends_on) VALUES (?, ?, ?)').run(workspaceId, input.taskId, input.dependsOn);
    driver.prepare('UPDATE task SET revision = revision + 1, updated_at_ms = ? WHERE workspace_id = ? AND task_id = ?').run(input.nowMs, workspaceId, input.taskId);
    const next = load(driver, workspaceId, input.taskId);
    if (next === undefined) throw new StoreStop('store-unavailable');
    return { ok: true, task: next };
  });
  return result as TaskResult;
}

export interface TransitionInput {
  readonly taskId: string;
  readonly to: StoreTaskState;
  readonly actor: TaskActor;
  readonly reasonCode: string;
  readonly expectedRevision?: number;
  readonly nowMs: number;
}

/**
 * The one state-change entry point. Refuses an illegal transition, a stale revision, an
 * actor outside its moves, and `verified` (use verifyTask or acceptException).
 */
export function transitionTask(store: OpenStoreResult, input: TransitionInput): TaskResult {
  if (!isId(input.taskId) || !isState(input.to) || !(TASK_ACTORS as readonly string[]).includes(input.actor) || !REASON.test(input.reasonCode) || !isMs(input.nowMs)) {
    return refuse('invalid-input');
  }
  if (input.expectedRevision !== undefined && !Number.isSafeInteger(input.expectedRevision)) return refuse('invalid-input');
  if (input.to === 'verified') return { ok: false, reasonCode: 'VERIFY_REQUIRES_PROOF' };
  const result = write(store, ({ driver, workspaceId }): TaskResult => {
    const task = load(driver, workspaceId, input.taskId);
    if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
    if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) return { ok: false, reasonCode: 'STALE_REVISION', task };
    if (!TASK_TRANSITIONS[task.state].includes(input.to)) return { ok: false, reasonCode: 'ILLEGAL_TRANSITION', task };
    if (input.actor === 'agent' && !AGENT_MOVES.has(`${task.state}>${input.to}`)) return { ok: false, reasonCode: 'ACTOR_NOT_ALLOWED', task };
    if (input.to === 'ready' || input.to === 'validated') {
      const unknown = task.dependsOn.filter((dep) => load(driver, workspaceId, dep) === undefined);
      if (unknown.length > 0) {
        // An unknown dependency blocks (US24): never schedulable on a guess.
        const blocked = task.state === 'blocked' ? task : setState(driver, workspaceId, task, 'blocked', input.actor, 'UNKNOWN_DEPENDENCY', input.nowMs);
        return { ok: true, task: blocked, blockedBy: unknown };
      }
      if (input.to === 'ready') {
        const pending = task.dependsOn.filter((dep) => load(driver, workspaceId, dep)?.state !== 'verified');
        if (pending.length > 0) return { ok: false, reasonCode: 'DEPENDENCY_NOT_VERIFIED', task };
      }
    }
    return { ok: true, task: setState(driver, workspaceId, task, input.to, input.actor, input.reasonCode, input.nowMs) };
  });
  return result as TaskResult;
}

/**
 * Verifies a task in `verifying` from receipts the store holds: every named receipt must be
 * a current, passed verification receipt for this task. A frame cannot supply one.
 */
export function verifyTask(store: OpenStoreResult, input: { readonly taskId: string; readonly receiptIds: readonly string[]; readonly nowMs: number }): TaskResult {
  const receiptIds = idList(input.receiptIds, 1024);
  if (!isId(input.taskId) || receiptIds === undefined || receiptIds.length === 0 || !isMs(input.nowMs)) return refuse('invalid-input');
  const result = write(store, ({ driver, workspaceId }): TaskResult => {
    const task = load(driver, workspaceId, input.taskId);
    if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
    if (task.state !== 'verifying') return { ok: false, reasonCode: 'ILLEGAL_TRANSITION', task };
    for (const receiptId of receiptIds) {
      const row = driver.prepare('SELECT task_id, outcome, validity FROM verification_receipt WHERE workspace_id = ? AND receipt_id = ?').get(workspaceId, receiptId);
      if (row === undefined || field(row, 'task_id') !== input.taskId || field(row, 'outcome') !== 'passed' || field(row, 'validity') !== 'current') {
        return { ok: false, reasonCode: 'NO_PASSING_RECEIPT', task };
      }
    }
    return { ok: true, task: setState(driver, workspaceId, task, 'verified', 'runner', 'CHECKS_PASSED', input.nowMs, 'checks') };
  });
  return result as TaskResult;
}

/**
 * A human accepts a documented exception (SSOT §10.1). It needs a terminal-minted
 * authorization receipt for `task.exception` on this task, is recorded separately, and the
 * task shows `verifiedBy: 'exception'`, never a pass.
 */
export function acceptException(
  store: OpenStoreResult,
  input: { readonly taskId: string; readonly exceptionId: string; readonly principal: string; readonly reason: string; readonly authorizationId: string; readonly nowMs: number },
): TaskResult {
  if (!isId(input.taskId) || !isId(input.exceptionId) || !isId(input.principal) || !isId(input.authorizationId) || !isMs(input.nowMs)) return refuse('invalid-input');
  if (typeof input.reason !== 'string' || input.reason.length === 0 || input.reason.length > 2000) return refuse('invalid-input');
  const key = authorizationKey(store);
  const result = write(store, ({ driver, workspaceId }): TaskResult => {
    const task = load(driver, workspaceId, input.taskId);
    if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
    if (!['verifying', 'awaiting-evidence', 'failed'].includes(task.state)) return { ok: false, reasonCode: 'ILLEGAL_TRANSITION', task };
    const authorized = consumeAuthorization(driver, {
      authorizationId: input.authorizationId,
      principal: input.principal,
      actionClass: 'task.exception',
      scope: `${workspaceId}:${input.taskId}`,
      nowMs: input.nowMs,
    }, key);
    if (!authorized) return { ok: false, reasonCode: 'AUTHORIZATION_REFUSED', task };
    driver
      .prepare('INSERT INTO task_exception (workspace_id, exception_id, task_id, principal, reason, authorization_id, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, input.exceptionId, input.taskId, input.principal, input.reason, input.authorizationId, input.nowMs);
    const moved = task.state === 'verifying' ? task : setState(driver, workspaceId, task, 'verifying', 'human', 'EXCEPTION_REVIEW', input.nowMs);
    return { ok: true, task: setState(driver, workspaceId, moved, 'verified', 'human', 'HUMAN_EXCEPTION', input.nowMs, 'exception') };
  });
  return result as TaskResult;
}

/** Replaces the orchestrator's opaque task record (optimistic on revision). */
export function updateTaskRecord(store: OpenStoreResult, input: { readonly taskId: string; readonly record: unknown; readonly expectedRevision?: number; readonly nowMs: number }): TaskResult {
  const record = recordText(input.record);
  if (!isId(input.taskId) || record === undefined || !isMs(input.nowMs)) return refuse('invalid-input');
  const result = write(store, ({ driver, workspaceId }): TaskResult => {
    const task = load(driver, workspaceId, input.taskId);
    if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
    if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) return { ok: false, reasonCode: 'STALE_REVISION', task };
    driver.prepare('UPDATE task SET record = ?, revision = revision + 1, updated_at_ms = ? WHERE workspace_id = ? AND task_id = ?').run(record, input.nowMs, workspaceId, input.taskId);
    const next = load(driver, workspaceId, input.taskId);
    if (next === undefined) throw new StoreStop('store-unavailable');
    return { ok: true, task: next };
  });
  return result as TaskResult;
}

export function getTask(store: OpenStoreResult, taskId: string): TaskRow | undefined {
  if (!isId(taskId)) return undefined;
  const result = read(store, ({ driver, workspaceId }) => load(driver, workspaceId, taskId));
  return result !== undefined && !Object.hasOwn(result, 'ok') ? (result as TaskRow) : undefined;
}

export function listTasks(store: OpenStoreResult, filter: { readonly states?: readonly StoreTaskState[] } = {}): readonly TaskRow[] {
  const result = read(store, ({ driver, workspaceId }) =>
    driver
      .prepare('SELECT * FROM task WHERE workspace_id = ? ORDER BY created_at_ms, task_id')
      .all(workspaceId)
      .map((row) => taskRow(driver, workspaceId, row))
      .filter((t): t is TaskRow => t !== undefined && (filter.states === undefined || filter.states.includes(t.state))),
  );
  return Array.isArray(result) ? result : [];
}

export interface TaskTransitionRow {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly actor: string;
  readonly reasonCode: string;
  readonly atMs: number;
}

export function taskHistory(store: OpenStoreResult, taskId: string): readonly TaskTransitionRow[] {
  if (!isId(taskId)) return [];
  const result = read(store, ({ driver, workspaceId }) =>
    driver
      .prepare('SELECT * FROM task_transition WHERE workspace_id = ? AND task_id = ? ORDER BY seq')
      .all(workspaceId, taskId)
      .map((row) => ({
        seq: num(field(row, 'seq')) ?? 0,
        from: str(field(row, 'from_state')) ?? '',
        to: str(field(row, 'to_state')) ?? '',
        actor: str(field(row, 'actor')) ?? '',
        reasonCode: str(field(row, 'reason_code')) ?? '',
        atMs: num(field(row, 'at_ms')) ?? 0,
      })),
  );
  return Array.isArray(result) ? result : [];
}

export function taskExceptions(store: OpenStoreResult, taskId: string): readonly { readonly exceptionId: string; readonly principal: string; readonly reason: string; readonly authorizationId: string; readonly atMs: number }[] {
  if (!isId(taskId)) return [];
  const result = read(store, ({ driver, workspaceId }) =>
    driver
      .prepare('SELECT * FROM task_exception WHERE workspace_id = ? AND task_id = ? ORDER BY at_ms')
      .all(workspaceId, taskId)
      .map((row) => ({
        exceptionId: str(field(row, 'exception_id')) ?? '',
        principal: str(field(row, 'principal')) ?? '',
        reason: str(field(row, 'reason')) ?? '',
        authorizationId: str(field(row, 'authorization_id')) ?? '',
        atMs: num(field(row, 'at_ms')) ?? 0,
      })),
  );
  return Array.isArray(result) ? result : [];
}

/**
 * Moves the given tasks, where verified by checks, back to `awaiting-evidence` (their
 * receipts were invalidated by a changed revision). Returns the task ids moved.
 */
export function demoteVerifiedTasks(driver: SqlDriver, workspaceId: string, taskIds: readonly string[], nowMs: number): string[] {
  const moved: string[] = [];
  for (const taskId of new Set(taskIds)) {
    const task = load(driver, workspaceId, taskId);
    if (task === undefined || task.state !== 'verified' || task.verifiedBy !== 'checks') continue;
    setState(driver, workspaceId, task, 'awaiting-evidence', 'reconciler', 'RECEIPT_INVALIDATED', nowMs);
    moved.push(taskId);
  }
  return moved;
}
