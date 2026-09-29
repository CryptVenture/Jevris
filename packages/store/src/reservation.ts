import { issueLease } from './lease.js';
import {
  automationRefusedGuard,
  driverFor,
  type OpenStoreResult,
  type StoreRefusalReason,
} from './open.js';
import { acceptMoney, immediately, type SqlDriver } from './schema.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const JOB_RESERVATION_SQL = `
CREATE TABLE IF NOT EXISTS job_reservation (
  workspace_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'uncertain')),
  revision TEXT NOT NULL,
  PRIMARY KEY (workspace_id, reservation_id)
);
`;

class ReservationStop extends Error {
  readonly reason: StoreRefusalReason | 'refused';

  constructor(reason: StoreRefusalReason | 'refused') {
    super('stop');
    this.reason = reason;
  }
}

export interface RefusedJob {
  readonly reservationId: string;
  readonly reason: 'BUDGET';
}

export interface JobReservationRow {
  readonly reservationId: string;
  readonly ownerId: string;
  readonly reservedMicroUsd: bigint;
  readonly state: 'reserved' | 'committed' | 'released' | 'uncertain';
  readonly revision: string;
}

export type JobAdmission =
  | {
      readonly ok: true;
      readonly admitted: readonly string[];
      readonly refused: readonly RefusedJob[];
      readonly mandatoryCheckIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: StoreRefusalReason;
      readonly admitted: readonly [];
      readonly refused: readonly RefusedJob[];
      readonly mandatoryCheckIds: readonly string[];
    };

export type LeaseAndReserveResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly reservationId: string;
      readonly mandatoryCheckIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: StoreRefusalReason | 'refused';
      readonly mandatoryCheckIds: readonly string[];
    };

interface ParsedJob {
  readonly reservationId: string;
  readonly ownerId: string;
  readonly amount: bigint;
  readonly revision: string;
  readonly state: 'reserved' | 'uncertain';
}

function own(row: object, key: string): unknown {
  if (!Object.hasOwn(row, key)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value);
}

function isStamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
}

function isDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
}

function isResource(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function ensureJobReservationTables(driver: SqlDriver): void {
  driver.exec(JOB_RESERVATION_SQL);
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

function asObject(value: unknown): object | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value;
}

function parseJob(value: unknown, fallbackRevision: string): ParsedJob | 'money' | 'invalid' {
  const record = asObject(value);
  if (record === undefined) return 'invalid';
  const reservationId = own(record, 'reservationId');
  const ownerId = own(record, 'ownerId');
  if (!isId(reservationId) || !isId(ownerId)) return 'invalid';
  const rawAmount = own(record, 'reservedMicroUsd');
  if (typeof rawAmount !== 'bigint') return 'money';
  const amount = acceptMoney(rawAmount);
  if (amount === undefined) return 'money';
  const revisionValue = own(record, 'revision');
  const revision = revisionValue === undefined ? fallbackRevision : revisionValue;
  if (!isRevision(revision)) return 'invalid';
  const stateValue = own(record, 'state');
  if (stateValue !== undefined && stateValue !== 'reserved' && stateValue !== 'uncertain') return 'invalid';
  const state = stateValue === 'uncertain' ? 'uncertain' : 'reserved';
  return { reservationId, ownerId, amount, revision, state };
}

function jobsFrom(input: object): { readonly jobs: readonly ParsedJob[] } | 'money' | 'invalid' {
  const parentRevision = own(input, 'revision');
  const fallback = isRevision(parentRevision) ? parentRevision : '';
  if (Object.hasOwn(input, 'jobs')) {
    const jobs = own(input, 'jobs');
    if (!Array.isArray(jobs) || jobs.length === 0) return 'invalid';
    const parsed: ParsedJob[] = [];
    for (const job of jobs) {
      const one = parseJob(job, fallback);
      if (one === 'money' || one === 'invalid') return one;
      parsed.push(one);
    }
    return { jobs: parsed };
  }
  const one = parseJob(input, fallback);
  if (one === 'money' || one === 'invalid') return one;
  return { jobs: [one] };
}

function asBigCount(row: unknown): bigint {
  if (row === undefined || row === null || typeof row !== 'object') return 0n;
  const value = own(row, 'n');
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

function hasUncertain(driver: SqlDriver, workspaceId: string): boolean {
  const row = driver
    .prepare(
      `SELECT 1 AS n
       FROM job_reservation
       WHERE workspace_id = ? AND state = 'uncertain'
       LIMIT 1`,
    )
    .get(workspaceId);
  return row !== undefined && row !== null;
}

function sumActive(driver: SqlDriver, workspaceId: string): bigint {
  const row = driver
    .prepare(
      `SELECT COALESCE(SUM(reserved_micro_usd), 0) AS n
       FROM job_reservation
       WHERE workspace_id = ? AND state IN ('reserved', 'committed')`,
    )
    .get(workspaceId);
  return asBigCount(row);
}

function insertJob(driver: SqlDriver, workspaceId: string, job: ParsedJob): void {
  driver
    .prepare(
      `INSERT INTO job_reservation (
         workspace_id, reservation_id, owner_id, reserved_micro_usd, state, revision
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(workspaceId, job.reservationId, job.ownerId, job.amount, job.state, job.revision);
}

interface AdmitOutcome {
  readonly admitted: readonly string[];
  readonly refused: readonly RefusedJob[];
}

function admitInside(driver: SqlDriver, workspaceId: string, envelope: bigint, jobs: readonly ParsedJob[]): AdmitOutcome {
  if (hasUncertain(driver, workspaceId)) {
    return {
      admitted: [],
      refused: jobs.map((job) => ({ reservationId: job.reservationId, reason: 'BUDGET' as const })),
    };
  }
  const admitted: string[] = [];
  const refused: RefusedJob[] = [];
  let used = sumActive(driver, workspaceId);
  for (const job of jobs) {
    if (hasUncertain(driver, workspaceId)) {
      refused.push({ reservationId: job.reservationId, reason: 'BUDGET' });
      continue;
    }
    if (job.state === 'uncertain') {
      insertJob(driver, workspaceId, job);
      admitted.push(job.reservationId);
      continue;
    }
    if (used + job.amount > envelope) {
      refused.push({ reservationId: job.reservationId, reason: 'BUDGET' });
      continue;
    }
    insertJob(driver, workspaceId, job);
    used += job.amount;
    admitted.push(job.reservationId);
  }
  return { admitted, refused };
}

function guard(store: OpenStoreResult): StoreRefusalReason | undefined {
  if (!store.ok) return store.reason;
  const blocked = automationRefusedGuard(store);
  if (blocked !== undefined) return blocked.reason;
  if (driverFor(store) === undefined) return 'store-unavailable';
  return undefined;
}

function moneyRefusal(checks: readonly string[]): JobAdmission {
  return { ok: false, reason: 'money-refused', admitted: [], refused: [], mandatoryCheckIds: checks };
}

function budgetRefusal(checks: readonly string[], refused: readonly RefusedJob[]): JobAdmission {
  return { ok: false, reason: 'BUDGET', admitted: [], refused, mandatoryCheckIds: checks };
}

export function admitJobReservation(store: OpenStoreResult, input: unknown): JobAdmission {
  const checks = copyChecks(asObject(input) === undefined ? undefined : own(asObject(input) as object, 'mandatoryCheckIds'));
  const blocked = guard(store);
  if (blocked !== undefined) {
    return { ok: false, reason: blocked, admitted: [], refused: [], mandatoryCheckIds: checks };
  }
  if (!store.ok) return { ok: false, reason: 'store-unavailable', admitted: [], refused: [], mandatoryCheckIds: checks };
  const driver = driverFor(store);
  if (driver === undefined) {
    return { ok: false, reason: 'store-unavailable', admitted: [], refused: [], mandatoryCheckIds: checks };
  }
  const record = asObject(input);
  if (record === undefined) {
    return { ok: false, reason: 'invalid-input', admitted: [], refused: [], mandatoryCheckIds: checks };
  }
  const envelope = acceptMoney(own(record, 'envelopeMicroUsd'));
  if (envelope === undefined) return moneyRefusal(checks);
  const parsed = jobsFrom(record);
  if (parsed === 'money') return moneyRefusal(checks);
  if (parsed === 'invalid') {
    return { ok: false, reason: 'invalid-input', admitted: [], refused: [], mandatoryCheckIds: checks };
  }
  let outcome: AdmitOutcome | undefined;
  const run = driver.transaction(() => {
    outcome = admitInside(driver, store.workspaceId, envelope, parsed.jobs);
  });
  try {
    immediately(run);
  } catch {
    return { ok: false, reason: 'store-unavailable', admitted: [], refused: [], mandatoryCheckIds: checks };
  }
  if (outcome === undefined) {
    return { ok: false, reason: 'store-unavailable', admitted: [], refused: [], mandatoryCheckIds: checks };
  }
  if (outcome.admitted.length === 0) return budgetRefusal(checks, outcome.refused);
  return {
    ok: true,
    admitted: outcome.admitted,
    refused: outcome.refused,
    mandatoryCheckIds: checks,
  };
}

export function leaseAndReserve(store: OpenStoreResult, input: unknown): LeaseAndReserveResult {
  const record = asObject(input);
  const checks = copyChecks(record === undefined ? undefined : own(record, 'mandatoryCheckIds'));
  const blocked = guard(store);
  if (blocked !== undefined) return { ok: false, reason: blocked, mandatoryCheckIds: checks };
  if (!store.ok || record === undefined) return { ok: false, reason: 'invalid-input', mandatoryCheckIds: checks };
  const driver = driverFor(store);
  if (driver === undefined) return { ok: false, reason: 'store-unavailable', mandatoryCheckIds: checks };
  const leaseId = own(record, 'leaseId');
  const taskId = own(record, 'taskId');
  const ownerId = own(record, 'ownerId');
  const resourceKey = own(record, 'resourceKey');
  const directory = own(record, 'directory');
  const heartbeatAt = own(record, 'heartbeatAt');
  const expiresAt = own(record, 'expiresAt');
  const reservationId = own(record, 'reservationId');
  if (!isId(leaseId) || !isId(taskId) || !isId(ownerId) || !isId(reservationId)) {
    return { ok: false, reason: 'invalid-input', mandatoryCheckIds: checks };
  }
  if (!isResource(resourceKey) || !isDirectory(directory) || !isStamp(heartbeatAt) || !isStamp(expiresAt)) {
    return { ok: false, reason: 'invalid-input', mandatoryCheckIds: checks };
  }
  const envelope = acceptMoney(own(record, 'envelopeMicroUsd'));
  if (envelope === undefined) return { ok: false, reason: 'money-refused', mandatoryCheckIds: checks };
  const parsed = parseJob(record, '');
  if (parsed === 'money') return { ok: false, reason: 'money-refused', mandatoryCheckIds: checks };
  if (parsed === 'invalid') return { ok: false, reason: 'invalid-input', mandatoryCheckIds: checks };
  const run = driver.transaction(() => {
    const issued = issueLease(store, {
      leaseId,
      taskId,
      ownerId,
      resourceKey,
      directory,
      heartbeatAt,
      expiresAt,
    });
    if (!issued.ok) throw new ReservationStop(issued.reason);
    const outcome = admitInside(driver, store.workspaceId, envelope, [parsed]);
    if (outcome.admitted.length !== 1) throw new ReservationStop('BUDGET');
  });
  try {
    immediately(run);
  } catch (error) {
    if (error instanceof ReservationStop) return { ok: false, reason: error.reason, mandatoryCheckIds: checks };
    return { ok: false, reason: 'store-unavailable', mandatoryCheckIds: checks };
  }
  return { ok: true, leaseId, reservationId, mandatoryCheckIds: checks };
}

const STATES = new Set(['reserved', 'committed', 'released', 'uncertain']);

export function readJobReservations(store: OpenStoreResult): readonly JobReservationRow[] {
  if (!store.ok) return [];
  const driver = driverFor(store);
  if (driver === undefined) return [];
  const rows = driver
    .prepare(
      `SELECT reservation_id, owner_id, reserved_micro_usd, state, revision
       FROM job_reservation
       WHERE workspace_id = ?`,
    )
    .all(store.workspaceId);
  const mapped: JobReservationRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const reservationId = own(row, 'reservation_id');
    const ownerId = own(row, 'owner_id');
    const reservedMicroUsd = own(row, 'reserved_micro_usd');
    const state = own(row, 'state');
    const revision = own(row, 'revision');
    if (!isId(reservationId) || !isId(ownerId) || typeof reservedMicroUsd !== 'bigint') continue;
    if (typeof state !== 'string' || !STATES.has(state) || !isRevision(revision)) continue;
    if (state !== 'reserved' && state !== 'committed' && state !== 'released' && state !== 'uncertain') continue;
    mapped.push({ reservationId, ownerId, reservedMicroUsd, state, revision });
  }
  return mapped;
}
