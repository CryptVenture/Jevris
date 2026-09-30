import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { fdLineWriter, type LineWriter } from './line-writer.js';
import { join } from 'node:path';
import type { SidecarTraceEvent } from '@jevris/contracts';
import { readSharedFileSync } from '@jevris/platform';

/**
 * Local observability for the sidecar (SSOT §17.5; OBS-01, OBS-02, OBS-03).
 *
 * - Traces: one JSON line per step, from a request's receipt to its outcome, in
 *   `<state>/traces/trace-<UTC date>.jsonl` (owner-only, 16 MiB a day, 7 days kept). A line holds
 *   only bounded codes: event and op names, the client kind, the request id, reason codes,
 *   Jevris decision ids, durations and counts. Workspace, task, session and delivery ids are
 *   keyed HMACs (a private per-home key), stable across restarts and meaningless elsewhere.
 *   Nothing else a caller passes is written: no source, no prompt, no path, no secret.
 * - Counters: requests per op with failures and a latency histogram, and reason codes, since
 *   the sidecar started. The decision counters come from the store (decisionCounters).
 * - Diagnostic mode: explicit and temporary (at most an hour). It adds sizes and deadlines to
 *   trace lines; it never adds content, so it still respects the secret policy.
 * - Status line: `<state>/statusline.json`, written from local state, read by
 *   `jevris sidecar statusline` without a sidecar round trip.
 */

export const TRACE_SCHEMA_VERSION = 1;
export const TRACE_DIR = 'traces';
export const TRACE_KEY_FILE = 'trace-key';
export const DIAGNOSTIC_FILE = 'diagnostic.json';
export const DIAGNOSTIC_SCHEMA = 'jevris-diagnostic-1';
export const STATUSLINE_FILE = 'statusline.json';
export const STATUSLINE_SCHEMA = 'jevris-statusline-1';
export const TRACE_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const TRACE_RETENTION_DAYS = 7;
export const DIAGNOSTIC_DEFAULT_MS = 15 * 60_000;
export const DIAGNOSTIC_MAX_MS = 60 * 60_000;
/** A status-line file older than this, from a sidecar that no longer runs, reads as not running. */
export const STATUSLINE_STALE_MS = 90_000;
/** Latency histogram upper bounds in milliseconds; the last bucket is everything slower. */
export const LATENCY_BUCKETS_MS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const TRACE_FILE = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const EVENT = /^[a-z][a-z0-9._:-]{0,63}$/;
const OP = /^[a-z][a-z0-9._-]{0,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SUBSCRIBER = /^[a-z@][a-z0-9@/._-]{0,63}$/;
const HOOK_EVENT = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;
const CLIENTS = new Set(['cli', 'hook', 'mcp']);
const REASON_KEYS_MAX = 128;
const OP_KEYS_MAX = 128;

export interface TraceInput extends SidecarTraceEvent {
  readonly ws?: string;
  readonly op?: string;
  readonly client?: string;
  readonly rid?: string;
  readonly ok?: boolean;
  readonly ms?: number;
  readonly budget?: string;
  readonly sessionId?: string;
  readonly deliveryKey?: string;
  readonly hookEvent?: string;
  readonly subscriber?: string;
  /** Diagnostic mode only. */
  readonly bytes?: number;
  readonly deadlineMs?: number;
}

export interface OpCounters {
  readonly count: number;
  readonly failures: number;
  /** Counts per LATENCY_BUCKETS_MS bucket, plus one for slower. */
  readonly latencyBuckets: readonly number[];
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface RequestCounters {
  readonly sinceMs: number;
  readonly requests: number;
  readonly failures: number;
  readonly byOp: { readonly [op: string]: OpCounters };
  readonly byBudget: { readonly hot: OpCounters; readonly background: OpCounters };
  readonly reasonCodes: { readonly [reasonCode: string]: number };
}

export interface DiagnosticState {
  readonly active: boolean;
  readonly untilMs: number | null;
}

export interface Telemetry {
  /** Writes one sanitized trace line. Never throws. */
  trace(input: TraceInput): void;
  /** Counts a finished request and traces its outcome. */
  requestDone(input: { readonly rid: string; readonly op: string; readonly client: string; readonly ok: boolean; readonly reasonCode: string | null; readonly ms: number; readonly budget: string; readonly ws?: string }): void;
  requestCounters(): RequestCounters;
  diagnostic(): DiagnosticState;
  /** Turns diagnostic mode on for `durationMs` (capped at DIAGNOSTIC_MAX_MS), or off with null. */
  setDiagnostic(durationMs: number | null): DiagnosticState;
  /** The keyed HMAC id a trace line uses for a workspace, task, session or delivery id. */
  opaqueId(kind: 'ws' | 'task' | 'session' | 'delivery', value: string): string;
  /** Lines not written because the day's file reached its cap or the disk refused. */
  dropped(): number;
  readonly traceDir: string;
  close(): void;
}

export interface TelemetryInput {
  readonly stateDir: string;
  readonly now?: () => number;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A private directory: created 0700, never a link. */
function privateDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The per-home trace key: 32 random bytes, created once, owner-only. */
function traceKey(stateDir: string): Uint8Array {
  const path = join(stateDir, TRACE_KEY_FILE);
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st !== undefined && st.isFile() && !st.isSymbolicLink() && st.size >= 32 && st.size <= 128) {
      const key = Buffer.from(readSharedFileSync(path, 'utf8').trim(), 'base64url');
      if (key.length === 32) return key;
    }
    if (st === undefined) {
      const key = randomBytes(32);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeSync(fd, `${key.toString('base64url')}\n`);
      } finally {
        closeSync(fd);
      }
      return key;
    }
  } catch {
    // fall through: a key for this process only (ids are stable until the next start)
  }
  return randomBytes(32);
}

function emptyCounters(): { count: number; failures: number; buckets: number[] } {
  return { count: 0, failures: 0, buckets: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0) };
}

function bucketOf(ms: number): number {
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
  return index === -1 ? LATENCY_BUCKETS_MS.length : index;
}

function percentile(buckets: readonly number[], q: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = Math.ceil(q * total);
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i] as number;
    // The bucket's upper bound; the open last bucket reports twice the last bound.
    if (seen >= rank) return LATENCY_BUCKETS_MS[i] ?? 2 * (LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1] as number);
  }
  return null;
}

function summary(c: { count: number; failures: number; buckets: number[] }): OpCounters {
  return { count: c.count, failures: c.failures, latencyBuckets: [...c.buckets], p50Ms: percentile(c.buckets, 0.5), p95Ms: percentile(c.buckets, 0.95) };
}

export function readDiagnostic(stateDir: string, nowMs: number): DiagnosticState {
  try {
    const path = join(stateDir, DIAGNOSTIC_FILE);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile() || st.isSymbolicLink() || st.size > 1024) return { active: false, untilMs: null };
    const parsed = JSON.parse(readSharedFileSync(path, 'utf8')) as Record<string, unknown>;
    const until = parsed['untilMs'];
    const setAt = parsed['setAtMs'];
    if (parsed['schemaVersion'] !== DIAGNOSTIC_SCHEMA || !isSafeCount(until) || !isSafeCount(setAt)) return { active: false, untilMs: null };
    // A file that claims more than the cap from when it was set is not honoured.
    if (until - setAt > DIAGNOSTIC_MAX_MS || until <= nowMs) return { active: false, untilMs: null };
    return { active: true, untilMs: until };
  } catch {
    return { active: false, untilMs: null };
  }
}

/** Writes a small private file atomically: exclusive temp, then rename over the target. */
export function writeSmallPrivateFile(path: string, text: string): boolean {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing !== undefined && existing.isSymbolicLink()) return false;
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // no temp left
    }
    return false;
  }
}

export function openTelemetry(input: TelemetryInput): Telemetry {
  const now = input.now ?? Date.now;
  const traceDir = join(input.stateDir, TRACE_DIR);
  const dirOk = privateDir(input.stateDir) && privateDir(traceDir);
  const key = traceKey(input.stateDir);
  const startedAtMs = now();
  const ops = new Map<string, { count: number; failures: number; buckets: number[] }>();
  const budgets = { hot: emptyCounters(), background: emptyCounters() };
  const reasons = new Map<string, number>();
  let requests = 0;
  let failures = 0;
  let droppedLines = 0;
  let seq = 0;
  let fd: number | undefined;
  let fdDate = '';
  let fdBytes = 0;
  /** P7: the open day's lines are queued and written asynchronously. */
  let writer: LineWriter | undefined;

  /** Closes the day's file once its queued lines are written (never under a pending write). */
  function closeDay(): void {
    const handle = fd;
    const closing = writer;
    fd = undefined;
    writer = undefined;
    if (handle === undefined) return;
    const shut = (): void => {
      try {
        closeSync(handle);
      } catch {
        // already closed
      }
    };
    if (closing === undefined) shut();
    else {
      droppedByClosed += closing.dropped();
      closing.drainThen(shut);
    }
  }
  let droppedByClosed = 0;
  let diagnosticCache: { state: DiagnosticState; readAtMs: number } | undefined;

  function opaqueId(kind: 'ws' | 'task' | 'session' | 'delivery', value: string): string {
    const prefix = kind === 'ws' ? 'w' : kind === 'task' ? 't' : kind === 'session' ? 's' : 'k';
    return `${prefix}_${createHmac('sha256', key).update(`${kind}\0${value}`, 'utf8').digest('base64url').slice(0, 16)}`;
  }

  function sweep(today: string): void {
    try {
      const cutoff = utcDate(Date.parse(`${today}T00:00:00Z`) - (TRACE_RETENTION_DAYS - 1) * 86_400_000);
      for (const name of readdirSync(traceDir)) {
        const match = TRACE_FILE.exec(name);
        if (match !== null && (match[1] as string) < cutoff) unlinkSync(join(traceDir, name));
      }
    } catch {
      // retention is retried at the next day change
    }
  }

  function fileFor(ms: number): number | undefined {
    const date = utcDate(ms);
    if (fd !== undefined && date === fdDate) return fd;
    if (fd !== undefined) closeDay();
    if (!dirOk) return undefined;
    const path = join(traceDir, `trace-${date}.jsonl`);
    try {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (st !== undefined && (st.isSymbolicLink() || !st.isFile())) return undefined;
      fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
      fdDate = date;
      fdBytes = st?.size ?? 0;
      writer = fdLineWriter(fd, fdBytes);
      sweep(date);
      return fd;
    } catch {
      return undefined;
    }
  }

  function diagnostic(): DiagnosticState {
    const at = now();
    if (diagnosticCache === undefined || at - diagnosticCache.readAtMs > 2000 || (diagnosticCache.state.untilMs !== null && diagnosticCache.state.untilMs <= at)) {
      diagnosticCache = { state: readDiagnostic(input.stateDir, at), readAtMs: at };
    }
    return diagnosticCache.state;
  }

  function sanitize(entry: TraceInput, diag: boolean): Record<string, string | number | boolean> | undefined {
    if (typeof entry.event !== 'string' || !EVENT.test(entry.event)) return undefined;
    const line: Record<string, string | number | boolean> = { event: entry.event };
    if (typeof entry.rid === 'string' && REQUEST_ID.test(entry.rid)) line['rid'] = entry.rid;
    if (typeof entry.op === 'string' && OP.test(entry.op)) line['op'] = entry.op;
    if (typeof entry.client === 'string' && CLIENTS.has(entry.client)) line['client'] = entry.client;
    if (typeof entry.ws === 'string' && entry.ws.length > 0) line['ws'] = entry.ws === 'global' ? 'global' : opaqueId('ws', entry.ws);
    if (typeof entry.taskId === 'string' && entry.taskId.length > 0) line['task'] = opaqueId('task', entry.taskId);
    if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) line['session'] = opaqueId('session', entry.sessionId);
    if (typeof entry.deliveryKey === 'string' && entry.deliveryKey.length > 0) line['delivery'] = opaqueId('delivery', entry.deliveryKey);
    if (typeof entry.decisionId === 'string' && DECISION_ID.test(entry.decisionId)) line['decisionId'] = entry.decisionId;
    if (typeof entry.reasonCode === 'string') line['reasonCode'] = REASON.test(entry.reasonCode) ? entry.reasonCode : 'OTHER';
    if (typeof entry.ok === 'boolean') line['ok'] = entry.ok;
    if (isSafeCount(entry.ms)) line['ms'] = Math.min(entry.ms, 86_400_000);
    if (entry.budget === 'hot' || entry.budget === 'background') line['budget'] = entry.budget;
    if (typeof entry.hookEvent === 'string' && HOOK_EVENT.test(entry.hookEvent)) line['hookEvent'] = entry.hookEvent;
    if (typeof entry.subscriber === 'string' && SUBSCRIBER.test(entry.subscriber)) line['subscriber'] = entry.subscriber;
    if (diag) {
      line['diag'] = true;
      if (isSafeCount(entry.bytes)) line['bytes'] = entry.bytes;
      if (isSafeCount(entry.deadlineMs)) line['deadlineMs'] = entry.deadlineMs;
    }
    return line;
  }

  function trace(entry: TraceInput): void {
    try {
      const at = now();
      const body = sanitize(entry, diagnostic().active);
      if (body === undefined) return;
      seq += 1;
      const text = `${JSON.stringify({ v: TRACE_SCHEMA_VERSION, ts: new Date(at).toISOString(), seq, ...body })}\n`;
      const handle = fileFor(at);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (handle === undefined || writer === undefined || fdBytes + bytes > TRACE_FILE_MAX_BYTES) {
        droppedLines += 1;
        return;
      }
      // The cap counts queued lines too, so the day's file never passes it.
      if (writer.write(text)) fdBytes += bytes;
    } catch {
      // A full disk must not take the sidecar down.
      droppedLines += 1;
    }
  }

  function count(target: { count: number; failures: number; buckets: number[] }, ok: boolean, ms: number): void {
    target.count += 1;
    if (!ok) target.failures += 1;
    target.buckets[bucketOf(ms)] = (target.buckets[bucketOf(ms)] ?? 0) + 1;
  }

  return {
    traceDir,
    trace,
    requestDone(done) {
      const ms = isSafeCount(done.ms) ? done.ms : 0;
      requests += 1;
      if (!done.ok) failures += 1;
      const opKey = OP.test(done.op) ? done.op : 'other';
      let opCounters = ops.get(opKey);
      if (opCounters === undefined && ops.size < OP_KEYS_MAX) {
        opCounters = emptyCounters();
        ops.set(opKey, opCounters);
      }
      if (opCounters !== undefined) count(opCounters, done.ok, ms);
      count(done.budget === 'background' ? budgets.background : budgets.hot, done.ok, ms);
      if (done.reasonCode !== null) {
        const code = REASON.test(done.reasonCode) ? done.reasonCode : 'OTHER';
        const keyed = reasons.has(code) || reasons.size < REASON_KEYS_MAX ? code : 'OTHER';
        reasons.set(keyed, (reasons.get(keyed) ?? 0) + 1);
      }
      trace({ event: 'request.outcome', rid: done.rid, op: done.op, client: done.client, ok: done.ok, ms, budget: done.budget, ...(done.reasonCode !== null ? { reasonCode: done.reasonCode } : {}), ...(done.ws !== undefined ? { ws: done.ws } : {}) });
    },
    requestCounters() {
      return {
        sinceMs: startedAtMs,
        requests,
        failures,
        byOp: Object.fromEntries([...ops.entries()].map(([op, c]) => [op, summary(c)])),
        byBudget: { hot: summary(budgets.hot), background: summary(budgets.background) },
        reasonCodes: Object.fromEntries(reasons),
      };
    },
    diagnostic,
    setDiagnostic(durationMs) {
      const at = now();
      const path = join(input.stateDir, DIAGNOSTIC_FILE);
      if (durationMs === null || durationMs <= 0) {
        try {
          unlinkSync(path);
        } catch {
          // already off
        }
        diagnosticCache = { state: { active: false, untilMs: null }, readAtMs: at };
        return diagnosticCache.state;
      }
      const until = at + Math.min(Math.floor(durationMs), DIAGNOSTIC_MAX_MS);
      const written = writeSmallPrivateFile(path, `${JSON.stringify({ schemaVersion: DIAGNOSTIC_SCHEMA, setAtMs: at, untilMs: until })}\n`);
      diagnosticCache = { state: written ? { active: true, untilMs: until } : { active: false, untilMs: null }, readAtMs: at };
      return diagnosticCache.state;
    },
    opaqueId,
    dropped: () => droppedLines + droppedByClosed + (writer?.dropped() ?? 0),
    close() {
      closeDay();
    },
  };
}

// ------------------------------------------------------------------ status line (OBS-03)

export interface StatusLineBody {
  readonly schemaVersion: typeof STATUSLINE_SCHEMA;
  readonly writtenAtMs: number;
  readonly pid: number;
  readonly sidecar: 'running' | 'stopped';
  readonly killSwitch: 'clear' | 'stopped';
  readonly decisions: 'jev' | 'rules-only' | 'degraded' | 'off';
  readonly store: 'ok' | 'absent' | 'unavailable';
  readonly diagnostic: boolean;
  /** Since local midnight on the sidecar's clock. */
  readonly today: { readonly decisions: number; readonly abstentions: number; readonly fallbacks: number; readonly costMicroUsd: number };
}

export function statusLineText(body: StatusLineBody | undefined, nowMs: number, alive: (pid: number) => boolean = pidAlive): string {
  if (body === undefined || body.sidecar === 'stopped' || (nowMs - body.writtenAtMs > STATUSLINE_STALE_MS && !alive(body.pid))) {
    return 'jevris: sidecar not running (rules-only)';
  }
  if (body.killSwitch === 'stopped') return 'jevris: stopped (kill switch)';
  const mode = body.decisions === 'jev' ? 'Jev' : body.decisions === 'rules-only' ? 'rules-only' : body.decisions === 'off' ? 'off' : 'degraded';
  const parts = [`jevris: ${mode}`, `${body.today.decisions} decisions today`];
  if (body.today.abstentions > 0) parts.push(`${body.today.abstentions} abstained`);
  if (body.today.fallbacks > 0) parts.push(`${body.today.fallbacks} fell back`);
  if (body.today.costMicroUsd > 0) parts.push(`$${(body.today.costMicroUsd / 1_000_000).toFixed(2)}`);
  if (body.store !== 'ok') parts.push('store unavailable');
  if (body.diagnostic) parts.push('diagnostic mode');
  return parts.join(' · ');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads the status-line cache. No sidecar round trip; undefined when absent or malformed. */
export function readStatusLine(stateDir: string): StatusLineBody | undefined {
  try {
    const path = join(stateDir, STATUSLINE_FILE);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile() || st.isSymbolicLink() || st.size > 4096) return undefined;
    const parsed = JSON.parse(readSharedFileSync(path, 'utf8')) as Record<string, unknown>;
    if (parsed['schemaVersion'] !== STATUSLINE_SCHEMA || !isSafeCount(parsed['writtenAtMs']) || !isSafeCount(parsed['pid'])) return undefined;
    const today = parsed['today'] as Record<string, unknown> | undefined;
    if (today === undefined || today === null || typeof today !== 'object') return undefined;
    for (const key of ['decisions', 'abstentions', 'fallbacks', 'costMicroUsd']) if (!isSafeCount(today[key])) return undefined;
    const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);
    const sidecar = pick(parsed['sidecar'], ['running', 'stopped'] as const);
    const killSwitch = pick(parsed['killSwitch'], ['clear', 'stopped'] as const);
    const decisions = pick(parsed['decisions'], ['jev', 'rules-only', 'degraded', 'off'] as const);
    const store = pick(parsed['store'], ['ok', 'absent', 'unavailable'] as const);
    if (sidecar === undefined || killSwitch === undefined || decisions === undefined || store === undefined) return undefined;
    return {
      schemaVersion: STATUSLINE_SCHEMA,
      writtenAtMs: parsed['writtenAtMs'] as number,
      pid: parsed['pid'] as number,
      sidecar,
      killSwitch,
      decisions,
      store,
      diagnostic: parsed['diagnostic'] === true,
      today: { decisions: today['decisions'] as number, abstentions: today['abstentions'] as number, fallbacks: today['fallbacks'] as number, costMicroUsd: today['costMicroUsd'] as number },
    };
  } catch {
    return undefined;
  }
}

export function writeStatusLine(stateDir: string, body: StatusLineBody): boolean {
  return writeSmallPrivateFile(join(stateDir, STATUSLINE_FILE), `${JSON.stringify(body)}\n`);
}
