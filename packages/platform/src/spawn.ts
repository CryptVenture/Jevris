import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { envValue, pathApiFor, type EnvLike } from './paths.js';

/**
 * One process-spawn helper (BLD-06).
 *
 * - `resolveExecutable` searches PATH; on win32 it tries each PATHEXT extension and never
 *   picks an extensionless file (npm's POSIX shim next to `claude.cmd`).
 * - `planSpawn` runs `.exe`, `.com` and POSIX executables directly with no shell. A `.cmd`
 *   or `.bat` shim, which Node refuses to spawn without a shell since CVE-2024-27980, runs
 *   as `cmd.exe /d /s /c "<escaped>"` with verbatim arguments. Arguments are quoted and
 *   caret-escaped; an argument cmd.exe cannot escape reliably (`"`, `%`, `!`, CR, LF, NUL)
 *   is refused instead.
 */

export interface ResolveOptions {
  readonly platform?: string;
  readonly env?: EnvLike;
  readonly cwd?: string;
  /** Injected for tests: true when `path` is a runnable file. */
  readonly isExecutableFile?: (path: string) => boolean;
}

export type SpawnPlan =
  | {
      readonly ok: true;
      readonly kind: 'direct' | 'cmd-shim';
      readonly command: string;
      readonly args: readonly string[];
      readonly resolved: string;
      readonly shell: false;
      readonly windowsVerbatimArguments: boolean;
    }
  | { readonly ok: false; readonly reason: 'not-found' | 'unsafe-argument' | 'invalid' };

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const SHIM_UNSAFE = /["%!\r\n\0]/;

function defaultIsExecutable(platform: string): (path: string) => boolean {
  return (path: string) => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform === 'win32') return true;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

export function pathExtensions(env: EnvLike, platform: string): readonly string[] {
  const raw = envValue(env, 'PATHEXT', platform);
  const list = (typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.') && ext.length > 1);
  return list.length > 0 ? list : DEFAULT_PATHEXT.toLowerCase().split(';');
}

function candidatesFor(base: string, platform: string, env: EnvLike): readonly string[] {
  if (platform !== 'win32') return [base];
  const api = pathApiFor(platform);
  const exts = pathExtensions(env, platform);
  const ext = api.extname(base).toLowerCase();
  if (ext.length > 0 && exts.includes(ext)) return [base];
  return exts.map((candidate) => `${base}${candidate}`);
}

export function resolveExecutable(name: string, options: ResolveOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const api = pathApiFor(platform);
  const isExecutable = options.isExecutableFile ?? defaultIsExecutable(platform);
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return null;
  const hasSeparator = name.includes('/') || (platform === 'win32' && name.includes('\\'));
  if (hasSeparator || api.isAbsolute(name)) {
    const base = api.isAbsolute(name) ? name : api.resolve(options.cwd ?? '.', name);
    for (const candidate of candidatesFor(base, platform, env)) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }
  const rawPath = envValue(env, 'PATH', platform) ?? '';
  const dirs = rawPath
    .split(api.delimiter)
    .map((dir) => (platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter((dir) => dir.length > 0 && api.isAbsolute(dir));
  for (const dir of dirs) {
    for (const candidate of candidatesFor(api.join(dir, name), platform, env)) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** cross-spawn style quoting of one argument for `cmd.exe /d /s /c`. */
export function escapeCmdArgument(arg: string): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  return out.replace(CMD_META, '^$1');
}

export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

export function isCmdShim(path: string, platform: string): boolean {
  if (platform !== 'win32') return false;
  const ext = pathApiFor(platform).extname(path).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

export function planSpawn(file: string, args: readonly string[], options: ResolveOptions = {}): SpawnPlan {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) return { ok: false, reason: 'invalid' };
  }
  const resolved = resolveExecutable(file, options);
  if (resolved === null) return { ok: false, reason: 'not-found' };
  if (!isCmdShim(resolved, platform)) {
    return { ok: true, kind: 'direct', command: resolved, args: [...args], resolved, shell: false, windowsVerbatimArguments: false };
  }
  if (SHIM_UNSAFE.test(resolved)) return { ok: false, reason: 'unsafe-argument' };
  for (const arg of args) {
    if (SHIM_UNSAFE.test(arg)) return { ok: false, reason: 'unsafe-argument' };
  }
  const line = [escapeCmdCommand(resolved), ...args.map(escapeCmdArgument)].join(' ');
  const comspec = envValue(env, 'ComSpec', platform);
  const shell = typeof comspec === 'string' && comspec.length > 0 && pathApiFor(platform).isAbsolute(comspec) ? comspec : 'cmd.exe';
  return {
    ok: true,
    kind: 'cmd-shim',
    command: shell,
    args: ['/d', '/s', '/c', `"${line}"`],
    resolved,
    shell: false,
    windowsVerbatimArguments: true,
  };
}

export interface RunSyncOptions extends ResolveOptions {
  readonly timeoutMs?: number;
  readonly spawnEnv?: EnvLike;
}

export interface RunSyncResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason?: 'not-found' | 'unsafe-argument' | 'invalid' | 'spawn-error';
}

/** Plans and runs a command synchronously, capturing text output. Never uses a shell. */
export function runSync(file: string, args: readonly string[], options: RunSyncOptions = {}): RunSyncResult {
  const plan = planSpawn(file, args, options);
  if (!plan.ok) return { ok: false, status: null, stdout: '', stderr: '', reason: plan.reason };
  const result = spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.spawnEnv === undefined ? {} : { env: options.spawnEnv }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (result.error !== undefined) {
    return { ok: false, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', reason: 'spawn-error' };
  }
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
