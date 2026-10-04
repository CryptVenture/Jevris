/**
 * Decision-call budget (§19.4, R11): reserve, commit, release, hold and reconcile.
 *
 * Replaces the old ledger behaviour where one unknown-usage timeout refused every later
 * decision forever. Now:
 *
 * - `reserve` admits a call only when `limit - committed - reserved - held >= amount`.
 * - `commit` settles a reservation with provider-reported usage and the actual cost.
 * - `release` frees a reservation whose request was never sent.
 * - `hold` marks an ambiguous outcome (a timeout that may have been billed). The full
 *   reservation stays counted, so the budget stays conservative, but later decisions are
 *   still admitted against what remains. A hold clears on `reconcile` (billing export or late
 *   provider usage); after `holdExpiryMs` it is settled at the reserved amount as an estimate.
 * - Every mutation runs under a cross-process lock (an atomic `mkdir`) and rewrites the file
 *   with the platform's durable write, so several processes can share one budget file.
 *
 * Money is integer micro-USD. Periods are UTC calendar months or days; entries of a closed
 * period stop counting except holds, which count until they are reconciled or expire.
 *
 * The file is rewritten whole, with an fsync, on every reserve and every settlement, so its size is
 * the cost of each. A busy month used to grow it without bound (measured: 27 ms per reserve and commit
 * at 3 KiB, 34 ms at 1.4 MiB and 108 ms at 5.8 MiB, so over 20 000 decisions). So settled entries of the
 * current period are folded: once more than `foldSettledAbove` (default 2000) of them are in the file,
 * all but the newest `keepSettled` (default 1000) become one summary entry per workspace (`r-fold-...`,
 * state `committed`, the sum of their cost and usage). Totals, the machine limit and every workspace cap
 * are unchanged by it (a summary counts as what it summarises), holds and open reservations are never
 * folded, and the fold is part of the same single atomic write as the change that caused it. What is
 * lost is only the per-reservation detail of settled, old spend in this file: the decision journal and
 * the store keep every decision's own record and cost.
 *
 * Limits (owner decision 2026-09-29): `currentLimit` is read again at every reserve and snapshot,
 * so a settings change applies at once and keeps the period's spent amount (it is in the file).
 * `workspaceLimit` gives a workspace its own cap inside that limit: a reservation must fit both,
 * checked under the same lock, so no two processes can together overspend either. A refusal
 * names the cap that ran out (`cap: 'machine' | 'workspace'`).
 */
import { mkdir, readFile, rmdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { durableWrite } from '@jevris/platform';

export const BUDGET_FILE_VERSION = 'jevris-decision-budget-1';

export type BudgetPeriod = 'day' | 'month' | 'none';

export type ReservationState = 'reserved' | 'committed' | 'released' | 'held' | 'reconciled' | 'expired-hold';

export interface Reservation {
  readonly id: string;
  readonly decisionId: string;
  readonly workspaceId: string;
  readonly period: string;
  readonly reservedMicroUsd: number;
  readonly state: ReservationState;
  /** Settled cost: provider usage, billing export, or the reservation for an expired hold. */
  readonly actualMicroUsd: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly source: 'provider-usage' | 'billing-export' | 'expired-hold-estimate' | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface BudgetFile {
  readonly schemaVersion: typeof BUDGET_FILE_VERSION;
  readonly reservations: readonly Reservation[];
}

export interface DecisionBudgetOptions {
  /** Spending limit per period, integer micro-USD; the fallback when `currentLimit` cannot answer. */
  readonly limitMicroUsd: number;
  /**
   * The limit now, read at every reserve and snapshot (settings may change while the process
   * runs). A throw or a value that is not integer micro-USD falls back to `limitMicroUsd`.
   */
  readonly currentLimit?: () => number;
  /**
   * A workspace's own cap inside the limit, integer micro-USD, or null for none. Read at every
   * reserve. A throw or a value that is not money is a cap of 0: the workspace goes rules-only.
   */
  readonly workspaceLimit?: (workspaceId: string) => number | null;
  readonly period?: BudgetPeriod;
  readonly holdExpiryMs?: number;
  /** Wall clock. */
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
  /** A lock directory older than this is considered abandoned by a crashed process. */
  readonly staleLockMs?: number;
  /** Settled entries of the period the file may hold before the oldest are folded (default 2000). */
  readonly foldSettledAbove?: number;
  /** Settled entries kept as they are when a fold happens, the newest ones (default 1000). */
  readonly keepSettled?: number;
}

/** Which cap refused a reservation: the machine-wide limit or the workspace's own cap. */
export type BudgetCap = 'machine' | 'workspace';

export type ReserveResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | {
      readonly ok: false;
      readonly reasonCode: 'BUDGET' | 'BUDGET_LOCKED' | 'BUDGET_STORE' | 'INVALID_AMOUNT';
      readonly availableMicroUsd: number | null;
      /** With BUDGET: the cap that ran out, and its limit (0 means it is set to no Jev calls). */
      readonly cap?: BudgetCap;
      readonly capLimitMicroUsd?: number;
    };

export type SettleResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | { readonly ok: false; readonly reasonCode: 'UNKNOWN_RESERVATION' | 'ALREADY_SETTLED' | 'BUDGET_LOCKED' | 'BUDGET_STORE' | 'INVALID_AMOUNT' };

export interface BudgetSnapshot {
  readonly period: string;
  readonly limitMicroUsd: number;
  readonly committedMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly heldMicroUsd: number;
  readonly availableMicroUsd: number;
  readonly holds: number;
  readonly reservations: number;
  /** When the period ends (UTC ISO), or null for a budget without periods. */
  readonly resetsAt: string | null;
  /** With `snapshot(workspaceId)`: that workspace's cap and use, or null when it has no cap. */
  readonly workspace?: WorkspaceBudgetSnapshot | null;
}

/** A workspace's own cap inside the limit and what it has used this period. */
export interface WorkspaceBudgetSnapshot {
  readonly workspaceId: string;
  readonly limitMicroUsd: number;
  readonly committedMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly heldMicroUsd: number;
  readonly availableMicroUsd: number;
}

const COUNT_OPEN: ReadonlySet<ReservationState> = new Set(['reserved', 'held']);
const SETTLED: ReadonlySet<ReservationState> = new Set(['committed', 'released', 'reconciled', 'expired-hold']);
/** The settled states a fold may summarise: their cost is final. An expired hold can still be reconciled, so it stays. */
const FOLDABLE: ReadonlySet<ReservationState> = new Set(['committed', 'released', 'reconciled']);
/** The id of a workspace's summary entry for a period. */
const FOLD_ID_PREFIX = 'r-fold-';

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validReservation(value: unknown): value is Reservation {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['decisionId'] === 'string' &&
    typeof r['workspaceId'] === 'string' &&
    typeof r['period'] === 'string' &&
    isMoney(r['reservedMicroUsd']) &&
    typeof r['state'] === 'string' &&
    ['reserved', 'committed', 'released', 'held', 'reconciled', 'expired-hold'].includes(r['state']) &&
    (r['actualMicroUsd'] === null || isMoney(r['actualMicroUsd'])) &&
    Number.isFinite(r['createdAtMs']) &&
    Number.isFinite(r['updatedAtMs'])
  );
}

function sleep(ms: number): Promise<void> {
  // Not unref'd: a caller waiting for the lock must keep the process alive.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function periodOf(period: BudgetPeriod, ms: number): string {
  if (period === 'none') return 'all';
  const iso = new Date(ms).toISOString();
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** The start of the next period (UTC), when the limits start again; null without periods. */
export function budgetResetsAt(period: BudgetPeriod, ms: number): string | null {
  if (period === 'none') return null;
  const d = new Date(ms);
  const next = period === 'day' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return new Date(next).toISOString();
}

/** Cost of a Jev call from token counts, in integer micro-USD (rounded up, minimum 1). */
export function jevCostMicroUsd(inputTokens: number, outputTokens: number, tariff: { readonly inputMicroUsdPerMillion: number; readonly outputMicroUsdPerMillion: number }): number {
  const raw = (inputTokens * tariff.inputMicroUsdPerMillion + outputTokens * tariff.outputMicroUsdPerMillion) / 1_000_000;
  return Math.max(1, Math.ceil(raw));
}

export class DecisionBudget {
  readonly #path: string | null;
  readonly #limit: number;
  readonly #currentLimit: (() => number) | undefined;
  readonly #workspaceLimit: ((workspaceId: string) => number | null) | undefined;
  readonly #period: BudgetPeriod;
  readonly #holdExpiryMs: number;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #foldAbove: number;
  readonly #keepSettled: number;
  #memory: Reservation[] = [];

  private constructor(path: string | null, options: DecisionBudgetOptions) {
    if (!isMoney(options.limitMicroUsd)) throw new Error('BUDGET_LIMIT_INVALID');
    this.#path = path;
    this.#limit = options.limitMicroUsd;
    this.#currentLimit = options.currentLimit;
    this.#workspaceLimit = options.workspaceLimit;
    this.#period = options.period ?? 'month';
    this.#holdExpiryMs = options.holdExpiryMs ?? 7 * 24 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => Date.now());
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.#staleLockMs = options.staleLockMs ?? 15_000;
    const keep = options.keepSettled ?? 1000;
    this.#keepSettled = Number.isSafeInteger(keep) && keep >= 0 ? keep : 1000;
    const above = options.foldSettledAbove ?? 2000;
    this.#foldAbove = Math.max(this.#keepSettled, Number.isSafeInteger(above) && above >= 0 ? above : 2000);
  }

  /** A budget persisted at `path`, shared by every process that opens the same file. */
  static open(path: string | null, options: DecisionBudgetOptions): DecisionBudget {
    return new DecisionBudget(path, options);
  }

  /** The limit now: `currentLimit` when it answers with money, else the fixed limit. */
  get limitMicroUsd(): number {
    return this.#resolveLimit();
  }

  #resolveLimit(): number {
    if (this.#currentLimit === undefined) return this.#limit;
    try {
      const value = this.#currentLimit();
      return isMoney(value) ? value : this.#limit;
    } catch {
      return this.#limit;
    }
  }

  /** The workspace's own cap, or null for none; an answer that is not money (or a throw) is 0. */
  #resolveWorkspaceLimit(workspaceId: string): number | null {
    if (this.#workspaceLimit === undefined) return null;
    try {
      const value = this.#workspaceLimit(workspaceId);
      if (value === null) return null;
      return isMoney(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async #read(): Promise<Reservation[] | null> {
    if (this.#path === null) return this.#memory.map((r) => ({ ...r }));
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      return null;
    }
    try {
      const parsed = JSON.parse(text) as Partial<BudgetFile>;
      if (parsed.schemaVersion !== BUDGET_FILE_VERSION || !Array.isArray(parsed.reservations)) return null;
      return parsed.reservations.filter(validReservation).map((r) => ({ ...r }));
    } catch {
      return null;
    }
  }

  async #write(reservations: readonly Reservation[]): Promise<boolean> {
    if (this.#path === null) {
      this.#memory = reservations.map((r) => ({ ...r }));
      return true;
    }
    const body: BudgetFile = { schemaVersion: BUDGET_FILE_VERSION, reservations };
    const written = await durableWrite(this.#path, `${JSON.stringify(body)}\n`);
    return written.ok;
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T | 'LOCKED'> {
    if (this.#path === null) return fn();
    const lock = `${this.#path}.lock`;
    const started = this.#now();
    let delay = 5;
    for (;;) {
      try {
        await mkdir(lock, { recursive: false, mode: 0o700 });
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT') {
          const parent = this.#path.slice(0, Math.max(this.#path.lastIndexOf('/'), this.#path.lastIndexOf('\\')));
          if (parent.length > 0) await mkdir(parent, { recursive: true, mode: 0o700 }).catch(() => undefined);
          continue;
        }
        // On Windows a lock folder another process is removing is "delete pending": creating it
        // then fails with EPERM, EACCES or EBUSY until the removal completes. That is contention
        // like EEXIST, bounded by the same timeout; elsewhere those codes are a real refusal.
        if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
          if (this.#now() - started > this.#lockTimeoutMs) return 'LOCKED';
          await sleep(delay);
          delay = Math.min(50, delay * 2);
          continue;
        }
        if (code !== 'EEXIST') return 'LOCKED';
        try {
          const info = await stat(lock);
          if (this.#now() - info.mtimeMs > this.#staleLockMs) {
            await rmdir(lock).catch(() => undefined);
            continue;
          }
        } catch {
          continue;
        }
        if (this.#now() - started > this.#lockTimeoutMs) return 'LOCKED';
        await sleep(delay);
        delay = Math.min(50, delay * 2);
      }
    }
    try {
      return await fn();
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }

  /** Expires old holds and drops settled entries of closed periods. */
  #maintain(reservations: Reservation[], nowMs: number): Reservation[] {
    const current = periodOf(this.#period, nowMs);
    const out: Reservation[] = [];
    for (const r of reservations) {
      if (r.state === 'held' && nowMs - r.updatedAtMs > this.#holdExpiryMs) {
        out.push({ ...r, state: 'expired-hold', actualMicroUsd: r.reservedMicroUsd, source: 'expired-hold-estimate', updatedAtMs: nowMs });
        continue;
      }
      if (r.period !== current && SETTLED.has(r.state)) continue;
      // An abandoned reservation from a closed period (the process died) is released.
      if (r.period !== current && r.state === 'reserved') continue;
      out.push(r);
    }
    return out;
  }

  /**
   * Folds the oldest settled entries of the current period into one summary entry per workspace when more than
   * `foldSettledAbove` are held (see the header). Order is by position, which is creation order: a reservation is
   * appended and settled in place. A summary is itself a committed entry, so it merges into the next fold.
   */
  #fold(reservations: Reservation[], nowMs: number): Reservation[] {
    const current = periodOf(this.#period, nowMs);
    const foldable: number[] = [];
    reservations.forEach((r, index) => {
      if (r.period === current && FOLDABLE.has(r.state)) foldable.push(index);
    });
    if (foldable.length <= this.#foldAbove) return reservations;
    const folded = new Set(foldable.slice(0, foldable.length - this.#keepSettled));
    const sums = new Map<string, Reservation>();
    for (const index of folded) {
      const r = reservations[index] as Reservation;
      const cost = r.state === 'released' ? 0 : (r.actualMicroUsd ?? r.reservedMicroUsd);
      const input = r.usage?.inputTokens ?? 0;
      const output = r.usage?.outputTokens ?? 0;
      const id = `${FOLD_ID_PREFIX}${current}-${r.workspaceId}`;
      const known = sums.get(id);
      sums.set(id, {
        id,
        decisionId: 'folded',
        workspaceId: r.workspaceId,
        period: current,
        reservedMicroUsd: (known?.reservedMicroUsd ?? 0) + cost,
        state: 'committed',
        actualMicroUsd: (known?.actualMicroUsd ?? 0) + cost,
        usage: { inputTokens: (known?.usage?.inputTokens ?? 0) + input, outputTokens: (known?.usage?.outputTokens ?? 0) + output },
        source: 'provider-usage',
        createdAtMs: Math.min(known?.createdAtMs ?? r.createdAtMs, r.createdAtMs),
        updatedAtMs: Math.max(known?.updatedAtMs ?? r.updatedAtMs, r.updatedAtMs),
      });
    }
    // A summary of nothing but released entries costs nothing and says nothing: it is not kept.
    const summaries = [...sums.values()].filter((r) => (r.actualMicroUsd ?? 0) > 0);
    return [...summaries, ...reservations.filter((_, index) => !folded.has(index))];
  }

  #totals(reservations: readonly Reservation[], nowMs: number, limit: number, workspaceId?: string): BudgetSnapshot {
    const current = periodOf(this.#period, nowMs);
    let committed = 0;
    let reserved = 0;
    let held = 0;
    let holds = 0;
    for (const r of reservations) {
      if (workspaceId !== undefined && r.workspaceId !== workspaceId) continue;
      if (r.state === 'held') {
        held += r.reservedMicroUsd;
        holds += 1;
        continue;
      }
      if (r.period !== current) continue;
      if (r.state === 'reserved') reserved += r.reservedMicroUsd;
      else if (r.state === 'committed' || r.state === 'reconciled' || r.state === 'expired-hold') committed += r.actualMicroUsd ?? r.reservedMicroUsd;
    }
    return {
      period: current,
      limitMicroUsd: limit,
      committedMicroUsd: committed,
      reservedMicroUsd: reserved,
      heldMicroUsd: held,
      availableMicroUsd: Math.max(0, limit - committed - reserved - held),
      holds,
      reservations: reservations.length,
      resetsAt: budgetResetsAt(this.#period, nowMs),
    };
  }

  #workspaceTotals(reservations: readonly Reservation[], nowMs: number, workspaceId: string, limit: number): WorkspaceBudgetSnapshot {
    const t = this.#totals(reservations, nowMs, limit, workspaceId);
    return { workspaceId, limitMicroUsd: limit, committedMicroUsd: t.committedMicroUsd, reservedMicroUsd: t.reservedMicroUsd, heldMicroUsd: t.heldMicroUsd, availableMicroUsd: t.availableMicroUsd };
  }

  /**
   * The period's totals against the limit now. With a workspace id, `workspace` also gives that
   * workspace's cap and use (null when it has no cap).
   */
  async snapshot(workspaceId?: string): Promise<BudgetSnapshot | null> {
    const all = await this.#read();
    if (all === null) return null;
    const nowMs = this.#now();
    const live = this.#maintain(all, nowMs);
    const totals = this.#totals(live, nowMs, this.#resolveLimit());
    if (workspaceId === undefined) return totals;
    const cap = this.#resolveWorkspaceLimit(workspaceId);
    return { ...totals, workspace: cap === null ? null : this.#workspaceTotals(live, nowMs, workspaceId, cap) };
  }

  async reserve(input: { readonly decisionId: string; readonly workspaceId: string; readonly microUsd: number }): Promise<ReserveResult> {
    if (!isMoney(input.microUsd) || input.microUsd === 0) return { ok: false, reasonCode: 'INVALID_AMOUNT', availableMicroUsd: null };
    // The limits are read before the lock (settings reads are not budget state); the spend they
    // are checked against is read under it, so both checks and the write are one step.
    const limit = this.#resolveLimit();
    const workspaceCap = this.#resolveWorkspaceLimit(input.workspaceId);
    const outcome = await this.#withLock(async (): Promise<ReserveResult> => {
      const all = await this.#read();
      if (all === null) return { ok: false, reasonCode: 'BUDGET_STORE', availableMicroUsd: null };
      const nowMs = this.#now();
      const live = this.#fold(this.#maintain(all, nowMs), nowMs);
      const totals = this.#totals(live, nowMs, limit);
      if (totals.availableMicroUsd < input.microUsd) return { ok: false, reasonCode: 'BUDGET', availableMicroUsd: totals.availableMicroUsd, cap: 'machine', capLimitMicroUsd: limit };
      if (workspaceCap !== null) {
        const own = this.#workspaceTotals(live, nowMs, input.workspaceId, workspaceCap);
        if (own.availableMicroUsd < input.microUsd) return { ok: false, reasonCode: 'BUDGET', availableMicroUsd: own.availableMicroUsd, cap: 'workspace', capLimitMicroUsd: workspaceCap };
      }
      const reservation: Reservation = {
        id: `r-${randomUUID()}`,
        decisionId: input.decisionId,
        workspaceId: input.workspaceId,
        period: totals.period,
        reservedMicroUsd: input.microUsd,
        state: 'reserved',
        actualMicroUsd: null,
        usage: null,
        source: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      live.push(reservation);
      if (!(await this.#write(live))) return { ok: false, reasonCode: 'BUDGET_STORE', availableMicroUsd: null };
      return { ok: true, reservation };
    });
    return outcome === 'LOCKED' ? { ok: false, reasonCode: 'BUDGET_LOCKED', availableMicroUsd: null } : outcome;
  }

  async #settle(id: string, allowed: ReadonlySet<ReservationState>, next: (r: Reservation, nowMs: number) => Reservation | 'INVALID'): Promise<SettleResult> {
    const outcome = await this.#withLock(async (): Promise<SettleResult> => {
      const all = await this.#read();
      if (all === null) return { ok: false, reasonCode: 'BUDGET_STORE' };
      const nowMs = this.#now();
      const live = this.#maintain(all, nowMs);
      const index = live.findIndex((r) => r.id === id);
      const found = live[index];
      if (found === undefined) return { ok: false, reasonCode: 'UNKNOWN_RESERVATION' };
      if (!allowed.has(found.state)) return { ok: false, reasonCode: 'ALREADY_SETTLED' };
      const updated = next(found, nowMs);
      if (updated === 'INVALID') return { ok: false, reasonCode: 'INVALID_AMOUNT' };
      live[index] = updated;
      if (!(await this.#write(live))) return { ok: false, reasonCode: 'BUDGET_STORE' };
      return { ok: true, reservation: updated };
    });
    return outcome === 'LOCKED' ? { ok: false, reasonCode: 'BUDGET_LOCKED' } : outcome;
  }

  /** Settles with provider-reported usage and its cost. */
  commit(id: string, input: { readonly usage: { readonly inputTokens: number; readonly outputTokens: number }; readonly actualMicroUsd: number }): Promise<SettleResult> {
    return this.#settle(id, new Set(['reserved']), (r, nowMs) =>
      !isMoney(input.actualMicroUsd) || !isMoney(input.usage.inputTokens) || !isMoney(input.usage.outputTokens)
        ? 'INVALID'
        : { ...r, state: 'committed', actualMicroUsd: input.actualMicroUsd, usage: { ...input.usage }, source: 'provider-usage', updatedAtMs: nowMs },
    );
  }

  /** Frees a reservation whose request never left the process. */
  release(id: string): Promise<SettleResult> {
    return this.#settle(id, new Set(['reserved']), (r, nowMs) => ({ ...r, state: 'released', actualMicroUsd: 0, source: null, updatedAtMs: nowMs }));
  }

  /** Marks usage unknown (the request may have been billed). The reservation stays counted. */
  hold(id: string): Promise<SettleResult> {
    return this.#settle(id, new Set(['reserved']), (r, nowMs) => ({ ...r, state: 'held', updatedAtMs: nowMs }));
  }

  /** Settles a held (or still reserved) entry from a billing export or late provider usage. */
  reconcile(id: string, input: { readonly actualMicroUsd: number; readonly source: 'provider-usage' | 'billing-export'; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }): Promise<SettleResult> {
    return this.#settle(id, new Set(['held', 'reserved', 'expired-hold']), (r, nowMs) =>
      !isMoney(input.actualMicroUsd)
        ? 'INVALID'
        : { ...r, state: 'reconciled', actualMicroUsd: input.actualMicroUsd, usage: input.usage === undefined ? r.usage : { ...input.usage }, source: input.source, updatedAtMs: nowMs },
    );
  }

  async get(id: string): Promise<Reservation | null> {
    const all = await this.#read();
    return all?.find((r) => r.id === id) ?? null;
  }

  /** Open (reserved or held) entries, e.g. for crash recovery. */
  async open(): Promise<readonly Reservation[]> {
    const all = await this.#read();
    return (all ?? []).filter((r) => COUNT_OPEN.has(r.state));
  }
}

/** Status's view of the Jev decision budget (E's StatusPayloadSchema `budget`, owner decision 2026-09-29). */
export interface BudgetStatusView {
  readonly state: 'unknown' | 'within' | 'bound' | 'exhausted';
  readonly reservedMicroUsd: number | null;
  readonly limitMicroUsd: number | null;
  readonly period?: string;
  readonly spentMicroUsd?: number;
  readonly resetsAt?: string;
  readonly workspace?: {
    readonly limitMicroUsd: number;
    readonly spentMicroUsd: number;
    readonly reservedMicroUsd: number;
    readonly availableMicroUsd: number;
    readonly source: 'cap' | 'repository' | 'unreadable';
  } | null;
  readonly exhaustedBy?: 'machine' | 'workspace' | null;
}

export const UNKNOWN_BUDGET_STATUS: BudgetStatusView = Object.freeze({ state: 'unknown', reservedMicroUsd: null, limitMicroUsd: null });

function field(from: unknown, key: string): unknown {
  return from !== null && typeof from === 'object' ? (from as { readonly [k: string]: unknown })[key] : undefined;
}

function moneyField(from: unknown, key: string): number | null {
  const value = field(from, key);
  return isMoney(value) ? value : null;
}

/**
 * The status view of a budget snapshot (`snapshot(workspaceId)`), checked field by field since
 * the sidecar reads it from an engine it does not type: the month's spend against the limit, the
 * workspace's cap when it has one, the reset date, and which cap has no room left (`exhausted`).
 * Anything that does not match is `unknown`.
 */
export function budgetStatusView(snapshot: unknown, workspaceSource: 'cap' | 'repository' | 'unreadable' = 'cap'): BudgetStatusView {
  const limit = moneyField(snapshot, 'limitMicroUsd');
  const available = moneyField(snapshot, 'availableMicroUsd');
  if (limit === null || available === null) return UNKNOWN_BUDGET_STATUS;
  const reserved = (moneyField(snapshot, 'reservedMicroUsd') ?? 0) + (moneyField(snapshot, 'heldMicroUsd') ?? 0);
  const own = field(snapshot, 'workspace');
  const ownLimit = moneyField(own, 'limitMicroUsd');
  const ownAvailable = moneyField(own, 'availableMicroUsd');
  const workspace =
    ownLimit === null || ownAvailable === null
      ? null
      : {
          limitMicroUsd: ownLimit,
          spentMicroUsd: moneyField(own, 'committedMicroUsd') ?? 0,
          reservedMicroUsd: (moneyField(own, 'reservedMicroUsd') ?? 0) + (moneyField(own, 'heldMicroUsd') ?? 0),
          availableMicroUsd: ownAvailable,
          source: workspaceSource,
        };
  const exhaustedBy = available <= 0 ? ('machine' as const) : workspace !== null && workspace.availableMicroUsd <= 0 ? ('workspace' as const) : null;
  const holds = moneyField(snapshot, 'holds') ?? 0;
  const period = field(snapshot, 'period');
  const resetsAt = field(snapshot, 'resetsAt');
  return {
    state: exhaustedBy !== null ? 'exhausted' : holds > 0 ? 'bound' : 'within',
    reservedMicroUsd: reserved,
    limitMicroUsd: limit,
    ...(typeof period === 'string' && /^[0-9]{4}-[0-9]{2}$/.test(period) ? { period } : {}),
    spentMicroUsd: moneyField(snapshot, 'committedMicroUsd') ?? 0,
    ...(typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt)) ? { resetsAt } : {}),
    workspace,
    exhaustedBy,
  };
}
