import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyHostDocument, hasRawKeyProperty, mergeOrganization, type HostDocument } from '@jevris/contracts';
import { parseIcacls, runSync, type AclEntry } from '@jevris/platform';

/**
 * Managed (enterprise) policy and the enterprise kill switch (GOV-05, SSOT §16.5, §4.2, C56).
 *
 * An administrator places them where only an administrator can write:
 *
 *   macOS    /Library/Application Support/Jevris/{policy.json,kill-switch.json}
 *   Linux    /etc/jevris/{policy.json,kill-switch.json}
 *   Windows  %ProgramData%\Jevris\{policy.json,kill-switch.json}, or the registry values
 *            HKLM\Software\Policies\Jevris: Policy (REG_SZ, the policy JSON) and KillSwitch
 *            (REG_DWORD, 1 stops)
 *
 * The file and every directory above it must be owned by root (POSIX) and writable by no one
 * else; on Windows only SYSTEM, Administrators and TrustedInstaller may write. A managed file
 * that fails the check (for example a world-writable one) is refused: a refused policy leaves
 * source egress denied, and a refused kill switch reads as stopped (fail closed, GOV-02).
 *
 * With a managed policy in place the user's files carry provenance `user` and can only narrow
 * it: host.json and organization.json are intersected with it, and a user file that would widen
 * it is ignored (POLICY_WIDEN). A user who turns Jevris optimization off (mode `off`, or their
 * own kill switch) never turns off the enterprise controls: the managed kill switch is read on
 * every request and `jevris kill-switch clear` cannot clear it.
 *
 * Moved from @jevris/cli (enterprise-policy.ts, which re-exports it) so the effective settings can
 * apply the managed `mode` ceiling (GOV-05).
 *
 * Tests: with JEVRIS_TEST=1, JEVRIS_TEST_MANAGED_DIR names the directory and the current user
 * counts as the administrator, but only when the real managed directory does not exist, so a
 * test variable can never replace a real enterprise policy.
 */

export const MANAGED_POLICY_FILE = 'policy.json';
export const MANAGED_KILL_SWITCH_FILE = 'kill-switch.json';
export const MANAGED_REGISTRY_KEY = 'HKLM\\Software\\Policies\\Jevris';
const MAX_MANAGED_BYTES = 262_144;

type Env = { readonly [key: string]: string | undefined };

export interface ManagedOptions {
  readonly platform?: string;
  readonly env?: Env;
  /** `reg query` and `icacls` output: injected by tests, and by the sidecar's cached reader (P8). */
  readonly exec?: (command: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: string };
}

export type ManagedRefusal = 'MANAGED_NOT_ADMIN_OWNED' | 'MANAGED_WRITABLE_BY_OTHERS' | 'MANAGED_SYMLINK' | 'MANAGED_UNREADABLE' | 'MANAGED_INVALID' | 'MANAGED_RAW_KEY';

export type ManagedPolicyState =
  | { readonly state: 'absent' }
  | { readonly state: 'ok'; readonly document: HostDocument; readonly source: 'file' | 'registry'; readonly path: string }
  | { readonly state: 'refused'; readonly reasonCode: ManagedRefusal; readonly source: 'file' | 'registry'; readonly path: string };

export interface ManagedKillSwitch {
  readonly stopped: boolean;
  readonly source: 'file' | 'registry' | null;
  readonly reason: string | null;
  /** Set when a managed kill-switch file exists but failed its checks (it then reads as stopped). */
  readonly refused: ManagedRefusal | null;
}

interface Location {
  readonly dir: string;
  /** The test override is in use: the current user counts as the administrator. */
  readonly test: boolean;
}

function envValue(env: Env, name: string): string | undefined {
  const direct = env[name];
  if (typeof direct === 'string') return direct;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper && typeof env[key] === 'string') return env[key];
  return undefined;
}

/** The managed directory for a platform (the real one, never an override). */
export function managedPolicyDir(platform: string = process.platform, env: Env = process.env): string {
  if (platform === 'darwin') return '/Library/Application Support/Jevris';
  if (platform === 'win32') {
    const programData = envValue(env, 'ProgramData');
    return join(typeof programData === 'string' && /^[A-Za-z]:\\/.test(programData) ? programData : 'C:\\ProgramData', 'Jevris');
  }
  return '/etc/jevris';
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function location(options: ManagedOptions): Location {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const real = managedPolicyDir(platform, env);
  const override = env['JEVRIS_TEST_MANAGED_DIR'];
  if (env['JEVRIS_TEST'] === '1' && typeof override === 'string' && override.length > 0 && !exists(real)) return { dir: override, test: true };
  return { dir: real, test: false };
}

function defaultExec(command: string, args: readonly string[], env: Env): { readonly status: number | null; readonly stdout: string } {
  // An absolute System32 path, no shell (platform runSync).
  const out = runSync(command, args, { env, spawnEnv: env, timeoutMs: 5000 });
  return { status: out.status, stdout: out.stdout };
}

/** Windows principals that may write a managed file (English names and well-known SIDs). */
const WINDOWS_ADMINS = new Set(['nt authority\\system', 'builtin\\administrators', 'nt service\\trustedinstaller', 'creator owner', '*s-1-5-18', '*s-1-5-32-544', 'system', 'administrators']);
/** ACE rights that grant no write: read, execute, synchronize, read control and inheritance flags. */
const READ_ONLY_RIGHTS = new Set(['R', 'RX', 'RD', 'REA', 'RA', 'X', 'S', 'RC', 'GR', 'GE', 'I', 'OI', 'CI', 'IO', 'NP', 'DENY']);

/** True when an ACE list lets only administrators write. Unknown principals with write rights fail. */
export function aclAdminOnlyWrite(entries: readonly AclEntry[], extraAdmins: readonly string[] = []): boolean {
  const admins = new Set([...WINDOWS_ADMINS, ...extraAdmins.map((name) => name.toLowerCase())]);
  for (const entry of entries) {
    if (admins.has(entry.principal.trim().toLowerCase())) continue;
    const rights = entry.rights.replace(/[()]/g, ' ').split(/[\s,]+/).filter((token) => token.length > 0);
    if (rights.includes('DENY')) continue;
    if (rights.some((token) => !READ_ONLY_RIGHTS.has(token))) return false;
  }
  return true;
}

/** Ownership and permission check for one managed path and every directory above it. */
function checkPath(path: string, loc: Location, options: ManagedOptions): ManagedRefusal | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'MANAGED_UNREADABLE';
  }
  if (st.isSymbolicLink()) return 'MANAGED_SYMLINK';
  if (platform === 'win32') {
    const systemRoot = envValue(env, 'SystemRoot') ?? 'C:\\Windows';
    const icacls = join(systemRoot, 'System32', 'icacls.exe');
    const run = options.exec ?? ((command, args) => defaultExec(command, args, env));
    for (const target of [path, loc.dir]) {
      const listed = run(icacls, [target]);
      const entries = listed.status === 0 ? parseIcacls(listed.stdout, target) : null;
      if (entries === null) return 'MANAGED_UNREADABLE';
      const self = loc.test ? [envValue(env, 'USERDOMAIN') !== undefined ? `${envValue(env, 'USERDOMAIN')}\\${envValue(env, 'USERNAME') ?? ''}` : envValue(env, 'USERNAME') ?? ''] : [];
      if (!aclAdminOnlyWrite(entries, self)) return 'MANAGED_WRITABLE_BY_OTHERS';
    }
    return undefined;
  }
  const getuid = Reflect.get(process, 'getuid') as (() => number) | undefined;
  const adminUid = loc.test && typeof getuid === 'function' ? getuid() : 0;
  // The file, then each directory up to the filesystem root: owned by the administrator and
  // writable by no one else (group write only for gid 0).
  let current = path;
  for (let depth = 0; depth < 64; depth += 1) {
    let info;
    try {
      info = depth === 0 ? st : lstatSync(current);
    } catch {
      return 'MANAGED_UNREADABLE';
    }
    const owner = info.uid;
    const gid = info.gid;
    // Above the managed directory the system owns the path (root); in a test only the
    // override directory and its contents belong to the current user.
    const insideManaged = current === path || current === loc.dir || current.startsWith(`${loc.dir}/`);
    const allowed = insideManaged ? adminUid : 0;
    if (owner !== allowed && owner !== 0) return 'MANAGED_NOT_ADMIN_OWNED';
    if ((info.mode & 0o002) !== 0 && !((info.mode & 0o1000) !== 0 && depth > 0)) return 'MANAGED_WRITABLE_BY_OTHERS';
    if ((info.mode & 0o020) !== 0 && gid !== 0 && !(loc.test && insideManaged)) return 'MANAGED_WRITABLE_BY_OTHERS';
    const parent = dirname(current);
    if (parent === current) break;
    // In a test the directories above the override (a temp dir) are not checked.
    if (loc.test && current === loc.dir) break;
    current = parent;
  }
  return undefined;
}

function readManagedJson(path: string, loc: Location, options: ManagedOptions): { readonly kind: 'absent' } | { readonly kind: 'refused'; readonly reasonCode: ManagedRefusal } | { readonly kind: 'ok'; readonly value: unknown } {
  if (!exists(path)) return { kind: 'absent' };
  const refused = checkPath(path, loc, options);
  if (refused !== undefined) return { kind: 'refused', reasonCode: refused };
  let text: string;
  try {
    if (lstatSync(path).size > MAX_MANAGED_BYTES) return { kind: 'refused', reasonCode: 'MANAGED_INVALID' };
    text = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'refused', reasonCode: 'MANAGED_UNREADABLE' };
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === 'object' && hasRawKeyProperty(value)) return { kind: 'refused', reasonCode: 'MANAGED_RAW_KEY' };
    return { kind: 'ok', value };
  } catch {
    return { kind: 'refused', reasonCode: 'MANAGED_INVALID' };
  }
}

/** Parses `reg query <key> /v <name>` output: the value's type and data, or undefined. */
export function parseRegQuery(stdout: string, name: string): { readonly type: string; readonly data: string } | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(line);
    if (match !== null && (match[1] as string).toLowerCase() === name.toLowerCase()) return { type: match[2] as string, data: (match[3] ?? '').trim() };
  }
  return undefined;
}

function registryValue(name: string, options: ManagedOptions): { readonly type: string; readonly data: string } | undefined {
  const env = options.env ?? process.env;
  const systemRoot = envValue(env, 'SystemRoot') ?? 'C:\\Windows';
  const run = options.exec ?? ((command, args) => defaultExec(command, args, env));
  const out = run(join(systemRoot, 'System32', 'reg.exe'), ['query', MANAGED_REGISTRY_KEY, '/v', name]);
  return out.status === 0 ? parseRegQuery(out.stdout, name) : undefined;
}

let processDefaults: ManagedOptions = {};

/**
 * The managed read options a call without its own uses (readEffectiveConfig's managed mode
 * ceiling reads the policy on every settings read). Unset, a read behaves as it always has. Only
 * the sidecar sets it, once at startup, to its cached `exec` port (managed-exec.ts), so a settings
 * read there never spawns reg.exe or icacls on a request. Tests that set it reset it with `{}`.
 */
export function setManagedPolicyDefaults(options: ManagedOptions): void {
  processDefaults = { ...options };
}

/** The managed read options in force for a call without its own. */
export function managedPolicyDefaults(): ManagedOptions {
  return processDefaults;
}

/** The managed policy, from the admin-owned file or (Windows) the policy registry key. */
export function readManagedPolicy(options: ManagedOptions = processDefaults): ManagedPolicyState {
  const platform = options.platform ?? process.platform;
  const loc = location(options);
  const path = join(loc.dir, MANAGED_POLICY_FILE);
  const file = readManagedJson(path, loc, options);
  if (file.kind === 'refused') return { state: 'refused', reasonCode: file.reasonCode, source: 'file', path };
  if (file.kind === 'ok') {
    const document = copyHostDocument(file.value);
    return document === undefined ? { state: 'refused', reasonCode: 'MANAGED_INVALID', source: 'file', path } : { state: 'ok', document, source: 'file', path };
  }
  if (platform === 'win32' && !loc.test) {
    const value = registryValue('Policy', options);
    if (value === undefined) return { state: 'absent' };
    const where = `${MANAGED_REGISTRY_KEY}\\Policy`;
    if (value.type !== 'REG_SZ' || value.data.length > MAX_MANAGED_BYTES) return { state: 'refused', reasonCode: 'MANAGED_INVALID', source: 'registry', path: where };
    try {
      const parsed = JSON.parse(value.data) as unknown;
      if (parsed !== null && typeof parsed === 'object' && hasRawKeyProperty(parsed)) return { state: 'refused', reasonCode: 'MANAGED_RAW_KEY', source: 'registry', path: where };
      const document = copyHostDocument(parsed);
      return document === undefined ? { state: 'refused', reasonCode: 'MANAGED_INVALID', source: 'registry', path: where } : { state: 'ok', document, source: 'registry', path: where };
    } catch {
      return { state: 'refused', reasonCode: 'MANAGED_INVALID', source: 'registry', path: where };
    }
  }
  return { state: 'absent' };
}

const SAFE_REASON = /[^A-Za-z0-9 _.:/@+,=-]/g;

/** The enterprise kill switch. Present and valid: its `stopped`; present but refused or malformed: stopped. */
export function readManagedKillSwitch(options: ManagedOptions = {}): ManagedKillSwitch {
  const platform = options.platform ?? process.platform;
  const loc = location(options);
  const file = readManagedJson(join(loc.dir, MANAGED_KILL_SWITCH_FILE), loc, options);
  if (file.kind === 'refused') return { stopped: true, source: 'file', reason: null, refused: file.reasonCode };
  if (file.kind === 'ok') {
    const value = file.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { stopped: true, source: 'file', reason: null, refused: 'MANAGED_INVALID' };
    const stopped = Reflect.get(value, 'stopped');
    const reason = Reflect.get(value, 'reason');
    if (typeof stopped !== 'boolean') return { stopped: true, source: 'file', reason: null, refused: 'MANAGED_INVALID' };
    return { stopped, source: 'file', reason: typeof reason === 'string' ? reason.replace(SAFE_REASON, ' ').trim().slice(0, 160) || null : null, refused: null };
  }
  if (platform === 'win32' && !loc.test) {
    const value = registryValue('KillSwitch', options);
    if (value !== undefined) {
      if (value.type !== 'REG_DWORD') return { stopped: true, source: 'registry', reason: null, refused: 'MANAGED_INVALID' };
      return { stopped: Number.parseInt(value.data, 16) !== 0 || value.data === '1', source: 'registry', reason: null, refused: null };
    }
  }
  return { stopped: false, source: null, reason: null, refused: null };
}

export interface LayeredPolicy {
  /** The policy in force: the managed one narrowed by the user's files, or the user's files alone. */
  readonly document: HostDocument | undefined;
  readonly managed: ManagedPolicyState;
  /** Each user file with its provenance and whether it narrowed the policy or was ignored. */
  readonly userLayers: readonly { readonly file: 'host.json' | 'organization.json'; readonly provenance: 'user' | 'administrator'; readonly applied: boolean; readonly reasonCode: 'POLICY_WIDEN' | null }[];
}

/**
 * Layers the user's host.json and organization.json under a managed policy. Without a managed
 * policy the user's host.json is the administrator's policy, as before (organization.json
 * narrows it). With one, both user files carry provenance `user` and may only narrow it; a file
 * that would widen it is ignored. A refused managed policy yields no document: egress stays denied.
 */
export function layerPolicy(managed: ManagedPolicyState, host: HostDocument | undefined, organization: HostDocument | undefined): LayeredPolicy {
  if (managed.state === 'refused') return { document: undefined, managed, userLayers: [] };
  if (managed.state === 'absent') {
    if (host === undefined) return { document: undefined, managed, userLayers: [] };
    if (organization === undefined) return { document: host, managed, userLayers: [{ file: 'host.json', provenance: 'administrator', applied: true, reasonCode: null }] };
    const merged = mergeOrganization(host, organization);
    return {
      document: merged.ok ? merged.document : host,
      managed,
      userLayers: [
        { file: 'host.json', provenance: 'administrator', applied: true, reasonCode: null },
        { file: 'organization.json', provenance: 'administrator', applied: merged.ok, reasonCode: merged.ok ? null : 'POLICY_WIDEN' },
      ],
    };
  }
  let document = managed.document;
  const userLayers: LayeredPolicy['userLayers'][number][] = [];
  for (const [file, layer] of [['host.json', host], ['organization.json', organization]] as const) {
    if (layer === undefined) continue;
    const merged = mergeOrganization(document, layer);
    if (merged.ok) document = merged.document;
    userLayers.push({ file, provenance: 'user', applied: merged.ok, reasonCode: merged.ok ? null : 'POLICY_WIDEN' });
  }
  return { document, managed, userLayers };
}
