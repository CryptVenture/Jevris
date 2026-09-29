/**
 * Which models each harness offers to the current sign-in, from the harness's own listing
 * (owner decision 2026-09-27, DOMAINS 3f090fa). No listing makes a billed call or runs a model.
 *
 * - Codex: `codex app-server` over stdio JSON-RPC, `initialize`, then `model/list`, following
 *   `nextCursor`. Hidden models are left out. On a ChatGPT sign-in the same session then sends one
 *   `account/rateLimits/read` (OP-6, owner decision DOMAINS 9deb30c8, read-only): only each
 *   window's used percent, length and reset and `ordinaryUsageAllowed` are read, never the account
 *   id, the plan, the credit balance or any text. Core's `recordAccessUsageReading` keeps a band and
 *   sets or lifts the Codex usage window; the payload is never kept.
 * - OpenCode and Kilo: `opencode models` and `kilo models`, one `provider/model` per line. Never
 *   `--refresh`. A line counts when its provider segment is one the registry's access rows name
 *   for the harness (the provider, or one of its `providerIds`: `moonshotai`, `google-vertex`;
 *   routing design R13), and the id kept is the registry's, else the bare model id. A line the
 *   one resolver (`resolveSpelling`) maps also keeps its own spelling and serving host (serving
 *   hosts R43): a pinned host's line (`openrouter/moonshotai/kimi-k3`) counts only when the
 *   registry has that exact serving for this harness; an unpinned host, a `:free` or `~` line
 *   stays out.
 * - Antigravity: `agy models`, one id per line. Secondary sources only, so it counts only once
 *   certify confirms it on this version. A slug the registry knows (`gemini-3.8-flash-low`) is
 *   kept as its registry id (`gemini-3.8-flash`).
 * - Claude Code (G13, owner decision DOMAINS 9d6a66d): an idle `claude -p` in stream-json mode
 *   that gets only the `initialize` control request and answers with the models its sign-in
 *   offers (the Agent SDK's `supportedModels()`). No user turn is sent, so no model runs and
 *   nothing is billed; the `account` part of the answer is never read.
 *
 * Every listing is gated three ways:
 * 1. `routing.modelListing` is not `off`.
 * 2. A signed record certifies `models.list` for this harness, version and OS. The certify case
 *    (`modelListCheck`) also proves, after a warm-up run, that the listing writes no session,
 *    history or config beyond the few side files the owner allowed, and does not self-update.
 * 3. It is not a test run, and HOME is the account's home.
 *
 * Each listing is bounded:
 * - 10 s, then the process tree is killed;
 * - 256 KiB of stdout;
 * - 512 ids, each checked against MODEL_ID_PATTERN and the secret patterns.
 *
 * The harness's no-update variables are set: OPENCODE_DISABLE_AUTOUPDATE, KILO_DISABLE_AUTOUPDATE
 * and KILO_NO_DAEMON, plus `-c check_for_update_on_startup=false` for Codex.
 *
 * A result carries only the ids, the harness version, or a reason code. It never carries output
 * text, which can name an account. B's sidecar schedules the refresh, and C's
 * `recordModelListing` writes `<data>/route-learning/model-offer.json`.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { MODEL_ID_PATTERN, SECRET_PATTERNS, type ModelRegistry } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, loadModelRegistry, recordAccessUsageReading, resolveSpelling, type AccessUsageWindowInput } from '@jevris/core';
import { jevrisPaths } from '@jevris/platform';
import { coveringCertification, loadCertifications, type CertificationLoad } from './certification-store.js';
import { installedHarnesses, LAUNCHER, type GlobalHarness } from './global-harness.js';
import { versionFromOutput } from './harness-versions.js';
import { launchInteractive, launchStreaming, probeRefusal, type InteractiveLaunch } from './live-harness.js';
import { listedModelId } from './harness-model.js';

import { detectHarnessAuth, type DetectedAuth } from './harness-auth.js';

export { detectHarnessAuth } from './harness-auth.js';

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

type Env = { readonly [key: string]: string | undefined };

/** The certification feature that allows a harness's listing (E's CERTIFICATION_FEATURES). */
export const MODEL_LIST_FEATURE = 'models.list' as const;
/** Each listing's bound; the process tree is killed when it passes. */
export const LISTING_TIMEOUT_MS = 10_000;
/** Stdout beyond this is not read: the listing is killed and fails. */
export const LISTING_STDOUT_CAP = 256 * 1024;
/** At most this many ids are kept per harness (sorted, unique). */
export const LISTING_MODEL_CAP = 512;
/** Codex `model/list` pages followed at most. */
const CODEX_PAGE_CAP = 8;
/** The Codex usage read (OP-6): its method, and how long the listing waits for it after the models. */
export const CODEX_USAGE_READ_METHOD = 'account/rateLimits/read' as const;
export const CODEX_USAGE_READ_TIMEOUT_MS = 3_000;
/** Key variables that make a Codex listing an API-key sign-in, where no usage read is sent. */
const CODEX_KEY_VARS: readonly string[] = ['CODEX_API_KEY', 'OPENAI_API_KEY'];

/** The harnesses that have a listing command; Claude Code has none. */
export const LISTING_HARNESSES: readonly GlobalHarness[] = ['claude', 'codex', 'opencode', 'kilocode', 'antigravity'];

export const LISTING_REASONS = [
  'LISTING_UNSUPPORTED',
  'LISTING_OFF',
  'LISTING_NOT_CERTIFIED',
  'LISTING_REFUSED',
  'HARNESS_NOT_INSTALLED',
  'HARNESS_VERSION_UNKNOWN',
  'LISTING_TIMEOUT',
  'LISTING_TOO_LARGE',
  'LISTING_FAILED',
  'LISTING_MALFORMED',
  'LISTING_ABORTED',
] as const;
export type ListingReason = (typeof LISTING_REASONS)[number];

/** One listed line the resolver mapped: its own spelling, its registry model and its serving host (C's ModelSpelling). */
export interface ListedSpelling {
  readonly raw: string;
  readonly modelId: string;
  readonly servingHost: string;
}

/**
 * B's ModelListing: the ids and the harness version, or a reason code. Kilo and OpenCode also
 * give the spellings their lines used (R43), which C's `recordModelListing` keeps.
 */
export type ModelListing =
  | {
      readonly ok: true;
      readonly version: string | null;
      readonly models: readonly string[];
      readonly spellings?: readonly ListedSpelling[];
      /**
       * Codex (OP-6): what core did with the usage reading, for the caller's trace
       * (ACCESS_LIMIT_RECORDED when `recorded`, ACCESS_LIMIT_CLEARED USAGE_READ per lifted entry).
       * Absent when no reading was sent, answered or kept.
       */
      readonly usage?: { readonly recorded: boolean; readonly lifted: number };
    }
  | { readonly ok: false; readonly reasonCode: ListingReason };

/** A Codex usage read as the listing passes it on: numbers and one flag, never the payload. */
export interface CodexUsageRead {
  readonly windows: readonly AccessUsageWindowInput[];
  readonly ordinaryUsageAllowed: boolean | null;
}

/** A test or certify can name the binary: `file` then `args` come before the listing's own argv. */
export interface ListingCommand {
  readonly file: string;
  readonly args?: readonly string[];
}

const ID = new RegExp(MODEL_ID_PATTERN, 'u');
const SECRETS = SECRET_PATTERNS.map((pattern) => new RegExp(pattern, 'u'));
const PROVIDER_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/;

/** True for an id the store may keep: the model id pattern, and nothing that looks like a secret. */
export function validModelId(id: string): boolean {
  return ID.test(id) && !SECRETS.some((pattern) => pattern.test(id));
}

function finish(ids: Iterable<string>): readonly string[] {
  return [...new Set(ids)].sort().slice(0, LISTING_MODEL_CAP);
}

/**
 * `opencode models` / `kilo models` output: one `provider/model` per line. A line that is not
 * `provider/model` makes the whole listing malformed. A line the one resolver maps (a maker
 * endpoint, or a pinned host's exact serving for this harness) counts as its model and keeps its
 * spelling and serving host (R43); any other line for a provider the registry does not name for
 * this harness is left out (listedModelId). At most 512 models and 512 spellings, sorted.
 */
export function parseProviderListing(stdout: string, harness: 'opencode' | 'kilocode' = 'opencode', registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): { readonly models: readonly string[]; readonly spellings: readonly ListedSpelling[] } | null {
  const ids: string[] = [];
  const spellings = new Map<string, ListedSpelling>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!PROVIDER_LINE.test(line)) return null;
    const resolved = SECRETS.some((pattern) => pattern.test(line)) ? null : resolveSpelling(registry, harness, line);
    if (resolved !== null && validModelId(resolved.modelId)) {
      ids.push(resolved.modelId);
      if (!spellings.has(line)) spellings.set(line, { raw: line, modelId: resolved.modelId, servingHost: resolved.servingHost });
      continue;
    }
    const id = listedModelId(registry, harness, line);
    if (id !== null && validModelId(id)) ids.push(id);
  }
  const models = finish(ids);
  const kept = [...spellings.values()].filter((item) => models.includes(item.modelId)).sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0)).slice(0, LISTING_MODEL_CAP);
  return { models, spellings: kept };
}

/** `agy models` output: one id per line; any other line makes the listing malformed. A known slug is kept as its registry id. */
export function parsePlainListing(stdout: string, registry: ModelRegistry = BUNDLED_MODEL_REGISTRY): readonly string[] | null {
  const ids: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!validModelId(line)) return null;
    ids.push(listedModelId(registry, 'antigravity', line) ?? line);
  }
  return finish(ids);
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One Codex `model/list` result: the visible models' ids and the next cursor, or null when malformed. */
export function parseCodexModelPage(result: unknown): { readonly models: readonly string[]; readonly nextCursor: string | null } | null {
  if (!isObject(result) || !Array.isArray(result['data'])) return null;
  const models: string[] = [];
  for (const item of result['data']) {
    if (!isObject(item)) return null;
    if (item['hidden'] === true) continue;
    const id = typeof item['model'] === 'string' ? item['model'] : typeof item['id'] === 'string' ? item['id'] : null;
    if (id === null) return null;
    if (validModelId(id)) models.push(id);
  }
  const cursor = result['nextCursor'];
  return { models, nextCursor: typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 1024 ? cursor : null };
}

/** The environment a listing runs with: the caller's, plus each harness's no-update variables. */
export function listingEnv(harness: GlobalHarness, base: Env): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string') env[key] = value;
  if (harness === 'opencode') env['OPENCODE_DISABLE_AUTOUPDATE'] = '1';
  if (harness === 'kilocode') {
    env['KILO_DISABLE_AUTOUPDATE'] = '1';
    env['KILO_NO_DAEMON'] = '1';
  }
  return env;
}

/**
 * Claude Code's idle session for the listing. Print mode reads stream-json from stdin and waits
 * for a user message, which is never sent. No session is saved, no MCP server or slash command
 * loads, and hooks are off for this process only (`disableAllHooks` in a per-run --settings), so
 * the listing records no Jevris session. Every flag is in `claude --help`; certify proves it.
 */
export const CLAUDE_LISTING_ARGV: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--settings',
  '{"disableAllHooks":true}',
];

/** The per-run settings the listing passes to Claude Code (the last item of CLAUDE_LISTING_ARGV). */
export const CLAUDE_LISTING_SETTINGS = '{"disableAllHooks":true}';

/**
 * The listing argv with `--settings` naming a file that holds CLAUDE_LISTING_SETTINGS. Windows
 * uses it: an npm-installed Claude Code is a `claude.cmd` shim, and a cmd shim never carries an
 * argument with a double quote (planSpawn refuses it, so the JSON form reads as not installed).
 */
export function claudeListingArgv(settingsFile?: string): readonly string[] {
  return settingsFile === undefined ? CLAUDE_LISTING_ARGV : [...CLAUDE_LISTING_ARGV.slice(0, -1), settingsFile];
}

/** Windows: a private temp folder with the listing's settings file; null when it cannot be written. */
async function listingSettingsFile(): Promise<{ readonly file: string; readonly remove: () => Promise<void> } | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'jevris-listing-'));
    const file = join(dir, 'settings.json');
    await writeFile(file, `${CLAUDE_LISTING_SETTINGS}\n`, { flag: 'wx', mode: 0o600 });
    const made = dir;
    return { file, remove: () => rm(made, { recursive: true, force: true }).catch(() => undefined) };
  } catch {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/** The listing's own argv (after any command prefix). */
export function listingArgv(harness: GlobalHarness): readonly string[] | null {
  switch (harness) {
    case 'codex':
      return ['-c', 'check_for_update_on_startup=false', 'app-server'];
    case 'opencode':
    case 'kilocode':
    case 'antigravity':
      return ['models'];
    case 'claude':
      return CLAUDE_LISTING_ARGV;
  }
}

/**
 * The ids in Claude Code's `initialize` answer: each model's `resolvedModel` (the wire id an alias
 * resolves to), else its `value` when that is a full `claude-` id. Aliases with no resolved id
 * (`default`, `sonnet`) are left out. Null when the answer has no model list.
 */
export function parseClaudeInitialize(response: unknown): readonly string[] | null {
  if (!isObject(response) || !Array.isArray(response['models'])) return null;
  const ids: string[] = [];
  for (const item of response['models']) {
    if (!isObject(item)) return null;
    const resolved = item['resolvedModel'];
    const value = item['value'];
    const id = typeof resolved === 'string' && resolved.length > 0 ? resolved : typeof value === 'string' && value.startsWith('claude-') ? value : null;
    if (id !== null && validModelId(id)) ids.push(id);
  }
  return finish(ids);
}

export interface RawListingInput {
  readonly harness: GlobalHarness;
  readonly command?: ListingCommand;
  readonly env: Env;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** The loaded registry that maps listed ids to registry ids. Default: the bundled snapshot. */
  readonly registry?: ModelRegistry;
  /** Codex (OP-6): also send one `account/rateLimits/read` after the models. The caller decides the sign-in. */
  readonly usageRead?: boolean;
  /** Tests: the usage read's own bound after the models (default CODEX_USAGE_READ_TIMEOUT_MS). */
  readonly usageReadTimeoutMs?: number;
}

export type RawListing =
  | {
      readonly ok: true;
      readonly models: readonly string[];
      /** Kilo and OpenCode: the spellings their lines used (R43). */
      readonly spellings?: readonly ListedSpelling[];
      /** Claude Code: the listing process's pid, which certify needs to know its own session register entry. */
      readonly pid?: number;
      /** Codex: the usage read, when it was asked for and answered with a reading that parses (OP-6). */
      readonly usage?: CodexUsageRead;
    }
  | { readonly ok: false; readonly reasonCode: ListingReason };

function commandOf(harness: GlobalHarness, command: ListingCommand | undefined): { readonly file: string; readonly prefix: readonly string[] } {
  return command === undefined ? { file: LAUNCHER[harness], prefix: [] } : { file: command.file, prefix: command.args ?? [] };
}

/** Bounds one launch: the timeout, the caller's abort and the stdout cap all kill the tree. */
function bound(
  launched: { readonly done: Promise<{ readonly spawned: boolean; readonly code: number | null }>; kill(): void },
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { readonly stop: (reason: ListingReason) => void; readonly outcome: Promise<{ readonly spawned: boolean; readonly code: number | null; readonly stopped: ListingReason | null }> } {
  let stopped: ListingReason | null = null;
  const stop = (reason: ListingReason): void => {
    if (stopped === null) stopped = reason;
    launched.kill();
  };
  const timer = setTimeout(() => stop('LISTING_TIMEOUT'), timeoutMs);
  const onAbort = (): void => stop('LISTING_ABORTED');
  signal?.addEventListener('abort', onAbort, { once: true });
  const outcome = launched.done.then((exit) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    return { spawned: exit.spawned, code: exit.code, stopped };
  });
  return { stop, outcome };
}

async function lineListing(input: RawListingInput, parse: (stdout: string) => { readonly models: readonly string[]; readonly spellings?: readonly ListedSpelling[] } | null): Promise<RawListing> {
  const { file, prefix } = commandOf(input.harness, input.command);
  const argv = listingArgv(input.harness) ?? [];
  let bytes = 0;
  let text = '';
  let over = false;
  let stop: ((reason: ListingReason) => void) | null = null;
  const launched = launchStreaming(file, [...prefix, ...argv], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: listingEnv(input.harness, input.env),
    input: '',
    onLine: (line) => {
      if (over) return;
      bytes += line.length + 1;
      if (bytes > LISTING_STDOUT_CAP) {
        over = true;
        text = '';
        stop?.('LISTING_TOO_LARGE');
        return;
      }
      text += `${line}\n`;
    },
  });
  const bounded = bound(launched, input.timeoutMs ?? LISTING_TIMEOUT_MS, input.signal);
  stop = bounded.stop;
  const exit = await bounded.outcome;
  if (!exit.spawned) return { ok: false, reasonCode: 'HARNESS_NOT_INSTALLED' };
  if (exit.stopped !== null) return { ok: false, reasonCode: exit.stopped };
  if (over) return { ok: false, reasonCode: 'LISTING_TOO_LARGE' };
  if (exit.code !== 0) return { ok: false, reasonCode: 'LISTING_FAILED' };
  const parsed = parse(text);
  return parsed === null ? { ok: false, reasonCode: 'LISTING_MALFORMED' } : { ok: true, models: parsed.models, ...(parsed.spellings === undefined ? {} : { spellings: parsed.spellings }) };
}

/** The Codex app-server conversation: initialize, initialized, then model/list page by page. */
async function codexListing(input: RawListingInput): Promise<RawListing> {
  const { file, prefix } = commandOf(input.harness, input.command);
  const argv = listingArgv('codex') ?? [];
  let bytes = 0;
  let nextId = 1;
  const models: string[] = [];
  let pages = 0;
  let result: RawListing | null = null;
  let session: InteractiveLaunch | null = null;
  let stop: ((reason: ListingReason) => void) | null = null;
  const settle = (value: RawListing): void => {
    if (result !== null) return;
    result = value;
    session?.endInput();
    session?.kill();
  };
  const request = (method: string, params: unknown): number => {
    const id = nextId;
    nextId += 1;
    session?.send(`${JSON.stringify({ id, method, params })}\n`);
    return id;
  };
  let initializeId = -1;
  let listId = -1;
  let usageId = -1;
  // The models, once every page is in; the listing waits only a bounded time for the usage read.
  let listed: RawListing | null = null;
  let usageTimer: number | null = null;
  const finishUsage = (usage: CodexUsageRead | null): void => {
    if (usageTimer !== null) clearTimeout(usageTimer);
    usageTimer = null;
    if (listed !== null && listed.ok) settle(usage === null ? listed : { ...listed, usage });
  };
  const onLine = (line: string): void => {
    if (result !== null) return;
    bytes += line.length + 1;
    if (bytes > LISTING_STDOUT_CAP) {
      stop?.('LISTING_TOO_LARGE');
      settle({ ok: false, reasonCode: 'LISTING_TOO_LARGE' });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not a protocol message (a log line); the timeout still bounds the run
    }
    if (!isObject(message) || typeof message['id'] !== 'number') return; // a notification
    if (message['id'] === usageId) {
      // An error or a malformed answer leaves the listing as it was, with no reading.
      finishUsage(message['error'] === undefined ? parseCodexRateLimits(message['result']) : null);
      return;
    }
    if (message['error'] !== undefined) {
      settle({ ok: false, reasonCode: 'LISTING_FAILED' });
      return;
    }
    if (message['id'] === initializeId) {
      session?.send(`${JSON.stringify({ method: 'initialized' })}\n`);
      listId = request('model/list', {});
      return;
    }
    if (message['id'] !== listId) return;
    const page = parseCodexModelPage(message['result']);
    if (page === null) {
      settle({ ok: false, reasonCode: 'LISTING_MALFORMED' });
      return;
    }
    models.push(...page.models);
    pages += 1;
    if (page.nextCursor !== null && pages < CODEX_PAGE_CAP && models.length < LISTING_MODEL_CAP) {
      listId = request('model/list', { cursor: page.nextCursor });
      return;
    }
    const done: RawListing = { ok: true, models: finish(models) };
    if (input.usageRead !== true) {
      settle(done);
      return;
    }
    listed = done;
    // `excludeResetCreditDetails`: Codex's background-poll form, which skips its second backend
    // lookup (the reset-credit list, never read here), so the read is one request to OpenAI.
    usageId = request(CODEX_USAGE_READ_METHOD, { excludeResetCreditDetails: true });
    usageTimer = setTimeout(() => finishUsage(null), Math.max(1, input.usageReadTimeoutMs ?? CODEX_USAGE_READ_TIMEOUT_MS));
  };
  session = launchInteractive(file, [...prefix, ...argv], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: listingEnv('codex', input.env),
    onLine,
  });
  const bounded = bound(session, input.timeoutMs ?? LISTING_TIMEOUT_MS, input.signal);
  stop = bounded.stop;
  if (session.pid !== undefined) initializeId = request('initialize', { clientInfo: { name: 'jevris', title: 'Jevris', version: '1' } });
  const exit = await bounded.outcome;
  if (usageTimer !== null) clearTimeout(usageTimer);
  const settled = result as RawListing | null;
  if (settled !== null) return settled;
  // The app-server ended (or the bound passed) while the usage read was pending: the models stand.
  const pending = listed as RawListing | null;
  if (pending !== null) return pending;
  if (!exit.spawned) return { ok: false, reasonCode: 'HARNESS_NOT_INSTALLED' };
  if (exit.stopped !== null) return { ok: false, reasonCode: exit.stopped };
  return { ok: false, reasonCode: 'LISTING_FAILED' };
}

const CLAUDE_INITIALIZE_ID = 'jevris-models';

/** Codex `account/rateLimits/read`'s window: `{usedPercent, windowDurationMins, resetsAt}` (resetsAt in epoch seconds). */
function codexUsageWindow(value: unknown): AccessUsageWindowInput | null {
  if (!isObject(value)) return null;
  const used = value['usedPercent'];
  const minutes = value['windowDurationMins'];
  const resets = value['resetsAt'];
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (minutes !== null && minutes !== undefined && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0)) return null;
  if (resets !== null && resets !== undefined && (typeof resets !== 'number' || !Number.isSafeInteger(resets) || resets <= 0)) return null;
  return { usedPercent: used, windowMinutes: typeof minutes === 'number' ? minutes : null, resetsAtMs: typeof resets === 'number' ? resets * 1000 : null };
}

/**
 * One `account/rateLimits/read` result (OP-6): the back-compatible `rateLimits` bucket's primary
 * and secondary windows and `ordinaryUsageAllowed`. Null when it is malformed or names no window:
 * a window that does not parse drops the whole reading, never a guess. Nothing else is read.
 */
export function parseCodexRateLimits(result: unknown): CodexUsageRead | null {
  if (!isObject(result) || !isObject(result['rateLimits'])) return null;
  const allowed = result['ordinaryUsageAllowed'];
  if (allowed !== null && allowed !== undefined && typeof allowed !== 'boolean') return null;
  const windows: AccessUsageWindowInput[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const raw = result['rateLimits'][key];
    if (raw === null || raw === undefined) continue;
    const window = codexUsageWindow(raw);
    if (window === null) return null;
    windows.push(window);
  }
  return windows.length === 0 ? null : { windows, ordinaryUsageAllowed: typeof allowed === 'boolean' ? allowed : null };
}

/** Claude Code's listing: one `initialize` control request on an idle print session, then stop. */
async function claudeListing(input: RawListingInput): Promise<RawListing> {
  const settings = process.platform === 'win32' ? await listingSettingsFile() : null;
  try {
    return await claudeListingWith(input, claudeListingArgv(settings?.file));
  } finally {
    await settings?.remove();
  }
}

async function claudeListingWith(input: RawListingInput, argv: readonly string[]): Promise<RawListing> {
  const { file, prefix } = commandOf(input.harness, input.command);
  let bytes = 0;
  let result: RawListing | null = null;
  let session: InteractiveLaunch | null = null;
  let stop: ((reason: ListingReason) => void) | null = null;
  const settle = (value: RawListing): void => {
    if (result !== null) return;
    result = value;
    session?.endInput();
    session?.kill();
  };
  const onLine = (line: string): void => {
    if (result !== null) return;
    bytes += line.length + 1;
    if (bytes > LISTING_STDOUT_CAP) {
      stop?.('LISTING_TOO_LARGE');
      settle({ ok: false, reasonCode: 'LISTING_TOO_LARGE' });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(message) || message['type'] !== 'control_response' || !isObject(message['response'])) return; // system and hook events
    const response = message['response'];
    if (response['request_id'] !== CLAUDE_INITIALIZE_ID) return;
    if (response['subtype'] !== 'success') {
      settle({ ok: false, reasonCode: 'LISTING_FAILED' });
      return;
    }
    const models = parseClaudeInitialize(response['response']);
    settle(models === null ? { ok: false, reasonCode: 'LISTING_MALFORMED' } : { ok: true, models, ...(session?.pid === undefined ? {} : { pid: session.pid }) });
  };
  session = launchInteractive(file, [...prefix, ...argv], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: listingEnv('claude', input.env),
    onLine,
  });
  const bounded = bound(session, input.timeoutMs ?? LISTING_TIMEOUT_MS, input.signal);
  stop = bounded.stop;
  if (session.pid !== undefined) session.send(`${JSON.stringify({ type: 'control_request', request_id: CLAUDE_INITIALIZE_ID, request: { subtype: 'initialize' } })}\n`);
  const exit = await bounded.outcome;
  const settled = result as RawListing | null;
  if (settled !== null) return settled;
  if (!exit.spawned) return { ok: false, reasonCode: 'HARNESS_NOT_INSTALLED' };
  if (exit.stopped !== null) return { ok: false, reasonCode: exit.stopped };
  return { ok: false, reasonCode: 'LISTING_FAILED' };
}

/**
 * Runs one harness's listing with no gate: the caller decides whether it may run (certify's
 * throwaway profile, or listOfferedModels after its gates). Never throws.
 */
export async function runModelListing(input: RawListingInput): Promise<RawListing> {
  if (input.signal?.aborted === true) return { ok: false, reasonCode: 'LISTING_ABORTED' };
  try {
    switch (input.harness) {
      case 'codex':
        return await codexListing(input);
      case 'opencode':
      case 'kilocode': {
        const harness = input.harness;
        return await lineListing(input, (stdout) => parseProviderListing(stdout, harness, input.registry));
      }
      case 'antigravity':
        return await lineListing(input, (stdout) => {
          const models = parsePlainListing(stdout, input.registry);
          return models === null ? null : { models };
        });
      case 'claude':
        return await claudeListing(input);
    }
  } catch {
    return { ok: false, reasonCode: 'LISTING_FAILED' };
  }
}

/** `<bin> --version`, bounded like a listing; null when it printed no version. */
async function listingVersion(harness: GlobalHarness, command: ListingCommand | undefined, env: Env, timeoutMs: number, signal: AbortSignal | undefined): Promise<{ readonly spawned: boolean; readonly version: string | null }> {
  const { file, prefix } = commandOf(harness, command);
  let text = '';
  const launched = launchStreaming(file, [...prefix, '--version'], {
    env: listingEnv(harness, env),
    input: '',
    onLine: (line) => {
      if (text.length < 4096) text += `${line}\n`;
    },
  });
  const exit = await bound(launched, timeoutMs, signal).outcome;
  if (!exit.spawned) return { spawned: false, version: null };
  return { spawned: true, version: exit.stopped === null && exit.code === 0 ? versionFromOutput(text) : null };
}

/** `routing.modelListing` from the effective config: anything but `off` is on (the default). */
export async function modelListingSetting(home: string, env?: Env): Promise<'on' | 'off'> {
  try {
    const { readEffectiveConfig } = await import('@jevris/orchestrator');
    const routing: unknown = readEffectiveConfig({ home, ...(env === undefined ? {} : { env }) }).config.routing;
    return isObject(routing) && routing['modelListing'] === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

/** True when a signed record covers `models.list` for this harness, version and OS now. */
export function listingCertified(load: CertificationLoad, harness: GlobalHarness, version: string, nowMs: number, platform: string = process.platform): boolean {
  return coveringCertification(load, { harness, harnessVersion: version, operatingSystem: platform, nowMs, featureId: MODEL_LIST_FEATURE }).covered !== null;
}

export interface ListOfferedModelsInput {
  readonly home: string;
  readonly harness: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** The listing's environment; default this process's. */
  readonly env?: Env;
  /** Tests: a stub binary instead of the harness's launcher on PATH. */
  readonly command?: ListingCommand;
  /** Tests: the certification records; default loaded from the home. */
  readonly load?: CertificationLoad;
  readonly nowMs?: number;
  readonly platform?: string;
  /**
   * Tests: Codex's login as `codex login status` reports it (default: asked read-only, never in a
   * test run or under a foreign HOME). The usage read is sent only on a ChatGPT login.
   */
  readonly codexLogin?: () => Promise<DetectedAuth>;
}

/**
 * Whether the Codex listing sends the usage read (OP-6): only on a ChatGPT sign-in Jevris can
 * vouch for, so the reading's authMode is 'subscription' and never a value from the payload (B).
 * A key in the listing's environment makes it an API-key sign-in, where nothing is read.
 */
export async function codexUsageSignIn(env: Env, login: () => Promise<DetectedAuth>): Promise<'subscription' | null> {
  if (CODEX_KEY_VARS.some((key) => (env[key] ?? '') !== '')) return null;
  try {
    return (await login()) === 'subscription' ? 'subscription' : null;
  } catch {
    return null;
  }
}

/** The certification feature that lets a Codex usage reading lift a usage window (K21). */
export const USAGE_READ_FEATURE = 'access.usage-read' as const;

/**
 * Whether a signed record certifies the usage read (K21) for this Codex version and OS now, from
 * the same records and check as the listing's own gate. An `unsupported` record, another version
 * or an unreadable record never certifies.
 */
export function usageReadCertified(load: CertificationLoad, version: string, nowMs: number, platform: string = process.platform): boolean {
  return coveringCertification(load, { harness: 'codex', harnessVersion: version, operatingSystem: platform, nowMs, featureId: USAGE_READ_FEATURE }).covered !== null;
}

/**
 * Hands a Codex usage read to core (OP-6). `certified` comes from the signed record for the
 * installed version (usageReadCertified): uncertified, a reading can set a timed usage window but
 * never lift one. Never throws; a failure keeps the listing as it was.
 */
async function applyUsageRead(home: string, usage: CodexUsageRead, nowMs: number, certified: boolean): Promise<{ readonly recorded: boolean; readonly lifted: number } | null> {
  const result = await recordAccessUsageReading({
    home,
    nowMs,
    reading: { harness: 'codex', authMode: 'subscription', windows: usage.windows, ordinaryUsageAllowed: usage.ordinaryUsageAllowed, certified },
  }).catch(() => null);
  return result === null || !result.ok ? null : { recorded: result.recorded !== null, lifted: result.lifted.length };
}

function knownHarness(value: string): GlobalHarness | null {
  return (['claude', 'kilocode', 'codex', 'opencode', 'antigravity'] as const).find((item) => item === value) ?? null;
}

/**
 * The models this harness offers to the current sign-in (B's sidecar calls it while idle, one
 * harness at a time). Model ids only, or a reason code. Never throws, never makes a billed call.
 */
export async function listOfferedModels(input: ListOfferedModelsInput): Promise<ModelListing> {
  const harness = knownHarness(input.harness);
  if (harness === null || !LISTING_HARNESSES.includes(harness)) return { ok: false, reasonCode: 'LISTING_UNSUPPORTED' };
  if ((await modelListingSetting(input.home, input.env)) === 'off') return { ok: false, reasonCode: 'LISTING_OFF' };
  const env = input.env ?? process.env;
  // The real binary never starts in a test run, or under a HOME that is not the account's.
  if (input.command === undefined && probeRefusal(env, input.home) !== null) return { ok: false, reasonCode: 'LISTING_REFUSED' };
  const timeoutMs = Math.min(Math.max(1, input.timeoutMs ?? LISTING_TIMEOUT_MS), LISTING_TIMEOUT_MS);
  const probed = await listingVersion(harness, input.command, env, timeoutMs, input.signal);
  if (!probed.spawned) return { ok: false, reasonCode: 'HARNESS_NOT_INSTALLED' };
  if (probed.version === null) return { ok: false, reasonCode: 'HARNESS_VERSION_UNKNOWN' };
  const load = input.load ?? (await loadCertifications(input.home));
  const nowMs = input.nowMs ?? Date.now();
  if (!listingCertified(load, harness, probed.version, nowMs, input.platform)) return { ok: false, reasonCode: 'LISTING_NOT_CERTIFIED' };
  const cwd = jevrisPaths({ home: input.home }).data;
  await mkdir(cwd, { recursive: true }).catch(() => undefined);
  const registry = (await loadModelRegistry({ home: input.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const usageRead = harness === 'codex' && (await codexUsageSignIn(env, input.codexLogin ?? (() => detectHarnessAuth('codex', env)))) !== null;
  const listed = await runModelListing({ harness, env, cwd, timeoutMs, registry, usageRead, ...(input.command === undefined ? {} : { command: input.command }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
  if (!listed.ok) return listed;
  const usage = usageRead && listed.usage !== undefined ? await applyUsageRead(input.home, listed.usage, nowMs, usageReadCertified(load, probed.version, nowMs, input.platform)) : null;
  return { ok: true, version: probed.version, models: listed.models, ...(listed.spellings === undefined ? {} : { spellings: listed.spellings }), ...(usage === null ? {} : { usage }) };
}

/** The installed harnesses that have a listing (B's `installed` port). */
export async function listingHarnesses(home: string): Promise<readonly GlobalHarness[]> {
  return (await installedHarnesses(jevrisPaths({ home }).data)).filter((harness) => LISTING_HARNESSES.includes(harness));
}

// ---- certify: the models.list case (built for certify; never run outside its throwaway profile) ----

/** A file's size and change time, or a folder, keyed by its path relative to the profile. */
export type TreeSnapshot = ReadonlyMap<string, string>;

export const SNAPSHOT_CAP = 20_000;

/**
 * Whether a snapshot may have been cut short at SNAPSHOT_CAP. A cut snapshot can leave out a
 * write, so the certify case fails on one (B's review, with the coordinator).
 */
export function snapshotTruncated(snapshot: TreeSnapshot): boolean {
  return snapshot.size >= SNAPSHOT_CAP;
}

/** Every entry under `root`, without following links; capped at 20,000 entries. */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    if (out.size >= SNAPSHOT_CAP) return;
    let names: readonly string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.size >= SNAPSHOT_CAP) return;
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join('/');
      try {
        const st = await lstat(path);
        if (st.isDirectory()) {
          out.set(rel, 'dir');
          await walk(path);
        } else {
          out.set(rel, `${st.size}:${st.mtimeMs}`);
        }
      } catch {
        // Gone between the listing and the stat: the next snapshot says so.
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * The paths added, changed or removed between two snapshots. A folder counts only when it was
 * added or removed with nothing touched inside it; otherwise the files inside it are named.
 */
export function touchedPaths(before: TreeSnapshot, after: TreeSnapshot): readonly string[] {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const [path, stamp] of after) {
    if (before.get(path) === stamp) continue;
    (stamp === 'dir' || before.get(path) === 'dir' ? dirs : files).add(path);
  }
  for (const [path, stamp] of before) if (!after.has(path)) (stamp === 'dir' ? dirs : files).add(path);
  const all = [...files, ...dirs];
  for (const dir of dirs) if (!all.some((path) => path.startsWith(`${dir}/`))) files.add(dir);
  return [...files].sort();
}

const HARMLESS_SEGMENT = /^(?:\.?cache|caches|logs?|tmp)$/i;
// Exact update names only (owner decision 0a9dc8c): `installation_id` or a skill file named
// `installing-*.md` is not an update.
const UPDATE_SEGMENT = /^(?:bin|update|updates|updater|version\.json|\.?install(?:ed|er)?(?:\.(?:json|lock|state))?)$/i;

/**
 * What a touched path means: `harmless` (a cache or log), `self-update` (a binary, updater or
 * version-check file), or `side-effect` (anything else: a session, history, config or database).
 */
export function classifyTouchedPath(path: string): 'harmless' | 'self-update' | 'side-effect' {
  const segments = path.split('/');
  if (segments.some((segment) => UPDATE_SEGMENT.test(segment))) return 'self-update';
  if (segments.some((segment) => HARMLESS_SEGMENT.test(segment)) || /\.log$/i.test(path)) return 'harmless';
  return 'side-effect';
}

export interface ModelListCheck {
  readonly passed: boolean;
  readonly reasonCode: string | null;
  readonly detail: string;
  /**
   * Every path the checked (second) run touched in the profile, relative to it (by path only),
   * plus, for a self-update, the update paths either run touched.
   */
  readonly touched: readonly string[];
}

/** Claude Code 2.1.284's lock on its marketplace list, allowed only gone or empty afterwards. */
const CLAUDE_MARKETPLACE_LOCK = '.claude/plugins/known_marketplaces.json.lock';

// Codex's second-run files (DOMAINS c78bedef): its log database, and a SQLite database's side files.
const CODEX_LOG_DATABASE = /^logs_\d{1,6}\.sqlite(?:-shm|-wal)?$/;
const CODEX_SQLITE_SHM = /^[A-Za-z0-9_]{1,64}\.sqlite-shm$/;
const CODEX_SQLITE_WAL = /^[A-Za-z0-9_]{1,64}\.sqlite-wal$/;

/**
 * A second-run write the owner allowed (DOMAINS 0a9dc8c), by path only:
 * - Kilo and OpenCode: their own database's SQLite side files, `<h>/<h>.db-shm` and
 *   `<h>/<h>.db-wal`, which change when the database is opened. The `.db` itself is not allowed,
 *   and neither is a `-wal` that is not empty afterwards (`sizeAfter` above 0), because that holds
 *   a committed write not yet checkpointed into the `.db` (B's review, LOW 16). A `-wal` that is
 *   gone afterwards (`sizeAfter` null) was checkpointed and removed.
 * - Claude Code: its register of live processes, `.claude/sessions/<pid>.json` and
 *   `.claude/sessions/<pid>.<id>.key`, for the listing process's own pid. The warm-up run's
 *   entries (its pid, `warmUpPid`) only when they are gone afterwards: certify ends the warm-up
 *   listing, so its entry is left stale, and Claude Code 2.1.284 sweeps it on the next start
 *   (inferred from the paths of the owner's RC5 run; coordinator's decision). And
 *   `.claude/plugins/known_marketplaces.json.lock` only when it is gone or empty afterwards (a
 *   zero-byte file or an empty folder; `sizeAfter` 0 or null).
 * - Codex (coordinator decision DOMAINS c78bedef, delegated by the owner), directly in `.codex`:
 *   a SQLite database's `<name>.sqlite-shm`, and its `<name>.sqlite-wal` only when it is empty or
 *   gone afterwards; the log database `logs_<n>.sqlite` and its side files, as logs; and anything
 *   in `.codex/.tmp`, a temporary folder like `tmp`. A main `.sqlite` file other than the log
 *   database is never allowed, and neither is any config, auth or rules file.
 */
export function allowedListingWrite(harness: GlobalHarness, path: string, pid: number | null, sizeAfter: number | null, warmUpPid: number | null = null): boolean {
  const segments = path.split('/');
  if (harness === 'kilocode' || harness === 'opencode') {
    const name = harness === 'kilocode' ? 'kilo' : 'opencode';
    if (segments.length < 2 || segments.at(-2) !== name) return false;
    if (segments.at(-1) === `${name}.db-shm`) return true;
    return segments.at(-1) === `${name}.db-wal` && (sizeAfter === null || sizeAfter === 0);
  }
  if (harness === 'codex') {
    if (segments[0] !== '.codex' || segments.length < 2) return false;
    if (segments[1] === '.tmp') return true;
    if (segments.length !== 2) return false;
    const file = segments[1] ?? '';
    if (CODEX_LOG_DATABASE.test(file)) return true;
    if (CODEX_SQLITE_SHM.test(file)) return true;
    return CODEX_SQLITE_WAL.test(file) && (sizeAfter === null || sizeAfter === 0);
  }
  if (harness === 'claude') {
    if (path === CLAUDE_MARKETPLACE_LOCK) return sizeAfter === null || sizeAfter === 0;
    if (segments.length !== 3 || segments[0] !== '.claude' || segments[1] !== 'sessions') return false;
    const file = segments[2] ?? '';
    const entryOf = (owner: number | null): boolean => owner !== null && Number.isSafeInteger(owner) && owner > 0 && (file === `${owner}.json` || new RegExp(`^${owner}\\.[A-Za-z0-9]{1,128}\\.key$`).test(file));
    if (entryOf(pid)) return true;
    return warmUpPid !== pid && entryOf(warmUpPid) && sizeAfter === null;
  }
  return false;
}

/**
 * The certify case for `models.list`. It runs the listing twice in the throwaway profile (owner
 * decision DOMAINS 0a9dc8c): the first run is a warm-up, because a fresh profile's first-run setup
 * (an installation id, bundled skills, a new database) is not a listing effect; a real home is
 * already set up. It passes only when the second run answered, parsed to ids, and touched nothing
 * but caches, logs and the writes allowedListingWrite names. Any other write on the second run to
 * a session, history or config fails it. A self-update on either run fails it, and so does a
 * profile snapshot cut short at SNAPSHOT_CAP. Every harness has a case; Claude Code's is its
 * initialize answer (G13).
 */
export async function modelListCheck(input: {
  readonly harness: GlobalHarness;
  readonly env: Env;
  readonly profile: string;
  readonly run?: (input: RawListingInput) => Promise<RawListing>;
}): Promise<ModelListCheck | null> {
  if (!LISTING_HARNESSES.includes(input.harness)) return null;
  const run = input.run ?? runModelListing;
  const listingInput: RawListingInput = { harness: input.harness, env: input.env, cwd: input.profile };
  const start = await snapshotTree(input.profile);
  const warm = await run(listingInput);
  const before = await snapshotTree(input.profile);
  const warmUp = touchedPaths(start, before);
  const listed = await run(listingInput);
  const after = await snapshotTree(input.profile);
  const touched = touchedPaths(before, after);
  const command = `${LAUNCHER[input.harness]} ${(listingArgv(input.harness) ?? []).join(' ')}`;
  if ([start, before, after].some(snapshotTruncated)) return { passed: false, reasonCode: 'LISTING_SNAPSHOT_TRUNCATED', detail: `${command}: the profile has ${SNAPSHOT_CAP} or more entries, so a write could go unseen`, touched };
  const sizeAfter = (path: string): number | null => {
    const stamp = after.get(path);
    if (stamp === undefined) return null;
    // A folder is empty afterwards (0) when nothing is under it.
    if (stamp === 'dir') return [...after.keys()].some((other) => other.startsWith(`${path}/`)) ? Number.MAX_SAFE_INTEGER : 0;
    const size = Number(stamp.split(':')[0]);
    return Number.isSafeInteger(size) ? size : Number.MAX_SAFE_INTEGER;
  };
  const pid = listed.ok && listed.pid !== undefined ? listed.pid : null;
  const warmUpPid = warm.ok && warm.pid !== undefined ? warm.pid : null;
  const updates = [...new Set([...warmUp, ...touched])].filter((path) => classifyTouchedPath(path) === 'self-update').sort();
  const effects = touched.filter((path) => classifyTouchedPath(path) === 'side-effect' && !allowedListingWrite(input.harness, path, pid, sizeAfter(path), warmUpPid));
  const allowed = touched.some((path) => classifyTouchedPath(path) === 'side-effect');
  const named = (paths: readonly string[]): string => `${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` and ${paths.length - 8} more` : ''}`;
  if (updates.length > 0) return { passed: false, reasonCode: 'LISTING_SELF_UPDATE', detail: `${command}: touched update files: ${named(updates)}`, touched: [...new Set([...updates, ...touched])].sort() };
  if (effects.length > 0) return { passed: false, reasonCode: 'LISTING_SIDE_EFFECT', detail: `${command}: wrote outside caches and logs: ${named(effects)}`, touched };
  if (!listed.ok) return { passed: false, reasonCode: listed.reasonCode, detail: `${command}: ${listed.reasonCode}`, touched };
  const harmless = touched.length === 0 ? 'touched nothing' : `touched only caches and logs${allowed ? ' and allowed side files' : ''}: ${named(touched)}`;
  return { passed: true, reasonCode: null, detail: `${command}: ${listed.models.length} model id${listed.models.length === 1 ? '' : 's'}; ${harmless}`, touched };
}

/** Doctor's line for one harness: whether its models come from a listing or from runs. */
export function modelListingLine(row: { readonly harness: GlobalHarness; readonly certifiedFeatures: readonly string[]; readonly certifyCommand: string }, setting: 'on' | 'off'): string {
  const head = `harness ${row.harness} models:`;
  const fallback = 'a model becomes eligible after it has run once';
  if (!LISTING_HARNESSES.includes(row.harness)) return `${head} cannot list models; ${fallback}`;
  if (setting === 'off') return `${head} cannot list models; ${fallback} (routing.modelListing is off)`;
  if (row.certifiedFeatures.includes(MODEL_LIST_FEATURE)) return `${head} lists its models (refreshed by the sidecar while idle, no model call)`;
  return `${head} cannot list models; ${fallback} (models.list is not certified here; fix: ${row.certifyCommand})`;
}

/** One route scope doctor shows eligibility for: a harness and the sign-in its owned workers use. */
export interface EligibilityDoctorScope {
  readonly harness: GlobalHarness;
  readonly authMode: string;
}

/**
 * Doctor's eligibility lines (C's modelEligibility and modelEligibilityLines, 8b4b851): per harness,
 * one summary line of what is eligible and why the rest is not. With `detail`, when doctor is
 * scoped to one harness, C's line for every model follows. With an administrator's account id,
 * each harness's line says the registry's account checks decide; the id is never printed. Every
 * line is keyed `harness <name> eligibility (...)`, so it has doctor's info severity. Never throws.
 */
export async function eligibilityDoctorLines(home: string, scopes: readonly EligibilityDoctorScope[], detail: boolean): Promise<string[]> {
  if (scopes.length === 0) return [];
  try {
    const core = await import('@jevris/core');
    const registry = (await core.loadModelRegistry({ home }).catch(() => null)) ?? core.BUNDLED_MODEL_REGISTRY;
    const policy = await core.loadRoutingPolicy({ home, registry }).catch(() => null);
    const accountId = policy?.accountId ?? null;
    const headOf = (scope: EligibilityDoctorScope): string => `harness ${scope.harness} eligibility (${scope.authMode} sign-in):`;
    if (accountId !== null) return scopes.map((scope) => `${headOf(scope)} the administrator's registry decides which models this account may use (its account checks); local runs and harness listings do not count`);
    const offer = await core.readModelOffer(home).catch(() => null);
    const availability = await core.loadModelAvailability(home, registry).catch(() => []);
    const lines: string[] = [];
    for (const scope of scopes) {
      const eligibility = core.modelEligibility({ registry, accountId: null, offer, unavailable: core.unavailableModels(availability, scope), scope });
      const eligible = eligibility.filter((item) => item.eligible).map((item) => item.modelId);
      const counts = new Map<string, number>();
      for (const item of eligibility) if (!item.eligible) counts.set(item.reasonCode, (counts.get(item.reasonCode) ?? 0) + 1);
      const rest = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => `${code} ${count}`).join(', ');
      const head = headOf(scope);
      const yes = eligible.length === 0 ? 'no model is eligible yet' : `eligible: ${eligible.join(', ')}`;
      lines.push(`${head} ${yes}${rest.length === 0 ? '' : `; not eligible: ${rest}`}`);
      if (detail) for (const line of core.modelEligibilityLines(eligibility, scope)) lines.push(`${head} ${line}`);
    }
    return lines;
  } catch {
    return [];
  }
}
