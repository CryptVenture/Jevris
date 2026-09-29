/**
 * Worker auth mode per harness (ORC-05, owner decision 2026-09-26): a harness runs on the
 * user's subscription login or on a vendor API key, and both are first-class.
 *
 * - `<config>/workers.json` may declare the mode per harness:
 *   `{ "schemaVersion": "jevris-workers-1", "auth": { "claude": "auto" | "api-key" | "subscription", ... } }`.
 * - `auto` (the default) is `api-key` when the harness's vendor key is in the environment,
 *   otherwise `subscription`. On OpenCode and Kilo, which hold their own per-provider logins and
 *   keys, `auto` follows what the harness holds for the model's provider
 *   (`resolveMultiProviderAuth`), so a run never bills a stored key while it is recorded as a
 *   subscription.
 * - `workers.json` may also name the preferred harness per model provider:
 *   `"harness": { "xai": "kilo", "anthropic": "opencode" }` (see PROVIDER_HARNESSES). Without
 *   one, the provider's native harness is tried first, then OpenCode, then Kilo.
 * - A subscription login runs only through the user's installed harness CLI (F's ports). The
 *   Agent SDK runs only in `api-key` mode, with the key from the environment. Anthropic does not
 *   allow third-party products to use claude.ai logins through the Agent SDK.
 *
 * - xAI (Grok) models run through the user's installed OpenCode or Kilo (owner decision
 *   2026-09-26, DOMAINS 72ff950, superseding 82d085f). Subscription mode uses the harness's own
 *   SuperGrok login: xAI announced SuperGrok OAuth for OpenCode (2026-05-21) and Kilo
 *   (2026-05-27), the same pattern as Claude and Codex subscriptions, where the harness does the
 *   login and Jevris never touches the token. api-key mode needs XAI_API_KEY (XAI_API_KEY_MISSING);
 *   `auto` is api-key when XAI_API_KEY is set, else subscription. A subscription run never sees
 *   XAI_API_KEY, and a key run is never handed a login token (`providerEnv`).
 *   SuperGrok plan eligibility for third-party harnesses is unconfirmed (one report shows a
 *   standard SuperGrok plan getting HTTP 403), so a harness's 403 is named XAI_PLAN_NOT_ELIGIBLE
 *   and a 401 or login failure XAI_AUTH_FAILED (`xaiAuthFailure`), never a generic failure.
 *
 * Only the mode is read or recorded, never a key or token value.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRegistry } from '@jevris/contracts';
import { isPlain, own } from '../util.js';
import { hostRouteOfSpelling } from './worker-hosts.js';

export type WorkerHarness = 'claude' | 'codex' | 'opencode' | 'kilo' | 'antigravity';
export type WorkerAuthMode = 'api-key' | 'subscription';
export type WorkerAuthSetting = 'auto' | WorkerAuthMode;

export const WORKERS_SETTINGS_FILE = 'workers.json';
export const WORKERS_SETTINGS_SCHEMA = 'jevris-workers-1';

export const WORKER_HARNESSES: readonly WorkerHarness[] = ['claude', 'codex', 'opencode', 'kilo', 'antigravity'];
const HARNESSES = WORKER_HARNESSES;
const SETTINGS: readonly WorkerAuthSetting[] = ['auto', 'api-key', 'subscription'];

/** The vendor key variables whose presence means `api-key` in `auto` mode. */
export const VENDOR_KEY_VARS: { readonly [H in WorkerHarness]: readonly string[] } = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  opencode: [],
  kilo: [],
  // Antigravity signs in with a Google account only (its headless docs name no API-key sign-in),
  // so `auto` is always its subscription login.
  antigravity: [],
};

/**
 * The model providers an owned worker can run (routing design R29): the registry's providers
 * Jevris knows the key variables for. Which of them runs, and on which harness, comes from the
 * loaded registry's harness rows (`providerHarnesses`); GLM (zai), Kimi (moonshot) and DeepSeek
 * run only through OpenCode or Kilo provider configuration.
 */
export type WorkerProvider = 'anthropic' | 'openai' | 'xai' | 'google' | 'zai' | 'moonshot' | 'deepseek';
export const WORKER_PROVIDERS: readonly WorkerProvider[] = ['anthropic', 'openai', 'xai', 'google', 'zai', 'moonshot', 'deepseek'];

/**
 * The provider key variables an owned worker's API-key mode needs (names only). zai, moonshot and
 * deepseek are the variables OpenCode and Kilo read for those providers (models.dev, read by F on
 * 2026-09-27; F's opencodeProviderKeys gives the same).
 */
export const PROVIDER_KEY_VARS: { readonly [P in WorkerProvider]: readonly string[] } = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  xai: ['XAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  zai: ['ZHIPU_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
};

/**
 * The harnesses that can run an owned worker for each provider's models, native harness first,
 * for a registry without harness rows. OpenCode and Kilo are multi-provider; xAI, GLM, Kimi and
 * DeepSeek models run only on them.
 */
export const PROVIDER_HARNESSES: { readonly [P in WorkerProvider]: readonly WorkerHarness[] } = {
  anthropic: ['claude', 'opencode', 'kilo'],
  openai: ['codex', 'opencode', 'kilo'],
  xai: ['opencode', 'kilo'],
  google: ['antigravity', 'opencode', 'kilo'],
  zai: ['opencode', 'kilo'],
  moonshot: ['opencode', 'kilo'],
  deepseek: ['opencode', 'kilo'],
};

/** The registry's harness row names (HARNESS_IDS) for D's worker harnesses. */
const WORKER_HARNESS_OF: { readonly [harness: string]: WorkerHarness } = { claude: 'claude', codex: 'codex', opencode: 'opencode', kilocode: 'kilo', antigravity: 'antigravity' };

/** One registry harness row, as far as the worker runner reads it. */
export interface ProviderHarnessRow {
  readonly harness: string;
  readonly provider: string;
  readonly access?: string;
  readonly idTemplate?: string;
  readonly providerIds?: readonly string[];
}

/**
 * The harnesses that can run a provider's models (R29), native first, then OpenCode, then Kilo,
 * from the registry's harness rows. Whether OpenCode or Kilo can name a given model is asked per
 * model (F's `opencodeModel`), and a harness that cannot is skipped: Kimi and DeepSeek on Kilo
 * today. A registry without harness rows uses PROVIDER_HARNESSES.
 */
export function providerHarnesses(provider: WorkerProvider, registry?: { readonly harnessAccess?: readonly ProviderHarnessRow[] }): readonly WorkerHarness[] {
  const rows = registry?.harnessAccess;
  if (rows === undefined || rows.length === 0) return PROVIDER_HARNESSES[provider];
  const order = (row: ProviderHarnessRow): number => (row.access === 'native' ? 0 : row.harness === 'opencode' ? 1 : 2);
  const usable = rows
    .filter((row) => row.provider === provider && WORKER_HARNESS_OF[row.harness] !== undefined)
    .sort((a, b) => order(a) - order(b));
  return [...new Set(usable.map((row) => WORKER_HARNESS_OF[row.harness] as WorkerHarness))];
}

const OPENAI_MODEL = /^(?:openai\/)?(?:gpt-|o[1-9]|codex)/i;
const XAI_MODEL = /^(?:(?:xai|x-ai)\/|grok(?:[-.]|$))/i;
const GOOGLE_MODEL = /^(?:google\/|gemini(?:[-.]|$))/i;
/** Anthropic API ids and Claude Code's aliases (`opus`, `sonnet[1m]`, `haiku`, `opusplan`, `default`). */
const ANTHROPIC_MODEL = /^(?:(?:anthropic\/)?claude-|(?:opus|sonnet|haiku|opusplan|default)(?:\[1m\])?$)/i;

/** A run for a model whose provider is not known (routing design R5): refused, never sent to Claude. */
export const WORKER_PROVIDER_UNKNOWN = 'WORKER_PROVIDER_UNKNOWN';

/** The registry parts the worker runner reads (the loaded model registry, or the bundled one). */
export interface ProviderRegistry {
  readonly entries: readonly { readonly modelId: string; readonly provider: string; readonly requiresProviderConsent?: boolean }[];
  readonly harnessAccess?: readonly ProviderHarnessRow[];
}

/** A full model registry (the loaded or bundled one), not a test's partial one: the resolver needs it. */
function isFullRegistry(value: ProviderRegistry): value is ProviderRegistry & ModelRegistry {
  return typeof Reflect.get(value, 'baselineModelId') === 'string' && typeof Reflect.get(value, 'snapshotId') === 'string';
}

function isWorkerProvider(value: string): value is WorkerProvider {
  return (WORKER_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The provider of a model id (`grok-4.7`, `xai/grok-4.7`, `gpt-5`, `claude-…`), or null when it
 * is not known (routing design R5).
 * - An id the model registry lists takes the registry's provider (a `provider/` prefix is read
 *   as the provider when the registry lists the id under it). A registry provider that owned
 *   workers do not run yet is null.
 * - Otherwise the id's family: Anthropic, OpenAI, xAI or Google.
 * - A pinned host's spelling of a registered model (R52: `openrouter/moonshotai/kimi-k3`, read by
 *   core's resolver on OpenCode or Kilo) takes the maker behind the host.
 * - Anything else is null. The caller refuses it (WORKER_PROVIDER_UNKNOWN); an unknown id is
 *   never run on Claude.
 */
export function workerProvider(model: string, registry?: ProviderRegistry): WorkerProvider | null {
  // R52: a host spelling (`openrouter/moonshotai/kimi-k3`) names the maker behind the host.
  if (registry !== undefined && model.indexOf('/') !== model.lastIndexOf('/') && isFullRegistry(registry)) {
    const route = hostRouteOfSpelling(registry, model);
    if (route !== null) return isWorkerProvider(route.provider) && providerHarnesses(route.provider, registry).length > 0 ? route.provider : null;
  }
  if (registry !== undefined) {
    const cut = model.indexOf('/');
    const prefix = cut > 0 ? model.slice(0, cut) : undefined;
    const bare = cut > 0 ? model.slice(cut + 1) : model;
    // A prefix is the registry's provider, or a harness's own provider id for it (`moonshotai/kimi-k3`).
    const byHarnessId = prefix === undefined ? undefined : (registry.harnessAccess ?? []).find((row) => (row.providerIds ?? []).includes(prefix))?.provider;
    const listed = registry.entries.filter((entry) => entry.modelId === bare && (prefix === undefined || entry.provider === prefix || entry.provider === byHarnessId));
    const providers = new Set(listed.map((entry) => entry.provider));
    if (providers.size === 1) {
      const provider = [...providers][0] as string;
      return isWorkerProvider(provider) && providerHarnesses(provider, registry).length > 0 ? provider : null;
    }
    if (providers.size > 1) return null;
  }
  if (XAI_MODEL.test(model)) return 'xai';
  if (OPENAI_MODEL.test(model)) return 'openai';
  if (GOOGLE_MODEL.test(model)) return 'google';
  if (ANTHROPIC_MODEL.test(model)) return 'anthropic';
  return null;
}

/** Reason codes for an owned worker's xAI auth. */
export const XAI_API_KEY_MISSING = 'XAI_API_KEY_MISSING';
export const XAI_PLAN_NOT_ELIGIBLE = 'XAI_PLAN_NOT_ELIGIBLE';
export const XAI_AUTH_FAILED = 'XAI_AUTH_FAILED';

export type ProviderAuthDecision =
  | { readonly ok: true; readonly mode: WorkerAuthMode }
  | { readonly ok: false; readonly mode: WorkerAuthMode; readonly reasonCode: string; readonly reason: string };

/**
 * The provider's rule for an owned worker. xAI: a declared subscription runs on the harness's
 * own login; declared api-key needs XAI_API_KEY; `auto` is api-key with the key, else
 * subscription. Other providers keep the harness's decided mode (their harness ports enforce
 * their own rules).
 */
export function ownedWorkerAuth(provider: WorkerProvider, mode: WorkerAuthMode, setting: WorkerAuthSetting | undefined, env: { readonly [key: string]: string | undefined }): ProviderAuthDecision {
  if (provider !== 'xai') return { ok: true, mode };
  const hasKey = PROVIDER_KEY_VARS.xai.some((name) => (env[name] ?? '') !== '');
  if (setting === 'subscription') return { ok: true, mode: 'subscription' };
  if (setting === 'api-key' && !hasKey) return { ok: false, mode: 'api-key', reasonCode: XAI_API_KEY_MISSING, reason: `${XAI_API_KEY_MISSING}: api-key mode for an xAI model needs XAI_API_KEY in the environment` };
  return { ok: true, mode: hasKey ? 'api-key' : 'subscription' };
}

/** The environment a provider's owned worker gets: a subscription run never sees the provider's keys. */
export function providerEnv(provider: WorkerProvider, mode: WorkerAuthMode, env: { readonly [key: string]: string | undefined }): { [key: string]: string | undefined } {
  const out: { [key: string]: string | undefined } = { ...env };
  if (mode === 'subscription') for (const name of PROVIDER_KEY_VARS[provider]) delete out[name];
  return out;
}

/**
 * Names an xAI auth failure from a harness outcome's reason: a 403 or a plan refusal is
 * XAI_PLAN_NOT_ELIGIBLE, a 401 or a login failure XAI_AUTH_FAILED; null when it is neither.
 */
export function xaiAuthFailure(reason: string): typeof XAI_PLAN_NOT_ELIGIBLE | typeof XAI_AUTH_FAILED | null {
  if (/\b403\b|forbidden|not eligible|not included in your plan|not available (?:on|for) your plan|upgrade your (?:plan|subscription)/i.test(reason)) return XAI_PLAN_NOT_ELIGIBLE;
  if (/\b401\b|unauthori[sz]ed|not (?:logged|signed) in|(?:log|sign) ?in required|authentication failed|invalid (?:api )?key/i.test(reason)) return XAI_AUTH_FAILED;
  return null;
}

export type WorkerAuthSettings =
  | {
      readonly ok: true;
      readonly auth: { readonly [H in WorkerHarness]?: WorkerAuthSetting };
      /** The preferred harness per model provider (`workers.json` `harness`), when declared. */
      readonly harness?: { readonly [P in WorkerProvider]?: WorkerHarness };
    }
  | { readonly ok: false; readonly problem: string };

export function readWorkerAuthSettings(configDir: string): WorkerAuthSettings {
  let text: string;
  try {
    text = readFileSync(join(configDir, WORKERS_SETTINGS_FILE), 'utf8');
  } catch {
    return { ok: true, auth: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'workers.json is not JSON' };
  }
  if (!isPlain(parsed) || own(parsed, 'schemaVersion') !== WORKERS_SETTINGS_SCHEMA) return { ok: false, problem: `workers.json needs schemaVersion ${WORKERS_SETTINGS_SCHEMA}` };
  const preferred = own(parsed, 'harness');
  const harness: { [P in WorkerProvider]?: WorkerHarness } = {};
  if (preferred !== undefined) {
    if (!isPlain(preferred)) return { ok: false, problem: 'workers.json harness must be an object' };
    for (const [key, value] of Object.entries(preferred)) {
      if (!(WORKER_PROVIDERS as readonly string[]).includes(key)) return { ok: false, problem: `workers.json harness names an unknown provider: ${key.slice(0, 32)}` };
      const provider = key as WorkerProvider;
      if (typeof value !== 'string' || !(PROVIDER_HARNESSES[provider] as readonly string[]).includes(value)) return { ok: false, problem: `workers.json harness.${key} must be one of ${PROVIDER_HARNESSES[provider].join(', ')}` };
      harness[provider] = value as WorkerHarness;
    }
  }
  const withHarness = Object.keys(harness).length > 0 ? { harness } : {};
  const auth = own(parsed, 'auth');
  if (auth === undefined) return { ok: true, auth: {}, ...withHarness };
  if (!isPlain(auth)) return { ok: false, problem: 'workers.json auth must be an object' };
  const out: { [H in WorkerHarness]?: WorkerAuthSetting } = {};
  for (const [key, value] of Object.entries(auth)) {
    if (!(HARNESSES as readonly string[]).includes(key)) return { ok: false, problem: `workers.json names an unknown harness: ${key.slice(0, 32)}` };
    if (typeof value !== 'string' || !(SETTINGS as readonly string[]).includes(value)) return { ok: false, problem: `workers.json auth.${key} must be auto, api-key or subscription` };
    out[key as WorkerHarness] = value as WorkerAuthSetting;
  }
  return { ok: true, auth: out, ...withHarness };
}

/**
 * The mode a harness's worker runs in: the declared one, else detected from the environment.
 * For a multi-provider harness (OpenCode, Kilo), `auto` looks at the model provider's key. With no
 * key the answer is an assumed subscription, for billing only: it is not a sign-in (`vendorAuth`
 * says `undetected`, which the consent gate does not count, finding 8).
 */
export function harnessAuthMode(harness: WorkerHarness, provider: WorkerProvider, setting: WorkerAuthSetting | undefined, env: { readonly [key: string]: string | undefined }): WorkerAuthMode {
  if (setting === 'api-key' || setting === 'subscription') return setting;
  const names = harness === 'opencode' || harness === 'kilo' ? PROVIDER_KEY_VARS[provider] : VENDOR_KEY_VARS[harness];
  return names.some((name) => (env[name] ?? '') !== '') ? 'api-key' : 'subscription';
}

// ------------------------------------------------- multi-provider harnesses (OpenCode, Kilo)

/** One credential a multi-provider harness holds (`<harness> auth list`): provider as printed and its type, never a value. */
export interface StoredCredential {
  readonly provider: string;
  readonly type: string;
}

/** Where a run's auth mode came from (recorded with the run). */
export type WorkerAuthSource = 'declared' | 'environment' | 'stored-login' | 'stored-key' | 'nothing-stored' | 'undetected';

/**
 * OD-4 (B's security review, finding 8): the sources that count as signed in to a provider for
 * the consent gate's signed-in default. `undetected` is an assumed subscription (Jevris never reads
 * a harness's own login), so it never does; neither does `nothing-stored`.
 */
export const SIGNED_IN_SOURCES: ReadonlySet<WorkerAuthSource> = new Set<WorkerAuthSource>(['declared', 'environment', 'stored-login', 'stored-key']);

/** Whether a resolved auth source counts as signed in (finding 8). */
export function signedInSource(source: WorkerAuthSource | null | undefined): boolean {
  return source !== null && source !== undefined && SIGNED_IN_SOURCES.has(source);
}

/**
 * The mode of a single-vendor harness's worker (Claude Code, Codex, Antigravity) and its source:
 * the declared mode (`declared`), else the vendor's key in the environment (`environment`), else a
 * subscription that is assumed, not seen (`undetected`).
 */
export function vendorAuth(harness: WorkerHarness, provider: WorkerProvider, setting: WorkerAuthSetting | undefined, env: { readonly [key: string]: string | undefined }): { readonly mode: WorkerAuthMode; readonly source: WorkerAuthSource } {
  const mode = harnessAuthMode(harness, provider, setting, env);
  if (setting === 'api-key' || setting === 'subscription') return { mode, source: 'declared' };
  return { mode, source: mode === 'api-key' ? 'environment' : 'undetected' };
}

export type ResolvedWorkerAuth =
  | { readonly ok: true; readonly mode: WorkerAuthMode; readonly source: WorkerAuthSource }
  | { readonly ok: false; readonly mode: WorkerAuthMode; readonly source: WorkerAuthSource; readonly reasonCode: string; readonly reason: string };

/** The refusal when a harness holds no usable login or key for a provider: `XAI_NO_LOGIN`, `OPENAI_NO_LOGIN` … */
export function noLoginCode(provider: WorkerProvider): string {
  return `${provider.toUpperCase()}_NO_LOGIN`;
}

/** The model provider a stored credential's printed provider name belongs to, or null. */
export function credentialProvider(name: string): WorkerProvider | null {
  const n = name.trim().toLowerCase();
  if (/^anthropic\b/.test(n)) return 'anthropic';
  if (/^openai\b/.test(n)) return 'openai';
  if (/^(?:xai|x-ai|x\.ai|grok)\b/.test(n)) return 'xai';
  if (/^(?:google|gemini)\b/.test(n)) return 'google';
  if (/^(?:zai|z\.ai|zhipu)/.test(n)) return 'zai';
  if (/^(?:moonshot|kimi)/.test(n)) return 'moonshot';
  if (/^deepseek\b/.test(n)) return 'deepseek';
  return null;
}

const LOGIN_TYPES = new Set(['oauth']);
const KEY_TYPES = new Set(['api', 'wellknown']);

/**
 * The auth mode of an owned worker on OpenCode or Kilo, per model provider (billing
 * correctness, F 17beb82 and 865ffa1; coordinator's rule). `stored` is the harness's credential
 * list (`[]`: nothing stored), or null when it could not be read (not probed in a test run or
 * under a foreign HOME, not installed, unreadable).
 *
 * `auto`, in order:
 * 1. the provider's key in the environment: api-key (`environment`);
 * 2. the list unreadable: subscription, as before detection (`undetected`);
 * 3. a stored API key for the provider: api-key (`stored-key`);
 * 4. a stored OAuth login for the provider: subscription (`stored-login`). An Anthropic OAuth
 *    login does not count: it resolves to a subscription, which the caller refuses
 *    (ANTHROPIC_LOGIN_THIRD_PARTY);
 * 5. nothing stored for the provider: refused before launch, `<PROVIDER>_NO_LOGIN`, with a fix.
 *
 * A mode declared in workers.json always wins (`declared`). XAI_API_KEY_MISSING only when api-key
 * is declared for an xAI model with no key in the environment and none stored in the harness.
 */
export function resolveMultiProviderAuth(
  provider: WorkerProvider,
  setting: WorkerAuthSetting | undefined,
  env: { readonly [key: string]: string | undefined },
  stored: readonly StoredCredential[] | null,
): ResolvedWorkerAuth {
  const envKey = PROVIDER_KEY_VARS[provider].some((name) => (env[name] ?? '') !== '');
  const mine = stored === null ? null : stored.filter((c) => credentialProvider(c.provider) === provider);
  const storedLogin = mine !== null && mine.some((c) => LOGIN_TYPES.has(c.type));
  const storedKey = mine !== null && mine.some((c) => KEY_TYPES.has(c.type));
  if (setting === 'subscription') return { ok: true, mode: 'subscription', source: 'declared' };
  if (setting === 'api-key') {
    if (provider === 'xai' && !envKey && !storedKey) {
      return { ok: false, mode: 'api-key', source: 'declared', reasonCode: XAI_API_KEY_MISSING, reason: `${XAI_API_KEY_MISSING}: api-key is declared for an xAI model, but XAI_API_KEY is not set and the harness holds no xAI key; set XAI_API_KEY or store the key in the harness` };
    }
    return { ok: true, mode: 'api-key', source: 'declared' };
  }
  if (envKey) return { ok: true, mode: 'api-key', source: 'environment' };
  if (mine === null) return { ok: true, mode: 'subscription', source: 'undetected' };
  if (storedKey) return { ok: true, mode: 'api-key', source: 'stored-key' };
  // An Anthropic login resolves to the subscription the caller refuses (ANTHROPIC_LOGIN_THIRD_PARTY).
  if (storedLogin) return { ok: true, mode: 'subscription', source: 'stored-login' };
  const code = noLoginCode(provider);
  const signIn = provider === 'anthropic' ? `store an Anthropic API key in the harness` : `sign in to ${provider} in the harness (its auth login), store a ${provider} API key there`;
  return {
    ok: false,
    mode: 'subscription',
    source: 'nothing-stored',
    reasonCode: code,
    reason: `${code}: the harness holds no ${provider} login or key and ${PROVIDER_KEY_VARS[provider].join(' or ')} is not set; ${signIn}, or set ${PROVIDER_KEY_VARS[provider][0] ?? 'the key'}`,
  };
}

/** The mode a harness's worker runs in: the declared one, else detected from the environment. */
export function workerAuthMode(harness: WorkerHarness, setting: WorkerAuthSetting | undefined, env: { readonly [key: string]: string | undefined }): WorkerAuthMode {
  if (setting === 'api-key' || setting === 'subscription') return setting;
  return VENDOR_KEY_VARS[harness].some((name) => (env[name] ?? '') !== '') ? 'api-key' : 'subscription';
}
