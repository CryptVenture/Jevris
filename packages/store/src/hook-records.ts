/**
 * Hook-path records in the store (sidecar concurrency audit P2, owner decision ededdba; agreed
 * with D). D's hook-path collections (loop signals, stop reminders and reports, restores,
 * rehydrations, evidence selections and reads, subagent runs, compaction deferrals) move here from
 * the one-file-per-record ledger, so a hook no longer pays a directory lock and several fsyncs.
 *
 * - One table, `hook_records` (v8): workspace, collection, key, a JSON value and the time of its
 *   last write. Ids, codes, counts, times and paths only, the same content rule as D's ledger.
 * - `hookLedger(store)` has the shape of D's `RecordLedger`: `get`, `list` (sorted by key) and
 *   `transact(fn, { signal })`. `fn` is synchronous. Its writes apply all-or-nothing to an
 *   in-memory buffer when it returns, and are readable at once from every ledger on the same
 *   store. A throwing `fn` writes nothing. An aborted signal refuses before `fn` runs.
 * - The buffer is committed in one SQLite transaction at most `flushMs` (1 s) after its first
 *   write, and when the store closes. The owner accepted losing at most the last second of hook
 *   bookkeeping on a crash; receipts, budgets, money, permissions and consent never use this path.
 * - A flush the store refuses keeps the buffer and retries on the next tick. Past
 *   MAX_PENDING_BYTES of unflushed values a transaction is refused rather than growing memory.
 *
 * Retention: rows follow `decisionRetentionDays` by `at_ms` (the sweep in retention.ts, class
 * HOOK_RECORDS_RETENTION), and the ledger scope of `jevris data delete` removes the store with them.
 */
import { isStoreRefusal, read, write } from './access.js';
import { onStoreClose, type OpenedStore, type OpenStoreResult } from './open.js';
import type { SqlDriver } from './schema.js';

/** v8: hook-path records (P2). */
export const HOOK_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS hook_records (
  workspace_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
  PRIMARY KEY (workspace_id, collection, key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS hook_records_by_time ON hook_records (collection, at_ms);
`;

export const HOOK_COLLECTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** The largest value, as UTF-8 JSON (D: 256 KiB). */
export const MAX_HOOK_RECORD_BYTES = 256 * 1024;
/** The largest key, in UTF-8 bytes. */
export const MAX_HOOK_KEY_BYTES = 1024;
/** Unflushed bytes past which a transaction is refused. */
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FLUSH_MS = 1000;

export interface HookLedgerTx {
  get<T>(collection: string, key: string): T | undefined;
  list<T>(collection: string): readonly T[];
  put(collection: string, key: string, value: unknown): void;
  delete(collection: string, key: string): void;
}

export interface HookTransactOptions {
  readonly signal?: AbortSignal;
}

export interface HookLedger {
  readonly workspaceId: string;
  get<T>(collection: string, key: string): T | undefined;
  list<T>(collection: string): readonly T[];
  transact<R>(fn: (tx: HookLedgerTx) => R, options?: HookTransactOptions): Promise<R>;
}

export interface HookLedgerOptions {
  /** The commit window; tests shorten it. Default 1000 ms. */
  readonly flushMs?: number;
  readonly nowMs?: () => number;
}

/** A pending write: the JSON text, or null for a delete. */
interface Pending {
  readonly text: string | null;
  readonly atMs: number;
}

/** Per open store (keyed by its SQLite driver, so workspace views share one buffer and one flush). */
interface Buffer {
  readonly store: OpenedStore;
  /** workspace \0 collection -> key -> pending write. */
  readonly pending: Map<string, Map<string, Pending>>;
  /** Pending value size in UTF-16 code units: a bound on memory, not an exact byte count. */
  bytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  flushMs: number;
}

const buffers = new WeakMap<SqlDriver, Buffer>();

function bufferKey(workspaceId: string, collection: string): string {
  return `${workspaceId}\0${collection}`;
}

function checkCollection(collection: unknown): asserts collection is string {
  if (typeof collection !== 'string' || !HOOK_COLLECTION_PATTERN.test(collection)) throw new Error('hook ledger: invalid collection');
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || utf8Bytes(key) > MAX_HOOK_KEY_BYTES) throw new Error('hook ledger: invalid key');
}

const utf8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return utf8.encode(text).byteLength;
}

function encode(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string') throw new Error('hook ledger: value is not JSON');
  if (utf8Bytes(text) > MAX_HOOK_RECORD_BYTES) throw new Error('hook ledger: record too large');
  return text;
}

function decode<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function driverOf(store: OpenedStore): SqlDriver {
  const access = read(store, ({ driver }) => driver);
  if (isStoreRefusal(access)) throw new Error(`hook ledger: store ${access.reason}`);
  return access;
}

/** Commits every pending write in one transaction. False when the store refused (the buffer stays). */
function flushBuffer(buffer: Buffer): boolean {
  if (buffer.timer !== undefined) {
    clearTimeout(buffer.timer);
    buffer.timer = undefined;
  }
  if (buffer.pending.size === 0) return true;
  const batch = [...buffer.pending.entries()];
  const result = write(
    buffer.store,
    ({ driver }) => {
      const upsert = driver.prepare(
        `INSERT INTO hook_records (workspace_id, collection, key, value, at_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, collection, key) DO UPDATE SET value = excluded.value, at_ms = excluded.at_ms`,
      );
      const remove = driver.prepare('DELETE FROM hook_records WHERE workspace_id = ? AND collection = ? AND key = ?');
      for (const [scope, entries] of batch) {
        const cut = scope.indexOf('\0');
        const workspaceId = scope.slice(0, cut);
        const collection = scope.slice(cut + 1);
        for (const [key, entry] of entries) {
          if (entry.text === null) remove.run(workspaceId, collection, key);
          else upsert.run(workspaceId, collection, key, entry.text, entry.atMs);
        }
      }
      return true;
    },
  );
  if (isStoreRefusal(result)) {
    schedule(buffer);
    return false;
  }
  // Only what was committed leaves the buffer: a write made after the batch was taken stays.
  for (const [scope, entries] of batch) {
    const live = buffer.pending.get(scope);
    if (live === undefined) continue;
    for (const [key, entry] of entries) {
      if (live.get(key) === entry) {
        live.delete(key);
        buffer.bytes -= entry.text === null ? 0 : entry.text.length;
      }
    }
    if (live.size === 0) buffer.pending.delete(scope);
  }
  if (buffer.pending.size === 0 || buffer.bytes < 0) buffer.bytes = 0;
  return true;
}

function schedule(buffer: Buffer): void {
  if (buffer.timer !== undefined || buffer.pending.size === 0) return;
  const timer = setTimeout(() => {
    buffer.timer = undefined;
    try {
      flushBuffer(buffer);
    } catch {
      schedule(buffer);
    }
  }, buffer.flushMs);
  (timer as { unref?: () => void }).unref?.();
  buffer.timer = timer;
}

function bufferFor(store: OpenedStore, flushMs: number): Buffer {
  const driver = driverOf(store);
  let buffer = buffers.get(driver);
  if (buffer === undefined) {
    buffer = { store, pending: new Map(), bytes: 0, timer: undefined, flushMs };
    buffers.set(driver, buffer);
    const own = buffer;
    onStoreClose(store, () => {
      try {
        flushBuffer(own);
      } finally {
        if (own.timer !== undefined) clearTimeout(own.timer);
        own.timer = undefined;
      }
    });
  } else if (flushMs < buffer.flushMs) {
    buffer.flushMs = flushMs;
  }
  return buffer;
}

/**
 * Commits every buffered hook record of this store now. The sidecar calls it before it closes the
 * store (closing flushes too). False when the store refused; the buffer then stays for a retry.
 */
export function flushHookRecords(store: OpenStoreResult): boolean {
  if (!store.ok) return false;
  const access = read(store, ({ driver }) => driver);
  if (isStoreRefusal(access)) return false;
  const buffer = buffers.get(access);
  return buffer === undefined ? true : flushBuffer(buffer);
}

/** Pending counts, for status and tests. */
export function hookRecordsPending(store: OpenStoreResult): { readonly records: number; readonly bytes: number } {
  if (!store.ok) return { records: 0, bytes: 0 };
  const access = read(store, ({ driver }) => driver);
  if (isStoreRefusal(access)) return { records: 0, bytes: 0 };
  const buffer = buffers.get(access);
  if (buffer === undefined) return { records: 0, bytes: 0 };
  let records = 0;
  for (const entries of buffer.pending.values()) records += entries.size;
  return { records, bytes: buffer.bytes };
}

/**
 * D's hook-path ledger over the store, scoped to `store.workspaceId` (pass a workspace view for
 * another workspace). Reads see buffered writes at once; commits follow within `flushMs`.
 */
export function hookLedger(store: OpenStoreResult, options: HookLedgerOptions = {}): HookLedger {
  if (!store.ok) throw new Error(`hook ledger: store ${store.reason}`);
  const opened = store;
  const workspaceId = opened.workspaceId;
  const flushMs = Math.max(1, Math.min(options.flushMs ?? DEFAULT_FLUSH_MS, DEFAULT_FLUSH_MS));
  const nowMs = options.nowMs ?? Date.now;
  bufferFor(opened, flushMs);

  const committedRow = (collection: string, key: string): string | undefined => {
    const row = read(opened, ({ driver }) => driver.prepare('SELECT value FROM hook_records WHERE workspace_id = ? AND collection = ? AND key = ?').get(workspaceId, collection, key));
    if (isStoreRefusal(row)) throw new Error(`hook ledger: store ${row.reason}`);
    const value = row === undefined || row === null ? undefined : Reflect.get(row as object, 'value');
    return typeof value === 'string' ? value : undefined;
  };

  const committedList = (collection: string): Map<string, string> => {
    const rows = read(opened, ({ driver }) => driver.prepare('SELECT key, value FROM hook_records WHERE workspace_id = ? AND collection = ?').all(workspaceId, collection));
    if (isStoreRefusal(rows)) throw new Error(`hook ledger: store ${rows.reason}`);
    const out = new Map<string, string>();
    for (const row of rows as readonly unknown[]) {
      const key = Reflect.get(row as object, 'key');
      const value = Reflect.get(row as object, 'value');
      if (typeof key === 'string' && typeof value === 'string') out.set(key, value);
    }
    return out;
  };

  /** The current text: the transaction's own write, then the buffer, then the table. */
  const textOf = (collection: string, key: string, staged?: Map<string, Pending>): string | undefined => {
    const scope = bufferKey(workspaceId, collection);
    const own = staged?.get(`${scope}\0${key}`);
    if (own !== undefined) return own.text ?? undefined;
    const buffer = bufferFor(opened, flushMs);
    const pending = buffer.pending.get(scope)?.get(key);
    if (pending !== undefined) return pending.text ?? undefined;
    return committedRow(collection, key);
  };

  const listOf = <T>(collection: string, staged?: Map<string, Pending>): readonly T[] => {
    const scope = bufferKey(workspaceId, collection);
    const merged = committedList(collection);
    const buffer = bufferFor(opened, flushMs);
    for (const [key, entry] of buffer.pending.get(scope) ?? []) {
      if (entry.text === null) merged.delete(key);
      else merged.set(key, entry.text);
    }
    if (staged !== undefined) {
      const prefix = `${scope}\0`;
      for (const [compound, entry] of staged) {
        if (!compound.startsWith(prefix)) continue;
        const key = compound.slice(prefix.length);
        if (entry.text === null) merged.delete(key);
        else merged.set(key, entry.text);
      }
    }
    const keys = [...merged.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: T[] = [];
    for (const key of keys) {
      const value = decode<T>(merged.get(key) as string);
      if (value !== undefined) out.push(value);
    }
    return out;
  };

  return Object.freeze({
    workspaceId,
    get<T>(collection: string, key: string): T | undefined {
      checkCollection(collection);
      checkKey(key);
      const text = textOf(collection, key);
      return text === undefined ? undefined : decode<T>(text);
    },
    list<T>(collection: string): readonly T[] {
      checkCollection(collection);
      return listOf<T>(collection);
    },
    async transact<R>(fn: (tx: HookLedgerTx) => R, transactOptions: HookTransactOptions = {}): Promise<R> {
      if (transactOptions.signal?.aborted === true) throw new Error('ledger: lock wait aborted');
      const buffer = bufferFor(opened, flushMs);
      if (buffer.bytes > MAX_PENDING_BYTES && !flushBuffer(buffer)) throw new Error('hook ledger: store not committing');
      const staged = new Map<string, Pending>();
      const atMs = nowMs();
      const tx: HookLedgerTx = {
        get<T>(collection: string, key: string): T | undefined {
          checkCollection(collection);
          checkKey(key);
          const text = textOf(collection, key, staged);
          return text === undefined ? undefined : decode<T>(text);
        },
        list<T>(collection: string): readonly T[] {
          checkCollection(collection);
          return listOf<T>(collection, staged);
        },
        put(collection: string, key: string, value: unknown): void {
          checkCollection(collection);
          checkKey(key);
          staged.set(`${bufferKey(workspaceId, collection)}\0${key}`, { text: encode(value), atMs });
        },
        delete(collection: string, key: string): void {
          checkCollection(collection);
          checkKey(key);
          staged.set(`${bufferKey(workspaceId, collection)}\0${key}`, { text: null, atMs });
        },
      };
      const result = fn(tx);
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('hook ledger: the transaction function must be synchronous');
      }
      // All-or-nothing: nothing reached the buffer until fn returned.
      for (const [compound, entry] of staged) {
        const cut = compound.lastIndexOf('\0');
        const scope = compound.slice(0, cut);
        const key = compound.slice(cut + 1);
        let entries = buffer.pending.get(scope);
        if (entries === undefined) {
          entries = new Map();
          buffer.pending.set(scope, entries);
        }
        const before = entries.get(key);
        if (before !== undefined && before.text !== null) buffer.bytes -= before.text.length;
        entries.set(key, entry);
        if (entry.text !== null) buffer.bytes += entry.text.length;
      }
      schedule(buffer);
      return result;
    },
  });
}
