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
  /** The file id and creation time, when known: a folder removed and made again is another one. */
  readonly ino?: number | bigint;
  readonly birthtimeMs?: number;
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

// One port per system folder, so currentUser's cache (keyed by port) runs whoami once per process.
const defaultExecs = new Map<string, ExecPort>();

function defaultExec(env: EnvLike, platform: string): ExecPort {
  const system = envValue(env, 'SystemRoot', platform) ?? 'C:\\Windows';
  const key = `${platform}\0${system}`;
  const known = defaultExecs.get(key);
  if (known !== undefined) return known;
  const exec: ExecPort = (file, args) => {
    const api = pathApiFor(platform);
    const full = api.isAbsolute(file) ? file : api.join(system, 'System32', file);
    const result = spawnSync(full, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000 });
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  };
  defaultExecs.set(key, exec);
  return exec;
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
  // A failed lookup is asked again next time: the default port lives as long as the process.
  if (user !== null) userCache.set(exec, user);
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
  const echoed = echoedPath(path);
  let started = false;
  for (const raw of lines) {
    if (!started) {
      if (raw.trim().length === 0) continue;
      const echo = echoed.exec(raw);
      if (echo === null) return null;
      started = true;
      const first = raw.slice(echo[0].length).trim();
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

/**
 * The path as icacls echoes it. icacls writes in the console's OEM code page, not UTF-8, so a
 * non-ASCII character comes back as another character, U+FFFD or `?` (a home such as
 * `C:\Users\Ann Lée`); each run of them matches one run of non-ASCII characters or `?`.
 */
function echoedPath(path: string): RegExp {
  let source = '';
  let inRun = false;
  for (const ch of path) {
    if (ch.charCodeAt(0) < 0x80) {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      inRun = false;
    } else if (!inRun) {
      source += '(?:[^\\x00-\\x7f]|\\?)+';
      inRun = true;
    }
  }
  return new RegExp(`^${source}`, 'i');
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

/** An ACL principal as `icacls /remove:g` takes it: a bare SID (an unresolved account) gets its `*`. */
function removable(principal: string): string {
  return /^S-1-[0-9-]+$/.test(principal) ? `*${principal}` : principal;
}

/**
 * Replaces the ACL with one full-control ACE for the current user (inheritable on a directory).
 * `/inheritance:r` drops inherited ACEs only, and `/grant:r` replaces only this user's, so an
 * explicit ACE for anyone else survives both. A new directory on windows-latest carries explicit
 * SYSTEM and Administrators ACEs, so those are removed by name, and the result is read back.
 */
export function applyOwnerOnlyAcl(path: string, isDirectory: boolean, options: OwnerOnlyOptions = {}): boolean {
  const { exec } = ports(options);
  const user = currentUser(exec);
  if (user === null) return false;
  const grant = isDirectory ? `*${user.sid}:(OI)(CI)F` : `*${user.sid}:F`;
  const result = exec('icacls.exe', [path, '/inheritance:r', '/grant:r', grant, '/q']);
  if (result.status !== 0) return false;
  let listed = exec('icacls.exe', [path]);
  if (listed.status !== 0) return false;
  let entries = parseIcacls(listed.stdout, path);
  if (entries === null) return false;
  const others = [...new Set(entries.filter((entry) => !isCurrentUser(entry.principal, user)).map((entry) => removable(entry.principal)))];
  if (others.length > 0) {
    if (exec('icacls.exe', [path, '/remove:g', ...others, '/q']).status !== 0) return false;
    listed = exec('icacls.exe', [path]);
    if (listed.status !== 0) return false;
    entries = parseIcacls(listed.stdout, path);
  }
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
  const dir = await privateDir(path, options, false);
  return dir.ok ? { ok: true } : dir;
}

/**
 * Windows: the private folders this process gave, or read back as having, an owner-only ACL whose
 * ACE files inherit, by exec port, path and folder identity. A file made in one inherits that ACL,
 * so it needs no icacls of its own; a folder removed and made again is not in the set.
 */
const inheritingDirs = new Map<ExecPort, Map<string, string>>();

function identity(st: PrivateStat): string | null {
  return st.ino === undefined || st.birthtimeMs === undefined ? null : `${String(st.ino)}:${String(st.birthtimeMs)}`;
}

function rememberInheriting(exec: ExecPort, path: string, st: PrivateStat): void {
  const id = identity(st);
  if (id === null) return;
  let known = inheritingDirs.get(exec);
  if (known === undefined) {
    known = new Map();
    inheritingDirs.set(exec, known);
  }
  known.set(path, id);
}

/** Whether files made in `path` inherit an owner-only ACL: known, or read back once (one icacls). */
function inheritsOwnerOnly(path: string, st: PrivateStat, exec: ExecPort): boolean {
  const id = identity(st);
  if (id !== null && inheritingDirs.get(exec)?.get(path) === id) return true;
  const user = currentUser(exec);
  if (user === null) return false;
  const listed = exec('icacls.exe', [path]);
  if (listed.status !== 0) return false;
  const entries = parseIcacls(listed.stdout, path);
  // Owner-only, and the user's full-control ACE is inherited by files ((OI), not inherit-only for folders).
  const inherits = entries !== null && aclIsOwnerOnly(entries, user) && entries.some((entry) => entry.rights.includes('(OI)'));
  if (inherits) rememberInheriting(exec, path, st);
  return inherits;
}

async function privateDir(path: string, options: OwnerOnlyOptions & { readonly repair?: boolean }, forFiles: boolean): Promise<{ readonly ok: true; readonly inherits: boolean } | { readonly ok: false; readonly code: string }> {
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
      // The grant is (OI)(CI) full control for this user alone, read back by applyOwnerOnlyAcl.
      rememberInheriting(p.exec, path, st);
      return { ok: true, inherits: true };
    }
    return { ok: true, inherits: forFiles && inheritsOwnerOnly(path, st, p.exec) };
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
  return { ok: true, inherits: false };
}

/**
 * Writes a private file: private parent, exclusive 0600 temp, atomic replace. On Windows the temp
 * gets its own owner-only ACL before the rename, unless the parent is a private folder whose
 * owner-only ACL files inherit (made or read back by this process): then the temp already has
 * it, and the write starts no icacls.
 */
export async function writePrivateFile(
  path: string,
  data: Uint8Array | string,
  options: OwnerOnlyOptions & Omit<DurableWriteOptions, 'platform' | 'mode' | 'beforeRename'> = {},
): Promise<DurableWriteResult> {
  const p = ports(options);
  const api = pathApiFor(p.platform);
  const dir = await privateDir(api.dirname(path), options, true);
  if (!dir.ok) return dir;
  return durableWrite(path, data, {
    ...options,
    platform: p.platform,
    mode: PRIVATE_FILE_MODE,
    ...(p.platform === 'win32' && !dir.inherits ? { beforeRename: (temp: string) => applyOwnerOnlyAcl(temp, false, options) } : {}),
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
