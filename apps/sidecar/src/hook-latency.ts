/**
 * Hook deadline misses the sidecar cannot see (learning-coverage audit P8; E's launcher calls
 * this). When a hook answers without the sidecar (a deadline, a timeout, the sidecar unreachable),
 * the launcher appends one line to `<state>/hook-latency.pending.jsonl` after its answer is
 * written. The sidecar folds the file into the store's daily latency counters at start and on
 * each flush, then removes it.
 *
 * A line holds a harness id, a reason code, the elapsed milliseconds and a time; nothing else.
 * Writing is synchronous and tiny: append-only at mode 0600, no symlink followed, skipped once
 * the file passes 64 KiB, and it never throws, so it can never delay or break a hook.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';

export const HOOK_LATENCY_FILE = 'hook-latency.pending.jsonl';
export const HOOK_LATENCY_FILE_MAX_BYTES = 65_536;
export const HOOK_LATENCY_VERSION = 1;

const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface HookLatencyEntry {
  readonly harness: string;
  readonly reasonCode: string;
  readonly elapsedMs: number;
  readonly atMs: number;
}

function validEntry(entry: HookLatencyEntry): boolean {
  return (
    HARNESS.test(entry.harness) &&
    REASON.test(entry.reasonCode) &&
    Number.isSafeInteger(entry.elapsedMs) &&
    entry.elapsedMs >= 0 &&
    entry.elapsedMs <= 3_600_000 &&
    Number.isSafeInteger(entry.atMs) &&
    entry.atMs >= 0
  );
}

/** The pending file for a home (JEVRIS_HOME from `env`, else the OS home). */
export function hookLatencyFile(input: { readonly env?: { readonly [key: string]: string | undefined }; readonly home?: string; readonly platform?: string } = {}): string {
  const paths = jevrisPaths({
    ...(input.home !== undefined ? { home: input.home } : {}),
    ...(input.env !== undefined ? { env: input.env as NodeJS.ProcessEnv } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
  });
  return join(paths.state, HOOK_LATENCY_FILE);
}

/** One line of the pending file. */
export function hookLatencyLine(entry: HookLatencyEntry): string {
  return `${JSON.stringify({ v: HOOK_LATENCY_VERSION, harness: entry.harness, reasonCode: entry.reasonCode, elapsedMs: entry.elapsedMs, atMs: entry.atMs })}\n`;
}

/** Parses one line, or undefined when it is not a valid entry. */
export function parseHookLatencyLine(line: string): HookLatencyEntry | undefined {
  if (line.length === 0 || line.length > 512) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const get = (key: string): unknown => (Object.hasOwn(value as object, key) ? (value as Record<string, unknown>)[key] : undefined);
  if (get('v') !== HOOK_LATENCY_VERSION) return undefined;
  const entry = { harness: get('harness'), reasonCode: get('reasonCode'), elapsedMs: get('elapsedMs'), atMs: get('atMs') };
  if (typeof entry.harness !== 'string' || typeof entry.reasonCode !== 'string' || typeof entry.elapsedMs !== 'number' || typeof entry.atMs !== 'number') return undefined;
  const parsed: HookLatencyEntry = { harness: entry.harness, reasonCode: entry.reasonCode, elapsedMs: entry.elapsedMs, atMs: entry.atMs };
  return validEntry(parsed) ? parsed : undefined;
}

/**
 * Appends one hook latency line. Synchronous, never throws, and writes nothing when the entry is
 * not valid, the file is over 64 KiB, or the path is not a plain file.
 */
export function appendHookLatency(input: HookLatencyEntry & { readonly env?: { readonly [key: string]: string | undefined }; readonly home?: string }): void {
  try {
    const entry: HookLatencyEntry = { harness: input.harness, reasonCode: input.reasonCode, elapsedMs: Math.max(0, Math.round(input.elapsedMs)), atMs: Math.round(input.atMs) };
    if (!validEntry(entry)) return;
    const file = hookLatencyFile({ ...(input.env !== undefined ? { env: input.env } : {}), ...(input.home !== undefined ? { home: input.home } : {}) });
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing !== undefined && (!existing.isFile() || existing.size > HOOK_LATENCY_FILE_MAX_BYTES)) return;
    if (existing === undefined) mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeSync(fd, hookLatencyLine(entry));
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort: a hook never fails because a counter could not be written.
  }
}
