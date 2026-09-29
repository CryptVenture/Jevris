/**
 * Shared access helpers for the durable-model modules: guarded read and write entry points
 * that refuse a closed, faulted or migration-refused store, record SQLite faults (DATA-08),
 * and convert safe-integer rows.
 */
import { automationRefusedGuard, driverFor, faultRefusal, type OpenStoreResult, type StoreRefusal, type StoreRefusalReason } from './open.js';
import { immediately, type SqlDriver } from './schema.js';

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function refuse(reason: StoreRefusalReason): StoreRefusal {
  return { ok: false, reason };
}

export class StoreStop extends Error {
  readonly reason: StoreRefusalReason;

  constructor(reason: StoreRefusalReason) {
    super('stop');
    this.reason = reason;
  }
}

export function field(row: unknown, key: string): unknown {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  return Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function nullableNum(value: unknown): number | null {
  return num(value) ?? null;
}

export interface Access {
  readonly driver: SqlDriver;
  readonly workspaceId: string;
}

/** Read access: a live store handle. */
export function readAccess(store: OpenStoreResult): Access | StoreRefusal {
  if (!store.ok) return refuse(store.reason);
  const driver = driverFor(store);
  if (driver === undefined) return refuse('store-unavailable');
  return { driver, workspaceId: store.workspaceId };
}

function isRefusal(value: Access | StoreRefusal): value is StoreRefusal {
  return Object.hasOwn(value, 'ok');
}

/**
 * Runs `fn` in one transaction on a writable store. A `StoreStop` becomes a refusal, a
 * SQLite fault stops owned automation and becomes its refusal, and other errors throw.
 */
export function write<T>(store: OpenStoreResult, fn: (access: Access) => T, options: { readonly ignoreAutomationRefusal?: boolean } = {}): T | StoreRefusal {
  const access = readAccess(store);
  if (isRefusal(access)) return access;
  const blocked = automationRefusedGuard(store);
  // Governance records (audit, authorization) still write after a migration refusal; a
  // disk or corruption fault stops every write.
  if (blocked !== undefined && !(options.ignoreAutomationRefusal === true && blocked.reason === 'migration-refused')) return refuse(blocked.reason);
  let result: T | undefined;
  const run = access.driver.transaction(() => {
    result = fn(access);
  });
  try {
    immediately(run);
  } catch (error) {
    if (error instanceof StoreStop) return refuse(error.reason);
    const fault = faultRefusal(store, error);
    if (fault !== undefined) return fault;
    throw error;
  }
  return result as T;
}

/** Runs a read; a SQLite fault is recorded and refused. */
export function read<T>(store: OpenStoreResult, fn: (access: Access) => T): T | StoreRefusal {
  const access = readAccess(store);
  if (isRefusal(access)) return access;
  try {
    return fn(access);
  } catch (error) {
    const fault = faultRefusal(store, error);
    if (fault !== undefined) return fault;
    throw error;
  }
}

export function isStoreRefusal(value: unknown): value is StoreRefusal {
  return value !== null && typeof value === 'object' && Reflect.get(value, 'ok') === false && typeof Reflect.get(value, 'reason') === 'string';
}
