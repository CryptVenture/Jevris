import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLICIT_BASE_URL, ACCESS_USAGE_STATUS_HARNESSES, ACCESS_USAGE_STATUS_MAX_READINGS, ACCESS_USAGE_STATUS_MAX_WINDOWS, HARNESS_IDS, ID_PATTERN, MAIN_SESSION_MODES, MODEL_ID_PATTERN, containsSecret, servingHostOf, sidecarBudgetsMs, SIDECAR_CLIENT_SCOPES, testScaledMs, TURN_HARNESSES, surfacePayloadContract, modeAllows, type JevrisConfig, type Mode } from '@jevris/contracts';
import type { OpenedStore } from '@jevris/store';
import type {
  SidecarAdviceAdherence,
  SidecarEventSubscriber,
  SidecarOpContext,
  SidecarOpDefinition,
  SidecarTraceEvent,
  SidecarWorkspace,
} from '@jevris/contracts';
import { createDeadline, isAbsoluteOnAnyPlatform, monotonicClock, type JevrisPaths } from '@jevris/platform';
import { ACCESS_BLOCKED_COLLECTION, FAIL_CLOSED_MODE, backgroundAtStopOf, firstTryOf, firstTryStatusView, firstTryWorkspaceOf, jevAssistOf, machineJevBudget, workspaceJevBudget, modeMigrationNotice, activeVerificationRuns, layerIssues, type EffectiveConfig, approvedScopeFor, openLedger, resumeAccessBlocked, type AccessBlockedRow, getTask, harnessVersionOf, listTasks, mainSessionView, openWorkspace, ownedWorktreeWorkspaces, hostRouteCertified, readEffectiveConfig, reminderSummary, rootIdentityId, statusStopReport, turnRouteCertified } from '@jevris/orchestrator';
import { BUILTIN_OP_NAMES, bodyRecord, ok, refuse, type LoadedOps } from './ops.js';
import { ANSWER_EVENT_KINDS, PROTOCOL, jevrisPackage, loadedRuntimeBuild } from './protocol.js';
import { renderedSubscribers } from './outcome-rank.js';
import { resolveRetention } from './retention-policy.js';
import { sweepFileRetention } from './file-retention.js';
import { adminOps } from './admin-ops.js';
import { providerConsentOps, providerConsentReader } from './provider-consent.js';
import { accessLimitsOps } from './access-limits-ops.js';
import { jevReenableOps } from './jev-reenable-ops.js';
import { UNKNOWN_BUDGET_STATUS, budgetStatusView, type BudgetStatusView, CIRCUIT_REENABLE_COMMAND, accessNewKeyClears, circuitDisabledText, loadModelRegistry, readAccessLimits, readAccessUsageReadings, servingTariffKnown, sessionHost, type CircuitSnapshot } from '@jevris/core';
import { sessionLinkOps } from './session-link.js';
import { createEventReplay } from './event-replay.js';
import { sweepInWorker, sweepInline, type RunningSweep, type SweepOutcome } from './maintenance.js';
import { detectLocality, type ExecutionLocality } from './locality.js';
import { guardEgressFetch, resolveSourceEgress } from './egress-guard.js';
import { hostScopeForStore, storeBelongsHere } from './host-scope.js';
import { sidecarManagedOptions } from './managed-exec.js';
import { modelRegistryStatusReader } from './model-registry-status.js';

/** P9: the status line's day tally is re-read from the store at most this often (reconciled costs). */
const TALLY_RESEED_MS = 5 * 60_000;

/** The store's per-machine, per-user, per-home scope (DATA-10); see host-scope.ts. */
export { hostScopeId } from './host-scope.js';
import { liveHarnessOf, recordDelivery, reverifyHarnesses, type LiveCertificationPorts } from './live-certification.js';
import { LATENCY_FLUSH_MS, createLatencyCounters } from './latency-counters.js';
import { IDLE_QUIET_MS, MODEL_OFFER_CHECK_MS, createModelOfferRefresher, defaultModelOfferPorts, type ModelOfferPorts } from './model-offer.js';
import { effectiveLimits, type LogEntry, type ServiceHooks, type SidecarService, type WorkspaceResolver } from './service.js';
import { createAdmission, createBackgroundExecutor, type Admission, type AdmissionLimits, type BackgroundExecutor, type BackgroundJob, type ExecutorDepth } from './admission.js';
import { DIAGNOSTIC_DEFAULT_MS, DIAGNOSTIC_MAX_MS, openTelemetry, writeStatusLine, type StatusLineBody, type Telemetry } from './telemetry.js';

/**
 * Everything the running sidecar holds: the single store handle, the workspace registry,
 * the decision engine, the kill-switch reader and the built-in ops (IPC-09, IPC-11, IPC-16).
 */

const WORKSPACE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Status lists at most this many session links (the store's SESSION_LINKS_MAX and the contract's cap). */
const SESSION_LINKS_MAX = 16;
/** Status lists at most this many access pauses (R79); `active` still counts them all. */
const ACCESS_LIMITS_STATUS_MAX = 16;
const MAX_EVENT_BYTES = 65_536;
/** The surface contract's Id pattern: a task slice id status may list. */
const SLICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The status contract's Id and ModelId patterns (activeWorkers entries; routing.modelPin). */
const STATUS_ID = new RegExp(ID_PATTERN);
const STATUS_MODEL_ID = new RegExp(MODEL_ID_PATTERN);
/** Status lists at most this many active workers (the contract's cap). */
const ACTIVE_WORKERS_MAX = 64;
/** An owned task is at work while it is leased or running (session.link's "active" too). */
const ACTIVE_TASK_STATES = ['leased', 'running'] as const;
/** An owned task is queued while it waits for a lease or a prerequisite: the states the queue drain starts from (JEV-0008, JEV-0069). */
const QUEUED_TASK_STATES = ['validated', 'ready'] as const;

/**
 * The effective settings for a request's workspace: D's one resolver (`readEffectiveConfig`:
 * defaults, `jevris.config.json`, the workspace's `.jevris/config.json` lowering, the
 * `organization.json` ceiling). Undefined only when the resolver throws.
 */
function effectiveSettingsOf(ctx: SidecarOpContext): EffectiveConfig | undefined {
  try {
    return readEffectiveConfig({ home: ctx.home, workspaceRoot: ctx.workspace.root });
  } catch {
    return undefined;
  }
}

function effectiveConfigOf(ctx: SidecarOpContext): JevrisConfig | undefined {
  return effectiveSettingsOf(ctx)?.config;
}

/**
 * The effective mode for a workspace (owner decision 0eb319de): the single ceiling every gate
 * asks `modeAllows` about. A user file that is there but cannot be used is capped at observe by
 * readEffectiveConfig itself (SR-20); if the resolver throws, the mode is observe here too.
 */
function effectiveModeFor(home: string, workspaceRoot: string | null): Mode {
  try {
    return readEffectiveConfig({ home, workspaceRoot }).config.mode;
  } catch {
    return FAIL_CLOSED_MODE;
  }
}

/**
 * The effective `jev.assist` for a workspace (owner decision 2026-10-01): `classify` or `off`. If the
 * resolver throws, Jev assist is off here: a classification call is never made on a guess.
 */
function effectiveJevAssistFor(home: string, workspaceRoot: string | null): 'off' | 'classify' {
  try {
    return jevAssistOf(readEffectiveConfig({ home, workspaceRoot }).config);
  } catch {
    return 'off';
  }
}

/**
 * The engine, with each decision and advice record it makes carrying the mode it was made under
 * (the workspace's effective mode), unless the caller names one (a managed worker's route does).
 */
export function recordingMode(engine: unknown, modeOf: (workspaceId: string) => Mode): unknown {
  if (engine === null || typeof engine !== 'object') return engine;
  return new Proxy(engine, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property !== 'decide' && property !== 'recordAdvice') return method.bind(target);
      return (first: unknown, ...rest: unknown[]) => {
        const request = plainRecord(first);
        const workspaceId = request?.['workspaceId'];
        if (request === undefined || request['mode'] !== undefined || typeof workspaceId !== 'string') return method.call(target, first, ...rest);
        return method.call(target, { ...request, mode: modeOf(workspaceId) }, ...rest);
      };
    },
  });
}

/** The upgrade's mode notice (D's modeMigrationNotice), or undefined; a status row that does not fit is dropped. */
function modeNoticeFor(home: string): string | undefined {
  try {
    return modeMigrationNotice({ home }) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The pinned harness model a status request names (a contract ModelId), or null. */
function statusModelPin(value: unknown): string | null {
  return typeof value === 'string' && STATUS_MODEL_ID.test(value) && !containsSecret(value) ? value : null;
}

/** Audit rows the CLI recorded while no sidecar ran (GOV-10); the CLI writes the same name. */
export const PENDING_AUDIT_FILE = 'audit-pending.jsonl';
const PENDING_AUDIT_KINDS = new Set(['credential.set', 'credential.remove', 'policy.change', 'kill-switch.clear', 'kill-switch.drill', 'data.delete', 'store.restore', 'store.migrate', 'egress.enable', 'egress.revoke']);
/**
 * The most one event subscriber is waited on before its answer is queued. It is further bounded
 * by 80% of the request's remaining deadline (the hot budget), so the hook still answers in time.
 * 250 ms lost proposals under machine load (a capsule restore, the Stop reminder), which then
 * read as NO_PROPOSAL; a subscriber that answers quickly is not slowed by a higher cap.
 */
const SUBSCRIBER_SLICE_CAP_MS = 700;
/**
 * A subscriber's synchronous work (up to its first await) cannot be interrupted: no timer fires
 * while it runs, so it delays every answer. Each start is measured. A subscriber whose last
 * synchronous prefix took this long or more runs after the answer instead (queued, with reason
 * SUBSCRIBER_SLOW_SYNC) until a measurement shows it is quick again. Subscribers start one at a
 * time, cheapest first, with a yield between starts so timers and I/O run in between.
 */
const SUBSCRIBER_SYNC_DEFER_MS = 100;
/**
 * K2: queued background work spills here past its memory bound (under the data folder, mode
 * 0600 files, each removed once it ran). It holds the event bodies, so it is private data like
 * the store; `jevris data delete` removes it with the data folder.
 */
export const SPOOL_DIR = 'spool';
/**
 * K3: event kinds whose answer must not be lost to load: a capsule restore and the Stop
 * continuation (what the harness shows next), and the PreCompact capsule the restore needs. They
 * are never queued by choice: they wait for their session's earlier work, then run inside the
 * full deadline, not a slice of it. The same kinds ride the answer lane at admission
 * (ANSWER_EVENT_KINDS).
 */
const ANSWER_KINDS: ReadonlySet<string> = new Set(ANSWER_EVENT_KINDS);
/**
 * How long a delivery key marks a repeat as a redelivery, the same window the orchestrator's
 * hook subscriber keeps. A harness retries a hook within seconds; a later event with the same
 * key is a new event, recorded and handed to the subscribers.
 */
export const EVENT_DEDUP_WINDOW_MS = 5 * 60_000;
/** At most this many in-memory delivery records (used only without a store); oldest go first. */
export const EVENT_DEDUP_RECORDS_MAX = 10_000;
/**
 * A retry waiting for the first delivery's answer (the answer replay, rule 2) stops this long
 * before its own deadline, so its duplicate answer still goes out in time.
 */
export const EVENT_REPLAY_WAIT_MARGIN_MS = 50;

type StoreModule = typeof import('@jevris/store');

const ARCHIVE_PERIOD_MS = 60_000;
const DAY_MS = 86_400_000;
/** The semantic hot-path target (AGENTS.md: 900 ms total), reported beside the latency counters. */
const SEMANTIC_TARGET_MS = 900;

export interface RuntimeStateInput {
  readonly home: string;
  readonly paths: JevrisPaths;
  readonly log: (entry: LogEntry) => void;
  readonly openStore: boolean;
  readonly engine?: unknown;
  /** Upper bound on one event subscriber's slice (default SUBSCRIBER_SLICE_CAP_MS). */
  readonly subscriberSliceMs?: number;
  /** The clock events are stamped and deduped with (tests); default Date.now. */
  readonly eventClock?: () => number;
  /** Where this sidecar runs (IPC-19); detected when absent. */
  readonly locality?: ExecutionLocality;
  /** The trace and counter clock (tests); default Date.now. */
  readonly telemetryClock?: () => number;
  /** Live certification evidence and re-checks (F's recordLiveEvent and maybeReverify); false turns them off. */
  readonly liveCertification?: LiveCertificationPorts | false;
  /** The harness model-offer refresh ports (tests); absent: the product ports (off under a test run); false: off. */
  readonly modelOffer?: ModelOfferPorts | false;
  /** The idle quiet time before a refresh and the busy retry (tests shorten them). */
  readonly modelOfferIdleMs?: number;
  /** Hot and background admission pools (audit P4); DEFAULT_ADMISSION when absent. */
  readonly admission?: Partial<AdmissionLimits>;
  /** Background executor: concurrent jobs (default 4) and queued bytes kept in memory before the spool (default 16 MiB). */
  readonly backgroundConcurrency?: number;
  readonly backgroundMemoryBytes?: number;
  /** P10: the script the store-maintenance worker runs (the sidecar entry). Absent: the sweep runs inline. */
  readonly maintenanceWorker?: string | URL;
  /** Tests only: the in-use owned-worker worktrees of a workspace (default: D's ownedWorktreeWorkspaces). */
  readonly ownedWorktrees?: (ctx: SidecarOpContext) => readonly { readonly taskId: string; readonly workspaceId: string }[];
  /** Tests only: whether a harness version passes its route.host certify case (default: the certification records). */
  readonly hostRouteCertified?: (query: HostRouteQuery) => Promise<boolean>;
  /** Access limits R76 (design 9.3): how often access-blocked tasks are checked for resume; 0 turns the tick off (default 60 s). */
  readonly accessResumeMs?: number;
  /**
   * The Jev connection opened at start (`prewarmJevConnection`). Absent: the provider package's own, used only when the
   * sidecar loads its engine itself (a test that passes `engine` opens no connection); false: none.
   */
  readonly jevConnection?: JevConnectionPorts | false;
}

/** What opening the Jev connection ahead of the first request needs from the host. */
export interface JevConnectionPorts {
  /** Opens one connection to the origin (no request, no data); true when one is ready. */
  prewarm(url: string): Promise<boolean>;
  /** True while a test provider replaces the real one (its loopback address is not worth a connection). */
  overrideActive(): boolean;
}

/** The provider package's connection ports, or undefined when it does not offer them. */
async function providerConnectionPorts(): Promise<JevConnectionPorts | undefined> {
  try {
    const provider: unknown = await import('@jevris/provider-typesafe');
    const prewarm = Reflect.get(provider as object, 'prewarmConnection') as ((url: string) => Promise<boolean>) | undefined;
    const override = Reflect.get(provider as object, 'readProviderOverride') as ((env?: unknown) => { readonly active: boolean }) | undefined;
    if (typeof prewarm !== 'function') return undefined;
    return { prewarm, overrideActive: () => (typeof override === 'function' ? override(process.env).active : false) };
  } catch {
    return undefined;
  }
}

/**
 * Opens the Jev connection at start (TCP and TLS, no request and no data), so the first request is not the one that pays for
 * the handshake: measured live, 50 to 110 ms of a first `route` that took 440 ms where one on an open connection took 300.
 * Only when Jev could be asked right now: the engine has a key, the mode allows background network work (a mode below
 * observe has none, SSOT 4.2), `jev.assist` is not off, the kill switch is clear and no test provider stands in. Any other
 * state opens nothing. The connection is idle until a request takes it, and the pool closes it when none does.
 */
export async function prewarmJevConnection(input: {
  readonly engine: unknown;
  readonly ports: JevConnectionPorts | undefined;
  readonly allowed: () => boolean;
  readonly assist: () => 'off' | 'classify';
  readonly killSwitchStopped: () => Promise<boolean>;
}): Promise<{ readonly warmed: boolean; readonly reasonCode: string }> {
  const no = (reasonCode: string): { readonly warmed: false; readonly reasonCode: string } => ({ warmed: false, reasonCode });
  if (input.ports === undefined) return no('PREWARM_NO_PORT');
  if (engineField(input.engine, 'providerConfigured') !== true) return no('PREWARM_RULES_ONLY');
  if (input.ports.overrideActive()) return no('PREWARM_TEST_PROVIDER');
  if (!input.allowed()) return no('PREWARM_MODE_OFF');
  if (input.assist() === 'off') return no('PREWARM_ASSIST_OFF');
  if (await input.killSwitchStopped()) return no('PREWARM_KILL_SWITCH');
  try {
    const warmed = await input.ports.prewarm(EXPLICIT_BASE_URL);
    return { warmed, reasonCode: warmed ? 'PREWARM_READY' : 'PREWARM_UNAVAILABLE' };
  } catch {
    return no('PREWARM_UNAVAILABLE');
  }
}

/** Access limits R76 (design 9.3): the resume tick's period. */
export const ACCESS_RESUME_TICK_MS = 60_000;

/** What the route.host certification answer is asked for (serving hosts R50). */
export interface HostRouteQuery {
  readonly home: string;
  readonly harness: string;
  readonly nowMs: number;
  readonly harnessVersion: string | null;
}

/**
 * Serving hosts R50: whether a Kilo or OpenCode version passes F's route.host certify case (D's
 * hostRouteCertified; certify grants it only with session.route). Any other harness is false.
 */
function routeHostCertified(query: HostRouteQuery): Promise<boolean> {
  return hostRouteCertified({ home: query.home, harness: query.harness, nowMs: query.nowMs, harnessVersion: query.harnessVersion });
}

/** P4: the sidecar's queues, counts only. */
export interface QueueStatus {
  readonly hotInFlight: number;
  readonly backgroundInFlight: number;
  /** Requests answered past their deadline whose work still runs. */
  readonly overrun: number;
  /** Background jobs running, subscriber work held past its slice, and jobs waiting in memory or in the spool. */
  readonly running: number;
  readonly held: number;
  readonly queued: number;
  readonly spooled: number;
}

export interface HealthBody {
  readonly pid: number;
  readonly version: string;
  /** The build this sidecar loaded (protocol runtimeBuild id), or null from a tree without a bundle. */
  readonly build: string | null;
  /** Verification runs under way or queued in this sidecar; a restart waits for them. */
  readonly verificationRuns: number;
  readonly protocol: number;
  readonly bootId: string;
  readonly endpoint: string;
  readonly startedAtMs: number;
  readonly uptimeMs: number;
  readonly connections: number;
  readonly inFlight: number;
  /**
   * The op budgets in force, in ms: 900 hot, 5000 background and 4000 on the answer lane in the
   * product. Only a test run (JEVRIS_TEST=1 with JEVRIS_TEST_BUDGET_SCALE) scales them, and
   * `budgetScale` then says by how much; it is 1 everywhere else.
   */
  readonly budgetMs: { readonly hot: number; readonly background: number; readonly answer: number };
  readonly budgetScale: number;
  readonly workspaces: number;
  readonly store: {
    readonly state: 'ok' | 'absent' | 'unavailable';
    readonly diagnostic: string | null;
    readonly schemaVersion: number | null;
    readonly filesystem: string | null;
    readonly fault: string | null;
  };
  readonly killSwitch: 'clear' | 'stopped';
  readonly engine: 'ready' | 'rules-only';
  readonly opSources: readonly string[];
  readonly maintenance: { readonly lastRunAtMs: number | null; readonly lastError: string | null };
  /** The execution environment this sidecar, its socket and its store live in (US37). */
  readonly locality: {
    readonly kind: ExecutionLocality['kind'];
    readonly id: string;
    readonly container: boolean;
    readonly ssh: boolean;
    readonly signals: readonly string[];
    readonly runtimeDir: string;
    readonly dataDir: string;
  };
}

export interface RuntimeState {
  readonly home: string;
  readonly paths: JevrisPaths;
  readonly workspaces: WorkspaceResolver & { list(): readonly SidecarWorkspace[] };
  readonly engine: unknown;
  /** The workspace's effective mode (owner decision 0eb319de); the service asks it per request. */
  modeOf(workspace: SidecarWorkspace): Mode;
  /** The effective `jev.assist` for a workspace (owner decision 2026-10-01). */
  jevAssistOf(workspace: SidecarWorkspace): 'off' | 'classify';
  readonly store: unknown;
  readonly storeDiagnostic: string | null;
  storeFor(workspace: SidecarWorkspace): unknown;
  /**
   * OD-8: what route.turn learns from the sidecar and never from the plugin: the session's approved
   * scope with D's turn gate and the task's slice, and the effective `routing.mainSession`.
   */
  turnContext(ctx: SidecarOpContext, sessionId: string, harness: string): Promise<{ readonly scope: { readonly taskId?: string; readonly risk?: string; readonly sliceId?: string; readonly turnActuation: 'bounded-auto' | 'advise'; readonly turnReasonCode: string | null } | null; readonly mainSession: (typeof MAIN_SESSION_MODES)[number] | null; readonly hostRouteCertified: boolean }>;
  /** P5: the advice-adherence port for a workspace (C's advice handlers), or undefined. */
  adviceAdherenceFor(workspace: SidecarWorkspace): SidecarAdviceAdherence | undefined;
  killSwitchStopped(): Promise<boolean>;
  trace(entry: SidecarTraceEvent & { readonly ws: string; readonly op: string }): void;
  /** OBS-01, OBS-02: traces and request counters. */
  readonly telemetry: Telemetry;
  readonly requestReceived: NonNullable<ServiceHooks['requestReceived']>;
  readonly requestDone: NonNullable<ServiceHooks['requestDone']>;
  /** OBS-03: rewrites the status-line cache from local state now. */
  refreshStatusLine(): Promise<void>;
  attach(service: SidecarService, loaded: LoadedOps): void;
  /** Built-in ops plus the loaded package ops, for the service. */
  ops(loaded: LoadedOps, requestShutdown: () => void): ReadonlyMap<string, SidecarOpDefinition>;
  health(): Promise<HealthBody>;
  startupMaintenance(): Promise<void>;
  dailyMaintenance(): Promise<void>;
  /** GOV-10: the audit row for a transport-level egress refusal (the engine's guard calls it). */
  recordEgressRefusal(reasonCode: string, fields: number): void;
  /** Archives terminal decisions from the engine journal into the store (DATA-05). */
  archiveDecisions(): Promise<void>;
  /** R76: one resume tick now (the timer's work); resolves when it ends, at once when one is running. */
  resumeAccessBlocked(): Promise<void>;
  /** P4: the hot and background admission the service uses. */
  readonly admission: Admission;
  /** P4, K1, K2: the bounded background executor (subscriber work past its slice, live certification). */
  readonly executor: BackgroundExecutor;
  close(): Promise<void>;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}


/**
 * Workspace identity from the root directory's device, inode and birth time, not its path
 * (IPC-09): D's rootIdentityId, the one id the CLI and the sidecar share. Birth time matters on
 * Linux, which hands a freed inode to the next directory at once.
 */
export function workspaceIdentity(root: string): SidecarWorkspace | undefined {
  try {
    const real = realpathSync(root);
    const id = rootIdentityId(real);
    return id === undefined ? undefined : { id, root: real };
  } catch {
    return undefined;
  }
}

/** The Jev decision budget's limits, read at every reservation (owner decision 2026-09-29). */
interface BudgetLimitReaders {
  readonly machine: () => number;
  readonly workspace: (workspaceId: string) => number | null;
}

async function loadEngine(
  home: string,
  log: (entry: LogEntry) => void,
  onEgressRefused: (reasonCode: string, fields: number) => void = () => undefined,
  providerConsent?: (provider: string) => unknown,
  budgetLimits?: BudgetLimitReaders,
  onNoCredential: (advice: string) => void = () => undefined,
): Promise<unknown> {
  let provider: unknown;
  try {
    provider = await import('@jevris/provider-typesafe');
  } catch {
    return undefined;
  }
  const factory = provider !== null && typeof provider === 'object' ? Reflect.get(provider, 'createSidecarEngine') : undefined;
  if (typeof factory !== 'function') return undefined;
  let credential: string | null = null;
  try {
    // Only the sidecar reads the Jev credential (GOV-06).
    const cred = await import('@jevris/cli/credential');
    // GOV-07: the keychain first; an explicitly named owner-only file or systemd credential
    // only when the keychain has no key. The log gets the source or a reason code, never the key.
    const resolved = await cred.resolveProviderCredential(cred.openHostEntry, {
      // Under a test run the opt-in is ignored too, so a developer's shell variable never
      // hands a live key to a test sidecar (the keyring is already blocked there).
      optInEnv: cred.keyringBlockedInTests() ? {} : {
        JEVRIS_CREDENTIAL_FILE: process.env.JEVRIS_CREDENTIAL_FILE,
        JEVRIS_CREDENTIAL_SYSTEMD: process.env.JEVRIS_CREDENTIAL_SYSTEMD,
        CREDENTIALS_DIRECTORY: process.env.CREDENTIALS_DIRECTORY,
      },
      onSource: (source) => {
        if (source !== 'keychain') log({ level: 'info', event: 'credential-source', source });
      },
    });
    if ('refused' in resolved && resolved.refused !== undefined) {
      log({ level: 'warn', event: 'credential-opt-in-refused', reasonCode: resolved.refused });
    }
    credential = 'apiKey' in resolved && typeof resolved.apiKey === 'string' ? resolved.apiKey : null;
    // Status says why there is no key, and does not point a headless machine at a command that cannot work.
    if (credential === null) {
      onNoCredential(cred.noCredentialAdvice({ keystoreFailure: 'keystoreFailure' in resolved ? resolved.keystoreFailure : undefined, optInRefused: 'refused' in resolved ? resolved.refused : undefined }));
    }
  } catch {
    credential = null;
  }
  if (credential === null) log({ level: 'info', event: 'credential', state: 'rules-only' });
  try {
    // Jev's requests go over the provider's own `nodeFetch`: node:https with a keep-alive pool of several
    // sockets. The global `fetch` negotiates HTTP/2 with api.typesafe.ai and then sends concurrent requests
    // to it one at a time (measured live: four at once took 201, 389, 573 and 776 ms against 240 ms each
    // on separate sockets), so several sessions routing together lost their Jev answer to the wait.
    const pooled = Reflect.get(provider as object, 'nodeFetch') as ((input: string, init?: unknown) => Promise<unknown>) | undefined;
    const globalFetch = Reflect.get(globalThis, 'fetch') as ((input: unknown, init?: unknown) => Promise<unknown>) | undefined;
    const baseFetch = typeof pooled === 'function' ? (pooled as (input: unknown, init?: unknown) => Promise<unknown>) : globalFetch;
    return await (factory as (input: object) => unknown)({
      home,
      credential,
      // The packet builder reads host egress on every decision (C's sourceEgress option);
      // only the administrator's host policy approves (GOV-01).
      sourceEgress: () => ({ provenance: 'administrator', sourceEgress: resolveSourceEgress({ home }) === 'approved' ? 'approved-scoped' : 'deny-until-approved' }),
      // Per-provider egress consent (owner 7be3c43, OD-4): C eliminates a candidate whose
      // provider needs consent and has none (PROVIDER_CONSENT_REQUIRED). A point read per call.
      ...(providerConsent !== undefined ? { providerConsent } : {}),
      // The monthly Jev decision budget: the machine-wide limit and each workspace's own cap, read
      // at every reservation, so `jevris configure` applies without a restart (owner decision 2026-09-29).
      ...(budgetLimits !== undefined ? { budgetLimit: budgetLimits.machine, workspaceBudgetLimit: budgetLimits.workspace } : {}),
      // GOV-01, GOV-08: no free-text evidence leaves unless host policy approves source
      // egress, and approved text is still secret-screened at the transport boundary.
      ...(baseFetch !== undefined
        ? {
            fetch: guardEgressFetch(baseFetch, () => resolveSourceEgress({ home }), (reasonCode, fields) => {
              log({ level: 'warn', event: 'egress-refused', reasonCode, fields: fields.slice(0, 16).join(',') });
              onEgressRefused(reasonCode, fields.length);
            }),
          }
        : {}),
      log: (line: unknown) => {
        log({ level: 'info', event: 'engine', detail: typeof line === 'string' ? line.slice(0, 200) : 'event' });
      },
    });
  } catch {
    log({ level: 'error', event: 'engine-failed' });
    return undefined;
  }
}

async function readKillSwitch(home: string): Promise<boolean> {
  try {
    const module = await import('@jevris/cli/kill-switch');
    // P8: on Windows the enterprise switch's registry read is cached (managed-exec.ts).
    return await module.readKillSwitchStopped(home, sidecarManagedOptions());
  } catch {
    // Unreadable means stopped (GOV-02).
    return true;
  }
}


const STORE_MESSAGES: { readonly [reason: string]: string } = {
  'writer-busy': 'Another Jevris process holds the store. Run `jevris sidecar stop`, then `jevris sidecar start`.',
  'network-filesystem': 'The Jevris data directory is on a network filesystem; the store never runs there. Set JEVRIS_HOME to a local disk.',
  'host-scope-mismatch': 'The Jevris store was copied from another machine or user and is refused. Move it aside or run `jevris store restore <backup>`.',
  'schema-newer': 'The Jevris store was written by a newer Jevris. Upgrade Jevris, or restore an older backup with `jevris store restore`.',
  'store-corrupt': 'The Jevris store failed its integrity check. Run `jevris store restore <backup>`; owned automation is stopped until then.',
  'store-full': 'The disk holding the Jevris store is full. Free space, then run `jevris sidecar restart`.',
  'store-io': 'The Jevris store could not be read or written. Check the disk, then run `jevris sidecar restart`.',
  'store-readonly': 'The Jevris store is read-only. Make the data directory writable, then run `jevris sidecar restart`.',
  'path-refused': 'The Jevris store path is refused (a symlink or a plugin directory). Run `jevris doctor`.',
};

/**
 * DATA-10: a refused store that is this user's file in this home most likely is this machine's
 * own store under an earlier network name (the scope once followed the host name).
 */
export function ownStoreRefusedMessage(dbPath: string, nowMs: number): string {
  const aside = `${dbPath}.refused-${new Date(nowMs).toISOString().slice(0, 10)}`;
  return `The Jevris store is refused: it has another machine identity, but it is your file in this home, so it probably came from an earlier network name of this machine. If you created it on this machine, run \`jevris store adopt\` in a terminal. Otherwise run \`jevris sidecar stop\`, move ${dbPath} (and any -wal and -shm file beside it) to ${aside}, then run \`jevris sidecar start\`.`;
}

function storeMessage(reason: string): string {
  return STORE_MESSAGES[reason] ?? `The Jevris store did not open (${reason}); the sidecar runs rules-only. Run \`jevris doctor\`.`;
}

function engineField(engine: unknown, key: string): unknown {
  return engine !== null && typeof engine === 'object' ? Reflect.get(engine, key) : undefined;
}

const OUTCOME = /^[a-z][a-z-]{0,31}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

export async function openRuntimeState(input: RuntimeStateInput): Promise<RuntimeState> {
  const { home, paths, log } = input;
  const dbPath = join(paths.data, 'jevris.db');
  const { hostScope, adoptHostScopes } = hostScopeForStore(home, dbPath);
  const registry = new Map<string, SidecarWorkspace>();
  let store: OpenedStore | undefined;
  let api: StoreModule | undefined;
  let storeDiagnostic: string | null = null;
  let filesystem: string | null = null;
  if (input.openStore) {
    try {
      api = await import('@jevris/store');
      const opened = api.openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope, adoptHostScopes });
      if (opened.ok) {
        store = opened;
        filesystem = opened.filesystem;
        if (opened.hostScopeMigrated === true) {
          // DATA-10: an earlier host-name scope of this machine and home, re-stamped on open.
          log({ level: 'info', event: 'store-host-scope', reasonCode: 'HOST_SCOPE_MIGRATED' });
          const audited = api.appendAudit(opened, { kind: 'store.adopt', actor: 'sidecar', channel: 'sidecar', atMs: Date.now(), detail: { reasonCode: 'HOST_SCOPE_MIGRATED' } });
          if (!audited.ok) log({ level: 'warn', event: 'audit-refused', kind: 'store.adopt', reason: audited.reason });
        }
        // IPC-09: workspaces persist; an id is honoured after a restart only while its root
        // still has the same identity.
        for (const row of api.listWorkspaces(opened)) registry.set(row.workspaceId, { id: row.workspaceId, root: row.rootPath });
      } else {
        storeDiagnostic = opened.reason === 'host-scope-mismatch' && storeBelongsHere(home, dbPath) ? ownStoreRefusedMessage(dbPath, Date.now()) : storeMessage(opened.reason);
        log({ level: 'error', event: 'store-refused', reason: opened.reason });
      }
    } catch {
      storeDiagnostic = 'The Jevris store driver did not load; the sidecar runs rules-only. Run `jevris doctor`.';
      log({ level: 'error', event: 'store-unavailable' });
    }
  }
  const sliceCapMs = typeof input.subscriberSliceMs === 'number' && input.subscriberSliceMs > 0 ? input.subscriberSliceMs : testScaledMs(SUBSCRIBER_SLICE_CAP_MS, process.env);
  /** The last measured synchronous prefix of each subscriber, in ms. */
  const syncCostMs = new Map<string, number>();
  // GOV-10: every transport-level egress refusal is an audit row (reason code and field count, no content).
  const auditEgress = (reasonCode: string, fields: number): void => {
    if (store === undefined || api === undefined) return;
    const written = api.appendAudit(store, { kind: 'egress.decision', actor: 'sidecar', channel: 'sidecar', atMs: Date.now(), detail: { decision: 'refused', reasonCode, fields } });
    if (!written.ok) log({ level: 'warn', event: 'audit-refused', kind: 'egress.decision', reason: written.reason });
  };
  /** Why the engine has no Jev key, once known; the plain advice until then. */
  let noCredentialAdvice: string | null = null;
  const loadedEngine =
    input.engine !== undefined
      ? input.engine
      : await loadEngine(home, log, auditEgress, providerConsentReader(() => (store !== undefined && api !== undefined ? { store, api } : undefined)), budgetLimitReaders(home, (workspaceId) => registry.get(workspaceId)?.root ?? null), (advice) => {
          noCredentialAdvice = advice;
        });
  // Each engine action that settles a decision mirrors it into the store before the op
  // answers, so `status` lists it at once; the periodic archive stays the catch-up path.
  // Owner decision 0eb319de: each record carries the mode it was made under, not the engine's default.
  const modeOfWorkspace = (workspaceId: string): Mode => effectiveModeFor(home, registry.get(workspaceId)?.root ?? null);
  const engine = mirrorTerminalDecisions(recordingMode(loadedEngine, modeOfWorkspace), (decisionId) => archiveOne(decisionId));
  let service: SidecarService | undefined;
  let loadedOps: LoadedOps | undefined;
  const background = new Set<Promise<unknown>>();
  // P4, K1, K2 (owner ededdba: no shedding): hot and background admission, and one bounded
  // executor for work that runs after an answer. Hook requests start first; background work
  // waits while one is in flight unless nothing background runs, so it always progresses.
  const admission = createAdmission(input.admission ?? {});
  const executor: BackgroundExecutor = createBackgroundExecutor({
    ...(input.backgroundConcurrency !== undefined ? { concurrency: input.backgroundConcurrency } : {}),
    ...(input.backgroundMemoryBytes !== undefined ? { memoryBytes: input.backgroundMemoryBytes } : {}),
    hotBusy: () => admission.counts().hot + admission.counts().answer > 0,
    spoolDir: join(input.paths.data, SPOOL_DIR),
    revive: (text) => reviveSubscriberJob(text),
    onEvent: (event) => {
      const reasonCode = event.event === 'job-spooled' ? 'BACKGROUND_SPOOLED' : event.event === 'job-failed' ? 'SUBSCRIBER_FAILED' : event.event === 'spool-unreadable' ? 'SPOOL_UNREADABLE' : 'SPOOL_WRITE_FAILED';
      trace({ event: `background-${event.event}`, ws: '', op: 'event', subscriber: event.label, reasonCode });
    },
  });
  admission.onIdle(() => executor.kick());
  const livePorts: LiveCertificationPorts | false =
    input.liveCertification === false ? false : { root: () => jevrisPackage().root, ...(input.liveCertification ?? {}) };
  /** Runs a live-certification call after the answer, through the executor; it never throws and never blocks one. */
  const liveSoon = (run: () => Promise<unknown>): void => {
    executor.enqueue({ key: 'live-certification', label: 'live-certification', bytes: 256, run: () => run().catch(() => undefined) });
  };
  let maintenance: { lastRunAtMs: number | null; lastError: string | null } = { lastRunAtMs: null, lastError: null };
  let archiving: Promise<void> | undefined;

  function persistWorkspace(identity: SidecarWorkspace): void {
    if (store === undefined || api === undefined || identity.root === null) return;
    const saved = api.registerWorkspace(store, { workspaceId: identity.id, rootIdentity: identity.id, rootPath: identity.root, nowMs: Date.now() });
    if (!saved.ok) log({ level: 'warn', event: 'workspace-persist-failed', ws: identity.id, reason: saved.reason });
  }

  const workspaces: RuntimeState['workspaces'] = {
    async resolve(ws) {
      if (isAbsoluteOnAnyPlatform(ws) || /^[A-Za-z]:[\\/]/.test(ws)) {
        const identity = workspaceIdentity(ws);
        if (identity === undefined) return 'unknown';
        const known = registry.get(identity.id);
        if (known === undefined || known.root !== identity.root) {
          // New, or the same directory reached by a new path (rename, mount): one identity.
          registry.set(identity.id, identity);
          persistWorkspace(identity);
          if (known === undefined) log({ level: 'info', event: 'workspace-registered', ws: identity.id });
        }
        return identity;
      }
      if (!WORKSPACE_ID.test(ws)) return 'unknown';
      const known = registry.get(ws);
      if (known === undefined || known.root === null) return 'unknown';
      // A persisted id is honoured only while its root still has that identity.
      const current = workspaceIdentity(known.root);
      if (current === undefined || current.id !== ws) return 'unknown';
      return known;
    },
    list: () => [...registry.values()],
  };

  /** P5: model advice recorded at delivery and the per-session override count, on the workspace view. */
  function adviceAdherenceFor(workspace: SidecarWorkspace): SidecarAdviceAdherence | undefined {
    if (store === undefined || api === undefined || workspace.id === 'global') return undefined;
    const storeApi = api;
    const view = storeApi.workspaceView(store, workspace.id);
    if (view === undefined) return undefined;
    return {
      open(advice) {
        try {
          const written = storeApi.openAdvice(view, advice);
          if (!written.ok) log({ level: 'warn', event: 'advice-adherence-refused', reason: written.reason });
          return written.ok;
        } catch {
          return false;
        }
      },
      overrides(advice) {
        try {
          return storeApi.adviceOverrides(view, advice);
        } catch {
          return 0;
        }
      },
    };
  }

  function storeFor(workspace: SidecarWorkspace): unknown {
    if (store === undefined || api === undefined) return undefined;
    if (workspace.id === 'global') return undefined;
    return api.workspaceView(store, workspace.id);
  }

  const telemetry = openTelemetry({ stateDir: paths.state, ...(input.telemetryClock !== undefined ? { now: input.telemetryClock } : {}) });

  // P8: persisted latency and deadline counters (daily rows in the store; see latency-counters.ts).
  const latency = createLatencyCounters({ stateDir: paths.state, store: () => (store !== undefined && api !== undefined ? { store, api } : undefined) });
  const latencyTimer = setInterval(() => {
    latency.flush();
  }, LATENCY_FLUSH_MS);
  latencyTimer.unref();

  /**
   * SSOT §4.2: in off there is no invisible background network activity. The host's mode (your
   * file and the administrator ceilings, no workspace) gates the sidecar's own background work
   * that reaches a harness or the network: the model listing (with Codex's usage read) and the
   * live certification re-check. Local work (the store, retention, archive, status line) runs.
   */
  const backgroundNetworkAllowed = (): boolean => modeAllows(effectiveModeFor(home, null), 'record');

  // The Jev connection, opened ahead of the first request (see prewarmJevConnection). Background work: the answer to the
  // first request is never held for it, and a close waits for it only briefly.
  const jevPorts = input.jevConnection === false ? undefined : (input.jevConnection ?? (input.engine === undefined ? await providerConnectionPorts() : undefined));
  const warming = prewarmJevConnection({ engine: loadedEngine, ports: jevPorts, allowed: backgroundNetworkAllowed, assist: () => effectiveJevAssistFor(home, null), killSwitchStopped: () => readKillSwitch(home) })
    .then((outcome) => {
      if (outcome.warmed || outcome.reasonCode === 'PREWARM_UNAVAILABLE') log({ level: 'info', event: 'jev-connection', reasonCode: outcome.reasonCode });
    })
    .catch(() => undefined);
  background.add(warming);
  void warming.finally(() => background.delete(warming));

  // The harness model-offer refresh (DOMAINS 3f090fa): only while idle, never concurrently.
  let lastRequestAtMs = Date.now();
  const quietMs = typeof input.modelOfferIdleMs === 'number' && input.modelOfferIdleMs >= 0 ? input.modelOfferIdleMs : IDLE_QUIET_MS;
  // The product ports by default; a test run gets them only when it passes ports, so a test
  // sidecar never reads install receipts or writes an offer file it did not ask for.
  const offerPorts: ModelOfferPorts | undefined =
    input.modelOffer === false ? undefined : input.modelOffer ?? (process.env['JEVRIS_TEST'] !== undefined && process.env['JEVRIS_TEST'] !== '' ? undefined : defaultModelOfferPorts(home));
  const modelOffer =
    offerPorts === undefined
      ? undefined
      : createModelOfferRefresher({
          ports: offerPorts,
          isIdle: () => !closed && (service?.inFlight() ?? 0) === 0 && Date.now() - lastRequestAtMs >= quietMs,
          allowed: backgroundNetworkAllowed,
          busyRetryMs: Math.max(10, quietMs),
          trace: (outcome) => {
            telemetry.trace({ event: 'model-offer.refreshed', ws: '', op: 'model-offer', harness: outcome.harness, reason: outcome.reason, models: outcome.models, ms: outcome.ms, ...(outcome.reasonCode !== null ? { reasonCode: outcome.reasonCode } : {}) });
            log({ level: outcome.reasonCode === null ? 'info' : 'warn', event: 'model-offer', harness: outcome.harness, models: outcome.models, reasonCode: outcome.reasonCode });
          },
        });
  const modelOfferTimer = modelOffer === undefined ? undefined : setInterval(() => void modelOffer.tick(), MODEL_OFFER_CHECK_MS);
  modelOfferTimer?.unref();

  // ---------------------------------------------------------------- access resume (R76)

  /**
   * Access limits R76 (design 9.3, 7.4; D's resumeAccessBlocked, 0b66509b): every minute, each
   * workspace with an access-blocked task that may resume is handed to D, which moves the task back
   * to ready once, when its pause has ended or been cleared, and continues owned work.
   * - The host ledger's access-blocked rows are read first, so a workspace with none is never
   *   opened, and nothing is created when orchestration never ran here.
   * - Each workspace runs with a full operation context: its store, the sidecar's engine, the kill
   *   switch as read now (unreadable reads as stopped), a background deadline and a live signal.
   * - One tick at a time; a tick in progress makes the next one a no-op. A throw in one workspace is
   *   traced by code and never stops the others. Traces carry codes and counts, never task text.
   */
  const accessResumeMs = input.accessResumeMs ?? ACCESS_RESUME_TICK_MS;
  let accessResumeRun: Promise<void> | undefined;
  const accessResumeStop = new AbortController();

  function resumeContext(workspace: SidecarWorkspace, killSwitch: boolean): SidecarOpContext {
    const adherence = adviceAdherenceFor(workspace);
    return {
      op: 'access.resume',
      client: 'cli',
      scopes: ['submit'],
      workspace,
      body: {},
      home,
      signal: accessResumeStop.signal,
      deadline: createDeadline(sidecarBudgetsMs(process.env).background, monotonicClock),
      store: storeFor(workspace),
      killSwitchStopped: killSwitch,
      ...(adherence !== undefined ? { adviceAdherence: adherence } : {}),
      engine,
      trace(event) {
        trace({ ...event, ws: workspace.id, op: 'access.resume', client: 'cli' });
      },
    };
  }

  async function accessResumeTick(): Promise<void> {
    const hostRoot = join(paths.data, 'orchestration', 'host');
    if (!existsSync(hostRoot)) return;
    const pending = new Set<string>();
    for (const row of openLedger(hostRoot).list<AccessBlockedRow>(ACCESS_BLOCKED_COLLECTION)) {
      if (row !== null && typeof row === 'object' && row.resumed !== true && row.autoResume === true && typeof row.workspaceId === 'string') pending.add(row.workspaceId);
    }
    if (pending.size === 0) return;
    const killSwitch = await readKillSwitch(home);
    for (const workspace of workspaces.list()) {
      if (closed || workspace.root === null || !pending.has(workspace.id)) continue;
      try {
        const ctx = resumeContext(workspace, killSwitch);
        const ws = openWorkspace({ home, workspaceRoot: workspace.root, workspaceId: workspace.id, store: ctx.store });
        const result = await resumeAccessBlocked(ctx, ws, Date.now());
        if (result.resumed.length > 0 || result.reasonCode !== 'OK') trace({ event: 'access-resume', ws: workspace.id, op: 'access.resume', reasonCode: result.reasonCode, resumed: result.resumed.length });
      } catch {
        trace({ event: 'access-resume-failed', ws: workspace.id, op: 'access.resume', reasonCode: 'ACCESS_RESUME_FAILED' });
      }
    }
  }

  function resumeAccessTick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (accessResumeRun !== undefined) return accessResumeRun;
    accessResumeRun = accessResumeTick()
      .catch(() => {
        log({ level: 'warn', event: 'access-resume-failed', reasonCode: 'ACCESS_RESUME_FAILED' });
      })
      .finally(() => {
        accessResumeRun = undefined;
      });
    return accessResumeRun;
  }
  const accessResumeTimer = accessResumeMs > 0 ? setInterval(() => void resumeAccessTick(), Math.max(10, accessResumeMs)) : undefined;
  accessResumeTimer?.unref();

  function trace(entry: SidecarTraceEvent & { readonly ws: string; readonly op: string }): void {
    log({ level: 'info', event: `trace:${entry.event}`.slice(0, 64), ws: entry.ws, op: entry.op, reasonCode: entry.reasonCode ?? null });
    telemetry.trace(entry);
    if ((entry.event === 'subscriber-queued' || entry.event === 'subscriber-slow-sync') && typeof entry['subscriber'] === 'string') {
      latency.count('subscriber', entry['subscriber'], entry.reasonCode ?? 'SUBSCRIBER_QUEUED', typeof entry['ms'] === 'number' ? entry['ms'] : 0);
    } else if (entry.event === 'breaker-open') {
      latency.count('breaker', typeof entry['breaker'] === 'string' ? entry['breaker'] : 'provider', entry.reasonCode ?? 'CIRCUIT_OPEN', 0);
    }
  }

  // ---------------------------------------------------------------- status line (OBS-03)

  let statusLineTimer: NodeJS.Timeout | undefined;
  let statusLineDue = false;
  let closed = false;

  function localMidnight(nowMs: number): number {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * P9: today's status-line counts, kept in memory. Seeded from the store at the first refresh of
   * a day and every TALLY_RESEED_MS (a reconciled cost updates a row in place), and otherwise
   * advanced by the rows added since the last one counted, so a refresh never reads the whole day.
   */
  let tally: { readonly dayStartMs: number; readonly seededAtMs: number; decisions: number; abstentions: number; fallbacks: number; costMicroUsd: number; lastRowid: number } | undefined;

  function todayCounts(nowMs: number): { readonly decisions: number; readonly abstentions: number; readonly fallbacks: number; readonly costMicroUsd: number } {
    const zero = { decisions: 0, abstentions: 0, fallbacks: 0, costMicroUsd: 0 };
    if (store === undefined || api === undefined) return zero;
    const dayStartMs = localMidnight(nowMs);
    const reseed = tally === undefined || tally.dayStartMs !== dayStartMs || nowMs - tally.seededAtMs > TALLY_RESEED_MS;
    const counted = api.decisionTally(store, { sinceMs: dayStartMs, ...(reseed || tally === undefined ? {} : { afterRowid: tally.lastRowid }) });
    if ('reason' in counted) return tally === undefined || reseed ? zero : tally;
    if (reseed || tally === undefined) {
      tally = { dayStartMs, seededAtMs: nowMs, decisions: counted.decisions, abstentions: counted.abstentions, fallbacks: counted.fallbacks, costMicroUsd: counted.costMicroUsd, lastRowid: counted.lastRowid };
    } else {
      tally.decisions += counted.decisions;
      tally.abstentions += counted.abstentions;
      tally.fallbacks += counted.fallbacks;
      tally.costMicroUsd += counted.costMicroUsd;
      tally.lastRowid = counted.lastRowid;
    }
    return { decisions: tally.decisions, abstentions: tally.abstentions, fallbacks: tally.fallbacks, costMicroUsd: tally.costMicroUsd };
  }

  async function statusLineBody(sidecar: 'running' | 'stopped'): Promise<StatusLineBody> {
    const nowMs = Date.now();
    const stopped = await readKillSwitch(home);
    const storeState = storeHealth().state;
    const today = todayCounts(nowMs);
    const decisions: StatusLineBody['decisions'] = stopped
      ? 'off'
      : storeState !== 'ok'
        ? 'degraded'
        : !engineReady()
          ? 'rules-only'
          : circuitDisabledReason(engine) !== null || providerDownReason(recentDecisions(undefined), nowMs) !== null
            ? 'degraded'
            : 'jev';
    return {
      schemaVersion: 'jevris-statusline-1',
      writtenAtMs: nowMs,
      pid: process.pid,
      sidecar,
      killSwitch: stopped ? 'stopped' : 'clear',
      decisions,
      store: storeState,
      diagnostic: telemetry.diagnostic().active,
      today,
    };
  }

  async function refreshStatusLine(): Promise<void> {
    if (closed) return;
    try {
      if (!writeStatusLine(paths.state, await statusLineBody('running'))) log({ level: 'warn', event: 'statusline-write-failed' });
    } catch {
      log({ level: 'warn', event: 'statusline-write-failed' });
    }
  }

  /** At most one rewrite a second after requests; a 30 s heartbeat keeps the file fresh. */
  function statusLineSoon(): void {
    if (statusLineDue || closed) return;
    statusLineDue = true;
    const timer = setTimeout(() => {
      statusLineDue = false;
      void refreshStatusLine();
    }, 1000);
    timer.unref();
  }

  function storeHealth(): HealthBody['store'] {
    if (store === undefined || api === undefined) {
      return { state: input.openStore ? 'unavailable' : 'absent', diagnostic: storeDiagnostic, schemaVersion: null, filesystem, fault: null };
    }
    const fault = api.storeFault(store);
    if (fault !== undefined) return { state: 'unavailable', diagnostic: fault.action, schemaVersion: store.schemaVersion, filesystem, fault: fault.code };
    const refused = api.automationRefusedGuard(store);
    if (refused !== undefined) {
      return { state: 'unavailable', diagnostic: 'A store migration failed; owned automation is stopped. Run `jevris store migrate --dry-run` and `jevris doctor`.', schemaVersion: store.schemaVersion, filesystem, fault: refused.reason };
    }
    return { state: 'ok', diagnostic: null, schemaVersion: store.schemaVersion, filesystem, fault: null };
  }

  function engineReady(): boolean {
    return engineField(engine, 'providerConfigured') === true;
  }

  async function health(): Promise<HealthBody> {
    const now = Date.now();
    const budgets = service?.budgets ?? effectiveLimits(undefined, process.env).budgets;
    return {
      pid: process.pid,
      version: jevrisPackage().version,
      build: loadedRuntimeBuild()?.id ?? null,
      verificationRuns: activeVerificationRuns(),
      protocol: PROTOCOL,
      bootId: service?.bootId ?? '',
      endpoint: service?.endpoint ?? '',
      startedAtMs: service?.startedAtMs ?? now,
      uptimeMs: service === undefined ? 0 : now - service.startedAtMs,
      connections: service?.connections() ?? 0,
      inFlight: service?.inFlight() ?? 0,
      budgetMs: { hot: budgets.hot, background: budgets.background, answer: budgets.answer },
      budgetScale: budgets.scale,
      workspaces: registry.size,
      store: storeHealth(),
      killSwitch: (await readKillSwitch(home)) ? 'stopped' : 'clear',
      engine: engineReady() ? 'ready' : 'rules-only',
      opSources: loadedOps?.sources ?? [],
      maintenance,
      locality: { kind: locality.kind, id: locality.id, container: locality.container, ssh: locality.ssh, signals: locality.signals, runtimeDir: input.paths.runtime, dataDir: input.paths.data },
    };
  }

  function builtins(loaded: LoadedOps, requestShutdown: () => void): SidecarOpDefinition[] {
    const defs: SidecarOpDefinition[] = [
      {
        op: 'ping',
        scope: 'status',
        budget: 'hot',
        workspace: 'optional',
        handle: () => ok({ pong: true, version: jevrisPackage().version, protocol: PROTOCOL }),
      },
      {
        op: 'health',
        scope: 'status',
        budget: 'hot',
        workspace: 'optional',
        handle: async () => ok(await health()),
      },
      {
        op: 'status',
        scope: 'status',
        budget: 'hot',
        workspace: 'optional',
        handle: async (ctx) => ok(await statusBody(ctx)),
      },
      {
        // P8: the persisted daily latency and deadline counters (E shows them in status).
        op: 'latency.counters',
        scope: 'status',
        budget: 'background',
        workspace: 'optional',
        handle: (ctx) => {
          if (store === undefined || api === undefined) return refuse('STORE_UNAVAILABLE', 'The Jevris store is not open; run `jevris sidecar status` for the reason.');
          latency.flush();
          const days = bodyRecord(ctx)['days'];
          const window = typeof days === 'number' && Number.isSafeInteger(days) && days >= 1 && days <= 90 ? days : 7;
          const nowMs = Date.now();
          const sinceMs = Math.floor(nowMs / 86_400_000) * 86_400_000 - (window - 1) * 86_400_000;
          return ok({ days: window, sinceMs, targetMs: SEMANTIC_TARGET_MS, counters: api.latencyCounters(store, { sinceMs }) });
        },
      },
      {
        op: 'shutdown',
        scope: 'admin',
        budget: 'hot',
        workspace: 'optional',
        handle: () => {
          setTimeout(requestShutdown, 20).unref();
          return ok({ stopping: true });
        },
      },
      {
        op: 'workspace.register',
        scope: 'status',
        budget: 'hot',
        handle: (ctx) => ok({ id: ctx.workspace.id, root: ctx.workspace.root }),
      },
      {
        op: 'workspace.list',
        scope: 'status',
        budget: 'hot',
        workspace: 'optional',
        handle: () => ok({ workspaces: workspaces.list() }),
      },
      {
        op: 'kill-switch.status',
        scope: 'status',
        budget: 'hot',
        workspace: 'optional',
        handle: (ctx) => ok({ killSwitch: ctx.killSwitchStopped ? 'stopped' : 'clear' }),
      },
      {
        op: 'store.health',
        scope: 'status',
        budget: 'hot',
        workspace: 'optional',
        handle: async () => ok((await health()).store),
      },
      {
        op: 'event',
        scope: 'advice',
        budget: 'hot',
        handle: (ctx) => handleEvent(ctx, loaded.subscribers),
      },
      {
        // OBS-02: the §17.5 decision counters from the store and the request counters since start.
        op: 'metrics',
        scope: 'status',
        budget: 'background',
        workspace: 'optional',
        handle: (ctx) => {
          const raw = bodyRecord(ctx)['sinceHours'];
          const hours = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= 24 * 90 ? raw : 24;
          const sinceMs = Date.now() - hours * 3_600_000;
          let decisions: unknown = null;
          if (store !== undefined && api !== undefined) {
            const counted = api.decisionCounters(store, { sinceMs, ...(ctx.workspace.id !== 'global' ? { workspaceId: ctx.workspace.id } : {}) });
            decisions = 'reason' in counted ? null : counted;
          }
          return ok({
            windowHours: hours,
            decisions,
            requests: telemetry.requestCounters(),
            traces: { dir: telemetry.traceDir, dropped: telemetry.dropped(), diagnostic: telemetry.diagnostic() },
          });
        },
      },
      {
        // OBS-02: the explicit, temporary diagnostic mode (CLI only; audited).
        op: 'diagnostic.set',
        scope: 'admin',
        budget: 'hot',
        workspace: 'optional',
        handle: (ctx) => {
          const raw = bodyRecord(ctx)['minutes'];
          if (raw !== undefined && (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > DIAGNOSTIC_MAX_MS / 60_000)) {
            return refuse('INVALID_DURATION', `Diagnostic mode lasts 1 to ${DIAGNOSTIC_MAX_MS / 60_000} minutes; 0 turns it off.`);
          }
          const minutes = raw === undefined ? DIAGNOSTIC_DEFAULT_MS / 60_000 : raw;
          const result = telemetry.setDiagnostic(minutes === 0 ? null : minutes * 60_000);
          if (minutes > 0 && !result.active) return refuse('DIAGNOSTIC_WRITE_FAILED', 'Diagnostic mode could not be recorded; check the state directory.');
          if (store !== undefined && api !== undefined) {
            const actor = bodyRecord(ctx)['actor'];
            const written = api.appendAudit(store, {
              kind: 'diagnostic.change',
              actor: typeof actor === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(actor) ? actor : 'cli',
              channel: 'cli',
              atMs: Date.now(),
              detail: { state: result.active ? 'on' : 'off', minutes: result.active ? minutes : 0 },
            });
            if (!written.ok) log({ level: 'warn', event: 'audit-refused', kind: 'diagnostic.change', reason: written.reason });
          }
          telemetry.trace({ event: 'diagnostic.change', reasonCode: result.active ? 'DIAGNOSTIC_ON' : 'DIAGNOSTIC_OFF' });
          statusLineSoon();
          return ok(result);
        },
      },
      ...adminOps({ home, paths, store: () => (store !== undefined && api !== undefined ? { store, api } : undefined) }),
      ...providerConsentOps({ store: () => (store !== undefined && api !== undefined ? { store, api } : undefined) }),
      ...accessLimitsOps({ store: () => (store !== undefined && api !== undefined ? { store, api } : undefined) }),
      ...jevReenableOps({ store: () => (store !== undefined && api !== undefined ? { store, api } : undefined), engine: () => engine }),
      routeTurnOp(),
      ...sessionLinkOps({ api: () => api, taskState }),
    ];
    return defs.filter((def) => BUILTIN_OP_NAMES.includes(def.op));
  }

  /**
   * The Jev decision budget for status (owner decision 2026-09-29): the month's spend against the
   * machine-wide limit, and against this workspace's own cap when it has one, with the reset date.
   * `exhausted` when either has no room left for this workspace's decisions.
   */
  async function budgetStatus(workspaceId: string): Promise<BudgetStatusView> {
    const budget = engineField(engine, 'budget');
    const snapshotFn = engineField(budget, 'snapshot');
    if (typeof snapshotFn !== 'function') return UNKNOWN_BUDGET_STATUS;
    try {
      const snap: unknown = await (snapshotFn as (workspaceId?: string) => Promise<unknown>).call(budget, workspaceId === 'global' ? undefined : workspaceId);
      const own = engineField(snap, 'workspace');
      return budgetStatusView(snap, own === null || own === undefined ? 'cap' : workspaceCapSource(workspaceId));
    } catch {
      return UNKNOWN_BUDGET_STATUS;
    }
  }

  /** Where this workspace's cap comes from, for status. */
  function workspaceCapSource(workspaceId: string): 'cap' | 'repository' | 'unreadable' {
    try {
      return workspaceJevBudget({ home, workspaceId, workspaceRoot: registry.get(workspaceId)?.root ?? null }).source ?? 'cap';
    } catch {
      return 'unreadable';
    }
  }

  function recentDecisions(workspaceId: string | undefined): unknown[] {
    if (store === undefined || api === undefined) return [];
    // K5: the newest five, newest first, without the record column.
    const rows = api.recentDecisionSummaries(store, { ...(workspaceId !== undefined ? { workspaceId } : {}), sinceMs: Date.now() - 7 * DAY_MS, limit: 5 });
    return rows.map((row) => ({
      decisionId: row.decisionId,
      outcome: OUTCOME.test(row.outcome) ? row.outcome : 'abstained',
      reasonCode: REASON.test(row.reasonCodes[0] ?? '') ? (row.reasonCodes[0] as string) : 'UNKNOWN',
      resolvedModel: row.model === 'rules' ? null : row.model,
      at: new Date(row.createdAtMs).toISOString(),
    }));
  }

  /**
   * RTE-10: the task slices route requests named that no released calibration covers, as C's
   * router recorded them in this process (UNKNOWN_SLICE abstentions). Empty when the provider
   * package does not report them.
   */
  async function unknownSlices(): Promise<string[]> {
    try {
      const provider: unknown = await import('@jevris/provider-typesafe');
      const read = provider !== null && typeof provider === 'object' ? Reflect.get(provider, 'unknownRouteSlices') : undefined;
      if (typeof read !== 'function') return [];
      const listed: unknown = read();
      if (!Array.isArray(listed)) return [];
      return listed.filter((slice): slice is string => typeof slice === 'string' && SLICE_ID.test(slice)).slice(-64);
    } catch {
      return [];
    }
  }

  /**
   * VER-05 on status: the workspace's last unverified stop report (D's statusStopReport reads the
   * stored row and the latest receipts only), and P6's reminder counts. Each is null for the
   * global workspace or on any failure.
   */
  function workspaceStatusOf(ctx: SidecarOpContext): { stopReport: unknown; reminders: unknown; activeWorkers: string[]; queuedTasks: number | null } {
    if (ctx.workspace.root === null || ctx.workspace.id === 'global') return { stopReport: null, reminders: null, activeWorkers: [], queuedTasks: null };
    let ws: ReturnType<typeof openWorkspace>;
    try {
      ws = openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(WORKSPACE_ID.test(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
    } catch {
      return { stopReport: null, reminders: null, activeWorkers: [], queuedTasks: null };
    }
    // The workspace's owned workers at work: its tasks leased or running in D's ledger (the same
    // "active" as session.link's taskState), by task id, at most the contract's 64.
    let activeWorkers: string[] = [];
    try {
      activeWorkers = listTasks(ws, { states: ACTIVE_TASK_STATES })
        .map((task) => task.node.id)
        .filter((id) => STATUS_ID.test(id) && !containsSecret(id))
        .slice(0, ACTIVE_WORKERS_MAX);
    } catch {
      activeWorkers = [];
    }
    // JEV-0069: the tasks waiting for a lease or a prerequisite (what a worker's end hands a slot to). A task is never in
    // both lists: it moves from ready to leased in the same transaction that grants its lease.
    let queuedTasks: number | null = null;
    try {
      queuedTasks = listTasks(ws, { states: QUEUED_TASK_STATES }).length;
    } catch {
      queuedTasks = null;
    }
    let stopReport: unknown = null;
    try {
      stopReport = statusStopReport(ws) ?? null;
    } catch {
      stopReport = null;
    }
    // P6: the Stop reminders and what followed them (D's reminderSummary reads files only).
    let reminders: unknown = null;
    try {
      reminders = reminderSummary(ws.state, ws.workspaceId);
    } catch {
      reminders = null;
    }
    return { stopReport, reminders, activeWorkers, queuedTasks };
  }

  /**
   * W09: native sessions outside Jevris ownership, as an advisory estimate that no hard cap
   * covers. Harness hooks report no token usage, so the estimate stays null until one does.
   */
  function nativeSpendOf(workspaceId: string | undefined): unknown {
    if (store === undefined || api === undefined) return null;
    const sessions = api.countNativeSessions(store, { sinceMs: Date.now() - DAY_MS, ...(workspaceId !== undefined ? { workspaceId } : {}) });
    return typeof sessions === 'number' ? { sessions, estimateMicroUsd: null, coverage: 'advisory-estimate' } : null;
  }

  /** The Sonnet-first view for status (the registry's ladder and this workspace's slices); null when it cannot be read, which drops the field. */
  async function firstTryViewOf(ctx: SidecarOpContext, setting: 'auto' | 'baseline'): Promise<unknown> {
    try {
      return await firstTryStatusView({ home: ctx.home, ws: firstTryWorkspaceOf(ctx), setting });
    } catch {
      return null;
    }
  }

  async function statusBody(ctx: SidecarOpContext): Promise<unknown> {
    const current = await health();
    const storeState = current.store.state;
    const recent = recentDecisions(ctx.workspace.id === 'global' ? undefined : ctx.workspace.id);
    const budget = await budgetStatus(ctx.workspace.id);
    const degraded =
      storeState !== 'ok'
        ? current.store.diagnostic
        : current.engine === 'rules-only'
          ? (noCredentialAdvice ?? 'No Jev credential is configured; decisions run rules-only. Run `jevris credential set`.')
          : (circuitDisabledReason(engine) ?? budgetSpentReason(budget) ?? providerDownReason(recent, Date.now()));
    const workspaceView = workspaceStatusOf(ctx);
    const modelPin = statusModelPin(bodyRecord(ctx)['modelPin']);
    const settings = effectiveSettingsOf(ctx);
    const body = {
      // The effective mode for this workspace: D's resolver (your settings, the workspace's
      // lowering, the organization, host and managed ceilings), the one `jevris configure` shows.
      jevrisMode: settings?.config.mode ?? FAIL_CLOSED_MODE,
      killSwitch: ctx.killSwitchStopped ? 'stopped' : 'clear',
      decisionHealth: ctx.killSwitchStopped || !modeAllows(settings?.config.mode ?? FAIL_CLOSED_MODE, 'record') ? 'off' : degraded === null ? 'healthy' : 'degraded',
      degradedReason: ctx.killSwitchStopped ? 'The kill switch is stopped. Run `jevris kill-switch status`.' : degraded,
      // The model the person pinned in the harness (Jevris never changes it). The sidecar cannot
      // read the session's environment, so the client names it (the CLI sends its ANTHROPIC_MODEL).
      routing: { modelPin, pinned: modelPin !== null },
      activeWorkers: workspaceView.activeWorkers,
      budget,
      recentDecisions: recent,
      unknownSlices: await unknownSlices(),
      store: { state: storeState, diagnostic: current.store.diagnostic },
      stopReport: workspaceView.stopReport,
      nativeSpend: nativeSpendOf(ctx.workspace.id === 'global' ? undefined : ctx.workspace.id),
    };
    // Fields the surface contract may not carry yet (P6 reminders, P4 queue depth): each is
    // added only when the contract accepts it.
    const mainSessions = await mainSessionsOf(ctx);
    const limits = await accessLimitsOf();
    const optional: readonly (readonly [string, unknown])[] = [
      // Which layer set the mode, and any problem with the layers that narrow it.
      ['modeSource', settings?.modeSource ?? 'defaults'],
      ['settingsIssues', layerIssues(settings?.issues ?? []).slice(0, 16).map((issue) => ({ path: issue.path.slice(0, 256), code: issue.code.slice(0, 64) }))],
      // The 1.2 upgrade's one-time mode notice, while it applies.
      ['modeNotice', modeNoticeFor(ctx.home)],
      ['reminders', workspaceView.reminders],
      // Owner decision 2026-09-30: whether a main-session Stop queues the missing approved checks.
      ['backgroundVerifyAtStop', settings === undefined ? 'off' : backgroundAtStopOf(settings.config)],
      // Owner decision 2026-09-30 (Sonnet-first routing): whether a low-risk owned task starts on a cheaper first-try model.
      ['firstTryRouting', settings === undefined ? 'auto' : firstTryOf(settings.config)],
      // Sonnet-first routing where people look: per harness the first-try and baseline models and the slices on each.
      ['firstTry', await firstTryViewOf(ctx, settings === undefined ? 'auto' : firstTryOf(settings.config))],
      // Owner decision 2026-10-01 (Jev as an active decision aid): whether Jev classifies a route request's task slice.
      ['jevAssist', settings === undefined ? 'classify' : jevAssistOf(settings.config)],
      ['queue', queueStatus()],
      // JEV-0069: the queued owned tasks, so a client can tell the queue is idle (0 here and no active worker).
      ['queuedTasks', workspaceView.queuedTasks],
      // Owner 9d6a66d: whether an administrator's registry override is active, or refused (then
      // routing is unavailable, with this reason code).
      ['modelRegistry', modelRegistryStatus()],
      // Owner 29423b6: the sessions linked to a task here (only these may be switched per turn).
      ['sessionLinks', sessionLinksOf(ctx)],
      // OD-8 (E f9a92f2, D 0b1fb09): each harness's main-session mode and whether its turns can be switched.
      // R54: the views without the host fields first, for a contract that does not carry them yet;
      // the next row replaces them with the full views when the contract accepts those.
      ['mainSessions', withoutHostFields(mainSessions)],
      ['mainSessions', mainSessions],
      // Access limits R79 (design section 11): the machine's access pauses in force.
      // The newKeyClears booleans (C2 d0ff6bf0, E's contract) replace the view when the contract
      // carries them; otherwise the view without them stays.
      ['accessLimits', withoutNewKeyClears(limits)],
      ['accessLimits', limits],
      ['jevCircuit', jevCircuitOf(engine)],
      // OP-6 (E e4bc1fdf, C2 dc4808b5): the last Codex usage reading per sign-in, bands only.
      ['accessUsage', await accessUsageOf()],
    ];
    // The body is the surface contract; a row that does not fit is dropped, never sent.
    const contract = surfacePayloadContract('status');
    const variants = [body, { ...body, stopReport: null, nativeSpend: null }, { ...body, stopReport: null, nativeSpend: null, recentDecisions: [] }];
    for (const variant of variants) {
      if (!contract.validate(variant).ok) continue;
      let candidate: Record<string, unknown> = variant;
      for (const [name, value] of optional) {
        const next = { ...candidate, [name]: value };
        if (contract.validate(next).ok) candidate = next;
      }
      return candidate;
    }
    return variants[variants.length - 1];
  }

  /**
   * Access limits R79 (design section 11; C2's record, 07683697): the machine's access pauses in
   * force for status, the machine-wide record read once. `active` counts them all; `entries` lists
   * at most ACCESS_LIMITS_STATUS_MAX, in the record's order (untimed first, then the soonest to
   * lift). Ids, classes and times only: the record holds no text, and the fingerprint is never
   * shown. Null when the read throws (an unreadable file is `readable: false`).
   */
  async function accessLimitsOf(): Promise<AccessLimitsView | null> {
    try {
      const nowMs = Date.now();
      const record = await readAccessLimits(home);
      // A defined order, so the view is stable: untimed pauses first, then the soonest to lift,
      // then the key (two pauses recorded together lift at the same instant).
      const active = record.entries
        .filter((e) => e.untilMs === null || e.untilMs > nowMs)
        .sort((a, b) => (a.untilMs === null ? -Infinity : a.untilMs) - (b.untilMs === null ? -Infinity : b.untilMs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const iso = (ms: number): string => new Date(ms).toISOString();
      return {
        readable: record.readable,
        full: record.full,
        active: active.length,
        entries: active.slice(0, ACCESS_LIMITS_STATUS_MAX).map((e) => ({
          key: e.key,
          class: e.class,
          weekly: e.weekly,
          scope: e.scope,
          until: e.untilMs === null ? null : iso(e.untilMs),
          resetBasis: e.resetBasis,
          source: e.source,
          since: iso(e.firstSeenMs),
          // Whether a new API key clears it: a boolean only, never the fingerprint.
          newKeyClears: accessNewKeyClears(e),
        })),
      };
    } catch {
      return null;
    }
  }

  /**
   * OP-6 (owner decision 9deb30c8; C2's core dc4808b5, E's contract e4bc1fdf): the last usage
   * reading per harness and sign-in for status, read-only from core's kept readings (none older
   * than 7 days, newest first). Each window's band, weekly flag and reset, and whether usage was
   * allowed; never a percentage, the payload, text or whether the read was certified. Only the
   * harnesses the status contract names are shown, at most its reading and window caps, so a later
   * core harness never fails status. Null when the read throws (an unreadable file is
   * `readable: false`).
   */
  async function accessUsageOf(): Promise<unknown> {
    try {
      const read = await readAccessUsageReadings(home, Date.now());
      const harnesses: readonly string[] = ACCESS_USAGE_STATUS_HARNESSES;
      const iso = (ms: number): string => new Date(ms).toISOString();
      return {
        readable: read.readable,
        readings: read.readings
          .filter((r) => harnesses.includes(r.harness))
          .slice(0, ACCESS_USAGE_STATUS_MAX_READINGS)
          .map((r) => ({
            harness: r.harness,
            authMode: r.authMode,
            readAt: iso(r.readAtMs),
            allowed: r.allowed,
            windows: r.windows.slice(0, ACCESS_USAGE_STATUS_MAX_WINDOWS).map((w) => ({ weekly: w.weekly, band: w.band, resetsAt: w.resetAtMs === null ? null : iso(w.resetAtMs) })),
          })),
      };
    } catch {
      return null;
    }
  }

  /**
   * The workspace's live session links for status, or null (the global workspace, no store, a
   * refusal). Its own links come first; then the links of its in-use owned-worker worktrees (D's
   * ownedWorktreeWorkspaces: realpath inside this workspace's worktree folder, a task of this
   * workspace), each marked `worker: true`. A worker worktree is its own workspace to the sidecar,
   * so its `via: 'plan'` link is written there. Only a link for that worktree's own task and a
   * turn harness is shown; nothing else from that view is sent. 16 in total; a refused or
   * unreadable worktree is skipped and never fails status.
   */
  function sessionLinksOf(ctx: SidecarOpContext): unknown {
    if (ctx.workspace.id === 'global' || api === undefined) return null;
    const view = storeFor(ctx.workspace) as OpenedStore | undefined;
    if (view === undefined) return null;
    const out: Record<string, unknown>[] = [];
    try {
      const links = api.listSessionLinks(view);
      if (!Array.isArray(links)) return null;
      for (const l of links) out.push({ harness: l.harness, sessionId: l.sessionId, taskId: l.taskId, linkedAtMs: l.linkedAtMs, via: l.via });
    } catch {
      return null;
    }
    if (ctx.workspace.root === null || out.length >= SESSION_LINKS_MAX) return out.slice(0, SESSION_LINKS_MAX);
    const held = store;
    if (held === undefined) return out;
    let workers: readonly { readonly taskId: string; readonly workspaceId: string }[] = [];
    try {
      if (input.ownedWorktrees !== undefined) workers = input.ownedWorktrees(ctx);
      else {
        const ws = openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(WORKSPACE_ID.test(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
        workers = ownedWorktreeWorkspaces(ws);
      }
    } catch {
      workers = [];
    }
    if (!Array.isArray(workers)) workers = [];
    for (const worker of workers.slice(0, SESSION_LINKS_MAX)) {
      if (out.length >= SESSION_LINKS_MAX) break;
      if (worker.workspaceId === ctx.workspace.id || !WORKSPACE_ID.test(worker.workspaceId)) continue;
      try {
        const workerView = api.workspaceView(held, worker.workspaceId);
        if (workerView === undefined) continue;
        const links = api.listSessionLinks(workerView);
        if (!Array.isArray(links)) continue;
        for (const l of links) {
          if (out.length >= SESSION_LINKS_MAX) break;
          if (l.taskId !== worker.taskId || !isTurnHarness(l.harness)) continue;
          out.push({ harness: l.harness, sessionId: l.sessionId, taskId: l.taskId, linkedAtMs: l.linkedAtMs, via: l.via, worker: true });
        }
      } catch {
        // this worktree is skipped
      }
    }
    return out;
  }

  /**
   * OD-8: one view per harness (HARNESS_IDS order) from D's mainSessionView: the effective
   * `routing.mainSession`, the harness's session.route certification for its recorded version
   * (false when no version is recorded), and the kill switch. Null when nothing can be read.
   */
  async function mainSessionsOf(ctx: SidecarOpContext): Promise<unknown> {
    try {
      const configured: unknown = effectiveConfigOf(ctx)?.routing.mainSession;
      const registry = await loadModelRegistry({ home: ctx.home }).catch(() => null);
      const views = [];
      for (const harness of HARNESS_IDS) {
        let version: string | null = null;
        try {
          version = harnessVersionOf(ctx.home, harness);
        } catch {
          version = null;
        }
        const certified = version !== null && isTurnHarness(harness) ? await turnCertified(harness, version) : false;
        views.push({ harness, ...mainSessionView(configured, harness, { certified, killSwitchStopped: ctx.killSwitchStopped }), ...sessionHostView(ctx, registry, harness) });
      }
      return views;
    } catch {
      return null;
    }
  }

  /** The main-session views without R54's host fields (a status contract that predates them). */
  function withoutHostFields(views: unknown): unknown {
    if (!Array.isArray(views)) return views;
    return views.map((v: unknown) => {
      if (v === null || typeof v !== 'object') return v;
      const { sessionHost: _host, tariff: _tariff, ...rest } = v as Record<string, unknown>;
      return rest;
    });
  }

  /** A main session counts for status while it was seen within this window (session.link's rule). */
  const SESSION_HOST_WINDOW_MS = 10 * 60_000;

  /**
   * Serving hosts R54 (design 8): the host the harness's newest active main session in this
   * workspace runs through, and whether the router knows the model's tariff there (R48). An
   * actuator never acts on an estimate, so `tariff: 'unknown'` means advice only. The session's
   * model is re-read through today's registry: a recorded spelling is evidence, not authority.
   * Both fields are null when no such session was seen in the last 10 minutes, its model is not
   * recorded or does not resolve, or the registry is refused (routing is then unavailable).
   */
  function sessionHostView(ctx: SidecarOpContext, registry: Awaited<ReturnType<typeof loadModelRegistry>>, harness: (typeof HARNESS_IDS)[number]): { readonly sessionHost: { readonly id: string; readonly kind: 'maker' | 'gateway' | 'inference-host' } | null; readonly tariff: 'known' | 'unknown' | null } {
    const none = { sessionHost: null, tariff: null } as const;
    try {
      const view = ctx.workspace.root === null ? undefined : (storeFor(ctx.workspace) as OpenedStore | undefined);
      if (registry === null || view === undefined || api === undefined) return none;
      const active = api.listActiveSessions(view, { harness, sinceMs: Date.now() - SESSION_HOST_WINDOW_MS, limit: 1 });
      const newest = Array.isArray(active) ? active[0] : undefined;
      const row = newest === undefined ? undefined : api.getSession(view, newest.sessionId);
      const model = row?.actualModel ?? row?.requestedModel ?? null;
      const resolved = sessionHost(registry, harness, model);
      if (resolved === null) return none;
      const kind = resolved.via === 'maker' ? 'maker' : (servingHostOf(resolved.servingHost)?.kind ?? null);
      if (kind === null) return none;
      return { sessionHost: { id: resolved.servingHost, kind }, tariff: servingTariffKnown(registry, resolved.servingHost, resolved.provider, resolved.modelId) ? 'known' : 'unknown' };
    } catch {
      return none;
    }
  }

  /** P4: admission and background executor depth, counts only (status). */
  const modelRegistryStatus = modelRegistryStatusReader(home);

  function queueStatus(): QueueStatus {
    const counts = admission.counts();
    const depth: ExecutorDepth = executor.depth();
    return { hotInFlight: counts.hot + counts.answer, backgroundInFlight: counts.background, overrun: counts.overrun, running: depth.running, held: depth.held, queued: depth.queued, spooled: depth.spooled };
  }

  const eventClock = input.eventClock ?? (() => Date.now());
  const locality = input.locality ?? detectLocality();
  /** Insertion order is time order: a key seen again is deleted and set anew. */
  const seenDeliveries = new Map<string, number>();
  /** The answer replay: each first delivery's answer, for a retry inside the dedup window. */
  const eventReplay = createEventReplay({ windowMs: EVENT_DEDUP_WINDOW_MS, clock: eventClock });

  /**
   * The first delivery's answer for a retry (rules 1 to 3; event-replay.ts): the answer it
   * delivered in time; else, while it is in flight, the answer it delivers within this retry's
   * own deadline less a margin; else null (the duplicate answer). 'mismatch' for a retry whose
   * body differs from the first under the same key. With the kill switch stopped, nothing is
   * replayed.
   */
  async function replayFor(ctx: SidecarOpContext, deliveryKey: string, bodyHash: string): Promise<Record<string, unknown> | 'mismatch' | null> {
    const found = eventReplay.lookup(ctx.workspace.id, deliveryKey, bodyHash);
    if (found.state === 'body-mismatch') return 'mismatch';
    if (ctx.killSwitchStopped) return null;
    if (found.state === 'delivered') return found.answer;
    if (found.state !== 'pending') return null;
    const waitMs = ctx.deadline.remainingMs() - EVENT_REPLAY_WAIT_MARGIN_MS;
    if (waitMs <= 0) return null;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
      timer.unref();
    });
    const aborted = new Promise<null>((resolve) => {
      if (ctx.signal.aborted) resolve(null);
      else ctx.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    try {
      return await Promise.race([found.settled, timedOut, aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Appends to the store's event table, or dedupes in memory without a store. Either way a
   * repeated delivery key is a duplicate only inside EVENT_DEDUP_WINDOW_MS; the in-memory
   * records expire with the window and are capped at EVENT_DEDUP_RECORDS_MAX.
   */
  function recordEvent(ctx: SidecarOpContext, deliveryKey: string, text: string, kind: string, sessionId: string | null): 'recorded' | 'duplicate' | 'refused' {
    const nowMs = eventClock();
    const view = storeFor(ctx.workspace) as OpenedStore | undefined;
    if (view !== undefined && api !== undefined) {
      const appended = api.appendEvent(
        view,
        {
          deliveryKey,
          sessionId,
          nativeKind: kind,
          payloadHash: sha(text),
          payloadBytes: Buffer.byteLength(text, 'utf8'),
          receivedAtMs: nowMs,
        },
        { dedupWindowMs: EVENT_DEDUP_WINDOW_MS },
      );
      if (appended.ok) return appended.duplicate ? 'duplicate' : 'recorded';
      log({ level: 'warn', event: 'event-append-refused', reason: appended.reason });
      if (appended.reason === 'oversize' || appended.reason === 'invalid-input') return 'refused';
    }
    for (const [key, atMs] of seenDeliveries) {
      if (nowMs >= atMs && nowMs - atMs < EVENT_DEDUP_WINDOW_MS) break;
      seenDeliveries.delete(key);
    }
    const dedupe = `${ctx.workspace.id}\0${deliveryKey}`;
    const prior = seenDeliveries.get(dedupe);
    if (prior !== undefined && nowMs >= prior && nowMs - prior < EVENT_DEDUP_WINDOW_MS) return 'duplicate';
    seenDeliveries.delete(dedupe);
    seenDeliveries.set(dedupe, nowMs);
    while (seenDeliveries.size > EVENT_DEDUP_RECORDS_MAX) {
      const first = seenDeliveries.keys().next();
      if (first.done === true) break;
      seenDeliveries.delete(first.value);
    }
    return 'recorded';
  }

  /**
   * Upserts the harness session an event names (US12): harness, version, and the requested and
   * actual models where the normalized event carries them. The store keeps known values when a
   * later event omits them (COALESCE), so an event without a model never erases one.
   */
  function recordSessionFor(ctx: SidecarOpContext, session: EventSession): void {
    const view = storeFor(ctx.workspace) as OpenedStore | undefined;
    if (view === undefined || api === undefined) return;
    const written = api.recordSession(view, {
      sessionId: session.sessionId,
      harness: session.harness,
      harnessVersion: session.harnessVersion,
      requestedModel: session.requestedModel,
      actualModel: session.actualModel,
      state: session.state,
      atMs: Date.now(),
      source: session.source,
    });
    if (!written.ok) log({ level: 'warn', event: 'session-record-refused', reason: written.reason });
  }

  /** OD-8: the forms of the task id, risk and turn reason code passed with an approved scope. */
  const SCOPE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const SCOPE_RISK = /^[a-z][a-z-]{0,31}$/;
  const SCOPE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

  /**
   * OD-8 (D 45692ae): whether a Kilo or OpenCode harness version passes its session.route certify
   * case. D's turnRouteCertified reads the certification records, so each answer is kept for
   * TURN_CERT_TTL_MS and one read runs at a time per harness and version. Anything unknown or
   * failed reads as not certified (advise).
   */
  const TURN_CERT_TTL_MS = 1000;

  function isTurnHarness(harness: string): boolean {
    return (TURN_HARNESSES as readonly string[]).includes(harness);
  }

  /**
   * One cached certification answer per harness and version: kept for TURN_CERT_TTL_MS, one read at
   * a time. `get` is awaited by the event path; `now` answers without waiting and starts a refresh
   * when stale. Anything unknown, failed or thrown reads as false.
   */
  function certificationCache(check: (harness: string, version: string | null) => Promise<boolean>): {
    readonly get: (harness: string, version: string | null) => Promise<boolean>;
    readonly now: (harness: string, version: string | null) => boolean;
  } {
    const answers = new Map<string, { value: boolean; atMs: number; pending: Promise<boolean> | undefined }>();
    const get = (harness: string, version: string | null): Promise<boolean> => {
      if (!isTurnHarness(harness)) return Promise.resolve(false);
      const key = `${harness}\u0000${version ?? ''}`;
      const hit = answers.get(key);
      if (hit !== undefined && Date.now() - hit.atMs <= TURN_CERT_TTL_MS) return Promise.resolve(hit.value);
      if (hit?.pending !== undefined) return hit.pending;
      let pending: Promise<boolean>;
      try {
        pending = check(harness, version);
      } catch {
        pending = Promise.resolve(false);
      }
      pending = pending
        .then((value) => value === true)
        .catch(() => false)
        .then((value) => {
          answers.set(key, { value, atMs: Date.now(), pending: undefined });
          return value;
        });
      answers.set(key, { value: hit?.value ?? false, atMs: hit?.atMs ?? 0, pending });
      return pending;
    };
    const now = (harness: string, version: string | null): boolean => {
      if (!isTurnHarness(harness)) return false;
      const hit = answers.get(`${harness}\u0000${version ?? ''}`);
      if (hit === undefined || Date.now() - hit.atMs > TURN_CERT_TTL_MS) void get(harness, version);
      return hit?.value ?? false;
    };
    return { get, now };
  }

  const turnCerts = certificationCache((harness, version) => turnRouteCertified({ home, harness, nowMs: Date.now(), harnessVersion: version }));
  /** The current session.route answer, reading it again when older than the ttl (awaited by the event path). */
  const turnCertified = turnCerts.get;
  /** The last known session.route answer without waiting (a subscriber run after the answer). */
  const turnCertifiedNow = turnCerts.now;

  /**
   * Serving hosts R50: whether the harness version passes F's route.host certify case, cached the
   * same way. C's route.turn and subagent routes read it as `hostRoutes` for spellTarget.
   */
  const hostCheck = input.hostRouteCertified ?? routeHostCertified;
  const hostCerts = certificationCache((harness, version) => hostCheck({ home, harness, nowMs: Date.now(), harnessVersion: version }));

  /**
   * The task, its risk and the turn gate as they ride with a scope for C's route.turn. Anything
   * that is not a plain id, a short risk token or a reason code is dropped, and anything but a
   * clean `bounded-auto` is advise. OD-8 switches a main-session turn only: a child session is
   * never one, whatever the task's gate says (B's routing review).
   */
  function gatedScope(found: object, childSession: boolean): { readonly taskId?: string; readonly risk?: string; readonly turnActuation: 'bounded-auto' | 'advise'; readonly turnReasonCode: string | null } {
    const taskId: unknown = Reflect.get(found, 'taskId');
    const risk: unknown = Reflect.get(found, 'risk');
    const actuation: unknown = Reflect.get(found, 'turnActuation');
    const reason: unknown = Reflect.get(found, 'turnReasonCode');
    const reasonCode = typeof reason === 'string' && SCOPE_REASON.test(reason) ? reason : null;
    const bounded = !childSession && actuation === 'bounded-auto' && reason === null;
    return {
      ...(typeof taskId === 'string' && SCOPE_TASK_ID.test(taskId) ? { taskId } : {}),
      ...(typeof risk === 'string' && SCOPE_RISK.test(risk) ? { risk } : {}),
      turnActuation: bounded ? 'bounded-auto' : 'advise',
      turnReasonCode: bounded ? null : childSession ? 'CHILD_SESSION' : (reasonCode ?? 'TURN_GATE_UNREADABLE'),
    };
  }

  /** session.link (owner 29423b6): a task in D's ledger is active when it is leased or running. */
  function taskState(ctx: SidecarOpContext, taskId: string): 'active' | 'inactive' | 'unknown' {
    if (ctx.workspace.root === null) return 'unknown';
    try {
      const ws = openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(WORKSPACE_ID.test(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
      if (getTask(ws, taskId) === undefined) return 'unknown';
      return listTasks(ws, { states: ACTIVE_TASK_STATES }).some((task) => task.node.id === taskId) ? 'active' : 'inactive';
    } catch {
      return 'unknown';
    }
  }

  type MainSessionModeValue = (typeof MAIN_SESSION_MODES)[number];
  interface TurnContextAnswer {
    readonly scope: { readonly taskId?: string; readonly risk?: string; readonly sliceId?: string; readonly turnActuation: 'bounded-auto' | 'advise'; readonly turnReasonCode: string | null } | null;
    readonly mainSession: MainSessionModeValue | null;
    /** Serving hosts R50: the harness's route.host certification for the recorded session's version; false otherwise. */
    readonly hostRouteCertified: boolean;
  }

  /**
   * OD-8: what C's route.turn needs about a turn that the plugin must not assert, worked out from
   * the sidecar's own state only (B's routing review):
   * - the effective `routing.mainSession` (null when the config cannot be read: advice only);
   * - the approved scope, only for a session the sidecar recorded from the same harness's own
   *   events and that has not ended. A child session's events carry its parent's id, so a child
   *   id is never recorded and reads as UNKNOWN_SESSION. The harness version for the session.route
   *   certification is the recorded one, never the request's;
   * - the slice from the task, never from the request;
   * - `hostRouteCertified` (R50): the route.host certification for the recorded session's harness
   *   version, false for an unknown or ended session or any failure.
   * Never throws: any failure is advice only.
   */
  async function turnContextFor(ctx: SidecarOpContext, sessionId: string, harness: string): Promise<TurnContextAnswer> {
    if (ctx.workspace.root === null) return { scope: null, mainSession: null, hostRouteCertified: false };
    let ws: ReturnType<typeof openWorkspace>;
    try {
      ws = openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(WORKSPACE_ID.test(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
    } catch {
      return { scope: null, mainSession: null, hostRouteCertified: false };
    }
    const configuredMain: unknown = effectiveConfigOf(ctx)?.routing.mainSession;
    const mainSession: MainSessionModeValue | null = (MAIN_SESSION_MODES as readonly unknown[]).includes(configuredMain) ? (configuredMain as MainSessionModeValue) : null;
    let hostRouteCertified = false;
    const advise = (turnReasonCode: string): TurnContextAnswer => ({ scope: { turnActuation: 'advise', turnReasonCode }, mainSession, hostRouteCertified });
    try {
      const view = storeFor(ctx.workspace) as OpenedStore | undefined;
      const row = view === undefined || api === undefined ? undefined : api.getSession(view, sessionId);
      if (row === undefined || row.harness !== harness) return advise('UNKNOWN_SESSION');
      if (row.state === 'ended') return advise('SESSION_ENDED');
      const [certified, hostCertified] = await Promise.all([turnCertified(harness, row.harnessVersion), hostCerts.get(harness, row.harnessVersion)]);
      hostRouteCertified = hostCertified;
      const found = approvedScopeFor(ws, sessionId, { harness, killSwitchStopped: ctx.killSwitchStopped, turnCertified: certified });
      if (found === null) return { scope: null, mainSession, hostRouteCertified };
      const gated = gatedScope(found, false);
      const slice = gated.taskId === undefined ? undefined : getTask(ws, gated.taskId)?.sliceId;
      return { scope: { ...gated, ...(typeof slice === 'string' && SCOPE_TASK_ID.test(slice) ? { sliceId: slice } : {}) }, mainSession, hostRouteCertified };
    } catch {
      hostRouteCertified = false;
      return advise('TURN_GATE_UNREADABLE');
    }
  }

  /**
   * C's `route.turn` op (ec42279), registered with the sidecar's turn context. The provider package
   * loads on the first call, so a sidecar that never serves a turn never imports it.
   */
  function routeTurnOp(): SidecarOpDefinition {
    let definition: Promise<SidecarOpDefinition | undefined> | undefined;
    return {
      op: 'route.turn',
      scope: 'advice',
      budget: 'hot',
      async handle(ctx) {
        // Owner decision 0eb319de: in off and observe a turn gets no switch and no advice text.
        const mode = effectiveModeFor(ctx.home, ctx.workspace.root);
        if (!modeAllows(mode, 'show-advice')) return refuse('MODE_DOES_NOT_ADVISE', `Jevris is in ${mode} mode; the turn keeps its model and nothing is shown.`);
        definition ??= import('@jevris/provider-typesafe')
          .then((provider) => provider.createRouteTurnOp((opCtx, sessionId, harness) => turnContextFor(opCtx, sessionId, harness)))
          .catch(() => undefined);
        const loaded = await definition;
        if (loaded === undefined) return refuse('ROUTE_UNAVAILABLE', 'The routing package could not be loaded; the turn is not switched.');
        return loaded.handle(ctx);
      },
    };
  }

  /**
   * INT-05: a body that carries `scope` gets `scope.approvedScope` from the plan (D's
   * approvedScopeFor: the task's write scopes, no effects), replacing anything the harness
   * sent; with no approved scope it is removed. The approved scope never comes from a hook.
   * JEV-0060: so does a proposed tool call (`tool.proposed`, a PreToolUse) that carries an `effect`.
   * The adapters send a written path as `scope` only after a write has finished, never on the
   * proposal, yet the permission triage reads `scope.approvedScope` on the proposal (to flag a
   * write outside the task's paths and to hold the effect classes for the scope-change advice at
   * the next diff boundary). With no approved scope such a body is left as it came.
   * Every body also gets the sidecar's `hostRouteCertified` (serving hosts R50).
   */
  function withApprovedScope(ctx: SidecarOpContext, sessionId: string | null): SidecarOpContext {
    const { repair: _claimedRepair, ...claimed } = bodyRecord(ctx);
    // R50: `hostRouteCertified` is the sidecar's own route.host answer for the event's harness and
    // version (the cached one; the event path waits for it on a worker event). A hook's claim is
    // replaced, so a subagent route never reads the plugin's word for it.
    const eventSession = sessionOf(claimed['envelope'] ?? ctx.body, claimed);
    // A failure event also gets the repair-attempt bound from the effective config
    // (`orchestration.maxRepairAttempts`), replacing anything the hook sent: repeated-failure advice
    // says the attempts are used up by this number. Read only for a failure, never for other events.
    let repair: { readonly maxAttempts: number } | undefined;
    if (plainRecord(claimed['failure']) !== undefined) {
      try {
        repair = { maxAttempts: readEffectiveConfig({ home: ctx.home, workspaceRoot: ctx.workspace.root }).config.orchestration.maxRepairAttempts };
      } catch {
        repair = undefined;
      }
    }
    const body: Record<string, unknown> = { ...claimed, hostRouteCertified: eventSession === undefined ? false : hostCerts.now(eventSession.harness, eventSession.harnessVersion), ...(repair === undefined ? {} : { repair }) };
    ctx = { ...ctx, body };
    const claimedScope = plainRecord(body['scope']);
    const proposedCall = claimedScope === undefined && plainRecord(claimed['envelope'])?.['kind'] === 'tool.proposed' && plainRecord(body['effect']) !== undefined;
    if (claimedScope === undefined && !proposedCall) return ctx;
    let approved: {
      readonly paths: readonly string[];
      readonly effects: readonly string[];
      readonly taskId?: string;
      readonly risk?: string;
      readonly turnActuation: 'bounded-auto' | 'advise';
      readonly turnReasonCode: string | null;
    } | null = null;
    if (ctx.workspace.root !== null) {
      try {
        const ws = openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(WORKSPACE_ID.test(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
        // OD-8 (D 45692ae): the gate for switching a Kilo or OpenCode main-session turn needs the
        // event's harness, the kill switch and the harness's session.route certification.
        const session = eventSession;
        const found = approvedScopeFor(ws, sessionId, {
          harness: session?.harness ?? null,
          killSwitchStopped: ctx.killSwitchStopped,
          turnCertified: session === undefined ? false : turnCertifiedNow(session.harness, session.harnessVersion),
        });
        approved = found === null ? null : { paths: [...found.paths], effects: [...found.effects], ...gatedScope(found, session?.source === 'subagent') };
      } catch {
        approved = null;
      }
    }
    // A proposal that carried no scope and has no approved one stays without: no empty scope is invented.
    if (claimedScope === undefined && approved === null) return ctx;
    const { approvedScope: _claimed, ...rest } = claimedScope ?? {};
    const merged = approved === null ? rest : { ...rest, approvedScope: approved };
    return { ...ctx, body: { ...body, scope: merged } };
  }

  /** An unwanted answer: a subscriber run after the answer never commits a consuming effect. */
  const unwantedSignal = (): AbortSignal => {
    const gone = new AbortController();
    gone.abort();
    return gone.signal;
  };

  /**
   * The context a subscriber runs with after the answer: the event's workspace and body, a fresh
   * background deadline (so late work is not cut short by the hook's spent one), and an aborted
   * answer signal, so it never commits a consuming effect (a restore taken, a reminder spent).
   */
  function backgroundContext(workspace: SidecarWorkspace, body: unknown, sessionId: string | null): SidecarOpContext {
    const adherence = adviceAdherenceFor(workspace);
    const base: SidecarOpContext = {
      op: 'event',
      client: 'hook',
      scopes: SIDECAR_CLIENT_SCOPES.hook,
      workspace,
      body,
      home,
      signal: unwantedSignal(),
      deadline: createDeadline(sidecarBudgetsMs(process.env).background, monotonicClock),
      store: storeFor(workspace),
      killSwitchStopped: false,
      mode: effectiveModeFor(home, workspace.root),
      // A subscriber that runs after the answer asks Jev only when `jev.assist` allows it, as it would on the hot path.
      jevAssist: effectiveJevAssistFor(home, workspace.root),
      ...(adherence !== undefined ? { adviceAdherence: adherence } : {}),
      engine: sessionId === null ? engine : engineForSession(engine, sessionId),
      trace(event) {
        trace({ ...event, ws: workspace.id, op: 'event', client: 'hook' });
      },
    };
    return withApprovedScope(base, sessionId);
  }

  /** The event kinds that can fire C's worker-creation trigger (a subagent route reads `hostRouteCertified`). */
  const WORKER_EVENT_KINDS: ReadonlySet<string> = new Set(['worker.started', 'tool.proposed']);

  type NamedSubscriber = SidecarEventSubscriber & { readonly source: string };

  /** A subscriber's work for one event, run later by the executor; spoolable as JSON. */
  function subscriberJob(subscriber: NamedSubscriber, workspace: SidecarWorkspace, body: unknown, sessionId: string | null, key: string, bytes: number): BackgroundJob {
    return {
      key,
      label: subscriber.name,
      bytes,
      async run() {
        // GOV-04: a kill switch stopped since the event was recorded stops its late work too.
        if (await readKillSwitch(home)) {
          trace({ event: 'subscriber-skipped', ws: workspace.id, op: 'event', subscriber: subscriber.name, reasonCode: 'KILL_SWITCH' });
          return;
        }
        const ctx = backgroundContext(workspace, body, sessionId);
        const began = monotonicClock.now();
        let running: Promise<unknown>;
        try {
          running = Promise.resolve(subscriber.handle(ctx));
        } catch (error) {
          running = Promise.reject(error);
        }
        syncCostMs.set(subscriber.name, Math.max(0, monotonicClock.now() - began));
        try {
          await running;
          trace({ event: 'subscriber-finished', ws: workspace.id, op: 'event', subscriber: subscriber.name });
        } catch {
          trace({ event: 'subscriber-failed', ws: workspace.id, op: 'event', subscriber: subscriber.name, reasonCode: 'SUBSCRIBER_FAILED' });
        }
      },
      spool() {
        try {
          return JSON.stringify({ v: 1, ws: workspace, body, sessionId, subscriber: subscriber.name, key, bytes });
        } catch {
          return undefined;
        }
      },
    };
  }

  /** A spooled subscriber job back as a job, once the ops are loaded and its workspace is known. */
  function reviveSubscriberJob(text: string): BackgroundJob | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const record = plainRecord(parsed);
    if (record === undefined || record['v'] !== 1) return undefined;
    const name = record['subscriber'];
    const key = record['key'];
    const ws = plainRecord(record['ws']);
    const sessionId = record['sessionId'];
    const subscriber = loadedOps?.subscribers.find((candidate) => candidate.name === name);
    const wsId = ws?.['id'];
    const known = typeof wsId === 'string' ? (registry.get(wsId) ?? (wsId === 'global' ? { id: 'global', root: null } : undefined)) : undefined;
    if (subscriber === undefined || known === undefined || typeof key !== 'string' || (sessionId !== null && typeof sessionId !== 'string')) return undefined;
    return subscriberJob(subscriber, known, record['body'], sessionId, key, typeof record['bytes'] === 'number' ? record['bytes'] : 0);
  }

  async function handleEvent(
    ctx: SidecarOpContext,
    subscribers: readonly (SidecarEventSubscriber & { readonly source: string })[],
  ): Promise<ReturnType<typeof ok>> {
    const body = bodyRecord(ctx);
    const envelope = body['envelope'] ?? ctx.body;
    let text: string;
    try {
      text = JSON.stringify(envelope);
    } catch {
      return refuse('MALFORMED');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_EVENT_BYTES) return refuse('OVERSIZE_EVENT', 'The event is larger than 64 KiB and was not recorded.');
    // Owner decision 0eb319de: in off nothing is recorded and no subscriber runs.
    const mode = effectiveModeFor(ctx.home, ctx.workspace.root);
    if (!modeAllows(mode, 'record')) {
      ctx.trace({ event: 'event-skipped', reasonCode: 'MODE_OFF' });
      return ok({ recorded: false, duplicate: false, mode, results: {} });
    }
    const rawKey = body['deliveryKey'];
    const deliveryKey = typeof rawKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rawKey) ? rawKey : `k${sha(text).slice(0, 63)}`;
    const rawKind = envelope !== null && typeof envelope === 'object' ? Reflect.get(envelope, 'kind') : undefined;
    const kind = typeof rawKind === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.:/@+-]{0,127}$/.test(rawKind) ? rawKind : 'event';
    const session = sessionOf(envelope, body);
    const recorded = recordEvent(ctx, deliveryKey, text, kind, session?.sessionId ?? null);
    if (recorded === 'refused') return refuse('MALFORMED', 'The event was not recorded.');
    const eventTrace = { hookEvent: kind, deliveryKey, ...(session !== undefined ? { sessionId: session.sessionId } : {}) };
    const bodyHash = sha(text);
    if (recorded === 'duplicate') {
      ctx.trace({ event: 'event-duplicate', ...eventTrace });
      // The answer replay: no subscriber runs again, so no effect is repeated.
      const replayed = await replayFor(ctx, deliveryKey, bodyHash);
      if (replayed === 'mismatch') {
        ctx.trace({ event: 'event-replay-refused', ...eventTrace, reasonCode: 'DELIVERY_BODY_MISMATCH' });
        return refuse('DELIVERY_BODY_MISMATCH', 'A retry under this delivery key carried a different event, so the first answer was not replayed.');
      }
      if (replayed !== null) {
        ctx.trace({ event: 'event-replayed', ...eventTrace });
        return ok({ ...replayed, recorded: false, duplicate: true, replayed: true });
      }
      return ok({ recorded: false, duplicate: true, results: {} });
    }
    // Started before any await, so a retry arriving while this runs finds it in flight (rule 2).
    const settle = eventReplay.begin(ctx.workspace.id, deliveryKey, bodyHash);
    let answer: Record<string, unknown> | null = null;
    try {
      answer = await answerRecorded({ ...ctx, mode }, subscribers, { body, envelope, text, kind, session, deliveryKey, eventTrace });
    } finally {
      // Kept for a retry only when it goes out in time (rule 1); an aborted or failed one is not (rule 3).
      settle(answer !== null && !ctx.signal.aborted ? answer : null);
    }
    return ok(answer);
  }

  /** A recorded (first) delivery's answer: the subscribers' results, as `event` answers them. */
  async function answerRecorded(
    ctx: SidecarOpContext,
    subscribers: readonly (SidecarEventSubscriber & { readonly source: string })[],
    event: {
      readonly body: Record<string, unknown>;
      readonly envelope: unknown;
      readonly text: string;
      readonly kind: string;
      readonly session: ReturnType<typeof sessionOf>;
      readonly deliveryKey: string;
      readonly eventTrace: { readonly hookEvent: string; readonly deliveryKey: string; readonly sessionId?: string };
    },
  ): Promise<Record<string, unknown>> {
    const { body, envelope, text, kind, session, deliveryKey, eventTrace } = event;
    ctx.trace({ event: 'event-recorded', ...eventTrace });
    // F's live certification evidence: one event per recorded delivery (names and counts only),
    // and a background re-check at the start of each session. Both run after the answer.
    if (livePorts !== false) {
      const ports = livePorts;
      const supplied = body['harnessVersion'];
      liveSoon(() => recordDelivery(home, envelope, supplied, ports));
      const harness = liveHarnessOf(envelope);
      if (kind === 'session.started' && harness !== undefined) liveSoon(() => reverifyHarnesses(home, [harness], ports, { [harness]: supplied }));
    }
    // A session under a new harness version refreshes that harness's model offer when idle.
    if (modelOffer !== undefined && kind === 'session.started' && session !== undefined && typeof body['harnessVersion'] === 'string') {
      const offer = modelOffer;
      const version = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(body['harnessVersion']) ? body['harnessVersion'] : null;
      setImmediate(() => offer.noteHarnessVersion(session.harness, version));
    }
    if (session !== undefined) recordSessionFor(ctx, session);
    // GOV-04: with the kill switch stopped the event is still recorded (observation), but no
    // subscriber runs, so no advice, decision or effect follows from it.
    if (ctx.killSwitchStopped) {
      ctx.trace({ event: 'subscribers-skipped', reasonCode: 'KILL_SWITCH' });
      return { recorded: true, duplicate: false, killSwitch: 'stopped', results: {} };
    }
    const results: Record<string, unknown> = {};
    /** Subscribers that missed their slice: their proposal, if any, was not waited for. */
    const queued: string[] = [];
    /**
     * A subscriber's consuming effect, handed over by `holdCommit` (a waiting advice line taken off its queue), for the
     * subscribers whose answer was used in time. Run below, after every subscriber has answered, only for an answer
     * the launcher will render: it renders the strongest outcome of all of them, so a line outranked by a certified
     * context is not taken and stays held for the session's next event.
     */
    const held = new Map<string, () => boolean>();
    const answered = new Set<string>();
    // Decisions a subscriber makes for this event carry its session id, so explain can join
    // the decision to the session's requested and actual model (US12).
    const sessionCtx: SidecarOpContext = session === undefined ? ctx : { ...ctx, engine: engineForSession(ctx.engine, session.sessionId) };
    // OD-8: a Kilo or OpenCode event that carries a scope waits for its harness's certification
    // answer (cached for a second), so the turn gate below never reads a stale one.
    const scoped = body['scope'] !== null && typeof body['scope'] === 'object';
    if (scoped && session !== undefined && isTurnHarness(session.harness)) await turnCertified(session.harness, session.harnessVersion);
    // R50: a Kilo or OpenCode event that can create a worker waits for its route.host answer too.
    if (session !== undefined && isTurnHarness(session.harness) && WORKER_EVENT_KINDS.has(kind)) await hostCerts.get(session.harness, session.harnessVersion);
    const subscriberCtx = withApprovedScope(sessionCtx, session?.sessionId ?? null);
    /**
     * A subscriber's `signal` says whether its answer is still wanted: it aborts with the request,
     * and also when the subscriber's slice ends (its answer is then queued and dropped). A
     * subscriber commits a consuming effect (a restore taken, a reminder spent, an explanation
     * marked shown) only while the signal is not aborted, as the last step before it answers, so
     * the effect happens only when the answer is used (D, US14). One started past its slice gets
     * an aborted signal: its answer is never used.
     */
    const answerSignal = (): { readonly signal: AbortSignal; readonly end: () => void } => {
      const slice = new AbortController();
      const end = () => slice.abort();
      if ((ctx.signal as { readonly aborted?: boolean }).aborted === true) end();
      else ctx.signal.addEventListener('abort', end, { once: true });
      return { signal: slice.signal, end };
    };
    /** Calls the subscriber and measures its synchronous prefix; a throw becomes a rejection. */
    const startMeasured = (subscriber: (typeof subscribers)[number], signal: AbortSignal): Promise<unknown> => {
      const began = monotonicClock.now();
      let running: Promise<unknown>;
      const heldContext: SidecarOpContext & { readonly holdCommit: (commit: () => boolean) => void } = {
        ...subscriberCtx,
        signal,
        holdCommit: (commit) => {
          held.set(subscriber.name, commit);
        },
      };
      try {
        running = Promise.resolve(subscriber.handle(heldContext));
      } catch (error) {
        running = Promise.reject(error);
      }
      const spent = Math.max(0, monotonicClock.now() - began);
      syncCostMs.set(subscriber.name, spent);
      if (spent >= SUBSCRIBER_SYNC_DEFER_MS) ctx.trace({ event: 'subscriber-slow-sync', subscriber: subscriber.name, ms: Math.round(spent), reasonCode: 'SUBSCRIBER_SLOW_SYNC' });
      return running;
    };
    // K2: one FIFO per (workspace, session, agent, subscriber). A subscriber's work for this event
    // never starts before its work for the same session's earlier events has finished.
    const rawAgent = envelope !== null && typeof envelope === 'object' ? Reflect.get(envelope, 'agentId') : undefined;
    const agentId = typeof rawAgent === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rawAgent) ? rawAgent : '-';
    const keyOf = (subscriber: (typeof subscribers)[number]): string => [ctx.workspace.id, session?.sessionId ?? '-', agentId, subscriber.name].join('\u0000');
    const eventBytes = Buffer.byteLength(text, 'utf8') + 1024;
    const queueFor = (subscriber: (typeof subscribers)[number], reasonCode: string): void => {
      results[subscriber.name] = { queued: true };
      queued.push(subscriber.name);
      ctx.trace({ event: 'subscriber-queued', subscriber: subscriber.name, reasonCode });
      const where = executor.enqueue(subscriberJob(subscriber, ctx.workspace, ctx.body, session?.sessionId ?? null, keyOf(subscriber), eventBytes));
      if (where === 'spooled') ctx.trace({ event: 'subscriber-spooled', subscriber: subscriber.name, reasonCode: 'BACKGROUND_SPOOLED' });
    };
    // K3: a restore or a Stop continuation is never queued by choice.
    const answerKind = ANSWER_KINDS.has(kind);
    // Owner decision 0eb319de: in observe every subscriber runs after the answer, where nothing it
    // proposes is shown and no consuming effect commits; it still records (and asks Jev for) the
    // counterfactual.
    if (ctx.mode !== undefined && !modeAllows(ctx.mode, 'show-advice')) {
      for (const subscriber of subscribers) queueFor(subscriber, 'MODE_OBSERVE');
      return { recorded: true, duplicate: false, deliveryKey, mode: ctx.mode, results, ...(queued.length > 0 ? { queued: queued.sort() } : {}) };
    }
    const waitFor = async (subscriber: (typeof subscribers)[number]): Promise<void> => {
      const answer = answerSignal();
      const running = startMeasured(subscriber, answer.signal);
      const remaining = ctx.deadline.remainingMs();
      const slice = Math.max(1, answerKind ? Math.floor(remaining * 0.9) : Math.min(sliceCapMs, Math.floor(remaining * 0.8)));
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          // First, synchronously: from here on the subscriber sees its answer is not wanted.
          answer.end();
          resolve('timeout');
        }, slice);
        timer.unref();
      });
      try {
        const winner = await Promise.race([running.then((value) => ({ value })), timedOut]);
        if (winner === 'timeout') {
          results[subscriber.name] = { queued: true };
          queued.push(subscriber.name);
          ctx.trace({ event: 'subscriber-queued', subscriber: subscriber.name, reasonCode: 'SUBSCRIBER_QUEUED' });
          // K1: it runs on, but inside the executor's bound: later work of its key waits for it.
          const tail = running.then(
            () => ctx.trace({ event: 'subscriber-finished', subscriber: subscriber.name }),
            () => ctx.trace({ event: 'subscriber-failed', subscriber: subscriber.name, reasonCode: 'SUBSCRIBER_FAILED' }),
          );
          executor.hold(keyOf(subscriber), subscriber.name, tail);
        } else {
          results[subscriber.name] = winner.value ?? null;
          answered.add(subscriber.name);
        }
      } catch {
        results[subscriber.name] = { error: 'SUBSCRIBER_FAILED' };
        ctx.trace({ event: 'subscriber-failed', subscriber: subscriber.name, reasonCode: 'SUBSCRIBER_FAILED' });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const order = subscribers
      .map((subscriber, index) => ({ subscriber, index, cost: syncCostMs.get(subscriber.name) ?? 0 }))
      .sort((a, b) => a.cost - b.cost || a.index - b.index);
    const waits: Promise<void>[] = [];
    for (const [position, { subscriber, cost }] of order.entries()) {
      // A yield between starts lets timers and I/O run, so one start cannot hold the others.
      if (position > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const key = keyOf(subscriber);
      if (answerKind) {
        // K2 then K3: the session's earlier work (a capsule write) finishes first, inside the deadline.
        const settled = executor.pending(key) ? await executor.settled(key, ctx.signal) : true;
        if (!settled || ctx.deadline.remainingMs() <= 1) {
          queueFor(subscriber, 'DEADLINE');
          continue;
        }
        waits.push(waitFor(subscriber));
        continue;
      }
      if (executor.pending(key)) {
        queueFor(subscriber, 'SUBSCRIBER_ORDERED');
        continue;
      }
      const remaining = ctx.deadline.remainingMs();
      const reasonCode = cost >= SUBSCRIBER_SYNC_DEFER_MS ? 'SUBSCRIBER_SLOW_SYNC' : remaining <= Math.max(1, cost) ? 'DEADLINE' : null;
      if (reasonCode !== null) {
        queueFor(subscriber, reasonCode);
        continue;
      }
      waits.push(waitFor(subscriber));
    }
    await Promise.all(waits);
    // Owner decision 0eb319de: below bounded-auto no subscriber's route reaches the harness (the
    // decision subscriber already explains its own; this holds for every subscriber).
    if (ctx.mode !== undefined && !modeAllows(ctx.mode, 'actuate')) {
      for (const [name, result] of Object.entries(results)) {
        const record = plainRecord(result);
        const outcome = plainRecord(record?.['hookOutcome']);
        if (record === undefined || outcome?.['kind'] !== 'route') continue;
        results[name] = { ...record, hookOutcome: { kind: 'observe' }, certified: false, reasonCode: 'MODE_DOES_NOT_ACTUATE' };
        ctx.trace({ event: 'route-withheld', subscriber: name, reasonCode: 'MODE_DOES_NOT_ACTUATE' });
      }
    }
    // The held consuming effects, last and synchronously: nothing asynchronous follows, so an effect that ran is one
    // whose answer is used. An answer the launcher will drop for a stronger outcome, or one the request no longer
    // wants, takes nothing: what it would have shown stays held for the next event.
    if (held.size > 0) {
      const rendered = renderedSubscribers(results);
      for (const [name, commit] of held) {
        if (!answered.has(name) || (ctx.signal as { readonly aborted?: boolean }).aborted === true) continue;
        let reasonCode: string | null = null;
        if (!rendered.has(name)) reasonCode = 'OUTRANKED';
        else if (!commitTook(commit)) reasonCode = 'ALREADY_SHOWN';
        if (reasonCode === null) continue;
        const record = plainRecord(results[name]);
        if (record === undefined) continue;
        results[name] = { ...record, hookOutcome: { kind: 'observe' }, certified: false, reasonCode, ...(Array.isArray(record['decisionIds']) ? { decisionIds: [] } : {}) };
        ctx.trace({ event: 'pending-advice-withheld', subscriber: name, reasonCode });
      }
    }
    return { recorded: true, duplicate: false, deliveryKey, results, ...(queued.length > 0 ? { queued: queued.sort() } : {}) };
  }

  const state: RuntimeState = {
    home,
    paths,
    workspaces,
    engine,
    modeOf: (workspace) => effectiveModeFor(home, workspace.root),
    jevAssistOf: (workspace) => effectiveJevAssistFor(home, workspace.root),
    get store() {
      return store;
    },
    storeDiagnostic,
    storeFor,
    turnContext: turnContextFor,
    adviceAdherenceFor,
    killSwitchStopped: () => readKillSwitch(home),
    trace,
    telemetry,
    requestReceived(entry) {
      lastRequestAtMs = Date.now();
      telemetry.trace({ event: 'request.received', ws: '', op: entry.op, rid: entry.rid, client: entry.client, budget: entry.budget, bytes: entry.bytes });
    },
    requestDone(entry) {
      telemetry.requestDone(entry);
      latency.count('sidecar-op', entry.op, entry.ok ? 'answered' : (entry.reasonCode ?? 'FAILED'), entry.ms);
      if (entry.late === true) latency.count('sidecar-op', entry.op, 'LATE_ANSWER', entry.ms);
      if (entry.op !== 'ping' && entry.op !== 'health') statusLineSoon();
    },
    refreshStatusLine,
    attach(attached, loaded) {
      service = attached;
      loadedOps = loaded;
      // Work a stopped sidecar left in the spool can be revived now that its subscribers are loaded.
      const recovered = executor.recoverSpool();
      if (recovered > 0) log({ level: 'info', event: 'spool-recovered', jobs: recovered });
    },
    admission,
    executor,
    ops(loaded, requestShutdown) {
      const map = new Map<string, SidecarOpDefinition>();
      for (const def of builtins(loaded, requestShutdown)) map.set(def.op, def);
      for (const [name, def] of loaded.ops) map.set(name, def);
      return map;
    },
    health,
    async startupMaintenance() {
      await runMaintenance('startup');
      if (livePorts !== false && backgroundNetworkAllowed()) {
        const ports = livePorts;
        liveSoon(() => reverifyHarnesses(home, undefined, ports));
      } else if (livePorts !== false) log({ level: 'info', event: 'live-recheck-skipped', reasonCode: 'MODE_OFF' });
      await refreshStatusLine();
      // A harness with no offer yet, or a stale one, is refreshed at the first idle moment.
      modelOffer?.request('start');
      if (statusLineTimer === undefined && !closed) {
        statusLineTimer = setInterval(() => void refreshStatusLine(), 30_000);
        statusLineTimer.unref();
      }
    },
    recordEgressRefusal: auditEgress,
    async dailyMaintenance() {
      await runMaintenance('daily');
    },
    archiveDecisions,
    resumeAccessBlocked: resumeAccessTick,
    async close() {
      if (archiveTimer !== undefined) clearInterval(archiveTimer);
      if (accessResumeTimer !== undefined) clearInterval(accessResumeTimer);
      accessResumeStop.abort();
      if (accessResumeRun !== undefined) await Promise.race([accessResumeRun, new Promise((resolve) => setTimeout(resolve, 250))]);
      clearInterval(latencyTimer);
      if (modelOfferTimer !== undefined) clearInterval(modelOfferTimer);
      await modelOffer?.close();
      if (statusLineTimer !== undefined) clearInterval(statusLineTimer);
      if (!closed) {
        closed = true;
        try {
          writeStatusLine(paths.state, await statusLineBody('stopped'));
        } catch {
          // the next start rewrites it
        }
      }
      // P10: a sweep in the maintenance worker stops; its open chunk rolls back.
      await maintenanceRun?.stop();
      // Queued work that has not started goes to the spool, so the next start runs it (no shedding).
      executor.close();
      await Promise.race([Promise.allSettled([...background, executor.drain(250), ...(archiving !== undefined ? [archiving] : [])]), new Promise((resolve) => setTimeout(resolve, 250))]);
      if (engine !== undefined && engine !== null && typeof engine === 'object') {
        const closer = Reflect.get(engine, 'close');
        if (typeof closer === 'function') {
          try {
            await (closer as () => unknown).call(engine);
          } catch {
            log({ level: 'warn', event: 'engine-close-failed' });
          }
        }
      }
      // The day's last trace lines are on disk when the stop returns (bounded: telemetry.close).
      await telemetry.close();
      try {
        latency.flush();
      } catch {
        log({ level: 'warn', event: 'latency-flush-failed' });
      }
      if (store !== undefined && api !== undefined) {
        try {
          api.closeStore(store);
        } catch {
          log({ level: 'warn', event: 'store-close-failed' });
        }
        store = undefined;
      }
    },
  };

  /** Mirrors one decision into the store if its journal entry is terminal. Never throws. */
  async function archiveOne(decisionId: string): Promise<void> {
    const journal = engineField(loadedEngine, 'journal');
    if (store === undefined || api === undefined || typeof engineField(journal, 'read') !== 'function') return;
    try {
      const result = await api.archiveJournalEntry(store, journal as Parameters<StoreModule['archiveJournalEntry']>[1], decisionId, 'sidecar', { notBeforeMs: archiveWatermarkMs() });
      if (!result.ok) log({ level: 'warn', event: 'decision-mirror-refused', reason: result.reason });
    } catch {
      log({ level: 'warn', event: 'decision-mirror-failed' });
    }
  }

  /** The retention policy, re-read at most once a minute (the archive runs after every decision). */
  let cachedRetention: { readonly policy: ReturnType<typeof resolveRetention>['policy']; readonly atMs: number } | undefined;
  function retentionPolicy(): ReturnType<typeof resolveRetention>['policy'] {
    const nowMs = Date.now();
    if (cachedRetention === undefined || nowMs - cachedRetention.atMs > 60_000) cachedRetention = { policy: resolveRetention({ home }).policy, atMs: nowMs };
    return cachedRetention.policy;
  }

  /**
   * K4: the archive's watermark, the retention sweep's decision cutoff. An entry created before it
   * is past retention: it is not archived, so a row the sweep removed never comes back.
   */
  function archiveWatermarkMs(): number {
    return Date.now() - retentionPolicy().decisionRetentionDays * DAY_MS;
  }

  /** C's DecisionJournal.prune on the sweep's cutoff, when the engine has it. Never throws. */
  async function pruneJournal(beforeMs: number): Promise<void> {
    const journal = engineField(loadedEngine, 'journal');
    const prune = engineField(journal, 'prune');
    if (typeof prune !== 'function') return;
    try {
      const result: unknown = await (prune as (input: { readonly beforeMs: number }) => unknown).call(journal, { beforeMs });
      const record = plainRecord(result);
      const count = (name: string): number => (typeof record?.[name] === 'number' ? (record[name] as number) : 0);
      log({ level: 'info', event: 'journal-pruned', removed: count('removed'), kept: count('kept'), keptForReconciliation: count('keptForReconciliation'), unreadable: count('unreadable'), failed: count('failed') });
    } catch {
      log({ level: 'warn', event: 'journal-prune-failed' });
    }
  }

  /** DATA-05: terminal decisions from the engine's journal become immutable store rows. */
  async function archiveDecisions(): Promise<void> {
    if (archiving !== undefined) return archiving;
    const journal = engineField(loadedEngine, 'journal');
    if (store === undefined || api === undefined || typeof engineField(journal, 'list') !== 'function' || typeof engineField(journal, 'read') !== 'function') return;
    const opened = store;
    const storeApi = api;
    archiving = (async () => {
      try {
        const result = await storeApi.archiveJournal(opened, journal as Parameters<StoreModule['archiveJournal']>[1], 'sidecar', { notBeforeMs: archiveWatermarkMs() });
        if (result.ok && (result.inserted > 0 || result.usageFilled > 0)) log({ level: 'info', event: 'decisions-archived', inserted: result.inserted, usageFilled: result.usageFilled });
        if (!result.ok) log({ level: 'warn', event: 'decisions-archive-refused', reason: result.reason });
      } catch {
        log({ level: 'warn', event: 'decisions-archive-failed' });
      } finally {
        archiving = undefined;
      }
    })();
    return archiving;
  }

  /** DATA-04 at startup, DATA-11 retention at startup and daily, DATA-05 archive. */
  /**
   * GOV-10: audit rows a CLI command recorded while no sidecar ran (credential set and clear,
   * policy changes) wait in a private file under the state directory; they are appended here,
   * with their original time, and the file is removed. Only the kinds a CLI may record count.
   */
  function ingestPendingAudit(): void {
    if (store === undefined || api === undefined) return;
    const file = join(input.paths.state, PENDING_AUDIT_FILE);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    let appended = 0;
    for (const line of text.split('\n').slice(0, 1000)) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const kind = row['kind'];
        const atMs = row['atMs'];
        const actor = row['actor'];
        const detail = row['detail'];
        if (typeof kind !== 'string' || !PENDING_AUDIT_KINDS.has(kind) || typeof atMs !== 'number' || typeof actor !== 'string') continue;
        const written = api.appendAudit(store, {
          kind: kind as 'credential.set',
          actor,
          channel: 'cli',
          atMs,
          detail: { ...(detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, string | number | boolean | null>) : {}), deferred: true },
        });
        if (written.ok) appended += 1;
      } catch {
        // a malformed line is skipped
      }
    }
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
    if (appended > 0) log({ level: 'info', event: 'audit-pending-appended', rows: appended });
  }

  /** The maintenance worker's sweep in flight, stopped by close. */
  let maintenanceRun: RunningSweep | undefined;

  async function runMaintenance(when: 'startup' | 'daily'): Promise<void> {
    if (store === undefined || api === undefined) return;
    const nowMs = Date.now();
    try {
      if (when === 'startup') {
        ingestPendingAudit();
        const reconciled = api.reconcileRestart(store, { nowMs });
        if (reconciled.ok) {
          log({
            level: 'info',
            event: 'restart-reconciled',
            expiredLeases: reconciled.expiredLeases,
            blockedTasks: reconciled.blockedTasks.length,
            uncertainReservations: reconciled.uncertainReservations,
            unknownUsageHolds: reconciled.unknownUsageHolds,
            outbox: reconciled.outboxNeedsReconciliation,
          });
        } else {
          log({ level: 'warn', event: 'restart-reconcile-refused', reason: reconciled.reason });
        }
      }
      await archiveDecisions();
      const resolved = resolveRetention({ home });
      for (const issue of resolved.issues) log({ level: 'warn', event: 'retention-policy-invalid', reasonCode: issue });
      const policy = resolved.policy;
      cachedRetention = { policy, atMs: nowMs };
      // P10: the sweep runs in the maintenance worker on its own connection, in chunks; without
      // one (an in-process daemon) or when it cannot start, the same chunked sweep runs here.
      const job = { path: store.resolvedPath, hostScope: store.hostScope, policy, nowMs, rawDir: join(paths.data, 'evidence') };
      let swept: SweepOutcome;
      if (input.maintenanceWorker !== undefined && !closed) {
        maintenanceRun = sweepInWorker(input.maintenanceWorker, job);
        swept = await maintenanceRun.done;
        maintenanceRun = undefined;
        if (!swept.ok && swept.reason !== 'MAINTENANCE_STOPPED' && swept.reason !== 'MAINTENANCE_WORKER_TIMEOUT' && !closed) {
          log({ level: 'warn', event: 'maintenance-worker-refused', reason: swept.reason });
          swept = sweepInline(api, store, job);
        }
      } else {
        swept = sweepInline(api, store, job);
      }
      if (swept.ok) log({ level: 'info', event: 'retention-swept', when, where: swept.where, rawArtifactRetentionDays: policy.rawArtifactRetentionDays, decisionRetentionDays: policy.decisionRetentionDays, rawFiles: swept.rawFiles, rows: Object.values(swept.removed).reduce((a, b) => a + b, 0), vacuumed: swept.vacuumed, longestWriteMs: swept.longestWriteMs });
      else log({ level: 'warn', event: 'retention-refused', reason: swept.reason });
      // K4 (C 89c9420): the journal is pruned on the sweep's own cutoff, so it stops growing and the
      // archive (which skips entries past that watermark) never brings a swept row back.
      await pruneJournal(nowMs - policy.decisionRetentionDays * DAY_MS);
      // DATA-11: the file classes beside the store (orchestration history, worker runs, live evidence, calibration cases).
      const files = await sweepFileRetention({ home, dataDir: paths.data, policy, nowMs });
      const fileRows = Object.values(files.orchestration).reduce((a, b) => a + b, 0);
      if (fileRows > 0 || files.liveEvidence > 0 || files.calibrationCases > 0) log({ level: 'info', event: 'retention-files-swept', when, orchestration: fileRows, liveEvidence: files.liveEvidence, calibrationCases: files.calibrationCases });
      maintenance = { lastRunAtMs: nowMs, lastError: null };
    } catch {
      maintenance = { lastRunAtMs: nowMs, lastError: 'MAINTENANCE_FAILED' };
      log({ level: 'error', event: 'maintenance-failed', when });
    }
  }

  const archiveTimer = engine !== undefined && store !== undefined ? setInterval(() => void archiveDecisions(), ARCHIVE_PERIOD_MS) : undefined;
  archiveTimer?.unref();

  return state;
}

// ------------------------------------------------------------------ sessions (US12)

const SESSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _.:/@+-]{0,127}$/;
const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface EventSession {
  readonly sessionId: string;
  readonly harness: string;
  readonly harnessVersion: string | null;
  readonly requestedModel: string | null;
  readonly actualModel: string | null;
  readonly state: 'active' | 'ended';
  /** The normalized event kind, recorded as the source of a model change (P5). */
  readonly source: string;
}

function label(value: unknown): string | null {
  return typeof value === 'string' && SESSION_LABEL.test(value) ? value : null;
}

/** Runs a held consuming effect; false when it took nothing (already taken) or threw, so the answer is not shown. */
function commitTook(commit: () => boolean): boolean {
  try {
    return commit();
  } catch {
    return false;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The session a normalized harness event names, or undefined. The model the harness reports as
 * active is the actual model; a requested switch (`model.change.requested`) names the requested
 * one and a completed switch (`model.changed`) the new actual one. A tool input's model (a
 * subagent's) is not the session's and is ignored, and so is any model on a subagent's event.
 */
export function sessionOf(envelope: unknown, body: Record<string, unknown>): EventSession | undefined {
  const event = plainRecord(envelope);
  if (event === undefined || event['schemaVersion'] !== '1.0') return undefined;
  const sessionId = event['sessionId'];
  const harness = label(event['harness']);
  if (typeof sessionId !== 'string' || !SESSION_KEY.test(sessionId) || harness === null) return undefined;
  const kind = typeof event['kind'] === 'string' ? event['kind'] : '';
  const payload = plainRecord(event['payload']) ?? {};
  const toModel = label(payload['toModel']);
  let requestedModel: string | null = null;
  let actualModel = label(event['model']);
  // A subagent's event (F's adapters: `parentSessionId` set, `sessionId` the parent, `agentId`
  // the subagent) is recorded under the parent session as its subagent: the subagent's model is
  // not the session's, and a subagent ending never ends the parent session.
  const subagent = typeof event['parentSessionId'] === 'string';
  if (subagent) {
    return { sessionId, harness, harnessVersion: label(body['harnessVersion']), requestedModel: null, actualModel: null, state: 'active', source: 'subagent' };
  }
  if (kind === 'model.change.requested') {
    // The switch is only asked for: it names the requested model and says nothing new about
    // the actual one.
    requestedModel = toModel ?? actualModel;
    actualModel = null;
  } else if (kind === 'model.changed') {
    actualModel = toModel ?? actualModel;
  } else if (kind === 'task.requested' && (harness === 'kilocode' || harness === 'opencode')) {
    // Kilo and OpenCode name the model chosen for a message when it is sent (chat.message): that
    // is the requested model. The one that answered arrives with message.completed.
    requestedModel = actualModel;
    actualModel = null;
  }
  return {
    sessionId,
    harness,
    harnessVersion: label(body['harnessVersion']),
    requestedModel,
    actualModel,
    state: kind === 'session.ended' ? 'ended' : 'active',
    source: /^[a-z][a-z0-9.-]{0,63}$/.test(kind) ? kind : 'unknown',
  };
}

/** The engine a subscriber sees: decide() requests without a session id get this event's. */
export function engineForSession(engine: unknown, sessionId: string): unknown {
  if (engine === null || typeof engine !== 'object') return engine;
  const decide = Reflect.get(engine, 'decide');
  if (typeof decide !== 'function') return engine;
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property !== 'decide') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (request: unknown, ...rest: unknown[]) => {
        const record = plainRecord(request);
        const stamped = record !== undefined && record['sessionId'] === undefined ? { ...record, sessionId } : request;
        return (decide as (...args: unknown[]) => unknown).call(target, stamped, ...rest);
      };
    },
  });
}

// ------------------------------------------------------------------ decision mirror

const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Engine members that only read; everything else may settle a decision. */
const ENGINE_READS = new Set(['lookup', 'entry', 'list', 'read', 'snapshot', 'close', 'recover']);

function decisionIdsOf(result: unknown, args: readonly unknown[]): string[] {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && DECISION_ID.test(value)) ids.add(value);
  };
  const record = plainRecord(result);
  if (record !== undefined) {
    add(record['decisionId']);
    add(plainRecord(record['record'])?.['decisionId']);
  }
  if (typeof args[0] === 'string') add(args[0]);
  return [...ids];
}

/**
 * The engine the sidecar hands to ops and subscribers: each method that may settle a decision
 * awaits `mirror(decisionId)` for every decision id its result or first argument names before
 * it returns. The mirror is idempotent and never throws, so a store problem never changes the
 * engine's answer.
 */
export function mirrorTerminalDecisions(engine: unknown, mirror: (decisionId: string) => Promise<void>): unknown {
  if (engine === null || typeof engine !== 'object') return engine;
  return new Proxy(engine, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property !== 'string' || ENGINE_READS.has(property)) return method.bind(target);
      return (...args: unknown[]) => {
        const out = method.apply(target, args);
        if (out === null || typeof out !== 'object' || typeof Reflect.get(out, 'then') !== 'function') return out;
        return (out as Promise<unknown>).then(async (result) => {
          for (const id of decisionIdsOf(result, args)) await mirror(id);
          return result;
        });
      };
    },
  });
}

// ------------------------------------------------------------------ provider health (W07)

/**
 * The fixed line for a disabled Jev circuit (C2's circuitDisabledText: the code, the time and the
 * command that clears it), or null when the engine has no circuit or it is not disabled. It comes
 * ahead of providerDownReason, which reads only recent decisions. Never throws.
 */
export function circuitDisabledReason(engine: unknown): string | null {
  const snapshot = disabledSnapshot(engine);
  if (snapshot === null) return null;
  try {
    return circuitDisabledText(snapshot);
  } catch {
    return null;
  }
}

/** The engine circuit's snapshot when it is disabled, else null. Never throws. */
function disabledSnapshot(engine: unknown): CircuitSnapshot | null {
  try {
    if (engine === null || typeof engine !== 'object') return null;
    const circuit = Reflect.get(engine, 'circuit') as unknown;
    if (circuit === null || typeof circuit !== 'object') return null;
    const snapshot = Reflect.get(circuit, 'snapshot') as unknown;
    if (typeof snapshot !== 'function') return null;
    const value = (snapshot as () => unknown).call(circuit);
    return value !== null && typeof value === 'object' && Reflect.get(value, 'state') === 'disabled' ? (value as CircuitSnapshot) : null;
  } catch {
    return null;
  }
}

/** Status's view of the machine's access pauses (R79; E's AccessLimitsStatusSchema). */
export interface AccessLimitsView {
  readonly readable: boolean;
  readonly full: boolean;
  readonly active: number;
  readonly entries: readonly ({ readonly newKeyClears: boolean } & { readonly [field: string]: unknown })[];
}

/** The view without the newKeyClears booleans, for a status contract that does not carry them. */
export function withoutNewKeyClears(view: AccessLimitsView | null): unknown {
  if (view === null) return null;
  return { ...view, entries: view.entries.map(({ newKeyClears: _dropped, ...rest }) => rest) };
}

/** Status's view of a disabled Jev circuit (E's JevCircuitStatusSchema). */
export interface JevCircuitView {
  readonly state: 'disabled';
  readonly reasonCode: 'PROVIDER_BILLING' | 'PROVIDER_DISABLED';
  readonly reasonClass: 'BILLING' | 'ACCOUNT' | 'AUTH';
  readonly since: string | null;
  readonly command: 'jevris credential reenable' | 'jevris credential set';
}

/**
 * The `jevCircuit` status field (decision ea2af91a, agreed with E): the disabled state's fixed
 * reason code and class, since when, and the one command that clears it. Null when the engine has
 * no circuit or it is not disabled, or the reason is unknown. Never a key or fingerprint.
 */
export function jevCircuitOf(engine: unknown): JevCircuitView | null {
  const snapshot = disabledSnapshot(engine);
  if (snapshot === null) return null;
  const reasonClass = snapshot.disabledReason;
  if (reasonClass !== 'BILLING' && reasonClass !== 'ACCOUNT' && reasonClass !== 'AUTH') return null;
  const sinceMs = snapshot.disabledSinceMs;
  return {
    state: 'disabled',
    reasonCode: reasonClass === 'BILLING' ? 'PROVIDER_BILLING' : 'PROVIDER_DISABLED',
    reasonClass,
    since: typeof sinceMs === 'number' && Number.isSafeInteger(sinceMs) && sinceMs >= 0 ? new Date(sinceMs).toISOString() : null,
    command: reasonClass === 'AUTH' ? 'jevris credential set' : CIRCUIT_REENABLE_COMMAND,
  };
}

// ------------------------------------------------------------- Jev decision budget (2026-09-29)

/**
 * The degraded line while this workspace's Jev decisions run rules-only because a budget has no
 * room: which cap (BUDGET_MACHINE_LIMIT, BUDGET_WORKSPACE_CAP), whether it is set to 0
 * (BUDGET_ZERO), when it starts again and the command that changes it. Null otherwise.
 */
export function budgetSpentReason(budget: BudgetStatusView): string | null {
  if (budget.state !== 'exhausted' || budget.exhaustedBy === undefined || budget.exhaustedBy === null) return null;
  const until = budget.resetsAt === undefined ? '' : ` until ${budget.resetsAt.slice(0, 10)} (UTC)`;
  if (budget.exhaustedBy === 'workspace') {
    const ws = budget.workspace;
    if (ws !== undefined && ws !== null && ws.limitMicroUsd === 0) return 'This workspace\'s Jev decision budget is 0 (BUDGET_WORKSPACE_CAP, BUDGET_ZERO): no Jev calls here; its decisions run rules-only. Change it with `jevris configure workspace-budget`.';
    const where = ws !== undefined && ws !== null && ws.source === 'repository' ? 'the repository\'s .jevris/config.json' : '`jevris configure workspace-budget`';
    return `This workspace's monthly Jev decision budget is spent (BUDGET_WORKSPACE_CAP); its decisions run rules-only${until}. Other workspaces go on. Its cap is set by ${where}.`;
  }
  if (budget.limitMicroUsd === 0) return 'The Jev decision budget is 0 (BUDGET_MACHINE_LIMIT, BUDGET_ZERO): no Jev calls; decisions run rules-only. Change it with `jevris configure set decisions.monthlyBudgetMicroUsd <micro-USD>`.';
  return `The monthly Jev decision budget is spent (BUDGET_MACHINE_LIMIT); decisions run rules-only${until}. Raise it with \`jevris configure set decisions.monthlyBudgetMicroUsd <micro-USD>\`.`;
}

/**
 * The limits the engine's budget reads at every reservation: the machine-wide limit (the effective
 * `decisions.monthlyBudgetMicroUsd`) and a workspace's own cap (the stored cap, lowered by its
 * repository file when the sidecar knows its root). Each read goes to the files, so a
 * `jevris configure` change applies to the next decision without a restart.
 */
export function budgetLimitReaders(home: string, rootOf: (workspaceId: string) => string | null): BudgetLimitReaders {
  return {
    machine: () => machineJevBudget({ home }),
    workspace: (workspaceId) => workspaceJevBudget({ home, workspaceId, workspaceRoot: rootOf(workspaceId) }).capMicroUsd,
  };
}

/** Reason codes that mean Jev was unreachable, refused the call or is paused by the breaker. */
const PROVIDER_DOWN = /^(?:CIRCUIT_OPEN|PROVIDER_[A-Z_]+|DEADLINE|TIMEOUT|RATE_LIMITED|OVERLOADED|NETWORK[A-Z_]*|CONNECTION[A-Z_]*|AUTH[A-Z_]*|EGRESS_(?:NOT_APPROVED|SECRET_BLOCKED))$/;
const PROVIDER_DOWN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Status says decisions are degraded while the latest decision (within 15 minutes) fell back
 * because of the provider: an outage, an overload, the circuit breaker or a refused egress.
 * One successful decision clears it.
 */
export function providerDownReason(recent: readonly unknown[], nowMs: number): string | null {
  const latest = plainRecord(recent[0]);
  if (latest === undefined) return null;
  const reasonCode = typeof latest['reasonCode'] === 'string' ? latest['reasonCode'] : '';
  const at = typeof latest['at'] === 'string' ? Date.parse(latest['at']) : Number.NaN;
  if (!PROVIDER_DOWN.test(reasonCode) || !Number.isFinite(at) || nowMs - at > PROVIDER_DOWN_WINDOW_MS) return null;
  return `Jev is unavailable (${reasonCode}); decisions run rules-only until it answers again. Run \`jevris doctor\` for details.`;
}
