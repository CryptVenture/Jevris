/**
 * Detached advice waiting for the next event of its session.
 *
 * A hook never waits on Jev. When a live adviser (repeated failure, new task) has to ask, it answers
 * the hook at once with nothing, runs the question after the hook has gone, and puts the finished
 * advice here. The decision subscriber hands it to the harness at the session's next event that can
 * show it, and only then marks it delivered (the commit of its proposal), so an event that cannot
 * show it, or whose answer is no longer wanted, leaves it for the next one.
 *
 * In memory only. A sidecar restart drops pending advice, which is acceptable: it is advice, the
 * decision it came from is already recorded, and nothing depends on it being shown.
 *
 * A session with no usable id (`UNKNOWN_SESSION_ID`, the placeholder the envelope carries when the
 * harness gave none) has no queue: every such event of a workspace shares the placeholder, so
 * advice for one conversation would show in another. Nothing is queued for it and it is given none.
 */
import { UNKNOWN_SESSION_ID } from '@jevris/core';

export type PendingKind = 'repeated-failure' | 'new-task';

export interface PendingAdvice {
  readonly kind: PendingKind;
  /** The one short plain-text line to show. Fixed templates only: no user text, no path, no output. */
  readonly text: string;
  /** The advisory decision this advice was recorded under, when one was recorded. */
  readonly decisionId: string | null;
  /** The reason code of the source (`REPEATED_FAILURE_*` or `NEW_TASK_*`). */
  readonly reasonCode: string;
  readonly atMs: number;
}

export interface PendingAdviceOptions {
  readonly now?: () => number;
  /** How long advice stays worth showing, in ms (default 10 minutes). */
  readonly ttlMs?: number;
  /** The most sessions held at once (default 256); the oldest goes first. */
  readonly maxSessions?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SESSIONS = 256;
const MAX_TEXT_CHARS = 500;

/** At most one pending advice per kind per session: a newer one replaces an older one. */
export class PendingAdviceStore {
  readonly #sessions = new Map<string, PendingAdvice[]>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxSessions: number;

  constructor(options: PendingAdviceOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  }

  static key(workspaceId: string, sessionId: string): string {
    return `${workspaceId}\u0000${sessionId}`;
  }

  #live(key: string): PendingAdvice[] {
    const now = this.#now();
    const list = (this.#sessions.get(key) ?? []).filter((advice) => now - advice.atMs <= this.#ttlMs);
    if (list.length === 0) this.#sessions.delete(key);
    else this.#sessions.set(key, list);
    return list;
  }

  /** Adds advice for a session, replacing any pending advice of the same kind. Empty text, and a session with no usable id, are ignored. */
  put(workspaceId: string, sessionId: string, advice: Omit<PendingAdvice, 'atMs'> & { readonly atMs?: number }): boolean {
    if (sessionId === UNKNOWN_SESSION_ID) return false;
    const text = advice.text.trim().slice(0, MAX_TEXT_CHARS);
    if (text.length === 0) return false;
    const key = PendingAdviceStore.key(workspaceId, sessionId);
    const kept = this.#live(key).filter((existing) => existing.kind !== advice.kind);
    kept.push({ kind: advice.kind, text, decisionId: advice.decisionId, reasonCode: advice.reasonCode, atMs: advice.atMs ?? this.#now() });
    this.#sessions.delete(key);
    this.#sessions.set(key, kept);
    while (this.#sessions.size > this.#maxSessions) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true) break;
      this.#sessions.delete(oldest.value);
    }
    return true;
  }

  /** The oldest unexpired advice of the session, without taking it. */
  peek(workspaceId: string, sessionId: string): PendingAdvice | null {
    if (sessionId === UNKNOWN_SESSION_ID) return null;
    const list = this.#live(PendingAdviceStore.key(workspaceId, sessionId));
    return list[0] ?? null;
  }

  /** The unexpired advice of one kind in the session, without taking it. */
  find(workspaceId: string, sessionId: string, kind: PendingKind): PendingAdvice | null {
    if (sessionId === UNKNOWN_SESSION_ID) return null;
    return this.#live(PendingAdviceStore.key(workspaceId, sessionId)).find((advice) => advice.kind === kind) ?? null;
  }

  /** Takes the advice off the queue. False when it was already taken or replaced. */
  consume(workspaceId: string, sessionId: string, advice: PendingAdvice): boolean {
    if (sessionId === UNKNOWN_SESSION_ID) return false;
    const key = PendingAdviceStore.key(workspaceId, sessionId);
    const list = this.#live(key);
    const at = list.findIndex((existing) => existing === advice);
    if (at < 0) return false;
    list.splice(at, 1);
    if (list.length === 0) this.#sessions.delete(key);
    return true;
  }

  /** Pending advice in the session (tests and status). */
  count(workspaceId: string, sessionId: string): number {
    if (sessionId === UNKNOWN_SESSION_ID) return 0;
    return this.#live(PendingAdviceStore.key(workspaceId, sessionId)).length;
  }
}

/** The store the default handlers and the default decision subscriber share. */
export const PENDING_ADVICE = new PendingAdviceStore();
