/**
 * Owned workers, cancellation and task completion (ORC-05, ORC-06, SSOT §10.2, §10.3, W01).
 *
 * `runLeasedTask` turns a lease into work: a fresh worktree from the base commit, a running
 * task, an Agent SDK session in that worktree (through the WorkerPort), heartbeats that also
 * pick up cross-process cancel requests, the allowed-paths check on the real diff, and a
 * fenced state change at the end. Spend is released as the SDK's reported cost, or as
 * uncertain when the SDK reported none.
 *
 * `cancelTask` stops scheduling for the task, signals its owned session (in this process
 * directly, in another process through the owned-session registry), releases the lease, and
 * keeps the worktree: a dirty or unknown tree is never deleted.
 *
 * `completeTask` runs the task's acceptance checks in its worktree and moves the task to
 * `verified` only from a store-read completion verdict.
 *
 * Owned effects (GOV-03, US40): before the worker session starts, the run is written to the
 * store as a pending owned effect (`beginOwnedEffect`, operation id `op-<lease id>`). The kill
 * switch holds every pending effect. When the session ends the effect is settled; a held
 * effect stays held, the task is blocked for reconciliation, and only a person reconciles it
 * (`reconcileOwnedEffect`, after the kill switch is cleared) before the task is ready again.
 */
import type { WorkspaceServices } from '../workspace.js';
import { openWorkspace } from '../workspace.js';
import { createWorktree, enforceAllowedPaths, getWorktree, retainWorktree, worktreeStatus, type WorktreeRecord } from '../worktree.js';
import { runVerification, verificationStatus } from '../verify/service.js';
import type { CompletionReport } from '../verify/completion.js';
import { beginOwnedEffect, heldEffects, reconcileEffect, settleOwnedEffect } from '@jevris/store';
import { recordKey } from '../util.js';
import type { LeaseAuthority, LeaseGrant, LeaseRecord } from './leases.js';
import { selfIdentity, type ProcessIdentity } from './liveness.js';
import { completionLabel, completionOutcome, recordRouteOutcome } from './learning.js';
import { recordTaskEstimate } from './estimates.js';
import { blockCancelledDependants } from './scheduler.js';
import {
  PROVIDER_HARNESSES,
  XAI_PLAN_NOT_ELIGIBLE,
  signedInSource,
  vendorAuth,
  providerEnv,
  PROVIDER_KEY_VARS,
  readWorkerAuthSettings,
  resolveMultiProviderAuth,
  WORKER_PROVIDER_UNKNOWN,
  providerHarnesses,
  workerProvider,
  xaiAuthFailure,
  type ResolvedWorkerAuth,
  type StoredCredential,
  type WorkerAuthMode,
  type WorkerAuthSettings,
  type WorkerAuthSource,
  type WorkerHarness,
  type ProviderRegistry,
  type WorkerProvider,
} from './worker-auth.js';
import { getTask, markVerified, taskTransition, type TaskRecord } from './tasks.js';
import {
  BUNDLED_MODEL_REGISTRY,
  MODEL_SIGNAL_PORTS,
  MODEL_UNAVAILABLE_REASONS,
  classifyModelUnavailable,
  loadModelAvailability,
  loadModelRegistry,
  HOST_CONSENT_REQUIRED,
  providerConsentGate,
  ranHereParties,
  ranHereProviders,
  routeConsentGate,
  readModelOffer,
  recordModelRun,
  recordModelUnavailable,
  unavailableModels,
  type AvailabilityAuthMode,
  type ModelSignalPort,
  type ModelUnavailableReason,
  type ProviderConsentReader,
} from '@jevris/core';
import { HARNESS_IDS, type AccessLimitFinding, type AccessSignalWire, type HarnessId, type ModelRegistry } from '@jevris/contracts';
import { cleanRunSpelling, resolveRunSpelling } from './model-spelling.js';
import { HOST_ROUTE_UNKNOWN, hostEnv, hostReachable, hostRouteOfRun, resolveHostAuth, type HostRoute } from './worker-hosts.js';
import {
  ACCESS_BLOCKED_COLLECTION,
  accessBlockedRow,
  accessRepeat,
  accessReason,
  clearRunAccess,
  launchAccessCheck,
  nextOverloadAttempt,
  overloadedReason,
  overloadRetryAt,
  recordRunAccess,
  accessCertified,
  limitCooldownHoursOf,
  wireSignalOf,
  type AccessBlockedRow,
  type RunAccessResult,
} from './access-limits.js';

// ------------------------------------------------------------------------------ worker port

/**
 * Every status an owned worker run ends with: the one list the outcome type, the scripted test
 * port and the run record use (F's ports mirror it in `OwnedWorkerStatus`).
 * `model-unavailable`: the port found the requested model gone, or not accessible from this
 * harness and sign-in (C's MODEL_UNAVAILABLE_SIGNALS); `modelUnavailable` says which.
 * `access-limit` and `overloaded` (access limits R70): the run hit a rate limit, a usage window,
 * exhausted credit, a blocked account, or an overloaded provider; `accessSignal` says which. A
 * stored `usage-limit` run reads as an access limit.
 */
export const WORKER_RUN_STATUSES = ['completed', 'failed', 'max-turns', 'budget-exceeded', 'aborted', 'timeout', 'unsupported', 'refused', 'usage-limit', 'model-unavailable', 'access-limit', 'overloaded'] as const;
export type WorkerRunStatus = (typeof WORKER_RUN_STATUSES)[number];

/** What a `model-unavailable` run found, as C's availability record takes it: never error text. */
export interface ModelUnavailableFinding {
  readonly reasonCode: ModelUnavailableReason;
  /** C's port id: a harness id (`kilocode`, never `kilo`) or `claude-api` (the Agent SDK worker). */
  readonly port: ModelSignalPort;
  readonly authMode: AvailabilityAuthMode;
}

/** C's port id for a worker harness (HARNESS_IDS: Kilo is `kilocode`). */
export const MODEL_PORT_OF: { readonly [H in WorkerHarness]: ModelSignalPort } = { claude: 'claude', codex: 'codex', opencode: 'opencode', kilo: 'kilocode', antigravity: 'antigravity' };

/** A finding the availability record may take: a known reason from a known port, never Jev's (`typesafe`). */
export function validFinding(value: unknown): ModelUnavailableFinding | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { readonly reasonCode?: unknown; readonly port?: unknown; readonly authMode?: unknown };
  if (typeof v.reasonCode !== 'string' || !(MODEL_UNAVAILABLE_REASONS as readonly string[]).includes(v.reasonCode)) return null;
  if (typeof v.port !== 'string' || !(MODEL_SIGNAL_PORTS as readonly string[]).includes(v.port) || v.port === 'typesafe') return null;
  const authMode = v.authMode === 'api-key' || v.authMode === 'subscription' ? v.authMode : 'unknown';
  return { reasonCode: v.reasonCode as ModelUnavailableReason, port: v.port as ModelSignalPort, authMode };
}

/**
 * Whether `model` is recorded unavailable on this machine for the run `port` would make: every
 * MODEL_GONE, and a MODEL_NOT_ACCESSIBLE only on that harness and sign-in (C's unavailableModels).
 * Null when it is available, or when the record cannot be read (a read never blocks a launch).
 */
export async function modelUnavailableHere(home: string, model: string, port: WorkerPort | null): Promise<ModelUnavailableReason | null> {
  try {
    const registry = (await loadModelRegistry({ home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const entries = await loadModelAvailability(home, registry);
    if (entries.length === 0) return null;
    const harness = port?.harnessFor?.(model) ?? null;
    const auth = harness === null || port?.authFor === undefined ? null : ((await port.authFor(model).catch(() => null))?.mode ?? null);
    return unavailableModels(entries, { harness: harness === null ? null : MODEL_PORT_OF[harness], authMode: auth })[model] ?? null;
  } catch {
    return null;
  }
}

export interface WorkerRunInput {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onStart?: (control: { readonly interrupt: () => void; readonly abort: () => void; readonly sessionId: () => string | null }) => void;
  /**
   * Called at most once, with the harness session id, as soon as the harness first names it (F's
   * ports, 5bb12a6; the Agent SDK port). The runner binds it to the running owned session, so the
   * session is linked to its task while the run is live (owner decision 29423b6). The dispatching
   * port adds the harness the run went to.
   */
  readonly onSessionId?: (sessionId: string, harness?: WorkerHarness) => void;
  /** The leased task (for the scripted test port only; never sent to a harness). */
  readonly taskId?: string;
  /** The auth mode the harness CLI port runs in (never a key or token value). */
  readonly auth?: WorkerAuthMode;
  /**
   * The reasoning effort the router launched (C16 effort arms), when it is not the model's
   * default; absent runs with no effort setting (Claude Code `--effort`, Codex
   * `model_reasoning_effort`).
   */
  readonly effort?: string;
  /**
   * The child's environment for a harness CLI port (set by loadWorkerPort from the auth mode:
   * a subscription run never carries the provider's API keys). Absent: the port's own default.
   */
  readonly env?: { readonly [key: string]: string | undefined };
  /**
   * R29: the model registry the runner loaded, so F's ports spell the model for the harness the
   * same way (an administrator's override included). Absent: F's bundled snapshot.
   */
  readonly registry?: ModelRegistry;
  /**
   * R52: the pinned serving host the run goes through (`openrouter`, `kilo`), with `model` the
   * registry id; absent is the maker's own route. The dispatching port also reads a host spelling in
   * `model` (`openrouter/moonshotai/kimi-k3`) as this. It runs only on OpenCode or Kilo, with the
   * (host, maker) pair's consent and the host's sign-in, and hands F's port the registry id plus
   * the host. Nothing passes it until task-ops does (held for the owner).
   */
  readonly servingHost?: string;
}

export interface WorkerRunOutcome {
  /** `usage-limit`: the harness's subscription or session limit was hit (a 429); not the task's failure. */
  readonly status: WorkerRunStatus;
  readonly reason: string;
  readonly sessionId: string | null;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly costUsd: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null;
  readonly turns: number | null;
  readonly durationMs: number;
  /** The auth mode that actually ran, when the port reports it ('unknown' when it could not tell). */
  readonly authMode?: WorkerAuthMode | 'unknown';
  /** Where the auth mode came from (set by loadWorkerPort): declared, the environment, the harness's stored login or key, or undetected. */
  readonly authSource?: WorkerAuthSource;
  /** For `usage-limit`: when the harness says the limit lifts (ISO), if it says. */
  readonly resetAt?: string;
  /** The harness the owned worker ran on (set by loadWorkerPort). */
  readonly harness?: WorkerHarness;
  /** The effort the run was given (null: the model's default); set by loadWorkerPort. */
  readonly effort?: string | null;
  /**
   * The harness port's first-use check of the session's first event (F 9534911): model,
   * effort, tools, auth and worktree. A failed check stops the run (refused) and F's port
   * demotes worker.route; null when there was no first event.
   */
  readonly initCheck?: { readonly ok: boolean; readonly reasonCode: string | null } | null;
  /** Present only with status `model-unavailable`: what the port found (F's shape, C's table). */
  readonly modelUnavailable?: ModelUnavailableFinding;
  /**
   * The access signal the run ended on (E's wire shape: codes, a reset and a text pattern id,
   * never text). The runner classifies it again with core in its own process (R70).
   */
  readonly accessSignal?: AccessSignalWire;
  /** The worker's own classification of that signal: kept as its claim, never recorded as such. */
  readonly accessLimit?: AccessLimitFinding;
  /**
   * `false` only for the dispatching port's own refusals, all made before any harness port runs,
   * so no child process was started or attempted (no login for the host, no consent, no harness,
   * an unknown route): a known zero effect. The run's reservation, owned effect and lease then
   * settle at 0 instead of being held as unknown spend. Anything a harness port returns never
   * carries it (loadWorkerPort drops it), so a run that started, or a spawn that threw, keeps
   * today's hold. The coordinator's pre-spawn release; core's LaunchReceipt.spawned.
   */
  readonly spawned?: false;
}

export interface WorkerPort {
  run(input: WorkerRunInput): Promise<WorkerRunOutcome>;
  /** The harness a model's run would use here (the dispatching port), or null when none can. */
  harnessFor?(model: string, servingHost?: string): WorkerHarness | null;
  /** The auth mode a model's run would use here and where it comes from, or null when it would be refused. */
  authFor?(model: string, servingHost?: string): Promise<{ readonly mode: WorkerAuthMode; readonly source: WorkerAuthSource } | null>;
}

/**
 * A run outcome that carries a port's model signal (the class id from C's table, never error
 * text), classified through C's `classifyModelUnavailable`: a non-null reason makes it
 * `model-unavailable` with what was found. Any other outcome is returned unchanged.
 */
export function withModelSignal<T extends { readonly status: string; readonly requestedModel: string }>(
  outcome: T & { readonly modelSignal?: { readonly port: string; readonly signal: string } },
  authMode: AvailabilityAuthMode,
  certified = false,
): T | (T & { readonly status: 'model-unavailable'; readonly reason: string; readonly modelUnavailable: ModelUnavailableFinding }) {
  const sig = outcome.modelSignal;
  if (sig === undefined || outcome.status === 'completed') return outcome;
  const reasonCode = classifyModelUnavailable({ port: sig.port, signal: sig.signal, certified });
  const finding = reasonCode === null ? null : validFinding({ reasonCode, port: sig.port, authMode });
  if (finding === null) return outcome;
  return { ...outcome, status: 'model-unavailable', reason: `model ${outcome.requestedModel} is not available here (${finding.reasonCode} via ${finding.port})`, modelUnavailable: finding };
}

/** The Agent SDK worker from `@jevris/adapter-claude-sdk`, or null when it cannot load. */
export async function loadSdkWorkerPort(): Promise<WorkerPort | null> {
  try {
    const adapter = await import('@jevris/adapter-claude-sdk');
    // The SDK runs only on ANTHROPIC_API_KEY: a found-gone model is recorded for api-key sign-in.
    return { run: async ({ taskId: _task, ...input }) => withModelSignal(await adapter.runOwnedWorker(input), 'api-key') };
  } catch {
    return null;
  }
}

/** Why a run cannot start when a harness's worker port cannot load: install that harness. */
export const OPENCODE_PORT_MISSING = 'unsupported: install OpenCode (opencode) and run jevris install --harness opencode';
export const KILO_PORT_MISSING = 'unsupported: install Kilo Code (kilo) and run jevris install --harness kilocode';
export const ANTIGRAVITY_PORT_MISSING = 'unsupported: install Antigravity (agy) with its headless mode and run jevris install --harness antigravity';
/** An Anthropic model on OpenCode or Kilo runs only with ANTHROPIC_API_KEY, never a claude.ai login. */
export const ANTHROPIC_LOGIN_THIRD_PARTY = 'ANTHROPIC_LOGIN_THIRD_PARTY';
export const CODEX_PORT_MISSING = 'unsupported: install the Codex CLI (codex) and run jevris install --harness codex';

/** F's Codex worker (`@jevris/cli/codex-worker`), or null when it cannot load. */
export async function loadCodexWorkerPort(): Promise<WorkerPort | null> {
  try {
    const cli = await import('@jevris/cli/codex-worker');
    return harnessWorkerPort(cli.codexWorkerPort());
  } catch {
    return null;
  }
}

/**
 * A WorkerPort over one of F's harness ports. The effort goes only as one of F's levels (an
 * unknown level runs at the model's default, recorded as such), and the scripted-port task id
 * never reaches a harness.
 */
export function harnessWorkerPort(port: { run(input: HarnessPortInput): Promise<WorkerRunOutcome> }): WorkerPort {
  return {
    run: ({ taskId: _task, effort, ...input }) => port.run({ ...input, ...(effort !== undefined && isHarnessEffort(effort) ? { effort } : {}) }),
  };
}

/** The effort levels F's ports take (F maps each to the harness's own flag). */
export type HarnessEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** A harness port's input: the run input without the scripted-port task id, effort as F's level. */
export type HarnessPortInput = Omit<WorkerRunInput, 'taskId' | 'effort'> & { readonly effort?: HarnessEffort };

const HARNESS_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function isHarnessEffort(effort: string): effort is HarnessEffort {
  return HARNESS_EFFORTS.has(effort);
}

/** F's OpenCode worker (`@jevris/cli/opencode-worker`), or null when it cannot load. */
export async function loadOpencodeWorkerPort(): Promise<WorkerPort | null> {
  try {
    const cli = await import('@jevris/cli/opencode-worker');
    return harnessWorkerPort(cli.opencodeWorkerPort());
  } catch {
    return null;
  }
}

/** F's Kilo Code worker (`@jevris/cli/kilo-worker`), or null when it cannot load. */
export async function loadKiloWorkerPort(): Promise<WorkerPort | null> {
  try {
    const cli = await import('@jevris/cli/kilo-worker');
    return harnessWorkerPort(cli.kiloWorkerPort());
  } catch {
    return null;
  }
}

/** F's Antigravity worker (`@jevris/cli/antigravity-worker`), or null when it cannot load. */
export async function loadAntigravityWorkerPort(): Promise<WorkerPort | null> {
  try {
    const cli = await import('@jevris/cli/antigravity-worker');
    return harnessWorkerPort(cli.antigravityWorkerPort());
  } catch {
    return null;
  }
}

/** Loaders the model-dispatching port uses (test seam). */
export interface WorkerPortLoaders {
  readonly sdk?: () => Promise<WorkerPort | null>;
  readonly codex?: () => Promise<WorkerPort | null>;
  /** F's Claude Code CLI worker (the subscription path, allowed with a key). */
  readonly claude?: () => Promise<WorkerPort | null>;
  readonly opencode?: () => Promise<WorkerPort | null>;
  readonly kilo?: () => Promise<WorkerPort | null>;
  readonly antigravity?: () => Promise<WorkerPort | null>;
}

export interface WorkerPortOptions {
  /** The host config directory holding `workers.json` (auth mode per harness, preferred harness per provider). */
  readonly configDir?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  /**
   * Whether a harness may run owned workers on this host (installed, and later certified for
   * worker.route). Default: every harness whose port loads.
   */
  readonly usable?: (harness: WorkerHarness) => boolean;
  /**
   * The credentials OpenCode or Kilo holds (`<harness> auth list`: provider and type, never a
   * value), or null when they cannot be read. Default: F's reader (not probed in a test run).
   */
  readonly credentials?: (harness: 'opencode' | 'kilo', env: { readonly [key: string]: string | undefined }) => Promise<readonly StoredCredential[] | null>;
  /** The home whose model registry names each model's provider (R5). Default: the bundled registry. */
  readonly home?: string;
  /** The model registry itself (tests); wins over `home`. */
  readonly registry?: ProviderRegistry;
  /**
   * R29, OD-4: the stored per-provider consent (B's point read, through the sidecar's store).
   * A provider the registry marks as needing consent (Kimi, DeepSeek) runs only with a current
   * grant; any other provider runs while the harness holds its login or key, unless revoked.
   * Absent: only the marked providers are refused (no grant can be shown).
   */
  readonly providerConsent?: ProviderConsentReader;
  /** Test seam for F's `opencodeModel` (whether OpenCode or Kilo can name a model). Default: F's export. */
  readonly harnessModelId?: (model: string, harness: 'opencode' | 'kilocode', registry: ModelRegistry | undefined) => string | null;
}

/** A full model registry (the loaded or bundled one), not a test's partial one. */
function isModelRegistry(value: ProviderRegistry): value is ProviderRegistry & ModelRegistry {
  return typeof Reflect.get(value, 'baselineModelId') === 'string' && typeof Reflect.get(value, 'snapshotId') === 'string';
}

/** F's `opencodeModel` (R29), or null when F's module cannot load. */
async function loadHarnessModelId(): Promise<((model: string, harness: 'opencode' | 'kilocode', registry: ModelRegistry | undefined) => string | null) | null> {
  try {
    const cli = await import('@jevris/cli/opencode-worker');
    const fn: unknown = Reflect.get(cli, 'opencodeModel');
    if (typeof fn !== 'function') return null;
    return (model, harness, registry) => {
      try {
        const id: unknown = fn(model, harness, registry);
        return typeof id === 'string' ? id : null;
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}

/** Every provider key variable Jevris knows: a host run's child sees none of them (B's LOW 36). */
const ALL_PROVIDER_KEY_VARS: readonly string[] = Object.values(PROVIDER_KEY_VARS).flat();
/** A serving host id's shape (F's owned-session check). */
const HOST_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** A run refused because no harness that runs the provider can name the model (R29: Kimi on Kilo). */
export const WORKER_MODEL_UNNAMED = 'WORKER_MODEL_UNNAMED';

/** A run refused because the provider has no consent to receive the work (R29, OD-4). */
export const PROVIDER_CONSENT_REQUIRED = 'PROVIDER_CONSENT_REQUIRED';

/**
 * F's reader of the credentials a multi-provider harness holds (`@jevris/cli/harness-auth`
 * `providerCredentials`, 865ffa1): `<harness> auth list`, types only, never a value. It never
 * probes in a test run or under a foreign HOME. Null when it cannot tell or cannot load: `auto`
 * then falls back to the environment and the run records its source as `undetected`.
 */
export async function loadStoredCredentials(harness: 'opencode' | 'kilo', env: { readonly [key: string]: string | undefined }): Promise<readonly StoredCredential[] | null> {
  try {
    const cli = await import('@jevris/cli/harness-auth');
    return await cli.providerCredentials(harness, env);
  } catch {
    return null;
  }
}

const PORT_MISSING: { readonly [H in WorkerHarness]: string } = {
  claude: CLAUDE_CLI_PORT_MISSING_TEXT(),
  codex: 'unsupported: install the Codex CLI (codex) and run jevris install --harness codex',
  opencode: OPENCODE_PORT_MISSING,
  kilo: KILO_PORT_MISSING,
  antigravity: ANTIGRAVITY_PORT_MISSING,
};

function CLAUDE_CLI_PORT_MISSING_TEXT(): string {
  return 'unsupported: install Claude Code (claude), log in, and run jevris install --harness claude';
}

/** Why a Claude-model run cannot start on a subscription login without F's CLI worker. */
export const CLAUDE_CLI_PORT_MISSING = CLAUDE_CLI_PORT_MISSING_TEXT();

/** F's Claude Code CLI worker (`@jevris/cli/claude-worker`), or null when it cannot load. */
export async function loadClaudeCliWorkerPort(): Promise<WorkerPort | null> {
  try {
    const cli = await import('@jevris/cli/claude-worker');
    return harnessWorkerPort(cli.claudeWorkerPort());
  } catch {
    return null;
  }
}

const INIT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A refusal of the dispatching port before any harness port runs: nothing was spawned. */
function unsupportedOutcome(input: WorkerRunInput, reason: string, status: 'unsupported' | 'refused' = 'unsupported'): WorkerRunOutcome {
  return { status, reason, sessionId: null, requestedModel: input.model, actualModel: null, costUsd: null, usage: null, turns: null, durationMs: 0, spawned: false };
}

/** A run's reason when no harness can take the provider's model: each candidate's install hint. */
function noHarnessReason(candidates: readonly WorkerHarness[]): string {
  if (candidates.length === 1) return PORT_MISSING[candidates[0] as WorkerHarness];
  return `unsupported: no installed harness runs this model; ${candidates.map((h) => PORT_MISSING[h].replace(/^unsupported: /, '')).join(', or ')}`;
}

/**
 * The owned-worker port (ORC-05, CDX-04, owner decisions 2026-09-26). Per task:
 *
 * 1. The provider comes from the model (workerProvider).
 * 2. The harness: the one `workers.json` prefers for that provider (only that one, so a missing
 *    preferred harness says "install X"), else the provider's harnesses in order (native first,
 *    then OpenCode, then Kilo), the first whose port loads and that is usable here.
 * 3. The auth mode: the harness's declared mode, else `auto` from the provider's key; on OpenCode
 *    and Kilo, from what the harness holds for the provider (resolveMultiProviderAuth).
 *
 * - Claude on a subscription login: only F's Claude Code CLI worker. The Agent SDK never runs
 *   on a claude.ai login. Claude with an API key: the Agent SDK when installed, else the CLI.
 * - An Anthropic model on OpenCode or Kilo needs ANTHROPIC_API_KEY (never a claude.ai login in a
 *   third-party harness: ANTHROPIC_LOGIN_THIRD_PARTY).
 * - xAI models: OpenCode or Kilo, under the xAI rule in worker-auth.ts (resolveMultiProviderAuth).
 * - Codex, OpenCode, Kilo, Antigravity: F's worker for that harness in the chosen mode.
 *
 * Each outcome records the auth mode that ran and the harness it ran on.
 */
export async function loadWorkerPort(loaders: WorkerPortLoaders = {}, options: WorkerPortOptions = {}): Promise<WorkerPort | null> {
  const sdk = await (loaders.sdk ?? loadSdkWorkerPort)();
  const ports: { readonly [H in WorkerHarness]: WorkerPort | null } = {
    claude: await (loaders.claude ?? loadClaudeCliWorkerPort)(),
    codex: await (loaders.codex ?? loadCodexWorkerPort)(),
    opencode: await (loaders.opencode ?? loadOpencodeWorkerPort)(),
    kilo: await (loaders.kilo ?? loadKiloWorkerPort)(),
    antigravity: await (loaders.antigravity ?? loadAntigravityWorkerPort)(),
  };
  if (sdk === null && Object.values(ports).every((port) => port === null)) return null;
  const env = options.env ?? process.env;
  const registry: ProviderRegistry = options.registry ?? (options.home === undefined ? BUNDLED_MODEL_REGISTRY : ((await loadModelRegistry({ home: options.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY));
  const providerOf = (model: string): WorkerProvider | null => workerProvider(model, registry);
  const usable = options.usable ?? (() => true);
  const available = (harness: WorkerHarness): boolean => usable(harness) && (ports[harness] !== null || (harness === 'claude' && sdk !== null));
  const readSettings = () => (options.configDir === undefined ? ({ ok: true, auth: {} } as const) : readWorkerAuthSettings(options.configDir));
  // R29: OpenCode or Kilo is a candidate only when it can name the model (F's opencodeModel).
  const namer = options.harnessModelId ?? (ports.opencode !== null || ports.kilo !== null ? await loadHarnessModelId() : null);
  const canName = (harness: WorkerHarness, model: string): boolean =>
    (harness !== 'opencode' && harness !== 'kilo') || namer === null || namer(model, harness === 'kilo' ? 'kilocode' : 'opencode', isModelRegistry(registry) ? registry : undefined) !== null;
  const full = isModelRegistry(registry) ? registry : null;
  const candidatesFor = (provider: WorkerProvider, settings: WorkerAuthSettings, model: string, route: HostRoute | null = null): readonly WorkerHarness[] => {
    const preferred = settings.ok ? settings.harness?.[provider] : undefined;
    if (route !== null) {
      // R52: only a harness with the host's row and a spelling of the model there (OpenCode, Kilo).
      // A preference for the maker holds when it can reach a host at all.
      const hosts: readonly WorkerHarness[] = preferred === 'opencode' || preferred === 'kilo' ? [preferred] : ['opencode', 'kilo'];
      return full === null ? [] : hosts.filter((harness) => hostReachable(full, harness, route));
    }
    const listed = preferred === undefined ? providerHarnesses(provider, registry) : [preferred];
    return listed.filter((harness) => canName(harness, model));
  };
  /** R52: the run's pinned-host route; null is the maker's own route. */
  const routeOf = (model: string, servingHost: string | undefined): HostRoute | null | typeof HOST_ROUTE_UNKNOWN =>
    full === null ? (servingHost === undefined ? null : HOST_ROUTE_UNKNOWN) : hostRouteOfRun(full, model, servingHost);
  /** The provider of a run: the maker behind a host route, else the model's. */
  const makerOf = (model: string, route: HostRoute | null): WorkerProvider | null => (route === null ? providerOf(model) : providerOf([route.provider, route.modelId].join('/')));
  /** R29, OD-4: whether the provider may receive this work; the refusal's reason code otherwise. */
  const consentFor = (provider: WorkerProvider, signedIn: boolean): string | null => {
    if (options.providerConsent === undefined) {
      const marked = registry.entries.some((e) => e.provider === provider && e.requiresProviderConsent === true);
      return marked ? PROVIDER_CONSENT_REQUIRED : null;
    }
    // C's gate reads only each entry's provider and requiresProviderConsent, which ProviderRegistry carries.
    const gate = providerConsentGate(registry as unknown as Parameters<typeof providerConsentGate>[0], signedIn ? [provider] : [], options.providerConsent);
    if (gate.consentedProviders.includes(provider)) return null;
    return gate.blocked.find((b) => b.provider === provider)?.reasonCode ?? PROVIDER_CONSENT_REQUIRED;
  };
  /** c065d52: whether a harness on this machine has run one of the provider's models (C's model offer). */
  const ranHere = async (provider: WorkerProvider): Promise<boolean> => {
    if (options.home === undefined || !isModelRegistry(registry)) return false;
    const offer = await readModelOffer(options.home).catch(() => null);
    return ranHereProviders(registry, offer).includes(provider);
  };
  /**
   * R52, design 5.1: a route through a pinned host needs the maker's consent, the host's and no
   * block on a host it forwards to (core `routeConsentGate`). Signed in: the host when its sign-in
   * is seen, and the parties a harness here has run a model through (RAN_HERE); a gateway sign-in
   * never signs in the maker behind it. With no consent reader nothing can be shown: refused.
   */
  const hostConsentFor = async (route: HostRoute, hostSignedIn: boolean): Promise<string | null> => {
    const read = options.providerConsent;
    if (read === undefined || full === null) return `${HOST_CONSENT_REQUIRED}: ${route.servingHost} and ${route.provider} have no consent Jevris can read; grant them with jevris consent provider <id> --grant`;
    const offer = options.home === undefined ? null : await readModelOffer(options.home).catch(() => null);
    const signedIn = new Set(ranHereParties(full, offer));
    if (hostSignedIn) signedIn.add(route.servingHost);
    const gate = routeConsentGate(full, [...signedIn].sort(), read, { provider: route.provider, servingHost: route.servingHost, via: 'host' });
    if (gate.allowed) return null;
    const why = gate.downstream ? `${gate.party}, which ${route.servingHost} forwards to, has withdrawn consent` : `${gate.party} has no current consent to receive this work through ${route.servingHost}`;
    return `${gate.reasonCode}: ${why}; grant it with jevris consent provider ${gate.party} --grant`;
  };
  // The harness's credential list is read once per port (one `auth list` per harness).
  const readCredentials = options.credentials ?? loadStoredCredentials;
  const held = new Map<'opencode' | 'kilo', Promise<readonly StoredCredential[] | null>>();
  const credentialsOf = (harness: 'opencode' | 'kilo'): Promise<readonly StoredCredential[] | null> => {
    let answer = held.get(harness);
    if (answer === undefined) {
      answer = readCredentials(harness, env).catch(() => null);
      held.set(harness, answer);
    }
    return answer;
  };
  /** The run's auth mode and its source, per harness and model provider (null harness: not installed, nothing is read). */
  const resolveAuth = async (harness: WorkerHarness | null, probeHarness: WorkerHarness, provider: WorkerProvider, settings: WorkerAuthSettings & { readonly ok: true }, route: HostRoute | null = null): Promise<ResolvedWorkerAuth> => {
    const setting = settings.auth[probeHarness];
    // R52: a host route signs in to the host, by the harness's row for it, never by the maker's rule.
    if (route !== null && full !== null && (probeHarness === 'opencode' || probeHarness === 'kilo')) {
      return resolveHostAuth(full, probeHarness, route.servingHost, setting, env, harness === null ? null : await credentialsOf(probeHarness));
    }
    if (probeHarness === 'opencode' || probeHarness === 'kilo') return resolveMultiProviderAuth(provider, setting, env, harness === null ? null : await credentialsOf(probeHarness));
    return { ok: true, ...vendorAuth(probeHarness, provider, setting, env) };
  };
  return {
    async authFor(model, servingHost) {
      const settings = readSettings();
      if (!settings.ok) return null;
      const route = routeOf(model, servingHost);
      if (route === HOST_ROUTE_UNKNOWN) return null;
      const provider = makerOf(model, route);
      if (provider === null) return null;
      const candidates = candidatesFor(provider, settings, model, route);
      const harness = candidates.find(available) ?? null;
      if (harness === null) return null;
      const resolved = await resolveAuth(harness, harness, provider, settings, route);
      return resolved.ok ? { mode: resolved.mode, source: resolved.source } : null;
    },
    harnessFor(model, servingHost) {
      const settings = readSettings();
      if (!settings.ok) return null;
      const route = routeOf(model, servingHost);
      if (route === HOST_ROUTE_UNKNOWN) return null;
      const provider = makerOf(model, route);
      return provider === null ? null : (candidatesFor(provider, settings, model, route).find(available) ?? null);
    },
    async run(input) {
      const route = routeOf(input.model, input.servingHost);
      if (route === HOST_ROUTE_UNKNOWN) {
        // B's nit: the host is echoed only in a host id's shape, never as a free string.
        const host = typeof input.servingHost === 'string' && HOST_ID.test(input.servingHost) ? input.servingHost : 'an unknown host';
        return unsupportedOutcome(input, `${HOST_ROUTE_UNKNOWN}: ${input.model.slice(0, 128)} through ${host} is not a pinned host's route for a registered model`, 'refused');
      }
      const provider = makerOf(input.model, route);
      // An id no registry entry or model family names is refused, never run on Claude (R5).
      if (provider === null) return unsupportedOutcome(input, `${WORKER_PROVIDER_UNKNOWN}: no known provider runs this model`, 'refused');
      const settings = readSettings();
      if (!settings.ok) return unsupportedOutcome(input, `refused: ${settings.problem}`, 'refused');
      const candidates = candidatesFor(provider, settings, input.model, route);
      if (candidates.length === 0) {
        const where = route === null ? `no harness that runs ${provider} can name ${input.model.slice(0, 128)}` : `no harness here reaches ${route.provider}'s ${route.modelId} through ${route.servingHost}`;
        return unsupportedOutcome(input, `${WORKER_MODEL_UNNAMED}: ${where}`, 'refused');
      }
      const harness = candidates.find(available) ?? null;
      const probeHarness = harness ?? (candidates[0] as WorkerHarness);
      // The auth rule comes before any port. On OpenCode and Kilo it follows what the harness holds
      // for the model's provider (billing correctness: a stored key is never recorded as a
      // subscription); the xAI rule (DOMAINS 72ff950) is part of it. A host route signs in to the host.
      const resolved = await resolveAuth(harness, probeHarness, provider, settings, route);
      const auth = resolved.mode;
      const authSource = resolved.source;
      if (!resolved.ok) return { ...unsupportedOutcome(input, resolved.reason, 'refused'), authMode: auth, authSource };
      if (harness === null) return { ...unsupportedOutcome(input, noHarnessReason(candidates)), authMode: auth, authSource };
      if (route !== null) {
        // R52, design 5.1: the (host, maker) pair's consent.
        const refusedPair = await hostConsentFor(route, signedInSource(authSource));
        if (refusedPair !== null) return { ...unsupportedOutcome(input, refusedPair, 'refused'), authMode: auth, authSource };
      } else {
        // OD-4: content goes to a provider only with its consent; Kimi and DeepSeek always ask.
        // Owner decision c065d52 (finding 8): signed in is a seen sign-in (declared, environment,
        // stored key or login) or a harness here having run the provider's model (RAN_HERE); an
        // undetected sign-in alone never is.
        const refusedConsent = consentFor(provider, signedInSource(authSource) || (await ranHere(provider)));
        if (refusedConsent !== null) {
          return { ...unsupportedOutcome(input, `${refusedConsent}: ${provider} has no current consent to receive this work; grant it with jevris consent provider ${provider} --grant`, 'refused'), authMode: auth, authSource };
        }
      }
      // A claude.ai login is never used outside Claude Code; a host's own sign-in is not one.
      if (route === null && provider === 'anthropic' && (harness === 'opencode' || harness === 'kilo') && auth === 'subscription') {
        return {
          ...unsupportedOutcome(input, `${ANTHROPIC_LOGIN_THIRD_PARTY}: an Anthropic model on ${harness} needs ANTHROPIC_API_KEY; a claude.ai login runs only in Claude Code`, 'refused'),
          authMode: auth,
          authSource,
        };
      }
      let port = ports[harness];
      let viaSdk = false;
      // An API-key Claude run goes through the Agent SDK, which takes the effort as its `effort`
      // option (G21); a Haiku model has none and keeps its default, recorded as such.
      if (harness === 'claude' && auth === 'api-key' && sdk !== null) [port, viaSdk] = [sdk, true];
      if (port === null) return { ...unsupportedOutcome(input, PORT_MISSING[harness]), authMode: auth, authSource };
      const { auth: _declared, effort, onSessionId, servingHost: _host, ...given } = input;
      // R52: F's port gets the registry id plus the host, and spells it on the host itself.
      const base = route === null ? given : { ...given, model: route.modelId, servingHost: route.servingHost };
      // The runner learns which harness the session id belongs to (a plan link needs it).
      const rest = onSessionId === undefined ? base : { ...base, onSessionId: (sessionId: string) => onSessionId(sessionId, harness) };
      const applied = effort === undefined ? null : effort;
      // A harness CLI run gets the provider's environment for its mode: a subscription run never
      // sees the provider's API keys (the harness does its own login; Jevris never touches it).
      const loaded = isModelRegistry(registry) ? { registry } : {};
      const runEnv = route === null ? providerEnv(provider, auth, env) : hostEnv(route, auth, ALL_PROVIDER_KEY_VARS, env);
      // Only this port's own refusals above say nothing was spawned; a harness port's word never does.
      const { spawned: _spawned, ...outcome } = await port.run(viaSdk ? { ...rest, ...(applied === null ? {} : { effort: applied }) } : { ...rest, auth, env: runEnv, ...(applied === null ? {} : { effort: applied }), ...loaded });
      const reported = outcome.authMode === 'api-key' || outcome.authMode === 'subscription' ? outcome.authMode : undefined;
      const authMode = reported ?? (viaSdk ? 'api-key' : auth);
      // The effort the port actually passed (F maps some levels down, and Haiku takes none), else
      // the one handed to it; null is the model's default.
      const ranEffort = outcome.effort !== undefined ? outcome.effort : applied;
      // xAI: a harness's 403 or 401 is named, never a generic failure (plan eligibility for
      // third-party harnesses is unconfirmed).
      const named = route === null && provider === 'xai' && outcome.status !== 'completed' && outcome.status !== 'model-unavailable' ? xaiAuthFailure(outcome.reason) : null;
      if (named !== null) {
        const hint =
          named === XAI_PLAN_NOT_ELIGIBLE
            ? `${harness} was refused by xAI (HTTP 403): SuperGrok plan eligibility for third-party harnesses is unconfirmed; use XAI_API_KEY or a plan xAI enables for ${harness}`
            : `${harness} could not authenticate to xAI (HTTP 401 or no login): sign in again in ${harness}, or set XAI_API_KEY`;
        return { ...outcome, status: 'refused', reason: `${named}: ${hint}`, authMode, authSource, harness, effort: ranEffort };
      }
      // A failed first-use check that stopped the run names its reason code first (for the task's
      // reason, status and doctor); F's port has already recorded it and demoted worker.route.
      const init = outcome.initCheck;
      if (init?.ok === false && outcome.status === 'refused' && typeof init.reasonCode === 'string' && INIT_CODE.test(init.reasonCode) && !outcome.reason.startsWith(init.reasonCode)) {
        return { ...outcome, reason: `${init.reasonCode}: ${outcome.reason.replace(/^refused: /, '')}`.slice(0, 500), authMode, authSource, harness, effort: ranEffort };
      }
      return { ...outcome, authMode, authSource, harness, effort: ranEffort };
    },
  };
}

// -------------------------------------------------------------------- owned-session registry

/**
 * Owner decision 29423b6: the harness session id a port reports at start is written to this
 * lease's running owned session, so approvedScopeFor finds the task by the session's own hook
 * events while the run is live, not only after it ends. Only the lease's own record, only while
 * it runs and only once: a newer lease's record, an ended one and an id already bound are left
 * alone. The id is capped at 128 characters, as F's ports cap it.
 */
async function bindOwnedSession(ws: WorkspaceServices, lease: { readonly id: string; readonly taskId: string }, sessionId: string, harness: WorkerHarness | undefined): Promise<void> {
  const id = typeof sessionId === 'string' ? sessionId.slice(0, 128) : '';
  if (id === '') return;
  const key = sessionKey(ws.workspaceId, lease.taskId);
  const bound = await ws.host.transact((tx) => {
    const session = tx.get<OwnedSessionRecord>('owned-sessions', key);
    if (session === undefined || session.leaseId !== lease.id || session.state !== 'running' || session.sessionId !== null) return false;
    tx.put('owned-sessions', key, { ...session, sessionId: id, ...(harness === undefined ? {} : { harness }) });
    return true;
  });
  const hookHarness = harness === undefined ? undefined : PLAN_LINK_HARNESS[harness];
  if (bound && hookHarness !== undefined) {
    if (plannedLinks.size >= PLANNED_LINKS_MAX) plannedLinks.delete(plannedLinks.keys().next().value as string);
    plannedLinks.set(id, { workspaceId: ws.workspaceId, taskId: lease.taskId, leaseId: lease.id, harness: hookHarness });
  }
}

/** A plan link waiting for its session's first event in the sidecar (owner decision 29423b6). */
export interface PlannedLink {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly leaseId: string;
  /** The harness as its hook events name it (Kilo's is `kilocode`). */
  readonly harness: string;
}

/** The owned-worker harnesses whose main-session turns can be switched (OD-8), by hook name. */
const PLAN_LINK_HARNESS: { readonly [H in WorkerHarness]?: string } = { kilo: 'kilocode', opencode: 'opencode' };
const PLANNED_LINKS_MAX = 256;
const plannedLinks = new Map<string, PlannedLink>();

/** The plan link waiting for this session, if any; taken once (the subscriber makes the link). */
export function takePlannedLink(sessionId: string, harness: string): PlannedLink | undefined {
  const link = plannedLinks.get(sessionId);
  if (link === undefined || link.harness !== harness) return undefined;
  plannedLinks.delete(sessionId);
  return link;
}

/** Puts back a plan link whose session the store has not recorded yet. */
export function keepPlannedLink(sessionId: string, link: PlannedLink): void {
  if (!plannedLinks.has(sessionId) && plannedLinks.size < PLANNED_LINKS_MAX) plannedLinks.set(sessionId, link);
}

function dropPlannedLinks(leaseId: string): void {
  for (const [sessionId, link] of plannedLinks) if (link.leaseId === leaseId) plannedLinks.delete(sessionId);
}

export interface OwnedSessionRecord {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly worktreeId: string;
  readonly holder: ProcessIdentity;
  readonly sessionId: string | null;
  /** The harness the run went to, once its session id is bound. */
  readonly harness?: WorkerHarness;
  readonly state: 'running' | 'ended';
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly outcome: string | null;
}

export interface WorkerRunRecord {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly worktreeId: string | null;
  readonly status: WorkerRunOutcome['status'];
  readonly reason: string;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly costUsd: number | null;
  readonly usage: WorkerRunOutcome['usage'];
  readonly turns: number | null;
  readonly durationMs: number;
  readonly sessionId: string | null;
  readonly changedPaths: readonly string[];
  readonly pathViolations: readonly string[];
  readonly endedAtMs: number;
  /** The store operation id of this run's owned effect. */
  readonly effectOperationId?: string;
  /** How the owned effect settled: acknowledged, failed, or held by the kill switch. */
  readonly effectState?: 'acknowledged' | 'failed' | 'held' | 'abandoned' | 'unrecorded';
  /** A late result: the run ended after a newer lease owned the task, so it changed nothing (W04). */
  readonly stale?: true;
  /** The auth mode the run used (C prices a key in dollars and a subscription in usage limits). */
  readonly authMode?: WorkerAuthMode | 'unknown';
  /** Where the auth mode came from (declared, environment, stored-login, stored-key, nothing-stored, undetected). */
  readonly authSource?: WorkerAuthSource;
  /** For a usage-limit stop: when the harness said the limit lifts. */
  readonly resetAt?: string;
  /** The harness the run used. */
  readonly harness?: WorkerHarness;
  /** The effort the run was given (null or absent: the model's default). */
  readonly effort?: string | null;
  /**
   * A `model-unavailable` run: what was found, and whether C's machine record took it
   * (RECORDED, or LOCK_BUSY, WRITE_FAILED, INVALID_INPUT: the task's result stands either way).
   */
  readonly modelUnavailable?: ModelUnavailableFinding & { readonly recorded: string };
  /**
   * The access limit the runner classified from the run's signal (R70), and what the machine
   * record did with it: RECORDED, NOT_A_PAUSE (overloaded), or the record's refusal code.
   */
  readonly accessLimit?: AccessLimitFinding & {
    readonly recorded: string;
    /** The port reported another harness than the one launched; the limit went under the launch's. */
    readonly harnessMismatch?: true;
  };
  /** The dispatching port refused before any child started (WorkerRunOutcome.spawned): settled at 0. */
  readonly spawned?: false;
}

/** An ISO 8601 instant as the ports write a reset time (UTC, `Z`); anything else is not shown. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The owned-effect operation id for a lease (store id pattern, at most 64 characters). */
export function effectOperationId(leaseId: string): string {
  return `op-${leaseId.replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 64);
}

/** In-process abort handles, by task. Other processes are reached through cancel requests. */
const running = new Map<string, AbortController>();
/** In-process runs by task, resolved once the run has published its end (so a cancel can answer with it). */
const settling = new Map<string, Promise<void>>();

function sessionKey(workspaceId: string, taskId: string): string {
  return recordKey(workspaceId, taskId);
}

export function ownedSessions(ws: WorkspaceServices): readonly OwnedSessionRecord[] {
  return ws.host.list<OwnedSessionRecord>('owned-sessions').filter((s) => s.workspaceId === ws.workspaceId);
}

export function workerRuns(ws: WorkspaceServices, taskId?: string): readonly WorkerRunRecord[] {
  return ws.host
    .list<WorkerRunRecord>('worker-runs')
    .filter((r) => r.workspaceId === ws.workspaceId && (taskId === undefined || r.taskId === taskId))
    .sort((a, b) => a.endedAtMs - b.endedAtMs);
}

// --------------------------------------------------------------------------------- running

export interface RunLeasedTaskOptions {
  readonly authority: LeaseAuthority;
  readonly port: WorkerPort | null;
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly prompt: string;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly timeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly baseCommit?: string;
  readonly now?: () => number;
  /** The routed effort (C16); absent runs with no effort setting. */
  readonly effort?: string;
  /**
   * The decision clock (the engine's, `engineNow`) for what a run records about the model: a
   * found-gone entry is stamped with it. Leases and heartbeats keep `now`. Default: `now`.
   */
  readonly decisionNow?: () => number;
  /**
   * Where an API-key launch's key is read to fingerprint it (access limits, design 4.4); the
   * key itself is never kept. Default: this process's environment.
   */
  readonly env?: { readonly [key: string]: string | undefined };
  /**
   * R52: the pinned serving host the run goes through (the task's session host), with `model` the
   * registry id. The dispatching port spells the model there and refuses it rather than run direct.
   */
  readonly servingHost?: string;
}

export interface RunLeasedTaskResult {
  readonly taskId: string;
  readonly finalState: TaskRecord['node']['state'] | 'unchanged';
  readonly run: WorkerRunRecord | null;
  readonly reasonCode: string;
}

function microUsd(costUsd: number | null): number | null {
  return costUsd === null ? null : Math.round(costUsd * 1_000_000);
}

/**
 * R52: a leased task that is not launched at all (a route through the session's host that did not
 * launch): it blocks with the fixed reason and its lease is released with nothing spent. No owned
 * effect was begun, so there is nothing to settle.
 */
export async function refuseLeasedTask(ws: WorkspaceServices, grant: LeaseGrant, options: { readonly authority: LeaseAuthority; readonly reason: string; readonly reasonCode: string; readonly now?: () => number }): Promise<RunLeasedTaskResult> {
  const now = options.now ?? Date.now;
  const { lease } = grant;
  const published = await options.authority.publishFenced(ws.workspaceId, lease.taskId, lease.fencingToken, () => taskTransition(ws, lease.taskId, 'blocked', options.reason, { actor: 'runner', nowMs: now(), patch: { leaseId: null } }), now());
  // A newer lease owns the task now: it is not blocked here, and its lease is not ours to release.
  if (!published.ok) return { taskId: lease.taskId, finalState: 'unchanged', run: null, reasonCode: published.reasonCode };
  await options.authority.release(ws.workspaceId, lease.id, lease.fencingToken, { actualMicroUsd: 0 }, now(), options.reason);
  return { taskId: lease.taskId, finalState: 'blocked', run: null, reasonCode: options.reasonCode };
}

export async function runLeasedTask(ws: WorkspaceServices, grant: LeaseGrant, options: RunLeasedTaskOptions): Promise<RunLeasedTaskResult> {
  const key = sessionKey(ws.workspaceId, grant.lease.taskId);
  let release = (): void => {};
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  settling.set(key, settled);
  try {
    return await runLeasedTaskOnce(ws, grant, options);
  } finally {
    if (settling.get(key) === settled) settling.delete(key);
    release();
  }
}

async function runLeasedTaskOnce(ws: WorkspaceServices, grant: LeaseGrant, options: RunLeasedTaskOptions): Promise<RunLeasedTaskResult> {
  const now = options.now ?? Date.now;
  const { lease } = grant;
  const task = getTask(ws, lease.taskId);
  if (task === undefined) return { taskId: lease.taskId, finalState: 'unchanged', run: null, reasonCode: 'UNKNOWN_TASK' };
  const release = (spend: number | null, reason: string) => options.authority.release(ws.workspaceId, lease.id, lease.fencingToken, { actualMicroUsd: spend }, now(), reason);
  const block = async (reason: string, code: string): Promise<RunLeasedTaskResult> => {
    await options.authority.publishFenced(ws.workspaceId, lease.taskId, lease.fencingToken, () => taskTransition(ws, lease.taskId, 'blocked', reason, { actor: 'runner', nowMs: now(), patch: { leaseId: null } }), now());
    await release(0, reason);
    return { taskId: lease.taskId, finalState: 'blocked', run: null, reasonCode: code };
  };
  if (options.port === null) return block('owned workers are unsupported: install @anthropic-ai/claude-agent-sdk', 'WORKER_UNSUPPORTED');
  // The run is an external effect: record it as pending before anything happens, so the kill
  // switch can hold it. No record, no run.
  const operationId = effectOperationId(lease.id);
  const begun = ws.store === undefined ? { ok: false as const, reason: 'store-unavailable' } : beginOwnedEffect(ws.store, { operationId, kind: 'owned-worker', reservationMicroUsd: BigInt(Math.max(0, Math.round(grant.reservation.reservedMicroUsd))), nowMs: now() });
  if (!begun.ok) return block(`owned effect not recorded: ${begun.reason}`, 'OWNED_EFFECT_UNRECORDED');
  if (begun.existing && begun.state !== 'pending') return block(`owned effect ${operationId} is already ${begun.state}`, 'OWNED_EFFECT_EXISTS');
  const settle = (outcome: 'applied' | 'failed', spend: number | null) => {
    if (ws.store === undefined) return 'unrecorded' as const;
    const r = settleOwnedEffect(ws.store, { operationId, outcome, actualMicroUsd: spend === null ? null : BigInt(Math.max(0, spend)), nowMs: now() });
    return r.ok ? r.state : ('unrecorded' as const);
  };
  // A model found gone here (or not accessible from this harness and sign-in) is never launched
  // again: the task fails with the reason, and the effect recorded above settles failed with
  // nothing spent (C's found-gone record). The effect is recorded first, so the kill switch can
  // hold any run from the moment it is leased.
  const gone = await modelUnavailableHere(ws.home, options.model, options.port);
  if (gone !== null) {
    const state = settle('failed', 0);
    if (state === 'held' || state === 'abandoned') return block(`owned effect ${operationId} is held by the kill switch: reconcile it after clear`, 'OWNED_EFFECT_HELD');
    const reason = `model ${options.model} is not available here (${gone}); it is not launched again until the registry is refreshed or jevris route learning gone clear`;
    await options.authority.publishFenced(ws.workspaceId, lease.taskId, lease.fencingToken, () => taskTransition(ws, lease.taskId, 'failed', reason, { actor: 'runner', nowMs: now(), patch: { leaseId: null } }), now());
    await release(0, reason);
    return { taskId: lease.taskId, finalState: 'failed', run: null, reasonCode: 'MODEL_UNAVAILABLE' };
  }
  // Access limits (R70, design E9): a scope paused on this machine launches nothing. The effect
  // settles failed with nothing spent, and the task blocks with the pause's fixed reason and an
  // access-blocked row, which the resume tick reads (R76). A record that cannot be read never
  // blocks a launch.
  const decisionNow = options.decisionNow ?? now;
  const accessKey = sessionKey(ws.workspaceId, lease.taskId);
  const launchHarness = options.port.harnessFor?.(options.model, options.servingHost) ?? null;
  const launchAuth = launchHarness === null || options.port.authFor === undefined ? null : ((await options.port.authFor(options.model, options.servingHost).catch(() => null))?.mode ?? null);
  const accessRegistry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const launch = launchHarness === null ? null : await launchAccessCheck({ home: ws.home, registry: accessRegistry, harness: launchHarness, model: options.model, authMode: launchAuth ?? 'unknown', env: options.env ?? process.env, nowMs: decisionNow(), ...(options.servingHost === undefined ? {} : { servingHost: options.servingHost }) });
  if (launch !== null && launch.pause !== null) {
    const pause = launch.pause;
    const state = settle('failed', 0);
    if (state === 'held' || state === 'abandoned') return block(`owned effect ${operationId} is held by the kill switch: reconcile it after clear`, 'OWNED_EFFECT_HELD');
    // OP-5: a limit again after the one automatic resume promises none (the row below says the same).
    const reason = accessReason({ pause }, { autoResume: !accessRepeat(ws.host.get<AccessBlockedRow>(ACCESS_BLOCKED_COLLECTION, accessKey), pause.class) });
    const at = now();
    await options.authority.publishFenced(
      ws.workspaceId,
      lease.taskId,
      lease.fencingToken,
      (tx) => {
        const previous = tx.get<AccessBlockedRow>(ACCESS_BLOCKED_COLLECTION, accessKey);
        tx.put(ACCESS_BLOCKED_COLLECTION, accessKey, accessBlockedRow({ workspaceId: ws.workspaceId, taskId: lease.taskId, previous, class: pause.class, scopeKey: pause.entry.key, untilMs: pause.untilMs, nowMs: at, run: launchHarness === null ? null : { harness: launchHarness, model: options.model, authMode: launchAuth ?? 'unknown', servingHost: options.servingHost } }));
        return taskTransition(ws, lease.taskId, 'blocked', reason, { actor: 'runner', nowMs: at, patch: { leaseId: null } });
      },
      at,
    );
    await release(0, reason);
    return { taskId: lease.taskId, finalState: 'blocked', run: null, reasonCode: 'ACCESS_LIMITED' };
  }
  const created = await createWorktree(ws, { taskId: lease.taskId, allowedPaths: task.node.writeScopes, ...(options.baseCommit === undefined ? {} : { baseCommit: options.baseCommit }) });
  if (!created.ok) {
    settle('failed', 0);
    return block(`worktree: ${created.reasonCode}`, created.reasonCode);
  }
  const worktree = created.worktree;
  const started = await options.authority.publishFenced(
    ws.workspaceId,
    lease.taskId,
    lease.fencingToken,
    (tx) => {
      const moved = taskTransition(ws, lease.taskId, 'running', 'WORKER_STARTED', { actor: 'runner', nowMs: now() });
      if (!moved.ok) return false;
      tx.put('owned-sessions', sessionKey(ws.workspaceId, lease.taskId), {
        workspaceId: ws.workspaceId,
        taskId: lease.taskId,
        leaseId: lease.id,
        worktreeId: worktree.id,
        holder: selfIdentity(),
        sessionId: null,
        state: 'running',
        startedAtMs: now(),
        endedAtMs: null,
        outcome: null,
      } satisfies OwnedSessionRecord);
      return moved.ok;
    },
    now(),
  );
  if (!started.ok || !started.value) {
    settle('failed', 0);
    await retainWorktree(ws, worktree.id, 'lease lost before start');
    return { taskId: lease.taskId, finalState: 'unchanged', run: null, reasonCode: started.ok ? 'ILLEGAL_TRANSITION' : started.reasonCode };
  }
  const controller = new AbortController();
  running.set(sessionKey(ws.workspaceId, lease.taskId), controller);
  let cancelled = false;
  let leaseLost = false;
  const ttl = Date.parse(lease.expiresAt) - Date.parse(lease.heartbeatAt);
  const beat = setInterval(() => {
    void (async () => {
      const request = ws.host.get<{ readonly reason: string }>('cancel-requests', sessionKey(ws.workspaceId, lease.taskId));
      if (request !== undefined) {
        cancelled = true;
        controller.abort();
        return;
      }
      const hb = await options.authority.heartbeat(ws.workspaceId, lease.id, lease.fencingToken, now());
      if (!hb.ok) {
        leaseLost = true;
        controller.abort();
      }
    })();
  }, options.heartbeatMs ?? Math.max(1_000, Math.floor(ttl / 3)));
  let outcome: WorkerRunOutcome;
  let binding: Promise<unknown> = Promise.resolve();
  try {
    outcome = await options.port.run({
      taskId: lease.taskId,
      prompt: options.prompt,
      model: options.model,
      cwd: worktree.path,
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns ?? 40,
      maxBudgetUsd: options.maxBudgetUsd ?? Math.max(0.01, grant.reservation.reservedMicroUsd / 1_000_000),
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      signal: controller.signal,
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.servingHost === undefined ? {} : { servingHost: options.servingHost }),
      onStart: (control) => {
        void control;
      },
      onSessionId: (sessionId, harness) => {
        binding = bindOwnedSession(ws, lease, sessionId, harness).catch(() => undefined);
      },
    });
    await binding;
  } finally {
    clearInterval(beat);
    // Only this run's own handle (K6): a newer run of the task may already have registered its own.
    const key = sessionKey(ws.workspaceId, lease.taskId);
    if (running.get(key) === controller) running.delete(key);
    dropPlannedLinks(lease.id);
  }
  const cancelRequest = ws.host.get<{ readonly reason?: unknown }>('cancel-requests', sessionKey(ws.workspaceId, lease.taskId));
  if (cancelRequest !== undefined) cancelled = true;
  const cancelReason = typeof cancelRequest?.reason === 'string' && cancelRequest.reason !== '' ? cancelRequest.reason.slice(0, 200) : 'cancelled by the user';
  const paths = await enforceAllowedPaths(worktree);
  // A model found gone at launch goes on C's machine record under the model this run asked for
  // (never an observed substitute), at the decision clock. A failed write never fails the task.
  const finding = outcome.status === 'model-unavailable' ? validFinding(outcome.modelUnavailable) : null;
  let recorded = 'NOT_RECORDED';
  if (finding !== null) {
    try {
      const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
      const result = await recordModelUnavailable({ home: ws.home, modelId: options.model, reasonCode: finding.reasonCode, port: finding.port, authMode: finding.authMode, source: 'launch', nowMs: (options.decisionNow ?? now)(), registry });
      recorded = result.ok ? 'RECORDED' : result.reasonCode;
    } catch {
      recorded = 'WRITE_FAILED';
    }
  }
  // An access signal is classified again here, in the process that records it (R70): the
  // worker's own finding is only its claim. A pausing class goes on the machine record under
  // the run's scope; the task blocks whatever status the port reported, since an access limit is
  // never the task's failure.
  const accessSignal = outcome.status === 'completed' ? null : wireSignalOf(outcome.accessSignal);
  // The launch's harness wins over the port's report, so a port bug can never pause or clear
  // another harness's scope; a mismatch shows on the run record.
  const portHarness = outcome.harness ?? null;
  const runHarness = launchHarness ?? portHarness;
  const harnessMismatch = launchHarness !== null && portHarness !== null && portHarness !== launchHarness;
  const runAuth = (harnessMismatch ? null : outcome.authMode) ?? launchAuth ?? 'unknown';
  // OP-4: the signal is trusted only when the harness's signed record certifies access.detect at
  // its installed version (F's K16-K18); OP-11: a pause with no reported reset is timed from the
  // workspace's limitCooldownHours.
  const recordAccess = async (signal: AccessSignalWire, harness: WorkerHarness): Promise<RunAccessResult | null> => {
    const nowMs = decisionNow();
    const certified = await accessCertified({ home: ws.home, harness, featureId: 'access.detect', nowMs });
    const baseHours = await limitCooldownHoursOf(ws.home, ws.workspaceId);
    return recordRunAccess({ home: ws.home, registry: accessRegistry, signal, certified, harness, model: options.model, reportedModel: outcome.actualModel, authMode: runAuth, fingerprint: launch?.fingerprint ?? null, nowMs, ...(options.servingHost === undefined ? {} : { servingHost: options.servingHost }), ...(baseHours === undefined ? {} : { baseHours }) });
  };
  const access: RunAccessResult | null = accessSignal === null || runHarness === null ? null : await recordAccess(accessSignal, runHarness);
  const previousBlock = ws.host.get<AccessBlockedRow>(ACCESS_BLOCKED_COLLECTION, accessKey);
  const overloadAttempt = access?.classification.class === 'overloaded' ? nextOverloadAttempt(previousBlock) : null;
  const overloadRetry = overloadAttempt === null ? null : overloadRetryAt(overloadAttempt, now());
  // The pre-spawn release: a refusal before any child started is a known zero effect, so the
  // effect and the lease settle at 0, never as unknown spend held for reconciliation.
  const notSpawned = outcome.spawned === false;
  const spend = notSpawned ? 0 : microUsd(outcome.costUsd);
  // Settle the effect. A held effect answers `held` and stays held with its reservation.
  const effectState = settle(outcome.status === 'completed' ? 'applied' : 'failed', spend);
  const held = effectState === 'held' || effectState === 'abandoned';
  const endedAtMs = now();
  const run: WorkerRunRecord = {
    workspaceId: ws.workspaceId,
    taskId: lease.taskId,
    leaseId: lease.id,
    worktreeId: worktree.id,
    status: outcome.status,
    reason: outcome.reason,
    requestedModel: outcome.requestedModel,
    actualModel: outcome.actualModel,
    costUsd: outcome.costUsd,
    usage: outcome.usage,
    turns: outcome.turns,
    durationMs: outcome.durationMs,
    sessionId: outcome.sessionId,
    changedPaths: paths.changed,
    pathViolations: paths.violations,
    endedAtMs,
    effectOperationId: operationId,
    effectState,
    ...(outcome.authMode === undefined ? {} : { authMode: outcome.authMode }),
    ...(outcome.authSource === undefined ? {} : { authSource: outcome.authSource }),
    ...(outcome.resetAt === undefined ? {} : { resetAt: outcome.resetAt.slice(0, 40) }),
    ...(runHarness === null ? {} : { harness: runHarness }),
    ...(outcome.effort !== undefined ? { effort: outcome.effort } : options.effort === undefined ? {} : { effort: options.effort }),
    ...(finding === null ? {} : { modelUnavailable: { ...finding, recorded } }),
    ...(access === null ? {} : { accessLimit: { ...access.finding, recorded: access.recorded, ...(harnessMismatch ? { harnessMismatch: true as const } : {}) } }),
    ...(notSpawned ? { spawned: false as const } : {}),
  };
  let to: TaskRecord['node']['state'];
  let reason: string;
  if (held) [to, reason] = ['blocked', `owned effect ${operationId} is held by the kill switch: reconcile it after clear`];
  else if (cancelled) [to, reason] = ['cancelled', cancelReason];
  else if (leaseLost) [to, reason] = ['blocked', 'lease lost during the run: reconcile before rescheduling'];
  else if (outcome.status === 'completed' && paths.unknown) [to, reason] = ['blocked', 'the worktree diff could not be read'];
  else if (outcome.status === 'completed' && !paths.ok) [to, reason] = ['failed', `wrote outside allowed paths: ${paths.violations.slice(0, 5).join(', ')}`];
  else if (outcome.status === 'completed') [to, reason] = ['awaiting-evidence', 'worker finished; acceptance checks pending'];
  else if (outcome.status === 'aborted') [to, reason] = ['blocked', 'worker aborted'];
  else if (outcome.status === 'unsupported') [to, reason] = ['blocked', outcome.reason];
  // A harness usage limit is not the task's failure: it waits for a person (or the reset) and never escalates.
  // A gone model is the task's failure on that model; it is never relaunched on it (see above).
  // An access limit or an overload blocks the task, never fails it (design 7.3, 7.4).
  else if (access !== null && access.classification.class === 'overloaded') [to, reason] = ['blocked', overloadedReason(access.classification.signal, overloadRetry)];
  else if (access !== null) [to, reason] = ['blocked', accessReason(access, { autoResume: !accessRepeat(previousBlock, access.classification.class) })];
  else if (outcome.status === 'model-unavailable') [to, reason] = ['failed', `model ${options.model} is not available here (${finding?.reasonCode ?? 'MODEL_UNAVAILABLE'}${finding === null ? '' : ` via ${finding.port}`})`];
  else if (outcome.status === 'usage-limit') [to, reason] = ['blocked', `harness usage limit reached${outcome.resetAt === undefined || !ISO_INSTANT.test(outcome.resetAt) ? '' : `; it resets at ${outcome.resetAt}`}`];
  // R80: a run's own reason can carry vendor or harness text (a result, an event, stderr), which
  // never reaches task state: the task says only how the worker ended. Its run record keeps the
  // port's reason, which F's ports and D's Agent SDK worker keep to fixed text.
  // The pre-spawn release (C's note): a refusal before any child started names the dispatching
  // port's own reason code (fixed codes only, never text), so the task says why nothing ran.
  else if (notSpawned) [to, reason] = ['failed', `worker ${outcome.status} before starting (${/^[A-Z][A-Z0-9_]{2,63}(?=:)/.exec(outcome.reason)?.[0] ?? 'REFUSED'})`];
  else [to, reason] = ['failed', `worker ${outcome.status}`];
  const published = await options.authority.publishFenced(
    ws.workspaceId,
    lease.taskId,
    lease.fencingToken,
    (tx) => {
      tx.put('worker-runs', recordKey(ws.workspaceId, lease.id), run);
      const session = tx.get<OwnedSessionRecord>('owned-sessions', sessionKey(ws.workspaceId, lease.taskId));
      if (session !== undefined) tx.put('owned-sessions', sessionKey(ws.workspaceId, lease.taskId), { ...session, sessionId: outcome.sessionId, state: 'ended', endedAtMs, outcome: outcome.status });
      tx.delete('cancel-requests', sessionKey(ws.workspaceId, lease.taskId));
      if (access !== null && to === 'blocked' && !held && !leaseLost) {
        const blocked = access.classification.class === 'overloaded' ? { untilMs: overloadRetry, scopeKey: null, attempt: overloadAttempt ?? 0 } : { untilMs: access.pause?.untilMs ?? null, scopeKey: access.pause?.entry.key ?? null };
        tx.put(ACCESS_BLOCKED_COLLECTION, accessKey, accessBlockedRow({ workspaceId: ws.workspaceId, taskId: lease.taskId, previous: previousBlock, class: access.classification.class, nowMs: endedAtMs, run: runHarness === null ? null : { harness: runHarness, model: options.model, authMode: runAuth, servingHost: options.servingHost }, ...blocked }));
      } else if (outcome.status === 'completed') tx.delete(ACCESS_BLOCKED_COLLECTION, accessKey);
      return taskTransition(ws, lease.taskId, to, reason, { actor: to === 'cancelled' ? 'human' : 'runner', nowMs: endedAtMs, patch: { leaseId: null } });
    },
    endedAtMs,
  );
  if (!published.ok) {
    // A newer lease owns the task now: keep the result as history only, change nothing.
    await ws.host.transact((tx) => tx.put('worker-runs', recordKey(ws.workspaceId, lease.id), { ...run, stale: true, reason: `stale result (${published.reasonCode}): ${run.reason}` }));
  }
  // A held effect's spend is uncertain until a person reconciles it: release conservatively.
  await release(held ? null : spend, held ? 'owned effect held' : `worker ${outcome.status}`);
  if (to !== 'awaiting-evidence') await retainWorktree(ws, worktree.id, reason);
  await recordRanModel(ws, run, options);
  // A run that completed is an observed success on its scope: its pauses clear (design 9.1).
  if (outcome.status === 'completed' && runHarness !== null) await clearRunAccess({ home: ws.home, registry: accessRegistry, harness: runHarness, model: options.model, reportedModel: outcome.actualModel, authMode: runAuth, nowMs: decisionNow(), ...(options.servingHost === undefined ? {} : { servingHost: options.servingHost }) });
  // P11: the task's estimate against what its leases committed, after the release settled the spend.
  await recordTaskEstimate(ws, lease.taskId, now()).catch(() => null);
  return { taskId: lease.taskId, finalState: published.ok ? to : 'unchanged', run, reasonCode: !published.ok ? published.reasonCode : held ? 'OWNED_EFFECT_HELD' : access !== null && to === 'blocked' ? (access.classification.class === 'overloaded' ? 'PROVIDER_OVERLOADED' : 'ACCESS_LIMITED') : outcome.status.toUpperCase().replace(/-/g, '_') };
}

/**
 * Local proof that a model runs here (owner decision DOMAINS 3f090fa): a run whose harness
 * reported the model it used goes on C's machine record under that harness and sign-in, the
 * same pair the route request carries (MODEL_PORT_OF of the harness, the run's auth mode). R42
 * records the raw spelling and the host that served it (`resolveRunSpelling`); a spelling the
 * resolver does not map is not recorded. A run that completed cleanly with no reported model
 * counts as a weaker `requested-clean-run` only by C's rule (`cleanRunSpelling`: its maker's
 * exact id, never through a gateway). It is advice for eligibility only and never fails the run.
 */
async function recordRanModel(ws: WorkspaceServices, run: WorkerRunRecord, options: RunLeasedTaskOptions): Promise<void> {
  const harness = run.harness ?? options.port?.harnessFor?.(options.model) ?? null;
  if (harness === null) return;
  const clean = run.actualModel === null && run.status === 'completed' && run.modelUnavailable === undefined;
  if (run.actualModel === null && !clean) return;
  try {
    const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const port = MODEL_PORT_OF[harness];
    if (!(HARNESS_IDS as readonly string[]).includes(port)) return;
    const spelling = run.actualModel !== null ? resolveRunSpelling(registry, port as HarnessId, run.actualModel) : cleanRunSpelling(registry, port as HarnessId, run.requestedModel);
    if (spelling === null) return;
    await recordModelRun(ws.home, {
      harness: port,
      authMode: run.authMode ?? 'unknown',
      modelId: spelling.modelId,
      nowMs: (options.decisionNow ?? options.now ?? Date.now)(),
      raw: spelling.raw,
      servingHost: spelling.servingHost,
      source: run.actualModel !== null ? 'reported' : 'requested-clean-run',
    });
  } catch {
    // The record is advice for eligibility; the run's result stands.
  }
}

// ------------------------------------------------------------------------ owned effects

export interface HeldTaskEffect {
  readonly operationId: string;
  readonly taskId: string | null;
  readonly leaseId: string | null;
  readonly reservationMicroUsd: number;
}

/** Owned effects the kill switch holds in this workspace, with the task each belongs to. */
export function heldTaskEffects(ws: WorkspaceServices): readonly HeldTaskEffect[] {
  if (ws.store === undefined) return [];
  const runs = workerRuns(ws);
  // A worker killed with its process wrote no run record: its effect is found through the
  // lease it ran under (the operation id is op-<lease id>).
  const leases = ws.host.list<LeaseRecord>('leases').filter((l) => l.lease.workspaceId === ws.workspaceId);
  return heldEffects(ws.store).map((e) => {
    const run = runs.find((r) => r.effectOperationId === e.operationId);
    const lease = run === undefined ? leases.find((l) => effectOperationId(l.lease.id) === e.operationId) : undefined;
    return { operationId: e.operationId, taskId: run?.taskId ?? lease?.lease.taskId ?? null, leaseId: run?.leaseId ?? lease?.lease.id ?? null, reservationMicroUsd: Number(e.reservationMicroUsd) };
  });
}

export interface ReconcileOwnedEffectInput {
  readonly taskId: string;
  readonly resolution: 'applied' | 'abandoned';
  /** The person reconciling; a model worker never reconciles. */
  readonly actor: string;
  readonly channel: 'terminal' | 'cli';
  readonly killSwitchStopped: boolean;
  readonly nowMs?: number;
  /** false: leave a blocked task blocked (the caller settles its lease and moves it). */
  readonly moveTask?: boolean;
}

export type ReconcileOwnedEffectResult =
  | { readonly ok: true; readonly operationId: string; readonly state: string; readonly auditSeq: number | null; readonly taskState: TaskRecord['node']['state'] }
  | { readonly ok: false; readonly reasonCode: 'KILL_SWITCH' | 'UNKNOWN_TASK' | 'NOT_HELD' | 'STORE_UNAVAILABLE' | 'REFUSED'; readonly detail?: string };

/**
 * A person reconciles a held owned effect after the kill switch is cleared: applied (the
 * worker's effect happened and is kept) or abandoned. The store audits it once; the task
 * then moves from blocked-for-reconciliation back to ready (SSOT D05). The retained worktree
 * stays where it is.
 */
export function reconcileOwnedEffect(ws: WorkspaceServices, input: ReconcileOwnedEffectInput): ReconcileOwnedEffectResult {
  if (input.killSwitchStopped) return { ok: false, reasonCode: 'KILL_SWITCH', detail: 'clear the kill switch first' };
  if (ws.store === undefined) return { ok: false, reasonCode: 'STORE_UNAVAILABLE' };
  const task = getTask(ws, input.taskId);
  if (task === undefined) return { ok: false, reasonCode: 'UNKNOWN_TASK' };
  const held = heldTaskEffects(ws).find((e) => e.taskId === input.taskId);
  if (held === undefined) return { ok: false, reasonCode: 'NOT_HELD' };
  const nowMs = input.nowMs ?? Date.now();
  const r = reconcileEffect(ws.store, { operationId: held.operationId, resolution: input.resolution, actor: input.actor, channel: input.channel, nowMs });
  if (!r.ok) return { ok: false, reasonCode: 'REFUSED', detail: r.reason };
  let taskState = task.node.state;
  if (task.node.state === 'blocked' && input.moveTask !== false) {
    const moved = taskTransition(ws, input.taskId, 'ready', `owned effect reconciled as ${input.resolution} by ${input.actor.slice(0, 64)}`, { actor: 'human', nowMs });
    if (moved.ok) taskState = 'ready';
  }
  return { ok: true, operationId: held.operationId, state: r.state, auditSeq: r.auditSeq, taskState };
}

// ------------------------------------------------------------------------------- cancel

export interface CancelResult {
  readonly cancelled: boolean;
  readonly reasonCode: string;
  readonly signalled: 'in-process' | 'requested' | 'none';
  readonly worktree: { readonly id: string; readonly status: 'clean' | 'dirty' | 'unknown'; readonly deleted: false } | null;
}

export async function cancelTask(
  ws: WorkspaceServices,
  authority: LeaseAuthority,
  taskId: string,
  reason = 'cancelled by the user',
  nowMs = Date.now(),
  /** How long to wait for an in-process run to publish its end, so the answer shows it (the op's deadline). */
  settleWaitMs = 0,
): Promise<CancelResult> {
  const task = getTask(ws, taskId);
  if (task === undefined) return { cancelled: false, reasonCode: 'UNKNOWN_TASK', signalled: 'none', worktree: null };
  if (task.node.state === 'cancelled' || task.node.state === 'verified') return { cancelled: false, reasonCode: 'TERMINAL', signalled: 'none', worktree: null };
  const key = sessionKey(ws.workspaceId, taskId);
  const session = ws.host.get<OwnedSessionRecord>('owned-sessions', key);
  let signalled: CancelResult['signalled'] = 'none';
  const local = running.get(key);
  if (local !== undefined) {
    await ws.host.transact((tx) => tx.put('cancel-requests', key, { reason: reason.slice(0, 200), atMs: nowMs }));
    local.abort();
    signalled = 'in-process';
    // The aborted run publishes the cancellation itself (its diff, its effect, its lease): wait
    // for it within the caller's deadline, so the answer is the task's real state.
    const settled = settling.get(key);
    if (settled !== undefined && settleWaitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, settleWaitMs)))]);
      if (timer !== undefined) clearTimeout(timer);
    }
  } else if (session !== undefined && session.state === 'running') {
    // The owning process picks this up on its next heartbeat and aborts its own session.
    await ws.host.transact((tx) => tx.put('cancel-requests', key, { reason: reason.slice(0, 200), atMs: nowMs }));
    signalled = 'requested';
  }
  if (signalled === 'none') {
    // Nothing is running: stop scheduling now and release any lease conservatively.
    const leases = authority.activeLeases(ws.workspaceId).filter((l: LeaseRecord) => l.lease.taskId === taskId);
    for (const l of leases) await authority.release(ws.workspaceId, l.lease.id, l.lease.fencingToken, { actualMicroUsd: null }, nowMs, 'cancelled');
    const current = getTask(ws, taskId);
    if (current !== undefined && current.node.state !== 'cancelled') taskTransition(ws, taskId, 'cancelled', reason, { actor: 'human', nowMs, patch: { leaseId: null } });
  }
  // Queued tasks that depended on this one can never start now; say so instead of leaving them
  // to fail a later, unrelated submit (JEV-0035). Nothing is cancelled for the person.
  blockCancelledDependants(ws, nowMs);
  const tree: WorktreeRecord | undefined = session === undefined ? undefined : getWorktree(ws, session.worktreeId);
  if (tree !== undefined) await retainWorktree(ws, tree.id, 'kept after cancel');
  return {
    cancelled: true,
    reasonCode: 'CANCELLED',
    signalled,
    worktree: tree === undefined ? null : { id: tree.id, status: await worktreeStatus(tree), deleted: false },
  };
}

// ----------------------------------------------------------------------------- completion

export interface CompleteTaskResult {
  readonly taskId: string;
  readonly verified: boolean;
  readonly state: TaskRecord['node']['state'] | 'unknown';
  readonly completion: CompletionReport | null;
  readonly reasonCode: string;
}

/** The workspace services a task's checks run in: its worktree when it has one. */
export function taskWorkspace(ws: WorkspaceServices, taskId: string): WorkspaceServices {
  const session = ws.host.get<OwnedSessionRecord>('owned-sessions', sessionKey(ws.workspaceId, taskId));
  const tree = session === undefined ? undefined : getWorktree(ws, session.worktreeId);
  if (tree === undefined || tree.state === 'removed') return ws;
  return openWorkspace({ home: ws.home, workspaceRoot: tree.path, workspaceId: ws.workspaceId, store: ws.store });
}

export async function completeTask(ws: WorkspaceServices, taskId: string, options: { readonly run?: boolean; readonly nowMs?: number } = {}): Promise<CompleteTaskResult> {
  const task = getTask(ws, taskId);
  if (task === undefined) return { taskId, verified: false, state: 'unknown', completion: null, reasonCode: 'UNKNOWN_TASK' };
  if (!['awaiting-evidence', 'verifying', 'running'].includes(task.node.state)) {
    return { taskId, verified: task.node.state === 'verified', state: task.node.state, completion: null, reasonCode: task.node.state === 'verified' ? 'ALREADY_VERIFIED' : 'NOT_AWAITING_EVIDENCE' };
  }
  const target = taskWorkspace(ws, taskId);
  const request = { taskId, checkIds: task.node.acceptanceCheckIds, acceptanceCheckIds: task.node.acceptanceCheckIds, requirementIds: task.node.requirementIds };
  const completion = options.run === false ? await verificationStatus(target, request) : (await runVerification(target, request)).completion;
  const nowMs = options.nowMs ?? Date.now();
  const outcome = ((): { readonly state: TaskRecord['node']['state'] | 'unknown'; readonly ok: boolean } => {
    const current = getTask(ws, taskId);
    if (current === undefined) return { state: 'unknown', ok: false };
    if (!completion.verified) {
      if (current.node.state === 'running') taskTransition(ws, taskId, 'awaiting-evidence', 'CHECKS_PENDING', { actor: 'runner', nowMs });
      return { state: getTask(ws, taskId)?.node.state ?? current.node.state, ok: false };
    }
    // The store verifies from the mandatory checks' receipts it holds for this task.
    const receiptIds = completion.checks.filter((c) => c.mandatory && c.status === 'passed' && c.receiptId !== null).map((c) => c.receiptId as string);
    const marked = markVerified(ws, taskId, receiptIds, nowMs);
    return { state: marked.ok ? marked.task.node.state : (getTask(ws, taskId)?.node.state ?? current.node.state), ok: marked.ok };
  })();
  // C16: a mandatory check's store receipt labels the task's route (pass or fail); never a model's judgement.
  const label = outcome.ok || !completion.verified ? completionOutcome(completion) : null;
  const routeLabel = label === null ? null : completionLabel(ws, taskId, label);
  await recordTaskEstimate(ws, taskId, nowMs).catch(() => null);
  if (routeLabel !== null) recordRouteOutcome(ws, taskId, routeLabel.kind, { receiptId: routeLabel.receiptId, run: workerRuns(ws, taskId).filter((r) => r.stale !== true).at(-1) ?? null, nowMs });
  return { taskId, verified: outcome.ok, state: outcome.state, completion, reasonCode: outcome.ok ? 'VERIFIED' : completion.missingEvidence.length > 0 ? 'EVIDENCE_MISSING' : 'NOT_VERIFIED' };
}
