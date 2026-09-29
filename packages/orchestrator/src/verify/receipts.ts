/**
 * Runner receipts (SSOT §10.5, VER-01): start and end, executable and argv, cwd, input
 * revision, exit code, signal, structured results, raw-output hash and handle, runner identity
 * and environment fingerprint. Failed runs write failed receipts.
 *
 * B's store is the only source completion reads. A receipt can be invalidated (freshness) but
 * never edited into a pass. Only `recordRunnerReceipt`, called by the runner and the CI
 * importer inside this package, writes one.
 */
import {
  invalidateVerificationReceipts,
  isStoreReceipt,
  readVerificationReceipts,
  recordVerificationReceipt,
  type OpenStoreResult,
  type StoredReceipt as StoreReceipt,
} from '@jevris/store';
import type { RecordLedger } from '../ledger.js';
import type { EnvironmentFingerprint } from './environment.js';
import type { StructuredResults } from './results.js';
import { isId, recordKey } from '../util.js';

export type ReceiptOutcome = 'passed' | 'failed' | 'unknown' | 'not-run';

export interface RunnerReceipt {
  readonly schemaVersion: 'jevris-receipt-1';
  readonly id: string;
  readonly checkId: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly manifestHash: string;
  readonly runnerId: string;
  readonly issuer: 'local-runner' | 'ci-import';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly executable: string | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly inputRevision: {
    readonly head: string;
    readonly dirtyHash: string;
    readonly revision: string;
    readonly scopeRevision: string;
    readonly branch: string | null;
    readonly lockfileHash: string;
  };
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outcome: ReceiptOutcome;
  readonly outcomeReason: string;
  readonly results: StructuredResults | null;
  readonly rawOutputHash: string;
  readonly rawOutputHandle: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly environmentHash: string;
  readonly environment: EnvironmentFingerprint;
  readonly mandatory: boolean;
  readonly requirementIds: readonly string[];
  readonly inputScopes: readonly string[];
  /** CI imports: issuer id and signing key id. Null for local runs. */
  readonly ci: { readonly issuerId: string; readonly keyId: string; readonly jobId: string; readonly artifactHash: string } | null;
}

export type ReceiptValidity = 'current' | 'invalidated';

export interface StoredReceipt {
  readonly receipt: RunnerReceipt;
  readonly validity: ReceiptValidity;
  readonly invalidatedReason: string | null;
  readonly recordedAtMs: number;
}

export interface ReceiptLedger {
  list(workspaceId: string, filter?: { readonly checkId?: string; readonly taskId?: string }): readonly StoredReceipt[];
  get(workspaceId: string, receiptId: string): StoredReceipt | undefined;
  /** Latest receipt per check id for the workspace (optionally for one task). */
  latest(workspaceId: string, taskId?: string | null): ReadonlyMap<string, StoredReceipt>;
  invalidate(workspaceId: string, receiptIds: readonly string[], reason: string): Promise<number>;
  /** False when the store is unavailable: nothing can be read or recorded. */
  readonly available: boolean;
}

const RECORDERS = new WeakSet<object>();

export interface WritableReceiptLedger extends ReceiptLedger {
  readonly writer: object;
}

/** Store bodies are capped at 64 KiB; structured results go first, then long argv. */
const BODY_BUDGET = 60_000;

function bodyFor(receipt: RunnerReceipt): RunnerReceipt {
  const size = (r: RunnerReceipt) => new TextEncoder().encode(JSON.stringify(r)).length;
  if (size(receipt) <= BODY_BUDGET) return receipt;
  const lean: RunnerReceipt = { ...receipt, results: null };
  if (size(lean) <= BODY_BUDGET) return lean;
  return { ...lean, argv: lean.argv.slice(0, 16).map((a) => a.slice(0, 256)), cwd: lean.cwd.slice(0, 1024) };
}

function isRunnerReceipt(value: unknown): value is RunnerReceipt {
  return value !== null && typeof value === 'object' && Reflect.get(value, 'schemaVersion') === 'jevris-receipt-1';
}

interface InvalidationRow {
  readonly reason: string;
}

/**
 * The receipt ledger over B's store (DATA-03, VER-01). The store is the only place a receipt
 * lives: rows are append-only, reads come back branded from the store, and invalidation there
 * demotes tasks verified by those receipts. Invalidation reasons are kept beside it in the
 * workspace state ledger (`receipt-invalidations`).
 */
export function storeReceiptLedger(store: OpenStoreResult | undefined, reasons: RecordLedger): WritableReceiptLedger {
  const writer = Object.freeze({});
  RECORDERS.add(writer);
  const open = store !== undefined && store.ok ? store : undefined;
  const reasonKey = (workspaceId: string, receiptId: string) => recordKey(workspaceId, receiptId);
  const rowOf = (row: StoreReceipt): StoredReceipt | undefined => {
    if (!isStoreReceipt(row) || !isRunnerReceipt(row.body)) return undefined;
    const invalidated = row.validity === 'invalidated';
    const why = invalidated ? reasons.get<InvalidationRow>('receipt-invalidations', reasonKey(row.body.workspaceId, row.receiptId)) : undefined;
    return { receipt: row.body, validity: row.validity, invalidatedReason: invalidated ? (why?.reason ?? 'invalidated') : null, recordedAtMs: row.recordedAtMs };
  };
  const all = (workspaceId: string, filter: { readonly taskId?: string; readonly checkId?: string; readonly receiptIds?: readonly string[] } = {}): StoredReceipt[] => {
    if (open === undefined || workspaceId !== open.workspaceId) return [];
    return readVerificationReceipts(open, filter)
      .map(rowOf)
      .filter((r): r is StoredReceipt => r !== undefined);
  };
  const api: WritableReceiptLedger = {
    writer,
    available: open !== undefined,
    list(workspaceId, filter = {}) {
      return all(workspaceId, filter);
    },
    get(workspaceId, receiptId) {
      if (!isId(workspaceId) || !isId(receiptId)) return undefined;
      return all(workspaceId, { receiptIds: [receiptId] })[0];
    },
    latest(workspaceId, taskId) {
      const out = new Map<string, StoredReceipt>();
      for (const row of all(workspaceId)) {
        if (taskId !== undefined && taskId !== null && row.receipt.taskId !== null && row.receipt.taskId !== taskId) continue;
        const prior = out.get(row.receipt.checkId);
        if (prior === undefined || prior.receipt.endedAt < row.receipt.endedAt || (prior.receipt.endedAt === row.receipt.endedAt && prior.recordedAtMs < row.recordedAtMs)) {
          out.set(row.receipt.checkId, row);
        }
      }
      return out;
    },
    async invalidate(workspaceId, receiptIds, reason) {
      if (open === undefined || workspaceId !== open.workspaceId) return 0;
      const ids = receiptIds.filter((id) => isId(id));
      if (ids.length === 0) return 0;
      const result = invalidateVerificationReceipts(open, { receiptIds: ids, nowMs: Date.now() });
      if (!result.ok) return 0;
      if (result.invalidated.length > 0) {
        await reasons.transact((tx) => {
          for (const id of result.invalidated) tx.put('receipt-invalidations', reasonKey(workspaceId, id), { reason: reason.slice(0, 200) } satisfies InvalidationRow);
        });
      }
      return result.invalidated.length;
    },
  };
  Object.defineProperty(api, 'record', {
    enumerable: false,
    value: async (receipt: RunnerReceipt, nowMs: number) => {
      if (open === undefined) throw new Error('receipt: the store is unavailable');
      if (receipt.workspaceId !== open.workspaceId) throw new Error('receipt: workspace mismatch');
      const written = recordVerificationReceipt(open, {
        receiptId: receipt.id,
        taskId: receipt.taskId,
        checkId: receipt.checkId,
        issuer: receipt.issuer,
        inputRevision: receipt.inputRevision.revision,
        scopeRevision: receipt.inputRevision.scopeRevision,
        runnerId: receipt.runnerId,
        environmentHash: receipt.environmentHash,
        outcome: receipt.outcome,
        rawHash: /^[a-f0-9]{64}$/.test(receipt.rawOutputHash) ? receipt.rawOutputHash : null,
        body: bodyFor(receipt),
        recordedAtMs: nowMs,
      });
      if (!written.ok) throw new Error(`receipt: refused by the store (${written.reason})`);
      if (written.duplicate) throw new Error('receipt: duplicate id');
    },
  });
  return api;
}

/** Package-internal: the runner and the CI importer write receipts through this. */
export async function recordRunnerReceipt(ledger: WritableReceiptLedger, receipt: RunnerReceipt, nowMs: number = Date.now()): Promise<void> {
  if (!RECORDERS.has(ledger.writer)) throw new Error('receipt: ledger is not writable');
  const record = Reflect.get(ledger, 'record') as (r: RunnerReceipt, n: number) => Promise<void>;
  await record(receipt, nowMs);
}
