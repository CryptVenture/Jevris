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
  /** Spending limit per period, integer micro-USD. */
  readonly limitMicroUsd: number;
  readonly period?: BudgetPeriod;
  readonly holdExpiryMs?: number;
  /** Wall clock. */
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
  /** A lock directory older than this is considered abandoned by a crashed process. */
  readonly staleLockMs?: number;
}

export type ReserveResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | { readonly ok: false; readonly reasonCode: 'BUDGET' | 'BUDGET_LOCKED' | 'BUDGET_STORE' | 'INVALID_AMOUNT'; readonly availableMicroUsd: number | null };

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
}

const COUNT_OPEN: ReadonlySet<ReservationState> = new Set(['reserved', 'held']);
const SETTLED: ReadonlySet<ReservationState> = new Set(['committed', 'released', 'reconciled', 'expired-hold']);

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

/** Cost of a Jev call from token counts, in integer micro-USD (rounded up, minimum 1). */
export function jevCostMicroUsd(inputTokens: number, outputTokens: number, tariff: { readonly inputMicroUsdPerMillion: number; readonly outputMicroUsdPerMillion: number }): number {
  const raw = (inputTokens * tariff.inputMicroUsdPerMillion + outputTokens * tariff.outputMicroUsdPerMillion) / 1_000_000;
  return Math.max(1, Math.ceil(raw));
}

export class DecisionBudget {
  readonly #path: string | null;
  readonly #limit: number;
  readonly #period: BudgetPeriod;
  readonly #holdExpiryMs: number;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  #memory: Reservation[] = [];

  private constructor(path: string | null, options: DecisionBudgetOptions) {
    if (!isMoney(options.limitMicroUsd)) throw new Error('BUDGET_LIMIT_INVALID');
    this.#path = path;
    this.#limit = options.limitMicroUsd;
    this.#period = options.period ?? 'month';
    this.#holdExpiryMs = options.holdExpiryMs ?? 7 * 24 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => Date.now());
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.#staleLockMs = options.staleLockMs ?? 15_000;
  }

  /** A budget persisted at `path`, shared by every process that opens the same file. */
  static open(path: string | null, options: DecisionBudgetOptions): DecisionBudget {
    return new DecisionBudget(path, options);
  }

  get limitMicroUsd(): number {
    return this.#limit;
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

  #totals(reservations: readonly Reservation[], nowMs: number): BudgetSnapshot {
    const current = periodOf(this.#period, nowMs);
    let committed = 0;
    let reserved = 0;
    let held = 0;
    let holds = 0;
    for (const r of reservations) {
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
      limitMicroUsd: this.#limit,
      committedMicroUsd: committed,
      reservedMicroUsd: reserved,
      heldMicroUsd: held,
      availableMicroUsd: Math.max(0, this.#limit - committed - reserved - held),
      holds,
      reservations: reservations.length,
    };
  }

  async snapshot(): Promise<BudgetSnapshot | null> {
    const all = await this.#read();
    if (all === null) return null;
    const nowMs = this.#now();
    return this.#totals(this.#maintain(all, nowMs), nowMs);
  }

  async reserve(input: { readonly decisionId: string; readonly workspaceId: string; readonly microUsd: number }): Promise<ReserveResult> {
    if (!isMoney(input.microUsd) || input.microUsd === 0) return { ok: false, reasonCode: 'INVALID_AMOUNT', availableMicroUsd: null };
    const outcome = await this.#withLock(async (): Promise<ReserveResult> => {
      const all = await this.#read();
      if (all === null) return { ok: false, reasonCode: 'BUDGET_STORE', availableMicroUsd: null };
      const nowMs = this.#now();
      const live = this.#maintain(all, nowMs);
      const totals = this.#totals(live, nowMs);
      if (totals.availableMicroUsd < input.microUsd) return { ok: false, reasonCode: 'BUDGET', availableMicroUsd: totals.availableMicroUsd };
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
