/**
 * The runner environment: an explicit per-platform allowlist, never the whole parent env and
 * never an empty env (VER-01, VER-02, BUG-25). Credential-looking names are always refused, so
 * a manifest cannot pull a provider key into a check. The fingerprint records names and value
 * hashes only.
 */
import { sha256, stableJson } from '../util.js';

const COMMON = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'TERM'];
const POSIX = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL'];
const WIN32 = [
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

export const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_().]{0,127}$/;

export type EnvMap = { readonly [key: string]: string | undefined };

export function baseAllowlist(platform: string): readonly string[] {
  return platform === 'win32' ? [...COMMON, ...WIN32] : [...COMMON, ...POSIX];
}

/** True for a name a manifest may add to the allowlist. */
export function allowableName(name: string): boolean {
  return NAME_PATTERN.test(name) && !CREDENTIAL_NAME.test(name);
}

function lookup(env: EnvMap, name: string, platform: string): { readonly key: string; readonly value: string } | undefined {
  if (platform !== 'win32') {
    const value = env[name];
    return typeof value === 'string' ? { key: name, value } : undefined;
  }
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) {
      const value = env[key];
      if (typeof value === 'string') return { key: name, value };
    }
  }
  return undefined;
}

export interface RunnerEnvironment {
  readonly env: { readonly [key: string]: string };
  readonly names: readonly string[];
  readonly refused: readonly string[];
}

export function runnerEnvironment(parent: EnvMap, extra: readonly string[], platform: string): RunnerEnvironment {
  const env: { [key: string]: string } = {};
  const refused: string[] = [];
  const wanted = [...baseAllowlist(platform)];
  for (const name of extra) {
    if (!allowableName(name)) {
      refused.push(name);
      continue;
    }
    if (!wanted.includes(name)) wanted.push(name);
  }
  for (const name of wanted) {
    const found = lookup(parent, name, platform);
    if (found !== undefined) env[found.key] = found.value;
  }
  return { env, names: Object.keys(env).sort(), refused };
}

export interface EnvironmentFingerprint {
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly variables: { readonly [name: string]: string };
  readonly toolchains: { readonly [name: string]: string };
}

export function fingerprint(
  env: { readonly [key: string]: string },
  facts: { readonly platform: string; readonly arch: string; readonly node: string; readonly toolchains?: { readonly [name: string]: string } },
): { readonly fingerprint: EnvironmentFingerprint; readonly hash: string } {
  const variables: { [name: string]: string } = {};
  for (const name of Object.keys(env).sort()) variables[name] = sha256(env[name] ?? '').slice(0, 16);
  const value: EnvironmentFingerprint = {
    platform: facts.platform,
    arch: facts.arch,
    node: facts.node,
    variables,
    toolchains: { ...(facts.toolchains ?? {}) },
  };
  return { fingerprint: value, hash: sha256(stableJson(value)) };
}
