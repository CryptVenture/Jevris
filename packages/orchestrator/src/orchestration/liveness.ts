/**
 * Cross-platform process liveness (ORC-03, D05): a PID alone is reused by the OS, so a holder
 * is alive only when the PID exists and its start time matches the recorded one.
 *
 * Start time comes from /proc on Linux, `ps -o lstart=` on macOS and other POSIX systems, and
 * PowerShell `Get-Process` on Windows. When the start time cannot be read, liveness falls back
 * to "the PID exists", and the lease heartbeat stays the authority.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { hostnameCandidates, machineIdentity, runSync, type MachineIdentityResult } from '@jevris/platform';
import { sha256 } from '../util.js';

export interface ProcessIdentity {
  readonly hostId: string;
  readonly pid: number;
  /** Wall-clock ms the process started, or null when the OS would not say. */
  readonly startedAtMs: number | null;
  /** An owned SDK session id, when the holder is an Agent SDK session. */
  readonly sessionId: string | null;
}

/** Test seams for the host identity: the machine identity and the names this machine has gone by. */
export interface HostIdentityPorts {
  readonly machine?: () => MachineIdentityResult;
  readonly hostname?: () => string;
  readonly hostnames?: () => readonly string[];
}

/** The earlier host id, from a host name (kept for the fallback and to adopt old records). */
export function legacyHostId(name: string): string {
  return `h-${sha256(name).slice(0, 16)}`;
}

/**
 * This machine's host id for lease holders, the owned-session registry and the ledger lock
 * (DATA-10, B a08d9fc): a hash of the stable machine id (IOPlatformUUID, /etc/machine-id or
 * MachineGuid), the same token B's store writer lock uses, so a macOS network rename never makes
 * this machine's own leases look foreign. The raw id is never kept. When the machine id cannot
 * be read it is the earlier host-name id.
 */
export function hostIdentity(ports: HostIdentityPorts = {}): string {
  const identity = (ports.machine ?? machineIdentity)();
  return identity.ok ? `m${sha256(`jevris-lock-host\0${identity.machineId}`).slice(0, 24)}` : legacyHostId((ports.hostname ?? hostname)());
}

let knownNames: readonly string[] | undefined;

/** The names this machine has gone by: platform hostnameCandidates once per process, plus the current name. */
function namesOf(ports: HostIdentityPorts): readonly string[] {
  const current = (ports.hostname ?? hostname)();
  let names: readonly string[];
  if (ports.hostnames !== undefined) names = ports.hostnames();
  else {
    try {
      knownNames ??= hostnameCandidates();
    } catch {
      knownNames = [];
    }
    names = knownNames;
  }
  return names.includes(current) ? names : [current, ...names];
}

/**
 * True when a recorded host is this machine: its stable id, or an earlier record stamped by one
 * of this machine's names (the old `h-` id, or a raw name in an old ledger lock). Old records are
 * adopted the way B's store migration adopts the machine's known names.
 */
export function isThisHost(host: string, ports: HostIdentityPorts = {}): boolean {
  if (host === hostIdentity(ports)) return true;
  const names = namesOf(ports);
  return names.includes(host) || names.some((name) => legacyHostId(name) === host);
}

const START_TOLERANCE_MS = 2_000;

function linuxStart(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8'); // path-hygiene: allow Linux procfs path
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const btimeLine = readFileSync('/proc/stat', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('btime '));
    const btime = Number(btimeLine?.split(' ')[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return Math.round(btime * 1000 + (ticks / 100) * 1000);
  } catch {
    return null;
  }
}

function psStart(pid: number): number | null {
  const r = runSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 3_000, spawnEnv: { PATH: process.env['PATH'], LC_ALL: 'C', TZ: process.env['TZ'] } });
  if (!r.ok) return null;
  const parsed = Date.parse(r.stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function windowsStart(pid: number): number | null {
  const r = runSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToString('o')`],
    { timeoutMs: 5_000 },
  );
  if (!r.ok) return null;
  const parsed = Date.parse(r.stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function processStartMs(pid: number, platform: string = process.platform): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') return linuxStart(pid) ?? psStart(pid);
  if (platform === 'win32') return windowsStart(pid);
  return psStart(pid);
}

export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EPERM';
  }
}

let selfStart: number | null | undefined;

/** The identity of this process, for lease holders and the owned-process registry. */
export function selfIdentity(sessionId: string | null = null): ProcessIdentity {
  selfStart ??= processStartMs(process.pid);
  return { hostId: hostIdentity(), pid: process.pid, startedAtMs: selfStart, sessionId };
}

export type Liveness = 'alive' | 'dead' | 'other-host' | 'unknown';

/** Liveness of a recorded holder; `other-host` leaves the decision to the heartbeat. */
export function livenessOf(identity: ProcessIdentity, probe: { readonly exists?: (pid: number) => boolean; readonly startMs?: (pid: number) => number | null } = {}): Liveness {
  if (!isThisHost(identity.hostId)) return 'other-host';
  const exists = (probe.exists ?? pidExists)(identity.pid);
  if (!exists) return 'dead';
  if (identity.startedAtMs === null) return 'unknown';
  const now = (probe.startMs ?? processStartMs)(identity.pid);
  if (now === null) return 'unknown';
  return Math.abs(now - identity.startedAtMs) <= START_TOLERANCE_MS ? 'alive' : 'dead';
}
