/**
 * The answer replay (owner queue 9deb30c8, DOMAINS 78960940). A harness that retries a hook
 * inside the dedup window sends the same delivery key again. Before this, the retry got an empty
 * duplicate answer, so advice the first delivery produced (a Stop reminder, a restore) was lost
 * when the harness had not seen the first answer. Three rules:
 *
 * 1. The first answer was delivered in time (its request was not aborted): the retry gets that
 *    same answer, marked replayed. No subscriber runs again, so no effect is repeated.
 * 2. The first is still in flight: the retry waits for it, bounded by the retry's own deadline
 *    (never extending it), then applies rule 1 or 3.
 * 3. The first was aborted (DEADLINE or CANCELLED): the retry gets today's duplicate answer
 *    (observe). A subscriber commits a consuming effect only while its answer is wanted (US14), so
 *    nothing was spent and a later event carries it.
 *
 * The cache is per (workspace, delivery key), in memory only (it never outlives the sidecar),
 * capped in count and bytes, and each entry expires with the dedup window. It holds the rendered
 * answer as it was sent, as JSON text, and the event body's hash: a retry whose body differs
 * under the same key is not replayed.
 */

/** At most this many answers (in flight or settled) are kept; the oldest go first. */
export const EVENT_REPLAY_ENTRIES_MAX = 512;
/** At most this many bytes of settled answers are kept in all; the oldest go first. */
export const EVENT_REPLAY_BYTES_MAX = 4 * 1024 * 1024;
/** An answer larger than this is not kept: its retry gets the duplicate answer (rule 3). */
export const EVENT_REPLAY_ANSWER_MAX_BYTES = 256 * 1024;

/** What a retry finds. */
export type ReplayLookup =
  | { readonly state: 'none' }
  | { readonly state: 'body-mismatch' }
  | { readonly state: 'aborted' }
  | { readonly state: 'delivered'; readonly answer: Record<string, unknown> }
  | { readonly state: 'pending'; readonly settled: Promise<Record<string, unknown> | null> };

export interface EventReplay {
  /**
   * A recorded (first) delivery starts its entry. The returned function settles it once: the
   * answer that was delivered in time, or null when the request was aborted or failed.
   */
  begin(workspaceId: string, deliveryKey: string, bodyHash: string): (answer: Record<string, unknown> | null) => void;
  /** A duplicate delivery looks up the first one's answer. */
  lookup(workspaceId: string, deliveryKey: string, bodyHash: string): ReplayLookup;
  /** Entries and bytes held (status and tests). */
  size(): { readonly entries: number; readonly bytes: number };
}

interface Entry {
  readonly atMs: number;
  readonly bodyHash: string;
  /** undefined while in flight; null for aborted, failed or too large; else the answer's JSON. */
  text: string | null | undefined;
  bytes: number;
  readonly settled: Promise<string | null>;
  readonly resolve: (text: string | null) => void;
}

export function createEventReplay(options: {
  readonly windowMs: number;
  readonly clock: () => number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxAnswerBytes?: number;
}): EventReplay {
  const maxEntries = options.maxEntries ?? EVENT_REPLAY_ENTRIES_MAX;
  const maxBytes = options.maxBytes ?? EVENT_REPLAY_BYTES_MAX;
  const maxAnswerBytes = options.maxAnswerBytes ?? EVENT_REPLAY_ANSWER_MAX_BYTES;
  /** Insertion order is time order: a key begun again is deleted and set anew. */
  const entries = new Map<string, Entry>();
  let bytes = 0;

  const keyOf = (workspaceId: string, deliveryKey: string): string => `${workspaceId}\0${deliveryKey}`;
  const drop = (key: string, entry: Entry): void => {
    entries.delete(key);
    bytes -= entry.bytes;
    // A retry still waiting on a dropped entry gets the duplicate answer (rule 3).
    if (entry.text === undefined) entry.resolve(null);
  };
  const expire = (nowMs: number): void => {
    for (const [key, entry] of entries) {
      if (nowMs >= entry.atMs && nowMs - entry.atMs < options.windowMs) break;
      drop(key, entry);
    }
  };
  const trim = (): void => {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      drop(key, entry);
    }
  };
  const parsed = (text: string | null): Record<string, unknown> | null => {
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  return {
    begin(workspaceId, deliveryKey, bodyHash) {
      const nowMs = options.clock();
      expire(nowMs);
      const key = keyOf(workspaceId, deliveryKey);
      const prior = entries.get(key);
      if (prior !== undefined) drop(key, prior);
      let resolve: (text: string | null) => void = () => undefined;
      const settled = new Promise<string | null>((r) => {
        resolve = r;
      });
      const entry: Entry = { atMs: nowMs, bodyHash, text: undefined, bytes: 0, settled, resolve };
      entries.set(key, entry);
      trim();
      let done = false;
      return (answer) => {
        if (done) return;
        done = true;
        let text: string | null = null;
        if (answer !== null) {
          try {
            text = JSON.stringify(answer);
          } catch {
            text = null;
          }
        }
        if (text !== null && Buffer.byteLength(text, 'utf8') > maxAnswerBytes) text = null;
        entry.text = text;
        if (entries.get(key) === entry) {
          entry.bytes = text === null ? 0 : Buffer.byteLength(text, 'utf8');
          bytes += entry.bytes;
          trim();
        }
        entry.resolve(text);
      };
    },
    lookup(workspaceId, deliveryKey, bodyHash) {
      expire(options.clock());
      const entry = entries.get(keyOf(workspaceId, deliveryKey));
      if (entry === undefined) return { state: 'none' };
      if (entry.bodyHash !== bodyHash) return { state: 'body-mismatch' };
      if (entry.text === undefined) return { state: 'pending', settled: entry.settled.then(parsed) };
      const answer = parsed(entry.text);
      return answer === null ? { state: 'aborted' } : { state: 'delivered', answer };
    },
    size() {
      return { entries: entries.size, bytes };
    },
  };
}
