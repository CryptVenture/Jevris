/**
 * The hook launcher (HKR-01): `node <runtime>/dist/hook.mjs --harness <name> [--event <Native>]`.
 *
 * One native hook input arrives on stdin. The harness's adapter (domain F) normalizes it, the
 * launcher forwards the normalized event to the sidecar's `event` op (scope hook, hot budget,
 * never waiting for a sidecar to start), and prints exactly one protocol response rendered by
 * the same adapter. Every path exits 0: Jevris never blocks, denies or asks on a harness action
 * (§16.2). A slow or absent sidecar, a refusal or a malformed input all render the adapter's
 * "no decision" form before the hard deadline.
 *
 * Outcomes come from sidecar subscribers as `{ hookOutcome }` in the `event` result. A
 * `context` or `route` outcome is rendered only when the subscriber attests `certified: true`
 * (the sidecar owns certification records and the harness version, §15.4); anything else is
 * observation. `JEVRIS_HOOK_OBSERVE_ONLY=1` forces observation.
 */
import { sessionAccessOf } from './session-access.js';
import { HARNESS_INPUT_CAP, HookOutcomeContract, RouteTurnPayloadContract, stillRunningText, type HarnessIntent, type HookOutcome, type LauncherName, type NormalizeContext, type NormalizeResult, type NormalizedHarnessEvent } from '@jevris/contracts';

export interface HarnessAdapter {
  normalize(native: unknown, context?: NormalizeContext): NormalizeResult;
  /**
   * `native` is passed only with a `route` outcome, and only when the hook input reached the
   * launcher whole (never cut to fit): the route names a registry model id, and the adapter builds
   * the rewritten tool input from the harness's own input, so no tool-input value crosses the
   * sidecar boundary (E 7a6f7a5, owner decision 9ce2ba5).
   */
  protocolResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string;
  /**
   * VER-05: the harness's Stop block for one continuation; absent where Stop cannot block.
   * `running` names the missing checks a background run is still producing, with the words for
   * them (contracts stillRunningText), so the reason does not ask for them again.
   */
  stopContinuationResponse?(event: NormalizedHarnessEvent | null, missingEvidence: readonly unknown[], running?: StopRunningChecks): string;
}

/** The missing checks a verification run is still producing, and the words for them. */
export interface StopRunningChecks {
  readonly checkIds: readonly string[];
  readonly text: string;
}

export type EnsureResult =
  | { readonly ok: true; readonly endpoint: string; readonly started: boolean }
  | { readonly ok: false; readonly reason: string; readonly reasonCode?: string; readonly message: string };

export type RequestResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: string; readonly reasonCode?: string; readonly message: string };

/** The `route.turn` request body (C's op, OD-8): the turn's own ids and model, never a scope or a mode. */
export interface RouteTurnBody {
  readonly harness: 'kilocode' | 'opencode';
  readonly sessionId: string;
  readonly messageId?: string;
  readonly current: { readonly providerID: string; readonly modelID: string; readonly variant?: string };
  readonly modelPin: null;
}

export interface LauncherSidecar {
  ensure(input: { readonly home?: string; readonly waitMs: number }): Promise<EnsureResult>;
  request(
    input:
      | {
          readonly home?: string;
          readonly op: 'event';
          readonly workspace?: string;
          readonly body: { readonly envelope: NormalizedHarnessEvent; readonly deliveryKey: string; readonly harnessVersion?: string; readonly authMode?: SessionAuthMode; readonly showsExplain: boolean } & HarnessIntent;
          readonly scope: 'hook';
          readonly timeoutMs: number;
          readonly eventAtMs: number;
          readonly budget: 'hot';
        }
      | {
          readonly home?: string;
          readonly op: 'route.turn';
          readonly workspace?: string;
          readonly body: RouteTurnBody;
          readonly scope: 'hook';
          readonly timeoutMs: number;
          readonly eventAtMs: number;
          readonly budget: 'hot';
        },
  ): Promise<RequestResult>;
}

export interface LauncherDeps {
  readonly adapters: Readonly<Record<LauncherName, HarnessAdapter>>;
  readonly sidecar: LauncherSidecar;
  readonly env: { readonly [key: string]: string | undefined };
  readonly cwd: () => string;
  readonly nowMs: () => number;
  /**
   * The harness version the harness itself supplied in this hook payload, if any. Defaults to
   * the payload's top-level `harness_version` or `harnessVersion`. Never spawns the harness and
   * never reads a file: the sidecar looks up the installer-recorded version itself. Null or a
   * malformed value omits `body.harnessVersion`.
   */
  readonly harnessVersion?: (harness: LauncherName, native: unknown) => string | null;
  /** Diagnostics only: reason codes, never event content. */
  readonly log?: (line: string) => void;
  /**
   * The size of a file in bytes, or null. Used only on the native `transcript_path`, to give
   * the adapter the delivery's position in the session (never reads the transcript).
   */
  readonly fileSize?: (path: string) => number | null;
  /**
   * Guard 6 (access limits R68, OP-12): whether the session's endpoint for `provider` is not the
   * provider's own. Asked only for an event that ends a turn on an access signal; absent means
   * no access signal is ever sent.
   */
  readonly endpointRedirected?: (harness: LauncherName, provider: string, workspace: string | undefined) => Promise<boolean>;
}

/** The transcript's size when the hook ran, or null (no path, no file, or no fileSize dep). */
export function transcriptPosition(deps: LauncherDeps, native: unknown): number | null {
  if (deps.fileSize === undefined || native === null || typeof native !== 'object' || Array.isArray(native)) return null;
  const record = native as { readonly [key: string]: unknown };
  const raw = Object.hasOwn(record, 'transcript_path') ? record['transcript_path'] : undefined;
  const path = typeof raw === 'string' ? plainPath(raw) : undefined;
  if (path === undefined) return null;
  try {
    const size = deps.fileSize(path);
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function payloadVersion(_harness: LauncherName, native: unknown): string | null {
  if (native === null || typeof native !== 'object' || Array.isArray(native)) return null;
  const record = native as { readonly [key: string]: unknown };
  for (const key of ['harness_version', 'harnessVersion']) {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof value === 'string') return value;
  }
  return null;
}

export type SessionAuthMode = 'api-key' | 'subscription';

function envSet(env: { readonly [key: string]: string | undefined }, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * G21 (harness parity audit): how this Claude Code session pays, read from the environment the
 * hook inherits, by Claude Code's authentication precedence (code.claude.com/docs/en/authentication,
 * read 27 September 2026). Only names are checked, never a value. Null when the environment
 * cannot tell:
 * - a cloud provider (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`): not an account mode;
 * - none of the variables below: a `/login` may be a claude.ai subscription or a Console
 *   (API-billed) login, and an Anthropic profile ranks below them anyway.
 * A Claude apps gateway sign-in outranks every variable and is not visible here; an
 * `apiKeyHelper` (a setting) outranks `CLAUDE_CODE_OAUTH_TOKEN` and is not visible either.
 * `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` is `api-key` (in an interactive session the key
 * is used once approved; a declined key is not visible here). `CLAUDE_CODE_OAUTH_TOKEN` alone is
 * `subscription`. Other harnesses: null (their sign-in is not visible to a hook).
 */
export function sessionAuthMode(harness: LauncherName, env: { readonly [key: string]: string | undefined }): SessionAuthMode | null {
  if (harness !== 'claude') return null;
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((key) => envSet(env, key))) return null;
  if (envSet(env, 'ANTHROPIC_AUTH_TOKEN') || envSet(env, 'ANTHROPIC_API_KEY')) return 'api-key';
  if (envSet(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return 'subscription';
  return null;
}

/** A harness-supplied version token, or null (the field is then omitted). */
export function suppliedVersion(deps: LauncherDeps, harness: LauncherName, native: unknown): string | null {
  try {
    const value = (deps.harnessVersion ?? payloadVersion)(harness, native);
    return typeof value === 'string' && VERSION_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export interface LauncherResult {
  readonly exitCode: 0;
  /** What the harness reads on stdout: the adapter's rendering, possibly empty. */
  readonly stdout: string;
  /** Why the outcome was chosen (tests and debug logs). */
  readonly reason: string;
  /** Misses a Kilo or OpenCode shim counted on its side and carried on this delivery (G16). */
  readonly shimMisses?: readonly ShimMissRecord[];
}

/** One kind of shim-side miss (audit G16): how many since the last carried set, and the longest wait. */
export interface ShimMissRecord {
  readonly reasonCode: 'SHIM_DROPPED' | 'SHIM_TIMEOUT' | 'SHIM_SPAWN_FAILED' | 'SHIM_KILLED';
  readonly count: number;
  readonly maxMs: number;
}

const SHIM_MISS_CODES: ReadonlySet<string> = new Set(['SHIM_DROPPED', 'SHIM_TIMEOUT', 'SHIM_SPAWN_FAILED', 'SHIM_KILLED']);

/**
 * The shim's `shimMisses` field, validated: at most one entry per reason code, a count from 1
 * to 1,000,000 and a wait from 0 to 3,600,000 ms. Anything else is ignored, never an error.
 */
export function shimMissesOf(value: unknown): readonly ShimMissRecord[] {
  if (!Array.isArray(value) || value.length > SHIM_MISS_CODES.size) return [];
  const seen = new Set<string>();
  const list: ShimMissRecord[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const reasonCode = own(item, 'reasonCode');
    const count = own(item, 'count');
    const maxMs = own(item, 'maxMs');
    if (typeof reasonCode !== 'string' || !SHIM_MISS_CODES.has(reasonCode) || seen.has(reasonCode)) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 1_000_000) continue;
    if (!Number.isSafeInteger(maxMs) || (maxMs as number) < 0 || (maxMs as number) > 3_600_000) continue;
    seen.add(reasonCode);
    list.push({ reasonCode: reasonCode as ShimMissRecord['reasonCode'], count: count as number, maxMs: maxMs as number });
  }
  return list;
}

/**
 * The reasons bin.ts records in the hook-latency file, as misses the sidecar cannot see: P8
 * (B a51d524, E's proposal) the deadlines, the watchdog and the sidecar start states; K8 (audit
 * 07aa380, owner decision ededdba) the client-side misses TIMEOUT, HANDSHAKE_TIMEOUT, BUSY,
 * CONNECT_*, ECONNREFUSED and CLOSED. Autostart off is the user's choice, not a miss.
 */
const COUNTED_HOOK_REASON = /^(?:DEADLINE|HOOK_DEADLINE|HOOK_WATCHDOG|TIMEOUT|HANDSHAKE_TIMEOUT|BUSY|CONNECT_[A-Z0-9_]{1,55}|ECONNREFUSED|CLOSED|SIDECAR_(?!AUTOSTART_OFF$)[A-Z0-9_]{1,55})$/;

export function countedHookReason(reason: string): boolean {
  return COUNTED_HOOK_REASON.test(reason);
}

export const LAUNCHER_NAME_LIST: readonly LauncherName[] = ['claude', 'kilo', 'codex', 'opencode', 'agy'];
export const DEFAULT_DEADLINE_MS = 1500;
const MIN_DEADLINE_MS = 100;
const MAX_DEADLINE_MS = 4000;
const CONTEXT_CAP = 8000;

export interface LauncherArgs {
  readonly harness: LauncherName;
  readonly event: string | null;
}

/** `--harness <name>` (required) and `--event <Native>` (optional). Anything else: null. */
export function parseLauncherArgs(argv: readonly string[]): LauncherArgs | null {
  let harness: string | undefined;
  let event: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if ((arg === '--harness' || arg === '--event') && typeof value === 'string' && value.length > 0 && value.length <= 128) {
      if (arg === '--harness') {
        if (harness !== undefined) return null;
        harness = value;
      } else {
        if (event !== undefined) return null;
        event = value;
      }
      i += 1;
      continue;
    }
    return null;
  }
  if (harness === undefined || !(LAUNCHER_NAME_LIST as readonly string[]).includes(harness)) return null;
  if (event !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(event)) return null;
  return { harness: harness as LauncherName, event: event ?? null };
}

/** The hard deadline, from JEVRIS_HOOK_DEADLINE_MS clamped to 100..4000 ms. */
export function deadlineMs(env: { readonly [key: string]: string | undefined }): number {
  const raw = env['JEVRIS_HOOK_DEADLINE_MS'];
  const parsed = typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : DEFAULT_DEADLINE_MS;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, parsed));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** One outcome proposed by a subscriber, or null when it proposes nothing usable. */
export function outcomeOf(value: unknown): { readonly outcome: HookOutcome; readonly certified: boolean } | null {
  if (!isPlainObject(value)) return null;
  const proposed = own(value, 'hookOutcome');
  if (!isPlainObject(proposed)) return null;
  const certified = own(value, 'certified') === true;
  const kind = own(proposed, 'kind');
  if (kind === 'observe') return { outcome: { kind: 'observe' }, certified };
  if (kind === 'context' || kind === 'explain') {
    const text = own(proposed, 'text');
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return { outcome: { kind, text: text.slice(0, CONTEXT_CAP) }, certified };
  }
  if (kind === 'route') {
    const variant = own(proposed, 'variant');
    const checked = HookOutcomeContract.validate({ kind, model: own(proposed, 'model'), ...(variant === undefined ? {} : { variant }) });
    if (!checked.ok || checked.value.kind !== 'route') return null;
    const wireVariant = checked.value.variant;
    return { outcome: { kind: 'route', model: checked.value.model, ...(wireVariant === undefined || wireVariant === null ? {} : { variant: wireVariant }) }, certified };
  }
  return null;
}

const RANK: Readonly<Record<HookOutcome['kind'], number>> = { observe: 0, explain: 1, context: 2, route: 3 };

const SUBSCRIBER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The subscribers the sidecar stopped waiting for (B's `queued`, a53b702): each missed its slice,
 * so a proposal it makes later is not in this answer. Malformed entries are ignored.
 */
function queuedOf(result: Record<string, unknown>): readonly string[] {
  const queued = own(result, 'queued');
  if (!Array.isArray(queued)) return [];
  return queued.slice(0, 64).filter((name): name is string => typeof name === 'string' && SUBSCRIBER_NAME.test(name));
}

/**
 * The outcome to render from an `event` result: the strongest proposal among subscribers,
 * where `context` and `route` count only when certified. Ties keep the first subscriber by
 * name so the choice is deterministic. When nothing was proposed and a subscriber missed its
 * slice, the reason is SUBSCRIBER_QUEUED, not NO_PROPOSAL: a proposal may have been lost to time.
 * A duplicate delivery observes, unless the sidecar replayed the first delivery's answer (D's
 * answer replay): that renders as the first did, with reason DUPLICATE_REPLAYED.
 * A result the stopped sidecar answered (`killSwitch: 'stopped'`, no subscriber ran) observes
 * with reason KILL_SWITCH.
 */
export function chooseOutcome(result: unknown): { readonly outcome: HookOutcome; readonly reason: string; readonly continuation: readonly string[] | null } {
  if (!isPlainObject(result)) return { outcome: { kind: 'observe' }, reason: 'NO_RESULT', continuation: null };
  // GOV-02..04: a stopped sidecar recorded the event and ran no subscriber; say so, not NO_PROPOSAL.
  if (own(result, 'killSwitch') === 'stopped') return { outcome: { kind: 'observe' }, reason: 'KILL_SWITCH', continuation: null };
  const replayed = own(result, 'duplicate') === true && own(result, 'replayed') === true;
  if (own(result, 'duplicate') === true && !replayed) return { outcome: { kind: 'observe' }, reason: 'DUPLICATE_DELIVERY', continuation: null };
  const results = own(result, 'results');
  if (!isPlainObject(results)) return { outcome: { kind: 'observe' }, reason: 'NO_SUBSCRIBER_RESULT', continuation: null };
  let best: HookOutcome = { kind: 'observe' };
  let reason = 'NO_PROPOSAL';
  let continuation: readonly string[] | null = null;
  for (const name of Object.keys(results).sort()) {
    continuation ??= stopContinuationOf(results[name]);
    const proposal = outcomeOf(results[name]);
    if (proposal === null) continue;
    const actuates = proposal.outcome.kind === 'context' || proposal.outcome.kind === 'route';
    if (actuates && !proposal.certified) {
      if (reason === 'NO_PROPOSAL') reason = 'NOT_CERTIFIED';
      continue;
    }
    if (RANK[proposal.outcome.kind] > RANK[best.kind]) {
      best = proposal.outcome;
      reason = `PROPOSED_BY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40)}`;
    }
  }
  if (reason === 'NO_PROPOSAL' && queuedOf(result).length > 0) reason = 'SUBSCRIBER_QUEUED';
  return { outcome: best, reason: replayed ? 'DUPLICATE_REPLAYED' : reason, continuation };
}

/**
 * VER-05: a certified stop reminder's missing evidence ids, or null. D's completion subscriber
 * proposes it once per unchanged condition, never while stop_hook_active, and not at all when
 * orchestration.maxStopContinuationsPerCondition is 0.
 */
function stopContinuationOf(value: unknown): readonly string[] | null {
  const proposed = isPlainObject(value) ? own(value, 'stopContinuation') : undefined;
  if (!isPlainObject(proposed) || own(proposed, 'certified') !== true) return null;
  const ids = own(proposed, 'missingEvidence');
  if (!Array.isArray(ids)) return null;
  const strings = ids.filter((id): id is string => typeof id === 'string').slice(0, 16);
  return strings.length === 0 ? null : strings;
}

/**
 * US23: the missing checks D's stop decision says a background run is still producing (RUNNING)
 * or will next (QUEUED), from the same subscriber result that proposed the continuation, with
 * the words for them. Only ids among the continuation's own, and only those two states.
 */
function runningChecksOf(result: unknown, missing: readonly string[]): StopRunningChecks | undefined {
  const results = isPlainObject(result) ? own(result, 'results') : undefined;
  if (!isPlainObject(results)) return undefined;
  for (const name of Object.keys(results).sort()) {
    if (stopContinuationOf(results[name]) === null) continue;
    const proposed = own(results[name] as Record<string, unknown>, 'stopContinuation') as Record<string, unknown>;
    const pending = own(proposed, 'pending');
    if (!isPlainObject(pending)) return undefined;
    const entries: (readonly [string, 'RUNNING' | 'QUEUED'])[] = [];
    for (const id of missing) {
      const state = Object.hasOwn(pending, id) ? pending[id] : undefined;
      if (state === 'RUNNING' || state === 'QUEUED') entries.push([id, state]);
    }
    return entries.length === 0 ? undefined : { checkIds: entries.map(([id]) => id), text: stillRunningText(entries) };
  }
  return undefined;
}

/**
 * VER-05: the block keeps the person's view. The reminder the harness would have shown (its
 * explain rendering, `systemMessage` on Claude Code and Codex) rides beside the block; the
 * block's own `decision` and `reason` always win.
 */
function withShownMessage(block: string, shown: string): string {
  if (shown === '') return block;
  try {
    const view = JSON.parse(shown) as unknown;
    const message = isPlainObject(view) ? own(view, 'systemMessage') : undefined;
    if (typeof message !== 'string' || message === '') return block;
    const parsed = JSON.parse(block) as unknown;
    return isPlainObject(parsed) ? JSON.stringify({ systemMessage: message, ...parsed }) : block;
  } catch {
    return block;
  }
}

/**
 * G2: true when an `explain` outcome renders differently from `observe` on this event, so the
 * harness would show it. Kilo and OpenCode render only compaction context, so it is false there.
 */
export function showsExplainOn(adapter: HarnessAdapter, event: NormalizedHarnessEvent): boolean {
  return render(adapter, event, { kind: 'explain', text: 'Jevris explain probe.' }) !== render(adapter, event, { kind: 'observe' });
}

function render(adapter: HarnessAdapter, event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string {
  try {
    const text = native === undefined ? adapter.protocolResponse(event, outcome) : adapter.protocolResponse(event, outcome, native);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(late), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(late);
      },
    );
  });
}

function plainPath(value: string | undefined | null): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') ? value : undefined;
}

/** The most stdin the launcher reads; a larger input is refused (drained, never parsed). */
export const NATIVE_READ_CAP = 8 * 1024 * 1024;
/** Appended where the launcher cut a string so the input would fit. */
export const NATIVE_CUT_MARKER = ' [cut by Jevris]';

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Cuts every string longer than a limit (32768, then 8192, 1024, 256, 64 characters), keeping
 * keys, numbers and structure, until the JSON fits `cap` bytes. Null when even that is too big.
 */
export function fitNative(native: unknown, cap: number): unknown {
  const cut = (value: unknown, limit: number, depth: number): unknown => {
    if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}${NATIVE_CUT_MARKER}` : value;
    if (depth > 64 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => cut(item, limit, depth + 1));
    const out: Record<string, unknown> = {};
    // defineProperty keeps a `__proto__` key as an own key, so the adapter still refuses it.
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) Object.defineProperty(out, key, { value: cut(item, limit, depth + 1), enumerable: true, writable: true, configurable: true });
    return out;
  };
  for (const limit of [32_768, 8192, 1024, 256, 64]) {
    const fitted = cut(native, limit, 0);
    if (utf8Bytes(JSON.stringify(fitted)) <= cap) return fitted;
  }
  return null;
}

/**
 * Runs one hook delivery. `input` is the raw stdin text (already capped by the caller);
 * `startedAtMs` is when the process started, so the deadline covers stdin too.
 */
export async function runLauncher(args: LauncherArgs, input: string | null, deps: LauncherDeps, startedAtMs: number): Promise<LauncherResult> {
  let shimMisses: readonly ShimMissRecord[] = [];
  const pending: { turn: PendingTurn | null } = { turn: null };
  const delivered = await runDelivery(
    args,
    input,
    deps,
    startedAtMs,
    (list) => {
      shimMisses = list;
    },
    (turn) => {
      pending.turn = turn;
    },
  );
  const result = pending.turn === null ? delivered : await withTurn(delivered, pending.turn);
  return shimMisses.length === 0 ? result : { ...result, shimMisses };
}

/** A `route.turn` call made next to a top-level turn's event, with the ids it asked with. */
interface PendingTurn {
  readonly sessionId: string;
  readonly messageId: string | null;
  readonly answer: Promise<RequestResult>;
}

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TURN_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TURN_MODEL = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;
const TURN_VARIANT = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The route.turn body for a Kilo or OpenCode top-level chat.message the shim asked about
 * (`routeTurn: true`): its session and message, and the model the harness resolved for it.
 * Null for anything else, a subagent's message or a malformed id, which asks nothing.
 */
export function routeTurnBody(harness: LauncherName, event: NormalizedHarnessEvent, native: unknown): RouteTurnBody | null {
  if (harness !== 'kilo' && harness !== 'opencode') return null;
  // A normalized event leaves out a null parent, so an absent one is a top-level session.
  if (event.nativeEventName !== 'chat.message' || (event.parentSessionId ?? null) !== null || !isPlainObject(native)) return null;
  const input = own(native, 'input');
  if (!isPlainObject(input)) return null;
  // The model the harness resolved for this turn, `output.message.model` ({providerID, modelID,
  // variant}), not `input.model`, which is undefined when the turn names none (R53). The message
  // id is the caller's, else the one the harness gave the resolved message.
  const output = own(native, 'output');
  const message = isPlainObject(output) ? own(output, 'message') : undefined;
  const sessionId = own(input, 'sessionID');
  const given = own(input, 'messageID');
  const messageId = given !== undefined && given !== null ? given : isPlainObject(message) ? own(message, 'id') : undefined;
  const model = isPlainObject(message) ? own(message, 'model') : undefined;
  const variant = isPlainObject(model) ? own(model, 'variant') : undefined;
  if (typeof sessionId !== 'string' || !TURN_ID.test(sessionId) || sessionId !== event.sessionId || !isPlainObject(model)) return null;
  if (messageId !== undefined && messageId !== null && (typeof messageId !== 'string' || !TURN_ID.test(messageId))) return null;
  const providerID = own(model, 'providerID');
  const modelID = own(model, 'modelID');
  if (typeof providerID !== 'string' || !TURN_PROVIDER.test(providerID) || typeof modelID !== 'string' || !TURN_MODEL.test(modelID)) return null;
  if (variant !== undefined && variant !== null && (typeof variant !== 'string' || !TURN_VARIANT.test(variant))) return null;
  return {
    harness: harness === 'kilo' ? 'kilocode' : 'opencode',
    sessionId,
    ...(typeof messageId === 'string' ? { messageId } : {}),
    current: { providerID, modelID, ...(typeof variant === 'string' ? { variant } : {}) },
    modelPin: null,
  };
}

/**
 * Adds a route.turn answer to the turn's response as `{"turn":{sessionId, messageId, payload}}`,
 * next to any text it shows. Only an answer that passes RouteTurnPayloadContract is added; a
 * failed, late or invalid one adds nothing, so the turn keeps its model.
 */
async function withTurn(result: LauncherResult, turn: PendingTurn): Promise<LauncherResult> {
  let answer: RequestResult;
  try {
    answer = await turn.answer;
  } catch {
    return result;
  }
  if (!answer.ok) return result;
  const checked = RouteTurnPayloadContract.validate(answer.result);
  if (!checked.ok) return result;
  let base: Record<string, unknown> = {};
  if (result.stdout.length > 0) {
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!isPlainObject(parsed) || Object.hasOwn(parsed, 'turn')) return result;
      base = parsed;
    } catch {
      return result;
    }
  }
  const stdout = JSON.stringify({ ...base, turn: { sessionId: turn.sessionId, messageId: turn.messageId, payload: checked.value } });
  return { ...result, stdout };
}

async function runDelivery(
  args: LauncherArgs,
  input: string | null,
  deps: LauncherDeps,
  startedAtMs: number,
  onShimMisses: (list: readonly ShimMissRecord[]) => void,
  onTurn: (turn: PendingTurn) => void,
): Promise<LauncherResult> {
  const adapter = deps.adapters[args.harness];
  const observe = (event: NormalizedHarnessEvent | null, reason: string): LauncherResult => {
    deps.log?.(`jevris-hook ${args.harness} ${reason}`);
    return { exitCode: 0, stdout: render(adapter, event, { kind: 'observe' }), reason };
  };
  if (input === null) return observe(null, 'INPUT_REFUSED');
  let native: unknown;
  // Whether the input reached the launcher whole; a route is rendered only from a whole input.
  let whole = true;
  try {
    native = JSON.parse(input) as unknown;
  } catch {
    return observe(null, 'INVALID_JSON');
  }
  // G16: a Kilo or OpenCode shim carries the misses it counted on its side; they are taken off
  // the event before the adapter reads it, so the event is the one the shim normalized.
  if ((args.harness === 'kilo' || args.harness === 'opencode') && isPlainObject(native) && Object.hasOwn(native, 'shimMisses')) {
    const { shimMisses, ...rest } = native;
    onShimMisses(shimMissesOf(shimMisses));
    native = rest;
  }
  // OD-8: the shim asks route.turn only for a top-level turn it may switch; the flag is taken off
  // before the adapter reads the event.
  let turnAsked = false;
  if ((args.harness === 'kilo' || args.harness === 'opencode') && isPlainObject(native) && Object.hasOwn(native, 'routeTurn')) {
    const { routeTurn, ...rest } = native;
    turnAsked = routeTurn === true;
    native = rest;
  }
  // A large tool response (a big file read, a long command output) is not a reason to lose the
  // event: long strings are cut, with a marker, until the input fits the adapters' bound.
  if (input.length > HARNESS_INPUT_CAP / 4 && utf8Bytes(input) > HARNESS_INPUT_CAP) {
    const fitted = fitNative(native, HARNESS_INPUT_CAP);
    if (fitted === null) return observe(null, 'INPUT_REFUSED');
    native = fitted;
    whole = false;
  }
  let normalized: NormalizeResult;
  try {
    const transcriptBytes = transcriptPosition(deps, native);
    normalized = adapter.normalize(native, { ...(args.event !== null ? { hookKey: args.event } : {}), ...(transcriptBytes === null ? {} : { transcriptBytes }) });
  } catch {
    return observe(null, 'NORMALIZE_FAILED');
  }
  if (!normalized.ok) return observe(null, normalized.reasonCode);
  const event = normalized.event;
  const intent: HarnessIntent = normalized.intent ?? {};
  if (deps.env['JEVRIS_HOOK_OBSERVE_ONLY'] === '1') return observe(event, 'OBSERVE_ONLY');

  const budget = deadlineMs(deps.env);
  const remaining = (): number => budget - (deps.nowMs() - startedAtMs);
  if (remaining() <= 0) return observe(event, 'DEADLINE');
  const home = plainPath(deps.env['JEVRIS_HOME']);
  const homeInput = home !== undefined ? { home } : {};

  // One connection per hook (audit P11, owner decision ededdba): the request goes first, with no
  // probe connect. Only when it finds no sidecar (`unavailable`) is the sidecar started on demand,
  // without waiting for it (IPC-13); this delivery observes. With JEVRIS_SIDECAR_AUTOSTART=0
  // nothing is started: a running sidecar still answers, and with none the delivery observes
  // (SIDECAR_AUTOSTART_OFF).
  const autostart = deps.env['JEVRIS_SIDECAR_AUTOSTART'] !== '0';

  const workspace = plainPath(event.cwd) ?? plainPath(deps.env['CLAUDE_PROJECT_DIR']) ?? plainPath(deps.cwd());
  const harnessVersion = suppliedVersion(deps, args.harness, native);
  // G21: the session's sign-in, so a subagent route can leave out models this account cannot use.
  const authMode = sessionAuthMode(args.harness, deps.env);
  // G2 (agreed with D): whether this harness can show an explain outcome on this event, from the
  // adapter's own renderer, so D does not spend a reminder where it cannot be shown.
  const showsExplain = showsExplainOn(adapter, event);
  // R68: a turn that ended on an error carries its access signal (codes and a pattern id, never
  // text), unless its endpoint is redirected. Only such events read anything here.
  const access = sessionAccessOf(args.harness, event, native, deps.nowMs());
  let envelope = event;
  if (access !== null && deps.endpointRedirected !== undefined) {
    const redirected = await withDeadline(deps.endpointRedirected(args.harness, access.provider, workspace).catch(() => true), Math.max(1, remaining()), true);
    if (!redirected) envelope = { ...event, payload: { ...event.payload, accessSignal: access.signal } };
  }
  const left = remaining();
  if (left <= 0) return observe(event, 'DEADLINE');
  // route.turn runs next to the event, inside the same deadline (C: a hot op with no network call).
  const turnBody = turnAsked ? routeTurnBody(args.harness, event, native) : null;
  if (turnBody !== null) {
    onTurn({
      sessionId: turnBody.sessionId,
      messageId: turnBody.messageId ?? null,
      answer: withDeadline(
        deps.sidecar.request({ ...homeInput, op: 'route.turn', ...(workspace !== undefined ? { workspace } : {}), body: turnBody, scope: 'hook', timeoutMs: left, eventAtMs: startedAtMs, budget: 'hot' }),
        left,
        { ok: false, reason: 'timeout', reasonCode: 'HOOK_DEADLINE', message: 'deadline' } as RequestResult,
      ),
    });
  }
  const answer = await withDeadline(
    deps.sidecar.request({
      ...homeInput,
      op: 'event',
      ...(workspace !== undefined ? { workspace } : {}),
      // The decision inputs (INT-01..05) ride next to the envelope, never inside it.
      body: { envelope, deliveryKey: event.dedupKey, ...(harnessVersion === null ? {} : { harnessVersion }), ...(authMode === null ? {} : { authMode }), showsExplain, ...intent },
      scope: 'hook',
      timeoutMs: left,
      eventAtMs: startedAtMs,
      budget: 'hot',
    }),
    left,
    { ok: false, reason: 'timeout', reasonCode: 'HOOK_DEADLINE', message: 'deadline' } as RequestResult,
  );
  if (!answer.ok) {
    if (answer.reason === 'unavailable') {
      if (!autostart) return observe(event, 'SIDECAR_AUTOSTART_OFF');
      const ensured = await withDeadline(deps.sidecar.ensure({ ...homeInput, waitMs: 0 }), Math.max(1, remaining()), {
        ok: false,
        reason: 'timeout',
        message: 'deadline',
      } as EnsureResult);
      // A start the service manager refused, or that would have put a second sidecar beside the
      // service's, names its reason code; the others name the reason.
      if (!ensured.ok) return observe(event, `SIDECAR_${(ensured.reasonCode ?? ensured.reason).toUpperCase()}`);
    }
    return observe(event, answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  }
  if (remaining() <= 0) return observe(event, 'DEADLINE');
  const chosen = chooseOutcome(answer.result);
  // VER-05: the one continuation, only where this harness's Stop can block. The adapter checks
  // the event is a Stop with stop_hook_active false and builds the reason from the ids alone.
  if (chosen.continuation !== null && event.kind === 'turn.stopped' && adapter.stopContinuationResponse !== undefined) {
    let text = '';
    try {
      const running = runningChecksOf(answer.result, chosen.continuation);
      text = running === undefined ? adapter.stopContinuationResponse(event, chosen.continuation) : adapter.stopContinuationResponse(event, chosen.continuation, running);
    } catch {
      text = '';
    }
    if (typeof text === 'string' && text.length > 0) {
      // A replayed answer reads DUPLICATE_REPLAYED whatever it renders (E's review).
      const reason = chosen.reason === 'DUPLICATE_REPLAYED' ? 'DUPLICATE_REPLAYED' : 'STOP_CONTINUATION';
      deps.log?.(`jevris-hook ${args.harness} ${reason}`);
      return { exitCode: 0, stdout: withShownMessage(text, chosen.outcome.kind === 'explain' ? render(adapter, event, chosen.outcome) : ''), reason };
    }
  }
  if (chosen.outcome.kind === 'observe') return observe(event, chosen.reason);
  if (chosen.outcome.kind === 'route') {
    // The adapter maps the model to what the harness takes and keeps its own guards; a route it
    // cannot render (no alias, a model already named, a cut input) is no decision.
    const routed = render(adapter, event, chosen.outcome, whole ? native : undefined);
    if (routed === '') return observe(event, whole ? 'ROUTE_NOT_RENDERED' : 'ROUTE_INPUT_CUT');
    deps.log?.(`jevris-hook ${args.harness} ${chosen.reason}`);
    return { exitCode: 0, stdout: routed, reason: chosen.reason };
  }
  const stdout = render(adapter, event, chosen.outcome);
  deps.log?.(`jevris-hook ${args.harness} ${chosen.reason}`);
  return { exitCode: 0, stdout, reason: chosen.reason };
}

