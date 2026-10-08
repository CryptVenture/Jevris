/**
 * Sidecar protocol v1 (IPC-01..IPC-20, SSOT §5.2, §16.2, §17.2).
 *
 * Types only, plus plain constants. The wire protocol, the client and the daemon live in
 * `@jevris/sidecar`; every other domain codes against these names.
 *
 * Wire: newline-delimited JSON over a private Unix socket or a random per-user Windows pipe.
 *   1. client -> hello      { t:'hello', v:1, client, cnonce, runtimeVersion }
 *   2. server -> challenge  { t:'challenge', v:1, protocol, version, bootId, snonce, proof }
 *      proof = HMAC(clientKey, 'jevris-sidecar-v1\nserver\n' cnonce \n snonce \n bootId).
 *      The client refuses a server that cannot prove the key before it sends anything else.
 *   3. client -> req        { t:'req', v:1, id(nonce), ws, op, ts, eventAtMs?, budget, body(JSON text), deadlineAtMs?, mac }
 *      mac = HMAC(clientKey, 'jevris-sidecar-v1\nrequest\n' snonce \n id \n ws \n op \n ts \n eventAtMs \n budget \n sha256(body) [\n deadlineAtMs]).
 *      deadlineAtMs is the wall-clock ms at which the client stops waiting. When present it is
 *      MAC'd (appended last), and the sidecar's deadline for the request becomes the smaller of
 *      its budget and deadlineAtMs minus SIDECAR_CLIENT_DEADLINE_MARGIN_MS. It can only shorten.
 *      The nonce is consumed before dispatch for every op; the timestamp must be within the skew window.
 *   4. server -> res        { t:'res', v:1, id, payload(JSON text of SidecarOpOutcome), mac }
 *   Any failure before dispatch is { t:'error', id?, reasonCode } and the connection closes.
 *
 * The client key is per client kind (cli, hook, mcp) and per sidecar boot, stored owner-only in
 * the runtime directory. The kind decides the capability scopes; a frame can never assert them.
 */

/** The kind of local client. The agreed `scope` argument of sidecarRequest names one. */
export type SidecarClientKind = 'cli' | 'hook' | 'mcp';

export const SIDECAR_CLIENT_KINDS: readonly SidecarClientKind[] = ['cli', 'hook', 'mcp'];

/** Least-privilege capability scopes (IPC-10). */
export type SidecarScope = 'status' | 'advice' | 'checkpoint' | 'submit' | 'admin';

export const SIDECAR_SCOPES: readonly SidecarScope[] = ['status', 'advice', 'checkpoint', 'submit', 'admin'];

/** Scopes each client kind holds. MCP and hooks never submit or administer. */
export const SIDECAR_CLIENT_SCOPES: { readonly [K in SidecarClientKind]: readonly SidecarScope[] } = {
  cli: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
  hook: ['status', 'advice', 'checkpoint'],
  mcp: ['status', 'advice', 'checkpoint'],
};

export const SIDECAR_PROTOCOL_VERSION = 1;

/** Deadline classes measured from event receipt on the monotonic clock (IPC-15). */
export type SidecarBudgetClass = 'hot' | 'background';

export const SIDECAR_BUDGET_MS: { readonly [K in SidecarBudgetClass]: number } = { hot: 900, background: 5000 };

/** The most the test budget scale may be. */
export const TEST_BUDGET_SCALE_MAX = 20;

/**
 * The scale a test run puts on the sidecar's time budgets and the hook launcher's deadline, so a
 * slow runner cannot turn a stall into a failure. It is read from one variable, and only when
 * `JEVRIS_TEST` is `1` (the test-process marker scripts/test.mjs sets): outside a test run the
 * variable is ignored completely and the scale is 1, the product's own budgets. A value that is
 * not a number from 1 to 20 (up to two decimals) is also 1. This function is the only code that
 * reads the variable (lint/budget-scale.lint.mjs); every other reader asks it, passing the
 * environment, so contracts stays free of `process`.
 *
 * The scale multiplies the hot, background and answer-lane budgets, a connection's hello and frame
 * timers, a subscriber's slice, a capability consult's default wait, the default timeout of a client
 * request that names none, and the hook deadline with its 4000 ms ceiling, together, so their ratios
 * hold. A sidecar request still ends at the smaller of its budget and the client's deadline
 * less the margin (IPC-15), so a larger budget never makes the sidecar answer after the client has
 * left. A test about a deadline keeps its exact budgets by setting `limits.budgetMs` itself, or by
 * clearing the variable in the environment it gives a spawned process (test/budget-scale.mjs).
 */
export function testBudgetScale(env: { readonly [key: string]: string | undefined }): number {
  if (env['JEVRIS_TEST'] !== '1') return 1;
  const raw = env['JEVRIS_TEST_BUDGET_SCALE'];
  if (raw === undefined || !/^\d{1,2}(?:\.\d{1,2})?$/.test(raw)) return 1;
  const scale = Number(raw);
  return scale >= 1 && scale <= TEST_BUDGET_SCALE_MAX ? scale : 1;
}

/** `ms` times the test budget scale, rounded: a test run's longer budget, or `ms` itself outside one. */
export function testScaledMs(ms: number, env: { readonly [key: string]: string | undefined }): number {
  const scale = testBudgetScale(env);
  return scale === 1 ? ms : Math.round(ms * scale);
}

/** The op budgets in force for this environment: the product's, times the test budget scale. */
export function sidecarBudgetsMs(env: { readonly [key: string]: string | undefined }): { readonly [K in SidecarBudgetClass]: number } {
  return { hot: testScaledMs(SIDECAR_BUDGET_MS.hot, env), background: testScaledMs(SIDECAR_BUDGET_MS.background, env) };
}

/** Time kept back from a client's deadline for the answer to travel and be written (IPC-15). */
export const SIDECAR_CLIENT_DEADLINE_MARGIN_MS = 50;

/** Reasons a request fails before or during dispatch. Stable reason codes, never free text. */
export type SidecarRejectReason =
  | 'MALFORMED'
  | 'OVERSIZE'
  | 'UNKNOWN_CLIENT'
  | 'BAD_MAC'
  | 'REPLAYED'
  | 'EXPIRED'
  | 'CLOCK_SKEW'
  | 'SCOPE_DENIED'
  | 'UNKNOWN_OP'
  | 'UNKNOWN_WORKSPACE'
  | 'CROSS_WORKSPACE'
  | 'DEADLINE'
  | 'BUSY'
  | 'SHUTTING_DOWN'
  | 'KILL_SWITCH'
  | 'VERSION_MISMATCH'
  | 'STORE_UNAVAILABLE'
  | 'INTERNAL';

/** The body a handler returns. `body` is JSON-serializable. */
export type SidecarOpOutcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reasonCode: string; readonly message?: string };

/** The degraded state a consumer shows when the sidecar cannot answer (IPC-18). */
export type SidecarFailureReason = 'unavailable' | 'refused' | 'timeout' | 'rejected';

export interface SidecarEndpointFile {
  readonly schemaVersion: 'jevris-sidecar-endpoint-1';
  readonly protocol: number;
  readonly version: string;
  readonly pid: number;
  readonly bootId: string;
  /** A Unix socket path or a `\\.\pipe\...` name. */
  readonly endpoint: string;
  readonly startedAtMs: number;
  readonly supervised: boolean;
  /**
   * The build the sidecar loaded (protocol runtimeBuild: a short hash of its runtime's
   * dist/bundle-manifest.json), so a reinstall of the same version can tell it runs older code.
   * Absent from a sidecar that predates it, or one run from a tree without a bundle.
   */
  readonly build?: string;
}

// ------------------------------------------------------------------ client API (agreed with E)

export interface EnsureSidecarInput {
  readonly home?: string;
  /** 0 never blocks (hooks). The CLI and MCP use about 1500. */
  readonly waitMs?: number;
}

export type EnsureSidecarResult =
  | { readonly ok: true; readonly endpoint: string; readonly started: boolean }
  | {
      readonly ok: false;
      readonly reason: 'starting' | 'unavailable' | 'refused';
      /** Why nothing was started or why it is not up yet, when the client knows (for example SERVICE_START_REFUSED). */
      readonly reasonCode?: string;
      readonly message: string;
    };

export interface SidecarRequestInput {
  readonly home?: string;
  readonly op: string;
  /** A registered workspace id, or a workspace root path (registered by root identity). */
  readonly workspace?: string;
  readonly body?: unknown;
  /** The client kind; it decides the key and therefore the capability scopes. */
  readonly scope: SidecarClientKind;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Wall-clock ms of the originating event; the deadline counts from it. */
  readonly eventAtMs?: number;
  readonly budget?: SidecarBudgetClass;
}

export type SidecarRequestResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly reason: SidecarFailureReason;
      /** The stable reason code from the sidecar or the client, when there is one. */
      readonly reasonCode?: string;
      /** One line that tells the user what to do. Never contains a secret. */
      readonly message: string;
    };

// ------------------------------------------------------------------ op registry (other domains)

export interface SidecarDeadline {
  readonly budgetMs: number;
  remainingMs(): number;
  expired(): boolean;
}

export interface SidecarWorkspace {
  readonly id: string;
  /** The canonical root path (realpath), when the workspace was registered by root. */
  readonly root: string | null;
}

export interface SidecarTraceEvent {
  readonly event: string;
  readonly reasonCode?: string;
  readonly decisionId?: string;
  readonly taskId?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

/**
 * Advice adherence (learning-coverage audit P5, B with C): delivered model advice, resolved by the
 * sidecar to followed, overridden, no-change or unknown from the session's model changes. Bound to
 * the request's workspace store; ids, codes and model ids only. Neither call throws.
 */
export interface SidecarAdviceAdherence {
  /** Records advice at delivery; false when it was not recorded (invalid input, store refusal). */
  open(input: {
    readonly decisionId: string;
    readonly sessionId: string;
    readonly adviceKind: 'main-route' | 'model-change';
    readonly slice: string;
    readonly advisedModel: string;
    readonly currentModel?: string | null;
    readonly atMs: number;
  }): boolean;
  /** Overridden plus no-change verdicts for the same advice in this session (C suppresses at 2). */
  overrides(input: { readonly sessionId: string; readonly adviceKind: 'main-route' | 'model-change'; readonly slice: string; readonly advisedModel: string }): number;
}

/**
 * What a handler receives. `store` is the sidecar's single open store handle (an
 * `@jevris/store` OpenedStore) or undefined when the store is unavailable (rules-only).
 */
export interface SidecarOpContext {
  readonly op: string;
  readonly client: SidecarClientKind;
  readonly scopes: readonly SidecarScope[];
  readonly workspace: SidecarWorkspace;
  readonly body: unknown;
  readonly home: string;
  readonly signal: AbortSignal;
  readonly deadline: SidecarDeadline;
  /**
   * The hot budget this sidecar runs with, in ms (900 in the product, scaled or pinned in a test): the most an op that
   * asks Jev inside a request a person waits for (a route's task slice) waits for the call, less its reserve for the rest
   * of the answer, whatever budget class the request itself asked for. A person's `jevris route` and an MCP tool call ask
   * for the 5 s background budget so that a loaded host does not fail the work around the call, and that is not a licence
   * to hold the answer for 4.8 s for Jev (SSOT: a semantic hot-path decision has a 900 ms total budget, and fallback is
   * the outcome when it cannot be met). Absent where no sidecar set it (a direct unit call): the op's own budget alone.
   */
  readonly hotBudgetMs?: number;
  readonly store: unknown;
  readonly killSwitchStopped: boolean;
  /**
   * A live read of the kill switch. `killSwitchStopped` is the state when the request arrived; work
   * that outlives the request (an owned worker's run ending, then leasing the next task) asks this
   * instead. Absent: the request's value stands. A read that fails counts as stopped.
   */
  readonly killSwitchNow?: () => Promise<boolean>;
  /** P5 advice adherence for this workspace; absent when the store is unavailable (rules-only) or for the global workspace. */
  readonly adviceAdherence?: SidecarAdviceAdherence;
  /**
   * The single decision engine the sidecar builds once with `createDecisionEngine` from
   * `@jevris/core` (domain C). Undefined when the provider is not configured (rules-only).
   * No handler constructs a provider itself.
   */
  readonly engine: unknown;
  /**
   * The effective mode for this workspace (owner decision 0eb319de), which the sidecar resolves
   * for every event and sets here. A subscriber asks `modeAllows(mode, action)` before it shows
   * advice or actuates. Absent only where no sidecar resolved it (a direct unit call).
   */
  readonly mode?: 'off' | 'observe' | 'advise' | 'bounded-auto';
  /**
   * The effective `jev.assist` for this workspace (owner decision 2026-10-01): `classify` lets an op
   * ask Jev a bounded classification question (a route request's task slice); `off` keeps it
   * rules-only. Absent where no sidecar resolved it (a direct unit call): treated as `classify`.
   */
  readonly jevAssist?: 'off' | 'classify';
  /**
   * The person's own half of source-egress consent for this workspace (`privacy.sourceEgress` in the effective configuration):
   * `approved-scoped` is their preference to let screened text out, and never lets any out on its own (the administrator's
   * approval, which the engine reads, is the other half). Absent where no sidecar resolved it: treated as not approved.
   */
  readonly sourceEgressPreference?: 'deny-until-approved' | 'approved-scoped';
  /** Content-free trace line (OBS-01). Keys and values are bounded; no source, no secret. */
  trace(event: SidecarTraceEvent): void;
}

export interface SidecarOpDefinition {
  readonly op: string;
  readonly scope: SidecarScope;
  readonly budget: SidecarBudgetClass;
  /** Refused with KILL_SWITCH while the kill switch is stopped (effectful ops). */
  readonly stoppedByKillSwitch?: boolean;
  /** 'required' (default): the frame must name a workspace. 'optional': a global op. */
  readonly workspace?: 'required' | 'optional';
  handle(context: SidecarOpContext): Promise<SidecarOpOutcome> | SidecarOpOutcome;
}

/**
 * A subscriber to the built-in `event` op. The sidecar first appends the hook EventEnvelope to
 * the store (idempotent by delivery key), then calls each subscriber with the same context;
 * the op answers `{ recorded, duplicate, results: { [name]: result } }`. Packages export
 * `sidecarEventSubscribers: readonly SidecarEventSubscriber[]`.
 */
export interface SidecarEventSubscriber {
  readonly name: string;
  handle(context: SidecarOpContext): Promise<unknown> | unknown;
}

/**
 * Packages the sidecar asks for a `sidecarOps` export (a readonly SidecarOpDefinition[]).
 * A domain adds ops by exporting them from its own package; built-in names cannot be replaced.
 */
export const SIDECAR_OP_PACKAGES: readonly string[] = [
  '@jevris/core',
  '@jevris/provider-typesafe',
  '@jevris/orchestrator',
  '@jevris/evals',
  '@jevris/languages',
];
