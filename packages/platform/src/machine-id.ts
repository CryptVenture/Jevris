import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { currentUser, type ExecPort } from './owner-only.js';
import { envValue, pathApiFor, type EnvLike } from './paths.js';

/**
 * A stable identity for this machine and this user (DATA-10). The store's host scope is a
 * hash over it, so the scope no longer follows the host name, which on macOS changes with the
 * network (DHCP or Bonjour renames `os.hostname()`).
 *
 * - macOS: `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice`.
 * - Linux: `/etc/machine-id`, else `/var/lib/dbus/machine-id`.
 * - Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` through `reg query`.
 *
 * The user is the numeric uid on POSIX and the account SID on Windows. Commands run without a
 * shell, from their absolute system path, with a bounded time. The raw id is returned to be
 * hashed at once: callers never store it, log it or print it.
 */

export type MachineIdSource = 'ioplatformuuid' | 'etc-machine-id' | 'dbus-machine-id' | 'machineguid' | 'test';

export interface MachineIdentity {
  readonly ok: true;
  /** The raw machine id. Hash it; never store, log or print it. */
  readonly machineId: string;
  readonly source: MachineIdSource;
  /** `uid:<n>` on POSIX, `sid:<SID>` on Windows. */
  readonly user: string;
}

export interface MachineIdentityFailure {
  readonly ok: false;
  readonly reason: 'machine-id-unreadable' | 'user-unknown' | 'platform-unsupported';
}

export type MachineIdentityResult = MachineIdentity | MachineIdentityFailure;

export interface MachineIdOptions {
  readonly platform?: string;
  readonly env?: EnvLike;
  /** Runs `ioreg`, `reg.exe`, `whoami.exe` or `scutil` (tests inject fixtures). */
  readonly exec?: ExecPort;
  /** Reads a machine-id file; throws when it is missing (tests inject fixtures). */
  readonly readFile?: (path: string) => string;
  /** The POSIX uid; null when the platform has none. */
  readonly uid?: number | null;
}

/** Bounded time for each system query; a slow one falls back rather than stall a start. */
export const MACHINE_ID_EXEC_TIMEOUT_MS = 5000;

const IOREG = '/usr/sbin/ioreg';
const SCUTIL = '/usr/sbin/scutil';
const MACHINE_ID_FILES: readonly (readonly [string, MachineIdSource])[] = [
  ['/etc/machine-id', 'etc-machine-id'],
  ['/var/lib/dbus/machine-id', 'dbus-machine-id'],
];
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** An all-zero id is a placeholder some virtual machines report, not an identity. */
function notPlaceholder(id: string): boolean {
  return /[1-9A-Fa-f]/.test(id);
}

/** `"IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"` from ioreg, upper case, or null. */
export function parseIoregPlatformUuid(stdout: string): string | null {
  const match = /"IOPlatformUUID"\s*=\s*"([^"\r\n]*)"/.exec(stdout);
  const id = match?.[1];
  if (id === undefined || !UUID.test(id) || !notPlaceholder(id)) return null;
  return id.toUpperCase();
}

/** A systemd or D-Bus machine id: 32 hex characters on one line, lower case, or null. */
export function parseMachineIdFile(text: string): string | null {
  const id = text.trim();
  if (!/^[0-9A-Fa-f]{32}$/.test(id) || !notPlaceholder(id)) return null;
  return id.toLowerCase();
}

/** `MachineGuid    REG_SZ    <guid>` from `reg query`, lower case, or null. */
export function parseRegMachineGuid(stdout: string): string | null {
  const match = /^\s*MachineGuid\s+REG_SZ\s+(\S+)\s*$/m.exec(stdout);
  const id = match?.[1];
  if (id === undefined || !UUID.test(id) || !notPlaceholder(id)) return null;
  return id.toLowerCase();
}

function defaultExec(env: EnvLike, platform: string): ExecPort {
  return (file, args) => {
    const api = pathApiFor(platform);
    const system = envValue(env, 'SystemRoot', platform) ?? 'C:\\Windows';
    const full = platform === 'win32' && !api.isAbsolute(file) ? api.join(system, 'System32', file) : file;
    const result = spawnSync(full, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: MACHINE_ID_EXEC_TIMEOUT_MS });
    if (result.error !== undefined) return { status: null, stdout: '' };
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  };
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Runs a query once more when the first attempt fails (a busy machine at login). */
function execTwice(exec: ExecPort, file: string, args: readonly string[]): string | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = exec(file, args);
    if (result.status === 0) return result.stdout;
  }
  return null;
}

function readMachineId(platform: string, exec: ExecPort, readFile: (path: string) => string): { readonly id: string; readonly source: MachineIdSource } | null {
  if (platform === 'darwin') {
    const stdout = execTwice(exec, IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const id = stdout === null ? null : parseIoregPlatformUuid(stdout);
    return id === null ? null : { id, source: 'ioplatformuuid' };
  }
  if (platform === 'win32') {
    // The 64-bit registry view holds MachineGuid; a 32-bit view does not.
    for (const view of [['/reg:64'], []]) {
      const stdout = execTwice(exec, 'reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', ...view]);
      const id = stdout === null ? null : parseRegMachineGuid(stdout);
      if (id !== null) return { id, source: 'machineguid' };
    }
    return null;
  }
  if (platform === 'linux') {
    for (const [path, source] of MACHINE_ID_FILES) {
      let text: string;
      try {
        text = readFile(path);
      } catch {
        continue;
      }
      const id = parseMachineIdFile(text);
      if (id !== null) return { id, source };
    }
    return null;
  }
  return null;
}

function processUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Reads the machine id and the user now, with no cache. */
export function readMachineIdentity(options: MachineIdOptions = {}): MachineIdentityResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return { ok: false, reason: 'platform-unsupported' };
  const exec = options.exec ?? defaultExec(env, platform);
  const machine = readMachineId(platform, exec, options.readFile ?? defaultReadFile);
  if (machine === null) return { ok: false, reason: 'machine-id-unreadable' };
  let user: string;
  if (platform === 'win32') {
    const sid = currentUser(exec)?.sid;
    if (sid === undefined) return { ok: false, reason: 'user-unknown' };
    user = `sid:${sid}`;
  } else {
    const uid = options.uid === undefined ? processUid() : options.uid;
    if (uid === null || !Number.isSafeInteger(uid) || uid < 0) return { ok: false, reason: 'user-unknown' };
    user = `uid:${String(uid)}`;
  }
  return { ok: true, machineId: machine.id, source: machine.source, user };
}

/**
 * Under JEVRIS_TEST=1 no system query runs: the machine id is JEVRIS_TEST_MACHINE_ID (default
 * `jevris-test-machine`), and `unreadable` stands for a machine whose id cannot be read.
 */
function testIdentity(env: EnvLike, platform: string): MachineIdentityResult {
  const given = envValue(env, 'JEVRIS_TEST_MACHINE_ID', platform);
  if (given === 'unreadable') return { ok: false, reason: 'machine-id-unreadable' };
  const uid = processUid();
  return {
    ok: true,
    machineId: typeof given === 'string' && given.length > 0 ? given : 'jevris-test-machine',
    source: 'test',
    user: uid === null ? 'sid:test' : `uid:${String(uid)}`,
  };
}

let cached: MachineIdentityResult | undefined;

/** This machine's identity, read once per process (the scope must not change mid-run). */
export function machineIdentity(): MachineIdentityResult {
  if (cached !== undefined) return cached;
  const env = process.env;
  cached = envValue(env, 'JEVRIS_TEST', process.platform) === '1' ? testIdentity(env, process.platform) : readMachineIdentity();
  return cached;
}

export interface HostnameCandidateOptions {
  readonly platform?: string;
  readonly env?: EnvLike;
  readonly exec?: ExecPort;
  readonly hostname?: () => string;
}

const MAX_CANDIDATES = 8;

/**
 * The names this machine has gone by, for adopting a store stamped with the old host-name
 * scope: `os.hostname()`, and on macOS `scutil --get LocalHostName` (with and without
 * `.local`) and `scutil --get ComputerName`. Under JEVRIS_TEST=1 without an injected exec,
 * scutil is not run.
 */
export function hostnameCandidates(options: HostnameCandidateOptions = {}): readonly string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const names: string[] = [];
  const add = (name: string | null | undefined): void => {
    if (typeof name !== 'string') return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 255 || /[\0\r\n]/.test(trimmed) || names.includes(trimmed)) return;
    names.push(trimmed);
  };
  const withoutLocal = (name: string): string => name.replace(/\.local$/i, '');
  let own: string | undefined;
  try {
    own = (options.hostname ?? hostname)();
  } catch {
    own = undefined;
  }
  add(own);
  if (own !== undefined) add(withoutLocal(own));
  const underTest = options.exec === undefined && envValue(env, 'JEVRIS_TEST', platform) === '1';
  if (platform === 'darwin' && !underTest) {
    const exec = options.exec ?? defaultExec(env, platform);
    const local = exec(SCUTIL, ['--get', 'LocalHostName']);
    if (local.status === 0) {
      const name = local.stdout.trim();
      add(name);
      if (name.length > 0) add(`${withoutLocal(name)}.local`);
      add(withoutLocal(name));
    }
    const computer = exec(SCUTIL, ['--get', 'ComputerName']);
    if (computer.status === 0) add(computer.stdout.trim());
  }
  return names.slice(0, MAX_CANDIDATES);
}
