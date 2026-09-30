/**
 * P8 (B a51d524): the status view of the sidecar's persisted latency and deadline counters.
 * `latency.counters` answers daily rows; status shows their totals against the semantic target.
 * Only counts, milliseconds and names travel; never event content.
 */
import type { StatusLatency } from '@jevris/contracts';

/** The days of counters status reads. */
export const STATUS_LATENCY_DAYS = 7;

/**
 * A hook that gave up waiting: its own deadline passed, or the client-side wait for the sidecar's
 * connection, handshake or answer ran out (TIMEOUT, HANDSHAKE_TIMEOUT, CONNECT_TIMEOUT; owner
 * decision ededdba records them). Without the last three status showed 0 deadline misses beside a
 * hook that had waited its whole 1500 ms.
 */
const HOOK_DEADLINE_CODES: ReadonlySet<string> = new Set(['DEADLINE', 'HOOK_DEADLINE', 'HOOK_WATCHDOG', 'TIMEOUT', 'HANDSHAKE_TIMEOUT', 'CONNECT_TIMEOUT']);
/** The hook reason for a start on demand: no sidecar was running, so this hook ran rules-only and started one. */
const SIDECAR_STARTING = 'SIDECAR_STARTING';
const SUBSCRIBER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_ROWS = 5000;
const MAX_SLOW = 8;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function add(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

/**
 * A hook reason that counts as "the sidecar could not answer" (autostart turned off is a choice,
 * not a miss). Besides SIDECAR_*, the client-side connection failures the hook records (BUSY,
 * ECONNREFUSED, CLOSED, CONNECT_*) are this kind of miss; the timeouts are deadline misses.
 */
function sidecarMiss(metric: string): boolean {
  if (metric === 'SIDECAR_AUTOSTART_OFF') return false;
  return metric.startsWith('SIDECAR_') || metric === 'BUSY' || metric === 'ECONNREFUSED' || metric === 'CLOSED' || metric.startsWith('CONNECT_');
}

/** B's `latency.counters` answer summarised for status, or null when it is not that shape. */
export function latencySummary(answer: unknown): StatusLatency | null {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return null;
  const a = answer as { readonly days?: unknown; readonly targetMs?: unknown; readonly counters?: unknown };
  const days = count(a.days);
  const targetMs = count(a.targetMs);
  if (days === null || days < 1 || days > 90 || targetMs === null || !Array.isArray(a.counters)) return null;
  let hookDeadlineMisses = 0;
  let hookSidecarMisses = 0;
  let hookSidecarStarting = 0;
  let lateSidecarAnswers = 0;
  let breakerOpens = 0;
  const subscribers = new Map<string, { count: number; maxMs: number }>();
  for (const row of a.counters.slice(0, MAX_ROWS) as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { readonly scope?: unknown; readonly name?: unknown; readonly metric?: unknown; readonly count?: unknown; readonly maxMs?: unknown };
    const n = count(r.count);
    if (n === null || typeof r.metric !== 'string' || typeof r.name !== 'string') continue;
    if (r.scope === 'hook') {
      if (HOOK_DEADLINE_CODES.has(r.metric)) hookDeadlineMisses = add(hookDeadlineMisses, n);
      else if (sidecarMiss(r.metric)) {
        hookSidecarMisses = add(hookSidecarMisses, n);
        if (r.metric === SIDECAR_STARTING) hookSidecarStarting = add(hookSidecarStarting, n);
      }
    } else if (r.scope === 'sidecar-op' && r.metric === 'LATE_ANSWER') {
      lateSidecarAnswers = add(lateSidecarAnswers, n);
    } else if (r.scope === 'subscriber' && SUBSCRIBER_NAME.test(r.name)) {
      const held = subscribers.get(r.name) ?? { count: 0, maxMs: 0 };
      subscribers.set(r.name, { count: add(held.count, n), maxMs: Math.max(held.maxMs, count(r.maxMs) ?? 0) });
    } else if (r.scope === 'breaker') {
      breakerOpens = add(breakerOpens, n);
    }
  }
  const slowSubscribers = [...subscribers.entries()]
    .filter(([, held]) => held.count > 0)
    .sort(([an, a1], [bn, b1]) => b1.count - a1.count || (an < bn ? -1 : an > bn ? 1 : 0))
    .slice(0, MAX_SLOW)
    .map(([name, held]) => ({ name, count: held.count, maxMs: held.maxMs }));
  return { days, targetMs, hookDeadlineMisses, hookSidecarMisses, hookSidecarStarting, lateSidecarAnswers, slowSubscribers, breakerOpens };
}

function times(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Says which of the sidecar misses were expected. A hook that finds no sidecar starts one and runs
 * rules-only, which happens after an idle exit or after a reinstall retires the old build; that is
 * by design and reads differently from a sidecar that was running and did not answer.
 */
function startingNote(latency: StatusLatency): string {
  const starting = latency.hookSidecarStarting;
  if (starting === 0 || latency.hookSidecarMisses === 0) return '';
  const expected = 'while it was starting, which is expected after an idle exit or a reinstall';
  if (starting >= latency.hookSidecarMisses) return ` (all ${expected})`;
  return ` (${starting} ${expected}; ${latency.hookSidecarMisses - starting} for other reasons)`;
}

/** The status lines for the counters; none when status has no counters. */
export function latencyLines(latency: StatusLatency | null | undefined): string[] {
  if (latency === null || latency === undefined) return [];
  const head = `latency (last ${times(latency.days, 'day', 'days')}, target ${latency.targetMs} ms)`;
  const misses = latency.hookDeadlineMisses + latency.hookSidecarMisses + latency.lateSidecarAnswers + latency.breakerOpens;
  if (misses === 0 && latency.slowSubscribers.length === 0) return [`${head}: no deadline misses`];
  const lines = [
    `${head}: ${times(latency.hookDeadlineMisses, 'hook deadline miss', 'hook deadline misses')}, ${times(latency.hookSidecarMisses, 'hook the sidecar did not answer', 'hooks the sidecar did not answer')}${startingNote(latency)}, ${times(latency.lateSidecarAnswers, 'late sidecar answer', 'late sidecar answers')}`,
  ];
  if (latency.slowSubscribers.length > 0) {
    lines.push(`slow subscribers: ${latency.slowSubscribers.map((s) => `${s.name} ${times(s.count, 'miss', 'misses')} (max ${s.maxMs} ms)`).join(', ')}`);
  }
  if (latency.breakerOpens > 0) lines.push(`circuit breaker opened: ${times(latency.breakerOpens, 'time', 'times')}`);
  return lines;
}
