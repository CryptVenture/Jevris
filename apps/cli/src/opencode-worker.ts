/**
 * The OpenCode owned session (ORC-05; owner directive 2026-09-26: every harness has owned
 * workers): a worker port for D's `runLeasedTask`, beside the Claude and Codex ports. Kilo is
 * a fork of OpenCode with the same headless run, so this module serves both (kilo-worker.ts
 * only names Kilo's binary and variables).
 *
 * One run is one `opencode run --format json` turn (OpenCode 1.18.32 and Kilo 7.7.9, from
 * `run --help` on this Mac and the pinned sources, packages/opencode/src/cli/cmd/run.ts):
 *
 * - The prompt goes on stdin. With no message in argv, `run` reads the piped stdin as the message.
 * - `--dir` names the worktree. `run` resolves its directory from PWD, which a child inherits
 *   from its parent, so the port passes the worktree both ways.
 * - Events are JSON lines `{type, timestamp, sessionID, part|error}`: `step_start`,
 *   `step_finish` (cost and tokens), `tool_use`, `text` and `error`.
 * - Least privilege, before any tool runs: the run uses a Jevris agent defined in
 *   `<PREFIX>_CONFIG_CONTENT`. Its permission rules deny everything (`*`), then allow only the
 *   granted tools. An agent's rules merge after the user's config, and the last matching rule
 *   wins, so the user's config cannot widen them. The same rules also go in
 *   `<PREFIX>_PERMISSION`, which applies to every agent, in case the Jevris agent does not load.
 *   Web tools, subagents (`task`) and paths outside the worktree are never allowed.
 * - A permission ask is auto-rejected in a `run` (Jevris never passes `--auto` or a
 *   skip-permissions flag). Sharing is off, and so is self-update during a run.
 * - The agent's `steps` is the step cap, and the port also stops the run past `maxTurns` steps.
 *   The port stops the run when the reported cost passes `maxBudgetUsd`.
 * - Effort is `--variant <level>`.
 *
 * Auth (owner decision 2026-09-26; SuperGrok approved 72ff950). A subscription login in
 * OpenCode (for example SuperGrok) and a provider API key are both first-class, with one
 * exception: a Claude subscription login runs only in Claude Code (owner, 490b32a). A Claude
 * model through OpenCode or Kilo needs ANTHROPIC_API_KEY, so a subscription run for an
 * `anthropic/` model is refused (ANTHROPIC_LOGIN_THIRD_PARTY), as D refuses it.
 * - `subscription`: every provider key is removed from the child's environment, so the run
 *   can only use the login OpenCode stored. OpenCode does not report which credential answered,
 *   so the mode is the stated one.
 * - `api-key`: the model's provider key must be in the environment. `<PREFIX>_AUTH_CONTENT={}`
 *   hides every stored login from the run, so a key run never spends a subscription.
 * - Access limits (R66, design 5.2): an `error` event's name (`APIError`, `ProviderAuthError`),
 *   `statusCode`, the structured code of a bounded `responseBody` parse and the reset from
 *   `responseHeaders` make an access signal; `data.message` counts only as a pinned pattern id.
 *   The run is `access-limit` (a ProviderAuthError or a 401 is `account-blocked`, with the sign-in
 *   command) or `overloaded`, never the task's failure. The message, body and header values are
 *   never kept. A run whose project config redefines the provider reports no signal (guard 6).
 *
 * Cost: `step_finish.cost` is OpenCode's price from models.dev. With an API key it is the run's
 * spend. On a subscription it is only an estimate, so `costUsd` is null there. Reasoning
 * tokens are reported apart from output (`output = outputTokens - reasoning`), so the port
 * adds them back into `outputTokens`.
 */
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseJsonc, PROJECT_CONFIG_CAP, projectConfigFiles } from '@jevris/adapter-kilocode';
import { resetFromHeaders } from '@jevris/core';
import type { AccessLimitFinding, AccessSignalWire, ModelRegistry } from '@jevris/contracts';
import { opencodeAccessSignal, portAccess, signalStatus } from './access-signal.js';
export { bodyCode, opencodeAccessSignal, opencodeTranscriptAccess } from './access-signal.js';
import { workerEnv, VENDOR_KEYS, type AuthMode } from './harness-auth.js';
import { harnessModelChoice, type HarnessModelChoice } from './harness-model.js';
import { count, initFailed, INIT_OK, interruptedStatus, jsonLine, OWNED_WRITE_TOOLS, rec, runStreamingSession, sessionIdReporter, validateOwnedInput, type InitCheck, type OwnedUsage, type OwnedWorkerInputBase, type OwnedWorkerStatus, type WorkerEffort } from './owned-session.js';
import { eventShape, modelUnavailableOf, modelUnavailableText, opencodeEventModelSignal, opencodeStderrModelSignal, withCertifiedSignals, type ModelSignal, type ModelUnavailable } from './model-signals.js';
import { portEvidence, withWorkerEvidence, type WorkerEvidenceOptions } from './worker-evidence.js';

const MAX_RESULT_TEXT = 8_000;
/** The most of an error message read in memory to classify it; none of it is kept. */
const MAX_SCAN = 4096;
/** The harness's own line when a run's permission request was refused (its text is not kept). */
const PERMISSION_REJECTED = /permission requested: .*auto-rejecting/;

/** A Claude subscription login outside Claude Code (owner decision 2026-09-26, D's code). */
export const ANTHROPIC_LOGIN_THIRD_PARTY = 'ANTHROPIC_LOGIN_THIRD_PARTY';
/** R52: a host run whose model has no spelling through that host on this harness. */
export const WORKER_HOST_UNSPELLED = 'WORKER_HOST_UNSPELLED';
/** The Jevris agent every owned run uses. */
export const OPENCODE_WORKER_AGENT = 'jevris-worker';
/** `--variant` levels passed through (provider-specific; C's levels as given). */
export const OPENCODE_EFFORTS: readonly WorkerEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Provider key variables (names only), by the provider id in `provider/model`. The Zai and
 * Moonshot ids and their variables are models.dev's provider entries (api.json, read
 * 2026-09-27), which OpenCode and Kilo load (routing design R29).
 */
export const OPENCODE_PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zai: ['ZHIPU_API_KEY'],
  'zai-coding-plan': ['ZHIPU_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
};
const ALL_PROVIDER_KEYS: readonly string[] = [...new Set([...VENDOR_KEYS, ...Object.values(OPENCODE_PROVIDER_KEYS).flat()])];

/** What differs between OpenCode and Kilo. */
export interface OpencodeFlavor {
  readonly harness: 'opencode' | 'kilo';
  readonly binary: string;
  /** The environment variable prefix: `OPENCODE` or `KILO`. */
  readonly prefix: string;
  readonly missingMessage: string;
  readonly signIn: string;
  /** Extra child environment (Kilo: no daemon, so the run keeps this environment). */
  readonly extraEnv: Readonly<Record<string, string>>;
}

export const OPENCODE_FLAVOR: OpencodeFlavor = {
  harness: 'opencode',
  binary: 'opencode',
  prefix: 'OPENCODE',
  missingMessage: 'unsupported: install OpenCode (opencode) and run jevris install --harness opencode',
  signIn: 'opencode auth login',
  extraEnv: {},
};

export type OpencodeWorkerStatus = OwnedWorkerStatus;

export interface OpencodeWorkerInput extends OwnedWorkerInputBase {
  /** Receives each event's type (and part type), never content. */
  readonly onEvent?: (event: { readonly type: string; readonly partType?: string }) => void;
}

export interface OpencodeWorkerOutcome {
  readonly status: OpencodeWorkerStatus;
  readonly reason: string;
  readonly sessionId: string | null;
  readonly requestedModel: string;
  /** The `provider/model` passed to the harness. */
  readonly harnessModel: string | null;
  /** The JSON events do not name the answering model: always null (unknown, never guessed). */
  readonly actualModel: string | null;
  /** Summed step cost with an API key; null on a subscription (an estimate only). */
  readonly costUsd: number | null;
  readonly usage: OwnedUsage | null;
  /** Model steps started. */
  readonly turns: number | null;
  readonly durationMs: number;
  readonly resultText: string | null;
  /** The stated mode the run was shaped for; 'unknown' when no mode was decided. */
  readonly authMode: AuthMode | 'unknown';
  readonly resetAt?: string;
  readonly events: number;
  /** The `--variant` passed, or null. */
  readonly effort: WorkerEffort | null;
  /** The tool permissions the run was given (OpenCode permission names). */
  readonly allowedPermissions: readonly string[];
  /** The first-use check: the first event is a step of the Jevris session, and the Jevris agent loaded. */
  readonly initCheck: InitCheck | null;
  /**
   * The found-gone signal (model-signals.ts): ProviderModelNotFoundError as the stream's error
   * event, or on stderr (accepted on both until a capture shows which); null when none.
   */
  readonly modelSignal: ModelSignal | null;
  /** For `model-unavailable`: C's reason, the port (`opencode` or `kilocode`) and the auth mode, for D to record. */
  readonly modelUnavailable?: ModelUnavailable;
  /** For `access-limit` and `overloaded` (R66): the error's name, status, body code and reset; never text. */
  readonly accessSignal?: AccessSignalWire;
  /** This port's own classification of `accessSignal`: its claim, never recorded as such. */
  readonly accessLimit?: AccessLimitFinding;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;

const PROVIDER_PIN = /^[a-z0-9][a-z0-9._-]*\/[^/]/i;

/** The registry's harness id for an OpenCode-family flavor. */
export function flavorHarness(flavor: Pick<OpencodeFlavor, 'harness'>): 'opencode' | 'kilocode' {
  return flavor.harness === 'kilo' ? 'kilocode' : 'opencode';
}

/** A user's `provider/model` pin, as given; any other id the registry does not know is refused. */
function providerPin(model: string): string | null {
  return PROVIDER_PIN.test(model) ? model : null;
}

/**
 * How OpenCode (or Kilo) runs `model` at C's `effort`: the registry's `provider/model` spelling
 * for the harness (routing design R6, R18; harness-model.ts), or a user's `provider/model` pin as
 * given. Null when neither names it.
 */
export function opencodeModelChoice(model: string, effort?: WorkerEffort, harness: 'opencode' | 'kilocode' = 'opencode', registry?: ModelRegistry, servingHost?: string): HarnessModelChoice | null {
  return harnessModelChoice(harness, model, effort, { ...(registry === undefined ? {} : { registry }), fallbackLevels: OPENCODE_EFFORTS, unregistered: providerPin, ...(servingHost === undefined ? {} : { servingHost }) });
}

/** `provider/model` for a model id (the registry's spelling for the harness, or a pin as given), or null. */
export function opencodeModel(model: string, harness: 'opencode' | 'kilocode' = 'opencode', registry?: ModelRegistry): string | null {
  return opencodeModelChoice(model, undefined, harness, registry)?.id ?? null;
}

/**
 * The key variables an api-key run of `model` on OpenCode (or Kilo) needs, by the provider
 * segment of the id the harness is started with; null when the harness names no id for the
 * model, or Jevris knows no variable for that provider (D's auth check, R29).
 */
export function opencodeProviderKeys(model: string, harness: 'opencode' | 'kilocode' = 'opencode', registry?: ModelRegistry): readonly string[] | null {
  const id = opencodeModel(model, harness, registry);
  return id === null ? null : (OPENCODE_PROVIDER_KEYS[id.slice(0, id.indexOf('/'))] ?? null);
}

/** OpenCode permission names for D's granted tools (Claude names). */
export function opencodePermissions(allowedTools: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const tool of allowedTools) {
    if (tool === 'Read') out.add('read');
    else if (tool === 'Grep') out.add('grep');
    else if (tool === 'Glob') out.add('glob');
    else if (tool === 'LS') out.add('list');
    else if (tool === 'Bash') out.add('bash');
    else if (tool === 'TodoWrite') out.add('todowrite');
    else if (OWNED_WRITE_TOOLS.has(tool)) out.add('edit');
  }
  return [...out].sort();
}

/** The permission rules: `*` denied first, then each granted permission allowed (last match wins). */
export function opencodePermissionRules(allowedTools: readonly string[]): Readonly<Record<string, 'allow' | 'deny'>> {
  const rules: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  for (const name of opencodePermissions(allowedTools)) rules[name] = 'allow';
  return rules;
}

/** The config the run loads from `<PREFIX>_CONFIG_CONTENT`: the Jevris agent and sharing off (self-update is off by variable). */
export function opencodeConfigContent(input: Pick<OpencodeWorkerInput, 'allowedTools' | 'maxTurns'>): string {
  return JSON.stringify({
    share: 'disabled',
    agent: {
      [OPENCODE_WORKER_AGENT]: {
        mode: 'primary',
        description: 'Jevris owned worker: only the granted tools, inside the task worktree.',
        steps: input.maxTurns,
        permission: opencodePermissionRules(input.allowedTools),
      },
    },
  });
}

/** The exact argv for one owned turn (the prompt goes on stdin, never argv). */
export function opencodeRunArgs(harnessModel: string, cwd: string, effort: string | null): readonly string[] {
  return ['run', '--format', 'json', '--model', harnessModel, '--agent', OPENCODE_WORKER_AGENT, '--dir', cwd, ...(effort === null ? [] : ['--variant', effort])];
}

function has(env: { readonly [key: string]: string | undefined }, key: string): boolean {
  return (env[key] ?? '') !== '';
}

/** The child environment: auth shaped, the Jevris agent and rules, and the flavor's extras. */
export function opencodeWorkerEnv(flavor: OpencodeFlavor, input: Pick<OpencodeWorkerInput, 'auth' | 'allowedTools' | 'maxTurns' | 'cwd'>, base: { readonly [key: string]: string | undefined }): { [key: string]: string } {
  const env = workerEnv(flavor.harness, input.auth, base);
  if (input.auth === 'subscription') for (const key of ALL_PROVIDER_KEYS) delete env[key];
  // A key run never sees a stored login: an empty credential store replaces auth.json.
  if (input.auth === 'api-key') env[`${flavor.prefix}_AUTH_CONTENT`] = '{}';
  else delete env[`${flavor.prefix}_AUTH_CONTENT`];
  env[`${flavor.prefix}_CONFIG_CONTENT`] = opencodeConfigContent(input);
  env[`${flavor.prefix}_PERMISSION`] = JSON.stringify(opencodePermissionRules(input.allowedTools));
  env[`${flavor.prefix}_DISABLE_AUTOUPDATE`] = '1';
  env['PWD'] = input.cwd;
  for (const [key, value] of Object.entries(flavor.extraEnv)) env[key] = value;
  return env;
}

function refusedOutcome(input: Pick<OpencodeWorkerInput, 'model' | 'allowedTools'>, status: OpencodeWorkerStatus, reason: string): OpencodeWorkerOutcome {
  return {
    status,
    reason,
    sessionId: null,
    requestedModel: typeof input.model === 'string' ? input.model : '',
    harnessModel: null,
    actualModel: null,
    costUsd: null,
    usage: null,
    turns: null,
    durationMs: 0,
    resultText: null,
    authMode: 'unknown',
    events: 0,
    effort: null,
    allowedPermissions: Array.isArray(input.allowedTools) ? opencodePermissions(input.allowedTools) : [],
    initCheck: null,
    modelSignal: null,
  };
}

/** An error name a reason may carry (`APIError`, `ProviderAuthError`): letters only, never free text. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}Error$/;

/**
 * The error an `error` event carries: a fixed reason with its error name and status code (R80: the
 * message is read in memory and never kept), whether it is a sign-in problem, and its access
 * signal (R66).
 */
function readError(error: unknown, port: 'opencode' | 'kilocode'): { readonly message: string; readonly auth: boolean; readonly signal: AccessSignalWire | null } {
  const e = rec(error);
  const name = typeof e?.['name'] === 'string' ? (e['name'] as string) : '';
  const statusCode = signalStatus(rec(e?.['data'])?.['statusCode']) ?? null;
  const named = ERROR_NAME.test(name) ? name : 'an error';
  const message = `the session reported ${named}${statusCode === null ? '' : ` (status ${String(statusCode)})`}`;
  return { message, auth: name === 'ProviderAuthError' || statusCode === 401, signal: opencodeAccessSignal(port, error, Date.now()) };
}

async function definesProvider(harness: 'opencode' | 'kilocode', root: string, providerID: string): Promise<boolean> {
  for (const file of projectConfigFiles(harness, root, join)) {
    const info = await lstat(file).catch((error: unknown) => ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR' ? null : 'doubt'));
    if (info === null) continue;
    if (info === 'doubt' || !info.isFile() || info.size > PROJECT_CONFIG_CAP) return true;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null || text.includes('{env:') || text.includes('{file:')) return true;
    const parsed = rec(parseJsonc(text));
    if (parsed === undefined) return true;
    const providers = parsed['provider'];
    if (providers === undefined) continue;
    const table = rec(providers);
    if (table === undefined || Object.prototype.hasOwnProperty.call(table, providerID)) return true;
  }
  return false;
}

/** The primary checkout of a linked git worktree (its `.git` is a file), or null when it cannot be read. */
async function primaryCheckout(cwd: string): Promise<string | null> {
  const small = async (file: string): Promise<string | null> => {
    const info = await lstat(file).catch(() => null);
    return info === null || !info.isFile() || info.size > 4096 ? null : readFile(file, 'utf8').catch(() => null);
  };
  const pointer = /^gitdir: (.+)$/m.exec((await small(join(cwd, '.git'))) ?? '')?.[1]?.trim();
  if (pointer === undefined) return null;
  const gitdir = isAbsolute(pointer) ? pointer : resolve(cwd, pointer);
  const common = (await small(join(gitdir, 'commondir')))?.trim();
  if (common === undefined || common === '') return null;
  const commonDir = isAbsolute(common) ? common : resolve(gitdir, common);
  return basename(commonDir) === '.git' ? dirname(commonDir) : null;
}

/**
 * Guard 6 (design 5.5, T-R6's check): whether a project config the run loads defines the run's
 * provider (a redirected endpoint), so its access signal names no known party. The worktree's
 * own config files count; Kilo also loads the primary checkout's for a linked worktree, so those
 * count too. Any doubt (a file that is not a small regular file, does not parse, or substitutes
 * `{env:` or `{file:`; a linked worktree whose primary cannot be found) counts as redefined.
 */
export async function opencodeProviderRedefined(harness: 'opencode' | 'kilocode', cwd: string, providerID: string): Promise<boolean> {
  if (await definesProvider(harness, cwd, providerID)) return true;
  if (harness !== 'kilocode') return false;
  const dotGit = await lstat(join(cwd, '.git')).catch(() => null);
  if (dotGit === null || !dotGit.isFile()) return false;
  const primary = await primaryCheckout(cwd);
  return primary === null || (await definesProvider(harness, primary, providerID));
}

/** One owned turn on an OpenCode-family harness. */
export async function runOpencodeFamilyWorker(flavor: OpencodeFlavor, input: OpencodeWorkerInput): Promise<OpencodeWorkerOutcome> {
  const invalid = validateOwnedInput(input, { model: MODEL });
  if (invalid !== null) return refusedOutcome(input, 'refused', `invalid ${invalid}`);
  if (input.signal?.aborted === true) return refusedOutcome(input, 'aborted', 'aborted before start');
  const choice = opencodeModelChoice(input.model, input.effort, flavorHarness(flavor), input.registry, input.servingHost);
  // R52: a host run starts only the host's own spelling of the model; there is no maker fallback.
  if (choice === null && input.servingHost !== undefined) return refusedOutcome(input, 'refused', `refused: ${WORKER_HOST_UNSPELLED}: ${flavor.binary} names no spelling of ${input.model} through ${input.servingHost}`);
  if (choice === null) return refusedOutcome(input, 'refused', `refused: no provider for model ${input.model} on ${flavor.binary}; pass provider/model`);
  const harnessModel = choice.id;
  const provider = harnessModel.split('/')[0] ?? '';
  const base = input.env ?? process.env;
  if (provider === 'anthropic' && input.auth !== 'api-key') return refusedOutcome(input, 'refused', `refused: ${ANTHROPIC_LOGIN_THIRD_PARTY}: a Claude model through ${flavor.binary} needs api-key mode with ANTHROPIC_API_KEY; a Claude subscription login runs only in Claude Code`);
  if (input.auth === 'api-key') {
    const keys = OPENCODE_PROVIDER_KEYS[provider];
    if (keys === undefined) return refusedOutcome(input, 'refused', `refused: api-key mode for provider ${provider}: Jevris knows no key variable for it; state subscription or use a known provider`);
    if (!keys.some((key) => has(base, key))) return refusedOutcome(input, 'refused', `refused: api-key mode needs ${keys.join(' or ')} in the environment`);
  }
  const effort = choice.level;
  const env = opencodeWorkerEnv(flavor, input, base);
  // R52, B's LOW 36: a host run carries only the host's own key variables, whatever env it was given.
  if (input.servingHost !== undefined) {
    const own = input.auth === 'api-key' ? (OPENCODE_PROVIDER_KEYS[provider] ?? []) : [];
    for (const key of ALL_PROVIDER_KEYS) if (!own.includes(key)) delete env[key];
  }
  const file = input.command?.file ?? flavor.binary;
  const args = [...(input.command?.args ?? []), ...opencodeRunArgs(harnessModel, input.cwd, choice.effortToken)];

  let sessionId: string | null = null;
  const reportSession = sessionIdReporter(input.onSessionId);
  let steps = 0;
  let finished = 0;
  let cost = 0;
  let sawCost = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let sawUsage = false;
  let resultText: string | null = null;
  let failure: ReturnType<typeof readError> | null = null;
  let stepCapHit = false;
  let budgetHit = false;
  let events = 0;
  let initCheck: InitCheck | null = null;
  let modelSignal: ModelSignal | null = null;
  const seenParts = new Set<string>();

  const onLine = (line: string, stop: () => void): void => {
    const event = jsonLine(line);
    if (event === undefined || typeof event['type'] !== 'string') return;
    events += 1;
    const type = event['type'] as string;
    const part = rec(event['part']);
    const partType = typeof part?.['type'] === 'string' ? (part['type'] as string) : undefined;
    input.onEvent?.(partType === undefined ? { type } : { type, partType });
    // The first event of a Jevris run is a step of one session; an error first proves nothing.
    if (initCheck === null && type !== 'error') initCheck = type === 'step_start' && typeof event['sessionID'] === 'string' ? INIT_OK : initFailed('WORKER_INIT_SHAPE');
    // Stale revision: the first session named is the run's; a later one never replaces it.
    if (sessionId === null && typeof event['sessionID'] === 'string') sessionId = (event['sessionID'] as string).slice(0, 128);
    reportSession(sessionId);
    // Duplicate delivery: a step part delivered twice (same id) counts once.
    const partId = typeof part?.['id'] === 'string' ? `${type}:${part['id'] as string}` : null;
    if ((type === 'step_start' || type === 'step_finish') && partId !== null) {
      if (seenParts.has(partId)) return;
      seenParts.add(partId);
    }
    if (type === 'step_start') {
      steps += 1;
      if (steps > input.maxTurns && !stepCapHit) {
        stepCapHit = true;
        stop();
      }
    } else if (type === 'step_finish' && part !== undefined) {
      finished += 1;
      if (typeof part['cost'] === 'number' && Number.isFinite(part['cost'])) {
        cost += count(part['cost']);
        sawCost = true;
      }
      const tokens = rec(part['tokens']);
      if (tokens !== undefined) {
        sawUsage = true;
        const cache = rec(tokens['cache']);
        usage.inputTokens += count(tokens['input']);
        usage.outputTokens += count(tokens['output']) + count(tokens['reasoning']);
        usage.cacheReadInputTokens += count(cache?.['read']);
        usage.cacheCreationInputTokens += count(cache?.['write']);
      }
      if (sawCost && cost > input.maxBudgetUsd && !budgetHit) {
        budgetHit = true;
        stop();
      }
    } else if (type === 'text' && part !== undefined && typeof part['text'] === 'string') {
      resultText = (part['text'] as string).slice(0, MAX_RESULT_TEXT);
    } else if (type === 'error') {
      failure ??= readError(event['error'], flavorHarness(flavor));
      const id = modelSignal === null ? opencodeEventModelSignal(event['error']) : null;
      if (id !== null) modelSignal = { id, channel: 'event', shape: eventShape(event) };
    }
  };

  const end = await runStreamingSession({ file, args, cwd: input.cwd, env, input: input.prompt, timeoutMs: input.timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.onStart === undefined ? {} : { onStart: input.onStart }), sessionId: () => sessionId, onLine });
  const { exit, stderr, durationMs } = end;
  if (!exit.spawned) return { ...refusedOutcome(input, 'unsupported', flavor.missingMessage), durationMs };
  // The run falls back to the default agent, with the user's permissions, when the Jevris agent
  // did not load; it says so on stderr. That run is refused, never counted as the task's result.
  const agentMissing = new RegExp(`agent "${OPENCODE_WORKER_AGENT}" (?:not found|is a subagent)`).test(stderr);

  let status: OpencodeWorkerStatus;
  let reason: string;
  const interrupted = interruptedStatus(end, input.timeoutMs);
  const failed = failure as ReturnType<typeof readError> | null;
  // Where OpenCode puts ProviderModelNotFoundError is not yet captured: stderr counts too, for a run that did not complete.
  const stderrId = modelSignal === null && (failed !== null || (exit.code !== 0 && exit.code !== null) || finished === 0) ? opencodeStderrModelSignal(stderr, harnessModel) : null;
  const signal: ModelSignal | null = (modelSignal as ModelSignal | null) ?? (stderrId === null ? null : { id: stderrId, channel: 'stderr', shape: [] });
  const port = flavor.harness === 'kilo' ? 'kilocode' : 'opencode';
  const unavailable = modelUnavailableOf(port, signal, input.certifiedModelSignals, input.auth ?? 'unknown');
  const signInHint = `not signed in to ${provider}; run ${flavor.signIn}${input.auth === 'api-key' ? ` or set ${(OPENCODE_PROVIDER_KEYS[provider] ?? []).join(' or ')}` : ''}`;
  // Success wins (design 5.5): only a run that ended on an error event, not stopped by Jevris, and
  // whose provider no project config redefines, reports an access signal.
  const stopped = agentMissing || interrupted !== null || stepCapHit || budgetHit;
  const candidate = !stopped && failed !== null ? failed.signal : null;
  const access = candidate !== null && !(await opencodeProviderRedefined(port, input.cwd, provider)) ? portAccess(candidate, input.auth ?? 'unknown', Date.now()) : null;
  if (agentMissing) [status, reason] = ['refused', `refused: the Jevris agent did not load, so the run's permissions were not the granted ones (${flavor.prefix}_CONFIG_CONTENT)`];
  else if (interrupted !== null) [status, reason] = interrupted;
  else if (stepCapHit) [status, reason] = ['max-turns', `more than ${String(input.maxTurns)} steps`];
  else if (budgetHit) [status, reason] = ['budget-exceeded', `over ${String(input.maxBudgetUsd)} USD`];
  else if (access !== null) [status, reason] = [access.status, access.accessLimit.class === 'account-blocked' ? `${access.reason}: ${signInHint}` : access.reason];
  else if (failed !== null && failed.auth) [status, reason] = ['refused', `refused: ${signInHint}`];
  else if (unavailable !== null) [status, reason] = ['model-unavailable', modelUnavailableText(input.model, unavailable)];
  else if (failed !== null) [status, reason] = ['failed', failed.message];
  // R80: stderr (remote text) never enters a reason.
  else if (exit.code !== 0 && exit.code !== null) [status, reason] = ['failed', `${flavor.binary} run exited with code ${String(exit.code)}${PERMISSION_REJECTED.test(stderr.slice(-MAX_SCAN)) ? ': a permission request was auto-rejected' : ''}`];
  else if (finished === 0) [status, reason] = ['failed', 'the stream ended without a finished step'];
  else [status, reason] = ['completed', 'success'];

  return {
    status,
    reason,
    sessionId,
    requestedModel: input.model,
    harnessModel,
    actualModel: null,
    costUsd: input.auth === 'api-key' && sawCost ? cost : null,
    usage: sawUsage ? { ...usage } : null,
    turns: steps,
    durationMs,
    resultText: status === 'completed' ? resultText : null,
    authMode: input.auth ?? 'unknown',
    ...(access === null ? {} : { accessSignal: access.accessSignal, accessLimit: access.accessLimit, ...(access.resetAt === undefined ? {} : { resetAt: access.resetAt }) }),
    events,
    effort,
    allowedPermissions: opencodePermissions(input.allowedTools),
    initCheck: agentMissing ? initFailed('WORKER_AGENT_NOT_LOADED') : (initCheck as InitCheck | null),
    modelSignal: signal,
    ...(status === 'model-unavailable' && unavailable !== null ? { modelUnavailable: unavailable } : {}),
  };
}

export function runOpencodeWorker(input: OpencodeWorkerInput): Promise<OpencodeWorkerOutcome> {
  return runOpencodeFamilyWorker(OPENCODE_FLAVOR, input);
}

/** A WorkerPort for D's `runLeasedTask` (structurally `{ run(WorkerRunInput) }`). */
export function opencodeWorkerPort(options: Pick<OpencodeWorkerInput, 'command' | 'env'> & { readonly evidence?: WorkerEvidenceOptions | false } = {}): { run(input: Omit<OpencodeWorkerInput, 'command' | 'env'>): Promise<OpencodeWorkerOutcome> } {
  const { evidence: _evidence, ...binary } = options;
  const evidence = portEvidence('opencode', options);
  // A run on the harness's own binary adds its first-use check to the live evidence (worker.route),
  // and gets the found-gone signals its capture certified for that version.
  return { run: withWorkerEvidence('opencode', withCertifiedSignals('opencode', (input: Omit<OpencodeWorkerInput, 'command' | 'env'>) => runOpencodeWorker({ ...input, ...binary }), evidence), evidence) };
}
