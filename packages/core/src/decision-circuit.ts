/**
 * A persisted circuit breaker per provider and account (PRV-08, §7.6, C54, W07).
 *
 * - closed: calls are admitted.
 * - open: after `threshold` consecutive transient failures, or at once on a 429 whose Retry-After is
 *   at least the cooldown (R77, access-limits design section 10). Every call is refused and the
 *   engine runs rules-only defaults until the open time ends: the server's Retry-After or reset
 *   header when it sent one (never shorter than the cooldown), capped at 15 minutes.
 * - half-open: after the cooldown. Only a harmless health probe is admitted.
 * - observe-only: the probe succeeded. Observation (background, advisory) calls are admitted but
 *   automation stays off. After `restoreAfter` consecutive successes on the same resolved model
 *   the breaker closes; if the model changed it stays observe-only until an administrator resets
 *   it (a probe never restores automation across a model change).
 * - disabled: a 401 (AUTH), a 402 or other billing refusal (BILLING) or a 403 account restriction
 *   (ACCOUNT, SPEC §17.3 "401 / account restriction"). Nothing is admitted until the credential
 *   fingerprint changes, or, for BILLING and ACCOUNT, until a person who fixed the account behind
 *   the same key clears it (`clearDisabled`, coordinator decision on A's R77 finding). A bad key
 *   (AUTH) stays bad, and nothing probes a disabled provider on its own: a probe could bill.
 *
 * State survives a restart: it is one JSON file written with the platform's durable write.
 * Wall-clock time is used only for the persisted cooldown, never for in-process deadlines.
 */
import { readFile } from 'node:fs/promises';
import { TRANSIENT_FAILURE_KINDS, type ProviderFailureKind } from '@jevris/contracts';
import { durableWrite } from '@jevris/platform';

export const CIRCUIT_STATES = ['closed', 'open', 'half-open', 'observe-only', 'disabled'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export const CIRCUIT_DISABLED_REASONS = ['AUTH', 'BILLING', 'ACCOUNT'] as const;
export type CircuitDisabledReason = (typeof CIRCUIT_DISABLED_REASONS)[number];

/** The command that clears a BILLING or ACCOUNT disable (status and doctor name it). */
export const CIRCUIT_REENABLE_COMMAND = 'jevris credential reenable';

/** The longest the circuit stays open on a server's Retry-After (R77). */
export const CIRCUIT_MAX_OPEN_MS = 15 * 60_000;

export interface CircuitEntry {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly openedAtMs: number | null;
  /**
   * How long an open circuit stays open after `openedAtMs`: the server's Retry-After (at least the
   * cooldown, at most 15 minutes). Kept relative to `openedAtMs`, the one time anchor, so the open
   * time moves with it. Absent in a file written before R77: the cooldown.
   */
  readonly openForMs?: number | null;
  /** When the circuit was disabled (status and doctor show it); null when not disabled or unknown (a file written before it). */
  readonly disabledAtMs?: number | null;
  readonly disabledReason: CircuitDisabledReason | null;
  readonly configFingerprint: string | null;
  readonly lastModel: string | null;
  readonly modelChanged: boolean;
  readonly updatedAtMs: number;
}

export interface CircuitOptions {
  readonly threshold?: number;
  readonly cooldownMs?: number;
  readonly restoreAfter?: number;
  /** Wall clock for the persisted cooldown. */
  readonly now?: () => number;
}

export type Admission =
  | { readonly admitted: true; readonly automation: boolean; readonly probeOnly: false }
  | { readonly admitted: true; readonly automation: false; readonly probeOnly: true }
  | { readonly admitted: false; readonly reasonCode: 'CIRCUIT_OPEN' | 'PROVIDER_DISABLED' | 'PROVIDER_BILLING' | 'OBSERVE_ONLY' };

export interface CircuitSnapshot {
  readonly key: string;
  readonly state: CircuitState;
  /** Whether automated (non-observation) decisions may use the provider. */
  readonly automation: boolean;
  /** Whether observation-only calls may use the provider. */
  readonly observation: boolean;
  readonly reasonCode: string | null;
  /** Why a disabled circuit is disabled (`circuitDisabledText` gives the status and doctor line). */
  readonly disabledReason: CircuitDisabledReason | null;
  /** When a disabled circuit was disabled; null otherwise. */
  readonly disabledSinceMs: number | null;
}

export type CircuitClearResult =
  | { readonly ok: true; readonly cleared: Exclude<CircuitDisabledReason, 'AUTH'> }
  | { readonly ok: false; readonly reasonCode: 'NOT_DISABLED' | 'AUTH_NEEDS_NEW_KEY' };

const minuteIso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

/**
 * The fixed status and doctor line for a disabled circuit (codes, a time and a command only), or
 * null when it is not disabled.
 */
export function circuitDisabledText(snapshot: CircuitSnapshot): string | null {
  if (snapshot.state !== 'disabled') return null;
  const since = snapshot.disabledSinceMs === null ? '' : ` since ${minuteIso(snapshot.disabledSinceMs)}`;
  switch (snapshot.disabledReason) {
    case 'BILLING':
      return `Jev is disabled (PROVIDER_BILLING: billing refused)${since}; decisions run rules-only. After fixing billing, run \`${CIRCUIT_REENABLE_COMMAND}\`.`;
    case 'ACCOUNT':
      return `Jev is disabled (PROVIDER_DISABLED: account restricted)${since}; decisions run rules-only. After fixing the account, run \`${CIRCUIT_REENABLE_COMMAND}\`.`;
    default:
      return `Jev is disabled (PROVIDER_DISABLED: key refused)${since}; decisions run rules-only. Run \`jevris credential set\` with a valid key.`;
  }
}

const FILE_VERSION = 'jevris-circuit-1';

function freshEntry(nowMs: number): CircuitEntry {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    openedAtMs: null,
    openForMs: null,
    disabledAtMs: null,
    disabledReason: null,
    configFingerprint: null,
    lastModel: null,
    modelChanged: false,
    updatedAtMs: nowMs,
  };
}

function validEntry(value: unknown): value is CircuitEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['state'] === 'string' &&
    (CIRCUIT_STATES as readonly string[]).includes(entry['state']) &&
    Number.isSafeInteger(entry['consecutiveFailures']) &&
    Number.isSafeInteger(entry['consecutiveSuccesses']) &&
    (entry['openedAtMs'] === null || Number.isFinite(entry['openedAtMs'])) &&
    (entry['disabledReason'] === null || (CIRCUIT_DISABLED_REASONS as readonly unknown[]).includes(entry['disabledReason'])) &&
    (entry['configFingerprint'] === null || typeof entry['configFingerprint'] === 'string') &&
    (entry['lastModel'] === null || typeof entry['lastModel'] === 'string') &&
    typeof entry['modelChanged'] === 'boolean' &&
    Number.isFinite(entry['updatedAtMs'])
  );
}

export class CircuitBreaker {
  readonly #path: string | null;
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #restoreAfter: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CircuitEntry>();

  private constructor(path: string | null, options: CircuitOptions) {
    this.#path = path;
    this.#threshold = options.threshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#restoreAfter = options.restoreAfter ?? 3;
    this.#now = options.now ?? Date.now;
  }

  /** Loads the persisted state. A missing or corrupt file starts closed (a corrupt entry is dropped). */
  static async load(path: string | null, options: CircuitOptions = {}): Promise<CircuitBreaker> {
    const breaker = new CircuitBreaker(path, options);
    if (path === null) return breaker;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return breaker;
    }
    try {
      const parsed = JSON.parse(text) as { schemaVersion?: unknown; entries?: unknown };
      if (parsed.schemaVersion !== FILE_VERSION || parsed.entries === null || typeof parsed.entries !== 'object') return breaker;
      for (const [key, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key) || !validEntry(entry)) continue;
        // An open time in the future (a tampered or skewed file) would stretch the 15-minute cap: clamp it to now.
        const now = breaker.#now();
        // An open duration that is not a finite number of at least 0 (a tampered file, or one written
        // before R77 with none, or with the earlier `openUntilMs`) reads as absent: the cooldown. The
        // entry itself is kept, so a disabled circuit stays disabled.
        const raw: unknown = (entry as unknown as Record<string, unknown>)['openForMs'];
        const openForMs = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
        // The disable time is shown, never used for timing: a bad one reads as unknown, a future one as now.
        const rawAt: unknown = (entry as unknown as Record<string, unknown>)['disabledAtMs'];
        const disabledAtMs = entry.state !== 'disabled' || typeof rawAt !== 'number' || !Number.isFinite(rawAt) || rawAt < 0 ? null : Math.min(rawAt, now);
        const { openUntilMs: _legacy, ...rest } = entry as CircuitEntry & { readonly openUntilMs?: unknown };
        breaker.#entries.set(key, { ...rest, openForMs, disabledAtMs, ...(entry.openedAtMs !== null && entry.openedAtMs > now ? { openedAtMs: now } : {}) });
      }
    } catch {
      return breaker;
    }
    return breaker;
  }

  static key(providerId: string, accountId: string): string {
    return `${providerId}:${accountId}`;
  }

  #get(key: string): CircuitEntry {
    return this.#entries.get(key) ?? freshEntry(this.#now());
  }

  #set(key: string, entry: CircuitEntry): void {
    this.#entries.set(key, { ...entry, updatedAtMs: this.#now() });
  }

  /** Moves open -> half-open when the cooldown has passed, and re-enables after a config change. */
  #advance(key: string, fingerprint: string | null): CircuitEntry {
    const entry = this.#get(key);
    if (entry.state === 'disabled' && fingerprint !== null && entry.configFingerprint !== fingerprint) {
      const reset = { ...freshEntry(this.#now()), lastModel: entry.lastModel, configFingerprint: fingerprint };
      this.#set(key, reset);
      return reset;
    }
    // A stored open time never holds longer than 15 minutes after the open (B's nit: a tampered or
    // clock-skewed file cannot keep Jev closed).
    const until = entry.openedAtMs === null ? null : entry.openedAtMs + Math.min(entry.openForMs ?? this.#cooldownMs, CIRCUIT_MAX_OPEN_MS);
    if (entry.state === 'open' && until !== null && this.#now() >= until) {
      const half = { ...entry, state: 'half-open' as const };
      this.#set(key, half);
      return half;
    }
    return entry;
  }

  admit(key: string, options: { readonly observation: boolean; readonly fingerprint: string | null; readonly probe?: boolean }): Admission {
    const entry = this.#advance(key, options.fingerprint);
    switch (entry.state) {
      case 'closed':
        return { admitted: true, automation: true, probeOnly: false };
      case 'disabled':
        return { admitted: false, reasonCode: entry.disabledReason === 'BILLING' ? 'PROVIDER_BILLING' : 'PROVIDER_DISABLED' };
      case 'open':
        return { admitted: false, reasonCode: 'CIRCUIT_OPEN' };
      case 'half-open':
        return options.probe === true ? { admitted: true, automation: false, probeOnly: true } : { admitted: false, reasonCode: 'CIRCUIT_OPEN' };
      case 'observe-only':
        return options.observation ? { admitted: true, automation: false, probeOnly: false } : { admitted: false, reasonCode: 'OBSERVE_ONLY' };
    }
  }

  recordSuccess(key: string, model: string, options: { readonly probe?: boolean } = {}): void {
    const entry = this.#get(key);
    const changed = entry.lastModel !== null && entry.lastModel !== model;
    // A probe after the cooldown restores observation only. Later probes, like observation calls,
    // count toward restoring automation on the same model.
    if (entry.state === 'half-open' || (options.probe === true && entry.state === 'open')) {
      this.#set(key, { ...entry, state: 'observe-only', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, openForMs: null, modelChanged: entry.modelChanged || changed, lastModel: entry.lastModel ?? model });
      return;
    }
    if (entry.state === 'observe-only') {
      const modelChanged = entry.modelChanged || changed;
      const successes = entry.consecutiveSuccesses + 1;
      const close = !modelChanged && successes >= this.#restoreAfter;
      this.#set(key, {
        ...entry,
        state: close ? 'closed' : 'observe-only',
        consecutiveSuccesses: close ? 0 : successes,
        consecutiveFailures: 0,
        modelChanged,
      });
      return;
    }
    this.#set(key, { ...entry, consecutiveFailures: 0, consecutiveSuccesses: entry.consecutiveSuccesses + 1, lastModel: model, modelChanged: entry.modelChanged || changed });
  }

  /**
   * The open time for a failure (R77): the server's Retry-After when it sent one, never shorter than
   * the cooldown and never longer than 15 minutes.
   */
  #openFor(retryAfterMs: number | null | undefined): number {
    const asked = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    return Math.round(Math.min(CIRCUIT_MAX_OPEN_MS, Math.max(this.#cooldownMs, asked)));
  }

  /**
   * Records a failed call. `retryAfterMs` is the server's delay (Retry-After, reset headers) when
   * it sent one. A 401 disables (AUTH), a billing refusal disables (BILLING) and a 403 account
   * restriction disables (ACCOUNT), each until the credential fingerprint changes. A 429 whose
   * delay is at least the cooldown opens at once for that delay; other transients open after
   * `threshold` in a row.
   */
  recordFailure(key: string, failure: ProviderFailureKind, fingerprint: string | null, retryAfterMs: number | null = null): void {
    const entry = this.#get(key);
    const disabled: CircuitDisabledReason | null = failure === 'auth' ? 'AUTH' : failure === 'billing' ? 'BILLING' : failure === 'forbidden' ? 'ACCOUNT' : null;
    if (disabled !== null) {
      const disabledAtMs = entry.state === 'disabled' && entry.disabledReason === disabled ? (entry.disabledAtMs ?? this.#now()) : this.#now();
      this.#set(key, { ...entry, state: 'disabled', disabledReason: disabled, configFingerprint: fingerprint, consecutiveSuccesses: 0, openForMs: null, disabledAtMs });
      return;
    }
    // A disabled circuit waits for a new credential; a transient failure never re-enables it.
    if (!TRANSIENT_FAILURE_KINDS.includes(failure) || entry.state === 'disabled') return;
    if (entry.state === 'half-open' || entry.state === 'observe-only') {
      this.#set(key, { ...entry, state: 'open', openedAtMs: this.#now(), openForMs: this.#openFor(retryAfterMs), consecutiveFailures: entry.consecutiveFailures + 1, consecutiveSuccesses: 0 });
      return;
    }
    const failures = entry.consecutiveFailures + 1;
    const serverAsked = failure === 'rate-limited' && typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= this.#cooldownMs;
    const open = entry.state === 'open' || failures >= this.#threshold || serverAsked;
    const opening = open && entry.state !== 'open';
    this.#set(key, {
      ...entry,
      state: open ? 'open' : entry.state,
      openedAtMs: opening ? this.#now() : entry.openedAtMs,
      openForMs: opening ? this.#openFor(retryAfterMs) : (entry.openForMs ?? null),
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
    });
  }

  /**
   * A person's action (`jevris credential reenable`): clears a BILLING or ACCOUNT disable after the
   * account behind the same key was fixed. The circuit restores observation first, as after a
   * successful probe; automation follows after `restoreAfter` successes. An AUTH disable is not
   * cleared (a bad key stays bad; `jevris credential set` replaces it). Nothing is called here, and
   * a fresh 402 or 403 disables again at once.
   *
   * The circuit file has a single writer: the sidecar's engine (`createSidecarEngine` is its only
   * loader) keeps it in memory and replaces the whole file on persist. So a clear goes through that
   * engine (`DecisionEngine.circuit`), never through a second process writing the file.
   */
  clearDisabled(key: string): CircuitClearResult {
    const entry = this.#get(key);
    if (entry.state !== 'disabled') return { ok: false, reasonCode: 'NOT_DISABLED' };
    if (entry.disabledReason !== 'BILLING' && entry.disabledReason !== 'ACCOUNT') return { ok: false, reasonCode: 'AUTH_NEEDS_NEW_KEY' };
    const cleared = entry.disabledReason;
    this.#set(key, { ...entry, state: 'observe-only', disabledReason: null, disabledAtMs: null, consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, openForMs: null, modelChanged: false });
    return { ok: true, cleared };
  }

  /** The keys of the circuits this breaker holds (status lists a disabled one). */
  keys(): readonly string[] {
    return [...this.#entries.keys()].sort();
  }

  /** Administrator action: restore automation after reviewing a model change. */
  resetAutomation(key: string): void {
    const entry = this.#get(key);
    if (entry.state === 'observe-only' || entry.state === 'closed') this.#set(key, { ...entry, state: 'closed', modelChanged: false, consecutiveSuccesses: 0 });
  }

  snapshot(key: string, fingerprint: string | null = null): CircuitSnapshot {
    const entry = this.#advance(key, fingerprint);
    return {
      key,
      state: entry.state,
      automation: entry.state === 'closed',
      observation: entry.state === 'closed' || entry.state === 'observe-only',
      disabledReason: entry.state === 'disabled' ? entry.disabledReason : null,
      disabledSinceMs: entry.state === 'disabled' ? (entry.disabledAtMs ?? null) : null,
      reasonCode:
        entry.state === 'disabled' ? (entry.disabledReason === 'BILLING' ? 'PROVIDER_BILLING' : 'PROVIDER_DISABLED') : entry.state === 'open' || entry.state === 'half-open' ? 'CIRCUIT_OPEN' : entry.state === 'observe-only' ? 'OBSERVE_ONLY' : null,
    };
  }

  entry(key: string): CircuitEntry {
    return this.#get(key);
  }

  /** Writes the state file. Returns false when the write failed (the in-memory state still holds). */
  async persist(): Promise<boolean> {
    if (this.#path === null) return true;
    const entries: Record<string, CircuitEntry> = {};
    for (const [key, entry] of this.#entries) entries[key] = entry;
    const written = await durableWrite(this.#path, `${JSON.stringify({ schemaVersion: FILE_VERSION, entries })}\n`);
    return written.ok;
  }
}
