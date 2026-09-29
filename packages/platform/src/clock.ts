/**
 * One clock utility for in-process deadlines and budgets (BLD-05, SSOT §17.2).
 *
 * In-process elapsed time is monotonic (performance.now). Durable records and display
 * keep wall-clock timestamps; `anchoredClock` gives epoch milliseconds that advance only
 * with the monotonic clock, so a wall-clock jump after the anchor does not move a
 * deadline. A start time from another process is translated once, conservatively.
 */

export interface Clock {
  now(): number;
}

export const monotonicClock: Clock = {
  now: () => performance.now(),
};

export function monotonicNow(): number {
  return performance.now();
}

/** Epoch milliseconds anchored at `anchorWallMs`, advanced by `mono`. */
export function anchoredClock(anchorWallMs: number = Date.now(), mono: Clock = monotonicClock): Clock {
  const start = mono.now();
  return {
    now: () => anchorWallMs + (mono.now() - start),
  };
}

/**
 * Elapsed milliseconds since a start time recorded by another process, read once at
 * `nowWallMs`. A start in the future (the other clock is ahead, or ours jumped back)
 * counts as zero elapsed; a non-finite start counts as the whole budget spent.
 */
export function elapsedSinceForeignStart(startedAtWallMs: number, nowWallMs: number, budgetMs: number): number {
  if (!Number.isFinite(startedAtWallMs) || !Number.isFinite(nowWallMs)) return budgetMs;
  return Math.max(0, nowWallMs - startedAtWallMs);
}

export interface Deadline {
  readonly budgetMs: number;
  elapsedMs(): number;
  remainingMs(): number;
  expired(): boolean;
}

export function createDeadline(budgetMs: number, clock: Clock = monotonicClock, alreadyElapsedMs = 0): Deadline {
  const start = clock.now();
  const spent = Number.isFinite(alreadyElapsedMs) && alreadyElapsedMs > 0 ? alreadyElapsedMs : 0;
  const elapsedMs = (): number => spent + Math.max(0, clock.now() - start);
  return {
    budgetMs,
    elapsedMs,
    remainingMs: () => Math.max(0, budgetMs - elapsedMs()),
    expired: () => elapsedMs() >= budgetMs,
  };
}
