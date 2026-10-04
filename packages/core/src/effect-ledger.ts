/**
 * The effect classes a session has requested since its last diff boundary (C06 scope-change detection).
 *
 * The permission triage classifies each proposed tool call into the fixed effect classes
 * (`effectClasses`, C49). The scope-change decision wants the classes a session asked for since its
 * last boundary, so it can judge them against the task's approved scope. This holds only those
 * class codes, in memory, per workspace and session: no command, path, host or text, and nothing is
 * written to disk. A sidecar restart drops it, which is fine: it is advice, never evidence.
 */
import { EFFECT_CLASS_TEXT } from './intent-fixed.js';

const TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 512;

interface Entry {
  readonly classes: Set<string>;
  atMs: number;
}

export class EffectLedger {
  readonly #sessions = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  static key(workspaceId: string, sessionId: string): string {
    return `${workspaceId}\u0000${sessionId}`;
  }

  /** Remembers the classes of one proposed call. A code outside the scope vocabulary is ignored. */
  note(workspaceId: string, sessionId: string, classes: readonly string[]): void {
    const known = classes.filter((code) => Object.hasOwn(EFFECT_CLASS_TEXT, code));
    if (known.length === 0) return;
    const key = EffectLedger.key(workspaceId, sessionId);
    const now = this.#now();
    const found = this.#sessions.get(key);
    const entry: Entry = found !== undefined && now - found.atMs <= TTL_MS ? found : { classes: new Set(), atMs: now };
    for (const code of known) entry.classes.add(code);
    entry.atMs = now;
    this.#sessions.delete(key);
    this.#sessions.set(key, entry);
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true) break;
      this.#sessions.delete(oldest.value);
    }
  }

  /** The classes requested since the last take, sorted, and forgets them. */
  take(workspaceId: string, sessionId: string): string[] {
    const key = EffectLedger.key(workspaceId, sessionId);
    const found = this.#sessions.get(key);
    this.#sessions.delete(key);
    if (found === undefined || this.#now() - found.atMs > TTL_MS) return [];
    return [...found.classes].sort();
  }
}

/** The ledger the permission triage writes and the scope-change handler reads, in one sidecar process. */
export const EFFECT_LEDGER = new EffectLedger();
