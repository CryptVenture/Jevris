/**
 * Hook-path records in the store (sidecar concurrency audit P2; owner decisions DOMAINS ededdba,
 * B a8b512e).
 *
 * The collections below are written on the hook path (loop signals, Stop reminders and reports,
 * the restore queue and outcomes, rehydrations, evidence selections and reads, subagent runs,
 * compaction deferrals). With a store open they live in B's `hook_records` table through
 * `hookLedger`: a transaction applies to an in-memory buffer at once and commits within one
 * second, with no directory lock and no fsync per event. The owner accepted losing at most the
 * last second of this bookkeeping on a crash. Tasks, leases, receipts, budgets, money, consent,
 * capsules and freshness stay in their durable homes.
 *
 * - `ws.hook` is the ledger for these collections: its transaction writes only them.
 * - `ws.state` still reads them (routed by collection name), and a `ws.state` transaction that
 *   writes one applies that part to the hook ledger in the same synchronous step, inside the
 *   file ledger's transaction, so callers written against one ledger keep working.
 * Without a store (outside the sidecar), both are the file ledger, as before.
 *
 * Upgrade: a record an earlier version wrote as a file (or a process without the store writes)
 * stays readable through both ledgers until it ages out: a read takes the hook record, else the
 * file. A write goes to the hook records only, and shadows the file's copy.
 */
import { hookLedger, type HookLedger, type OpenedStore } from '@jevris/store';
import { ledgerEntries, type LedgerTx, type RecordLedger, type TransactOptions } from './ledger.js';

export const HOOK_COLLECTIONS: ReadonlySet<string> = new Set([
  'loop-signals',
  'loop-explained',
  'stop-reminders',
  'stop-reports',
  'restores',
  'rehydrations',
  'restore-outcomes',
  'evidence-selections',
  'evidence-reads',
  'subagent-runs',
  'compaction-deferrals',
  'display-queue',
]);

export function isHookCollection(collection: string): boolean {
  return HOOK_COLLECTIONS.has(collection);
}

function hookOptions(options: TransactOptions | undefined): { readonly signal?: AbortSignal } {
  return options?.signal === undefined ? {} : { signal: options.signal };
}

type Reader = Pick<LedgerTx, 'get' | 'list'>;

/** A hook collection's record: the hook ledger's, else an earlier file's. */
function readThroughGet<T>(hook: Reader, file: Reader, collection: string, id: string): T | undefined {
  return hook.get<T>(collection, id) ?? file.get<T>(collection, id);
}

/** A hook collection's records: the hook ledger's, then the earlier files' it does not shadow. */
function readThroughList<T>(hook: Reader, fileRoot: string, collection: string): readonly T[] {
  const legacy = ledgerEntries<T>(fileRoot, collection);
  const own = hook.list<T>(collection);
  if (legacy.length === 0) return own;
  return [...own, ...legacy.filter(([id]) => hook.get(collection, id) === undefined).map(([, value]) => value)];
}

/** A transaction view: hook collections through `hook`, the rest through `file`. */
function composite(file: LedgerTx, hook: LedgerTx, fileRoot: string): LedgerTx {
  return {
    get: <T>(collection: string, id: string): T | undefined => (isHookCollection(collection) ? readThroughGet<T>(hook, file, collection, id) : file.get<T>(collection, id)),
    list: <T>(collection: string): readonly T[] => (isHookCollection(collection) ? readThroughList<T>(hook, fileRoot, collection) : file.list<T>(collection)),
    put: (collection: string, id: string, value: unknown): void => (isHookCollection(collection) ? hook.put(collection, id, value) : file.put(collection, id, value)),
    delete: (collection: string, id: string): void => (isHookCollection(collection) ? hook.delete(collection, id) : file.delete(collection, id)),
  };
}

/** Refuses a write to anything but a hook collection (a ws.hook transaction). */
function hookOnly(hook: LedgerTx, file: RecordLedger): LedgerTx {
  const refuse = (collection: string): never => {
    throw new Error(`ledger: ${collection} is not a hook-path collection`);
  };
  return {
    get: <T>(collection: string, id: string): T | undefined => (isHookCollection(collection) ? readThroughGet<T>(hook, file, collection, id) : file.get<T>(collection, id)),
    list: <T>(collection: string): readonly T[] => (isHookCollection(collection) ? readThroughList<T>(hook, file.root, collection) : file.list<T>(collection)),
    put: (collection: string, id: string, value: unknown): void => (isHookCollection(collection) ? hook.put(collection, id, value) : refuse(collection)),
    delete: (collection: string, id: string): void => (isHookCollection(collection) ? hook.delete(collection, id) : refuse(collection)),
  };
}

/**
 * Runs `fn` inside `hook.transact` synchronously (the hook ledger applies its writes when `fn`
 * returns), and throws synchronously what `fn` threw, so an enclosing file transaction writes
 * nothing either.
 */
function inHook<R>(hook: HookLedger, fn: (tx: LedgerTx) => R): R {
  let ran = false;
  let failure: { readonly error: unknown } | undefined;
  let result: R | undefined;
  const pending = hook.transact((htx) => {
    ran = true;
    try {
      result = fn(htx);
    } catch (error) {
      failure = { error };
      throw error;
    }
    return undefined;
  });
  void pending.catch(() => undefined);
  if (failure !== undefined) throw failure.error;
  if (!ran) throw new Error('hook ledger: unavailable');
  return result as R;
}

export interface HookState {
  /** Hook-path collections only (writes); reads route by collection. */
  readonly hook: RecordLedger;
  /** The workspace ledger: reads route by collection; a transaction may write both kinds. */
  readonly state: RecordLedger;
}

/** The two ledgers over an open store; the file ledger alone when the hook ledger cannot open. */
export function hookState(file: RecordLedger, store: OpenedStore): HookState {
  let hook: HookLedger;
  try {
    hook = hookLedger(store);
  } catch {
    return { hook: file, state: file };
  }
  const get = <T>(collection: string, id: string): T | undefined => (isHookCollection(collection) ? readThroughGet<T>(hook, file, collection, id) : file.get<T>(collection, id));
  const list = <T>(collection: string): readonly T[] => (isHookCollection(collection) ? readThroughList<T>(hook, file.root, collection) : file.list<T>(collection));
  return {
    hook: {
      root: file.root,
      get,
      list,
      transact: <R>(fn: (tx: LedgerTx) => R, options?: TransactOptions): Promise<R> => hook.transact((htx) => fn(hookOnly(htx, file)), hookOptions(options)),
    },
    state: {
      root: file.root,
      get,
      list,
      transact: <R>(fn: (tx: LedgerTx) => R, options?: TransactOptions): Promise<R> => file.transact((ftx) => inHook(hook, (htx) => fn(composite(ftx, htx, file.root))), options),
    },
  };
}
