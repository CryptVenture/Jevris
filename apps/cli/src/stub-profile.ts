import { join } from 'node:path';
import type { GlobalHarness } from './global-harness.js';
import { appendTomlBlock, removeTomlTables, tomlString } from './toml-edit.js';

/**
 * Points a harness in certify's throwaway profile at the loopback stub provider (stub-provider.ts;
 * owner decision OD-9, routing design R33). The stub never calls a model, so the no-cost certify
 * cases (K1-K4, K8, K12) cost nothing:
 * - Claude Code: `ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_API_KEY`;
 * - Codex: a `[model_providers.stub]` with `wire_api = "responses"` in the profile's CODEX_HOME;
 * - OpenCode and Kilo: `OPENCODE_CONFIG_CONTENT` / `KILO_CONFIG_CONTENT` overriding the built-in
 *   anthropic provider's `baseURL`. No provider package from npm, which OpenCode would install at
 *   run time (network and a side effect).
 * Antigravity has no custom endpoint, so it has no stub profile and its cases stay owner-run.
 *
 * These functions are pure: they take the environment certify already built (certifyEnv) and
 * return a new one, plus the file contents to write. They never read or write the real home.
 * Every credential and provider route the parent environment carried is removed, so a stub run
 * can neither reach a real provider nor carry a real key: only the stub's dummy key remains.
 */

/** The part of a running stub a profile needs. */
export interface StubEndpoint {
  readonly baseUrl: string;
  readonly dummyKey: string;
}

export type StubEnv = { [key: string]: string };
type Env = { readonly [key: string]: string | undefined };

export interface StubProfileFile {
  readonly path: string;
  readonly content: string;
}

export interface StubProfile {
  readonly env: StubEnv;
  readonly files: readonly StubProfileFile[];
}

/** The harnesses a stub profile can point at the stub. */
export const STUB_HARNESSES = ['claude', 'codex', 'opencode', 'kilocode'] as const;
export type StubHarness = (typeof STUB_HARNESSES)[number];

/** The variable Codex reads the dummy key from (`env_key` of the stub provider). */
export const STUB_KEY_VARIABLE = 'JEVRIS_STUB_KEY';
/** The Codex provider id the stub is registered under. */
export const CODEX_STUB_PROVIDER = 'stub';

/** Only a loopback http origin with a port: the stub binds 127.0.0.1 and nothing else. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const DUMMY = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Variables that route a harness to a provider, choose its models or carry a credential. A stub
 * profile drops them all: a cloud switch (Bedrock, Vertex, Foundry), an auth token or another
 * base URL would bypass or outrank the stub, and a model override would hide the model a case
 * asked for.
 */
const DROPPED_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'CLAUDE_CODE_USE_', 'AZURE_OPENAI_'] as const;
const DROPPED_SUFFIXES = ['_API_KEY', '_AUTH_TOKEN', '_ACCESS_TOKEN', '_OAUTH_TOKEN', '_BASE_URL', '_API_BASE'] as const;
const DROPPED_NAMES = new Set(['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENCODE_CONFIG_CONTENT', 'KILO_CONFIG_CONTENT', STUB_KEY_VARIABLE]);

export function droppedForStub(name: string): boolean {
  const upper = name.toUpperCase();
  return DROPPED_NAMES.has(upper) || DROPPED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || DROPPED_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

function checkEndpoint(stub: StubEndpoint): void {
  if (!LOOPBACK.test(stub.baseUrl)) throw new Error('STUB_NOT_LOOPBACK: a stub profile points only at http://127.0.0.1:<port>');
  if (!DUMMY.test(stub.dummyKey)) throw new Error('STUB_KEY_INVALID: the stub key is a short fixed literal');
}

function checkModel(model: string): void {
  if (!MODEL.test(model)) throw new Error('STUB_MODEL_INVALID: the case model is not a model id');
}

/** No proxy for the loopback stub, added to whatever the parent listed. */
function noProxy(value: string | undefined): string {
  const parts = (value ?? '').split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  for (const host of ['127.0.0.1', 'localhost']) if (!parts.includes(host)) parts.push(host);
  return parts.join(',');
}

/** The certify environment with every provider route and credential removed, and no proxy for the stub. */
export function stubBaseEnv(env: Env): StubEnv {
  const out: StubEnv = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string' && !droppedForStub(key)) out[key] = value;
  const listed = env['NO_PROXY'] ?? env['no_proxy'];
  out['NO_PROXY'] = noProxy(listed);
  out['no_proxy'] = out['NO_PROXY'];
  return out;
}

/**
 * Claude Code. HOME and CLAUDE_CONFIG_DIR stay as certifyEnv set them (on macOS the account's
 * HOME, for the keychain; the config folder always in the profile).
 */
export function stubProfileClaude(stub: StubEndpoint, env: Env): StubProfile {
  checkEndpoint(stub);
  const out = stubBaseEnv(env);
  out['ANTHROPIC_BASE_URL'] = stub.baseUrl;
  out['ANTHROPIC_API_KEY'] = stub.dummyKey;
  out['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
  out['DISABLE_TELEMETRY'] = '1';
  return { env: out, files: [] };
}

/**
 * The profile's Codex config.toml with the stub as its provider and `model` set. Any top-level
 * `model` / `model_provider` and any earlier stub table are replaced; everything else (the hooks
 * install wrote, for one) is kept. Null when the existing file does not scan as TOML.
 */
export function stubCodexConfig(existing: string, stub: StubEndpoint, model: string): string | null {
  checkEndpoint(stub);
  checkModel(model);
  let text: string | null = existing;
  for (const prefix of [['model'], ['model_provider'], ['model_providers', CODEX_STUB_PROVIDER]]) {
    if (text === null) return null;
    text = removeTomlTables(text, prefix);
  }
  if (text === null) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const head = [`model = ${tomlString(model)}`, `model_provider = ${tomlString(CODEX_STUB_PROVIDER)}`].join(eol);
  const body = text.replace(/^(?:[ \t]*\r?\n)+/, '');
  const top = body.length > 0 ? `${head}${eol}${eol}${body}` : `${head}${eol}`;
  return appendTomlBlock(top, [
    `[model_providers.${CODEX_STUB_PROVIDER}]`,
    `name = ${tomlString('Jevris stub provider')}`,
    `base_url = ${tomlString(`${stub.baseUrl}/v1`)}`, // path-hygiene: allow loopback URL, not a file path
    `wire_api = ${tomlString('responses')}`,
    `env_key = ${tomlString(STUB_KEY_VARIABLE)}`,
  ]).text;
}

/** Codex, in the profile's CODEX_HOME (certifyEnv sets it). `existing` is that config.toml, or '' when absent. */
export function stubProfileCodex(stub: StubEndpoint, env: Env, model: string, existing = ''): StubProfile {
  const home = env['CODEX_HOME'];
  if (home === undefined || home.length === 0) throw new Error('STUB_NO_PROFILE: CODEX_HOME is not set; build the env with certifyEnv first');
  const content = stubCodexConfig(existing, stub, model);
  if (content === null) throw new Error('STUB_CONFIG_UNREADABLE: the profile config.toml does not scan as TOML');
  const out = stubBaseEnv(env);
  out[STUB_KEY_VARIABLE] = stub.dummyKey;
  return { env: out, files: [{ path: join(home, 'config.toml'), content }] };
}

/** The inline config for OpenCode and Kilo: the built-in anthropic provider, pointed at the stub. */
export function stubOpencodeConfig(stub: StubEndpoint, model: string): string {
  checkEndpoint(stub);
  checkModel(model);
  return JSON.stringify({
    provider: { anthropic: { options: { baseURL: `${stub.baseUrl}/v1`, apiKey: stub.dummyKey } } }, // path-hygiene: allow loopback URL, not a file path
    model: `anthropic/${model}`,
    autoupdate: false,
    share: 'disabled',
  });
}

/** OpenCode (`OPENCODE_CONFIG_CONTENT`) and Kilo (`KILO_CONFIG_CONTENT`); no file is written. */
export function stubProfileOpencode(harness: 'opencode' | 'kilocode', stub: StubEndpoint, env: Env, model: string): StubProfile {
  const content = stubOpencodeConfig(stub, model);
  const out = stubBaseEnv(env);
  out[harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT'] = content;
  return { env: out, files: [] };
}

export function isStubHarness(harness: GlobalHarness): harness is StubHarness {
  return (STUB_HARNESSES as readonly string[]).includes(harness);
}

/**
 * The stub profile for a harness, or null for Antigravity (no custom endpoint: owner-run).
 * `model` is the registry-side model id the case asks for (Claude takes it on its own flag).
 */
export function stubProfile(harness: GlobalHarness, stub: StubEndpoint, env: Env, options: { readonly model: string; readonly codexConfig?: string }): StubProfile | null {
  if (harness === 'claude') {
    checkModel(options.model);
    return stubProfileClaude(stub, env);
  }
  if (harness === 'codex') return stubProfileCodex(stub, env, options.model, options.codexConfig ?? '');
  if (harness === 'opencode' || harness === 'kilocode') return stubProfileOpencode(harness, stub, env, options.model);
  return null;
}
