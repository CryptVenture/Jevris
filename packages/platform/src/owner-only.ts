import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { durableWrite, type DurableWriteOptions, type DurableWriteResult } from './durable-write.js';
import { envValue, pathApiFor, type EnvLike } from './paths.js';

/**
 * Owner-only files and directories on every OS (BLD-08).
 *
 * POSIX: directories 0700, files created exclusively at 0600 (never written then chmodded),
 * umask 077 at the entry points. Windows: `icacls` gives a private directory a protected
 * ACL with one inheritable full-control ACE for the current user's SID, and a private
 * file an explicit one; the SID comes from `whoami /user`. A symlinked private path is
 * refused. `assertOwnerOnly` checks the mode on POSIX and the ACL on Windows.
 */

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
}

export type ExecPort = (file: string, args: readonly string[]) => ExecResult;

export interface PrivateStat {
  readonly mode: number;
  readonly uid?: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface OwnerOnlyOptions {
  readonly platform?: string;
  readonly env?: EnvLike;
  readonly exec?: ExecPort;
  readonly lstat?: (path: string) => Promise<PrivateStat>;
  readonly mkdir?: (path: string, options: { readonly recursive?: boolean; readonly mode?: number }) => Promise<unknown>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  readonly uid?: number;
}

export type OwnerOnlyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'missing' | 'symlink' | 'mode' | 'acl' | 'unknown'; readonly detail: string };

export type PrivateResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

function defaultExec(env: EnvLike, platform: string): ExecPort {
  return (file, args) => {
    const system = envValue(env, 'SystemRoot', platform) ?? 'C:\\Windows';
    const api = pathApiFor(platform);
    const full = api.isAbsolute(file) ? file : api.join(system, 'System32', file);
    const result = spawnSync(full, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000 });
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'EUNKNOWN';
}

function ports(options: OwnerOnlyOptions): {
  platform: string;
  env: EnvLike;
  exec: ExecPort;
  lstat: (path: string) => Promise<PrivateStat>;
  mkdir: (path: string, options: { readonly recursive?: boolean; readonly mode?: number }) => Promise<unknown>;
  chmod: (path: string, mode: number) => Promise<void>;
} {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return {
    platform,
    env,
    exec: options.exec ?? defaultExec(env, platform),
    lstat: options.lstat ?? lstat,
    mkdir: options.mkdir ?? mkdir,
    chmod: options.chmod ?? chmod,
  };
}

// ---------------------------------------------------------------- Windows ACL

export interface CurrentUser {
  readonly name: string;
  readonly sid: string;
}

const userCache = new Map<ExecPort, CurrentUser | null>();

/** Parses `whoami /user /fo csv /nh`: `"domain\user","S-1-5-21-..."`. */
export function parseWhoami(stdout: string): CurrentUser | null {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return null;
  const match = /^"([^"]+)","(S-1-[0-9-]+)"$/.exec(line);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return { name: match[1], sid: match[2] };
}

export function currentUser(exec: ExecPort): CurrentUser | null {
  if (userCache.has(exec)) return userCache.get(exec) ?? null;
  const result = exec('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const user = result.status === 0 ? parseWhoami(result.stdout) : null;
  userCache.set(exec, user);
  return user;
}

export interface AclEntry {
  readonly principal: string;
  readonly rights: string;
}

/**
 * Parses `icacls <path>` output. The first line is the path followed by the first ACE;
 * further ACEs are indented. Parsing stops at the first blank line (the summary follows).
 */
export function parseIcacls(stdout: string, path: string): readonly AclEntry[] | null {
  const lines = stdout.split(/\r?\n/);
  const entries: AclEntry[] = [];
  let started = false;
  for (const raw of lines) {
    if (!started) {
      if (raw.trim().length === 0) continue;
      if (!raw.toLowerCase().startsWith(path.toLowerCase())) return null;
      started = true;
      const first = raw.slice(path.length).trim();
      if (first.length === 0) continue;
      const entry = parseAce(first);
      if (entry === null) return null;
      entries.push(entry);
      continue;
    }
    const line = raw.trim();
    if (line.length === 0) break;
    const entry = parseAce(line);
    if (entry === null) return null;
    entries.push(entry);
  }
  return started ? entries : null;
}

function parseAce(text: string): AclEntry | null {
  const match = /^(.+?):((?:\([A-Z,]+\))+)$/.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return { principal: match[1], rights: match[2] };
}

function isCurrentUser(principal: string, user: CurrentUser): boolean {
  const value = principal.startsWith('*') ? principal.slice(1) : principal;
  const lower = value.toLowerCase();
  return lower === user.sid.toLowerCase() || lower === user.name.toLowerCase();
}

export function aclIsOwnerOnly(entries: readonly AclEntry[], user: CurrentUser): boolean {
  if (entries.length === 0) return false;
  return entries.every((entry) => isCurrentUser(entry.principal, user) && entry.rights.includes('F'));
}

/** Replaces the ACL with one full-control ACE for the current user (inheritable on a directory). */
export function applyOwnerOnlyAcl(path: string, isDirectory: boolean, options: OwnerOnlyOptions = {}): boolean {
  const { exec } = ports(options);
  const user = currentUser(exec);
  if (user === null) return false;
  const grant = isDirectory ? `*${user.sid}:(OI)(CI)F` : `*${user.sid}:F`;
  const result = exec('icacls.exe', [path, '/inheritance:r', '/grant:r', grant, '/q']);
  if (result.status !== 0) return false;
  const listed = exec('icacls.exe', [path]);
  if (listed.status !== 0) return false;
  const entries = parseIcacls(listed.stdout, path);
  return entries !== null && aclIsOwnerOnly(entries, user);
}

// ---------------------------------------------------------------- checks

export async function assertOwnerOnly(path: string, options: OwnerOnlyOptions = {}): Promise<OwnerOnlyCheck> {
  const p = ports(options);
  let st: PrivateStat;
  try {
    st = await p.lstat(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { ok: false, reason: 'missing', detail: 'not found' }
      : { ok: false, reason: 'unknown', detail: errorCode(error) };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink', detail: 'symlink' };
  if (p.platform === 'win32') {
    const user = currentUser(p.exec);
    if (user === null) return { ok: false, reason: 'unknown', detail: 'whoami failed' };
    const listed = p.exec('icacls.exe', [path]);
    if (listed.status !== 0) return { ok: false, reason: 'unknown', detail: 'icacls failed' };
    const entries = parseIcacls(listed.stdout, path);
    if (entries === null) return { ok: false, reason: 'unknown', detail: 'icacls output not understood' };
    if (!aclIsOwnerOnly(entries, user)) {
      const others = entries.filter((entry) => !isCurrentUser(entry.principal, user)).map((entry) => entry.principal);
      return { ok: false, reason: 'acl', detail: `acl grants ${others.length > 0 ? others.join(', ') : 'less than full control'}` };
    }
    return { ok: true };
  }
  if ((st.mode & 0o077) !== 0) {
    return { ok: false, reason: 'mode', detail: `mode 0${(st.mode & 0o777).toString(8)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- creation

/**
 * Creates `path` as a private directory (parents with default modes). A symlinked path is
 * refused. An existing directory is tightened to 0700 on POSIX when this user owns it; on
 * Windows the ACL is applied when the directory is created, or when `repair` is set.
 */
export async function ensurePrivateDir(path: string, options: OwnerOnlyOptions & { readonly repair?: boolean } = {}): Promise<PrivateResult> {
  const p = ports(options);
  const api = pathApiFor(p.platform);
  let created = false;
  try {
    const before = await p.lstat(path);
    if (before.isSymbolicLink()) return { ok: false, code: 'ESYMLINK' };
    if (!before.isDirectory()) return { ok: false, code: 'ENOTDIR' };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { ok: false, code: errorCode(error) };
    try {
      await p.mkdir(api.dirname(path), { recursive: true });
      await p.mkdir(path, { mode: PRIVATE_DIR_MODE });
      created = true;
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== 'EEXIST') return { ok: false, code: errorCode(mkdirError) };
    }
  }
  let st: PrivateStat;
  try {
    st = await p.lstat(path);
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
  if (st.isSymbolicLink()) return { ok: false, code: 'ESYMLINK' };
  if (!st.isDirectory()) return { ok: false, code: 'ENOTDIR' };
  if (p.platform === 'win32') {
    if (created || options.repair === true) {
      if (!applyOwnerOnlyAcl(path, true, options)) return { ok: false, code: 'EACL' };
    }
    return { ok: true };
  }
  if ((st.mode & 0o077) !== 0) {
    const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    if (uid !== undefined && st.uid !== undefined && st.uid !== uid) return { ok: false, code: 'EOWNER' };
    try {
      await p.chmod(path, PRIVATE_DIR_MODE);
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  }
  return { ok: true };
}

/** Writes a private file: private parent, exclusive 0600 temp, ACL on Windows, atomic replace. */
export async function writePrivateFile(
  path: string,
  data: Uint8Array | string,
  options: OwnerOnlyOptions & Omit<DurableWriteOptions, 'platform' | 'mode' | 'beforeRename'> = {},
): Promise<DurableWriteResult> {
  const p = ports(options);
  const api = pathApiFor(p.platform);
  const dir = await ensurePrivateDir(api.dirname(path), options);
  if (!dir.ok) return dir;
  return durableWrite(path, data, {
    ...options,
    platform: p.platform,
    mode: PRIVATE_FILE_MODE,
    ...(p.platform === 'win32' ? { beforeRename: (temp: string) => applyOwnerOnlyAcl(temp, false, options) } : {}),
  });
}

/** Tightens an existing file (for example SQLite -wal and -shm) to owner-only. Refuses a symlink. */
export async function tightenPrivateFile(path: string, options: OwnerOnlyOptions = {}): Promise<PrivateResult> {
  const p = ports(options);
  let st: PrivateStat;
  try {
    st = await p.lstat(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { ok: true } : { ok: false, code: errorCode(error) };
  }
  if (st.isSymbolicLink()) return { ok: false, code: 'ESYMLINK' };
  if (p.platform === 'win32') return applyOwnerOnlyAcl(path, false, options) ? { ok: true } : { ok: false, code: 'EACL' };
  if ((st.mode & 0o077) === 0) return { ok: true };
  try {
    await p.chmod(path, PRIVATE_FILE_MODE);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

/** umask 077 for this process on POSIX, so every file it creates starts private. */
export function setPrivateUmask(platform: string = process.platform): void {
  if (platform === 'win32') return;
  try {
    process.umask(0o077);
  } catch {
    // Worker threads cannot change the umask; exclusive 0600 creation still applies.
  }
}
