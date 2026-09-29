/**
 * Per-harness auth mode (owner decision 2026-09-26): each harness runs on the user's
 * subscription login or on a vendor API key, and both are first-class.
 *
 * - Only the mode is read, shown or recorded: never a key, a token, an email or an account id.
 * - The effective mode is D's (`workerAuthMode` over `<config>/workers.json`): `auto` is
 *   `api-key` when the harness's vendor key is in the environment, else `subscription`. The
 *   user can state it in workers.json when detection gives no answer.
 * - Detection asks the harness itself, read-only: `claude auth status --json` (its
 *   `authMethod`), `codex login status` (its first line), and `opencode auth list` / `kilo
 *   auth list` (the type of each stored credential: oauth, api or wellknown; never a value).
 *   Antigravity signs in only with Google, so there is nothing to detect.
 * - `workerEnv` shapes a worker's environment for the decided mode: a subscription run never
 *   sees a vendor key (so it cannot bill one by accident), and a key run never sees the
 *   subscription token (so it cannot spend the plan by accident).
 */
import type { HarnessCli } from './global-harness.js';
import { probeRefusal } from './live-harness.js';

type Env = { readonly [key: string]: string | undefined };

/** D's worker harnesses (`WorkerHarness` in @jevris/orchestrator). */
export type AuthHarness = 'claude' | 'codex' | 'opencode' | 'kilo' | 'antigravity';
export type AuthMode = 'api-key' | 'subscription';
export type AuthSetting = 'auto' | AuthMode;

/** What the harness itself says, from its own status command. */
export type DetectedAuth = 'subscription' | 'api-key' | 'signed-out' | 'unknown' | 'not-probed';

/** Every vendor key variable a subscription run must not see (XAI_API_KEY: Grok in Kilo and OpenCode). */
export const VENDOR_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'XAI_API_KEY'];
/**
 * Provider keys a harness can use for some models without deciding its mode: Kilo and OpenCode
 * run Grok on a SuperGrok login or on XAI_API_KEY. Doctor names the variable when it is set.
 */
export const MODEL_KEYS: Readonly<Record<AuthHarness, readonly string[]>> = { claude: [], codex: [], opencode: ['XAI_API_KEY'], kilo: ['XAI_API_KEY'], antigravity: [] };
/** Subscription tokens a key run must not see. */
export const SUBSCRIPTION_TOKENS: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_ACCESS_TOKEN'];

const AUTH_TIMEOUT_MS = 10_000;

function has(env: Env, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.length > 0;
}

/**
 * `claude auth status --json`: `authMethod` is `claude.ai` (a subscription login),
 * `oauth_token` (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), `api_key`, or `none`.
 * Every other field (email, organization) is ignored.
 */
export function parseClaudeAuthStatus(stdout: string): DetectedAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  const method = (parsed as { readonly authMethod?: unknown }).authMethod;
  const provider = (parsed as { readonly apiProvider?: unknown }).apiProvider;
  if (method === 'none' || (parsed as { readonly loggedIn?: unknown }).loggedIn === false) return 'signed-out';
  // Bedrock, Vertex and Foundry bill a cloud account per call: an API key for pricing.
  if (typeof provider === 'string' && provider !== 'firstParty') return 'api-key';
  if (method === 'claude.ai' || method === 'oauth_token') return 'subscription';
  if (method === 'api_key' || method === 'apiKeyHelper') return 'api-key';
  return 'unknown';
}

/** `codex login status`: "Logged in using ChatGPT", "Logged in using an API key - …", "Not logged in". */
export function parseCodexLoginStatus(stdout: string): DetectedAuth {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
  if (/^not logged in/i.test(line)) return 'signed-out';
  if (/chatgpt/i.test(line)) return 'subscription';
  if (/api key/i.test(line)) return 'api-key';
  return 'unknown';
}

/**
 * `opencode auth list` / `kilo auth list` (OpenCode 1.18.32, Kilo 7.7.9): a "Credentials" block
 * with one `●  <provider> <type>` line per stored credential (type oauth, api or wellknown),
 * then `N credentials`; an "Environment" block may follow, naming key variables. Only the
 * credential types are read. A stored OAuth login is a subscription; only stored keys is an
 * API key; no credential is no login. An Anthropic OAuth login does not count: Claude models
 * through OpenCode or Kilo need an API key (owner decision, ANTHROPIC_LOGIN_THIRD_PARTY).
 */
/** One stored credential as `<harness> auth list` prints it: the provider name and its type, never a value. */
export interface ProviderCredential {
  readonly provider: string;
  readonly type: 'oauth' | 'api' | 'wellknown';
}

/** The stored credentials of an auth listing, or null when it is not one (no count line: cut short). */
export function parseProviderCredentials(stdout: string): readonly ProviderCredential[] | null {
  const lines = stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /\bCredentials\b/.test(line));
  if (start === -1) return null;
  const entries: ProviderCredential[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\W*\d+ credentials?\s*$/.test(line)) return entries;
    const entry = /^\W*(\S.*?)\s+(oauth|api|wellknown)\s*$/.exec(line);
    if (entry !== null) entries.push({ provider: (entry[1] as string).trim().slice(0, 64), type: entry[2] as ProviderCredential['type'] });
  }
  return null;
}

export function parseProviderAuthList(stdout: string): DetectedAuth {
  const entries = parseProviderCredentials(stdout);
  if (entries === null) return 'unknown';
  if (entries.some((item) => item.type === 'oauth' && !/^anthropic$/i.test(item.provider))) return 'subscription';
  if (entries.some((item) => item.type === 'api' || item.type === 'wellknown')) return 'api-key';
  // No credential, or only an Anthropic OAuth login these harnesses may not use: no usable login.
  return 'signed-out';
}

/** Read-only switches for the OpenCode family: no models.dev fetch, no update check, no daemon. */
const QUIET_OPENCODE = { OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' } as const;
const QUIET_KILO = { KILO_DISABLE_MODELS_FETCH: '1', KILO_DISABLE_AUTOUPDATE: '1', KILO_NO_DAEMON: '1' } as const;

const DETECT: Readonly<Partial<Record<AuthHarness, { readonly file: string; readonly args: readonly string[]; readonly parse: (stdout: string) => DetectedAuth; readonly env?: { readonly [key: string]: string } }>>> = {
  claude: { file: 'claude', args: ['auth', 'status', '--json'], parse: parseClaudeAuthStatus },
  codex: { file: 'codex', args: ['login', 'status'], parse: parseCodexLoginStatus },
  opencode: { file: 'opencode', args: ['auth', 'list'], parse: parseProviderAuthList, env: QUIET_OPENCODE },
  kilo: { file: 'kilo', args: ['auth', 'list'], parse: parseProviderAuthList, env: QUIET_KILO },
};

/**
 * Asks the harness which login it holds (read-only). `unknown` when it cannot tell;
 * `not-probed` when `guard` refuses (by default: a test run, or a HOME that is not the OS
 * account's home, where the harness would look for a keychain that does not exist).
 */
export async function detectAuth(harness: AuthHarness, cli: HarnessCli, env: Env = process.env, guard: (env: Env) => string | null = probeRefusal): Promise<DetectedAuth> {
  if (guard(env) !== null) return 'not-probed';
  const probe = DETECT[harness];
  if (probe === undefined || !cli.available(probe.file)) return 'unknown';
  try {
    const ran = await cli.run(probe.file, probe.args, AUTH_TIMEOUT_MS, probe.env === undefined ? env : { ...env, ...probe.env });
    if (!ran.spawned) return 'unknown';
    // `codex login status` prints on stderr, and exits non-zero when signed out; its text still says so.
    return probe.parse(ran.stdout.trim() === '' ? (ran.stderr ?? '') : ran.stdout);
  } catch {
    return 'unknown';
  }
}

/**
 * D's entry (`@jevris/cli/harness-auth`): the mode a harness reports, with this machine's harness
 * CLI and doctor's probe rule (never in a test run or under a HOME that is not the account's:
 * 'not-probed'). The mode only, never a key or token. The harness CLI loads on first use, so
 * importing this module starts nothing.
 */
export async function detectHarnessAuth(harness: AuthHarness | 'kilocode', env: Env = process.env): Promise<DetectedAuth> {
  const worker: AuthHarness = harness === 'kilocode' ? 'kilo' : harness;
  if (probeRefusal(env) !== null) return 'not-probed';
  try {
    const { defaultHarnessCli } = await import('./global-harness.js');
    return await detectAuth(worker, defaultHarnessCli, env, () => null);
  } catch {
    return 'unknown';
  }
}

/**
 * D's entry: the stored credentials of OpenCode or Kilo (provider and type, never a value), so
 * `auto` can follow the model's own provider. Null when it cannot tell: not probed (a test run
 * or a foreign HOME), not on PATH, not started, or output it cannot read.
 */
export async function providerCredentials(harness: 'opencode' | 'kilo' | 'kilocode', env: Env = process.env): Promise<readonly ProviderCredential[] | null> {
  const probe = DETECT[harness === 'kilocode' ? 'kilo' : harness];
  if (probe === undefined || probeRefusal(env) !== null) return null;
  try {
    const { defaultHarnessCli } = await import('./global-harness.js');
    if (!defaultHarnessCli.available(probe.file)) return null;
    const ran = await defaultHarnessCli.run(probe.file, probe.args, AUTH_TIMEOUT_MS, { ...env, ...probe.env });
    return ran.spawned ? parseProviderCredentials(ran.stdout) : null;
  } catch {
    return null;
  }
}

export interface HarnessAuthView {
  readonly harness: AuthHarness;
  /** What workers.json says (`auto` when it says nothing). */
  readonly setting: AuthSetting;
  /** The mode D runs this harness's owned workers in (D's `workerAuthMode`). */
  readonly mode: AuthMode;
  /** The vendor key variables present (names only). */
  readonly keysInEnvironment: readonly string[];
  /** MODEL_KEYS variables present (names only), such as XAI_API_KEY for Grok models. */
  readonly modelKeysInEnvironment?: readonly string[];
  readonly detected: DetectedAuth;
  /** One sentence on anything that will stop a run in this mode, or null. */
  readonly problem: string | null;
  /** Why the harness was not asked (a test run, or a HOME that is not the account's home). */
  readonly notProbed?: string;
}

const SIGN_IN: Readonly<Record<AuthHarness, string>> = {
  claude: 'claude auth login (or CLAUDE_CODE_OAUTH_TOKEN from claude setup-token)',
  codex: 'codex login',
  opencode: 'opencode auth login',
  kilo: 'kilo auth login',
  antigravity: 'agy (it asks you to sign in with Google)',
};

/** What would stop a run in `mode`, given the keys present and what the harness reports. */
export function authProblem(harness: AuthHarness, mode: AuthMode, keyVars: readonly string[], keysInEnvironment: readonly string[], detected: DetectedAuth, env: Env): string | null {
  if (harness === 'antigravity' && mode === 'api-key') return 'Antigravity has no API-key sign-in, so its owned workers are refused in api-key mode; fix: set "antigravity" to "subscription" in workers.json, or remove it';
  if (mode === 'api-key' && keyVars.length > 0 && keysInEnvironment.length === 0) return `api-key mode needs ${keyVars.join(' or ')} in the environment`;
  if (mode === 'subscription' && detected === 'signed-out' && !(harness === 'claude' && has(env, 'CLAUDE_CODE_OAUTH_TOKEN'))) return `not signed in; run ${SIGN_IN[harness]}`;
  return null;
}

const DETECTED_TEXT: Readonly<Record<DetectedAuth, string>> = {
  subscription: 'the harness reports a subscription login',
  'api-key': 'the harness reports an API key',
  'signed-out': 'the harness reports no login',
  unknown: 'not detected',
  'not-probed': 'not probed',
};

/** One doctor line per harness: the mode, where it came from, and what would stop a run. */
export function authLine(view: HarnessAuthView, workersFile = '<config>/workers.json'): string {
  // Antigravity signs in only with Google (D: its auto is always that sign-in); there is no
  // mode to detect, and api-key is refused.
  if (view.harness === 'antigravity') {
    const source = view.setting === 'auto' ? 'auto: always its Google sign-in' : 'stated in workers.json';
    return `harness antigravity auth: ${view.mode === 'api-key' ? 'api-key' : 'google sign-in'} (${source}; Antigravity refuses api-key)${view.problem === null ? '' : `; ${view.problem}`}`;
  }
  // Kilo and OpenCode list their stored credentials; when that could not be read (not probed
  // here), nothing stated and no key in the environment means the mode is not known, and
  // doctor says so instead of assuming a subscription.
  const undetectable = view.harness === 'kilo' || view.harness === 'opencode';
  const modelKeys = (view.modelKeysInEnvironment ?? []).length > 0 ? `; ${(view.modelKeysInEnvironment ?? []).join(', ')} in the environment for Grok models` : '';
  if (view.setting === 'auto' && view.keysInEnvironment.length === 0 && (view.detected === 'unknown' || (undetectable && view.detected === 'not-probed'))) {
    return `harness ${view.harness} auth: unknown (not detected, and not stated${modelKeys}); state it in ${workersFile} (subscription or api-key), for example {"schemaVersion":"jevris-workers-1","auth":{"${view.harness}":"subscription"}}`;
  }
  const source = view.setting === 'auto' ? (view.keysInEnvironment.length > 0 ? `auto: ${view.keysInEnvironment.join(', ')} in the environment` : 'auto: no vendor key in the environment') : `stated in workers.json`;
  const tail = view.problem === null ? '' : `; ${view.problem}`;
  const detected = view.detected === 'not-probed' && view.notProbed !== undefined ? view.notProbed : DETECTED_TEXT[view.detected];
  return `harness ${view.harness} auth: ${view.mode} (${source}; ${detected}${modelKeys})${tail}`;
}

/**
 * The child environment for a worker in `auth` mode. Subscription: every vendor key removed.
 * API key: the subscription tokens removed, and for Codex the key is offered as CODEX_API_KEY
 * (what `codex exec` reads) when only OPENAI_API_KEY is set. Values move between variables in
 * memory only; nothing is written anywhere.
 */
export function workerEnv(harness: AuthHarness, auth: AuthMode | undefined, env: Env): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  if (auth === 'subscription') for (const key of VENDOR_KEYS) delete out[key];
  if (auth === 'api-key') {
    for (const key of SUBSCRIPTION_TOKENS) delete out[key];
    if (harness === 'codex' && !has(out, 'CODEX_API_KEY') && has(out, 'OPENAI_API_KEY')) out['CODEX_API_KEY'] = out['OPENAI_API_KEY'] as string;
  }
  return out;
}
