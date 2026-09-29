/**
 * The multi-host control service wire protocol (ORC-12, SSOT §10.2, §17.1, E31).
 *
 * JSON over HTTP(S). Every operation is `POST /v1/<op>` with `Authorization: Bearer <token>`.
 * A token selects exactly one tenant; a tenant's leases, reservations, fences, budgets and
 * task mirror live in that tenant's own transactional ledger, so no request can read or change
 * another tenant's rows. `GET /v1/health` needs no token and says only the schema version.
 */
import { createHash } from 'node:crypto';
import { TASK_STATES, type TaskState } from '@jevris/contracts';
import { isPlain, own, type Rec } from '../util.js';
import type { BudgetPolicy, BudgetRecord } from '../orchestration/leases.js';
import type { ProcessIdentity } from '../orchestration/liveness.js';

export const CONTROL_SCHEMA = 'jevris-control-1';
export const CONTROL_OPS = ['acquire', 'heartbeat', 'release', 'sweep', 'reconcile', 'fence', 'leases', 'import'] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A bearer token is a random secret of at least this many characters. */
export const MIN_TOKEN_CHARS = 32;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const POLICIES: readonly BudgetPolicy[] = ['finish-running', 'cancel-newest', 'pause-all'];

/** The stored form of a tenant token: sha256 hex. The service never stores the token itself. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** True for a host name or address that never leaves this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export class ProtocolError extends Error {
  constructor(readonly field: string) {
    super(`control: invalid ${field}`);
  }
}

export function reqString(body: Rec, key: string, pattern: RegExp = ID): string {
  const v = own(body, key);
  if (typeof v !== 'string' || !pattern.test(v)) throw new ProtocolError(key);
  return v;
}

export function workspaceOf(body: Rec): string {
  return reqString(body, 'workspaceId', WORKSPACE_PATTERN);
}

export function reqInt(body: Rec, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = own(body, key);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new ProtocolError(key);
  return v;
}

export function optInt(body: Rec, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return own(body, key) === undefined ? undefined : reqInt(body, key, min, max);
}

export function intOrNull(body: Rec, key: string, min: number): number | null {
  return own(body, key) === null ? null : reqInt(body, key, min);
}

export function reqArray(body: Rec, key: string, max: number): readonly unknown[] {
  const v = own(body, key);
  if (!Array.isArray(v) || v.length > max) throw new ProtocolError(key);
  return v;
}

export function reqRecord(value: unknown, field: string): Rec {
  if (!isPlain(value)) throw new ProtocolError(field);
  return value;
}

export function holderOf(value: unknown): ProcessIdentity {
  const h = reqRecord(value, 'holder');
  const sessionId = own(h, 'sessionId');
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 256)) throw new ProtocolError('holder.sessionId');
  return {
    hostId: reqString(h, 'hostId'),
    pid: reqInt(h, 'pid', 0),
    startedAtMs: intOrNull(h, 'startedAtMs', 0),
    sessionId: sessionId as string | null,
  };
}

export interface TaskSnapshot {
  readonly state: TaskState;
  readonly rootBudgetId: string;
  readonly resourceKeys: readonly string[];
}

export function snapshotOf(value: unknown): TaskSnapshot {
  const t = reqRecord(value, 'task');
  const state = own(t, 'state');
  if (typeof state !== 'string' || !(TASK_STATES as readonly string[]).includes(state)) throw new ProtocolError('task.state');
  const keys = reqArray(t, 'resourceKeys', 64);
  if (!keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 512)) throw new ProtocolError('task.resourceKeys');
  return { state: state as TaskState, rootBudgetId: reqString(t, 'rootBudgetId'), resourceKeys: keys as string[] };
}

export function budgetOf(value: unknown, workspaceId: string): BudgetRecord {
  const b = reqRecord(value, 'budget');
  const limit = reqInt(b, 'limitMicroUsd', 1);
  const reserve = reqInt(b, 'shutdownReserveMicroUsd', 0, limit - 1);
  const policy = own(b, 'policy');
  if (typeof policy !== 'string' || !(POLICIES as readonly string[]).includes(policy)) throw new ProtocolError('budget.policy');
  const createdAt = own(b, 'createdAt');
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new ProtocolError('budget.createdAt');
  const paused = own(b, 'paused');
  if (paused !== undefined && typeof paused !== 'boolean') throw new ProtocolError('budget.paused');
  const ownerId = own(b, 'ownerId');
  if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 256) throw new ProtocolError('budget.ownerId');
  if (own(b, 'workspaceId') !== workspaceId) throw new ProtocolError('budget.workspaceId');
  const updatedAtMs = optInt(b, 'updatedAtMs', 0);
  return {
    id: reqString(b, 'id'),
    workspaceId,
    ownerId,
    limitMicroUsd: limit,
    shutdownReserveMicroUsd: reserve,
    policy: policy as BudgetPolicy,
    createdAt,
    ...(paused === undefined ? {} : { paused }),
    ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
  };
}

/** Which of two copies of a budget is the later decision. */
export function budgetRevision(b: BudgetRecord): number {
  return b.updatedAtMs ?? Date.parse(b.createdAt);
}
