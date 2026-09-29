import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { hostnameCandidates, isInsideOrSame, jevrisPaths, machineIdentity, type MachineIdentityResult } from '@jevris/platform';

/**
 * The store's host scope (DATA-10): a store copied to another machine or user refuses to open.
 *
 * The scope is a hash over the stable machine id (IOPlatformUUID, /etc/machine-id or
 * MachineGuid), the user (uid or SID), the platform and the real path of the home. It no longer
 * uses the host name, which on macOS follows the network. When the machine id cannot be read
 * it falls back to the earlier host-name formula, and doctor says so.
 *
 * A store stamped by the earlier formula is adopted on open (re-stamped, HOST_SCOPE_MIGRATED)
 * when its scope matches that formula for one of this machine's names and the file is this
 * user's and lies in this home. The raw machine id is hashed here and never kept.
 */

export interface HostScopePorts {
  readonly machine?: () => MachineIdentityResult;
  readonly hostname?: () => string;
  /** The names this machine has gone by (default: platform hostnameCandidates). */
  readonly hostnames?: () => readonly string[];
  readonly platform?: string;
  /** The current uid for the ownership check; null skips it (Windows). */
  readonly uid?: number | null;
}

export interface HostScopeInfo {
  readonly scope: string;
  /** `machine-id`: stable; `host-name`: the fallback, which follows the host name. */
  readonly source: 'machine-id' | 'host-name';
  /** Why the machine id was not used, when it was not. */
  readonly reason: string | null;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function realHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/** The earlier formula: host name, platform and home (kept for the fallback and for adoption). */
export function legacyHostScopeId(home: string, host: string, platform: string = process.platform): string {
  return `h${sha(`${host}\0${platform}\0${realHome(home)}`).slice(0, 24)}`;
}

export function hostScopeInfo(home: string, ports: HostScopePorts = {}): HostScopeInfo {
  const platform = ports.platform ?? process.platform;
  const identity = (ports.machine ?? machineIdentity)();
  if (!identity.ok) {
    return { scope: legacyHostScopeId(home, (ports.hostname ?? hostname)(), platform), source: 'host-name', reason: identity.reason };
  }
  const scope = `h${sha(`jevris-host-scope-v2\0${identity.machineId}\0${identity.user}\0${platform}\0${realHome(home)}`).slice(0, 24)}`;
  return { scope, source: 'machine-id', reason: null };
}

/** A per-machine, per-user, per-home scope id. */
export function hostScopeId(home: string, ports: HostScopePorts = {}): string {
  return hostScopeInfo(home, ports).scope;
}

/** The earlier host-name scopes this machine may have stamped, one per known name. */
export function legacyHostScopes(home: string, ports: HostScopePorts = {}): readonly string[] {
  const platform = ports.platform ?? process.platform;
  let names: readonly string[];
  try {
    names = (ports.hostnames ?? (() => hostnameCandidates({ platform, ...(ports.hostname === undefined ? {} : { hostname: ports.hostname }) })))();
  } catch {
    names = [];
  }
  const out: string[] = [];
  for (const name of names) {
    const scope = legacyHostScopeId(home, name, platform);
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

function currentUid(ports: HostScopePorts): number | null {
  if (ports.uid !== undefined) return ports.uid;
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * True when the store file is a regular file owned by this user (POSIX) and lies in this home:
 * inside the real home, or in the data directory Jevris uses for it.
 */
export function storeBelongsHere(home: string, dbPath: string, ports: HostScopePorts = {}): boolean {
  try {
    const st = lstatSync(dbPath);
    if (!st.isFile()) return false;
    const uid = currentUid(ports);
    if (uid !== null && st.uid !== uid) return false;
    // Paths are this filesystem's: the real platform, whatever scope formula a test injects.
    const dir = realpathSync(dirname(dbPath));
    if (isInsideOrSame(realHome(home), dir)) return true;
    return isInsideOrSame(realpathSync(jevrisPaths({ home }).data), dir);
  } catch {
    return false;
  }
}

export interface StoreHostScope {
  readonly hostScope: string;
  /** Called by the store only when the stored scope differs: the scopes it may adopt. */
  readonly adoptHostScopes: () => readonly string[];
}

/** The scope to open `dbPath` with, and the earlier scopes of this machine it may adopt. */
export function hostScopeForStore(home: string, dbPath: string, ports: HostScopePorts = {}): StoreHostScope {
  const hostScope = hostScopeId(home, ports);
  return {
    hostScope,
    adoptHostScopes: () => (storeBelongsHere(home, dbPath, ports) ? legacyHostScopes(home, ports).filter((scope) => scope !== hostScope) : []),
  };
}
