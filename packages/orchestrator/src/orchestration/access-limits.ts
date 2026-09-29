/**
 * Access limits on owned runs (R70; design `.planning/research/access-limits.md` sections 7.2 E9,
 * 7.3, 7.4 and 9.1; C2's core R60, 07683697).
 *
 * - Before a launch, the run's scope is checked against the machine record. A paused scope
 *   launches nothing, and the task blocks with core's fixed reason.
 * - After a run, the worker's access signal is classified again here, in the recording process,
 *   and recorded. The worker's own finding is kept as its claim only. The task blocks, whatever
 *   status the port reported.
 * - A run that completed clears its scope (an observed success).
 *
 * Every blocked task gets an `access-blocked` row, which the resume tick reads (R76). Nothing here
 * keeps text: only ids, classes and times.
 */
import {
  AccessSignalWireSchema,
  defineContract,
  HARNESS_IDS,
  servingHostOf,
  type AccessLimitClass,
  type AccessLimitFinding,
  type AccessSignalWire,
  type HarnessId,
  type ModelRegistry,
} from '@jevris/contracts';
import {
  ACCESS_TIMING,
  accessBlockedReason,
  accessPauseFor,
  accessScopeOf,
  accessScopeOnHost,
  classifyAccessSignal,
  clearAccessLimitsForCredential,
  credentialFingerprint,
  harnessModelId,
  loadLearningState,
  pausedModels,
  readAccessLimits,
  recordAccessLimit,
  recordAccessSuccess,
  registryModel,
  type AccessClassification,
  type AccessPause,
  type AccessQuery,
} from '@jevris/core';
import { isCertified } from '../hooks/certification.js';
import { PROVIDER_KEY_VARS, WORKER_PROVIDERS, type WorkerAuthMode, type WorkerHarness, type WorkerProvider } from './worker-auth.js';
import { HOST_KEY_VARS, HOST_ROUTE_UNKNOWN, hostRouteOfRun } from './worker-hosts.js';

/** The certify cases that make an access signal trusted (OP-4): an owned run's port, a session's hooks. */
export type AccessCertificationFeature = 'access.detect' | 'access.session';

/**
 * Whether the harness's signed certification record covers `featureId` at the running version, on
 * this OS and now (OP-4; F's K16-K20). The record is read through the same signed-record reader as
 * route.host (`isCertified`), never from a plugin's or port's claim. The version is the one the
 * session forwarded, else the installed version doctor or install recorded; none is not certified.
 * Never throws.
 */
export async function accessCertified(input: { readonly home: string; readonly harness: WorkerHarness | HarnessId; readonly featureId: AccessCertificationFeature; readonly nowMs: number; readonly harnessVersion?: string | null }): Promise<boolean> {
  const harness: string = input.harness === 'kilo' ? 'kilocode' : input.harness;
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) return false;
  try {
    const answer = await isCertified({
      home: input.home,
      harness: harness as HarnessId,
      featureId: input.featureId,
      nowMs: input.nowMs,
      ...(input.harnessVersion === undefined || input.harnessVersion === null ? {} : { harnessVersion: input.harnessVersion }),
    });
    return answer.certified;
  } catch {
    return false;
  }
}

/**
 * The workspace's learning setting `limitCooldownHours` (OP-11), the usage-window base an access
 * pause with no reported reset is timed from, clamped to core's `ACCESS_TIMING` base range (0.25-168 h). Undefined when the workspace
 * has no learning state (core's 5 h default then applies) or it cannot be read.
 */
export async function limitCooldownHoursOf(home: string, workspaceId: string | undefined): Promise<number | undefined> {
  if (workspaceId === undefined) return undefined;
  try {
    const hours = (await loadLearningState({ home, workspaceId }))?.settings.limitCooldownHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours)) return undefined;
    return Math.min(ACCESS_TIMING.maxBaseHours, Math.max(ACCESS_TIMING.minBaseHours, hours));
  } catch {
    return undefined;
  }
}

/** The collection of blocked tasks the resume tick reads (design 7.3, 9.3). */
export const ACCESS_BLOCKED_COLLECTION = 'access-blocked';

/** Overloaded runs are retried by the resume tick after 30 s x 2^n, n = 0, 1, 2 (design 7.4). */
export const OVERLOAD_RETRY_BASE_MS = 30_000;
export const OVERLOAD_RETRIES_MAX = 3;

/**
 * A task an access limit or an overload blocked (design 7.3): the resume tick (R76) moves it back
 * to ready once, when the pause has ended or cleared and the task is still approved.
 */
export interface AccessBlockedRow {
  readonly workspaceId: string;
  readonly taskId: string;
  /** The machine record's entry key, when one was written. */
  readonly scopeKey: string | null;
  readonly class: AccessLimitClass;
  /** When the pause or the overload wait ends (null: no expiry, or no retry left). */
  readonly untilMs: number | null;
  readonly blockedAtMs: number;
  /** Set once the resume tick has moved the task back to ready. */
  readonly resumed: boolean;
  /** False when this is a repeat after an automatic resume: it waits for a person (OP-5). */
  readonly autoResume: boolean;
  /** Overloaded only: which retry this wait is for (0-based). */
  readonly attempt?: number;
  /** What the task ran on, so the resume tick checks that no other pause covers it (R76). */
  readonly harness?: WorkerHarness;
  readonly model?: string;
  readonly authMode?: WorkerAuthMode | 'unknown';
  /** The pinned host the task ran through; absent for a direct run. */
  readonly servingHost?: string;
  /** When the resume tick moved the task back to ready. */
  readonly resumedAtMs?: number;
}

const WireContract = defineContract<AccessSignalWire>({
  name: 'AccessSignalWire',
  description: 'An access signal as a worker outcome carries it (ids, codes and times only).',
  schema: AccessSignalWireSchema,
});

/** The signal an outcome carries, when it is a valid wire signal; anything else is ignored. */
export function wireSignalOf(value: unknown): AccessSignalWire | null {
  if (value === null || value === undefined) return null;
  const checked = WireContract.validate(value);
  return checked.ok ? checked.value : null;
}

/** C's harness id for a worker harness (Kilo is `kilocode`). */
export function accessHarnessOf(harness: WorkerHarness): HarnessId {
  const id = harness === 'kilo' ? 'kilocode' : harness;
  return (HARNESS_IDS as readonly string[]).includes(id) ? (id as HarnessId) : 'claude';
}

/**
 * The scope a run on `harness` in `authMode` has (design 4.1): the spelling the harness reported,
 * else the one the port spells the requested model with, else the registry id. Null when Jevris
 * cannot name the party that served it.
 */
export function runAccessScope(registry: ModelRegistry, harness: WorkerHarness, model: string, authMode: string, reported: string | null = null, servingHost?: string): AccessQuery | null {
  const h = accessHarnessOf(harness);
  // C's LOW B: a run through a pinned host is paused, and records, on the host's scope, as a session
  // through it does; a host Jevris cannot name records nothing (OP-12).
  if (servingHost !== undefined) {
    const route = hostRouteOfRun(registry, model, servingHost);
    return route === null || route === HOST_ROUTE_UNKNOWN ? null : accessScopeOnHost(registry, h, route.provider, route.modelId, route.servingHost, authMode);
  }
  if (reported !== null) {
    const scope = accessScopeOf(registry, h, reported, authMode);
    if (scope !== null) return scope;
  }
  const entry = registryModel(registry, model);
  const spelled = entry === null ? null : harnessModelId(registry, h, entry.modelId, entry.provider);
  return (spelled === null ? null : accessScopeOf(registry, h, spelled, authMode)) ?? accessScopeOf(registry, h, model, authMode);
}

/**
 * The fingerprint of the key an API-key launch will use, where Jevris holds it (design 4.4): the
 * variable the worker port checks. Null for a subscription or unknown sign-in, and for Antigravity,
 * whose key Jevris does not pass. Computed in memory; the key never leaves this function.
 *
 * `servingHost` is the launch scope's serving host:
 * - a pinned host (the coordinator's 1.2 decision after C's LOW B): the host's own key, from the
 *   same `HOST_KEY_VARS` that `hostEnv` keeps for the child (OPENROUTER_API_KEY), never the
 *   maker's; a host with no key variable (the Kilo Gateway is a login) gives null;
 * - a maker on OpenCode or Kilo (G-9, D's trace 3): the maker's key from `PROVIDER_KEY_VARS`, which
 *   `providerEnv` passes and the only credential the child has (`<PREFIX>_AUTH_CONTENT` is empty);
 * - Claude and Codex: their own variables, as before.
 * Where several variables name a key (OPENAI_API_KEY and CODEX_API_KEY, GEMINI_API_KEY and
 * GOOGLE_API_KEY), a multi-provider harness gets a fingerprint only when every set one holds the
 * same key; otherwise which one the harness reads is not known, and a new key clears nothing.
 */
export function launchFingerprint(harness: WorkerHarness, authMode: WorkerAuthMode | 'unknown', env: { readonly [key: string]: string | undefined }, servingHost?: string): string | null {
  if (authMode !== 'api-key') return null;
  let key: string | null | undefined;
  if (servingHost !== undefined && servingHostOf(servingHost) !== undefined) key = soleKey(HOST_KEY_VARS[servingHost] ?? [], env);
  else if (harness === 'claude') key = env['ANTHROPIC_API_KEY'];
  else if (harness === 'codex') key = env['CODEX_API_KEY'] || env['OPENAI_API_KEY'];
  else if ((harness === 'opencode' || harness === 'kilo') && isWorkerProvider(servingHost)) key = soleKey(PROVIDER_KEY_VARS[servingHost], env);
  return typeof key === 'string' && key.length > 0 ? credentialFingerprint(key) : null;
}

function isWorkerProvider(id: string | undefined): id is WorkerProvider {
  return id !== undefined && (WORKER_PROVIDERS as readonly string[]).includes(id);
}

/** The one key the set variables among `names` hold; null when none is set or two differ. */
function soleKey(names: readonly string[], env: { readonly [key: string]: string | undefined }): string | null {
  const values = new Set(names.map((name) => env[name]).filter((value): value is string => typeof value === 'string' && value.length > 0));
  return values.size === 1 ? ([...values][0] ?? null) : null;
}

export interface LaunchAccessCheck {
  readonly pause: AccessPause | null;
  readonly scope: AccessQuery | null;
  readonly fingerprint: string | null;
}

/**
 * The pause in force for a launch (E9), after clearing any untimed entry of the scope that was
 * recorded with another key (design 9.1, FINGERPRINT). A record that cannot be read never blocks
 * a launch (design 4.3: fail open).
 */
export async function launchAccessCheck(input: {
  readonly home: string;
  readonly registry: ModelRegistry;
  readonly harness: WorkerHarness;
  readonly model: string;
  readonly authMode: WorkerAuthMode | 'unknown';
  readonly env: { readonly [key: string]: string | undefined };
  readonly nowMs: number;
  /** The pinned host the run goes to; absent for a direct run. */
  readonly servingHost?: string;
}): Promise<LaunchAccessCheck> {
  const scope = runAccessScope(input.registry, input.harness, input.model, input.authMode, null, input.servingHost);
  const fingerprint = launchFingerprint(input.harness, input.authMode, input.env, scope?.servingHost);
  if (scope === null) return { pause: null, scope, fingerprint };
  try {
    if (fingerprint !== null) await clearAccessLimitsForCredential(input.home, scope, fingerprint, input.nowMs);
    const read = await readAccessLimits(input.home);
    return { pause: accessPauseFor(read.entries, scope, input.nowMs, { fingerprint }), scope, fingerprint };
  } catch {
    return { pause: null, scope, fingerprint };
  }
}

/**
 * R74 (design E7, E10): the models among `models` that the machine record pauses now, each on the
 * harness and sign-in the worker port would run it on (the launch check's scope, E9). Read only: a
 * new key clears an untimed pause only at launch. Empty when the port cannot say which harness runs
 * a model or the record cannot be read; the launch check still stops a paused run.
 */
export async function accessPausedModels(input: {
  readonly home: string;
  readonly registry: ModelRegistry;
  readonly port: { harnessFor?(model: string): WorkerHarness | null; authFor?(model: string): Promise<{ readonly mode: WorkerAuthMode } | null> };
  readonly models: readonly string[];
  readonly nowMs: number;
}): Promise<ReadonlySet<string>> {
  const { port } = input;
  if (port.harnessFor === undefined || input.models.length === 0) return new Set();
  let entries: Awaited<ReturnType<typeof readAccessLimits>>['entries'];
  try {
    entries = (await readAccessLimits(input.home)).entries;
  } catch {
    return new Set();
  }
  if (entries.length === 0) return new Set();
  const scopes = new Map<string, AccessQuery | null>();
  for (const model of new Set(input.models)) {
    // B's LOW 38: a port that throws for a model gives it no scope here (not paused); E9 still checks it.
    try {
      const harness = port.harnessFor(model);
      const auth = harness === null || port.authFor === undefined ? null : await port.authFor(model);
      scopes.set(model, harness === null ? null : runAccessScope(input.registry, harness, model, auth?.mode ?? 'unknown'));
    } catch {
      scopes.set(model, null);
    }
  }
  return new Set(Object.keys(pausedModels(entries, [...scopes.keys()], (model) => scopes.get(model) ?? null, input.nowMs)));
}

/** What an ended run's access signal came to: D's own classification and what the record did with it. */
export interface RunAccessResult {
  readonly classification: AccessClassification;
  /** The finding kept on the run record (D's classification, never the worker's claim). */
  readonly finding: AccessLimitFinding;
  /** RECORDED, NOT_A_PAUSE (overloaded), or the record's refusal code. */
  readonly recorded: string;
  /** The pause the record now holds for the scope, when one was written. */
  readonly pause: AccessPause | null;
}

/**
 * Classifies an ended run's signal in this process (B's LOW 24) and records a pausing class on the
 * machine record (design E9). `certified` comes from this process's own lookup of the harness's
 * signed `access.detect` record (`accessCertified`); uncertified, a text-only credit or blocked
 * signal is held as a timed pause (OP-4). `baseHours` is the workspace's `limitCooldownHours` (OP-11).
 */
export async function recordRunAccess(input: {
  readonly home: string;
  readonly registry: ModelRegistry;
  readonly signal: AccessSignalWire;
  readonly certified: boolean;
  readonly harness: WorkerHarness;
  readonly model: string;
  readonly reportedModel: string | null;
  readonly authMode: WorkerAuthMode | 'unknown';
  readonly fingerprint: string | null;
  readonly nowMs: number;
  readonly baseHours?: number;
  /** The pinned host the run went to; absent for a direct run. */
  readonly servingHost?: string;
}): Promise<RunAccessResult | null> {
  const classification = classifyAccessSignal({ ...input.signal, certified: input.certified }, input.authMode, input.nowMs, input.baseHours === undefined ? {} : { baseHours: input.baseHours });
  if (classification === null) return null;
  const scope = runAccessScope(input.registry, input.harness, input.model, input.authMode, input.reportedModel, input.servingHost);
  const finding: AccessLimitFinding = {
    class: classification.class,
    signal: classification.signal,
    weekly: classification.weekly,
    resetBasis: classification.resetBasis,
    ...(classification.untilMs === null ? {} : { resetAtMs: classification.untilMs }),
    ...(classification.modelScoped && scope?.modelId !== null && scope?.modelId !== undefined ? { modelId: scope.modelId } : {}),
    ...(classification.family === null ? {} : { family: classification.family }),
  };
  if (classification.class === 'overloaded') return { classification, finding, recorded: 'NOT_A_PAUSE', pause: null };
  if (scope === null) return { classification, finding, recorded: 'ACCESS_SCOPE_UNKNOWN', pause: null };
  try {
    const result = await recordAccessLimit({ home: input.home, scope, classification, source: 'owned-run', nowMs: input.nowMs, fingerprint: input.fingerprint, ...(input.baseHours === undefined ? {} : { baseHours: input.baseHours }) });
    if (!result.ok) return { classification, finding, recorded: result.reasonCode, pause: null };
    const entry = result.entry;
    return { classification, finding: { ...finding, ...(entry.untilMs === null ? {} : { resetAtMs: entry.untilMs }) }, recorded: 'RECORDED', pause: { class: entry.class, untilMs: entry.untilMs, entry } };
  } catch {
    return { classification, finding, recorded: 'WRITE_FAILED', pause: null };
  }
}

/** A run that completed is an observed success on its scope (design 9.1): its pauses clear. */
export async function clearRunAccess(input: { readonly home: string; readonly registry: ModelRegistry; readonly harness: WorkerHarness; readonly model: string; readonly reportedModel: string | null; readonly authMode: WorkerAuthMode | 'unknown'; readonly nowMs: number; readonly servingHost?: string }): Promise<number> {
  const scope = runAccessScope(input.registry, input.harness, input.model, input.authMode, input.reportedModel, input.servingHost);
  if (scope === null) return 0;
  try {
    return (await recordAccessSuccess(input.home, scope, input.nowMs)).cleared.length;
  } catch {
    return 0;
  }
}

const minuteIso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

/** A blocked task's reason for a limit that was classified but not recorded (fixed text). */
export function unrecordedAccessReason(finding: AccessLimitFinding, recorded: string): string {
  return `ACCESS_LIMITED: ${finding.class}${finding.weekly ? ' (weekly)' : ''} (${finding.signal}); not on the machine record (${recorded}); waits for a person`;
}

/**
 * The blocked reason for an access limit: core's text when the record holds the pause (a timed
 * pause names its reset; an untimed one only the ways it can clear for its scope, core's
 * `untimedClearText`, moved there from here in C2's d0ff6bf0).
 */
export function accessReason(result: RunAccessResult | { readonly pause: AccessPause }, options: { readonly autoResume?: boolean } = {}): string {
  if (result.pause !== null) return accessBlockedReason(result.pause, options);
  const r = result as RunAccessResult;
  return unrecordedAccessReason(r.finding, r.recorded);
}

/** The retry wait for the n-th overload of a task (design 7.4), with up to 10% jitter; null when none is left. */
export function overloadRetryAt(attempt: number, nowMs: number, jitter: number = Math.random()): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= OVERLOAD_RETRIES_MAX) return null;
  const wait = OVERLOAD_RETRY_BASE_MS * 2 ** attempt;
  return nowMs + wait + Math.floor(wait * 0.1 * Math.min(1, Math.max(0, jitter)));
}

/** The blocked reason for an overloaded provider (design 7.4; fixed text). */
export function overloadedReason(signal: string, retryAtMs: number | null): string {
  return retryAtMs === null
    ? `PROVIDER_OVERLOADED: the provider was overloaded (${signal}); the automatic retries are used up, so it waits for a person`
    : `PROVIDER_OVERLOADED: the provider was overloaded (${signal}); retried automatically after ${minuteIso(retryAtMs)} if owned workers run automatically and its checks are still approved, else start it again then`;
}

/**
 * The row for a task an access limit blocks. A repeat after an automatic resume (the previous
 * row was resumed) waits for a person (OP-5); an overload counts its retries.
 */
export function accessBlockedRow(input: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly previous: AccessBlockedRow | undefined;
  readonly class: AccessLimitClass;
  readonly scopeKey: string | null;
  readonly untilMs: number | null;
  readonly nowMs: number;
  readonly attempt?: number;
  /** The harness, model and sign-in the task ran on (null: the port could not say). */
  readonly run?: { readonly harness: WorkerHarness; readonly model: string; readonly authMode: WorkerAuthMode | 'unknown'; readonly servingHost?: string | undefined } | null;
}): AccessBlockedRow {
  const repeat = accessRepeat(input.previous, input.class);
  return {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    scopeKey: input.scopeKey,
    class: input.class,
    untilMs: input.untilMs,
    blockedAtMs: input.nowMs,
    resumed: false,
    autoResume: !repeat && (input.class !== 'overloaded' || input.untilMs !== null),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.run === undefined || input.run === null ? {} : { harness: input.run.harness, model: input.run.model, authMode: input.run.authMode, ...(input.run.servingHost === undefined ? {} : { servingHost: input.run.servingHost }) }),
  };
}

/**
 * A limit again after an automatic resume (OP-5): the row it replaces was resumed, and neither is
 * an overload (an overload counts its own attempts). Such a block waits for a person.
 */
export function accessRepeat(previous: AccessBlockedRow | undefined, cls: AccessLimitClass): boolean {
  return previous?.resumed === true && previous.class !== 'overloaded' && cls !== 'overloaded';
}

/** The next overload attempt for a task: one more than a previous overload row's, else 0. */
export function nextOverloadAttempt(previous: AccessBlockedRow | undefined): number {
  return previous?.class === 'overloaded' && typeof previous.attempt === 'number' ? previous.attempt + 1 : 0;
}
