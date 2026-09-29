/**
 * Models found gone on this machine (owner decision 2026-09-27, DOMAINS 3ff4c0f and 9d1e7eb): a
 * model stays recommended until it is actually retired, by the vendor's firm date or when a
 * launch or provider call finds it gone, whichever is first.
 *
 * - Signals. `MODEL_UNAVAILABLE_SIGNALS` is the one table of error classes per port. A port (D's
 *   worker ports and SDK worker, F's harness ports) detects the class in memory and passes only
 *   the class id; `classifyModelUnavailable` maps it to a reason. A structured signal (a Claude
 *   API 404 `not_found_error`, OpenCode's and Kilo's `ProviderModelNotFoundError`) is enough on
 *   its own. A text-matched signal counts only from a harness binary certified for it. A signal
 *   no row names is an ordinary task failure and is never recorded.
 * - Only the vendor's own API can say a model is gone everywhere (harness parity audit, a38e889).
 *   A harness's "not found" can come from its local provider configuration, a gateway or a plan
 *   (OpenCode and Kilo `ProviderModelNotFoundError`; Antigravity's per-plan model list), so it is
 *   `MODEL_NOT_ACCESSIBLE`: it narrows that harness and sign-in, never Claude Code or another harness.
 * - Reasons. `MODEL_GONE` applies on every harness. `MODEL_NOT_ACCESSIBLE` ("does not exist or
 *   you do not have access") applies only to its own harness and auth mode, and never affects
 *   routing, exploration or learning outside that scope.
 * - Record. `<data>/route-learning/model-availability.json`, one per machine (retention class
 *   `route-learning`), written atomically under an exclusive lock so every sidecar on the machine
 *   can write it. An entry holds the model id, the reason, the harness and auth mode, the source,
 *   first and last seen times, a count and the registry snapshot in force: never an error body,
 *   message, workspace, path or account.
 * - Clearing. An entry counts only while the registry snapshot it was recorded under is in force:
 *   the next registry refresh clears it. `clearModelAvailability` clears one model or all.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_IDS, MODEL_ID_PATTERN, type ModelRegistry } from '@jevris/contracts';
import { durableWrite, jevrisPaths } from '@jevris/platform';
import { withFileLock } from './route-file-lock.js';

export const MODEL_AVAILABILITY_SCHEMA = 'jevris-model-availability-1' as const;
export const MODEL_UNAVAILABLE_REASONS = ['MODEL_GONE', 'MODEL_NOT_ACCESSIBLE'] as const;
export type ModelUnavailableReason = (typeof MODEL_UNAVAILABLE_REASONS)[number];

/** Where a model-unavailable signal can come from: a harness, the Claude API directly (D's Agent SDK worker), or Jev. */
export const MODEL_SIGNAL_PORTS = [...HARNESS_IDS, 'claude-api', 'typesafe'] as const;
export type ModelSignalPort = (typeof MODEL_SIGNAL_PORTS)[number];

export interface ModelUnavailableSignal {
  readonly port: ModelSignalPort;
  /** The class id the port reports: never the error text. */
  readonly signal: string;
  /** What the signal means, or null when it is not reliable enough to record. */
  readonly reasonCode: ModelUnavailableReason | null;
  /** True for a structured field (a status and error type, an error name); false for matched text. */
  readonly structured: boolean;
  /** Text-matched signals count only from a harness binary certified for it (F's certify capture). */
  readonly needsCertifiedBinary: boolean;
  /** What the port matches, for D and F. */
  readonly detects: string;
}

/**
 * The error classes per port (the coordinator's DRY table for D and F). Evidence: the Claude API
 * errors and deprecation pages (fetched 2026-09-27: "Requests to retired models will fail", 404
 * `not_found_error`); Jev's live probe (fixtures/evidence/live-errors.json: an invalid model is a
 * generic 400 BadRequestError); the worker ports' stubbed streams. Rows marked unreliable wait
 * for a certified capture.
 */
export const MODEL_UNAVAILABLE_SIGNALS: readonly ModelUnavailableSignal[] = Object.freeze([
  { port: 'claude-api', signal: 'http-404-not-found-error', reasonCode: 'MODEL_GONE', structured: true, needsCertifiedBinary: false, detects: 'HTTP 404 with error.type "not_found_error" on POST /v1/messages for the requested model' },
  { port: 'opencode', signal: 'provider-model-not-found', reasonCode: 'MODEL_NOT_ACCESSIBLE', structured: true, needsCertifiedBinary: false, detects: 'an error event whose name is "ProviderModelNotFoundError"' },
  { port: 'kilocode', signal: 'provider-model-not-found', reasonCode: 'MODEL_NOT_ACCESSIBLE', structured: true, needsCertifiedBinary: false, detects: 'an error event whose name is "ProviderModelNotFoundError"' },
  { port: 'claude', signal: 'selected-model-issue', reasonCode: 'MODEL_NOT_ACCESSIBLE', structured: false, needsCertifiedBinary: true, detects: 'a result with is_error whose text is Claude Code\'s "issue with the selected model" message (it may not exist or you may not have access)' },
  { port: 'codex', signal: 'model-not-found', reasonCode: 'MODEL_NOT_ACCESSIBLE', structured: false, needsCertifiedBinary: true, detects: 'an error or turn.failed event (Codex emits the same message on both) whose message is OpenAI\'s model_not_found ("does not exist or you do not have access")' },
  { port: 'codex', signal: 'model-not-supported-for-account', reasonCode: 'MODEL_NOT_ACCESSIBLE', structured: false, needsCertifiedBinary: true, detects: 'an error or turn.failed event saying the model is not supported with this sign-in (a ChatGPT account)' },
  { port: 'antigravity', signal: 'unknown-model', reasonCode: 'MODEL_NOT_ACCESSIBLE', structured: false, needsCertifiedBinary: true, detects: 'an ERROR result naming an unknown model (counts only from a binary whose capture saw it)' },
  { port: 'typesafe', signal: 'http-400-bad-request', reasonCode: null, structured: false, needsCertifiedBinary: false, detects: 'a generic 400 BadRequestError: not specific to the model, never recorded' },
] satisfies readonly ModelUnavailableSignal[]);

/** What a port's signal means: a reason, or null when it is unknown, unreliable, or needs a certified binary it lacks. */
export function classifyModelUnavailable(input: { readonly port: string; readonly signal: string; readonly certified?: boolean }): ModelUnavailableReason | null {
  const row = MODEL_UNAVAILABLE_SIGNALS.find((r) => r.port === input.port && r.signal === input.signal);
  if (row === undefined || row.reasonCode === null) return null;
  if (row.needsCertifiedBinary && input.certified !== true) return null;
  return row.reasonCode;
}

export type AvailabilityAuthMode = 'api-key' | 'subscription' | 'unknown';

export interface ModelAvailabilityEntry {
  readonly modelId: string;
  readonly reasonCode: ModelUnavailableReason;
  /** The port that saw it (a harness id, `claude-api` or `typesafe`). */
  readonly port: ModelSignalPort;
  readonly authMode: AvailabilityAuthMode;
  readonly source: 'launch' | 'provider-call';
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly count: number;
  /** The registry snapshot in force when it was seen; the entry counts only while it still is. */
  readonly registrySnapshotId: string;
}

const MAX_ENTRIES = 64;
const MAX_BYTES = 65_536;
const MODEL_ID = new RegExp(MODEL_ID_PATTERN);
const SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const AUTH: readonly string[] = ['api-key', 'subscription', 'unknown'];

/** `<data>/route-learning/model-availability.json`. */
export function modelAvailabilityFile(home: string): string {
  return join(jevrisPaths({ home }).data, 'route-learning', 'model-availability.json');
}

function validEntry(v: unknown): ModelAvailabilityEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  const ok =
    typeof e['modelId'] === 'string' && MODEL_ID.test(e['modelId']) &&
    typeof e['reasonCode'] === 'string' && (MODEL_UNAVAILABLE_REASONS as readonly string[]).includes(e['reasonCode']) &&
    typeof e['port'] === 'string' && (MODEL_SIGNAL_PORTS as readonly string[]).includes(e['port']) &&
    typeof e['authMode'] === 'string' && AUTH.includes(e['authMode']) &&
    (e['source'] === 'launch' || e['source'] === 'provider-call') &&
    typeof e['firstSeenAt'] === 'string' && ISO.test(e['firstSeenAt']) &&
    typeof e['lastSeenAt'] === 'string' && ISO.test(e['lastSeenAt']) &&
    typeof e['count'] === 'number' && Number.isSafeInteger(e['count']) && e['count'] >= 1 &&
    typeof e['registrySnapshotId'] === 'string' && SNAPSHOT.test(e['registrySnapshotId']);
  if (!ok) return null;
  return {
    modelId: e['modelId'] as string,
    reasonCode: e['reasonCode'] as ModelUnavailableReason,
    port: e['port'] as ModelSignalPort,
    authMode: e['authMode'] as AvailabilityAuthMode,
    source: e['source'] as 'launch' | 'provider-call',
    firstSeenAt: e['firstSeenAt'] as string,
    lastSeenAt: e['lastSeenAt'] as string,
    count: e['count'] as number,
    registrySnapshotId: e['registrySnapshotId'] as string,
  };
}

/** Every valid entry on disk, for any snapshot. A missing, oversized or malformed file is empty. */
async function readAll(home: string): Promise<ModelAvailabilityEntry[]> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(modelAvailabilityFile(home));
  } catch {
    return [];
  }
  if (bytes.byteLength > MAX_BYTES) return [];
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { schemaVersion?: unknown; entries?: unknown };
    if (value.schemaVersion !== MODEL_AVAILABILITY_SCHEMA || !Array.isArray(value.entries)) return [];
    return value.entries.slice(0, MAX_ENTRIES).map(validEntry).filter((e): e is ModelAvailabilityEntry => e !== null);
  } catch {
    return [];
  }
}

async function write(home: string, entries: readonly ModelAvailabilityEntry[]): Promise<boolean> {
  const file = modelAvailabilityFile(home);
  await mkdir(join(jevrisPaths({ home }).data, 'route-learning'), { recursive: true, mode: 0o700 });
  const result = await durableWrite(file, `${JSON.stringify({ schemaVersion: MODEL_AVAILABILITY_SCHEMA, entries })}\n`, { mode: 0o600 });
  return result.ok;
}

/** Runs `fn` holding the file's exclusive lock (a directory beside it); a lock older than 10 s is taken over. */
async function locked<T>(home: string, fn: () => Promise<T>): Promise<T | null> {
  return withFileLock(modelAvailabilityFile(home), fn);
}

export interface RecordModelUnavailableInput {
  readonly home: string;
  readonly modelId: string;
  readonly reasonCode: ModelUnavailableReason;
  readonly port: ModelSignalPort;
  readonly authMode: AvailabilityAuthMode;
  readonly source: 'launch' | 'provider-call';
  readonly nowMs: number;
  /** The registry in force (its snapshot id is recorded). */
  readonly registry: Pick<ModelRegistry, 'snapshotId'>;
}

/**
 * Records a model found gone (or not accessible from one harness and auth mode) on this machine.
 * Entries from an older registry snapshot are pruned as it writes. Refuses invalid input.
 */
export async function recordModelUnavailable(input: RecordModelUnavailableInput): Promise<{ readonly ok: true; readonly entry: ModelAvailabilityEntry } | { readonly ok: false; readonly reasonCode: 'INVALID_INPUT' | 'LOCK_BUSY' | 'WRITE_FAILED' }> {
  if (!Number.isFinite(input.nowMs) || Math.abs(input.nowMs) > 8.64e15) return { ok: false, reasonCode: 'INVALID_INPUT' };
  const at = new Date(input.nowMs).toISOString();
  const candidate = validEntry({ modelId: input.modelId, reasonCode: input.reasonCode, port: input.port, authMode: input.authMode, source: input.source, firstSeenAt: at, lastSeenAt: at, count: 1, registrySnapshotId: input.registry.snapshotId });
  if (candidate === null) return { ok: false, reasonCode: 'INVALID_INPUT' };
  const outcome = await locked(input.home, async () => {
    const current = (await readAll(input.home)).filter((e) => e.registrySnapshotId === candidate.registrySnapshotId);
    const same = (e: ModelAvailabilityEntry): boolean => e.modelId === candidate.modelId && e.reasonCode === candidate.reasonCode && e.port === candidate.port && e.authMode === candidate.authMode;
    const prior = current.find(same);
    const entry: ModelAvailabilityEntry = prior === undefined ? candidate : { ...prior, source: candidate.source, lastSeenAt: at, count: Math.min(prior.count + 1, 1_000_000) };
    const next = [...current.filter((e) => !same(e)), entry].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1)).slice(0, MAX_ENTRIES);
    return (await write(input.home, next)) ? entry : false;
  });
  if (outcome === null) return { ok: false, reasonCode: 'LOCK_BUSY' };
  if (outcome === false) return { ok: false, reasonCode: 'WRITE_FAILED' };
  return { ok: true, entry: outcome };
}

/** The entries in force under `registry`'s snapshot: a refreshed registry leaves older ones out. */
export async function loadModelAvailability(home: string, registry: Pick<ModelRegistry, 'snapshotId'>): Promise<readonly ModelAvailabilityEntry[]> {
  return (await readAll(home)).filter((e) => e.registrySnapshotId === registry.snapshotId);
}

/** Clears one model's entries, or all (`jevris route learning gone clear`). */
export async function clearModelAvailability(home: string, modelId: string | 'all'): Promise<{ readonly ok: boolean; readonly removed: number }> {
  const outcome = await locked(home, async () => {
    const current = await readAll(home);
    const next = modelId === 'all' ? [] : current.filter((e) => e.modelId !== modelId);
    const removed = current.length - next.length;
    if (removed === 0) return 0;
    return (await write(home, next)) ? removed : null;
  });
  return outcome === null ? { ok: false, removed: 0 } : { ok: true, removed: outcome };
}

/**
 * Deletes the file itself, under its lock (`jevris route learning reset --machine`): every entry
 * goes, and nothing of it stays on disk. A missing file is already removed.
 */
export async function removeModelAvailability(home: string): Promise<{ readonly ok: boolean; readonly removed: number }> {
  const outcome = await locked(home, async () => {
    const count = (await readAll(home)).length;
    try {
      await rm(modelAvailabilityFile(home));
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'ENOENT') return null;
    }
    return count;
  });
  return outcome === null ? { ok: false, removed: 0 } : { ok: true, removed: outcome };
}

/**
 * The models the router must not recommend for a route on `harness` with `authMode`: every
 * MODEL_GONE, and a MODEL_NOT_ACCESSIBLE only on its own harness and auth mode. A route that
 * does not know its harness or auth mode is never narrowed by MODEL_NOT_ACCESSIBLE.
 */
export function unavailableModels(entries: readonly ModelAvailabilityEntry[], scope: { readonly harness?: string | null; readonly authMode?: string | null } = {}): Readonly<Record<string, ModelUnavailableReason>> {
  const out: Record<string, ModelUnavailableReason> = {};
  for (const e of entries) {
    if (e.reasonCode === 'MODEL_GONE') out[e.modelId] = 'MODEL_GONE';
    else if (out[e.modelId] === undefined && scope.harness !== undefined && scope.harness !== null && scope.authMode !== undefined && scope.authMode !== null && e.port === scope.harness && e.authMode === scope.authMode) out[e.modelId] = 'MODEL_NOT_ACCESSIBLE';
  }
  return out;
}

/** Plain-text lines for explain, status and doctor: one per entry in force. */
export function modelAvailabilityLines(entries: readonly ModelAvailabilityEntry[]): string[] {
  return entries.map((e) =>
    e.reasonCode === 'MODEL_GONE'
      ? `${e.modelId} is not recommended: found gone on this machine (MODEL_GONE, a ${e.port} ${e.source} on ${e.lastSeenAt.slice(0, 10)}). The next registry refresh or jevris route learning gone clear restores it.`
      : `${e.modelId} is not recommended on ${e.port} with ${e.authMode} sign-in: not accessible there (MODEL_NOT_ACCESSIBLE, ${e.lastSeenAt.slice(0, 10)}). Other harnesses are unaffected. The next registry refresh or jevris route learning gone clear restores it.`,
  );
}
