/**
 * Persisted latency and deadline counters (learning-coverage audit P8). The sidecar counts in
 * memory and folds the counts into the store's daily `latency_counter` rows every minute, at a
 * `latency.counters` read and at stop; the counts survive a restart, unlike the telemetry
 * counters. It also ingests the hook launcher's pending file (hook-latency.ts).
 *
 * Counted: every sidecar op's answer (`answered`) or refusal reason, an answer sent after the
 * client's own deadline (`LATE_ANSWER`), queued and slow subscribers, and breaker opens; hook
 * misses per harness and reason from the launcher. Codes, names, counts and milliseconds only.
 * Deadlines are user settings and never self-tune from these counts.
 */
import { lstatSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LatencyCount, LatencyScope, OpenedStore } from '@jevris/store';
import { HOOK_LATENCY_FILE, HOOK_LATENCY_FILE_MAX_BYTES, parseHookLatencyLine } from './hook-latency.js';

type StoreModule = typeof import('@jevris/store');

/** The most distinct counters held in memory between flushes. */
export const LATENCY_KEYS_MAX = 2_000;
export const LATENCY_FLUSH_MS = 60_000;
const DAY_MS = 86_400_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const METRIC = /^(?:answered|[A-Z][A-Z0-9_]{0,63})$/;

export interface LatencyCounters {
  count(scope: LatencyScope, name: string, metric: string, ms: number, atMs?: number): void;
  /** Ingests the hook file and writes the held counts; they are kept when the store refuses. */
  flush(): { readonly written: number; readonly hookLines: number };
  /** Counts held in memory, not yet written (for tests). */
  pending(): number;
}

interface Held {
  readonly day: number;
  readonly scope: LatencyScope;
  readonly name: string;
  readonly metric: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

export function createLatencyCounters(input: {
  readonly stateDir: string;
  readonly store: () => { readonly store: OpenedStore; readonly api: StoreModule } | undefined;
  readonly now?: () => number;
}): LatencyCounters {
  const now = input.now ?? Date.now;
  const held = new Map<string, Held>();
  let overflow = 0;

  function add(scope: LatencyScope, name: string, metric: string, ms: number, atMs: number, n = 1): void {
    const safeName = NAME.test(name) ? name : 'other';
    const safeMetric = METRIC.test(metric) ? metric : 'OTHER';
    const safeMs = Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), 3_600_000) : 0;
    const day = Math.floor(atMs / DAY_MS) * DAY_MS;
    const key = `${String(day)}\0${scope}\0${safeName}\0${safeMetric}`;
    let entry = held.get(key);
    if (entry === undefined) {
      if (held.size >= LATENCY_KEYS_MAX) {
        overflow += n;
        return;
      }
      entry = { day, scope, name: safeName, metric: safeMetric, count: 0, totalMs: 0, maxMs: 0 };
      held.set(key, entry);
    }
    entry.count += n;
    entry.totalMs += safeMs * n;
    entry.maxMs = Math.max(entry.maxMs, safeMs);
  }

  function ingestHookFile(): number {
    const file = join(input.stateDir, HOOK_LATENCY_FILE);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined) return 0;
    if (!st.isFile()) return 0;
    const taken = `${file}.ingesting-${String(process.pid)}`;
    try {
      renameSync(file, taken);
    } catch {
      return 0;
    }
    let lines = 0;
    try {
      const text = readFileSync(taken, 'utf8').slice(0, HOOK_LATENCY_FILE_MAX_BYTES + 4096);
      for (const line of text.split('\n')) {
        const entry = parseHookLatencyLine(line.trim());
        if (entry === undefined) continue;
        add('hook', entry.harness, entry.reasonCode, entry.elapsedMs, entry.atMs);
        lines += 1;
      }
    } catch {
      // an unreadable file is dropped
    }
    try {
      unlinkSync(taken);
    } catch {
      // removed meanwhile
    }
    return lines;
  }

  return {
    count(scope, name, metric, ms, atMs) {
      add(scope, name, metric, ms, atMs ?? now());
    },
    flush() {
      const held_ = input.store();
      if (held_ === undefined) return { written: 0, hookLines: 0 };
      let hookLines = 0;
      try {
        hookLines = ingestHookFile();
      } catch {
        hookLines = 0;
      }
      if (overflow > 0) {
        // Counts dropped at the memory cap are kept as one overflow counter.
        const day = Math.floor(now() / DAY_MS) * DAY_MS;
        held.set(`${String(day)}\0overflow`, { day, scope: 'sidecar-op', name: 'latency-counters', metric: 'COUNTER_OVERFLOW', count: overflow, totalMs: 0, maxMs: 0 });
        overflow = 0;
      }
      if (held.size === 0) return { written: 0, hookLines };
      const counts: LatencyCount[] = [...held.values()]
        .filter((h) => h.count > 0)
        .map((h) => ({ atMs: h.day, scope: h.scope, name: h.name, metric: h.metric, count: h.count, totalMs: h.totalMs, maxMs: h.maxMs }));
      const result = held_.api.addLatencyCounts(held_.store, counts);
      if (!result.ok) return { written: 0, hookLines };
      held.clear();
      return { written: result.added, hookLines };
    },
    pending() {
      return held.size;
    },
  };
}
