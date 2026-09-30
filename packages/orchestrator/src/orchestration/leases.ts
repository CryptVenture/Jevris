/**
 * The lease authority (ORC-02, ORC-03, SSOT §10.2, D05, C31).
 *
 * One transaction takes a lease and its budget reservation together and moves the task to
 * `leased`. Fencing tokens rise per task, so a writer holding an old token is refused once a
 * newer lease exists (`publishFenced`). Heartbeats extend a lease; the sweeper moves an
 * expired lease's task to `blocked` for reconciliation, marks its reservation `uncertain`
 * (never zero), and a task returns to `ready` only through `reconcileTask`.
 *
 * `ledgerLeaseAuthority` keeps leases, reservations, fences and budgets in the host ledger
 * (single host); task state is read and changed through a per-workspace `LeaseTaskPort` over
 * B's store, synchronously inside the ledger transaction (the task moves only after the lease
 * checks pass, and the ledger rows are written only after the task moved). The multi-host
 * control service (ORC-12) implements the same `LeaseAuthority` over its own transactional
 * store, so the scheduler does not change between the two.
 */
import {
  AgentLeaseContract,
  BudgetReservationContract,
  reservationsWithinBudget,
  type AgentLease,
  type BudgetReservation,
} from '@jevris/contracts';
import type { LedgerTx, RecordLedger } from '../ledger.js';
import { randomBytes } from 'node:crypto';
import { recordKey } from '../util.js';
import { livenessOf, type Liveness, type ProcessIdentity } from './liveness.js';
import { storeTaskPort, type LeaseTaskPort, type LeaseTaskView } from './tasks.js';
import type { WorkspaceServices } from '../workspace.js';
import { CONTROL_MIGRATIONS, configuredRemoteAuthority } from '../control/client.js';

export const DEFAULT_LEASE_TTL_MS = 120_000;
export const DEFAULT_GLOBAL_CAP = 2;

export type BudgetPolicy = 'finish-running' | 'cancel-newest' | 'pause-all';

export interface BudgetRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly limitMicroUsd: number;
  /** Held back for clean shutdown; reservations never use it (ORC-10). */
  readonly shutdownReserveMicroUsd: number;
  readonly policy: BudgetPolicy;
  readonly createdAt: string;
  /** Set by the pause-all policy on exhaustion: no new lease until a person resumes (ORC-10). */
  readonly paused?: boolean;
  /** When a person or policy last changed the record; the control service keeps the latest (ORC-12). */
  readonly updatedAtMs?: number;
}

export type LeaseState = 'active' | 'released' | 'expired' | 'superseded' | 'cancelled';

export interface LeaseRecord {
  readonly lease: AgentLease;
  readonly state: LeaseState;
  readonly holder: ProcessIdentity;
  readonly reservationId: string;
  readonly resourceKeys: readonly string[];
  readonly ttlMs: number;
  readonly issuedAtMs: number;
  readonly endedAtMs: number | null;
  readonly endReason: string | null;
}

export interface ReservationRecord {
  readonly reservation: BudgetReservation;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly updatedAtMs: number;
}

export interface LeaseRequest {
  readonly taskId: string;
  readonly ownerId: string;
  readonly worktreeId: string;
  readonly reserveMicroUsd: number;
  readonly holder: ProcessIdentity;
  readonly ttlMs?: number;
}

export interface LeaseGrant {
  readonly lease: AgentLease;
  readonly reservation: BudgetReservation;
}

export type LeaseRefusalCode =
  | 'UNKNOWN_TASK'
  | 'NOT_READY'
  | 'ALREADY_LEASED'
  | 'CAP_REACHED'
  | 'RESOURCE_BUSY'
  | 'UNKNOWN_BUDGET'
  | 'OVER_BUDGET'
  | 'BUDGET_PAUSED'
  | 'INVALID_REQUEST'
  /** The multi-host control service could not be reached; nothing was granted (ORC-12). */
  | 'CONTROL_UNAVAILABLE'
  /** This workspace moved to a control service that this host is not configured for (ORC-12). */
  | 'CONTROL_SERVICE_REQUIRED';

export interface AcquireResult {
  readonly granted: readonly LeaseGrant[];
  readonly refused: readonly { readonly taskId: string; readonly reasonCode: LeaseRefusalCode }[];
}

/** How a lease is settled when it is released together with a fenced publish. */
export interface LeaseRelease {
  readonly spend: { readonly actualMicroUsd: number | null };
  readonly reason: string;
}

export type FenceResult<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly reasonCode: 'STALE_TOKEN' | 'LEASE_NOT_ACTIVE' | 'UNKNOWN_LEASE' };

export interface LeaseAuthority {
  acquire(workspaceId: string, requests: readonly LeaseRequest[], options: { readonly cap: number; readonly nowMs: number }): Promise<AcquireResult>;
  heartbeat(workspaceId: string, leaseId: string, fencingToken: number, nowMs: number): Promise<{ readonly ok: boolean; readonly expiresAt?: string; readonly reasonCode?: string }>;
  release(workspaceId: string, leaseId: string, fencingToken: number, spend: { readonly actualMicroUsd: number | null }, nowMs: number, reason?: string): Promise<{ readonly ok: boolean; readonly reasonCode?: string }>;
  sweep(workspaceId: string, nowMs: number, liveness?: (holder: ProcessIdentity) => Liveness): Promise<readonly string[]>;
  reconcile(workspaceId: string, taskId: string, decision: { readonly spentMicroUsd: number | null; readonly resume: boolean }, nowMs: number): Promise<{ readonly ok: boolean; readonly reasonCode?: string }>;
  /**
   * Runs `fn` in one transaction if the token is still the task's newest and its lease is active.
   * With `release`, the same transaction also releases that lease (a run's end and its lease then
   * change together, so no request sees a finished run still holding a slot). A remote authority may
   * ignore `release`: the caller releases afterwards, which answers LEASE_NOT_ACTIVE when this did.
   */
  publishFenced<R>(workspaceId: string, taskId: string, fencingToken: number, fn: (tx: LedgerTx) => R, nowMs: number, release?: LeaseRelease): Promise<FenceResult<R>>;
  activeLeases(workspaceId: string | null): readonly LeaseRecord[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

function heldResources(tx: LedgerTx): Set<string> {
  const out = new Set<string>();
  for (const l of tx.list<LeaseRecord>('leases')) if (l.state === 'active') for (const k of l.resourceKeys) out.add(k);
  return out;
}

export async function setBudget(ledger: RecordLedger, budget: Omit<BudgetRecord, 'createdAt'>, nowMs = Date.now()): Promise<BudgetRecord> {
  if (!Number.isSafeInteger(budget.limitMicroUsd) || budget.limitMicroUsd <= 0) throw new Error('budget: limit must be a positive integer of micro-USD');
  if (!Number.isSafeInteger(budget.shutdownReserveMicroUsd) || budget.shutdownReserveMicroUsd < 0 || budget.shutdownReserveMicroUsd >= budget.limitMicroUsd) {
    throw new Error('budget: the shutdown reserve must be below the limit');
  }
  const record: BudgetRecord = { ...budget, createdAt: iso(nowMs) };
  await ledger.transact((tx) => tx.put('budgets', budget.id, record));
  return record;
}

export function budgetUse(ledger: RecordLedger, budgetId: string): { readonly heldMicroUsd: number; readonly limitMicroUsd: number; readonly reserveMicroUsd: number } | undefined {
  const budget = ledger.get<BudgetRecord>('budgets', budgetId);
  if (budget === undefined) return undefined;
  const rows = ledger.list<ReservationRecord>('reservations').filter((r) => r.reservation.budgetId === budgetId).map((r) => r.reservation);
  const check = reservationsWithinBudget(budgetId, Number.MAX_SAFE_INTEGER, rows);
  return { heldMicroUsd: check.heldMicroUsd, limitMicroUsd: budget.limitMicroUsd, reserveMicroUsd: budget.shutdownReserveMicroUsd };
}

/** The task port for a workspace; it may read and write the ledger through the transaction it is given. */
export type LeaseTaskResolver = (workspaceId: string, tx: LedgerTx) => LeaseTaskPort | undefined;

/** The lease authority for one workspace's services: host ledger plus that workspace's store. */
export function leaseAuthorityFor(ws: WorkspaceServices): LeaseAuthority {
  const port = storeTaskPort(ws);
  const tasksFor = (workspaceId: string) => (workspaceId === ws.workspaceId ? port : undefined);
  // A host configured for the multi-host control service leases only through it (ORC-12).
  const remote = configuredRemoteAuthority(ws, tasksFor);
  if (typeof remote === 'object') return remote;
  const local = ledgerLeaseAuthority(ws.host, tasksFor);
  // Unusable control settings, or a workspace already moved to a control service: no local
  // lease is granted, so two authorities never lease the same tasks.
  if (typeof remote === 'string') return refuseNewLeases(local, 'CONTROL_UNAVAILABLE');
  if (ws.host.get(CONTROL_MIGRATIONS, ws.workspaceId) !== undefined) return refuseNewLeases(local, 'CONTROL_SERVICE_REQUIRED');
  return local;
}

function refuseNewLeases(inner: LeaseAuthority, reasonCode: LeaseRefusalCode): LeaseAuthority {
  return {
    ...inner,
    acquire: async (_workspaceId, requests) => ({ granted: [], refused: requests.map((r) => ({ taskId: r.taskId, reasonCode })) }),
  };
}

function releaseIn(tx: LedgerTx, workspaceId: string, leaseId: string, fencingToken: number, spend: { readonly actualMicroUsd: number | null }, nowMs: number, reason: string): { readonly ok: boolean; readonly reasonCode?: string } {
  const key = recordKey(workspaceId, leaseId);
  const row = tx.get<LeaseRecord>('leases', key);
  if (row === undefined) return { ok: false, reasonCode: 'UNKNOWN_LEASE' };
  if (row.lease.fencingToken !== fencingToken) return { ok: false, reasonCode: 'STALE_TOKEN' };
  if (row.state !== 'active') return { ok: false, reasonCode: 'LEASE_NOT_ACTIVE' };
  tx.put('leases', key, { ...row, state: 'released', endedAtMs: nowMs, endReason: reason.slice(0, 200) });
  const res = tx.get<ReservationRecord>('reservations', row.reservationId);
  if (res !== undefined) {
    const actual = spend.actualMicroUsd;
    const reservation: BudgetReservation =
      actual === null
        ? { ...res.reservation, state: 'uncertain', actualMicroUsd: null, revision: `v${String(nowMs)}` }
        : { ...res.reservation, state: 'committed', actualMicroUsd: Math.max(0, Math.trunc(actual)), revision: `v${String(nowMs)}` };
    tx.put('reservations', row.reservationId, { ...res, reservation, updatedAtMs: nowMs });
  }
  return { ok: true };
}

export function ledgerLeaseAuthority(ledger: RecordLedger, tasksFor: LeaseTaskResolver): LeaseAuthority {
  const leaseKey = (workspaceId: string, leaseId: string) => recordKey(workspaceId, leaseId);
  return {
    async acquire(workspaceId, requests, { cap, nowMs }) {
      return ledger.transact((tx) => {
        const granted: LeaseGrant[] = [];
        const refused: { taskId: string; reasonCode: LeaseRefusalCode }[] = [];
        let running = tx.list<LeaseRecord>('leases').filter((l) => l.state === 'active').length;
        const busy = heldResources(tx);
        const port = tasksFor(workspaceId, tx);
        for (const req of requests) {
          const task: LeaseTaskView | undefined = port?.get(req.taskId);
          if (task === undefined) {
            refused.push({ taskId: req.taskId, reasonCode: 'UNKNOWN_TASK' });
            continue;
          }
          if (task.node.state !== 'ready') {
            refused.push({ taskId: req.taskId, reasonCode: task.node.state === 'leased' || task.node.state === 'running' ? 'ALREADY_LEASED' : 'NOT_READY' });
            continue;
          }
          if (running >= cap) {
            refused.push({ taskId: req.taskId, reasonCode: 'CAP_REACHED' });
            continue;
          }
          if (task.resourceKeys.some((k) => busy.has(k))) {
            refused.push({ taskId: req.taskId, reasonCode: 'RESOURCE_BUSY' });
            continue;
          }
          const budget = tx.get<BudgetRecord>('budgets', task.node.rootBudgetId);
          if (budget === undefined) {
            refused.push({ taskId: req.taskId, reasonCode: 'UNKNOWN_BUDGET' });
            continue;
          }
          if (budget.paused === true) {
            refused.push({ taskId: req.taskId, reasonCode: 'BUDGET_PAUSED' });
            continue;
          }
          const reservation: BudgetReservation = {
            id: newId('rsv'),
            budgetId: budget.id,
            ownerId: req.ownerId,
            currency: 'USD',
            reservedMicroUsd: Math.max(0, Math.trunc(req.reserveMicroUsd)),
            actualMicroUsd: null,
            state: 'reserved',
            revision: `v${String(nowMs)}`,
          };
          const held = tx
            .list<ReservationRecord>('reservations')
            .filter((r) => r.reservation.budgetId === budget.id)
            .map((r) => r.reservation);
          const check = reservationsWithinBudget(budget.id, budget.limitMicroUsd - budget.shutdownReserveMicroUsd, [...held, reservation]);
          if (!check.ok) {
            refused.push({ taskId: req.taskId, reasonCode: 'OVER_BUDGET' });
            continue;
          }
          const fence = (tx.get<number>('fences', recordKey(workspaceId, req.taskId)) ?? 0) + 1;
          const ttl = Math.max(5_000, Math.min(req.ttlMs ?? DEFAULT_LEASE_TTL_MS, 3_600_000));
          const lease: AgentLease = {
            id: newId('lease'),
            taskId: req.taskId,
            ownerId: req.ownerId,
            workspaceId,
            worktreeId: req.worktreeId,
            fencingToken: fence,
            heartbeatAt: iso(nowMs),
            expiresAt: iso(nowMs + ttl),
          };
          if (!AgentLeaseContract.validate(lease).ok || !BudgetReservationContract.validate(reservation).ok) {
            refused.push({ taskId: req.taskId, reasonCode: 'INVALID_REQUEST' });
            continue;
          }
          // The task moves first; a refused move (it changed meanwhile) leaves the ledger alone.
          if (port === undefined || !port.leased(req.taskId, lease.id, nowMs)) {
            refused.push({ taskId: req.taskId, reasonCode: 'NOT_READY' });
            continue;
          }
          // Any older lease on this task is superseded: its token is now stale.
          for (const old of tx.list<LeaseRecord>('leases')) {
            if (old.lease.workspaceId === workspaceId && old.lease.taskId === req.taskId && old.state === 'active') {
              tx.put('leases', leaseKey(workspaceId, old.lease.id), { ...old, state: 'superseded', endedAtMs: nowMs, endReason: 'superseded' });
            }
          }
          tx.put('fences', recordKey(workspaceId, req.taskId), fence);
          tx.put('leases', leaseKey(workspaceId, lease.id), {
            lease,
            state: 'active',
            holder: req.holder,
            reservationId: reservation.id,
            resourceKeys: task.resourceKeys,
            ttlMs: ttl,
            issuedAtMs: nowMs,
            endedAtMs: null,
            endReason: null,
          } satisfies LeaseRecord);
          tx.put('reservations', reservation.id, { reservation, workspaceId, taskId: req.taskId, leaseId: lease.id, updatedAtMs: nowMs } satisfies ReservationRecord);
          for (const k of task.resourceKeys) busy.add(k);
          running += 1;
          granted.push({ lease, reservation });
        }
        return { granted, refused };
      });
    },

    async heartbeat(workspaceId, leaseId, fencingToken, nowMs) {
      return ledger.transact((tx) => {
        const row = tx.get<LeaseRecord>('leases', leaseKey(workspaceId, leaseId));
        if (row === undefined) return { ok: false, reasonCode: 'UNKNOWN_LEASE' };
        if (row.state !== 'active') return { ok: false, reasonCode: 'LEASE_NOT_ACTIVE' };
        if (row.lease.fencingToken !== fencingToken) return { ok: false, reasonCode: 'STALE_TOKEN' };
        if (Date.parse(row.lease.expiresAt) <= nowMs) return { ok: false, reasonCode: 'LEASE_EXPIRED' };
        const lease = { ...row.lease, heartbeatAt: iso(nowMs), expiresAt: iso(nowMs + row.ttlMs) };
        tx.put('leases', leaseKey(workspaceId, leaseId), { ...row, lease });
        return { ok: true, expiresAt: lease.expiresAt };
      });
    },

    async release(workspaceId, leaseId, fencingToken, spend, nowMs, reason = 'released') {
      return ledger.transact((tx) => releaseIn(tx, workspaceId, leaseId, fencingToken, spend, nowMs, reason));
    },

    async sweep(workspaceId, nowMs, liveness = (h) => livenessOf(h)) {
      return ledger.transact((tx) => {
        const expired: string[] = [];
        const port = tasksFor(workspaceId, tx);
        for (const row of tx.list<LeaseRecord>('leases')) {
          if (row.lease.workspaceId !== workspaceId || row.state !== 'active') continue;
          const late = Date.parse(row.lease.expiresAt) <= nowMs;
          const dead = liveness(row.holder) === 'dead';
          if (!late && !dead) continue;
          tx.put('leases', leaseKey(workspaceId, row.lease.id), { ...row, state: 'expired', endedAtMs: nowMs, endReason: late ? 'heartbeat-expired' : 'holder-dead' });
          const res = tx.get<ReservationRecord>('reservations', row.reservationId);
          if (res !== undefined && res.reservation.state === 'reserved') {
            tx.put('reservations', row.reservationId, { ...res, reservation: { ...res.reservation, state: 'uncertain', revision: `v${String(nowMs)}` }, updatedAtMs: nowMs });
          }
          port?.expired(row.lease.taskId, row.lease.id, nowMs);
          expired.push(row.lease.id);
        }
        // Orphans: a task that records a lease the ledger does not hold as active (a crash
        // between the task move and the ledger commit, or a release without a task move) is
        // blocked for reconciliation too. Only ledger leases are reported as expired.
        if (port !== undefined) {
          const active = new Set(tx.list<LeaseRecord>('leases').filter((l) => l.state === 'active' && l.lease.workspaceId === workspaceId).map((l) => l.lease.id));
          for (const held of port.holding()) if (!active.has(held.leaseId)) port.expired(held.taskId, held.leaseId, nowMs);
        }
        return expired;
      });
    },

    async reconcile(workspaceId, taskId, decision, nowMs) {
      return ledger.transact((tx) => {
        const port = tasksFor(workspaceId, tx);
        const task = port?.get(taskId);
        if (port === undefined || task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
        if (task.node.state !== 'blocked') return { ok: false, reasonCode: 'NOT_BLOCKED' };
        // The task moves first: a refused move (e.g. a prerequisite no longer verified) settles nothing.
        const moved = port.reconciled(taskId, decision.resume, nowMs);
        if (!moved.ok) return { ok: false, reasonCode: moved.reasonCode };
        // Uncertain spend is settled conservatively: unknown spend counts as the full reservation.
        for (const res of tx.list<ReservationRecord>('reservations')) {
          if (res.workspaceId !== workspaceId || res.taskId !== taskId || res.reservation.state !== 'uncertain') continue;
          const actual = decision.spentMicroUsd === null ? res.reservation.reservedMicroUsd : Math.max(0, Math.trunc(decision.spentMicroUsd));
          tx.put('reservations', res.reservation.id, {
            ...res,
            reservation: { ...res.reservation, state: 'committed', actualMicroUsd: actual, revision: `v${String(nowMs)}` },
            updatedAtMs: nowMs,
          });
        }
        return { ok: true };
      });
    },

    async publishFenced(workspaceId, taskId, fencingToken, fn, nowMs, release) {
      return ledger.transact((tx): FenceResult<never> | { ok: true; value: ReturnType<typeof fn> } => {
        const fence = tx.get<number>('fences', recordKey(workspaceId, taskId)) ?? 0;
        if (fencingToken < fence) return { ok: false, reasonCode: 'STALE_TOKEN' };
        const active = tx
          .list<LeaseRecord>('leases')
          .find((l) => l.lease.workspaceId === workspaceId && l.lease.taskId === taskId && l.lease.fencingToken === fencingToken);
        if (active === undefined) return { ok: false, reasonCode: 'UNKNOWN_LEASE' };
        if (active.state !== 'active' || Date.parse(active.lease.expiresAt) <= nowMs) return { ok: false, reasonCode: 'LEASE_NOT_ACTIVE' };
        const value = fn(tx);
        if (release !== undefined) releaseIn(tx, workspaceId, active.lease.id, fencingToken, release.spend, nowMs, release.reason);
        return { ok: true, value };
      });
    },

    activeLeases(workspaceId) {
      return ledger.list<LeaseRecord>('leases').filter((l) => l.state === 'active' && (workspaceId === null || l.lease.workspaceId === workspaceId));
    },
  };
}
