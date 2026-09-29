/**
 * The harness model-offer refresh (owner decision 2026-09-27, DOMAINS 3f090fa): the sidecar keeps
 * current, per machine, which models each installed harness says it offers, so C's account
 * eligibility has local evidence. B owns the scheduling:
 *
 * - it runs only while the sidecar is idle (nothing in flight, no request for IDLE_QUIET_MS),
 *   never from a hook, never on the hot path, and never concurrently with itself;
 * - one harness at a time, each listing bounded by MODEL_OFFER_LISTING_TIMEOUT_MS;
 * - a harness is due when its last refresh is older than MODEL_OFFER_REFRESH_MS (locked), when its
 *   installed version differs from the one its offer was listed under, when a session starts
 *   under a new harness version, or when it has no offer yet.
 *
 * F lists the models (`listOfferedModels`: the harness's own listing, no billed call, no model
 * run); C owns the file (`<data>/route-learning/model-offer.json`, model ids only) and reads it
 * for eligibility. The refresh records counts and reason codes only (a trace per harness).
 * Retention is ROUTE_LEARNING_RETENTION: the file is replaced by each refresh, never swept, and
 * removed by `jevris data delete`, `uninstall --delete-data` and `route learning reset --machine`.
 */

/** Locked: a harness's offer is refreshed at most this often unless its version changes. */
export const MODEL_OFFER_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Each harness listing's bound. */
export const MODEL_OFFER_LISTING_TIMEOUT_MS = 10_000;
/** The sidecar counts as idle once no request arrived for this long and none is in flight. */
export const IDLE_QUIET_MS = 5_000;
/** How often the refresher looks for due harnesses. */
export const MODEL_OFFER_CHECK_MS = 60 * 60 * 1000;

const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

export type ModelListing = { readonly ok: true; readonly version: string | null; readonly models: readonly string[] } | { readonly ok: false; readonly reasonCode: string };

/** What the offer file says about one harness (C's readModelOffer). */
export interface OfferedEntry {
  readonly version: string | null;
  readonly refreshedAtMs: number;
}

export interface ModelOfferPorts {
  /** Harnesses installed for this home (F's installedHarnesses). */
  installed(): Promise<readonly string[]> | readonly string[];
  /** The installed version the harness was recorded with, or null (F's readRecordedVersion). */
  recordedVersion(harness: string): Promise<string | null> | string | null;
  /** F's listOfferedModels. */
  list(input: { readonly harness: string; readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<ModelListing>;
  /** The current offer per harness (C's readModelOffer). */
  read(): Promise<{ readonly [harness: string]: OfferedEntry }> | { readonly [harness: string]: OfferedEntry };
  /** Records one harness's listing (C's recordModelOffer); a failure keeps the earlier models. */
  record(harness: string, listing: ModelListing, nowMs: number): Promise<void> | void;
}

export type RefreshReason = 'start' | 'stale' | 'version-changed' | 'session-version' | 'missing';

export interface RefreshOutcome {
  readonly harness: string;
  readonly reason: RefreshReason;
  readonly models: number;
  readonly reasonCode: string | null;
  readonly ms: number;
}

export interface ModelOfferRefresher {
  /** Asks for a refresh (all installed harnesses, or one); it runs at the next idle moment. */
  request(reason: RefreshReason, harness?: string): void;
  /** A session started under this harness version: refresh when it differs from the offer's. */
  noteHarnessVersion(harness: string, version: string | null): void;
  /** Runs the due harnesses now if idle and not already running; resolves with what ran. */
  tick(): Promise<readonly RefreshOutcome[]>;
  running(): boolean;
  close(): Promise<void>;
}

/**
 * The listing, cut at its bound. The bound timer stays referenced: it is what ends a listing that
 * never settles, and an unref'd one lets the event loop empty first (Node 22.14.0 then drops the
 * pending work). It is cleared when the listing settles, and close() aborting ends it at once, so
 * it never holds the process for longer than one listing's bound.
 */
function withTimeout(work: Promise<ModelListing>, ms: number, controller: AbortController): Promise<ModelListing> {
  return new Promise((resolve) => {
    const settle = (value: ModelListing): void => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => settle({ ok: false, reasonCode: 'LISTING_CANCELLED' });
    const timer = setTimeout(() => {
      settle({ ok: false, reasonCode: 'LISTING_TIMEOUT' });
      controller.abort();
    }, ms);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    work.then(settle, () => settle({ ok: false, reasonCode: 'LISTING_FAILED' }));
  });
}

export function createModelOfferRefresher(input: {
  readonly ports: ModelOfferPorts;
  readonly isIdle: () => boolean;
  readonly now?: () => number;
  readonly trace?: (outcome: RefreshOutcome) => void;
  readonly refreshMs?: number;
  readonly listingTimeoutMs?: number;
  /** Retry delay while the sidecar is busy (tests shorten it). */
  readonly busyRetryMs?: number;
  /**
   * Whether the refresh may run at all (SSOT §4.2: in off mode no background network activity).
   * False: nothing is listed and nothing is recorded; the periodic check asks again later.
   */
  readonly allowed?: () => boolean;
}): ModelOfferRefresher {
  const now = input.now ?? Date.now;
  const refreshMs = input.refreshMs ?? MODEL_OFFER_REFRESH_MS;
  const listingTimeoutMs = input.listingTimeoutMs ?? MODEL_OFFER_LISTING_TIMEOUT_MS;
  const busyRetryMs = input.busyRetryMs ?? IDLE_QUIET_MS;
  /** Harnesses asked for explicitly, with the reason; '*' means every installed harness. */
  const asked = new Map<string, RefreshReason>();
  let inFlight: Promise<readonly RefreshOutcome[]> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let current: AbortController | undefined;
  /**
   * The recorded version each harness was last refreshed under, so a listing that reports its
   * version in another form than the install record cannot make a harness due again and again.
   */
  const refreshedUnder = new Map<string, string | null>();

  function scheduleRetry(): void {
    if (closed || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      void refresher.tick();
    }, busyRetryMs);
    retry.unref?.();
  }

  async function dueHarnesses(): Promise<{ readonly harness: string; readonly reason: RefreshReason; readonly recorded: string | null }[]> {
    const installed = [...(await input.ports.installed())].filter((h) => HARNESS.test(h));
    const offer = await input.ports.read();
    const out: { harness: string; reason: RefreshReason; recorded: string | null }[] = [];
    for (const harness of installed) {
      const recorded = await input.ports.recordedVersion(harness);
      const entry = Object.hasOwn(offer, harness) ? offer[harness] : undefined;
      const explicit = asked.get(harness) ?? asked.get('*');
      if (entry === undefined) {
        out.push({ harness, reason: explicit ?? 'missing', recorded });
        continue;
      }
      const changed = recorded !== null && entry.version !== null && recorded !== entry.version && (!refreshedUnder.has(harness) || refreshedUnder.get(harness) !== recorded);
      if (changed) out.push({ harness, reason: 'version-changed', recorded });
      else if (asked.get(harness) === 'session-version') out.push({ harness, reason: 'session-version', recorded });
      else if (now() - entry.refreshedAtMs >= refreshMs) out.push({ harness, reason: 'stale', recorded });
    }
    return out;
  }

  async function run(): Promise<readonly RefreshOutcome[]> {
    const due = await dueHarnesses();
    asked.clear();
    const outcomes: RefreshOutcome[] = [];
    for (const { harness, reason, recorded } of due) {
      if (closed || input.allowed?.() === false) break;
      if (!input.isIdle()) {
        // Busy again: the rest wait for the next idle moment.
        asked.set(harness, reason);
        scheduleRetry();
        continue;
      }
      const started = now();
      current = new AbortController();
      const listing = await withTimeout(Promise.resolve().then(() => input.ports.list({ harness, timeoutMs: listingTimeoutMs, signal: (current as AbortController).signal })), listingTimeoutMs, current);
      current = undefined;
      // A listing that close() cut short says nothing about the harness: it is not recorded.
      if (closed) break;
      const clean: ModelListing = listing.ok ? listing : { ok: false, reasonCode: REASON.test(listing.reasonCode) ? listing.reasonCode : 'LISTING_FAILED' };
      try {
        await input.ports.record(harness, clean, now());
      } catch {
        // C's writer never throws; a failure here only loses this refresh.
      }
      refreshedUnder.set(harness, recorded);
      const outcome: RefreshOutcome = { harness, reason, models: clean.ok ? clean.models.length : 0, reasonCode: clean.ok ? null : clean.reasonCode, ms: Math.max(0, now() - started) };
      outcomes.push(outcome);
      input.trace?.(outcome);
    }
    return outcomes;
  }

  const refresher: ModelOfferRefresher = {
    request(reason, harness) {
      if (harness !== undefined && !HARNESS.test(harness)) return;
      asked.set(harness ?? '*', reason);
      void refresher.tick();
    },
    noteHarnessVersion(harness, version) {
      if (!HARNESS.test(harness) || version === null) return;
      void (async () => {
        try {
          const offer = await input.ports.read();
          const entry = Object.hasOwn(offer, harness) ? offer[harness] : undefined;
          if (entry === undefined || (entry.version !== null && entry.version !== version)) refresher.request('session-version', harness);
        } catch {
          // an unreadable offer is refreshed by the periodic check
        }
      })();
    },
    tick() {
      if (closed || input.allowed?.() === false) return Promise.resolve([]);
      if (inFlight !== undefined) return inFlight.then(() => []);
      if (!input.isIdle()) {
        scheduleRetry();
        return Promise.resolve([]);
      }
      inFlight = run()
        .catch(() => [] as readonly RefreshOutcome[])
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    running: () => inFlight !== undefined,
    async close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      current?.abort();
      if (inFlight !== undefined) await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 250))]);
    },
  };
  return refresher;
}

// ---------------------------------------------------------------- default ports

/** The listing the offer file keeps per harness: the newest attempt across its sign-in modes. */
export function offeredEntries(offer: { readonly listings: readonly { readonly harness: string; readonly attemptedAt: string; readonly harnessVersion: string | null }[] } | null): { readonly [harness: string]: OfferedEntry } {
  const out: Record<string, OfferedEntry> = {};
  for (const listing of offer?.listings ?? []) {
    if (!HARNESS.test(listing.harness)) continue;
    const at = Date.parse(listing.attemptedAt);
    if (!Number.isFinite(at)) continue;
    const seen = out[listing.harness];
    if (seen === undefined || at > seen.refreshedAtMs) out[listing.harness] = { version: listing.harnessVersion, refreshedAtMs: at };
  }
  return out;
}

/** A detected sign-in mode as the offer file keys it. */
export function offerAuthMode(detected: unknown): 'api-key' | 'subscription' | 'unknown' {
  return detected === 'api-key' || detected === 'subscription' ? detected : 'unknown';
}

/**
 * The product ports: F's installed listing harnesses and `listOfferedModels` (which checks
 * certification and refuses a real binary in a test run), the recorded harness version, and C's
 * offer file. With `routing.modelListing` off (D's setting) no harness is listed at all, so
 * nothing runs and nothing is recorded. Each module loads on first use; one that does not load
 * leaves the refresh with nothing installed, so it does nothing.
 */
export function defaultModelOfferPorts(home: string, env: NodeJS.ProcessEnv = process.env): ModelOfferPorts {
  let authOf: ((harness: string) => Promise<'api-key' | 'subscription' | 'unknown'>) | undefined;
  return {
    async installed() {
      try {
        const offer = await import('@jevris/cli/model-offer');
        if ((await offer.modelListingSetting(home, env)) === 'off') return [];
        return await offer.listingHarnesses(home);
      } catch {
        return [];
      }
    },
    async recordedVersion(harness) {
      try {
        const { harnessVersionOf } = await import('@jevris/orchestrator');
        return harnessVersionOf(home, harness as Parameters<typeof harnessVersionOf>[1]);
      } catch {
        return null;
      }
    },
    async list({ harness, timeoutMs, signal }) {
      const offer = await import('@jevris/cli/model-offer');
      authOf ??= async (h) => offerAuthMode(await offer.detectHarnessAuth(h as Parameters<typeof offer.detectHarnessAuth>[0], env));
      return offer.listOfferedModels({ home, harness, timeoutMs, signal, env });
    },
    async read() {
      try {
        const core = await import('@jevris/core');
        return offeredEntries(await core.readModelOffer(home));
      } catch {
        return {};
      }
    },
    async record(harness, listing, nowMs) {
      const core = await import('@jevris/core');
      const authMode = authOf === undefined ? 'unknown' : await authOf(harness).catch(() => 'unknown' as const);
      await core.recordModelListing(home, { harness, authMode, result: listing, nowMs });
    },
  };
}
