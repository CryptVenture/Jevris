/**
 * A durable, multi-process record ledger for orchestration state that has no store table yet
 * (tasks until DATA-03, reminders, crash registry, pack registry, memory indexes).
 *
 * - One directory per collection; one JSON file per record, named by the hash of its id, so
 *   ids are safe on case-insensitive and Windows file systems.
 * - Every write happens inside `transact`, under an exclusive lock directory. A transaction
 *   first writes a journal, then applies it, then removes it, so a crash mid-commit is replayed
 *   (all-or-nothing) by the next locker.
 * - Within one process, transactions on one ledger queue on an in-process async mutex (sidecar
 *   concurrency audit P3): they never sleep-poll the directory lock against each other. The
 *   directory lock is only contended across processes.
 * - A caller may bound its wait with `{ signal, waitMs }`: a transaction that has not started
 *   when the signal aborts or the wait runs out is refused (`ledger: lock wait aborted` or
 *   `ledger: lock busy`) and writes nothing.
 * - A busy lock is waited for with bounded, jittered backoff up to `lockWaitMs` (default
 *   60 s): several harness sessions do write at once. A lock whose owner process is gone (same
 *   host) is reclaimed at once, and any lock older than `staleMs` (default 30 s) is taken over.
 *   Only a lock still held by a live owner at the deadline is an error.
 * - The commit (lock, journal, records, their fsyncs, unlock) runs on fs/promises, so a slow
 *   disk never holds the event loop (the verify8 profile: synchronous writes blocked it for
 *   seconds under a check's I/O). From the moment `fn` returns, this process reads the
 *   transaction's writes (they are kept in memory until the files are written), so no reader in
 *   the process sees half a transaction.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostIdentity, isThisHost, pidExists } from './orchestration/liveness.js';
import { isPlain, sha256 } from './util.js';

const COLLECTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export interface LedgerOptions {
  readonly staleMs?: number;
  readonly lockWaitMs?: number;
  readonly platform?: string;
}

export interface LedgerTx {
  get<T>(collection: string, id: string): T | undefined;
  list<T>(collection: string): readonly T[];
  put(collection: string, id: string, value: unknown): void;
  delete(collection: string, id: string): void;
}

/** Bounds on waiting for the lock: the caller's signal and at most `waitMs` (never above `lockWaitMs`). */
export interface TransactOptions {
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
}

export interface RecordLedger {
  readonly root: string;
  get<T>(collection: string, id: string): T | undefined;
  list<T>(collection: string): readonly T[];
  transact<R>(fn: (tx: LedgerTx) => R, options?: TransactOptions): Promise<R>;
}

/** The in-process queue per lock directory: the tail every next transaction waits on. */
const localQueues = new Map<string, Promise<void>>();

function aborted(signal: AbortSignal | undefined): boolean {
  return (signal as { readonly aborted?: boolean } | undefined)?.aborted === true;
}

/**
 * Takes this process's turn for `lockDir`, waiting for earlier transactions in order. Answers the
 * release; refuses when the signal aborts or `deadlineAt` passes first (its turn then passes on
 * as soon as the earlier ones finish, so the queue never stalls).
 */
async function localTurn(lockDir: string, signal: AbortSignal | undefined, deadlineAt: number): Promise<() => void> {
  const prior = localQueues.get(lockDir) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const tail = prior.then(() => mine);
  localQueues.set(lockDir, tail);
  const release = (): void => {
    done();
    if (localQueues.get(lockDir) === tail) localQueues.delete(lockDir);
  };
  if (aborted(signal)) {
    void prior.then(release);
    throw new Error('ledger: lock wait aborted');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const outcome = await new Promise<'ready' | 'aborted' | 'timeout'>((resolve) => {
    void prior.then(() => resolve('ready'));
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()));
    if (signal !== undefined) {
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  if (timer !== undefined) clearTimeout(timer);
  if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  if (outcome === 'ready') return release;
  void prior.then(release);
  throw new Error(outcome === 'aborted' ? 'ledger: lock wait aborted' : 'ledger: lock busy');
}

interface JournalOp {
  readonly c: string;
  readonly id: string;
  readonly v: unknown;
}

function fileFor(root: string, collection: string, id: string): string {
  return join(root, collection, `${sha256(id).slice(0, 40)}.json`);
}

function checkCollection(collection: string): void {
  if (!COLLECTION_PATTERN.test(collection)) throw new Error('ledger: bad collection name');
}

function writeFileDurable(path: string, text: string, sync = true): void {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, text);
    if (sync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      sleepSync(10 * (attempt + 1));
    }
  }
  try {
    rmSync(temp, { force: true });
  } catch {
    // leave the temp; it is ignored by readers
  }
  throw lastError;
}

/** writeFileDurable on fs/promises: the loop keeps turning while the disk works. */
async function writeFileDurableAsync(path: string, text: string, sync = true): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(text);
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  await rm(temp, { force: true }).catch(() => undefined);
  throw lastError;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // A short synchronous wait; only used between lock and rename retries.
  while (Date.now() < end) {
    // spin
  }
}

function readRecord(path: string): { readonly id: string; readonly v: unknown } | undefined {
  let text: string | undefined;
  // A file being replaced or scanned can refuse a read for a moment on Windows (EPERM, EBUSY,
  // EACCES). That is not an absent record: wait and read again, as the rename in the write does.
  for (let attempt = 0; text === undefined; attempt += 1) {
    try {
      if (statSync(path).size > MAX_RECORD_BYTES) return undefined;
      text = readFileSync(path, 'utf8');
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (attempt >= 7 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) return undefined;
      sleepSync(10 * (attempt + 1));
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlain(parsed) || typeof parsed['id'] !== 'string') return undefined;
    return { id: parsed['id'], v: parsed['v'] };
  } catch {
    return undefined;
  }
}

/** A collection's committed records with their ids, sorted by id (hook-state reads legacy files through it). */
export function ledgerEntries<T>(root: string, collection: string): readonly (readonly [string, T])[] {
  let names: string[];
  try {
    names = readdirSync(join(root, collection));
  } catch {
    return [];
  }
  const rows: [string, T][] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readRecord(join(root, collection, name));
    if (record !== undefined) rows.push([record.id, record.v as T]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

function readCollection(root: string, collection: string): readonly unknown[] {
  return ledgerEntries(root, collection).map((row) => row[1]);
}

export function openLedger(root: string, options: LedgerOptions = {}): RecordLedger {
  const staleMs = options.staleMs ?? 30_000;
  const lockWaitMs = options.lockWaitMs ?? 60_000;
  const lockDir = join(root, '.lock');
  const journal = join(root, 'journal.json');
  mkdirSync(root, { recursive: true, mode: 0o700 });

  function applyJournal(): void {
    let text: string;
    try {
      text = readFileSync(journal, 'utf8');
    } catch {
      return;
    }
    let ops: unknown;
    try {
      ops = JSON.parse(text);
    } catch {
      rmSync(journal, { force: true });
      return;
    }
    if (!Array.isArray(ops)) {
      rmSync(journal, { force: true });
      return;
    }
    for (const op of ops as JournalOp[]) {
      if (!isPlain(op) || typeof op.c !== 'string' || typeof op.id !== 'string') continue;
      mkdirSync(join(root, op.c), { recursive: true, mode: 0o700 });
      const path = fileFor(root, op.c, op.id);
      if (op.v === null) rmSync(path, { force: true });
      else writeFileDurable(path, JSON.stringify({ id: op.id, v: op.v }));
    }
    rmSync(journal, { force: true });
  }

  /** Applies a journal this process just wrote (the ops are in hand): records, then the journal's removal. */
  async function applyOps(ops: readonly JournalOp[]): Promise<void> {
    for (const op of ops) {
      await mkdir(join(root, op.c), { recursive: true, mode: 0o700 });
      const path = fileFor(root, op.c, op.id);
      if (op.v === null) await rm(path, { force: true });
      else await writeFileDurableAsync(path, JSON.stringify({ id: op.id, v: op.v }));
    }
    await rm(journal, { force: true });
  }

  /** The writes of the transaction being committed, readable in this process until they are on disk. */
  const inflight = new Map<string, JournalOp>();
  const inflightKey = (c: string, id: string): string => `${c}\0${id}`;

  // The stable machine host id (DATA-10); an owner file written by host name is still this host's.
  const self = { pid: process.pid, host: hostIdentity() };
  let heldNonce: string | null = null;

  function readOwner(): { readonly pid: number; readonly host: string; readonly nonce: string } | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(lockDir, 'owner'), 'utf8'));
      if (!isPlain(parsed) || typeof parsed['pid'] !== 'number' || typeof parsed['host'] !== 'string' || typeof parsed['nonce'] !== 'string') return null;
      return { pid: parsed['pid'], host: parsed['host'], nonce: parsed['nonce'] };
    } catch {
      return null;
    }
  }

  /** Removes the lock only if it still belongs to the owner we judged dead or stale. */
  function reclaim(expectedNonce: string | null): void {
    const now = readOwner();
    if (expectedNonce !== null && now !== null && now.nonce !== expectedNonce) return;
    rmSync(lockDir, { recursive: true, force: true });
  }

  async function acquire(deadlineAt: number, signal: AbortSignal | undefined): Promise<void> {
    let delay = 4;
    for (;;) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        const nonce = randomBytes(8).toString('hex');
        try {
          // Atomic but not synced: the owner file is advisory, and it only has to outlive this
          // process, not the machine (after a power loss the lock goes stale and is taken over).
          // One fsync fewer per transaction keeps the hook paths inside the sidecar's slice.
          await writeFileDurableAsync(join(lockDir, 'owner'), JSON.stringify({ pid: self.pid, host: self.host, nonce, at: Date.now() }), false);
        } catch {
          // an owner file is advisory; staleness still applies
        }
        heldNonce = nonce;
        return;
      } catch (error) {
        const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
      }
      const owner = readOwner();
      // This process holds its in-process turn, so a lock owned by this process was left behind
      // (an earlier transaction died between taking and releasing it): take it over at once.
      if (owner !== null && isThisHost(owner.host) && owner.pid === self.pid && owner.nonce !== heldNonce) {
        reclaim(owner.nonce);
        continue;
      }
      if (owner !== null && isThisHost(owner.host) && owner.pid !== self.pid && !pidExists(owner.pid)) {
        // The owner died holding the lock: its journal (if any) is replayed by the next holder.
        reclaim(owner.nonce);
        continue;
      }
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > staleMs) {
          reclaim(owner?.nonce ?? null);
          continue;
        }
      } catch {
        // the lock vanished between attempts: retry at once
        continue;
      }
      if (aborted(signal)) throw new Error('ledger: lock wait aborted');
      if (Date.now() > deadlineAt) throw new Error('ledger: lock busy');
      // Jittered exponential backoff so waiting processes do not move in lockstep.
      const wait = Math.floor(delay / 2 + Math.random() * delay);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      delay = Math.min(delay * 2, 200);
    }
  }

  async function release(): Promise<void> {
    const owner = readOwner();
    // Never remove a lock someone else took over after ours went stale.
    if (owner === null || owner.nonce === heldNonce) await rm(lockDir, { recursive: true, force: true });
    heldNonce = null;
  }

  const ledger: RecordLedger = {
    root,
    get<T>(collection: string, id: string): T | undefined {
      checkCollection(collection);
      const pending = inflight.get(inflightKey(collection, id));
      if (pending !== undefined) return (pending.v === null ? undefined : pending.v) as T | undefined;
      const record = readRecord(fileFor(root, collection, id));
      if (record === undefined || record.id !== id) return undefined;
      return record.v as T;
    },
    list<T>(collection: string): readonly T[] {
      checkCollection(collection);
      if (inflight.size === 0) return readCollection(root, collection) as readonly T[];
      const byId = new Map<string, unknown>(ledgerEntries(root, collection));
      for (const op of inflight.values()) {
        if (op.c !== collection) continue;
        if (op.v === null) byId.delete(op.id);
        else byId.set(op.id, op.v);
      }
      return [...byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]) as T[];
    },
    async transact<R>(fn: (tx: LedgerTx) => R, options: TransactOptions = {}): Promise<R> {
      const waitMs = options.waitMs === undefined ? lockWaitMs : Math.max(0, Math.min(lockWaitMs, options.waitMs));
      const deadlineAt = Date.now() + waitMs;
      const turn = await localTurn(lockDir, options.signal, deadlineAt);
      try {
        await acquire(deadlineAt, options.signal);
      } catch (error) {
        turn();
        throw error;
      }
      try {
        applyJournal();
        const staged = new Map<string, JournalOp>();
        const key = (c: string, id: string) => `${c}\0${id}`;
        const tx: LedgerTx = {
          get<T>(collection: string, id: string): T | undefined {
            checkCollection(collection);
            const pending = staged.get(key(collection, id));
            if (pending !== undefined) return (pending.v === null ? undefined : pending.v) as T | undefined;
            return ledger.get<T>(collection, id);
          },
          list<T>(collection: string): readonly T[] {
            checkCollection(collection);
            const byId = new Map<string, unknown>();
            for (const name of safeNames(join(root, collection))) {
              const record = readRecord(join(root, collection, name));
              if (record !== undefined) byId.set(record.id, record.v);
            }
            for (const op of staged.values()) {
              if (op.c !== collection) continue;
              if (op.v === null) byId.delete(op.id);
              else byId.set(op.id, op.v);
            }
            return [...byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]) as T[];
          },
          put(collection: string, id: string, value: unknown): void {
            checkCollection(collection);
            if (id.length === 0 || id.length > 512) throw new Error('ledger: bad id');
            const copy: unknown = JSON.parse(JSON.stringify(value));
            staged.set(key(collection, id), { c: collection, id, v: copy });
          },
          delete(collection: string, id: string): void {
            checkCollection(collection);
            staged.set(key(collection, id), { c: collection, id, v: null });
          },
        };
        const result = fn(tx);
        if (staged.size > 0) {
          const ops = [...staged.values()];
          // Readable in this process from now on; on disk once the journal is written and applied.
          for (const op of ops) inflight.set(inflightKey(op.c, op.id), op);
          try {
            await writeFileDurableAsync(journal, JSON.stringify(ops));
            await applyOps(ops);
          } finally {
            for (const op of ops) if (inflight.get(inflightKey(op.c, op.id)) === op) inflight.delete(inflightKey(op.c, op.id));
          }
        }
        return result;
      } finally {
        await release().catch(() => undefined);
        turn();
      }
    },
  };
  return ledger;
}

function safeNames(dir: string): readonly string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}
